import fs from 'node:fs';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { SessionManager } from '../../pty/session-manager';
import { ConfigManager } from '../../config/config-manager';
import type { BoardProfile, SessionRecord, Task } from '../../../shared/types';
import { isResumeEligible } from '../spawn-intent';
import { applyProfileToLane, findTaskProfile } from '../column-strategy';
import { resolveIsolatedSwimlaneId } from '../session-isolation';
import { retireRecord, markRecordSuspended } from '../session-lifecycle';
import { isShuttingDown } from '../../shutdown-state';
import { prepareAgentSpawn, type PreparedSpawn } from './prepare-spawn';
import { startStartupTimer } from './timing';

/**
 * Recover suspended and orphaned agent sessions on project open.
 *
 * Agent-agnostic: resolves the correct adapter per-task via agentRegistry,
 * so a project with mixed Claude/Gemini/Codex tasks recovers each with
 * the right CLI and command builder.
 *
 * Steps:
 *  1. Mark any leftover 'running' DB records as 'orphaned' (crash recovery).
 *  2. Collect all suspended + orphaned records, plus OS-killed "interrupted"
 *     records: status='exited' with an abnormal code (hard shutdown beat the
 *     clean-quit suspend; see getInterruptedExited). All three feed the same
 *     dedup/resume pipeline so autoSpawnTasks stays the pure-fresh fallback.
 *  3. Deduplicate: keep only the LATEST record per (task_id, isolated_swimlane_id).
 *  4. For each candidate, verify the task exists AND is NOT in a Backlog/Done
 *     column. Skip otherwise: retire the record, or preserve an OS-killed
 *     interrupted-exited record as suspended for future resume.
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
  projectDefaultModel?: string | null,
  projectDefaultEffort?: string | null,
  /** Board Board Profiles, so a profiled task resumes on the same rung it spawned under. */
  boardProfiles?: ReadonlyArray<BoardProfile>,
): Promise<void> {
  if (isShuttingDown()) return;

  const done = startStartupTimer('resumeSuspendedSessions', projectId, 'resumed');
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

  // 2. Gather ALL recoverable session records. Interrupted-exited records are
  //    OS-killed sessions the clean-quit path never marked 'suspended'; they
  //    flow through the same pipeline below so they resume instead of being
  //    abandoned for a fresh empty session.
  const suspended = sessionRepo.getResumable();
  const orphaned = sessionRepo.getOrphaned();
  const interruptedExited = sessionRepo.getInterruptedExited();
  const allRecords = [...suspended, ...orphaned, ...interruptedExited];
  if (allRecords.length === 0) {
    done(0);
    return;
  }

  const now = new Date().toISOString();

  // Resolve tasks and lanes once: needed for isolation targeting (3b) and the
  // auto_spawn / deleted / paused filters below.
  const swimlaneRepo = new SwimlaneRepository(db);
  const allLanes = swimlaneRepo.list();
  const laneMap = new Map(allLanes.map((lane) => [lane.id, lane]));
  const allTasks = taskRepo.list();
  const taskMap = new Map(allTasks.map((task) => [task.id, task]));

  /**
   * The task's own lane: its column with its Board Profile folded over it.
   *
   * Every strategy read on this path has to go through here, because both of the
   * flags it feeds are profile-scoped. `auto_spawn` decides whether a suspended
   * session is resumed or retired at startup, and `session_target` decides which
   * isolated track a record belongs to - reading either off the raw column would
   * retire a profiled task's session, or match it against the wrong track.
   */
  const laneForTask = (task: Task) => {
    const lane = laneMap.get(task.swimlane_id);
    return applyProfileToLane(
      lane,
      findTaskProfile({ profiles: boardProfiles, profileId: task.profile_id, taskId: task.id }),
      allLanes,
    ) ?? lane;
  };

  // 3a. Deduplicate PER (task_id, isolated_swimlane_id): keep only the most recent
  //     record for each parallel session. Retire strictly-older SAME-session
  //     duplicates only. A task may hold multiple sessions (e.g. its main session
  //     plus an isolated column's session), and we must not destroy a dormant one.
  //     Null (main) is folded into the key string via `?? 'main'`.
  const latestByTaskSession = new Map<string, SessionRecord>();
  let duplicatesRetired = 0;
  for (const record of allRecords) {
    const key = `${record.task_id}::${record.isolated_swimlane_id ?? 'main'}`;
    const existing = latestByTaskSession.get(key);
    if (!existing) {
      latestByTaskSession.set(key, record);
    } else if ((record.started_at || '') > (existing.started_at || '')) {
      retireRecord(sessionRepo, existing.id);
      latestByTaskSession.set(key, record);
      duplicatesRetired++;
    } else {
      retireRecord(sessionRepo, record.id);
      duplicatesRetired++;
    }
  }
  if (duplicatesRetired > 0) {
    console.log(`[SESSION_RECOVERY] Retired ${duplicatesRetired} duplicate record(s)`);
  }

  // 3b. Per task, recover ONLY the session matching the task's CURRENT column
  //     strategy. Non-target sessions are PRESERVED (never retired) so re-entering
  //     their column later continues their own conversation; an orphaned (live at
  //     crash) or interrupted-exited (OS-killed) non-target session is
  //     CAS-upgraded to 'suspended' so it is not reprocessed on the next startup
  //     but stays resumable. One PTY per task means at most one session was live
  //     at crash, and the task cannot move while the app is down, so that session
  //     IS the current column's target.
  const toRecover: SessionRecord[] = [];
  let preservedSessions = 0;
  for (const record of latestByTaskSession.values()) {
    const task = taskMap.get(record.task_id);
    if (!task) {
      // Task deleted: retire every session of it.
      retireRecord(sessionRepo, record.id);
      continue;
    }
    const targetIsolatedSwimlaneId = resolveIsolatedSwimlaneId(laneForTask(task));
    if (record.isolated_swimlane_id === targetIsolatedSwimlaneId) {
      toRecover.push(record);
    } else {
      if (record.status === 'orphaned' || record.status === 'exited') {
        markRecordSuspended(sessionRepo, record.id, 'system');
      }
      preservedSessions++;
    }
  }
  if (preservedSessions > 0) {
    console.log(`[SESSION_RECOVERY] Preserved ${preservedSessions} non-target session(s) for later resume`);
  }

  // 4. Whether a task's column should have an active agent is decided PER TASK
  //    (see laneForTask): auto_spawn is profile-scoped, so a lane-keyed
  //    exclusion set would retire the session of a task whose profile turns
  //    auto_spawn on - or resume one whose profile turns it off.
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

    // `resolvedLane &&` preserves the pre-profile semantics exactly: the old
    // lane-keyed set could only contain lanes that EXIST, so a task whose column
    // is missing was never excluded. Dropping the guard would silently start
    // retiring those records.
    const resolvedLane = laneForTask(task);
    if (resolvedLane && !resolvedLane.auto_spawn) {
      if (record.status === 'exited') {
        // OS-killed session whose task sits in a non-auto-spawn column (To Do /
        // Done): preserve it as 'suspended' for future resume, mirroring the
        // move-to-Done path, rather than leaving an abnormal 'exited' row that
        // gets re-gathered every startup.
        markRecordSuspended(sessionRepo, record.id, 'system');
      } else if (record.status !== 'suspended') {
        // orphaned (crashed) records keep the pre-existing retire behavior here;
        // only the OS-killed exited carve-out above is preserved for resume.
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
    // For crashed (orphaned) or OS-killed (interrupted-exited) records we
    // atomically transition to 'suspended' so we don't re-process them on next
    // startup. If the CAS fails (concurrent retire), skip quietly.
    if (!autoResumeSessionsOnRestart) {
      if (record.status === 'orphaned' || record.status === 'exited') {
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
    done(0);
    return;
  }

  const config = configManager.getEffectiveConfig(projectPath);
  const resolvedShell = await sessionManager.getShell();

  // --- Preparation pass: build spawn inputs per-task ---
  const spawnInputs: Array<PreparedSpawn & { record: SessionRecord; task: Task }> = [];

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

      const swimlane = laneMap.get(task.swimlane_id) ?? null;

      // Decide whether to resume or start fresh. Uses type-AND-isolation-aware
      // lookup so cross-agent and main-vs-isolated resume mismatches are
      // structurally impossible. The adapter isn't known yet - we use the record's
      // session_type (captured at spawn, agent-specific) and its isolation.
      const typeMatch = sessionRepo.getLatestForTaskByTypeAndIsolation(record.task_id, record.session_type, record.isolated_swimlane_id);
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
        projectDefaultModel: projectDefaultModel ?? null,
        projectDefaultEffort: projectDefaultEffort ?? null,
        resolvedShell,
        mcpServerHandle,
        resume,
        // A session record is literally in hand on this path, so the
        // first-spawn override lock no-ops by construction.
        hasSessionRecord: true,
        tasks: taskRepo,
        boardProfiles,
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
    done(0);
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
        env: input.extraEnv ?? undefined,
        statusOutputPath: input.statusOutputPath,
        eventsOutputPath: input.eventsOutputPath,
        agentParser: input.adapter,
        agentName: input.adapter.name,
        agentSessionId: input.agentSessionId,
        isolatedSwimlaneId: input.record.isolated_swimlane_id,
        // Recovery spawns carry no initial prompt (prompt: undefined in
        // prepare-spawn), so the agent comes up waiting for the user: a resume
        // sits at a quiet prompt, a fresh spawn at a blank one. Mark resuming so
        // the activity engine seeds idle, not 'thinking' (the documented
        // orphan-recovery contract). The command is already built, so this flag
        // does not alter it - it only drives the seed and the resume overlay.
        resuming: true,
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
        isolated_swimlane_id: input.record.isolated_swimlane_id,
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
      // Record what this resume applied (the `--model` / `--effort` flags land
      // on every resume) so a later column move diffs against the true value.
      sessionRepo.updateAppliedSettings(newSession.id, {
        model: input.appliedModel,
        effort: input.appliedEffort,
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
  done(recovered);
}
