/**
 * Kill what a reaped task left running: every process carrying its tag and
 * working inside its own directories (`reap-plan.ts`). Runs in the pty host.
 *
 * Two passes, on every platform:
 * 1. Scan, plan (`reap-plan.ts`), and ask each target to exit (SIGTERM on
 *    POSIX; a terminate on Windows).
 * 2. Wait, scan again, plan again, and force-kill whatever the second plan
 *    still holds. That catches a POSIX process that ignored SIGTERM and a
 *    tagged supervisor that respawned a child between the first scan and its
 *    own kill. Every kill re-checks the target's start time first (see each
 *    reader), so a pid reused since its scan is never touched.
 * When the second pass had anything to kill, or a root the first pass asked to
 * exit is still listed, a last scan finds what survived, and the report names
 * that as not stopped. A scan that fails or lists nothing after the first
 * pass's kills ends the reap there, with no force pass, and the roots it
 * signalled are reported as not stopped.
 *
 * Each plan also reads, right after its scan, which processes other Kangentic
 * work holds a TCP connection to (`connectionQueryOf`, the reader's
 * `connections`), and what the first plan left running stays running in the
 * second (`keepIdentities`): a client command that ends inside the grace must
 * not let the force pass kill the server it was using.
 *
 * The result reports, per task, the top of each subtree it stopped and the
 * task's own processes it left running on purpose (a window, a tmux server, a
 * shared tool), each under a short label (`process-label.ts`). With stopping
 * turned off it kills nothing and reports everything as still running.
 *
 * Concurrent requests coalesce: a request that arrives while a reap runs joins
 * the next batch, and one scan pair serves the whole batch. A bulk delete or a
 * project delete fires many at once. Each task keeps its own directories in the
 * batch, so one project's reap never widens another's, and each request gets
 * back only its own tasks' report. Each batch says when it starts
 * (`onBatchStart`), and main's budget for a request still waiting restarts
 * there, so a reap queued behind another is never charged for that wait.
 *
 * Best-effort by contract: it never throws, because a task teardown must
 * proceed even when the reap fails outright.
 */

import os from 'node:os';
import { isValidTaskTagValue } from './task-process-tag';
import { isUsableReapRoot } from './task-directories';
import {
  buildSafetyProtectedPids,
  connectionQueryOf,
  isInsideDirectory,
  planReapDetailed,
  processIdentity,
  subtreeOf,
  type KeptBecause,
  type KeptReason,
  type ReapPlan,
  type ReapPlanInput,
  type ReapTaskScope,
} from './reap-plan';
import {
  ScanStepError,
  type LocalConnectionRead,
  type ProcessScan,
  type ScannedProcess,
  type ScanStepFailureCode,
  type TaggedProcessReader,
} from './process-scan';

/** How long the first pass's targets get to exit before the second scan. */
export const REAP_GRACE_MS = 1000;
/** How long a force-killed process gets to disappear before it counts as not stopped. */
export const SURVIVOR_CHECK_MS = 500;
/** What a process is called when its command line could not be read. */
const UNNAMED_LABEL = 'process';

/** One task to reap, and where its processes work. */
export interface TaggedReapTask {
  taskId: string;
  /**
   * The task's project directory and worktree, each as stored and as its real
   * path. A tagged process working outside all of them is never killed.
   */
  directories: string[];
  /** The worktree alone, for the macOS withheld-orphan match and the report's place. */
  worktreePath: string | null;
}

export interface TaggedReapRequest {
  tasks: TaggedReapTask[];
  mainPid: number;
  /** False when the user turned stopping off: plan and report, kill nothing. */
  stop: boolean;
}

/** What happened to one reported process. */
export type LeftoverOutcome = 'stopped' | 'failed' | 'kept';

/**
 * A kept process's basis, with the label of the process that showed it (the
 * descendant or the client), read the way a reported process's is, or null
 * when there is none or it could not be read. For the local log only.
 */
