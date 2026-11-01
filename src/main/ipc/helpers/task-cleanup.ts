import fs from 'node:fs';
import path from 'node:path';
import PQueue from 'p-queue';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { WorktreeManager, prepareWorktreeForRemoval, GitQueuePriority } from '../../git/worktree-manager';
import { waitForWorktreeCreation } from '../../git/worktree-creation-registry';
import { scheduleRemovedWorktreeDeletion } from '../../git/removed-worktrees';
import { readWorktreeHead } from '../../git/worktree-head';
import { waitForChurnRead } from '../handlers/git-stats-capture';
import { getOpenProjectDb, getProjectDb } from '../../db/database';
import { agentRegistry } from '../../agent/agent-registry';
import type { AgentAdapter } from '../../agent/agent-adapter';
import type { SessionRecord } from '../../../shared/types';
import { parseStoredCliTarget, parseWslCliPath, type CliPlace } from '../../agent/shared/cli-target';
import { isWslDistroRunning, resolveWslDistroFacts } from '../../agent/shared/wsl-distro';
import type { IpcContext } from '../ipc-context';
import { leftoverProcessReports, publishLeftoverProcesses } from './leftover-process-reports';
import { getProjectRepos } from './project-repos';
import { withTaskLock } from '../task-lifecycle-lock';
import { isShuttingDown } from '../../shutdown-state';
import type { LeftoverSweepOptions } from '../../transition-engine/resource-cleanup';
import { backgroundSessionHoldingConversation } from '../../transition-engine/resume-id-reconcile';
import { closeTaskWindows } from './task-windows';
// Dev-only (dropped from prod via __KANGENTIC_DEV__ dead-code elimination).
import { stopWorktreePreviews } from '../../../devtools/main/worktree-preview-stop';

/**
 * Kill what the given tasks left running: the processes carrying their
 * `KANGENTIC_TASK_ID` tag, which each task session's PTY is spawned with and
 * every descendant inherits, however it detached (`nohup`, `Start-Process`,
 * `setsid`, a launcher that already exited), and that are the task's (see
 * `src/main/pty/process-tag/reap-plan.ts` for what is spared). Works across
 * sessions and across an app restart, because the tag lives in the processes
 * themselves.
 *
 * Call it on a TERMINAL transition only (Done, To Do, Backlog, delete), AFTER
 * every session of the task has exited: the reap force-kills, and a young
 * agent must get its exit grace (`.claude/rules/pty-teardown-grace.md`). The
 * pty host protects any PTY it still holds as a second line. Call it BEFORE a
 * worktree removal: a live process holding the directory as its cwd is what
 * makes the removal fail on Windows.
 *
 * Only processes working inside the task's project or worktree are reaped, so
 * pass the project path and each task's worktree: a shared daemon the agent
 * happened to start first (it moves to `/` or home) and anything it started
 * elsewhere are left alone. A process with no project path to check against
 * is never killed.
 *
 * With the user's "Stop leftover processes" setting off it kills nothing.
 * Either way the user is told what was stopped and what kept running: the
 * result goes to the leftover-process toast (`leftover-process-reports.ts`),
 * under each task's title, so pass `title` where the caller has it. A reap the
 * host finishes after main stopped waiting is reported when it finishes.
 *
 * Best-effort by contract: a teardown never fails because a reap did.
 */
