import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { TransitionEngine } from '../../engine/transition-engine';
import { getProjectDb } from '../../db/database';
import type { Task, Swimlane } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { isAbortError } from '../../../shared/abort-utils';
import { ensureTaskWorktree, ensureTaskBranchCheckout } from './task-git';
import { getProjectRepos } from './project-repos';

/** Build template variables for auto-command interpolation. */
export function buildAutoCommandVars(task: Task): Record<string, string> {
  return {
    title: task.title,
    description: task.description,
    taskId: task.id,
    worktreePath: task.worktree_path || '',
    branchName: task.branch_name || '',
  };
}

/** Create a TransitionEngine wired to explicit project context (not singletons). */
export function createTransitionEngine(
  context: IpcContext,
  actions: ActionRepository,
  tasks: TaskRepository,
  sessionRepo: SessionRepository,
  attachments: AttachmentRepository,
  projectId: string,
  projectPath: string | null,
): TransitionEngine {
  return new TransitionEngine(
    context.sessionManager, actions, tasks, context.claudeDetector, context.commandBuilder,
    () => {
      const config = context.configManager.getEffectiveConfig(projectPath || undefined);
      const gitConfig = { ...config.git };
      // Overlay board config's defaultBaseBranch (team-shared) onto gitConfig
      const boardDefaultBranch = context.boardConfigManager.getDefaultBaseBranch();
      if (boardDefaultBranch) {
        gitConfig.defaultBaseBranch = boardDefaultBranch;
      }
      return {
        permissionMode: config.claude.permissionMode,
        claudePath: config.claude.cliPath,
        projectPath,
        projectId,
        gitConfig,
        mcpServerEnabled: config.mcpServer?.enabled ?? true,
      };
    },
    sessionRepo,
    attachments,
  );
}

export interface AgentSpawnOptions {
  context: IpcContext;
  engine: TransitionEngine;
  tasks: TaskRepository;
  sessionRepo: SessionRepository;
  task: Task;
  fromSwimlaneId: string;
  toLane: Swimlane;
  skipPromptTemplate?: boolean;
  signal?: AbortSignal;
}

/**
 * Single entry point for spawning or resuming an agent session for a task.
 *
 * Implements the "ensure" pattern: idempotent, safe to call multiple times.
 * 1. Runs configured transition actions (which may spawn via spawn_agent action)
 * 2. Verifies whether a session was created (re-reads from DB)
 * 3. If not, spawns or resumes a session as fallback
 * 4. Schedules auto_command injection when appropriate
 *
 * No-ops when: toLane.auto_spawn is false, task already has a session, or
 * task was deleted mid-operation. AbortError always propagates for cancellation.
 */
