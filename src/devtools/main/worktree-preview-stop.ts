/**
 * Dev-only: stop every `/preview` running in a task's worktree before the
 * task's leftover reap, through the launcher's own stop file.
 *
 * A preview is `wt.exe` (or Terminal.app, or a Linux terminal) running
 * `node scripts/dev.js`, which runs Vite and a preview Electron. When the task
 * reached Done with one running, the reap had two bad outcomes. Kept, its
 * worktree was removed underneath it (the node_modules junction first, so Vite
 * failed). Killed, it got a hard terminate on Windows, so `dev.js` never ran
 * its stop path, and its Electron, which owns a window and is kept as a visible
 * app, sat on a dead Vite and held the worktree. On macOS and Linux the tag
 * probably never reaches a preview at all, since Terminal.app and the Linux
 * terminals start the command from their own process (not measured).
 *
 * The stop file is what `node scripts/worktree-preview.js --stop` writes:
 * `dev.js` polls for `<worktree>/.kangentic/preview-<port>.stop` every 500 ms,
 * writes `preview-<port>.stopping` at once, asks Electron to quit through its
 * real quit path (bounded at 8 s), runs its ephemeral cleanup (skipped when
 * the stop file says `worktree-removal`, see below) and exits 0, and the
 * terminal tab closes itself. The file names are pinned against the scripts
 * by `tests/unit/worktree-preview-stop.test.ts`, since main cannot require them.
 *
 * A pid file outlives a hard-killed `dev.js`, and Windows reuses pids quickly,
 * so a live pid proves nothing on its own. A `dev.js` killed mid-stop leaves
 * its stopping marker behind too, so a marker older than the bound counts as
 * none. A preview that has not written its stopping marker within the
 * acknowledgement window is left to the reap. So is one still running at the
 * bound, which leaves no window behind: `dev.js`
 * kills its Electron itself once the graceful quit's 8 s are up, before the
 * slow part of its cleanup (deleting the clones in place when a held handle
 * refused the rename), so at 15 s only `dev.js` and its shell remain to reap.
 *
 * `dev.js` exiting is not the preview being gone. Measured on Windows, the reap
 * scanned 40 ms after `dev.js`'s pid stopped answering and found the tab's
 * `cmd` still running, with `dev.js` still listed under it while it finished
 * terminating and, under that, the detached deleter `dev.js` starts
 * on its way out to delete the clones it moved into `.kangentic/trash-*`. The
 * deleter carries the task's tag and works in the temp folder, so the reap read
 * the tab's `cmd` as shared and reported it as still running, and the
 * deleter's open files failed the worktree removal that followed. So the stop
 * file says why it was written (`PREVIEW_STOP_FOR_WORKTREE_REMOVAL`): the
 * worktree goes next, and `dev.js` deletes nothing on its way out. And once
 * `dev.js` has exited, the stop waits, up to `PREVIEW_TREE_EXIT_BOUND_MS`, for
 * the rest of the tree it recorded before asking: the tab's `cmd` and
 * whatever `dev.js` started, adopting a child that appears during the quit.
 * That wait reads the pty host's process listing (pid, parent, name; no
 * process is opened), passed in as `listProcesses`.
 *
 * Three cases this leaves as they are, each bounded. A preview already
 * stopping when the reap asks (a closed window, an earlier `--stop`) is not
 * sent the reason, since `dev.js` read its stop file or started its cleanup
 * already, so it may still start its deleter, which the tree wait then covers
 * for its bound alone. An unarchive into To Do keeps the worktree yet sends
 * the same reason, so that worktree keeps its preview data until the next
 * preview there clears it at boot, as after a failed removal. And a `cmd`
 * above `dev.js` that is not the launcher's (a shell that ran it by hand)
 * never exits, which costs the stop the tree bound and nothing more: the stop
 * only waits.
 *
 * Never throws. Build-excluded from production: called only behind
 * `__KANGENTIC_DEV__` (`reapTaskLeftovers` in `src/main/ipc/helpers/task-cleanup.ts`).
 * See `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from '../../main/shared/process-liveness';
import type { HostProcessInfo } from '../../main/pty/host/protocol';

/** `dev.js` polls every 500 ms and writes the marker in the same tick, so three polls. */
export const PREVIEW_ACKNOWLEDGE_MS = 1500;
/** `dev.js`'s own 8 s graceful-quit bound, its cleanup, and room for a loaded machine. */
export const PREVIEW_STOP_BOUND_MS = 15_000;
/**
 * How long the rest of the preview's tree gets to exit after `dev.js` has. The
 * tab's `cmd` outlived `dev.js` by about 110 ms when measured; this is many
 * times that, and short enough that a process which never exits (a deleter
 * from a `dev.js` that predates the stop reason) costs one Done two seconds.
 */
