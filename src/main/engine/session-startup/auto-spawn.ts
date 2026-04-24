import fs from 'node:fs';
import { app } from 'electron';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { SessionManager } from '../../pty/session-manager';
import { ConfigManager } from '../../config/config-manager';
import type { Task } from '../../../shared/types';
import { isShuttingDown } from '../../shutdown-state';
import { prepareAgentSpawn } from './prepare-spawn';

/**
 * Enforce the auto-spawn invariant on project open: find tasks in
 * `auto_spawn=true` columns that have no running PTY session, and
 * start a fresh agent for each.
 *
 * Handles the case where a task is in an active column but has no
 * session (e.g. the session exited, the app closed without suspend,
 * or the task was placed there manually). Unlike resumeSuspendedSessions,
 * this always starts a fresh agent - no resume semantics.
 *
 * Callers typically run resumeSuspendedSessions first (so dirty-shutdown
 * state is picked up as a resume rather than a fresh spawn), then this
 * to cover any remaining gaps.
 */
export async function autoSpawnTasks(
  projectId: string,
  projectPath: string,
  sessionManager: SessionManager,
  configManager: ConfigManager,
  projectDefaultAgent?: string | null,
  mcpServerHandle?: import('../../agent/mcp-http-server').McpHttpServerHandle | null,
): Promise<void> {
  if (isShuttingDown()) return;

  const timerLabel = `[startup] autoSpawnTasks:${projectId.slice(0, 8)}`;
  if (!app.isPackaged) console.time(timerLabel);
  const db = getProjectDb(projectId);
  const taskRepo = new TaskRepository(db);
  const sessionRepo = new SessionRepository(db);
  const config = configManager.getEffectiveConfig(projectPath);

  // Determine which columns should have active agents (auto_spawn=true)
  const swimlaneRepo = new SwimlaneRepository(db);
  const allLanes = swimlaneRepo.list();
  const activeLanes = allLanes.filter((lane) => lane.auto_spawn);
  if (activeLanes.length === 0) {
    if (!app.isPackaged) console.timeEnd(timerLabel);
    return;
  }

  const resolvedShell = await sessionManager.getShell();

  // Batch-fetch user-paused task IDs to skip during reconciliation
  const userPausedTaskIds = sessionRepo.getUserPausedTaskIds();

  // Discover incoming spawn_agent transitions so we know which columns
  // have a spawn trigger wired up. Action configs are NOT used to build
  // the command here - the legacy path read them but never passed them
  // to buildCommand, so we drop the lookup entirely.
  const actionRepo = new ActionRepository(db);
  const allTransitions = actionRepo.listTransitions();
  const allActions = actionRepo.list();
  const spawnAgentActionIds = new Set(
    allActions.filter((action) => action.type === 'spawn_agent').map((action) => action.id),
  );
  const lanesWithIncomingSpawn = new Set(
    allTransitions
      .filter((transition) => spawnAgentActionIds.has(transition.action_id))
      .map((transition) => transition.to_swimlane_id),
  );

  // --- Preparation pass: collect spawn inputs ---
  const spawnInputs: Array<{
    task: Task;
    adapter: import('../../agent/agent-adapter').AgentAdapter;
    agent: string;
    command: string;
    cwd: string;
    sessionRecordId: string;
    agentSessionId: string | null;
    permissionMode: string;
    statusOutputPath: string;
    eventsOutputPath: string;
  }> = [];

  for (const lane of activeLanes) {
    const tasks = taskRepo.list(lane.id);
    // Note: lanesWithIncomingSpawn is currently informational only -
    // every auto_spawn lane still gets its tasks auto-spawned regardless
    // of whether a transition wired a spawn_agent action to it. This
    // matches the pre-refactor behavior and is preserved by design.
    void lanesWithIncomingSpawn;

    for (const task of tasks) {
      // Skip if the session manager already has a session for this task -
      // running, queued, OR a suspended placeholder. Placeholders are
      // registered by resumeSuspendedSessions (which runs before this) for:
      //   - user-paused records (explicit Pause button)
      //   - 'system'-suspended records when autoResumeSessionsOnRestart=false
      // Either case, the user must explicitly Resume - don't auto-spawn over
      // the placeholder and clobber the resumable record's agent_session_id.
      if (sessionManager.hasSessionForTask(task.id)) continue;

      // Safety net: register a placeholder for user-paused records that
      // somehow weren't registered by resumeSuspendedSessions (e.g. the
      // record was created after that pass, or cwd existence check failed).
      // Without this the task would auto-spawn a fresh agent and lose the
      // --resume transcript.
      if (userPausedTaskIds.has(task.id)) {
        const cwd = task.worktree_path || projectPath;
        sessionManager.registerSuspendedPlaceholder({ taskId: task.id, projectId, cwd });
        continue;
      }

      try {
        let cwd = task.worktree_path || projectPath;

        // Guard: CWD must still exist -- fall back to projectPath if worktree was deleted
        if (task.worktree_path && !fs.existsSync(task.worktree_path)) {
          console.log(`[AUTO_SPAWN] Worktree missing for task ${task.id} -- falling back to project path`);
          taskRepo.update({ id: task.id, worktree_path: null, branch_name: null });
          cwd = projectPath;
        }
        if (!fs.existsSync(cwd)) {
          console.log(`[AUTO_SPAWN] CWD ${cwd} missing -- skipping task ${task.id}`);
          continue;
        }

        const prep = await prepareAgentSpawn({
          task,
          swimlane: lane,
          cwd,
          projectId,
          projectPath,
          effectiveConfig: config,
          projectDefaultAgent: projectDefaultAgent ?? null,
          resolvedShell,
          mcpServerHandle,
          resume: null,
        });

        if (!prep.ok) {
          if (prep.reason === 'unknown-agent') {
            console.warn(`[AUTO_SPAWN] Unknown agent for task ${task.id.slice(0, 8)} -- skipping`);
          } else {
            console.warn(`[AUTO_SPAWN] CLI not found for task ${task.id.slice(0, 8)} -- skipping`);
          }
          continue;
        }

        spawnInputs.push({ task, ...prep.data });
      } catch (err) {
        console.error(`[AUTO_SPAWN] Preparation failed for task ${task.id}:`, err);
      }
    }
  }

  // --- Spawn pass (parallel): fire all spawns concurrently ---
  if (isShuttingDown()) {
    if (!app.isPackaged) console.timeEnd(timerLabel);
    return;
  }

  const spawnResults = await Promise.allSettled(
    spawnInputs.map(async (input) => {
      const newSession = await sessionManager.spawn({
        id: input.sessionRecordId,
        taskId: input.task.id,
        projectId,
        command: input.command,
        cwd: input.cwd,
        statusOutputPath: input.statusOutputPath,
        eventsOutputPath: input.eventsOutputPath,
        agentParser: input.adapter,
        agentName: input.adapter.name,
        exitSequence: input.adapter.getExitSequence?.() ?? ['\x03'],
      });
      return { input, newSession };
    }),
  );

  // --- DB update pass (sequential): process results ---
  let spawned = 0;
  const now = new Date().toISOString();
  for (let resultIndex = 0; resultIndex < spawnResults.length; resultIndex++) {
    const result = spawnResults[resultIndex];
    if (result.status === 'fulfilled') {
      const { input, newSession } = result.value;

      taskRepo.update({
        id: input.task.id,
        session_id: newSession.id,
        agent: input.agent,
      });

      sessionRepo.insert({
        id: newSession.id,
        task_id: input.task.id,
        session_type: input.adapter.sessionType,
        agent_session_id: input.agentSessionId,
        command: input.command,
        cwd: input.cwd,
        permission_mode: input.permissionMode,
        prompt: null,
        status: 'running',
        exit_code: null,
        started_at: now,
        suspended_at: null,
        exited_at: null,
        suspended_by: null,
      });

      spawned++;
    } else {
      const input = spawnInputs[resultIndex];
      console.error(`[AUTO_SPAWN] Spawn failed for task ${input.task.id}:`, result.reason);
    }
  }

  if (spawned > 0) {
    console.log(`[AUTO_SPAWN] Spawned ${spawned} session(s) for tasks without agents`);
  }
  if (!app.isPackaged) console.timeEnd(timerLabel);
}
