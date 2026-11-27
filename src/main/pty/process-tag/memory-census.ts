/**
 * What holds the Windows commit charge when memory reads low (Sentry
 * DESKTOP-5C, 5D, 5E, 5F, 5P). One install ran out of commit for two days,
 * across relaunches, with Kangentic's own live load explaining at most about
 * 10 GB of a 38 GB limit. A quit reaps nothing by design, so what a parked
 * task's agent started survives every relaunch, and a resumed agent may start
 * a second copy beside it (`task-process-tag.md`). Nothing measured that.
 *
 * At the start of each low-memory spell main asks the pty host for one census
 * (`censusHostMemory`). The host scans with `readCommit` (the reader reads
 * each same-user process's `PrivateUsage` on the handle its environment read
 * already opens) and sums the table here. It returns sums and counts, plus
 * one sum per task tag it saw. A tag value is a task id and stays on this
 * computer: main classifies it against the open projects and sends only
 * buckets (`src/main/diagnostics/host-memory-census.ts`).
 *
 * Every process falls into the first group it fits:
 *   1. Kangentic's own Electron processes (main sends their pids).
 *   2. Under a live PTY: a PTY root the host holds and its real descendants,
 *      by parent link and creation time, so a reused pid joins no tree.
 *   3. Kangentic's other children: below one of its Electron processes but
 *      under no live PTY (a headless agent CLI run, git, a probe).
 *   4. Tagged with a task id, per tag, outside every live tree.
 *   5. Every other process of the caller's user in the caller's session.
 * A process whose commit could not be read is counted as unmeasured only.
 */

import { subtreeOf } from './reap-plan';
import type { ScannedProcess } from './process-scan';

export interface HostMemoryCensusRequest {
  /** Kangentic's own Electron processes, from `app.getAppMetrics()`. */
  electronPids: number[];
}

/** A sum of commit charge over some processes. */
export interface CensusSum {
  bytes: number;
  count: number;
}

/** The processes carrying one task tag that are under no live PTY. */
export interface CensusTaggedSum extends CensusSum {
  taskId: string;
  /** A PTY this host holds belongs to the task: the processes are beside its live session, not under it. */
  hasLiveSession: boolean;
}

export interface HostMemoryCensusResult {
  /** False off Windows, where no reader reads commit. */
  supported: boolean;
  /** The scan failed, so the sums say nothing. */
  failed: boolean;
  kangentic: CensusSum;
  livePty: CensusSum;
  /** Below Kangentic's Electron processes, under no live PTY. */
  kangenticChildren: CensusSum;
  tagged: CensusTaggedSum[];
  otherSameUser: CensusSum;
  /** Same-user processes whose commit could not be read. */
  unmeasuredCount: number;
}

/** A PTY root the host holds, and the task it belongs to (null for a raw probe PTY). */
export interface CensusLiveRoot {
  pid: number;
  taskId: string | null;
}

function emptySum(): CensusSum {
  return { bytes: 0, count: 0 };
}

export function emptyCensus(supported: boolean, failed: boolean): HostMemoryCensusResult {
  return { supported, failed, kangentic: emptySum(), livePty: emptySum(), kangenticChildren: emptySum(), tagged: [], otherSameUser: emptySum(), unmeasuredCount: 0 };
}

function add(sum: CensusSum, bytes: number): void {
  sum.bytes += bytes;
  sum.count += 1;
}

/** Sums a scan taken with `readCommit` into the census groups. Pure. */
export function sumCensus(
  processes: readonly ScannedProcess[],
  input: { electronPids: ReadonlySet<number>; liveRoots: readonly CensusLiveRoot[] },
): HostMemoryCensusResult {
  const result = emptyCensus(true, false);
  const byPid = new Map(processes.map((scanned) => [scanned.pid, scanned]));
  const underLivePty = new Set<number>();
  const liveTaskIds = new Set<string>();
  for (const root of input.liveRoots) {
    if (root.taskId) liveTaskIds.add(root.taskId);
    const rootProcess = byPid.get(root.pid);
    if (!rootProcess) continue;
    for (const scanned of subtreeOf(rootProcess, processes, input.electronPids)) underLivePty.add(scanned.pid);
  }
  // What Kangentic's own processes started outside any live PTY. The walk
  // never enters a live root, so a PTY's tree stays its own group.
  const liveRootPids = new Set(input.liveRoots.map((root) => root.pid));
  const belowKangentic = new Set<number>();
  for (const electronPid of input.electronPids) {
    const electronProcess = byPid.get(electronPid);
    if (!electronProcess) continue;
    for (const scanned of subtreeOf(electronProcess, processes, liveRootPids)) belowKangentic.add(scanned.pid);
  }
  const taggedSums = new Map<string, CensusTaggedSum>();
  for (const scanned of processes) {
    // Never opened for its environment: another user's, another session's, or a system process.
    if (scanned.commitBytes === undefined) continue;
    if (scanned.commitBytes === null) {
      result.unmeasuredCount += 1;
      continue;
    }
    const bytes = scanned.commitBytes;
    if (input.electronPids.has(scanned.pid)) {
      add(result.kangentic, bytes);
    } else if (underLivePty.has(scanned.pid)) {
      add(result.livePty, bytes);
    } else if (belowKangentic.has(scanned.pid)) {
      add(result.kangenticChildren, bytes);
    } else if (scanned.tagValue) {
      let sum = taggedSums.get(scanned.tagValue);
      if (!sum) {
        sum = { taskId: scanned.tagValue, hasLiveSession: liveTaskIds.has(scanned.tagValue), bytes: 0, count: 0 };
        taggedSums.set(scanned.tagValue, sum);
      }
      add(sum, bytes);
    } else {
      add(result.otherSameUser, bytes);
    }
  }
  result.tagged = [...taggedSums.values()];
  return result;
}