export type KeptExplanation = KeptBecause & { evidenceLabel: string | null };

/** One process a reap reports to the user. */
export interface LeftoverProcessEntry {
  taskId: string;
  pid: number;
  /** The scan's identity key, so a later stop never touches a reused pid. */
  startKey: string;
  /** "node (vite)": never more of the command line (`process-label.ts`). */
  label: string;
  outcome: LeftoverOutcome;
  /** Why a `kept` process was left running; null when stopping is off, and for stopped or failed ones. */
  reason: KeptReason | null;
  /**
   * What `reason` rests on (`reap-plan.ts`), for main's log line. Never sent
   * to the renderer: `leftover-process-reports.ts` builds its rows field by
   * field. Null wherever `reason` is.
   */
  because: KeptExplanation | null;
  /** Whether it worked in the task's worktree or elsewhere in its project. */
  place: 'worktree' | 'project';
}

/** The process behind a `shared` verdict, as its label and pid. */
function evidenceOf(because: KeptExplanation): string {
  return `${because.evidenceLabel ?? UNNAMED_LABEL} (pid ${because.evidencePid})`;
}

/** Why a kept process was kept, in words, from its reason and what that rests on. */
function keptWhyOf(reason: KeptReason, because: KeptExplanation | null): string {
  if (!because) return reason;
  switch (because.basis) {
    case 'descendant':
      return `shared, by descendant ${evidenceOf(because)}, which works outside the task's directories or does not carry its tag`;
    case 'connection':
      return `shared, by a connection from ${evidenceOf(because)}`;
    case 'children':
      return `${reason}, because every child it has is kept`;
    case 'role':
      return reason;
  }
}

/**
 * The local log line for a process a reap did not stop, or null for one it
 * stopped. Only what the report already carries (the label, the pid, the
 * place), the task's short id, and the plan's reason and evidence pid: never
 * more of a command line or any environment text (`task-process-tag.md`).
 */
export function leftoverLogLine(entry: LeftoverProcessEntry): string | null {
  const who = `${entry.label} (pid ${entry.pid}) of task ${entry.taskId.slice(0, 8)} in the ${entry.place}`;
  if (entry.outcome === 'failed') return `could not stop ${who}`;
  if (entry.outcome !== 'kept') return null;
  if (entry.reason === null) return `left ${who} running: stopping is off`;
  return `kept ${who}: ${keptWhyOf(entry.reason, entry.because)}`;
}

/**
 * Why a reap gave up, as a fixed code. `reader_load`: koffi or an OS library
 * would not load. `empty_scan`: the scan listed no process at all, which is
 * never true (the host and main are always running). `process_list`,
 * `window_list` and `connection_list`: a scan step the reader named failed
 * (`ScanStepError`).
 * `reap_error`: anything else threw.
 */
export type ReapFailureCode = 'reader_load' | 'empty_scan' | ScanStepFailureCode | 'reap_error';

/**
 * The pass a reap was in when it failed. `first`: nothing was signalled yet.
 * `second`: the graceful kills went out. `last`: the survivor check, after the
 * force pass.
 */
export type ReapPass = 'first' | 'second' | 'last';

export interface TaggedReapResult {
  /** Pids a kill was issued for, in either pass. */
  killedPids: number[];
  /** Same-user processes whose environment could not be read, last scan. */
  unreadableCount: number;
  /**
   * Why the reap gave up, or null. Carried back rather than logged here: the
   * pty host's stdout goes nowhere in a packaged build, so main does the
   * logging (`SessionManager.reapTaskProcesses`). Local logs only: it can
   * come from a scan, so what leaves the machine is `failureCode`.
   */
  failureReason: string | null;
  failureCode: ReapFailureCode | null;
  /** The pass the reap failed in, or null when it failed before its first scan or did not fail. */
  failurePass: ReapPass | null;
  /** What the user is told: stopped, not stopped, and left running. */
  entries: LeftoverProcessEntry[];
}

