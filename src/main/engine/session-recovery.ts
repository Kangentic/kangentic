import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectDb } from '../db/database';
import { SessionRepository } from '../db/repositories/session-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { ActionRepository } from '../db/repositories/action-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { SessionManager } from '../pty/session-manager';
import { ClaudeDetector } from '../agent/claude-detector';
import { CommandBuilder } from '../agent/command-builder';
import { ConfigManager } from '../config/config-manager';
import type { SessionRecord, ActionConfig, Task, PermissionMode } from '../../shared/types';
import { ensureWorktreeTrust, ensureMcpServerTrust } from '../agent/trust-manager';
import { isShuttingDown } from '../shutdown-state';
import { sessionOutputPaths } from './session-paths';
import { app } from 'electron';

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
  if (isShuttingDown()) return;

  const timerLabel = `[startup] recoverSessions:${projectId.slice(0, 8)}`;
  if (!app.isPackaged) console.time(timerLabel);
  const db = getProjectDb(projectId);
  const sessionRepo = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);

  // 1. Mark leftover 'running' records as orphaned (crash case).
  //    SKIP records whose task already has a live PTY session -- this prevents
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
  if (allRecords.length === 0) {
    if (!app.isPackaged) console.timeEnd(timerLabel);
    return;
  }

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
        // New record is newer -- retire the old one
        sessionRepo.updateStatus(existing.id, 'exited', { exited_at: now });
        latestByTask.set(record.task_id, record);
      } else {
        // Existing is newer -- retire this one
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
      }
    }
  }

  const toRecover = Array.from(latestByTask.values());
  const duplicatesRetired = allRecords.length - toRecover.length;
  if (duplicatesRetired > 0) {
    console.log(
      `[SESSION_RECOVERY] Retired ${duplicatesRetired} duplicate record(s)`,
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

    // Skip user-paused sessions -- they should stay suspended until manually resumed.
    // Register a suspended placeholder so the renderer shows "Paused" state
    // and the "Resume session" button. task.session_id stays null (cleared on
    // suspend) so the SESSION_RESUME guard still passes when the user clicks resume.
    if (record.status === 'suspended' && record.suspended_by === 'user') {
      sessionManager.registerSuspendedPlaceholder({
        taskId: record.task_id,
        projectId,
        cwd: record.cwd,
      });
      skipped++;
      continue;
    }

    toProcess.push({ record, task });
  }

  // Early exit: nothing to actually recover
  if (toProcess.length === 0) {
    if (skipped > 0) {
      console.log(
        `[SESSION_RECOVERY] Skipped ${skipped} of ${toRecover.length} task(s) -- non-auto-spawn columns, deleted, or user-paused`,
      );
    }
    if (!app.isPackaged) console.timeEnd(timerLabel);
    return;
  }

  // Detect Claude CLI once
  const config = configManager.getEffectiveConfig(projectPath);
  const claude = await claudeDetector.detect(config.claude.cliPath);
  if (!claude.found || !claude.path) {
    console.warn(
      '[SESSION_RECOVERY] Claude CLI not found -- skipping',
      toProcess.length,
      'session(s)',
    );
    if (!app.isPackaged) console.timeEnd(timerLabel);
    return;
  }

  // Resolve shell once for all sessions (same global setting)
  const resolvedShell = await sessionManager.getShell();

  // --- Preparation pass (synchronous): build spawn inputs ---
  interface SpawnInput {
    record: SessionRecord;
    task: Task;
    command: string;
    cwd: string;
    claudeSessionId: string;
    canResume: boolean;
    prompt: string | undefined;
    permissionMode: string;
    statusOutputPath: string;
    eventsOutputPath: string;
  }

  const spawnInputs: SpawnInput[] = [];

  for (const { record, task } of toProcess) {
    try {
      // --- Guard: CWD must still exist ---
      if (!fs.existsSync(record.cwd)) {
        // Clear stale worktree_path so reconcileSessions can pick up the task
        if (task.worktree_path && !fs.existsSync(task.worktree_path)) {
          taskRepo.update({ id: task.id, worktree_path: null, branch_name: null });
        }
        console.log(
          `[SESSION_RECOVERY] CWD ${record.cwd} missing -- marking exited`,
        );
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
        skipped++;
        continue;
      }

      // Pre-populate trust so the agent doesn't block on the trust dialog
      await ensureWorktreeTrust(record.cwd);
      await ensureMcpServerTrust(record.cwd);

      // Resolution order: lane override → global config.
      // Use the task's current swimlane to resolve permission mode.
      const taskLane = swimlaneRepo.getById(task.swimlane_id);
      const permissionMode = taskLane?.permission_mode ?? config.claude.permissionMode;

      // Decide whether to resume or start fresh.
      const canResume = (record.status === 'suspended' || record.status === 'orphaned')
        && !!record.claude_session_id;

      let prompt: string | undefined;
      let claudeSessionId: string;

      if (canResume) {
        claudeSessionId = record.claude_session_id!;
        prompt = undefined;
      } else {
        claudeSessionId = randomUUID();
        // Recovery is resuming previously-started work, not starting fresh.
        // Don't re-send the original task description as it would duplicate context.
        prompt = undefined;
      }

      // Ensure the per-session directory exists
      const sessionDir = path.join(projectPath, '.kangentic', 'sessions', claudeSessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
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
        shell: resolvedShell,
        mcpServerEnabled: config.mcpServer?.enabled ?? true,
      });

      spawnInputs.push({
        record, task, command, cwd: record.cwd,
        claudeSessionId, canResume, prompt, permissionMode,
        statusOutputPath, eventsOutputPath,
      });
    } catch (err) {
      console.error(
        `[SESSION_RECOVERY] Preparation failed for session ${record.id} (task ${record.task_id}):`,
        err,
      );
      try {
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
      } catch (updateErr) {
        console.error(`[SESSION_RECOVERY] Failed to mark session ${record.id} as exited:`, updateErr);
      }
    }
  }

  // --- Spawn pass (parallel): fire all spawns concurrently ---
  // Re-check shutdown flag after the preparation pass (which may have awaited
  // claudeDetector.detect and shell resolution). Avoids firing N spawns that
  // would each individually throw and log errors against a closing DB.
  if (isShuttingDown()) {
    if (!app.isPackaged) console.timeEnd(timerLabel);
    return;
  }
  const spawnResults = await Promise.allSettled(
    spawnInputs.map(async (input) => {
      const newSession = await sessionManager.spawn({
        taskId: input.task.id,
        projectId,
        command: input.command,
        cwd: input.cwd,
        statusOutputPath: input.statusOutputPath,
        eventsOutputPath: input.eventsOutputPath,
      });
      return { input, newSession };
    }),
  );

  // --- DB update pass (sequential): process results ---
  let recovered = 0;
  for (let resultIndex = 0; resultIndex < spawnResults.length; resultIndex++) {
    const result = spawnResults[resultIndex];
    if (result.status === 'fulfilled') {
      const { input, newSession } = result.value;

      sessionRepo.updateStatus(input.record.id, 'exited', { exited_at: now });

      sessionRepo.insert({
        task_id: input.task.id,
        session_type: 'claude_agent',
        claude_session_id: input.claudeSessionId,
        command: input.command,
        cwd: input.cwd,
        permission_mode: input.permissionMode,
        prompt: input.prompt ?? null,
        status: 'running',
        exit_code: null,
        started_at: now,
        suspended_at: null,
        exited_at: null,
        suspended_by: null,
      });

      taskRepo.update({
        id: input.task.id,
        session_id: newSession.id,
      });

      recovered++;
    } else {
      const input = spawnInputs[resultIndex];
      console.error(
        `[SESSION_RECOVERY] Spawn failed for session ${input.record.id} (task ${input.record.task_id}):`,
        result.reason,
      );
      try {
        sessionRepo.updateStatus(input.record.id, 'exited', { exited_at: now });
      } catch (updateErr) {
        console.error(`[SESSION_RECOVERY] Failed to mark session ${input.record.id} as exited:`, updateErr);
      }
    }
  }

  if (recovered > 0 || skipped > 0) {
    console.log(
      `[SESSION_RECOVERY] Resumed ${recovered}, skipped ${skipped} (of ${toRecover.length} unique tasks, ${allRecords.length} total records)`,
    );
  }
  if (!app.isPackaged) console.timeEnd(timerLabel);
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
  if (isShuttingDown()) return;

  const reconcileTimerLabel = `[startup] reconcileSessions:${projectId.slice(0, 8)}`;
  if (!app.isPackaged) console.time(reconcileTimerLabel);
  const db = getProjectDb(projectId);
  const taskRepo = new TaskRepository(db);
  const actionRepo = new ActionRepository(db);
  const sessionRepo = new SessionRepository(db);
  const config = configManager.getEffectiveConfig(projectPath);

  // Determine which columns should have active agents (auto_spawn=true)
  const swimlaneRepo = new SwimlaneRepository(db);
  const allLanes = swimlaneRepo.list();
  const activeLanes = allLanes.filter(l => l.auto_spawn);
  if (activeLanes.length === 0) {
    if (!app.isPackaged) console.timeEnd(reconcileTimerLabel);
    return;
  }

  // Build set of task IDs that already have a running PTY session
  const activePtySessions = sessionManager.listSessions();
  const activeTaskIds = new Set(
    activePtySessions
      .filter((s) => s.status === 'running')
      .map((s) => s.taskId),
  );

  // Detect Claude CLI once before the loop
  const claude = await claudeDetector.detect(config.claude.cliPath);
  if (!claude.found || !claude.path) {
    console.warn(
      '[SESSION_RECONCILE] Claude CLI not found -- skipping all tasks',
    );
    if (!app.isPackaged) console.timeEnd(reconcileTimerLabel);
    return;
  }

  // Resolve shell once for all sessions (same global setting)
  const resolvedShell = await sessionManager.getShell();

  // Batch-fetch user-paused task IDs to skip during reconciliation
  const userPausedTaskIds = sessionRepo.getUserPausedTaskIds();

  // Cache transitions and actions for building commands
  const allTransitions = actionRepo.listTransitions();
  const allActions = actionRepo.list();

  // --- Preparation pass (synchronous): collect spawn inputs ---
  interface ReconcileSpawnInput {
    task: Task;
    command: string;
    cwd: string;
    claudeSessionId: string;
    prompt: string | undefined;
    permissionMode: string;
    agent: string;
    statusOutputPath: string;
    eventsOutputPath: string;
  }

  const spawnInputs: ReconcileSpawnInput[] = [];

  for (const lane of activeLanes) {
    const tasks = taskRepo.list(lane.id);
    for (const task of tasks) {
      if (activeTaskIds.has(task.id)) continue; // already has a session

      // Skip tasks whose latest session was user-paused -- respect user intent.
      // Register placeholder so renderer shows paused state (if not already registered).
      if (userPausedTaskIds.has(task.id)) {
        if (!sessionManager.hasSessionForTask(task.id)) {
          const cwd = task.worktree_path || projectPath;
          sessionManager.registerSuspendedPlaceholder({
            taskId: task.id,
            projectId,
            cwd,
          });
        }
        continue;
      }

      try {
        // Find a spawn_agent transition that targets this lane (optional -- provides custom prompt)
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
              console.error(`[SESSION_RECONCILE] Malformed config for action ${action.id} -- using defaults`);
            }
          }
        }

        // Resolution order: lane override → global setting
        const permissionMode =
          lane.permission_mode ?? config.claude.permissionMode;
        let cwd = task.worktree_path || projectPath;

        // Guard: CWD must still exist -- fall back to projectPath if worktree was deleted
        if (task.worktree_path && !fs.existsSync(task.worktree_path)) {
          console.log(`[SESSION_RECONCILE] Worktree missing for task ${task.id} -- falling back to project path`);
          taskRepo.update({ id: task.id, worktree_path: null, branch_name: null });
          cwd = projectPath;
        }
        if (!fs.existsSync(cwd)) {
          console.log(
            `[SESSION_RECONCILE] CWD ${cwd} missing -- skipping task ${task.id}`,
          );
          continue;
        }

        // Pre-populate trust so the agent doesn't block on the trust dialog
        await ensureWorktreeTrust(cwd);
        await ensureMcpServerTrust(cwd);

        // Generate a Claude session ID upfront so recovery can resume
        const claudeSessionId = randomUUID();
        // Reconciliation is resuming previously-started work, not starting fresh.
        // Don't re-send the original task description as it would duplicate context.
        const prompt = undefined;

        // Ensure the per-session directory exists
        const sessionDir = path.join(projectPath, '.kangentic', 'sessions', claudeSessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
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
          shell: resolvedShell,
          mcpServerEnabled: config.mcpServer?.enabled ?? true,
        });

        spawnInputs.push({
          task, command, cwd, claudeSessionId, prompt, permissionMode,
          agent: actionConfig?.agent || 'claude',
          statusOutputPath, eventsOutputPath,
        });
      } catch (err) {
        console.error(
          `[SESSION_RECONCILE] Preparation failed for task ${task.id}:`,
          err,
        );
      }
    }
  }

  // --- Spawn pass (parallel): fire all spawns concurrently ---
  if (isShuttingDown()) {
    if (!app.isPackaged) console.timeEnd(reconcileTimerLabel);
    return;
  }
  const spawnResults = await Promise.allSettled(
    spawnInputs.map(async (input) => {
      const newSession = await sessionManager.spawn({
        taskId: input.task.id,
        projectId,
        command: input.command,
        cwd: input.cwd,
        statusOutputPath: input.statusOutputPath,
        eventsOutputPath: input.eventsOutputPath,
      });
      return { input, newSession };
    }),
  );

  // --- DB update pass (sequential): process results ---
  let reconciled = 0;
  const reconcileNow = new Date().toISOString();
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
        task_id: input.task.id,
        session_type: 'claude_agent',
        claude_session_id: input.claudeSessionId,
        command: input.command,
        cwd: input.cwd,
        permission_mode: input.permissionMode,
        prompt: input.prompt ?? null,
        status: 'running',
        exit_code: null,
        started_at: reconcileNow,
        suspended_at: null,
        exited_at: null,
        suspended_by: null,
      });

      reconciled++;
    } else {
      const input = spawnInputs[resultIndex];
      console.error(
        `[SESSION_RECONCILE] Spawn failed for task ${input.task.id}:`,
        result.reason,
      );
    }
  }

  if (reconciled > 0) {
    console.log(
      `[SESSION_RECONCILE] Spawned ${reconciled} session(s) for tasks without agents`,
    );
  }
  if (!app.isPackaged) console.timeEnd(reconcileTimerLabel);
}