export async function reapTaskLeftovers(
  context: IpcContext,
  projectPath: string | null | undefined,
  tasks: ReadonlyArray<{ id: string; worktree_path: string | null; title?: string }>,
  options: {
    /** Distros the caller knows a CLI ran in, beyond the ones the session records name. */
    wslDistros?: readonly string[];
  } = {},
): Promise<void> {
  if (tasks.length === 0) return;
  // Before the reap, which would otherwise kill it: a conversation moved into
  // the agent CLI's own background session is still the task's agent.
  await stopTaskBackgroundSessions(context, projectPath ?? null, tasks.map((task) => task.id));
  // Held for the whole reap, so a bulk delete's reaps, which the host runs in
  // two batches a second apart, still make one toast.
  const releaseReport = leftoverProcessReports.beginReap();
  try {
    const stoppingEnabled = context.configManager.load().stopLeftoverProcesses !== false;
    // A /preview of a task worktree stops through its own stop file first, so
    // its Electron quits through the real quit path and its terminal tab
    // closes. Killed by the reap, it would leave that window on a dead dev
    // server, holding the worktree. The stop also waits for the rest of the
    // preview's tree (the tab's shell outlives dev.js), so the scan below never
    // reads a half-exited preview as shared.
    if (__KANGENTIC_DEV__ && stoppingEnabled) {
      await stopWorktreePreviews(
        tasks.flatMap((task) => (task.worktree_path ? [task.worktree_path] : [])),
        { listProcesses: () => context.sessionManager.listProcesses() },
      );
    }
    const taskTitles = new Map<string, string>();
    for (const task of tasks) if (task.title) taskTitles.set(task.id, task.title);
    const entries = await context.sessionManager.reapTaskProcesses(
      projectPath ?? null,
      tasks.map((task) => ({ id: task.id, worktreePath: task.worktree_path })),
      {
        stop: stoppingEnabled,
        wslDistros: [...(options.wslDistros ?? []), ...wslCliDistrosOf(context, projectPath ?? null, tasks.map((task) => task.id))],
        // The host finished a reap this call stopped waiting for. By now a Done
        // move has tried its worktree removal, which a process the reap had not
        // yet stopped can fail on Windows: retry it as a Stop from the list does.
        onLateEntries: (lateEntries) => {
          publishLeftoverProcesses(context.mainWindow, lateEntries, taskTitles, stoppingEnabled, projectPath ?? null);
          const stoppedTaskIds = new Set(lateEntries.filter((entry) => entry.outcome === 'stopped').map((entry) => entry.taskId));
          for (const taskId of stoppedTaskIds) void retryDoneWorktreeRemoval(context, projectPath ?? null, taskId);
        },
      },
    );
    publishLeftoverProcesses(context.mainWindow, entries, taskTitles, stoppingEnabled, projectPath ?? null);
  } catch (error) {
    console.warn(`[TASK-REAP] Leftover reap failed for ${tasks.length} task(s) (non-fatal):`, error);
  } finally {
    releaseReport();
  }
}

/** How many of a task's newest session records are checked for a conversation in a background session. */
const BACKGROUND_SESSION_RECORDS_PER_TASK = 3;

/**
 * How many records one call checks and stops at once. A bulk or project delete
 * checks many, and each stop lists every background session on the machine,
 * which can start the CLI's supervisor, so they run a few at a time rather
 * than one after another (a stop can take its whole 10 s budget) or all at once.
 */
const BACKGROUND_SESSION_STOP_CONCURRENCY = 2;

/**
 * The longest one call waits for its stops before the reap goes ahead. Twice
 * one stop's own 10 s budget, so a single stop always gets all of it, while a
 * bulk delete behind a supervisor that does not answer waits this long, not a
 * budget for every record. A stop still running at the deadline is not waited
 * for, and none starts after it.
 */
const BACKGROUND_SESSION_STOPS_DEADLINE_MS = 20_000;

/**
 * Stop the agent CLI's own background session holding a task's conversation,
 * for each of the tasks (Claude Code's `/bg` moves a conversation into one,
 * which outlives the task's PTY: see `AgentAdapter.stopBackgroundSession`).
 * It ends the task's own agent through the CLI's own stop, where the reap
 * after it would kill it with no exit of its own, and before the worktree it
 * works in is removed.
 *
 * Not gated on "Stop leftover processes": that setting is about what the agent
 * left running, and this is the agent itself, which every terminal transition
 * ends. Runs a CLI only for a record whose own hooks show its conversation
 * moved into a background session (`backgroundSessionHoldingConversation`), so
 * a task that never did costs a few file reads. The CLI is the project's
 * configured one, so a record whose CLI ran somewhere that path no longer
 * reaches is left to the reap. Best-effort: never throws.
 */
