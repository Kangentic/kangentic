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
 * real quit path (bounded at 8 s), runs its ephemeral cleanup and exits 0, and
 * the terminal tab closes itself. The file names are pinned against the scripts
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
 * Never throws. Build-excluded from production: called only behind
 * `__KANGENTIC_DEV__` (`reapTaskLeftovers` in `src/main/ipc/helpers/task-cleanup.ts`).
 * See `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from '../../main/shared/process-liveness';

/** `dev.js` polls every 500 ms and writes the marker in the same tick, so three polls. */
export const PREVIEW_ACKNOWLEDGE_MS = 1500;
/** `dev.js`'s own 8 s graceful-quit bound, its cleanup, and room for a loaded machine. */
export const PREVIEW_STOP_BOUND_MS = 15_000;
const POLL_INTERVAL_MS = 100;

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
}

export interface PreviewStopOptions {
  isProcessAlive?: (pid: number) => boolean;
  acknowledgeMs?: number;
  boundMs?: number;
}

interface RunningPreview {
  worktreePath: string;
  port: number;
  pid: number;
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

async function stopPreview(preview: RunningPreview, options: Required<PreviewStopOptions>): Promise<PreviewStopResult> {
  const startedAt = Date.now();
  const markerPath = previewStoppingMarkerPath(preview.worktreePath, preview.port);
  const result = (outcome: PreviewStopOutcome): PreviewStopResult => ({ ...preview, outcome, elapsedMs: Date.now() - startedAt });
  // Already stopping (a closed window, an earlier --stop): only the exit to wait for.
  let acknowledged = await hasFreshMarker(markerPath, options.boundMs);
  if (!acknowledged) {
    try {
      await fs.promises.writeFile(previewStopFilePath(preview.worktreePath, preview.port), String(Date.now()));
    } catch {
      return result('unacknowledged');
    }
  }
  for (;;) {
    if (!options.isProcessAlive(preview.pid)) return result('stopped');
    const elapsedMs = Date.now() - startedAt;
    if (!acknowledged) acknowledged = await hasFreshMarker(markerPath, options.boundMs);
    if (!acknowledged && elapsedMs >= options.acknowledgeMs) return result('unacknowledged');
    if (elapsedMs >= options.boundMs) return result('timed-out');
    await sleep(POLL_INTERVAL_MS);
  }
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
  const resolved: Required<PreviewStopOptions> = {
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    acknowledgeMs: options.acknowledgeMs ?? PREVIEW_ACKNOWLEDGE_MS,
    boundMs: options.boundMs ?? PREVIEW_STOP_BOUND_MS,
  };
  try {
    const previews = (await Promise.all(worktreePaths.map((worktreePath) => findRunningPreviews(worktreePath, resolved.isProcessAlive)))).flat();
    const results = await Promise.all(previews.map((preview) => stopPreview(preview, resolved)));
    for (const stopResult of results) {
      console.log(`[PREVIEW-STOP] Preview on port ${stopResult.port} (pid ${stopResult.pid}) in ${path.basename(stopResult.worktreePath)}: ${stopResult.outcome} after ${stopResult.elapsedMs} ms`);
    }
    return results;
  } catch (error) {
    console.warn('[PREVIEW-STOP] Stopping worktree previews failed (non-fatal):', error);
    return [];
  }
}
