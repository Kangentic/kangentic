import fs from 'node:fs';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { AutomationRunRepository } from '../../db/repositories/automation-run-repository';
import { TaskMoveRepository } from '../../db/repositories/task-move-repository';
import { SessionManager } from '../../pty/session-manager';
import { releaseCommandHold } from '../../pty/lifecycle/adapter-lifecycle';
import { serializeCliTarget } from '../../agent/shared/cli-target';
import { ConfigManager } from '../../config/config-manager';
import type { BoardProfile, Swimlane, Task } from '../../../shared/types';
import { NEVER_AUTO_SPAWN_ROLES } from '../../../shared/types';
import { isAbortError } from '../../../shared/abort-utils';
import { isShuttingDown } from '../../shutdown-state';
import { withTaskLock } from '../../ipc/task-lifecycle-lock';
import { isMoveInFlight } from '../../ipc/handlers/task-move-controllers';
import { isResumeInFlight } from '../../ipc/handlers/session-resume-controllers';
import { isTaskWorkflowPaused } from '../../workflows/workflow-home';
import { applyProfileToLane, findTaskProfile } from '../column-strategy';
import { resolveIsolatedSwimlaneId } from '../session-isolation';
import { prepareAgentSpawn, type PreparedSpawn } from './prepare-spawn';
import { demoteMissingWorktree } from './missing-worktree';
import { startStartupTimer } from './timing';

/** What the pty host's crash took down, for a scoped pass (`lostScope`). */
export interface LostSessionScope {
  /** The tasks of the lost sessions: only these start. */
  taskIds: ReadonlySet<string>;
  /** The lost sessions themselves, whose rows stay in the registry, exited. */
  lostSessionIds: ReadonlySet<string>;
}

/**
 * Starts a task's first agent through the board path (`autoSpawnForTask`): the
 * worktree first, then the branch, the column's enter automations and the task
 * prompt, as the move into the column would have. Never an explicit Start.
 */
export type FirstAgentStarter = (task: { id: string; title: string }, swimlaneId: string) => Promise<void>;

/** What scopes a pass and where it sends a task that never had an agent. */
export interface AutoSpawnTasksOptions {
  /**
   * Start the crash's lost tasks and nothing else: the pty host's crash path,
   * mid-run, for the tasks whose lost session could not be resumed (it had no
   * agent session id yet). Mirrors `resumeSuspendedSessions`' `onlySessionIds`:
   * an unscoped pass would also wake a task whose agent exited earlier this
   * run. Startup omits it.
   */
  lostScope?: LostSessionScope;
  /**
   * Where a task that never had an agent goes (see `autoSpawnTasks`). The
   * project open paths pass `autoSpawnForTask`; the crash's scoped pass passes
   * none, since every task it starts had a session.
   */
  startFirstAgent?: FirstAgentStarter;
}

/** A task the discovery pass found with no agent history, for the board path. */
interface FirstAgentCandidate {
  task: Task;
  swimlaneId: string;
}

/**
 * A move, a resume or an `autoSpawnForTask` is working on the task. Each one
 * spawns its own agent when it is done, and each can sit in an unlocked gap
 * where the row is already in its new column with no session and no worktree
 * yet. A spawn here then started an agent with no prompt in the project root,
 * and the move found the session and skipped its own spawn (2026-10-27: a
 * workflow moved four tasks while a renderer reload ran this pass).
 */
function boardSpawnInFlight(taskId: string): boolean {
  return isMoveInFlight(taskId) || isResumeInFlight(taskId);
}

/**
 * Clears a task's `session_id` when nothing backs it: no record and no
 * registry row. `spawnAgent` starts no agent for a row that names a session,
 * yet still runs the column's enter automations, and the next launch's
 * enter-run guard would then leave the task alone for good. Its own lock
 * block, before the hand-off, as `startTaskSession` reconciles the pointer
 * before its start: `autoSpawnForTask` takes the lock itself, and the lock is
 * not reentrant.
 */
async function clearStaleSessionPointer(
  taskId: string,
  taskRepo: TaskRepository,
  sessionRepo: SessionRepository,
  sessionManager: SessionManager,
): Promise<void> {
  await withTaskLock(taskId, async () => {
    const current = taskRepo.getById(taskId);
    if (!current?.session_id) return;
    if (sessionManager.hasSessionForTask(taskId) || sessionRepo.getLatestForTask(taskId) !== undefined) return;
    console.log(`[AUTO_SPAWN] Cleared the session pointer of task ${taskId}: no record or session backs it`);
    taskRepo.update({ id: taskId, session_id: null });
  });
}