export async function spawnAgent(options: AgentSpawnOptions): Promise<void> {
  const { context, engine, tasks, sessionRepo, task, fromSwimlaneId, toLane, skipPromptTemplate, signal } = options;

  // Guard: if the target column doesn't want agents, no-op
  if (!toLane.auto_spawn) return;

  // Guard: if the user manually paused this task, don't auto-resume.
  // The user must explicitly click Resume (SESSION_RESUME) to restart.
  const latestSession = sessionRepo.getLatestForTask(task.id);
  if (latestSession?.status === 'suspended' && latestSession.suspended_by === 'user') {
    console.log(`[spawnAgent] Skipping auto-spawn for task ${task.id.slice(0, 8)} (manually paused by user)`);
    return;
  }

  // Step 1: execute configured transition actions (may fire spawn_agent)
  // Error-isolated: a broken/missing transition must not prevent fallback spawn
  try {
    await engine.executeTransition(task, fromSwimlaneId, toLane.id, toLane.permission_mode, skipPromptTemplate, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('[spawnAgent] Transition engine error (continuing to fallback):', error);
  }

  // Verify: re-read from DB - don't assume transition succeeded or failed
  let currentTask = tasks.getById(task.id);

  // Guard: session exists (transition spawned) or task deleted - no-op
  if (!currentTask || currentTask.session_id) return;

  // Step 2: no session after transitions - resume suspended or spawn fresh
  console.log(`[spawnAgent] No session after transitions, spawning for task ${task.id.slice(0, 8)}`);

  // Determine resume vs fresh spawn for auto_command handling
  const suspendedRecord = sessionRepo.getLatestForTask(task.id);
  const wasSuspended = !!suspendedRecord?.claude_session_id
    && suspendedRecord.status === 'suspended';

  // Resume path: preload auto_command as initial resume prompt
  // Fresh path: auto_command scheduled via commandInjector after spawn
  const resumePrompt = (toLane.auto_command?.trim() && wasSuspended)
    ? context.commandBuilder.interpolateTemplate(toLane.auto_command, buildAutoCommandVars(currentTask))
    : undefined;

  try {
    await engine.resumeSuspendedSession(currentTask, toLane.permission_mode, skipPromptTemplate, resumePrompt, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('[spawnAgent] Failed to start session:', error);
    return;
  }

  // Verify: re-read to confirm spawn actually worked
  currentTask = tasks.getById(task.id);

  // Step 3: schedule auto_command for fresh spawns only
  // (resumes already have it preloaded as the resume prompt)
  if (currentTask?.session_id && toLane.auto_command?.trim() && !resumePrompt) {
    const vars = buildAutoCommandVars(currentTask);
    const interpolated = context.commandBuilder.interpolateTemplate(toLane.auto_command, vars);
    context.commandInjector.schedule(currentTask.id, currentTask.session_id, interpolated, { freshlySpawned: true });
  }
}

/**
 * Auto-spawn an agent session for a newly created task when the target
 * swimlane has `auto_spawn` enabled. Handles worktree setup, branch checkout,
 * transition engine execution, session resume fallback, and auto-command
 * injection.
 *
 * Called from both the SessionManager `task-created` event (internal MCP
 * bridge) and the external CommandBridge `onTaskCreated` callback.
 */
export async function autoSpawnForTask(
  context: IpcContext,
  projectId: string,
  task: { id: string; title: string },
  swimlaneId: string,
): Promise<void> {
  try {
    const db = getProjectDb(projectId);
    const swimlaneRepo = new SwimlaneRepository(db);
    const toLane = swimlaneRepo.getById(swimlaneId);
    if (!toLane?.auto_spawn) return;

    const project = context.projectRepo.getById(projectId);
    const projectPath = project?.path ?? null;
    if (!projectPath) return;

    const { tasks, actions, attachments } = getProjectRepos(context, projectId);
    const fullTask = tasks.getById(task.id);
    if (!fullTask) return;

    try {
      await ensureTaskWorktree(context, fullTask, tasks, projectPath);
    } catch (worktreeError) {
      console.error('[MCP auto-spawn] Worktree creation failed:', worktreeError);
      return;
    }

    // Checkout branch for non-worktree tasks (may fail if another session is active)
    if (fullTask.base_branch && !fullTask.worktree_path) {
      try {
        // Inlined from guardActiveNonWorktreeSessions to avoid circular import with task-move.ts
        const activeSessions = context.sessionManager.listSessions()
          .filter(session => session.taskId !== fullTask.id && (session.status === 'running' || session.status === 'queued'));
        const otherNonWorktreeSessions = activeSessions.filter(session => {
          const otherTask = tasks.getById(session.taskId);
          return otherTask && !otherTask.worktree_path;
        });
        if (otherNonWorktreeSessions.length > 0) {
          throw new Error(
            `Cannot switch to branch '${fullTask.base_branch}': another task is running in the main repo. `
            + `Enable worktree mode for branch isolation.`
          );
        }
        await ensureTaskBranchCheckout(fullTask, projectPath);
      } catch (checkoutError) {
        console.error('[MCP auto-spawn] Branch checkout failed:', checkoutError);
        return;
      }
    }

    const sessionRepo = new SessionRepository(db);
    const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachments, projectId, projectPath);

    await spawnAgent({ context, engine, tasks, sessionRepo, task: fullTask, fromSwimlaneId: '*', toLane });

    console.log(`[MCP auto-spawn] Spawned agent for "${task.title}" in ${toLane.name}`);
  } catch (err) {
    console.error('[MCP auto-spawn] Failed:', err);
  }
}
