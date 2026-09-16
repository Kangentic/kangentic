import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../config/board-config/atomic-write';
import { trackEvent } from '../analytics/analytics';

/**
 * Counts repeated GPU-process deaths within one app run and, once they cross
 * a threshold, persists an escalation record for the NEXT launch to report.
 *
 * Why not report live, the way UtilityRestartPolicy does for our own worker
 * processes (`src/main/utility-process/restart-policy.ts`): a GPU process
 * that keeps failing can end in `content::IntentionallyCrashBrowserForUnusableGpuProcess`
 * (Chromium's `LOG(FATAL)` when every fallback mode - hardware, software GL,
 * display compositor - has been tried and failed), which kills the whole
 * app synchronously. Sentry's transport is async, so a live report queued at
 * that moment never transmits - this is why a 90-day search turned up zero
 * `'GPU' process exited with 'launch-failed'` events despite the SDK
 * capturing that reason by default (see error-reporting.ts's GPU filter).
 * The record on disk is what survives; `readPendingGpuEscalation` /
 * `clearGpuEscalation` let the next boot report it once, the same way a
 * minidump itself arrives with `found_at_startup: true`.
 *
 * The threshold deliberately mirrors Chromium's own judgment of GPU health
 * (`kForgiveGpuCrashMinutes = 5`, 3 crashes triggers its own fallback to
 * software compositing - `gpu_data_manager_impl_private.cc`), so our latch
 * fires at the same point Chromium itself decides the GPU is unhealthy,
 * not on an arbitrarily different schedule.
 *
 * Telemetry follows the restart-policy precedent: `gpu_process_gone` ticks
 * Aptabase on the FIRST death and again when the latch fires (never once
 * per death), because an unbounded per-crash count is exactly what made
 * three utility-process crashes read as "71 crashes a day" before that
 * policy existed - a crash-looping GPU would reproduce the same inflation.
 * That cap is Aptabase-only: the durable ESCALATION RECORD is not a
 * write-once artifact the way the Sentry report and the Aptabase tick are.
 * It keeps updating (count, lastAt, GPU mode) on every further death in the
 * same window, because a report that always reads `count: 3` cannot tell a
 * run that latched once and ended (DESKTOP-W) from one that kept dying for
 * an hour - the two shapes this module exists to distinguish.
 */

export interface GpuHealthOptions {
  /** Deaths within the decay window before an escalation is written. */
  maxCrashes?: number;
  /** Quiet period after which the crash count resets. */
  decayMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Reads Chromium's current GPU mode at the moment of THIS death (Electron's
   *  `app.getGPUFeatureStatus()`, via the caller - this module stays
   *  Electron-free). Only read once an escalation is about to be written, not
   *  on every death, so the two calls before a latch cost nothing. Omitted in
   *  most tests; defaults to an empty record. */
  getFeatureStatus?: () => Record<string, string>;
}

/** Matches Chromium's own 3-crashes-in-5-minutes judgment (see module doc). */
const DEFAULT_MAX_CRASHES = 3;
const DEFAULT_DECAY_MS = 5 * 60_000;

/** The durable record, updated on every death once latched. Bounded to a
 *  single latest escalation, never a growing list - a later, separate
 *  incident in the same run (after a decay reset) overwrites it. */
export interface GpuEscalationRecord {
  reason: string;
  exitCode: number | null;
  /** Total deaths counted in the window that produced this record, kept
   *  current across every write - NOT frozen at the cap. A record written
   *  once at latch and never touched again would read `count: 3` whether the
   *  run ended right there (DESKTOP-W's shape) or kept dying dozens of times,
   *  which defeats the reason this field exists. */
  count: number;
  firstAt: string;
  lastAt: string;
  appVersion: string;
  /** Chromium's GPU mode at the moment of the death that produced this write
   *  (`app.getGPUFeatureStatus()`). This is the ESCALATING run's state, not
   *  the reporting run's - the boot that reads and reports this record may
   *  have come up on working hardware GL. Read alongside a live
   *  `getGPUFeatureStatus()` call at report time, never in place of one. */
  featureStatus: Record<string, string>;
}

type CrashPhase = 'first' | 'latched';

let crashCount = 0;
let firstCrashAt: number | null = null;
let lastCrashAt: number | null = null;
/** Per-run Aptabase phase gate, mirroring restart-policy.ts's
 *  `trackedCrashPhases` (there keyed by service; GPU has only one). This
 *  Set alone is what holds the telemetry to two ticks per run: it is NOT
 *  cleared by a decay reset, so a second escalation later in the same run
 *  updates the record without ticking Aptabase again. It does not gate the
 *  escalation WRITE, which keeps updating on every death after the latch
 *  (see GpuEscalationRecord.count). */