/**
 * The board path, one task at a time: each can create a worktree and check
 * out a branch (the same reason the auto_spawn reconcile runs its spawns in
 * sequence). It runs after the pass's own spawns, which need no git work, and
 * the pass awaits it, so a caller's later steps (the tool-breakdown repair,
 * the background activation marking the project recovered) wait for these
 * starts too. Such tasks are rare: a quit cut a move short after its column
 * commit.
 */
async function handOffFirstAgents(
  firstAgents: ReadonlyArray<FirstAgentCandidate>,
  startFirstAgent: FirstAgentStarter,
  taskRepo: TaskRepository,
  sessionRepo: SessionRepository,
  sessionManager: SessionManager,
): Promise<void> {
  let handedOff = 0;
  for (const { task, swimlaneId } of firstAgents) {
    if (isShuttingDown()) return;
    // Discovery ran before every await of the pass: a move or a resume that
    // took the task since then owns its spawn.
    if (boardSpawnInFlight(task.id)) {
      console.log(`[AUTO_SPAWN] Skipped task ${task.id}: a move or a resume took it before its first agent started`);
      continue;
    }
    try {
      if (task.session_id) await clearStaleSessionPointer(task.id, taskRepo, sessionRepo, sessionManager);
      await startFirstAgent({ id: task.id, title: task.title }, swimlaneId);
      handedOff++;
    } catch (error) {
      console.error(`[AUTO_SPAWN] First agent failed for task ${task.id}:`, error);
    }
  }
  if (handedOff > 0) {
    console.log(`[AUTO_SPAWN] Handed ${handedOff} task(s) with no agent history to the board path`);
  }
}