export const PREVIEW_TREE_EXIT_BOUND_MS = 2000;
/**
 * What the stop file holds when a task's leftover reap asks: the worktree is
 * removed next, so `dev.js` skips its ephemeral cleanup (the trash move and the
 * detached deleter). `node scripts/worktree-preview.js --stop` writes a
 * timestamp, which keeps that cleanup. `dev.js` reads it through
 * `isWorktreeRemovalStop` in `scripts/preview-isolation.js`, and
 * `tests/unit/worktree-preview-stop.test.ts` pins the two constants equal.
 */
export const PREVIEW_STOP_FOR_WORKTREE_REMOVAL = 'worktree-removal';
const POLL_INTERVAL_MS = 100;
const TREE_POLL_INTERVAL_MS = 50;
/** The Windows launcher's shell: both of its terminals run `cmd /c <dev.js command>`. */
const LAUNCHER_SHELL_NAME = 'cmd';

/** One row of the pty host's process listing: lowercase name, no `.exe` on Windows. */
export type PreviewProcessRow = HostProcessInfo;

export function previewPidFilePath(worktreePath: string, port: number): string {
  return path.join(worktreePath, '.kangentic', `preview-${port}.pid`);
}

export function previewStopFilePath(worktreePath: string, port: number): string {
  return path.join(worktreePath, '.kangentic', `preview-${port}.stop`);
}

export function previewStoppingMarkerPath(worktreePath: string, port: number): string {
  return path.join(worktreePath, '.kangentic', `preview-${port}.stopping`);
}

/**
 * `stopped`: the preview's `dev.js` exited. `unacknowledged`: it never wrote
 * its stopping marker, so the pid file was stale or the stop file could not be
 * written. `timed-out`: it acknowledged and was still running at the bound.
 */
export type PreviewStopOutcome = 'stopped' | 'unacknowledged' | 'timed-out';

export interface PreviewStopResult {
  worktreePath: string;
  port: number;
  pid: number;
  outcome: PreviewStopOutcome;
  elapsedMs: number;
  /**
   * How the rest of the tree went, for a `stopped` preview with a listing:
   * `gone` within the tree bound, or `listed` at the bound with what was
   * left. Null when there was no tree to wait for or no listing to read.
   */
  tree: { outcome: 'gone'; elapsedMs: number } | { outcome: 'listed'; elapsedMs: number; leftovers: string[] } | null;
}

export interface PreviewStopOptions {
  isProcessAlive?: (pid: number) => boolean;
  acknowledgeMs?: number;
  boundMs?: number;
  /** The pty host's process listing. Without it, the stop ends when `dev.js` does. */
  listProcesses?: () => Promise<PreviewProcessRow[]>;
  treeBoundMs?: number;
}

type ResolvedStopOptions = Required<Omit<PreviewStopOptions, 'listProcesses'>> & Pick<PreviewStopOptions, 'listProcesses'>;

interface RunningPreview {
  worktreePath: string;
  port: number;
  pid: number;
}

/** A listed process, as a name the listing must still give that pid for it to count as the same one. */
type TrackedTree = Map<number, string>;

