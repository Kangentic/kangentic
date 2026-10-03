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
 * When the second pass had anything to kill, a last scan finds what survived
 * it, and the report names that as not stopped. A scan that fails or lists
 * nothing after the first pass's kills ends the reap there, with no force
 * pass, and the roots it signalled are reported as not stopped.
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
  isInsideDirectory,
  planReapDetailed,
  subtreeOf,
  type KeptReason,
  type ReapPlanInput,
  type ReapTaskScope,
} from './reap-plan';
import type { ProcessScan, ScannedProcess, TaggedProcessReader } from './process-scan';

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
 * never true (the host and main are always running). `reap_error`: anything
 * else threw.
 */
export type ReapFailureCode = 'reader_load' | 'empty_scan' | 'reap_error';

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
function emptyResult(): TaggedReapResult {
  return { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, entries: [] };
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

function identityOf(scanned: ScannedProcess): string {
  return `${scanned.pid}:${scanned.startKey}`;
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

/**
 * The valid tasks of a request, merged by id, with their directories. Main
 * already drops a filesystem root and the home directory
 * (`resolveTaskDirectories`); the host drops them again rather than trust
 * every caller to, since one such directory makes the directory test admit
 * nearly every tagged process. A task left with no directory is dropped.
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
  const tasks = scopesOf(request.tasks, deps.homeDirectory ?? os.homedir());
  if (tasks.size === 0) return emptyResult();
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
    return { ...emptyResult(), failureReason: messageOf(error), failureCode: 'reader_load' };
  }
  const killed = new Set<number>();
  // Set once the graceful kills went out: a scan that fails after them still
  // owes the user a report, with what was signalled listed as not stopped.
  let signalledEntries: (() => LeftoverProcessEntry[]) | null = null;
  try {
    const firstScan = await deps.reader.scan();
    if (firstScan.processes.length === 0) {
      return { ...emptyResult(), failureReason: 'the process scan listed nothing', failureCode: 'empty_scan' };
    }
    const firstPlan = planReapDetailed(planInput(firstScan.processes));
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
        entries: [...firstPlan.roots.map((root) => entryFor(root.process, root.taskId, 'kept', null)), ...keptEntries],
      };
    }

    for (const pid of await killAll(deps.reader, firstPlan.targets, 'graceful')) killed.add(pid);
    signalledEntries = () => [
      ...firstPlan.roots.map((root) => entryFor(root.process, root.taskId, 'failed', null)),
      ...keptEntries,
    ];
    await wait(REAP_GRACE_MS);
    const secondScan = requireProcesses(await deps.reader.scan());
    const secondPlan = planReapDetailed(planInput(secondScan.processes));
    for (const pid of await killAll(deps.reader, secondPlan.targets, 'force')) killed.add(pid);

    // What outlived even the force pass is reported as not stopped, under the
    // root it belongs to, or on its own when its root is gone. On its own it is
    // reported under the task of the second plan's root it was killed under,
    // so an untagged one (an unreadable environment, a withheld Apple tool)
    // is named too.
    const failedRootPids = new Set<number>();
    const orphanSurvivors: ScannedProcess[] = [];
    const orphanTasks = new Map<number, string>();
    const secondRootTasks = new Map(secondPlan.roots.map((root) => [root.process.pid, root.taskId]));
    let unreadableCount = secondScan.unreadableCount;
    if (secondPlan.targets.length > 0) {
      await wait(SURVIVOR_CHECK_MS);
      const lastScan = requireProcesses(await deps.reader.scan());
      unreadableCount = lastScan.unreadableCount;
      const alive = new Set(lastScan.processes.map(identityOf));
      const reportedRootPids = new Set(firstPlan.roots.map((root) => root.process.pid));
      const secondByPid = new Map(secondScan.processes.map((scanned) => [scanned.pid, scanned]));
      for (const survivor of secondPlan.targets) {
        if (!alive.has(identityOf(survivor))) continue;
        let owner: number | null = reportedRootPids.has(survivor.pid) ? survivor.pid : null;
        let cursor = survivor;
        for (let depth = 0; owner === null && depth < 64; depth += 1) {
          const parent = secondByPid.get(cursor.ppid);
          if (!parent || parent.pid === cursor.pid) break;
          if (reportedRootPids.has(parent.pid)) owner = parent.pid;
          cursor = parent;
        }
        if (owner !== null) {
          failedRootPids.add(owner);
          continue;
        }
        const taskId = owningTaskOf(survivor, secondByPid, secondRootTasks);
        if (taskId === null) continue;
        orphanSurvivors.push(survivor);
        orphanTasks.set(survivor.pid, taskId);
      }
    }
    const survivorLabels = await describeSafely(deps.reader, orphanSurvivors);
    for (const [pid, label] of survivorLabels) labels.set(pid, label);
    const orphanEntries = orphanSurvivors.map((survivor) => entryFor(survivor, orphanTasks.get(survivor.pid) as string, 'failed', null));

    return {
      killedPids: [...killed].sort((left, right) => left - right),
      unreadableCount,
      failureReason: null,
      failureCode: null,
      entries: [
        ...firstPlan.roots.map((root) => entryFor(root.process, root.taskId, failedRootPids.has(root.process.pid) ? 'failed' : 'stopped', null)),
        ...orphanEntries,
        ...keptEntries,
      ],
    };
  } catch (error) {
    return {
      ...emptyResult(),
      killedPids: [...killed].sort((left, right) => left - right),
      failureReason: messageOf(error),
      failureCode: error instanceof EmptyScanError ? 'empty_scan' : 'reap_error',
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

/** `ended`: it was already gone. `failed`: it is still running. */
export type StopProcessOutcome = 'stopped' | 'ended' | 'failed';

/**
 * Stop one process a report named, with everything under it, as the user
 * asked from the list. Its tag and directory were checked when the report was
 * made; here only its identity is, and Kangentic's own tree and every held PTY
 * stay out of reach exactly as in a reap. A window or a tmux server is stopped
 * here, since the user chose it by name.
 */
export async function stopProcessTree(
  request: StopProcessRequest,
  deps: TaggedReaperDeps,
): Promise<StopProcessOutcome> {
  const wait = deps.wait ?? defaultWait;
  try {
    const scan = await deps.reader.scan();
    // A scan that lists nothing failed (see `empty_scan`); it says nothing about whether the process ended.
    if (scan.processes.length === 0) return 'failed';
    const target = scan.processes.find((scanned) => scanned.pid === request.pid && scanned.startKey === request.startKey);
    if (!target || !request.startKey) return 'ended';
    const safetyPids = buildSafetyProtectedPids({ processes: scan.processes, mainPid: request.mainPid, liveRootPids: deps.liveRootPids() });
    if (safetyPids.has(target.pid)) return 'failed';
    const tree = subtreeOf(target, scan.processes, safetyPids);
    if (tree.length === 0) return 'failed';
    await killAll(deps.reader, tree, 'graceful');
    await wait(REAP_GRACE_MS);
    // An empty later scan throws, so it reads as `failed`, never as `stopped`.
    const secondScan = requireProcesses(await deps.reader.scan());
    const aliveAfterFirst = new Set(secondScan.processes.map(identityOf));
    const survivors = tree.filter((scanned) => aliveAfterFirst.has(identityOf(scanned)));
    if (survivors.length === 0) return 'stopped';
    await killAll(deps.reader, survivors, 'force');
    await wait(SURVIVOR_CHECK_MS);
    const lastScan = requireProcesses(await deps.reader.scan());
    return lastScan.processes.some((scanned) => identityOf(scanned) === identityOf(target)) ? 'failed' : 'stopped';
  } catch {
    return 'failed';
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
  stop(request: StopProcessRequest): Promise<StopProcessOutcome> {
    const run = this.stopChain.then(() => stopProcessTree(request, this.deps));
    this.stopChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
