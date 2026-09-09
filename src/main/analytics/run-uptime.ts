import fs from 'node:fs';
import { atomicWriteJson } from '../config/board-config/atomic-write';

/**
 * Run-duration reporting for the app_launch event.
 *
 * A closing event cannot be delivered from the quit path. Every shutdown entry
 * point runs synchronous cleanup and exits before the SDK's one-POST-per-event
 * request can complete, and .claude/rules/synchronous-shutdown.md forbids
 * holding the quit for a network call, so `app_close` was fired on every quit
 * and landed on none of them. Instead the run's uptime is checkpointed to disk
 * while the app runs and reported on the NEXT launch as properties of
 * app_launch. That is delivery-proof by construction: it survives a hard
 * kill, an OS shutdown, a power loss, and a crash, which are exactly the
 * endings a close event could never report.
 *
 * Why its own file rather than analytics-usage.json (the lifetime flags):
 *
 * - The checkpoint rewrites the file once a minute. A truncate-then-write torn
 *   by a power loss would blank the LIFETIME flags and re-fire every
 *   onboarding_milestone and feature_first_use, so the run record lives in its
 *   own file and is written atomically (tmp + rename).
 * - Every write here is synchronous. The lifetime flags use an async write
 *   chain, which cannot be ordered against the synchronous quit-path write: a
 *   checkpoint already in the thread pool when the user quits would land last
 *   and mislabel a clean quit as abrupt. Sync main-thread writes are strictly
 *   ordered, so the exit write is always the last one. The record is about
 *   120 bytes, well under a millisecond to write.
 *
 * What counts as which exit:
 *
 * - `clean`: performShutdown ran (window close, Cmd+Q, Ctrl+C, SIGTERM, an OS
 *   shutdown or log-off that reached the app, an update install).
 * - `failsafe`: performShutdown ran but Electron's teardown hung and the hard
 *   failsafe force-killed the process tree. Before this, that ending was
 *   visible only in the project log.
 * - `abrupt`: no exit was recorded (a crash, a kill, a power loss).
 *
 * Uptime is wall-clock and includes time asleep, as the old app_close
 * durationSeconds did. This module deliberately imports nothing from
 * analytics.ts: it returns properties and index.ts attaches them, so the
 * quit path touches disk only.
 */

/** How often the running uptime is checkpointed. One minute: the report is
 *  bucketed at minute granularity, so a finer cadence buys nothing. */
export const RUN_UPTIME_CHECKPOINT_INTERVAL_MS = 60_000;

export type RunExit = 'clean' | 'failsafe' | 'abrupt';

/** The on-disk shape. `exit` is null until the quit path records one. */
interface RunRecord {
  uptimeSeconds: number;
  exit: 'clean' | 'failsafe' | null;
}

interface PreviousRun {
  uptimeSeconds: number;
  exit: RunExit;
}

let runFilePath: string | null = null;
let runStartedAt: number | null = null;
let exitRecorded = false;
let previousRun: PreviousRun | null = null;

/** A previous run is only one whose record carries a finite uptime. A missing
 *  file (first run), a pre-upgrade config dir, or a corrupt record all read as
 *  "no previous run" and app_launch simply omits the properties. */
function readPreviousRun(filePath: string): PreviousRun | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<RunRecord> | null;
    const uptimeSeconds = parsed?.uptimeSeconds;
    if (typeof uptimeSeconds !== 'number' || !Number.isFinite(uptimeSeconds)) return null;
    const exit = parsed?.exit === 'clean' || parsed?.exit === 'failsafe' ? parsed.exit : 'abrupt';
    return { uptimeSeconds, exit };
  } catch {
    return null;
  }
}

/** Never throws. The exit write runs inside performShutdown BEFORE the
 *  synchronous cleanup that kills the PTYs, so a throw here (ENOSPC, an AV
 *  refusing the rename) would skip the kill and hang teardown until the hard
 *  failsafe. A run record that cannot be written costs one launch's duration,
 *  nothing more. */
function writeRun(record: RunRecord): void {
  if (!runFilePath) return;
  try {
    atomicWriteJson(runFilePath, record);
  } catch {
    try {
      fs.writeFileSync(runFilePath, JSON.stringify(record, null, 2) + '\n');
    } catch {
      // Unwritable config dir: give up on this run's record.
    }
  }
}

function elapsedSeconds(nowMs: number): number {
  if (runStartedAt === null) return 0;
  return Math.max(0, Math.round((nowMs - runStartedAt) / 1000));
}

/**
 * Read the previous run's record, then start this run's. Called once at
 * startup from index.ts with a path under the global config dir. Sync read
 * and write, matching the other startup config reads.
 */
export function initRunUptimeTracking(filePath: string, startedAtMs: number): void {
  previousRun = readPreviousRun(filePath);
  runFilePath = filePath;
  runStartedAt = startedAtMs;
  exitRecorded = false;
  writeRun({ uptimeSeconds: 0, exit: null });
}

/**
 * Checkpoint the running uptime. A no-op before init and after an exit has
 * been recorded, so a tick that fires during teardown cannot overwrite the
 * exit record with an open one.
 */
export function checkpointRunUptime(nowMs: number = Date.now()): void {
  if (runStartedAt === null || exitRecorded) return;
  writeRun({ uptimeSeconds: elapsedSeconds(nowMs), exit: null });
}

/**
 * Record how this run ended. `clean` is written by performShutdown; `failsafe`
 * by the hard-failsafe timer, which fires after `clean` and overwrites it,
 * since a quit that had to be force-killed did not end cleanly. Synchronous
 * disk write only, never a network call (synchronous-shutdown.md rule 3).
 */
export function recordRunExit(kind: 'clean' | 'failsafe', nowMs: number = Date.now()): void {
  if (runStartedAt === null) return;
  exitRecorded = true;
  writeRun({ uptimeSeconds: elapsedSeconds(nowMs), exit: kind });
}

/**
 * The previous run's properties for app_launch, or `{}` on a first run. The
 * raw seconds are kept beside the bucket because Aptabase aggregates numeric
 * properties (average, min, max), which is what replaces the dashboard's own
 * Avg. Duration now that no close event lands; the bucket gives the breakdown
 * table.
 */
export function previousRunLaunchProps(): Record<string, string | number> {
  if (!previousRun) return {};
  return {
    lastRunUptimeSeconds: previousRun.uptimeSeconds,
    lastRunUptime: bucketUptimeSeconds(previousRun.uptimeSeconds),
    lastRunExit: previousRun.exit,
  };
}

/** Bucket a run's uptime so the dashboard reads as a distribution. */
export function bucketUptimeSeconds(seconds: number): string {
  if (seconds < 60) return '<1m';
  if (seconds < 5 * 60) return '1-5m';
  if (seconds < 30 * 60) return '5-30m';
  if (seconds < 2 * 3600) return '30m-2h';
  if (seconds < 8 * 3600) return '2-8h';
  return '8h+';
}

/** Reset module state between unit tests (vitest shares module instances). */
export function resetRunUptimeForTests(): void {
  runFilePath = null;
  runStartedAt = null;
  exitRecorded = false;
  previousRun = null;
}
