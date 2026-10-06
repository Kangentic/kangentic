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
 * back only its own tasks' report.
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
  /** Whether it worked in the task's worktree or elsewhere in its project. */
  place: 'worktree' | 'project';
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

export interface TaggedReaperDeps {
  reader: TaggedProcessReader;
  /** The PTY roots the host still holds; see `reap-plan.ts`. Read per scan. */
  liveRootPids: () => number[];
  wait?: (ms: number) => Promise<void>;
  /** Defaults to the host platform's: case-insensitive on Windows and macOS. */
  caseInsensitivePaths?: boolean;
  /** Defaults to `os.homedir()`; a test passes its own. */
  homeDirectory?: string;
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

const identityOf = processIdentity;

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
    const labels = await describeSafely(deps.reader, [
      ...firstPlan.roots.map((root) => root.process),
      ...firstPlan.kept.map((kept) => kept.process),
    ]);
    const entryFor = (scanned: ScannedProcess, taskId: string, outcome: LeftoverOutcome, reason: KeptReason | null): LeftoverProcessEntry => ({
      taskId,
      pid: scanned.pid,
      startKey: scanned.startKey,
      label: labels.get(scanned.pid) ?? UNNAMED_LABEL,
      outcome,
      reason,
      place: placeOf(scanned, taskId),
    });
    const keptEntries = firstPlan.kept.map((kept) => entryFor(kept.process, kept.taskId, 'kept', kept.reason));

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
    const listedAfterFirst = new Set(secondScan.processes.map(identityOf));
    const rootStillListed = firstPlan.roots.some((root) => listedAfterFirst.has(identityOf(root.process)));
    if (secondPlan.targets.length > 0 || rootStillListed) {
      await wait(SURVIVOR_CHECK_MS);
      pass = 'last';
      const lastScan = requireProcesses(await deps.reader.scan());
      unreadableCount = lastScan.unreadableCount;
      const alive = new Set(lastScan.processes.map(identityOf));
      // By identity, not pid: a root that exited can have its pid reused by a
      // new process, which must not be reported as that root failing.
      const reportedRootPidByIdentity = new Map(firstPlan.roots.map((root) => [identityOf(root.process), root.process.pid]));
      for (const root of firstPlan.roots) if (alive.has(identityOf(root.process))) failedRootPids.add(root.process.pid);
      const secondByPid = new Map(secondScan.processes.map((scanned) => [scanned.pid, scanned]));
      for (const survivor of secondPlan.targets) {
        if (!alive.has(identityOf(survivor))) continue;
        let owner: number | null = reportedRootPidByIdentity.get(identityOf(survivor)) ?? null;
        let cursor = survivor;
        for (let depth = 0; owner === null && depth < 64; depth += 1) {
          const parent = secondByPid.get(cursor.ppid);
          if (!parent || parent.pid === cursor.pid) break;
          owner = reportedRootPidByIdentity.get(identityOf(parent)) ?? null;
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

/** A stop the user asked for, of one process a report named. */
export interface StopProcessRequest {
  pid: number;
  /** The identity key the report carried; a process with another is not the one named. */
  startKey: string;
  mainPid: number;
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
 * here, since the user chose it by name.
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
    const target = scan.processes.find((scanned) => scanned.pid === request.pid && scanned.startKey === request.startKey);
    if (!target || !request.startKey) return stopAnswer('ended');
    const safetyPids = buildSafetyProtectedPids({ processes: scan.processes, mainPid: request.mainPid, liveRootPids: deps.liveRootPids() });
    if (safetyPids.has(target.pid)) return stopAnswer('failed');
    const tree = subtreeOf(target, scan.processes, safetyPids);
    if (tree.length === 0) return stopAnswer('failed');
    await killAll(deps.reader, tree, 'graceful');
    await wait(REAP_GRACE_MS);
    pass = 'second';
    // An empty later scan throws, so it reads as `failed`, never as `stopped`.
    const secondScan = requireProcesses(await deps.reader.scan());
    const aliveAfterFirst = new Set(secondScan.processes.map(identityOf));
    const survivors = tree.filter((scanned) => aliveAfterFirst.has(identityOf(scanned)));
    if (survivors.length === 0) return stopAnswer('stopped');
    await killAll(deps.reader, survivors, 'force');
    await wait(SURVIVOR_CHECK_MS);
    pass = 'last';
    const lastScan = requireProcesses(await deps.reader.scan());
    // Any survivor, not only the target: a child that outlived its parent
    // keeps the tree running.
    const aliveAtLast = new Set(lastScan.processes.map(identityOf));
    return stopAnswer(survivors.some((survivor) => aliveAtLast.has(identityOf(survivor))) ? 'failed' : 'stopped');
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
    const run = this.stopChain.then(() => stopProcessTree(request, this.deps));
    this.stopChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
