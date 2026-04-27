import fs from 'node:fs';
import { app } from 'electron';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { SessionManager } from '../../pty/session-manager';
import { ConfigManager } from '../../config/config-manager';
import type { SessionRecord, Task } from '../../../shared/types';
import { isResumeEligible } from '../spawn-intent';
import { retireRecord, markRecordSuspended } from '../session-lifecycle';
import { isShuttingDown } from '../../shutdown-state';
import { prepareAgentSpawn } from './prepare-spawn';

/**
 * Recover suspended and orphaned agent sessions on project open.
 *
 * Agent-agnostic: resolves the correct adapter per-task via agentRegistry,
 * so a project with mixed Claude/Gemini/Codex tasks recovers each with
 * the right CLI and command builder.
 *
 * Steps:
 *  1. Mark any leftover 'running' DB records as 'orphaned' (crash recovery).
 *  2. Collect all suspended + orphaned session records.
 *  3. Deduplicate: keep only the LATEST record per task_id.
 *  4. For each candidate, verify the task exists AND is NOT in a Backlog/Done
 *     column. Skip and mark exited otherwise.
 *  5. Detect the agent CLI, build the command, and spawn a new PTY.
 *  6. Mark old records as exited; insert fresh records for the new PTYs.
 */
export async function resumeSuspendedSessions(
  projectId: string,
  projectPath: string,
  sessionManager: SessionManager,
  configManager: ConfigManager,
  projectDefaultAgent?: string | null,
  mcpServerHandle?: import('../../agent/mcp-http-server').McpHttpServerHandle | null,
): Promise<void> {
  if (isShuttingDown()) return;

  const timerLabel = `[startup] resumeSuspendedSessions:${projectId.slice(0, 8)}`;
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
      .filter((session) => session.status === 'running' || session.status === 'queued')
      .map((session) => session.taskId),
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
      const existingTime = existing.started_at || '';
      const recordTime = record.started_at || '';
      if (recordTime > existingTime) {
        retireRecord(sessionRepo, existing.id);
        latestByTask.set(record.task_id, record);
      } else {
        retireRecord(sessionRepo, record.id);
      }
    }
  }

  const toRecover = Array.from(latestByTask.values());
  const duplicatesRetired = allRecords.length - toRecover.length;
  if (duplicatesRetired > 0) {
    console.log(`[SESSION_RECOVERY] Retired ${duplicatesRetired} duplicate record(s)`);
  }

  // 4. Determine which columns should NOT have active agents (auto_spawn=false)
  const swimlaneRepo = new SwimlaneRepository(db);
  const excludedLaneIds = new Set(
    swimlaneRepo.list()
      .filter((lane) => !lane.auto_spawn)
      .map((lane) => lane.id),
  );

  // --- Pre-filter: batch-resolve tasks and partition records ---
  const allTasks = taskRepo.list();
  const taskMap = new Map(allTasks.map((task) => [task.id, task]));

  const autoResumeSessionsOnRestart = configManager.load().agent.autoResumeSessionsOnRestart;

  const toProcess: Array<{ record: SessionRecord; task: Task }> = [];
  let skipped = 0;

  for (const record of toRecover) {
    if (liveTaskIds.has(record.task_id)) {
      skipped++;
      continue;
    }

    const task = taskMap.get(record.task_id);
    if (!task) {
      retireRecord(sessionRepo, record.id);
      skipped++;
      continue;
    }

    if (excludedLaneIds.has(task.swimlane_id)) {
      if (record.status !== 'suspended') {
        retireRecord(sessionRepo, record.id);
      }
      skipped++;
      continue;
    }

    // When auto-resume-on-restart is OFF, don't spawn. Register a suspended
    // placeholder so the renderer shows a Resume button. The record stays
    // marked 'system' (not 'user') so dragging the task through columns
    // still resumes normally - the 'user' marker is reserved for explicit
    // pauses via the Pause button (see spawnAgent's user-pause guard).
    //
    // For crashed (orphaned) records we atomically transition to 'suspended'
    // so we don't re-process them on next startup. If the CAS fails
    // (concurrent retire), skip quietly.
    if (!autoResumeSessionsOnRestart) {
      if (record.status === 'orphaned') {
        const upgraded = markRecordSuspended(sessionRepo, record.id, 'system');
        if (!upgraded) {
          skipped++;
          continue;
        }
      }
      sessionManager.registerSuspendedPlaceholder({
        taskId: record.task_id,
        projectId,
        cwd: record.cwd,
      });
      // Ensure task.session_id is null so SESSION_RESUME's precondition
      // passes when the user clicks the Resume button.
      if (task.session_id) {
        taskRepo.update({ id: task.id, session_id: null });
      }
      skipped++;
      continue;
    }

    // User explicitly paused (clicked Pause). Even when auto-resume-on-restart
    // is enabled, respect the pause. Register a placeholder so the renderer
    // shows "Paused" state. Clear task.session_id defensively - it should
    // already be null from SESSION_SUSPEND, but crash-recovery paths may
    // have left it set.
    if (record.status === 'suspended' && record.suspended_by === 'user') {
      sessionManager.registerSuspendedPlaceholder({
        taskId: record.task_id,
        projectId,
        cwd: record.cwd,
      });
      if (task.session_id) {
        taskRepo.update({ id: task.id, session_id: null });
      }
      skipped++;
      continue;
    }

    toProcess.push({ record, task });
  }

  if (toProcess.length === 0) {
    if (skipped > 0) {
      console.log(
        `[SESSION_RECOVERY] Skipped ${skipped} of ${toRecover.length} task(s) -- non-auto-spawn columns, deleted, user-paused, or auto-resume disabled`,
      );
    }
    if (!app.isPackaged) console.timeEnd(timerLabel);
    return;
  }

  const config = configManager.getEffectiveConfig(projectPath);
  const resolvedShell = await sessionManager.getShell();

  // --- Preparation pass: build spawn inputs per-task ---
  const spawnInputs: Array<{
    record: SessionRecord;
    task: Task;
    adapter: import('../../agent/agent-adapter').AgentAdapter;
    command: string;
    cwd: string;
    sessionRecordId: string;
    agentSessionId: string | null;
    permissionMode: string;
    statusOutputPath: string;
    eventsOutputPath: string;
  }> = [];

  for (const { record, task } of toProcess) {
    try {
      if (!fs.existsSync(record.cwd)) {
        if (task.worktree_path && !fs.existsSync(task.worktree_path)) {
          taskRepo.update({ id: task.id, worktree_path: null, branch_name: null });
        }
        console.log(`[SESSION_RECOVERY] CWD ${record.cwd} missing -- marking exited`);
        retireRecord(sessionRepo, record.id);
        skipped++;
        continue;
      }

      const swimlane = swimlaneRepo.getById(task.swimlane_id) ?? null;

      // Decide whether to resume or start fresh. Uses type-aware lookup
      // so cross-agent resume mismatches are structurally impossible.
      // The adapter isn't known yet - we use the record's session_type
      // which was captured at spawn time and is agent-specific.
      const typeMatch = sessionRepo.getLatestForTaskByType(record.task_id, record.session_type);
      const canResume = isResumeEligible(typeMatch);
      const resume = canResume ? { agentSessionId: typeMatch!.agent_session_id! } : null;

      const prep = await prepareAgentSpawn({
        task,
        swimlane,
        cwd: record.cwd,
        projectId,
        projectPath,
        effectiveConfig: config,
        projectDefaultAgent: projectDefaultAgent ?? null,
        resolvedShell,
        mcpServerHandle,
        resume,
      });

      if (!prep.ok) {
        if (prep.reason === 'unknown-agent') {
          console.warn(`[SESSION_RECOVERY] Unknown agent for task ${task.id.slice(0, 8)} -- skipping`);
        } else {
          console.warn(`[SESSION_RECOVERY] CLI not found for task ${task.id.slice(0, 8)} -- skipping`);
        }
        retireRecord(sessionRepo, record.id);
        skipped++;
        continue;
      }

      spawnInputs.push({ record, task, ...prep.data });
    } catch (err) {
      console.error(
        `[SESSION_RECOVERY] Preparation failed for session ${record.id} (task ${record.task_id}):`,
        err,
      );
      try {
        retireRecord(sessionRepo, record.id);
      } catch (updateErr) {
        console.error(`[SESSION_RECOVERY] Failed to mark session ${record.id} as exited:`, updateErr);
      }
    }
  }

  // --- Spawn pass (parallel): fire all spawns concurrently ---
  // Re-check shutdown flag after the preparation pass (which may have awaited
  // adapter.detect and shell resolution). Avoids firing N spawns that
  // would each individually throw and log errors against a closing DB.
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
        agentSessionId: input.agentSessionId,
        exitSequence: input.adapter.getExitSequence?.() ?? ['\x03'],
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

      retireRecord(sessionRepo, input.record.id);

      sessionRepo.insert({
        id: newSession.id,
        task_id: input.task.id,
        session_type: input.record.session_type,
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

      taskRepo.update({ id: input.task.id, session_id: newSession.id });
      recovered++;
    } else {
      const input = spawnInputs[resultIndex];
      console.error(
        `[SESSION_RECOVERY] Spawn failed for session ${input.record.id} (task ${input.record.task_id}):`,
        result.reason,
      );
      try {
        retireRecord(sessionRepo, input.record.id);
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
