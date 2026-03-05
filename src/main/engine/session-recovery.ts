import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectDb } from '../db/database';
import { SessionRepository } from '../db/repositories/session-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { ActionRepository } from '../db/repositories/action-repository';
import { AttachmentRepository } from '../db/repositories/attachment-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { SessionManager } from '../pty/session-manager';
import { ClaudeDetector } from '../agent/claude-detector';
import { CommandBuilder } from '../agent/command-builder';
import { ConfigManager } from '../config/config-manager';
import type { SessionRecord, ActionConfig, Task, PermissionMode } from '../../shared/types';
import { ensureWorktreeTrust } from '../agent/trust-manager';
import { sessionOutputPaths } from './session-paths';
import { sanitizeForPty } from '../../shared/paths';

// ---------------------------------------------------------------------------
// Prune orphaned worktree tasks (worktree dir deleted externally)
// ---------------------------------------------------------------------------

/**
 * Delete tasks whose worktree directories have been removed outside the app.
 *
 * Called on project open, before session recovery. Only prunes if the
 * `.kangentic/worktrees/` parent directory exists (if missing, the project
 * may be on an unmounted drive — don't prune anything).
 *
 * Never prunes tasks without a worktree_path or tasks with an active PTY.
 */
export function pruneOrphanedWorktrees(
  projectPath: string,
  taskRepo: TaskRepository,
  sessionRepo: SessionRepository,
  sessionManager: SessionManager,
): number {
  const worktreesDir = path.join(projectPath, '.kangentic', 'worktrees');
  if (!fs.existsSync(worktreesDir)) return 0; // Parent missing — don't prune

  const activeTaskIds = new Set(
    sessionManager.listSessions()
      .filter(s => s.status === 'running' || s.status === 'queued')
      .map(s => s.taskId),
  );

  let pruned = 0;
  for (const task of taskRepo.list()) {
    if (!task.worktree_path) continue;              // Never had a worktree
    if (fs.existsSync(task.worktree_path)) continue; // Worktree still exists
    if (activeTaskIds.has(task.id)) continue;         // Safety check

    console.log(`[PRUNE] Deleting orphaned task "${task.title}" (${task.id.slice(0, 8)}) -- worktree missing`);
    sessionRepo.deleteByTaskId(task.id);
    taskRepo.delete(task.id);
    pruned++;
  }

  // Background pass: remove stale worktree, session, and task directories
  // not referenced by any task. Collects ALL referenced IDs (including archived
  // tasks) synchronously, then runs async deletion so the UI stays responsive.
  const allTasks = [...taskRepo.list(), ...taskRepo.listArchived()];
  const referencedWorktrees = new Set(allTasks.map(t => t.worktree_path).filter((p): p is string => Boolean(p)));
  const referencedTaskIds = new Set(allTasks.map(t => t.id));
  const referencedSessionDirIds = new Set([
    ...allTasks.map(t => t.id),              // session dirs may be named by task ID
    ...allTasks.map(t => t.session_id).filter((s): s is string => Boolean(s)),
    ...sessionManager.listSessions().map(s => s.id),
    ...sessionRepo.listAllClaudeSessionIds(), // session dirs are named by Claude session ID
  ]);

  pruneStaleResources(projectPath, referencedWorktrees, referencedTaskIds, referencedSessionDirIds)
    .catch(err => console.warn('[PRUNE] Background cleanup failed:', err));

  return pruned;
}

/**
 * Background cleanup of orphaned directories under `.kangentic/`.
 *
 * Scans three subdirectories and removes entries not referenced by any task:
 *  - `worktrees/<slug>/`  — matched against task.worktree_path
 *  - `sessions/<uuid>/`   — matched against task.session_id + active PTY sessions
 *  - `tasks/<uuid>/`      — matched against task.id
 *
 * Uses async fs for non-blocking I/O so the UI stays responsive.
 * Retries EPERM failures (Windows file handle timing) with increasing delays.
 */
async function pruneStaleResources(
  projectPath: string,
  referencedWorktrees: Set<string>,
  referencedTaskIds: Set<string>,
  referencedSessionIds: Set<string>,
): Promise<void> {
  const kangenticDir = path.join(projectPath, '.kangentic');

  // Worktree directories: match by full path
  await pruneDirectory(
    path.join(kangenticDir, 'worktrees'),
    (dirPath) => referencedWorktrees.has(dirPath),
    'worktree',
  );

  // Session directories: match by directory name (UUID) against session IDs
  await pruneDirectory(
    path.join(kangenticDir, 'sessions'),
    (_dirPath, name) => referencedSessionIds.has(name),
    'session',
  );

  // Task directories: match by directory name (UUID) against task IDs
  await pruneDirectory(
    path.join(kangenticDir, 'tasks'),
    (_dirPath, name) => referencedTaskIds.has(name),
    'task',
  );
}

