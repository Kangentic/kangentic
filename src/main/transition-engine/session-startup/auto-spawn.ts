import fs from 'node:fs';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { SessionManager } from '../../pty/session-manager';
import { ConfigManager } from '../../config/config-manager';
import type { Swimlane, Task } from '../../../shared/types';
import { isShuttingDown } from '../../shutdown-state';
import { resolveIsolatedSwimlaneId } from '../session-isolation';
import { prepareAgentSpawn, type PreparedSpawn } from './prepare-spawn';
import { startStartupTimer } from './timing';

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
  projectDefaultModel?: string | null,
  projectDefaultEffort?: string | null,
): Promise<void> {
  if (isShuttingDown()) return;

  const done = startStartupTimer('autoSpawnTasks', projectId, 'spawned');
  const db = getProjectDb(projectId);
  const taskRepo = new TaskRepository(db);
  const sessionRepo = new SessionRepository(db);

  // Determine which columns should have active agents (auto_spawn=true)
  const swimlaneRepo = new SwimlaneRepository(db);
  const allLanes = swimlaneRepo.list();
  const activeLanes = allLanes.filter((lane) => lane.auto_spawn);
  if (activeLanes.length === 0) {
    done(0);
    return;
  }

  // --- Cheap discovery pass: find tasks in active lanes that lack a session.
  // Every auto_spawn lane spawns its tasks regardless of whether a transition
  // wired a spawn_agent action to it - this matches the pre-refactor behavior
  // and is preserved by design, so no transition/action lookup is needed here.
  // Done before any shell/config/paused-ID resolution so a project where
  // everything already has a session costs nothing.
  const candidates: Array<{ lane: Swimlane; task: Task }> = [];
  for (const lane of activeLanes) {
    for (const task of taskRepo.list(lane.id)) {
      if (!sessionManager.hasSessionForTask(task.id)) {
        candidates.push({ lane, task });
      }
    }
  }
  if (candidates.length === 0) {
    done(0);
    return;
  }

  const resolvedShell = await sessionManager.getShell();
  const config = configManager.getEffectiveConfig(projectPath);

  // Batch-fetch user-paused task IDs to skip during reconciliation
  const userPausedTaskIds = sessionRepo.getUserPausedTaskIds();

  // --- Preparation pass: collect spawn inputs ---
  // `isolatedSwimlaneId` tags each fresh session (null for normal columns, the
  // swimlane id for an 'isolated' column). Resumable isolated sessions are already
  // handled by resumeSuspendedSessions, which runs first, so this pass only ever
  // spawns fresh - it just records the correct isolation on that fresh row.
  const spawnInputs: Array<PreparedSpawn & { task: Task; isolatedSwimlaneId: string | null }> = [];

  for (const { lane, task } of candidates) {
    // Defensive re-check: a session may have been registered for this task
    // during the `await getShell()` above (a concurrent project open or
    // resumeSuspendedSessions). Placeholders registered by
    // resumeSuspendedSessions cover user-paused records and
    // 'system'-suspended records when autoResumeSessionsOnRestart=false;
    // in either case the user must explicitly Resume - don't auto-spawn over
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
        projectDefaultModel: projectDefaultModel ?? null,
        projectDefaultEffort: projectDefaultEffort ?? null,
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

      spawnInputs.push({ task, isolatedSwimlaneId: resolveIsolatedSwimlaneId(lane), ...prep.data });
    } catch (err) {
      console.error(`[AUTO_SPAWN] Preparation failed for task ${task.id}:`, err);
    }
  }

  // --- Spawn pass (parallel): fire all spawns concurrently ---
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
        isolatedSwimlaneId: input.isolatedSwimlaneId,
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
      });
      // Record what this fresh spawn applied so a later column move diffs
      // against the session's true value, not the leaving column's config.
      sessionRepo.updateAppliedSettings(newSession.id, {
        model: input.appliedModel,
        effort: input.appliedEffort,
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
  done(spawned);
}