async function stopTaskBackgroundSessions(context: IpcContext, projectPath: string | null, taskIds: readonly string[]): Promise<void> {
  if (!projectPath || taskIds.length === 0) return;
  try {
    const project = context.projectRepo.list().find((candidate) => candidate.path === projectPath);
    const db = project ? getOpenProjectDb(project.id) : null;
    if (!db) return;
    const sessionRepo = new SessionRepository(db);
    const cliPathOverrides = context.configManager.getEffectiveConfig(projectPath).agent.cliPaths;
    const records = taskIds.flatMap((taskId) => sessionRepo.listForTaskNewestFirst(taskId).slice(0, BACKGROUND_SESSION_RECORDS_PER_TASK));
    /** One detection per adapter for the whole call. */
    const cliPaths = new Map<string, Promise<string | null>>();
    const cliPathOf = (adapter: AgentAdapter): Promise<string | null> => {
      let cliPath = cliPaths.get(adapter.name);
      if (!cliPath) {
        cliPath = adapter.detect(cliPathOverrides[adapter.name] ?? null).then((detection) => (detection.found && detection.path ? detection.path : null));
        cliPaths.set(adapter.name, cliPath);
      }
      return cliPath;
    };
    const stopped = new Set<string>();
    const stopForRecord = async (record: SessionRecord): Promise<void> => {
      try {
        const agentSessionId = record.agent_session_id;
        if (!agentSessionId) return;
        const adapter = agentRegistry.getBySessionType(record.session_type);
        if (!adapter?.stopBackgroundSession) return;
        const backgroundId = await backgroundSessionHoldingConversation({
          adapter,
          projectPath,
          recordId: record.id,
          agentSessionId,
          cwd: record.cwd,
          cliTarget: parseStoredCliTarget(record.cli_target),
        });
        if (!backgroundId || stopped.has(backgroundId)) return;
        // Claimed before the first await below, so two records naming one
        // conversation never stop it twice.
        stopped.add(backgroundId);
        const cliPath = await cliPathOf(adapter);
        if (cliPath) await adapter.stopBackgroundSession({ agentSessionId: backgroundId, cliPath });
      } catch (error) {
        console.warn(`[TASK-REAP] could not stop a background session for record ${record.id.slice(0, 8)} before the reap (non-fatal):`, error);
      }
    };
    const queue = new PQueue({ concurrency: BACKGROUND_SESSION_STOP_CONCURRENCY });
    const allStops = Promise.all(records.map((record) => queue.add(() => stopForRecord(record))));
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      deadlineTimer = setTimeout(() => resolve('deadline'), BACKGROUND_SESSION_STOPS_DEADLINE_MS);
    });
    try {
      const outcome = await Promise.race([allStops.then(() => 'done' as const), deadline]);
      if (outcome === 'deadline') {
        const notStarted = queue.size;
        queue.clear();
        console.warn(
          `[TASK-REAP] background session stops passed ${BACKGROUND_SESSION_STOPS_DEADLINE_MS} ms; the reap goes ahead`
          + ` (${queue.pending} still stopping, ${notStarted} not started)`,
        );
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  } catch (error) {
    console.warn('[TASK-REAP] could not stop a background session before the reap (non-fatal):', error);
  }
}

/**
 * The WSL distros the tasks' sessions ran a CLI in, from the session records'
 * `cli_target`, so the reap also runs where a CLI path into a distro ran the
 * agent, whatever shell is configured. The records outlive the sessions and a
 * restart; a delete removes them only after its reap. [] off Windows, and when
 * the project's database is not open.
 */
function wslCliDistrosOf(context: IpcContext, projectPath: string | null, taskIds: readonly string[]): string[] {
  if (process.platform !== 'win32' || !projectPath || taskIds.length === 0) return [];
  try {
    const project = context.projectRepo.list().find((candidate) => candidate.path === projectPath);
    const db = project ? getOpenProjectDb(project.id) : null;
    if (!db) return [];
    const distros = new SessionRepository(db).listCliTargetsOfTasks(taskIds)
      .map((raw) => parseStoredCliTarget(raw)?.distro)
      .filter((distro): distro is string => typeof distro === 'string');
    return [...new Set(distros)];
  } catch (error) {
    console.warn('[TASK-REAP] could not read the distros the tasks ran a CLI in (non-fatal):', error);
    return [];
  }
}

/**
 * The startup sweep's view of the setting and the toast
 * (`sweepTerminalTaskLeftovers`): the same as a transition's reap.
 */
