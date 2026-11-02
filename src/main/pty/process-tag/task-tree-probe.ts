/**
 * What a task still has running, and whether anything outside it is using that,
 * decided from one scan and signalling nothing. Pure, like `reap-plan.ts`. A
 * project's Stop script runs on these answers (`src/main/stop-script/`).
 *
 * Two questions that want two different sets of processes:
 *
 * - **Running** gates the script. A process counts when it carries the task's
 *   tag, works inside the task's folders, has not exited, and is not protected
 *   (`buildProtectedPids`: Kangentic's tree, a held PTY, a visible app, a tmux
 *   server, each with everything under them). A task that left only those has
 *   nothing for a Stop script to stop.
 *
 * - **Tree** decides who is a client. It is every process carrying the tag,
 *   wherever it works, plus everything under them. The folder must not narrow
 *   it: a stack's own dashboard can carry the tag and work in a package cache,
 *   and a folder filter would make it an outside client of its own stack, which
 *   would hold the stop off for good.
 *
 * A client here is anything outside the tree, which is wider than the reap's
 * evidence on purpose. At Done an untagged client is no evidence by decision,
 * since a dev server open in a tab must still stop. On a pause the same tab is
 * someone using the stack. Kangentic's own processes count for the same reason:
 * the network service behind a Browser pane is a person looking at the page.
 */

import {
  buildProtectedPids,
  isInsideDirectory,
  type ReapPlanInput,
  type ReapTaskScope,
} from './reap-plan';
import { seedsAndDescendants, type LocalConnectionRead, type ScannedProcess } from './process-scan';

export type TaskTreeProbeInput = Pick<ReapPlanInput, 'processes' | 'mainPid' | 'liveRootPids' | 'caseInsensitivePaths'>;

/** The pids nothing here reads as the task's: `buildProtectedPids` over this scan. */
export function protectedPidsOfProbe(input: TaskTreeProbeInput): Set<number> {
  return buildProtectedPids(input);
}

/** What the task still has running in its folders, in scan order. */
export function runningInTaskFolders(
  input: TaskTreeProbeInput,
  protectedPids: ReadonlySet<number>,
  taskId: string,
  scope: ReapTaskScope,
): ScannedProcess[] {
  const caseInsensitive = input.caseInsensitivePaths ?? true;
  return input.processes.filter((scanned) => {
    if (scanned.tagValue !== taskId || scanned.exited || protectedPids.has(scanned.pid)) return false;
    const directory = scanned.workingDirectory;
    if (!directory) return false;
    return scope.directories.some((root) => isInsideDirectory(directory, root, caseInsensitive));
  });
}

/** The top of each running subtree: what a message names, so one server is one name. */
export function topOfRunning(running: readonly ScannedProcess[]): ScannedProcess[] {
  const runningPids = new Set(running.map((scanned) => scanned.pid));
  return running.filter((scanned) => !runningPids.has(scanned.ppid) || scanned.ppid === scanned.pid);
}

/** The task's tree and the rest of the machine, as the connection read wants them. */
export function treeConnectionQueryOf(
  input: TaskTreeProbeInput,
  protectedPids: ReadonlySet<number>,
  taskId: string,
): { treePids: Set<number>; listeners: ScannedProcess[]; clients: ScannedProcess[] } {
  const reached = seedsAndDescendants(input.processes, (scanned) => scanned.tagValue === taskId && !protectedPids.has(scanned.pid));
  const listeners = [...reached].filter((scanned) => !protectedPids.has(scanned.pid));
  const treePids = new Set(listeners.map((scanned) => scanned.pid));
  const clients = input.processes.filter((scanned) => !treePids.has(scanned.pid) && !scanned.exited);
  return { treePids, listeners, clients };
}

/** Whether something outside the tree holds a connection to a port the tree listens on. */
export function hasOutsideClient(read: LocalConnectionRead, treePids: ReadonlySet<number>): boolean {
  return read.pairs.some((pair) => treePids.has(pair.listenerPid) && !treePids.has(pair.clientPid));
}