/** Remove unreferenced subdirectories with retry on EPERM. */
async function pruneDirectory(
  parentDir: string,
  isReferenced: (dirPath: string, name: string) => boolean,
  label: string,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist — nothing to prune
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(parentDir, entry.name);
    if (isReferenced(dirPath, entry.name)) continue;

    console.log(`[PRUNE] Removing orphaned ${label} directory: ${entry.name}`);

    let removed = false;
    const delays = [0, 300, 1000];
    for (const delay of delays) {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        removed = true;
        break;
      } catch {
        // EPERM — retry after next delay
      }
    }
    if (!removed) {
      console.warn(`[PRUNE] Could not remove orphaned ${label} directory ${entry.name} after retries`);
    }
  }
}

// ---------------------------------------------------------------------------
// Session recovery (resume suspended / orphaned sessions)
// ---------------------------------------------------------------------------

/**
 * Recover suspended and orphaned Claude agent sessions on project open.
 *
 * Steps:
 *  1. Mark any leftover 'running' DB records as 'orphaned' (crash recovery).
 *  2. Collect all suspended + orphaned `claude_agent` session records.
 *  3. Deduplicate: keep only the LATEST record per task_id.
 *     Mark all older duplicates as exited. This prevents compounding on
 *     repeated restarts.
 *  4. For each candidate, verify the task exists AND is NOT in a Backlog/Done
 *     column. Skip and mark exited otherwise.
 *  5. Spawn a new PTY with `--session-id` to let Claude CLI resume.
 *  6. Mark old records as exited; insert fresh records for the new PTYs.
 */