export function leftoverSweepOptions(context: IpcContext, projectPath: string): LeftoverSweepOptions {
  return {
    stoppingEnabled: () => context.configManager.load().stopLeftoverProcesses !== false,
    wslDistrosOf: (taskIds) => wslCliDistrosOf(context, projectPath, taskIds),
    onReport: (entries, taskTitles, stoppingEnabled) => {
      publishLeftoverProcesses(context.mainWindow, entries, taskTitles, stoppingEnabled, projectPath);
    },
  };
}

/**
 * After the user stopped a leftover process from the list, or a reap main had
 * stopped waiting for stopped one, retry removing its task's worktree when the
 * task is in Done and the worktree is still on disk.
 * On Windows a process working in a directory blocks its removal, so a window
 * or a server the Done move left running is what kept it; without this, the
 * worktree waits for the next project open (`retryFailedDoneCleanups`).
 *
 * Best-effort and quiet: if something else still holds the directory, the
 * removal fails as it did at Done, and the same startup retry takes it.
 *
 * Main closes a project's database only to delete the project, and a late
 * reap answer can land after that close while the project is still listed.
 * Opening it then would create and migrate a new empty file for a deleted
 * project, so a closed database means there is nothing to retry.
 */
export async function retryDoneWorktreeRemoval(
  context: IpcContext,
  projectPath: string | null,
  taskId: string,
): Promise<boolean> {
  if (!projectPath) return false;
  try {
    const project = context.projectRepo.list().find((candidate) => candidate.path === projectPath);
    if (!project || !getOpenProjectDb(project.id)) return false;
    const { tasks, swimlanes } = getProjectRepos(context, project.id);
    const doneLane = swimlanes.list().find((lane) => lane.role === 'done');
    if (!doneLane) return false;
    return await withTaskLock(taskId, async () => {
      const task = tasks.getById(taskId);
      if (!task?.worktree_path || task.swimlane_id !== doneLane.id) return false;
      return deleteTaskWorktree(context, task, tasks, projectPath);
    });
  } catch (error) {
    console.warn(`[TASK-REAP] Worktree removal retry after a stop failed for ${taskId.slice(0, 8)} (non-fatal):`, error);
    return false;
  }
}

/**
 * How long after a Done move's failed worktree removal its one automatic retry
 * waits. A holder that is already on its way out clears within seconds: a
 * `/preview`'s cleanup helper deleting inside the worktree measured about 3 s.
 */
export const DONE_REMOVAL_RETRY_DELAY_MS = 10_000;

/**
 * How long a Done move's removal waits for the churn capture it just fired into
 * the worktree. That read is six git processes at background priority, about a
 * second on a quiet machine; past this the removal goes ahead and the capture
 * reports nothing, which never overwrites an earlier one.
 */
const CHURN_READ_WAIT_MS = 15_000;

/**
 * Retry a Done move's worktree removal once, a little later, when it failed.
 * On Windows any process still closing files in the directory fails the
 * removal ("Permission denied"), and one that is on its way out is gone
 * seconds later; without this the worktree waited for the next project open
 * (`retryFailedDoneCleanups`). One attempt, best-effort and quiet: a retry
 * that fails again leaves the worktree to that startup retry, as before. A
 * task that has left Done by then is left alone (`retryDoneWorktreeRemoval`
 * re-checks under the task lock), and nothing is retried during a quit.
 */
export function scheduleDoneWorktreeRemovalRetry(
  context: IpcContext,
  projectPath: string | null,
  taskId: string,
  delayMs: number = DONE_REMOVAL_RETRY_DELAY_MS,
): void {
  if (!projectPath) return;
  const timer = setTimeout(() => {
    if (isShuttingDown()) return;
    void retryDoneWorktreeRemoval(context, projectPath, taskId).then((removed) => {
      if (removed) console.log(`[TASK_MOVE] Deleted worktree for task ${taskId.slice(0, 8)} on its retry after the Done move`);
    });
  }, delayMs);
  timer.unref?.();
}

/** A project's effective `agent.cliPaths`, or null when it cannot be read. */
export type ProjectCliPaths = (projectPath: string) => Readonly<Record<string, string | null | undefined>> | null;

/** The project a Kangentic worktree belongs to: it lives at `<project>/.kangentic/worktrees/<slug>`. */
function projectPathOfWorktree(worktreePath: string): string | null {
  const worktreesFolder = path.dirname(path.resolve(worktreePath));
  const kangenticFolder = path.dirname(worktreesFolder);
  if (path.basename(worktreesFolder) !== 'worktrees' || path.basename(kangenticFolder) !== '.kangentic') return null;
  return path.dirname(kangenticFolder);
}