const trackedPhases = new Set<CrashPhase>();

/** Forget all module state (vitest shares module instances). */
export function resetGpuHealthForTests(): void {
  crashCount = 0;
  firstCrashAt = null;
  lastCrashAt = null;
  trackedPhases.clear();
}

function decayIfQuiet(nowMs: number, decayMs: number): void {
  if (crashCount === 0 || lastCrashAt === null) return;
  if (nowMs - lastCrashAt < decayMs) return;
  crashCount = 0;
  firstCrashAt = null;
  lastCrashAt = null;
}

function trackPhaseOnce(phase: CrashPhase, reason: string, exitCode: number | null): void {
  if (trackedPhases.has(phase)) return;
  trackedPhases.add(phase);
  trackEvent('gpu_process_gone', { reason, exitCode: exitCode ?? -1, phase });
}

/** Never throws. Mirrors run-uptime.ts's writeRun: an unwritable config dir
 *  costs this one escalation, nothing more. mkdir first, matching
 *  crash-capture.ts's writeRecord, so a fresh install (configDir not yet
 *  created) does not silently drop the very first escalation. */
function writeEscalation(filePath: string, record: GpuEscalationRecord): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    return;
  }
  try {
    atomicWriteJson(filePath, record);
  } catch {
    try {
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n');
    } catch {
      // Unwritable config dir: give up on this escalation.
    }
  }
}

/**
 * Record a GPU child-process-gone death. Callers filter to non-`clean-exit`
 * GPU events before calling this (crash-capture.ts already does, for the
 * local crash-record write this complements).
 *
 * Counts in-memory. The durable write starts the moment the count first
 * reaches `maxCrashes` within the decay window, and keeps updating - with
 * the CURRENT count, lastAt, and GPU mode - on every further death in the
 * same window, so a chronic looper's record does not read identically to a
 * run that latched once and ended.
 */
export function recordGpuProcessGone(
  filePath: string,
  reason: string,
  exitCode: number | null | undefined,
  appVersion: string,
  options: GpuHealthOptions = {},
): void {
  const maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;
  const decayMs = options.decayMs ?? DEFAULT_DECAY_MS;
  const now = options.now ?? Date.now;
  const nowMs = now();
  const normalizedExitCode = exitCode ?? null;

  decayIfQuiet(nowMs, decayMs);

  crashCount += 1;
  if (firstCrashAt === null) firstCrashAt = nowMs;
  lastCrashAt = nowMs;

  trackPhaseOnce('first', reason, normalizedExitCode);

  if (crashCount >= maxCrashes) {
    trackPhaseOnce('latched', reason, normalizedExitCode);
    writeEscalation(filePath, {
      reason,
      exitCode: normalizedExitCode,
      count: crashCount,
      firstAt: new Date(firstCrashAt).toISOString(),
      lastAt: new Date(nowMs).toISOString(),
      appVersion,
      featureStatus: options.getFeatureStatus?.() ?? {},
    });
  }
}

/** A missing file, a pre-upgrade config dir, or a corrupt record all read as
 *  "nothing pending" - the same stance `run-uptime.ts`'s `readPreviousRun`
 *  takes for the same reasons. `featureStatus` tolerates a missing or
 *  wrong-shaped value as `{}` rather than invalidating the whole record: it
 *  is context, not the fact that matters (a repeated GPU death happened). */
export function readPendingGpuEscalation(filePath: string): GpuEscalationRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<GpuEscalationRecord> | null;
    if (
      typeof parsed?.reason !== 'string' ||
      typeof parsed?.count !== 'number' ||
      !Number.isFinite(parsed.count) ||
      typeof parsed?.firstAt !== 'string' ||
      typeof parsed?.lastAt !== 'string' ||
      typeof parsed?.appVersion !== 'string'
    ) {
      return null;
    }
    const featureStatus =
      parsed.featureStatus && typeof parsed.featureStatus === 'object' && !Array.isArray(parsed.featureStatus)
        ? (parsed.featureStatus as Record<string, string>)
        : {};
    return {
      reason: parsed.reason,
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
      count: parsed.count,
      firstAt: parsed.firstAt,
      lastAt: parsed.lastAt,
      appVersion: parsed.appVersion,
      featureStatus,
    };
  } catch {
    return null;
  }
}

/** Best-effort. Called after an escalation has been reported, so it fires
 *  once rather than on every subsequent launch. A missing file is not an
 *  error - there was nothing pending to clear. */
export function clearGpuEscalation(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Missing, or unwritable: nothing more to do either way.
  }
}