export async function recoverSessions(
  projectId: string,
  projectPath: string,
  sessionManager: SessionManager,
  claudeDetector: ClaudeDetector,
  commandBuilder: CommandBuilder,
  configManager: ConfigManager,
): Promise<void> {
  const db = getProjectDb(projectId);
  const sessionRepo = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);
  const actionRepo = new ActionRepository(db);
  const attachmentRepo = new AttachmentRepository(db);

  // 1. Mark leftover 'running' records as orphaned (crash case).
  //    SKIP records whose task already has a live PTY session — this prevents
  //    re-entrant calls (Vite hot-reload, duplicate PROJECT_OPEN) from
  //    orphaning sessions that were JUST created and are actively running.
  const liveTaskIds = new Set(
    sessionManager.listSessions()
      .filter(s => s.status === 'running' || s.status === 'queued')
      .map(s => s.taskId),
  );
  if (liveTaskIds.size > 0) {
    sessionRepo.markRunningAsOrphanedExcluding(liveTaskIds);
  } else {
    sessionRepo.markAllRunningAsOrphaned();
  }

  // 2. Gather ALL recoverable session records
  const suspended = sessionRepo.getResumable();
  const orphaned = sessionRepo.getOrphaned();
  const allRecords = [...suspended, ...orphaned];
  if (allRecords.length === 0) return;

  // 3. Deduplicate: for each task_id, keep only the most recent record.
  //    Mark all older duplicates as exited immediately.
  const now = new Date().toISOString();
  const latestByTask = new Map<string, SessionRecord>();

  for (const record of allRecords) {
    const existing = latestByTask.get(record.task_id);
    if (!existing) {
      latestByTask.set(record.task_id, record);
    } else {
      // Keep whichever has the later started_at; retire the other
      const existingTime = existing.started_at || '';
      const recordTime = record.started_at || '';
      if (recordTime > existingTime) {
        // New record is newer — retire the old one
        sessionRepo.updateStatus(existing.id, 'exited', { exited_at: now });
        latestByTask.set(record.task_id, record);
      } else {
        // Existing is newer — retire this one
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
      }
    }
  }

  const toRecover = Array.from(latestByTask.values());
  const duplicatesRetired = allRecords.length - toRecover.length;
  if (duplicatesRetired > 0) {
    console.log(
      `Session recovery: retired ${duplicatesRetired} duplicate record(s)`,
    );
  }

  // 4. Determine which columns should NOT have active agents (auto_spawn=false)
  const swimlaneRepo = new SwimlaneRepository(db);
  const excludedLaneIds = new Set(
    swimlaneRepo.list()
      .filter(l => !l.auto_spawn)
      .map(l => l.id),
  );

  // --- Pre-filter: batch-resolve tasks and partition records ---
  // Fetch all tasks in one query instead of N individual getById calls.
  // Tasks that are archived will be absent from the map and treated as deleted.
  const allTasks = taskRepo.list();
  const taskMap = new Map(allTasks.map(t => [t.id, t]));

  const toProcess: Array<{ record: SessionRecord; task: Task }> = [];
  let skipped = 0;

  for (const record of toRecover) {
    if (liveTaskIds.has(record.task_id)) {
      skipped++;
      continue;
    }

    const task = taskMap.get(record.task_id);
    if (!task) {
      sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
      skipped++;
      continue;
    }

    if (excludedLaneIds.has(task.swimlane_id)) {
      if (record.status !== 'suspended') {
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
      }
      skipped++;
      continue;
    }

    toProcess.push({ record, task });
  }

  // Early exit: nothing to actually recover
  if (toProcess.length === 0) {
    if (skipped > 0) {
      console.log(
        `Session recovery: skipped ${skipped} of ${toRecover.length} task(s) -- all in non-auto-spawn columns or deleted`,
      );
    }
    return;
  }

  // Cache transitions and actions for prompt lookup during recovery
  const allTransitions = actionRepo.listTransitions();
  const allActions = actionRepo.list();

  // Detect Claude CLI once
  const config = configManager.getEffectiveConfig(projectPath);
  const claude = await claudeDetector.detect(config.claude.cliPath);
  if (!claude.found || !claude.path) {
    console.warn(
      'Session recovery: Claude CLI not found — skipping',
      toProcess.length,
      'session(s)',
    );
    return;
  }

  let recovered = 0;

  for (const { record, task } of toProcess) {
    try {
      // --- Guard: CWD must still exist ---
      if (!fs.existsSync(record.cwd)) {
        // Clear stale worktree_path so reconcileSessions can pick up the task
        if (task.worktree_path && !fs.existsSync(task.worktree_path)) {
          taskRepo.update({ id: task.id, worktree_path: null, branch_name: null });
        }
        console.log(
          `Session recovery: cwd ${record.cwd} missing — marking exited`,
        );
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
        skipped++;
        continue;
      }

      // Pre-populate trust for worktree paths
      if (record.cwd !== projectPath) {
        ensureWorktreeTrust(record.cwd);
      }

      // Resolution order: lane override → global config.
      // Use the task's current swimlane to resolve permission mode.
      const taskLane = swimlaneRepo.getById(task.swimlane_id);
      const permissionMode = taskLane?.permission_strategy ?? config.claude.permissionMode;

      // Decide whether to resume or start fresh.
      // Both SUSPENDED (clean shutdown) and ORPHANED (crash) sessions can
      // attempt --resume as long as the claude_session_id is known — the
      // JSONL file is usually intact. If the file is missing or corrupt,
      // Claude CLI will error and the session exits; reconciliation will
      // create a fresh one on the next app launch.
      const canResume = (record.status === 'suspended' || record.status === 'orphaned')
        && !!record.claude_session_id;

      let prompt: string | undefined;
      let claudeSessionId: string;

      if (canResume) {
        // Resume existing Claude conversation — no extra prompt needed
        claudeSessionId = record.claude_session_id!;
        prompt = undefined;
      } else {
        // Fresh session (orphaned or no prior session ID)
        claudeSessionId = randomUUID();

        // Find the spawn_agent action that targets this task's lane
        const incomingTransition = allTransitions.find(
          (t) =>
            t.to_swimlane_id === task.swimlane_id &&
            allActions.find((a) => a.id === t.action_id)?.type === 'spawn_agent',
        );
        const action = incomingTransition
          ? allActions.find((a) => a.id === incomingTransition.action_id)
          : undefined;
        let actionConfig: ActionConfig | undefined;
        if (action) {
          try {
            actionConfig = JSON.parse(action.config_json) as ActionConfig;
          } catch {
            console.error(`Session recovery: malformed config for action ${action.id} -- using defaults`);
          }
        }

        const cleanTitle = sanitizeForPty(task.title);
        const cleanDesc = sanitizeForPty(task.description);
        const attachmentPaths = attachmentRepo.getPathsForTask(task.id);
        prompt = actionConfig?.promptTemplate
          ? commandBuilder.interpolateTemplate(actionConfig.promptTemplate, {
              title: cleanTitle,
              description: cleanDesc ? `: ${cleanDesc}` : '',
              taskId: task.id,
              worktreePath: task.worktree_path || '',
              branchName: task.branch_name || '',
              attachments: attachmentPaths.length > 0
                ? ` [Review images: ${attachmentPaths.join(', ')}]`
                : '',
            })
          : undefined;
      }

      // Ensure the per-session directory exists
      const sessionDir = path.join(projectPath, '.kangentic', 'sessions', claudeSessionId);
      try {
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (err) {
        console.error(`Failed to create session directory: ${sessionDir}`, err);
        throw new Error(`Cannot create session directory at ${sessionDir}: ${(err as Error).message}`);
      }
      const { statusOutputPath, eventsOutputPath } = sessionOutputPaths(sessionDir);

      const command = commandBuilder.buildClaudeCommand({
        claudePath: claude.path,
        taskId: task.id,
        prompt,
        cwd: record.cwd,
        permissionMode: permissionMode as PermissionMode,
        projectRoot: projectPath,
        sessionId: claudeSessionId,
        resume: canResume,
        statusOutputPath,
        eventsOutputPath,
      });

      // Spawn a new PTY
      const newSession = await sessionManager.spawn({
        taskId: task.id,
        projectId,
        command,
        cwd: record.cwd,
        statusOutputPath,
        eventsOutputPath,
      });

      // Mark old record as exited
      sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });

      // Insert new record for the resumed session
      sessionRepo.insert({
        task_id: task.id,
        session_type: 'claude_agent',
        claude_session_id: claudeSessionId,
        command,
        cwd: record.cwd,
        permission_mode: permissionMode,
        prompt: prompt ?? null,
        status: 'running',
        exit_code: null,
        started_at: now,
        suspended_at: null,
        exited_at: null,
      });

      // Update the task's session_id to point to the new PTY
      taskRepo.update({
        id: task.id,
        session_id: newSession.id,
      });

      recovered++;
    } catch (err) {
      console.error(
        `Session recovery failed for session ${record.id} (task ${record.task_id}):`,
        err,
      );
      try {
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
      } catch (updateErr) {
        console.error(`Failed to mark session ${record.id} as exited:`, updateErr);
      }
    }
  }

  if (recovered > 0 || skipped > 0) {
    console.log(
      `Session recovery: resumed ${recovered}, skipped ${skipped} (of ${toRecover.length} unique tasks, ${allRecords.length} total records)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Session reconciliation (spawn fresh agents for orphaned tasks)
// ---------------------------------------------------------------------------

/**
 * Reconcile sessions on project open: find tasks in auto_spawn columns
 * that don't have a running PTY session, and spawn one.
 *
 * This handles the case where a task is in an active column but has no
 * session (e.g., session exited, app closed without suspend, or the task
 * was placed there manually).
 */
export async function reconcileSessions(
  projectId: string,
  projectPath: string,
  sessionManager: SessionManager,
  claudeDetector: ClaudeDetector,
  commandBuilder: CommandBuilder,
  configManager: ConfigManager,
): Promise<void> {
  const db = getProjectDb(projectId);
  const taskRepo = new TaskRepository(db);
  const actionRepo = new ActionRepository(db);
  const sessionRepo = new SessionRepository(db);
  const attachmentRepo = new AttachmentRepository(db);
  const config = configManager.getEffectiveConfig(projectPath);

  // Determine which columns should have active agents (auto_spawn=true)
  const swimlaneRepo = new SwimlaneRepository(db);
  const allLanes = swimlaneRepo.list();
  const activeLanes = allLanes.filter(l => l.auto_spawn);
  if (activeLanes.length === 0) return;

  // Build set of task IDs that already have a running PTY session
  const activePtySessions = sessionManager.listSessions();
  const activeTaskIds = new Set(
    activePtySessions
      .filter((s) => s.status === 'running')
      .map((s) => s.taskId),
  );

  // Cache transitions and actions for building commands
  const allTransitions = actionRepo.listTransitions();
  const allActions = actionRepo.list();

  let reconciled = 0;
  for (const lane of activeLanes) {
    const tasks = taskRepo.list(lane.id);
    for (const task of tasks) {
      if (activeTaskIds.has(task.id)) continue; // already has a session

      try {
        // Find a spawn_agent transition that targets this lane (optional — provides custom prompt)
        const incomingTransition = allTransitions.find(
          (t) =>
            t.to_swimlane_id === lane.id &&
            allActions.find((a) => a.id === t.action_id)?.type === 'spawn_agent',
        );

        let actionConfig: ActionConfig | undefined;
        if (incomingTransition) {
          const action = allActions.find(
            (a) => a.id === incomingTransition.action_id,
          );
          if (action) {
            try {
              actionConfig = JSON.parse(action.config_json);
            } catch {
              console.error(`Session reconciliation: malformed config for action ${action.id} -- using defaults`);
            }
          }
        }

        // Resolution order: lane override → action config → global setting
        const permissionMode =
          lane.permission_strategy ?? actionConfig?.permissionMode ?? config.claude.permissionMode;
        let cwd = task.worktree_path || projectPath;

        // Guard: CWD must still exist — fall back to projectPath if worktree was deleted
        if (task.worktree_path && !fs.existsSync(task.worktree_path)) {
          console.log(`Session reconciliation: worktree missing for task ${task.id} -- falling back to project path`);
          taskRepo.update({ id: task.id, worktree_path: null, branch_name: null });
          cwd = projectPath;
        }
        if (!fs.existsSync(cwd)) {
          console.log(
            `Session reconciliation: cwd ${cwd} missing — skipping task ${task.id}`,
          );
          continue;
        }

        // Pre-populate trust for worktree paths
        if (cwd !== projectPath) {
          ensureWorktreeTrust(cwd);
        }

        const claude = await claudeDetector.detect(config.claude.cliPath);
        if (!claude.found || !claude.path) {
          console.warn(
            `Session reconciliation: Claude CLI not found — skipping task ${task.id}`,
          );
          continue;
        }

        // Generate a Claude session ID upfront so recovery can resume
        const claudeSessionId = randomUUID();
        const cleanTitle = sanitizeForPty(task.title);
        const cleanDesc = sanitizeForPty(task.description);
        const attachmentPaths = attachmentRepo.getPathsForTask(task.id);
        const prompt = actionConfig?.promptTemplate
          ? commandBuilder.interpolateTemplate(actionConfig.promptTemplate, {
              title: cleanTitle,
              description: cleanDesc ? `: ${cleanDesc}` : '',
              taskId: task.id,
              worktreePath: task.worktree_path || '',
              branchName: task.branch_name || '',
              attachments: attachmentPaths.length > 0
                ? ` [Review images: ${attachmentPaths.join(', ')}]`
                : '',
            })
          : undefined;

        // Ensure the per-session directory exists
        const sessionDir = path.join(projectPath, '.kangentic', 'sessions', claudeSessionId);
        try {
          fs.mkdirSync(sessionDir, { recursive: true });
        } catch (err) {
          console.error(`Failed to create session directory: ${sessionDir}`, err);
          throw new Error(`Cannot create session directory at ${sessionDir}: ${(err as Error).message}`);
        }
        const { statusOutputPath, eventsOutputPath } = sessionOutputPaths(sessionDir);

        const command = commandBuilder.buildClaudeCommand({
          claudePath: claude.path,
          taskId: task.id,
          prompt,
          cwd,
          permissionMode: permissionMode as PermissionMode,
          projectRoot: projectPath,
          sessionId: claudeSessionId,
          statusOutputPath,
          eventsOutputPath,
        });

        const session = await sessionManager.spawn({
          taskId: task.id,
          projectId,
          command,
          cwd,
          statusOutputPath,
          eventsOutputPath,
        });

        taskRepo.update({
          id: task.id,
          session_id: session.id,
          agent: actionConfig?.agent || 'claude',
        });

        sessionRepo.insert({
          task_id: task.id,
          session_type: 'claude_agent',
          claude_session_id: claudeSessionId,
          command,
          cwd,
          permission_mode: permissionMode,
          prompt: prompt ?? null,
          status: 'running',
          exit_code: null,
          started_at: new Date().toISOString(),
          suspended_at: null,
          exited_at: null,
        });

        reconciled++;
      } catch (err) {
        console.error(
          `Session reconciliation failed for task ${task.id}:`,
          err,
        );
      }
    }
  }

  if (reconciled > 0) {
    console.log(
      `Session reconciliation: spawned ${reconciled} session(s) for tasks without agents`,
    );
  }
}