/**
 * The WSL distro an adapter's CLI runs in for the project a worktree belongs
 * to, from the project's own CLI path, the setting its spawns read. Only while
 * the distro runs: reading its share would start it, and a removal never
 * starts one to tidy a file. Null on any other platform, for an adapter
 * without WSL support, and for a CLI on this machine. A project whose CLI path
 * changed while a task's worktree existed leaves that worktree's entry in the
 * old distro: the sessions' own `cli_target` would name it, but the removal
 * listener knows only the path, and one dead trust entry did not earn a
 * cwd-keyed session query here.
 */
async function wslPlaceOfWorktree(
  adapter: { name: string; supportsWslCli?: boolean },
  worktreePath: string,
  cliPathsOf: ProjectCliPaths,
): Promise<CliPlace | null> {
  if (process.platform !== 'win32' || adapter.supportsWslCli !== true) return null;
  const projectPath = projectPathOfWorktree(worktreePath);
  const parsed = projectPath ? parseWslCliPath(cliPathsOf(projectPath)?.[adapter.name]) : null;
  if (!parsed || !(await isWslDistroRunning(parsed.distro))) return null;
  return { kind: 'wsl', distro: parsed.distro, facts: await resolveWslDistroFacts(parsed.distro) };
}

/**
 * Let every adapter drop the per-directory state it recorded for a worktree
 * Kangentic has just deleted (Codex's directory trust in
 * `~/.codex/config.toml` is the motivating case). Generic over the registry,
 * so no agent is named here - see .claude/rules/agent-adapters-boundary.md,
 * and `onProjectRelocated` in project-relocate.ts for the same shape.
 *
 * An adapter whose CLI the project runs from a WSL distro is called a second
 * time with that place, so the entry its trust step wrote in the distro's own
 * config goes too (`wslPlaceOfWorktree`).
 *
 * Best-effort: the worktree is already gone, and a failure only leaves a
 * stale entry behind. It must never fail the cleanup.
 */
export async function notifyAdaptersWorktreeRemoved(
  worktreePath: string,
  cliPathsOf: ProjectCliPaths = () => null,
): Promise<void> {
  for (const adapterName of agentRegistry.list()) {
    const adapter = agentRegistry.get(adapterName);
    if (!adapter?.onWorktreeRemoved) continue;
    try {
      await adapter.onWorktreeRemoved(worktreePath);
      const place = await wslPlaceOfWorktree(adapter, worktreePath, cliPathsOf);
      if (place) await adapter.onWorktreeRemoved(worktreePath, place);
    } catch (error) {
      console.warn(`[WORKTREE] ${adapterName} onWorktreeRemoved failed (non-fatal):`, error);
    }
  }
}

/**
 * Kill the PTY session and wipe session records for a task.
 * Preserves the worktree and branch so code is not lost.
 *
 * Used by `cleanupTaskResources` (below) and by an unarchive into To Do
 * (`resetSessionForTodoRestore` in task-archive.ts), which resets the session
 * but keeps a worktree the Done move could not remove.
 */