/** The two queues `TaggedReaper` runs one at a time: reap batches and Stops. */
export type TaggedReaperQueue = 'reap' | 'stop';

export interface TaggedReaperDeps {
  reader: TaggedProcessReader;
  /** The PTY roots the host still holds; see `reap-plan.ts`. Read per scan. */
  liveRootPids: () => number[];
  wait?: (ms: number) => Promise<void>;
  /** Defaults to the host platform's: case-insensitive on Windows and macOS. */
  caseInsensitivePaths?: boolean;
  /** Defaults to `os.homedir()`; a test passes its own. */
  homeDirectory?: string;
  /**
   * Called as each reap batch or Stop starts running, after any wait in the
   * queue. The pty host tells main, which restarts the budget of every request
   * still waiting (`batch-started`), so a request is never charged for the
   * batch ahead of it. Only `TaggedReaper` calls it.
   */
  onBatchStart?: (kind: TaggedReaperQueue) => void;
}

/** A fresh result each time, so no caller can share another's arrays. */
export function emptyReapResult(): TaggedReapResult {
  return { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A scan that listed nothing failed. It never means every process has gone. */
class EmptyScanError extends Error {
  constructor() {
    super('the process scan listed nothing');
  }
}

/**
 * The identities a scan shows still running. A Windows process still listed
 * while it terminates has already exited (`ScannedProcess.exited`), so a kill
 * that landed is not reported as a survivor, and a Stop of one that ended on
 * its own reads `ended`.
 */
function runningIdentitiesOf(scan: ProcessScan): Set<string> {
  return new Set(scan.processes.filter((scanned) => !scanned.exited).map(processIdentity));
}

/** A later scan's result, or an `EmptyScanError` when it listed nothing. */
function requireProcesses(scan: ProcessScan): ProcessScan {
  if (scan.processes.length === 0) throw new EmptyScanError();
  return scan;
}

/** The fixed code for what a pass threw, by its type and never its message. */
function failureCodeOf(error: unknown): ReapFailureCode {
  if (error instanceof EmptyScanError) return 'empty_scan';
  if (error instanceof ScanStepError) return error.code;
  return 'reap_error';
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function killAll(
  reader: TaggedProcessReader,
  targets: readonly ScannedProcess[],
  strength: 'graceful' | 'force',
): Promise<number[]> {
  const outcomes = await Promise.all(targets.map(async (target) => {
    try {
      return (await reader.kill(target, strength)) ? target.pid : null;
    } catch {
      return null;
    }
  }));
  return outcomes.filter((pid): pid is number => pid !== null);
}

async function describeSafely(reader: TaggedProcessReader, targets: readonly ScannedProcess[]): Promise<Map<number, string>> {
  if (targets.length === 0) return new Map();
  try {
    return await reader.describe(targets);
  } catch {
    return new Map();
  }
}

/**
 * Plan from one scan, with the connections read right after it. A reader
 * without `connections` contributes none, and a scan with nothing a reaped
 * task runs reads nothing. A failed read throws
 * `ScanStepError('connection_list')`, which fails the pass it is in.
 */
async function planWithConnections(reader: TaggedProcessReader, input: ReapPlanInput): Promise<ReapPlan> {
  if (!reader.connections) return planReapDetailed(input);
  const query = connectionQueryOf(input);
  const connections: LocalConnectionRead = query.listeners.length > 0
    ? await reader.connections(query.listeners, query.clients)
    : { pairs: [], listeningPids: [] };
  return planReapDetailed({ ...input, connections });
}

/**
 * The task a plan target was killed under: that of the reported root at or
 * above it in the same scan. Every target sits under one, since a plan only
 * collects downward from its roots.
 */
function owningTaskOf(target: ScannedProcess, byPid: ReadonlyMap<number, ScannedProcess>, rootTasks: ReadonlyMap<number, string>): string | null {
  let cursor = target;
  for (let depth = 0; depth < 64; depth += 1) {
    const taskId = rootTasks.get(cursor.pid);
    if (taskId !== undefined) return taskId;
    const parent = byPid.get(cursor.ppid);
    if (!parent || parent.pid === cursor.pid) return null;
    cursor = parent;
  }
  return null;
}

/** Whether an ancestor of `survivor` in the same scan is another surviving orphan of `taskId`. */
function isUnderOrphanOfTask(
  survivor: ScannedProcess,
  taskId: string,
  byPid: ReadonlyMap<number, ScannedProcess>,
  orphanTaskByPid: ReadonlyMap<number, string>,
): boolean {
  let cursor = survivor;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = byPid.get(cursor.ppid);
    if (!parent || parent.pid === cursor.pid) return false;
    if (orphanTaskByPid.get(parent.pid) === taskId) return true;
    cursor = parent;
  }
  return false;
}

/**
 * The valid tasks of a request, merged by id, with their directories. Main
 * already drops a filesystem root and the home directory
 * (`resolveTaskDirectories`); the host drops them again rather than trust
 * every caller to, since one such directory makes the directory test admit
 * nearly every tagged process. A task left with no directory is dropped.
 * Main refuses home in both its stored and its real-path form; this backstop
 * compares the stored form only.
 */
function scopesOf(tasks: readonly TaggedReapTask[], homeDirectory: string): Map<string, ReapTaskScope> {
  const scopes = new Map<string, { directories: Set<string>; worktreePath: string | null }>();
  for (const task of tasks) {
    if (!isValidTaskTagValue(task.taskId)) continue;
    let scope = scopes.get(task.taskId);
    if (!scope) {
      scope = { directories: new Set(), worktreePath: null };
      scopes.set(task.taskId, scope);
    }
    for (const directory of task.directories) if (isUsableReapRoot(directory, homeDirectory)) scope.directories.add(directory);
    scope.worktreePath ??= task.worktreePath && isUsableReapRoot(task.worktreePath, homeDirectory) ? task.worktreePath : null;
  }
  return new Map([...scopes]
    .filter(([, scope]) => scope.directories.size > 0)
    .map(([taskId, scope]) => [taskId, { directories: [...scope.directories], worktreePath: scope.worktreePath }]));
}

/** One reap for one batch of tasks. Exported for tests. */
export async function reapTaggedOnce(
  request: TaggedReapRequest,
  deps: TaggedReaperDeps,
): Promise<TaggedReapResult> {
  let tasks: Map<string, ReapTaskScope>;
  try {
    tasks = scopesOf(request.tasks, deps.homeDirectory ?? os.homedir());
  } catch (error) {
    // `os.homedir()` throws for a user with no home. Without it home cannot be
    // refused as a root, so the reap kills nothing.
    return { ...emptyReapResult(), failureReason: messageOf(error), failureCode: 'reap_error' };
  }
  if (tasks.size === 0) return emptyReapResult();
  const wait = deps.wait ?? defaultWait;
  const caseInsensitivePaths = deps.caseInsensitivePaths ?? process.platform !== 'linux';
  const planInput = (processes: ScannedProcess[]): ReapPlanInput => ({
    processes,
    tasks,
    mainPid: request.mainPid,
    liveRootPids: deps.liveRootPids(),
    caseInsensitivePaths,
  });
  const placeOf = (scanned: ScannedProcess, taskId: string): 'worktree' | 'project' => {
    const worktreePath = tasks.get(taskId)?.worktreePath ?? null;
    return worktreePath && scanned.workingDirectory && isInsideDirectory(scanned.workingDirectory, worktreePath, caseInsensitivePaths)
      ? 'worktree'
      : 'project';
  };
  try {
    await deps.reader.ready?.();
  } catch (error) {
    return { ...emptyReapResult(), failureReason: messageOf(error), failureCode: 'reader_load' };
  }
  const killed = new Set<number>();
  // Set once the graceful kills went out: a scan that fails after them still
  // owes the user a report, with what was signalled listed as not stopped.
  let signalledEntries: (() => LeftoverProcessEntry[]) | null = null;
  // Which pass a failure lands in, which says what was signalled before it.
  let pass: ReapPass = 'first';
  try {
    const firstScan = await deps.reader.scan();
    if (firstScan.processes.length === 0) {
      return { ...emptyReapResult(), failureReason: 'the process scan listed nothing', failureCode: 'empty_scan', failurePass: pass };
    }
    const firstPlan = await planWithConnections(deps.reader, planInput(firstScan.processes));
    // The process behind each `shared` verdict is labeled too, for the local
    // log line only: the report never names it. Each process is described
    // once, however many verdicts it is behind.
    const firstByPid = new Map(firstScan.processes.map((scanned) => [scanned.pid, scanned]));
    const describedByPid = new Map<number, ScannedProcess>();
    for (const scanned of [...firstPlan.roots.map((root) => root.process), ...firstPlan.kept.map((kept) => kept.process)]) {
      describedByPid.set(scanned.pid, scanned);
    }
    for (const kept of firstPlan.kept) {
      const evidence = kept.because.evidencePid === null ? undefined : firstByPid.get(kept.because.evidencePid);
      if (evidence) describedByPid.set(evidence.pid, evidence);
    }
    const labels = await describeSafely(deps.reader, [...describedByPid.values()]);
    const explain = (because: KeptBecause): KeptExplanation => ({
      ...because,
      evidenceLabel: because.evidencePid === null ? null : labels.get(because.evidencePid) ?? null,
    });
    const entryFor = (
      scanned: ScannedProcess,
      taskId: string,
      outcome: LeftoverOutcome,
      reason: KeptReason | null,
      because: KeptExplanation | null = null,
    ): LeftoverProcessEntry => ({
      taskId,
      pid: scanned.pid,
      startKey: scanned.startKey,
      label: labels.get(scanned.pid) ?? UNNAMED_LABEL,
      outcome,
      reason,
      because,
      place: placeOf(scanned, taskId),
    });
    const keptEntries = firstPlan.kept.map((kept) => entryFor(kept.process, kept.taskId, 'kept', kept.reason, explain(kept.because)));

    if (!request.stop || firstPlan.targets.length === 0) {
      return {
        killedPids: [],
        unreadableCount: firstScan.unreadableCount,
        failureReason: null,
        failureCode: null,
        failurePass: null,
        entries: [...firstPlan.roots.map((root) => entryFor(root.process, root.taskId, 'kept', null)), ...keptEntries],
      };
    }

    for (const pid of await killAll(deps.reader, firstPlan.targets, 'graceful')) killed.add(pid);
    signalledEntries = () => [
      ...firstPlan.roots.map((root) => entryFor(root.process, root.taskId, 'failed', null)),
      ...keptEntries,
    ];
    await wait(REAP_GRACE_MS);
    pass = 'second';
    const secondScan = requireProcesses(await deps.reader.scan());
    // What the first plan left running on purpose stays running, whatever this
    // scan reads, and what it asked to exit is never kept for its children alone.
    const secondPlan = await planWithConnections(deps.reader, {
      ...planInput(secondScan.processes),
      keepIdentities: firstPlan.keptIdentities,
      signalledIdentities: new Set(firstPlan.targets.map(processIdentity)),
    });
    for (const pid of await killAll(deps.reader, secondPlan.targets, 'force')) killed.add(pid);

    // What outlived even the force pass is reported as not stopped, under the
    // root it belongs to, or on its own when its root is gone. On its own it is
    // reported under the task of the second plan's root it was killed under,
    // so an untagged one (an unreadable environment, a withheld Apple tool)
    // is named too.
    const failedRootPids = new Set<number>();
    const orphanSurvivors: Array<{ survivor: ScannedProcess; taskId: string }> = [];
    const secondRootTasks = new Map(secondPlan.roots.map((root) => [root.process.pid, root.taskId]));
    let unreadableCount = secondScan.unreadableCount;
    // A root the second plan no longer holds (its directory moved, its tag read
    // as null, a new child made it shared) was not force-killed, so only a later
    // scan can say whether it stopped. Scan two alone cannot: on Windows a
    // process can still be listed there while it exits.
    const listedAfterFirst = runningIdentitiesOf(secondScan);
    const rootStillListed = firstPlan.roots.some((root) => listedAfterFirst.has(processIdentity(root.process)));
    if (secondPlan.targets.length > 0 || rootStillListed) {
      await wait(SURVIVOR_CHECK_MS);
      pass = 'last';
      const lastScan = requireProcesses(await deps.reader.scan());
      unreadableCount = lastScan.unreadableCount;
      const alive = runningIdentitiesOf(lastScan);
      // By identity, not pid: a root that exited can have its pid reused by a
      // new process, which must not be reported as that root failing.
      const reportedRootPidByIdentity = new Map(firstPlan.roots.map((root) => [processIdentity(root.process), root.process.pid]));
      for (const root of firstPlan.roots) if (alive.has(processIdentity(root.process))) failedRootPids.add(root.process.pid);
      const secondByPid = new Map(secondScan.processes.map((scanned) => [scanned.pid, scanned]));
      for (const survivor of secondPlan.targets) {
        if (!alive.has(processIdentity(survivor))) continue;
        let owner: number | null = reportedRootPidByIdentity.get(processIdentity(survivor)) ?? null;
        let cursor = survivor;
        for (let depth = 0; owner === null && depth < 64; depth += 1) {
          const parent = secondByPid.get(cursor.ppid);
          if (!parent || parent.pid === cursor.pid) break;
          owner = reportedRootPidByIdentity.get(processIdentity(parent)) ?? null;
          cursor = parent;
        }
        if (owner !== null) {
          failedRootPids.add(owner);
          continue;
        }
        const taskId = owningTaskOf(survivor, secondByPid, secondRootTasks);
        if (taskId !== null) orphanSurvivors.push({ survivor, taskId });
      }
      // A survivor under another surviving orphan of its task is part of that
      // one's tree: the report names the top only, as it does for a root.
      const orphanTaskByPid = new Map(orphanSurvivors.map((orphan) => [orphan.survivor.pid, orphan.taskId]));
      const topOrphans = orphanSurvivors.filter((orphan) => !isUnderOrphanOfTask(orphan.survivor, orphan.taskId, secondByPid, orphanTaskByPid));
      orphanSurvivors.splice(0, orphanSurvivors.length, ...topOrphans);
    }
    // A separate map, not merged into `labels`: a survivor can hold the pid of
    // a first-plan root that exited, and that root's entry keeps its own label.
    const survivorLabels = await describeSafely(deps.reader, orphanSurvivors.map((orphan) => orphan.survivor));
    const orphanEntries = orphanSurvivors.map((orphan) => ({
      ...entryFor(orphan.survivor, orphan.taskId, 'failed', null),
      label: survivorLabels.get(orphan.survivor.pid) ?? UNNAMED_LABEL,
    }));

    return {
      killedPids: [...killed].sort((left, right) => left - right),
      unreadableCount,
      failureReason: null,
      failureCode: null,
      failurePass: null,
      entries: [
        ...firstPlan.roots.map((root) => entryFor(root.process, root.taskId, failedRootPids.has(root.process.pid) ? 'failed' : 'stopped', null)),
        ...orphanEntries,
        ...keptEntries,
      ],
    };
  } catch (error) {
    return {
      ...emptyReapResult(),
      killedPids: [...killed].sort((left, right) => left - right),
      failureReason: messageOf(error),
      failureCode: failureCodeOf(error),
      failurePass: pass,
      entries: signalledEntries ? signalledEntries() : [],
    };
  }
}

/**
 * A stop of one process and its tree, named by identity: one a report named,
 * which the user asked to stop, or one the worktree-removal reap found holding
 * its worktree (`zombie-reaper.ts`).
 */
export interface StopProcessRequest {
  pid: number;
  /** The identity key the report carried; a process with another is not the one named. Empty when `startedAtMs` names it instead. */
  startKey: string;
  /**
   * Its creation time, read by a scan outside the reader (the removal reap's
   * `Win32_Process` query, whose `CreationDate` lands on the same millisecond
   * as the reader's: 483 of 483 processes measured). Read only when
   * `startKey` is empty. With neither, nothing matches.
   */
  startedAtMs?: number;
  mainPid: number;
}

/** Whether a scanned process is the one a stop request names (see `StopProcessRequest`). */
function isRequestedProcess(scanned: ScannedProcess, request: StopProcessRequest): boolean {
  if (scanned.pid !== request.pid || scanned.startKey === '') return false;
  if (request.startKey) return scanned.startKey === request.startKey;
  return request.startedAtMs !== undefined && scanned.startedAtMs === request.startedAtMs;
}

/** `ended`: it was already gone. `failed`: it, or a process under it, is still running. */
export type StopProcessOutcome = 'stopped' | 'ended' | 'failed';

/**
 * A stop's answer, and why it gave up when it did. A refusal (Kangentic's
 * tree, a held PTY) or a process that outlived the force kill is an answer,
 * with no failure code. Only a scan that threw or listed nothing carries one,
 * with the pass it happened in. `failureReason` is for local logs only: it
 * can come from a scan.
 */
export interface StopProcessResult {
  outcome: StopProcessOutcome;
  failureCode: ReapFailureCode | null;
  failurePass: ReapPass | null;
  failureReason: string | null;
}

/** A stop's answer with no failure to report. */
export function stopAnswer(outcome: StopProcessOutcome): StopProcessResult {
  return { outcome, failureCode: null, failurePass: null, failureReason: null };
}

/**
 * Stop one process a report named, with everything under it, as the user
 * asked from the list. Its tag and directory were checked when the report was
 * made; here only its identity is, and Kangentic's own tree and every held PTY
 * stay out of reach exactly as in a reap. A window or a tmux server is stopped
 * here, since the user chose it by name. The worktree-removal reap stops the
 * orphans holding a worktree the same way, by the creation time its own scan
 * read, so a pid that changed hands since that scan is never touched.
 *
 * It stops the tree the first scan saw, and adopts nothing later: a child
 * started between that scan and the kill is left, since once its parent is
 * gone a Linux scan cannot tell it from a stranger that reused the parent's
 * pid. It keeps the task's tag, so the next terminal transition reaps it.
 */
export async function stopProcessTree(
  request: StopProcessRequest,
  deps: TaggedReaperDeps,
): Promise<StopProcessResult> {
  const wait = deps.wait ?? defaultWait;
  // As in a reap: which pass a failure lands in says what was signalled before it.
  let pass: ReapPass = 'first';
  try {
    // A scan that lists nothing failed (see `empty_scan`); it says nothing about whether the process ended.
    const scan = requireProcesses(await deps.reader.scan());
    const target = scan.processes.find((scanned) => isRequestedProcess(scanned, request));
    if (!target || target.exited) return stopAnswer('ended');
    const safetyPids = buildSafetyProtectedPids({ processes: scan.processes, mainPid: request.mainPid, liveRootPids: deps.liveRootPids() });
    if (safetyPids.has(target.pid)) return stopAnswer('failed');
    const tree = subtreeOf(target, scan.processes, safetyPids);
    if (tree.length === 0) return stopAnswer('failed');
    await killAll(deps.reader, tree, 'graceful');
    await wait(REAP_GRACE_MS);
    pass = 'second';
    // An empty later scan throws, so it reads as `failed`, never as `stopped`.
    const secondScan = requireProcesses(await deps.reader.scan());
    const aliveAfterFirst = runningIdentitiesOf(secondScan);
    const survivors = tree.filter((scanned) => aliveAfterFirst.has(processIdentity(scanned)));
    if (survivors.length === 0) return stopAnswer('stopped');
    await killAll(deps.reader, survivors, 'force');
    await wait(SURVIVOR_CHECK_MS);
    pass = 'last';
    const lastScan = requireProcesses(await deps.reader.scan());
    // Any survivor, not only the target: a child that outlived its parent
    // keeps the tree running.
    const aliveAtLast = runningIdentitiesOf(lastScan);
    return stopAnswer(survivors.some((survivor) => aliveAtLast.has(processIdentity(survivor))) ? 'failed' : 'stopped');
  } catch (error) {
    return { outcome: 'failed', failureCode: failureCodeOf(error), failurePass: pass, failureReason: messageOf(error) };
  }
}

interface PendingBatch {
  tasks: TaggedReapTask[];
  mainPid: number;
  stop: boolean;
  waiters: Array<{ taskIds: Set<string>; resolve: (result: TaggedReapResult) => void }>;
}

/** Serializes reaps and coalesces the requests that arrive during one. */
export class TaggedReaper {
  private running = false;
  /** One pending batch per stop setting, so a report-only request never kills. */
  private readonly pending = new Map<boolean, PendingBatch>();
  private stopChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: TaggedReaperDeps) {}

  request(request: TaggedReapRequest): Promise<TaggedReapResult> {
    return new Promise((resolve) => {
      let batch = this.pending.get(request.stop);
      if (!batch) {
        batch = { tasks: [], mainPid: request.mainPid, stop: request.stop, waiters: [] };
        this.pending.set(request.stop, batch);
      }
      batch.tasks.push(...request.tasks);
      batch.waiters.push({ taskIds: new Set(request.tasks.map((task) => task.taskId)), resolve });
      if (!this.running) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.size > 0) {
        const [stop, batch] = this.pending.entries().next().value as [boolean, PendingBatch];
        this.pending.delete(stop);
        this.announceStart('reap');
        const result = await reapTaggedOnce({ tasks: batch.tasks, mainPid: batch.mainPid, stop: batch.stop }, this.deps);
        for (const waiter of batch.waiters) {
          waiter.resolve({ ...result, entries: result.entries.filter((entry) => waiter.taskIds.has(entry.taskId)) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Stop one reported process. Stops run one at a time, so two clicks never interleave their scans. */
  stop(request: StopProcessRequest): Promise<StopProcessResult> {
    const run = this.stopChain.then(() => {
      this.announceStart('stop');
      return stopProcessTree(request, this.deps);
    });
    this.stopChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Whether each process a report named is still running, for the leftover
   * list's recheck: `true`, `false` (ended), or `null` (cannot tell). Outside
   * both queues, since it kills nothing and must not wait behind a reap's
   * grace. A reader without `isRunning` answers `null` for every one: a full
   * scan reads every process's environment, which a recheck on a timer must
   * never do.
   */
  async checkRunning(identities: ReadonlyArray<Pick<ScannedProcess, 'pid' | 'startKey'>>): Promise<Array<boolean | null>> {
    const reader = this.deps.reader;
    if (!reader.isRunning) return identities.map(() => null);
    const answers: Array<boolean | null> = [];
    for (const identity of identities) {
      try {
        answers.push(await reader.isRunning(identity));
      } catch {
        answers.push(null);
      }
    }
    return answers;
  }

  /** A failure to tell main (a closed port at quit) must not strand a waiter: a reap never throws. */
  private announceStart(kind: TaggedReaperQueue): void {
    try {
      this.deps.onBatchStart?.(kind);
    } catch {
      // Main's budget then runs from the send, as it did before batches announced their start.
    }
  }
}