/** A listing, or null when none could be read: [] is "no table", never "everything exited". */
async function listOrNull(listProcesses: () => Promise<PreviewProcessRow[]>): Promise<PreviewProcessRow[] | null> {
  try {
    const rows = await listProcesses();
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Add every listed child of a tracked process, and theirs, to `tree`. A child
 * counts when its parent is no longer listed (an orphan on Windows keeps its
 * dead parent's pid) or is listed under the name it was tracked with; a
 * different name means the pid was reused.
 */
function adoptChildren(tree: TrackedTree, rows: readonly PreviewProcessRow[]): void {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (tree.has(row.pid) || row.pid === row.ppid) continue;
      const trackedParentName = tree.get(row.ppid);
      if (trackedParentName === undefined) continue;
      const listedParent = byPid.get(row.ppid);
      if (listedParent && listedParent.comm !== trackedParentName) continue;
      tree.set(row.pid, row.comm);
      grew = true;
    }
  }
}

/** Never wait on this process or its parent, whatever the listing links them to. */
function forgetOwnProcesses(tree: TrackedTree): void {
  tree.delete(process.pid);
  tree.delete(process.ppid);
}

/**
 * The preview's tree before it is asked to stop: `dev.js`, everything under
 * it, and the launcher's `cmd` above it. Never this process or its parent.
 */
function previewTreeOf(devPid: number, rows: readonly PreviewProcessRow[]): TrackedTree {
  const tree: TrackedTree = new Map();
  const devScriptRow = rows.find((row) => row.pid === devPid);
  if (!devScriptRow) return tree;
  tree.set(devScriptRow.pid, devScriptRow.comm);
  const parent = rows.find((row) => row.pid === devScriptRow.ppid);
  if (parent && parent.comm === LAUNCHER_SHELL_NAME) tree.set(parent.pid, parent.comm);
  adoptChildren(tree, rows);
  forgetOwnProcesses(tree);
  return tree;
}

/** Wait, up to the tree bound, until nothing tracked is listed under its name. */
async function waitForTree(
  tree: TrackedTree,
  listProcesses: () => Promise<PreviewProcessRow[]>,
  treeBoundMs: number,
): Promise<PreviewStopResult['tree']> {
  const startedAt = Date.now();
  for (;;) {
    const rows = await listOrNull(listProcesses);
    if (!rows) return null;
    adoptChildren(tree, rows);
    forgetOwnProcesses(tree);
    const remaining = rows.filter((row) => tree.get(row.pid) === row.comm);
    const elapsedMs = Date.now() - startedAt;
    if (remaining.length === 0) return { outcome: 'gone', elapsedMs };
    if (elapsedMs >= treeBoundMs) {
      return { outcome: 'listed', elapsedMs, leftovers: remaining.map((row) => `${row.comm} ${row.pid}`) };
    }
    await sleep(TREE_POLL_INTERVAL_MS);
  }
}

/**
 * Write the stop file whole, so `dev.js`, which polls for it, never reads it
 * empty and misses why it was asked. Throws when it cannot be written.
 */
async function writeStopFile(stopPath: string): Promise<void> {
  const temporaryPath = `${stopPath}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, PREVIEW_STOP_FOR_WORKTREE_REMOVAL);
    await fs.promises.rename(temporaryPath, stopPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** A stopping marker written within the bound, which a stale one never is (see the header). */
async function hasFreshMarker(markerPath: string, boundMs: number): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(markerPath);
    return Date.now() - stats.mtimeMs < boundMs;
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The previews whose pid file names a live process other than this one or its own `dev.js`. */
async function findRunningPreviews(worktreePath: string, alive: (pid: number) => boolean): Promise<RunningPreview[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(path.join(worktreePath, '.kangentic'));
  } catch {
    return [];
  }
  const previews: RunningPreview[] = [];
  for (const entry of entries) {
    const match = /^preview-(\d+)\.pid$/.exec(entry);
    if (!match) continue;
    const port = Number.parseInt(match[1], 10);
    let pid: number;
    try {
      pid = Number.parseInt((await fs.promises.readFile(previewPidFilePath(worktreePath, port), 'utf-8')).trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || pid === process.ppid || !alive(pid)) continue;
    previews.push({ worktreePath, port, pid });
  }
  return previews;
}

async function stopPreview(preview: RunningPreview, options: ResolvedStopOptions): Promise<PreviewStopResult> {
  const startedAt = Date.now();
  const markerPath = previewStoppingMarkerPath(preview.worktreePath, preview.port);
  const result = (
    outcome: PreviewStopOutcome,
    tree: PreviewStopResult['tree'] = null,
    elapsedMs: number = Date.now() - startedAt,
  ): PreviewStopResult => ({ ...preview, outcome, elapsedMs, tree });
  // Recorded while `dev.js` still runs: once it has exited, nothing links the
  // tab's shell to what it started.
  const listProcesses = options.listProcesses;
  const initialRows = listProcesses ? await listOrNull(listProcesses) : null;
  const tree: TrackedTree = initialRows ? previewTreeOf(preview.pid, initialRows) : new Map();
  // Already stopping (a closed window, an earlier --stop): only the exit to wait for.
  let acknowledged = await hasFreshMarker(markerPath, options.boundMs);
  if (!acknowledged) {
    try {
      await writeStopFile(previewStopFilePath(preview.worktreePath, preview.port));
    } catch {
      return result('unacknowledged');
    }
  }
  for (;;) {
    if (!options.isProcessAlive(preview.pid)) {
      if (!listProcesses || tree.size === 0) return result('stopped');
      const devStoppedAfterMs = Date.now() - startedAt;
      const treeResult = await waitForTree(tree, listProcesses, options.treeBoundMs);
      return result('stopped', treeResult, devStoppedAfterMs);
    }
    const elapsedMs = Date.now() - startedAt;
    if (!acknowledged) acknowledged = await hasFreshMarker(markerPath, options.boundMs);
    if (!acknowledged && elapsedMs >= options.acknowledgeMs) return result('unacknowledged');
    if (elapsedMs >= options.boundMs) return result('timed-out');
    await sleep(POLL_INTERVAL_MS);
  }
}

/** The log's tail for the tree wait: names and pids only, as the listing gives them. */
function describeTree(tree: PreviewStopResult['tree']): string {
  if (!tree) return '';
  if (tree.outcome === 'gone') return `; the rest of its tree exited ${tree.elapsedMs} ms later`;
  return `; still listed ${tree.elapsedMs} ms later: ${tree.leftovers.join(', ')}`;
}

/**
 * Stop every preview running in `worktreePaths`, all at once, and resolve once
 * each has exited, stayed silent past the acknowledgement window, or reached
 * the bound. Pass task worktrees only: `dev.js` writes its pid file into
 * whatever directory it runs from, the main checkout under `npm start` included.
 */
export async function stopWorktreePreviews(
  worktreePaths: readonly string[],
  options: PreviewStopOptions = {},
): Promise<PreviewStopResult[]> {
  const resolved: ResolvedStopOptions = {
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    acknowledgeMs: options.acknowledgeMs ?? PREVIEW_ACKNOWLEDGE_MS,
    boundMs: options.boundMs ?? PREVIEW_STOP_BOUND_MS,
    listProcesses: options.listProcesses,
    treeBoundMs: options.treeBoundMs ?? PREVIEW_TREE_EXIT_BOUND_MS,
  };
  try {
    const previews = (await Promise.all(worktreePaths.map((worktreePath) => findRunningPreviews(worktreePath, resolved.isProcessAlive)))).flat();
    const results = await Promise.all(previews.map((preview) => stopPreview(preview, resolved)));
    for (const stopResult of results) {
      console.log(`[PREVIEW-STOP] Preview on port ${stopResult.port} (pid ${stopResult.pid}) in ${path.basename(stopResult.worktreePath)}: ${stopResult.outcome} after ${stopResult.elapsedMs} ms${describeTree(stopResult.tree)}`);
    }
    return results;
  } catch (error) {
    console.warn('[PREVIEW-STOP] Stopping worktree previews failed (non-fatal):', error);
    return [];
  }
}