export async function cleanupTaskSession(
  context: IpcContext,
  task: { id: string; session_id: string | null; worktree_path: string | null; branch_name: string | null; title?: string },
  tasks: TaskRepository,
  projectId?: string | null,
  projectPath?: string | null,
): Promise<void> {
  const resolvedProjectId = projectId ?? context.currentProjectId;
  const resolvedProjectPath = projectPath ?? context.currentProjectPath;

  // Kill active PTY session and wait for process exit before proceeding.
  // The PTY process holds CWD + conpty handles on the worktree directory;
  // awaiting exit ensures those handles are released before cleanup.
  if (task.session_id) {
    try {
      // kill() always tags the exit intentional, so this deliberate hard
      // reset (move to To Do, backlog demote, task delete) never surfaces a
      // false "Session crashed" toast from the non-zero force-kill exit.
      context.sessionManager.kill(task.session_id);
      await context.sessionManager.awaitExit(task.session_id);
      context.sessionManager.remove(task.session_id);
    } catch { /* may already be dead */ }
    // Guard against concurrent delete: the task row may already be gone by
    // the time awaitExit resolves. Update is idempotent - skip when absent.
    if (tasks.getById(task.id)) {
      tasks.update({ id: task.id, session_id: null });
    }
  }

  // Safety net: kill any PTY session for this task that was spawned by a
  // concurrent move but not yet written to the task's session_id field.
  // Awaited: a spawn of the task still in flight is cancelled, and the PTY its
  // host may already have started holds the worktree until it exits, which
  // must come before the session directories and the worktree go.
  await context.sessionManager.removeByTaskId(task.id);

  // Every session of the task is gone and its removal pushed, so a Browser
  // pop-out closing now stands up no lane and remounts no in-app pane.
  closeTaskWindows(resolvedProjectId, task.id);

  // A dev server the agent backgrounded outlives the PTY and holds the worktree
  // directory as its cwd, which is what makes the removal in
  // cleanupTaskResources fail. After removeByTaskId, so every session of the
  // task has exited and none is force-killed outside its exit grace.
  await reapTaskLeftovers(context, resolvedProjectPath, [{ ...task, title: task.title ?? tasks.getById(task.id)?.title }]);

  // Remove session DB records + directories from disk
  if (resolvedProjectId) {
    const db = getProjectDb(resolvedProjectId);
    const sessionRepo = new SessionRepository(db);

    // Best-effort disk cleanup (non-fatal -- DB records are the source of truth).
    // Uses async fs.promises.rm so the event loop stays responsive during bulk
    // operations. The previous sync rmSync in a tight loop caused a multi-second
    // event-loop stall when many tasks with multiple session records each
    // landed in the bulk-delete handler concurrently - every IPC call from the
    // renderer (including the click that triggered delete) queued up behind
    // the sync work. Promise.all lets the kernel parallelize while keeping
    // the main thread free to service other handlers.
    if (resolvedProjectPath) {
      const records = db.prepare(
        'SELECT id FROM sessions WHERE task_id = ?'
      ).all(task.id) as Array<{ id: string }>;

      // Never delete the on-disk directory of a session that is still live.
      // The kills above (task.session_id + removeByTaskId) clear the
      // intended-for-deletion sessions from the manager, so anything still
      // running/queued here is a session a concurrent spawn brought to life
      // for this task. Wiping its events.jsonl directory mid-write severs the
      // activity feed and makes the card falsely read idle. A spared dir whose
      // DB record we then delete is still protected from the orphan prune by
      // pruneOrphanedDirectories' listSessions() guard until the session
      // actually exits, at which point it gets pruned normally.
      const liveSessionIds = new Set(
        context.sessionManager.listSessions()
          .filter((session) => session.status === 'running' || session.status === 'queued')
          .map((session) => session.id),
      );

      await Promise.all(records.map(({ id }) => {
        if (liveSessionIds.has(id)) return Promise.resolve();
        const sessionDir = path.join(resolvedProjectPath, '.kangentic', 'sessions', id);
        return fs.promises.rm(sessionDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        }).catch((error: NodeJS.ErrnoException) => {
          // force: true already silences ENOENT, so anything surfacing here is
          // a genuine problem (EACCES, EPERM, EBUSY post-retry). Best-effort:
          // log and continue so the task DELETE still proceeds.
          if (error.code !== 'ENOENT') {
            console.warn(`[CLEANUP] Failed to remove session dir ${sessionDir}: ${error.message}`);
          }
        });
      }));
    }

    // Always delete DB records -- this must succeed for task DELETE to pass FK check
    sessionRepo.deleteByTaskId(task.id);
  }
}

/**
 * Full cleanup: kill session, remove worktree + branch, wipe session records.
 *
 * Used by a move into a todo-role column (full reset), BACKLOG_DEMOTE (the task
 * becomes a backlog item), TASK_DELETE and TASK_BULK_DELETE (permanent removal).
 */