/**
 * Enforce the auto-spawn invariant on project open: find tasks in
 * `auto_spawn=true` columns that have no running PTY session, and
 * start an agent for each.
 *
 * Handles the case where a task is in an active column but has no
 * session (e.g. the session exited, the app closed without suspend,
 * or the task was placed there manually). Unlike resumeSuspendedSessions,
 * it never resumes: what it starts is a fresh agent.
 *
 * Three kinds of task are not started here:
 *
 * - A task a board path is working on (`boardSpawnInFlight`). Its own spawn
 *   follows, in its worktree and with its prompt.
 * - A task in a paused workflow (`isTaskWorkflowPaused`). A paused workflow
 *   starts nothing by itself; its Resume starts the agent. A session a person
 *   resumed during the pause, running at quit, is restored by the resume pass,
 *   and one a pty host crash took is brought back by the `lostScope` pass,
 *   which does not skip it.
 * - A task that never had an agent (no session record at all: a new task, or
 *   one a move to To Do reset). A fresh spawn here would start it in whatever
 *   directory the row names, with no prompt, and its worktree may not exist
 *   yet. It goes to `startFirstAgent` instead, which is the board path. With
 *   no starter it is left alone. A task whose column's enter automations
 *   already ran this visit is left alone too: its move reached the spawn and
 *   the agent failed to start, and handing it off would run those automations
 *   again at every launch.
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
  projectDefaultModel?: string | null,
  projectDefaultEffort?: string | null,
  /** Board Board Profiles, so a profiled task spawns on its own rung for this column. */
  boardProfiles?: ReadonlyArray<BoardProfile>,
  options: AutoSpawnTasksOptions = {},
): Promise<void> {
  const { lostScope, startFirstAgent } = options;
  if (isShuttingDown()) return;
  if (lostScope && lostScope.taskIds.size === 0) return;
  // The lost rows stay in the registry, exited, so in a scoped pass every row
  // but those counts as the task having a session: a resumed session, a paused
  // placeholder that must keep its Resume, and a resume whose spawn failed (an
  // exited row of its own), which a fresh agent must not replace.
  const hasSession = lostScope
    ? (taskId: string): boolean => sessionManager.listSessions()
      .some((session) => session.taskId === taskId && !lostScope.lostSessionIds.has(session.id))
    : (taskId: string): boolean => sessionManager.hasSessionForTask(taskId);

  const done = startStartupTimer('autoSpawnTasks', projectId, 'spawned');
  const db = getProjectDb(projectId);
  const taskRepo = new TaskRepository(db);
  const sessionRepo = new SessionRepository(db);

  // Determine which columns should have active agents (auto_spawn=true)
  const swimlaneRepo = new SwimlaneRepository(db);
  const allLanes = swimlaneRepo.list();

  // auto_spawn is profile-scoped, so a lane's own flag cannot decide alone: a
  // profile may turn it ON for a column whose base has it off, or OFF for one
  // that has it on. Only the ON direction needs extra lanes scanned - the OFF
  // direction is caught by the per-task check below, inside lanes we already
  // visit. With no profiles on the board this set is empty and both the scanned
  // lanes and the cost are exactly what they were before profiles existed.
  const laneIdsSomeProfileEnables = new Set<string>();
  for (const profile of boardProfiles ?? []) {
    for (const [laneId, entry] of Object.entries(profile.columns ?? {})) {
      if (entry.autoSpawn === true) laneIdsSomeProfileEnables.add(laneId);
    }
  }
  // To Do and Done never get an agent, however a profile wrote auto_spawn - mirrors
  // auto-spawn-reconcile.ts's guard for the same invariant. Filtered at the lane level
  // (not per-task below) because a Board Profile can only turn auto_spawn ON for a lane
  // id, never change what role that lane id carries: applyProfileToLane leaves `role`
  // untouched by contract (see wire-mappers.ts), so the raw lane's role already decides
  // this for every task in it, and a todo/done lane can hold hundreds of tasks that would
  // otherwise be scanned, profile-folded, and session-probed one at a time for nothing.
  const lanesToScan = allLanes.filter(
    (lane) =>
      (lane.auto_spawn || laneIdsSomeProfileEnables.has(lane.id)) &&
      (lane.role === null || !NEVER_AUTO_SPAWN_ROLES.has(lane.role)),
  );
  if (lanesToScan.length === 0) {
    done(0);
    return;
  }

  // --- Cheap discovery pass: find tasks in active lanes that lack a session.
  // Every auto_spawn lane spawns its tasks regardless of whether a transition
  // wired a spawn_agent action to it - this matches the pre-refactor behavior
  // and is preserved by design, so no transition/action lookup is needed here.
  // Done before any shell/config/paused-ID resolution so a project where
  // everything already has a session costs nothing.
  //
  // The lane is folded ONCE here and carried on the candidate, so every
  // downstream read (prepareAgentSpawn's `swimlane`, resolveIsolatedSwimlaneId)
  // sees the task's own rung rather than the column's base settings.
  const candidates: Array<{ lane: Swimlane; task: Task; hasSessionRecord: boolean }> = [];
  // Tasks that never had an agent, for the board path once this pass is done.
  const firstAgents: FirstAgentCandidate[] = [];
  const automationRunRepo = new AutomationRunRepository(db);
  const taskMoveRepo = new TaskMoveRepository(db);
  for (const lane of lanesToScan) {
    for (const task of taskRepo.list(lane.id)) {
      if (lostScope && !lostScope.taskIds.has(task.id)) continue;
      if (hasSession(task.id)) continue;
      const laneForTask = applyProfileToLane(
        lane,
        findTaskProfile({ profiles: boardProfiles, profileId: task.profile_id, taskId: task.id }),
        allLanes,
      ) ?? lane;
      if (!laneForTask.auto_spawn) continue;
      if (boardSpawnInFlight(task.id)) {
        console.log(`[AUTO_SPAWN] Skipped task ${task.id}: a move or a resume is working on it, and starts its agent`);
        continue;
      }
      // Not in a pty-host-loss pass: that one brings back agents that were
      // running, and in a paused workflow those are agents a person resumed.
      if (!lostScope && isTaskWorkflowPaused(task, projectId)) {
        console.log(`[AUTO_SPAWN] Skipped task ${task.id}: its workflow is paused, and the workflow's Resume starts its agent`);
        continue;
      }
      // A failed read skips this task, not the pass: the preparation pass
      // below treats a throw the same way.
      try {
        // First-ever-spawn detection: the board path for a task with none,
        // and the override lock's input for the rest (prepareAgentSpawn below).
        const hasSessionRecord = sessionRepo.getLatestForTask(task.id) !== undefined;
        if (!hasSessionRecord) {
          if (!startFirstAgent) {
            console.log(`[AUTO_SPAWN] Skipped task ${task.id}: it never had an agent, and this pass starts none through the board path`);
            continue;
          }
          // `AutomationRunRepository.pruneTo` keeps the newest enter run of
          // such a task for this read: change the two together.
          const visitStartedAt = taskMoveRepo.visitStartedAt(task.id, lane.id);
          if (automationRunRepo.hasEnterRunSince(task.id, lane.id, visitStartedAt)) {
            console.warn(
              `[AUTO_SPAWN] Skipped task ${task.id}: it never had an agent, but its column's enter automations`
              + ' already ran this visit, so its agent failed to start. Leaving it alone so they do not run again.',
            );
            continue;
          }
          firstAgents.push({ task, swimlaneId: lane.id });
          continue;
        }
        candidates.push({ lane: laneForTask, task, hasSessionRecord });
      } catch (error) {
        console.error(`[AUTO_SPAWN] Discovery failed for task ${task.id}:`, error);
      }
    }
  }

  const handOff = (): Promise<void> => (
    startFirstAgent
      ? handOffFirstAgents(firstAgents, startFirstAgent, taskRepo, sessionRepo, sessionManager)
      : Promise.resolve()
  );

  if (candidates.length === 0) {
    done(0);
    await handOff();
    return;
  }

  const resolvedShell = await sessionManager.getShell();
  const config = configManager.getEffectiveConfig(projectPath);

  // Batch-fetch held-paused task IDs (paused by the user or by Kangentic) to
  // skip during reconciliation
  const heldPausedTaskIds = sessionRepo.getHeldPausedTaskIds();

  // --- Preparation pass: collect spawn inputs ---
  // `isolatedSwimlaneId` tags each fresh session (null for normal columns, the
  // swimlane id for an 'isolated' column). Resumable isolated sessions are already
  // handled by resumeSuspendedSessions, which runs first, so this pass only ever
  // spawns fresh - it just records the correct isolation on that fresh row.
  const spawnInputs: Array<PreparedSpawn & { task: Task; isolatedSwimlaneId: string | null }> = [];

  for (const { lane, task, hasSessionRecord } of candidates) {
    // Defensive re-check: a session may have been registered for this task
    // during the `await getShell()` above (a concurrent project open or
    // resumeSuspendedSessions). Placeholders registered by
    // resumeSuspendedSessions cover held-pause records (user or auto) and
    // 'system'-suspended records when autoResumeSessionsOnRestart=false;
    // in either case the user must explicitly Resume - don't auto-spawn over
    // the placeholder and clobber the resumable record's agent_session_id.
    if (hasSession(task.id)) continue;

    // Safety net: register a placeholder for held-paused records that
    // somehow weren't registered by resumeSuspendedSessions (e.g. the
    // record was created after that pass, or cwd existence check failed).
    // Without this the task would auto-spawn a fresh agent and lose the
    // --resume transcript.
    if (heldPausedTaskIds.has(task.id)) {
      const cwd = task.worktree_path || projectPath;
      sessionManager.registerSuspendedPlaceholder({ taskId: task.id, projectId, cwd });
      continue;
    }

    try {
      let cwd = task.worktree_path || projectPath;

      // Guard: CWD must still exist -- fall back to projectPath if worktree was deleted
      if (task.worktree_path && !fs.existsSync(task.worktree_path)) {
        console.log(`[AUTO_SPAWN] Worktree missing for task ${task.id} -- falling back to project path`);
        await demoteMissingWorktree(taskRepo, task, projectPath);
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
        projectDefaultModel: projectDefaultModel ?? null,
        projectDefaultEffort: projectDefaultEffort ?? null,
        resolvedShell,
        mcpServerHandle,
        resume: null,
        // First-ever-spawn detection for the override lock, read once in the
        // discovery pass. A task with no record went to the board path there,
        // whose preamble locks its overrides, so every task here has one.
        hasSessionRecord,
        tasks: taskRepo,
        boardProfiles,
      });

      if (!prep.ok) {
        if (prep.reason === 'unknown-agent') {
          console.warn(`[AUTO_SPAWN] Unknown agent for task ${task.id.slice(0, 8)} -- skipping`);
        } else {
          console.warn(`[AUTO_SPAWN] CLI not found for task ${task.id.slice(0, 8)} -- skipping`);
        }
        continue;
      }

      spawnInputs.push({ task, isolatedSwimlaneId: resolveIsolatedSwimlaneId(lane), ...prep.data });
    } catch (err) {
      console.error(`[AUTO_SPAWN] Preparation failed for task ${task.id}:`, err);
    }
  }

  // --- Spawn pass (parallel): fire all spawns concurrently ---
  if (isShuttingDown()) {
    // Every prepared command took a hold that no spawn will now release. A
    // hold left behind keeps its folder's file through the quit, since the
    // folder's last live session would no longer be its last holder. No task
    // is handed to the board path either: the quit is under way.
    for (const input of spawnInputs) releaseCommandHold(input.adapter, input.cwd, input.sessionRecordId);
    done(0);
    return;
  }

  // Each spawn and its DB writes run under the task's lifecycle lock, after a
  // re-check: the preparation above awaited the shell and every agent's
  // detection, and a move, a Resume or a reset that took the task in that time
  // owns it now. Without the lock this pass spawned into a task the user had
  // just moved, To Do included. A reset shows as a changed `session_id`, which
  // it clears. A move still making its worktree shows as nothing on the row:
  // its Phase 1 committed the column, and the worktree and the spawn come
  // after the lock is released, so only its registered controller says so.
  //
  // A skipped task keeps the session directory its preparation made, which
  // the next launch's orphan cleanup removes. What the adapter's command
  // builder wrote for that run (Gemini's hooks file in the worktree) is held
  // under the prepared session's id, so a skip releases that hold. A hold
  // never released keeps the folder's file in place for the rest of the run:
  // no later session's release can empty the folder's holds.
  const spawnResults = await Promise.allSettled(
    spawnInputs.map((input) => withTaskLock(input.task.id, async () => {
      // Until spawn() takes the command, this pass owns its hold. spawn()
      // releases a spawn that never runs, and a session that ran owns its own.
      let handedToSpawn = false;
      try {
        const current = taskRepo.getById(input.task.id);
        if (
          !current
          || current.swimlane_id !== input.task.swimlane_id
          || current.session_id !== input.task.session_id
          // A move to To Do and back inside the preparation leaves the column as
          // it was, but its cleanup removed the worktree the agent was prepared
          // in, and the move back may still be making it again (its own spawn
          // follows when it has).
          || (current.worktree_path || projectPath) !== input.cwd
          || !fs.existsSync(input.cwd)
          || hasSession(input.task.id)
          || boardSpawnInFlight(input.task.id)
        ) {
          // Logged, so a task this pass left without an agent leaves a trace.
          console.log(`[AUTO_SPAWN] Skipped task ${input.task.id}: it changed while its spawn was prepared`);
          return null;
        }
        // Stamped inside the lock, so a record another holder wrote while this
        // one waited never sorts after the one written here.
        const now = new Date().toISOString();

        handedToSpawn = true;
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
          isolatedSwimlaneId: input.isolatedSwimlaneId,
          permissionMode: input.permissionMode,
          exitSequence: input.adapter.getExitSequence?.() ?? ['\x03'],
          inputInAlternateScreen: input.inputInAlternateScreen,
          shell: input.shell,
          cliTarget: input.cliTarget,
        });

        taskRepo.update({
          id: input.task.id,
          session_id: newSession.id,
          agent: input.agent,
        });

        sessionRepo.insert({
          id: newSession.id,
          task_id: input.task.id,
          session_type: input.adapter.sessionType,
          isolated_swimlane_id: input.isolatedSwimlaneId,
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
          cli_target: serializeCliTarget(input.cliTarget),
        });
        // Record what this fresh spawn applied so a later column move diffs
        // against the session's true value, not the leaving column's config.
        sessionRepo.updateAppliedSettings(newSession.id, {
          model: input.appliedModel,
          effort: input.appliedEffort,
        });
        return newSession;
      } finally {
        if (!handedToSpawn) releaseCommandHold(input.adapter, input.cwd, input.sessionRecordId);
      }
    })),
  );

  let spawned = 0;
  for (let resultIndex = 0; resultIndex < spawnResults.length; resultIndex++) {
    const result = spawnResults[resultIndex];
    if (result.status === 'fulfilled') {
      if (result.value) spawned++;
    } else {
      const input = spawnInputs[resultIndex];
      if (isAbortError(result.reason)) {
        // A teardown (a move, a reset, a project close) ended the session while
        // it spawned: the canceller took the task over, not a failure.
        console.log(`[AUTO_SPAWN] Spawn cancelled for task ${input.task.id}: the session was ended while it spawned`);
      } else {
        console.error(`[AUTO_SPAWN] Spawn failed for task ${input.task.id}:`, result.reason);
      }
    }
  }

  if (spawned > 0) {
    console.log(`[AUTO_SPAWN] Spawned ${spawned} session(s) for tasks without agents`);
  }
  done(spawned);
  await handOff();
}