export async function cleanupTaskResources(
  context: IpcContext,
  task: { id: string; session_id: string | null; worktree_path: string | null; branch_name: string | null; title?: string },
  tasks: TaskRepository,
  projectId?: string | null,
  projectPath?: string | null,
): Promise<void> {
  await cleanupTaskSession(context, task, tasks, projectId, projectPath);

  // A full reset ends the spawn decision `worktree_skip_reason` describes; the
  // next spawn re-decides. Unconditional (not inside the worktree block below)
  // because the task carrying a reason is exactly the one WITHOUT a worktree.
  // Guarded: a concurrent delete may already have removed the row.
  if (tasks.getById(task.id)) {
    tasks.setWorktreeSkipReason(task.id, null);
  }

  const resolvedProjectPath = projectPath ?? context.currentProjectPath;

  // Remove worktree + branch
  if (task.worktree_path && resolvedProjectPath) {
    let removed = false;
    // Capture the tip before the checkout goes, as `deleteTaskWorktree` does:
    // the commit is the one anchor that survives a reset, and a task whose PR
    // was not linked yet when the reset ran (resolver down) can otherwise never
    // link it again.
    const { sha: capturedSha } = await readWorktreeHead(task.worktree_path);
    try {
      const worktreeManager = new WorktreeManager(resolvedProjectPath);
      // Reap orphans + clear node_modules BEFORE taking the git lock so the slow
      // fs work does not hold the per-project queue. Safe outside the lock: the
      // caller holds withTaskLock(taskId), which serializes same-path work.
      await prepareWorktreeForRemoval(task.worktree_path, 'moderate');
      await worktreeManager.withLock(async () => {
        removed = await worktreeManager.removeWorktree(task.worktree_path!, { removalProfile: 'moderate' });
        if (removed && task.branch_name) {
          const config = context.configManager.getEffectiveConfig(resolvedProjectPath);
          if (config.git.autoCleanup) {
            // Prune stale worktree metadata so git allows branch deletion
            // even if removeWorktree couldn't fully remove the directory
            try { await worktreeManager.pruneWorktrees(); } catch { /* best effort */ }
            await worktreeManager.removeBranch(task.branch_name);
          }
        }
        // BACKGROUND: cleanup is best-effort with a startup retry net
        // (retryFailedDoneCleanups); a batch of removals must not park a
        // fresh agent spawn waiting at USER priority on this project.
      }, { label: `cleanup-worktree:${task.id.slice(0, 8)}`, priority: GitQueuePriority.BACKGROUND });
    } catch (err) {
      console.error(`[WORKTREE] Failed to clean up worktree for task ${task.id.slice(0, 8)}:`, err);
    }
    // Only clear DB fields if the directory was actually removed.
    // Keeping them set allows resource-cleanup to retry on next startup.
    // Guard against concurrent delete: the task row may already be gone
    // by the time removeWorktree resolves. Update is idempotent.
    // `pushed_branch` is deliberately kept: it is a remote fact and a PR
    // anchor that outlives the local checkout. A To Do move forgets it
    // afterwards (`forgetPRLinkOnTodoReset`); a delete and a Backlog demote
    // keep it.
    if (removed && tasks.getById(task.id)) {
      tasks.update({
        id: task.id,
        worktree_path: null,
        branch_name: null,
        resolved_base_branch: null,
        ...(capturedSha ? { head_sha: capturedSha } : {}),
      });
    }
  }
}

/**
 * Delete only the local worktree directory, preserving branch_name and
 * all session records. `worktree_path` is nulled on success so the task
 * reads as "deleted-but-resumable". Moving out of Done re-creates the
 * worktree from the preserved branch via ensureTaskWorktree().
 *
 * Before removal it reads the worktree's live HEAD and, if the agent renamed
 * the branch inside the worktree, writes the real branch name back to
 * `tasks.branch_name`. Agents rename branches to team conventions, so the
 * stored slug can be stale; without this the Done dialog would name the wrong
 * branch and, worse, restore (`createWorktree`) would re-attach to a branch
 * that no longer exists and silently fork a fresh one from base, losing the
 * committed work. The write-back happens BEFORE the removal attempt so a
 * failed removal still leaves the corrected name persisted for the startup
 * retry pass.
 *
 * The directory is moved aside first (`WorktreeManager.moveWorktreeAside`):
 * renamed into `.kangentic/removed-worktrees/`, and its files are deleted in
 * the background, never while a Post-Worktree Script runs
 * (`removed-worktrees.ts`). Only when the rename fails, because something
 * still holds the directory, is it removed in place as before.
 *
 * Returns true when the directory left its path and the DB field was cleared,
 * false when there was nothing to delete or the removal failed. Callers use
 * the return value for log classification; callers that want to retry on
 * failure rely on the preserved `worktree_path`.
 *
 * LOCK CONTRACT: callers MUST hold a `withTaskLock(taskId, ...)` for the
 * duration of this call. Crosses an await boundary and mutates per-task
 * state (`worktree_path`, `branch_name`, plus filesystem state under the
 * project's worktrees directory). Without the lock, a concurrent
 * ensureTaskWorktree or cleanupTaskResources for the same task can interleave
 * with the removal and corrupt git's worktree metadata.
 *
 * Used by TASK_MOVE -> Done.
 */
export async function deleteTaskWorktree(
  context: IpcContext,
  task: { id: string; worktree_path: string | null; branch_name: string | null },
  tasks: TaskRepository,
  projectPath?: string | null,
): Promise<boolean> {
  const resolvedProjectPath = projectPath ?? context.currentProjectPath;
  if (!task.worktree_path || !resolvedProjectPath) return false;

  // Capture the worktree HEAD before removal: the immutable commit anchor
  // survives the Done transition (PR resolution can match by commit after a
  // rename), and the live branch name corrects a stale stored slug so both the
  // Done dialog and the eventual restore name the branch the work lives on.
  const { branch: capturedBranch, sha: capturedSha } = await readWorktreeHead(task.worktree_path);
  if (capturedBranch && capturedBranch !== task.branch_name && tasks.getById(task.id)) {
    tasks.update({ id: task.id, branch_name: capturedBranch });
  }

  // The Done move fired its churn capture into this worktree just before this
  // call. The in-place delete below used to give it 30 s of slack; a move
  // aside takes the directory at once.
  await waitForChurnRead(task.worktree_path, CHURN_READ_WAIT_MS);

  let removed = false;
  // True once the worktree sits in removed-worktrees/ and the deleter has to
  // be started for it. False after an in-place removal, which leaves no copy.
  let copyAwaitsDeleter = false;
  try {
    const worktreeManager = new WorktreeManager(resolvedProjectPath);
    // A creation still setting this path up writes there outside the git
    // queue; wait it out here, since the move inside the queue only refuses.
    await waitForWorktreeCreation(task.worktree_path);
    // BACKGROUND: nothing user-visible gates on the removal finishing (the
    // board mutation + archive already happened); a batch Done-move must not
    // park a fresh agent spawn behind its removals.
    copyAwaitsDeleter = await worktreeManager.withLock(
      () => worktreeManager.moveWorktreeAside(task.worktree_path!),
      { label: `remove-worktree:${task.id.slice(0, 8)}`, priority: GitQueuePriority.BACKGROUND },
    );
    removed = copyAwaitsDeleter;
    if (!copyAwaitsDeleter) {
      // The rename failed (something holds the directory) or was refused.
      // Remove in place, as before the move existed, so the retry net below
      // and at the next project open still applies.
      //
      // Reap orphans + clear node_modules BEFORE taking the git lock so the slow
      // fs work (and a pinned-handle stall) does not head-of-line-block every
      // other spawn on this project. Safe outside the lock per the LOCK CONTRACT
      // above: the caller holds withTaskLock(taskId), which serializes same-path
      // work; no other task ever shares this worktree path.
      await prepareWorktreeForRemoval(task.worktree_path, 'moderate');
      removed = await worktreeManager.withLock(
        () => worktreeManager.removeWorktree(task.worktree_path!, { removalProfile: 'moderate' }),
        { label: `remove-worktree:${task.id.slice(0, 8)}`, priority: GitQueuePriority.BACKGROUND },
      );
    }
  } catch (err) {
    console.error(`[WORKTREE] Failed to delete worktree for task ${task.id.slice(0, 8)}:`, err);
  }

  if (removed) {
    tasks.update({ id: task.id, worktree_path: null, ...(capturedSha ? { head_sha: capturedSha } : {}) });
  }
  // After the row stops naming the path. The deleter waits while any init
  // script runs, so the next task's install has the disk to itself.
  if (copyAwaitsDeleter) scheduleRemovedWorktreeDeletion(resolvedProjectPath);
  return removed;
}
