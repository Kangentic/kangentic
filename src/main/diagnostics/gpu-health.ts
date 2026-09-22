import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../config/board-config/atomic-write';
import { trackEvent } from '../analytics/analytics';

/**
 * Records GPU-process deaths within one app run and persists them for the
 * NEXT launch to report.
 *
 * Why not report live, the way UtilityRestartPolicy does for our own worker
 * processes (`src/main/utility-process/restart-policy.ts`): a GPU process
 * that keeps failing can end in `content::IntentionallyCrashBrowserForUnusableGpuProcess`
 * (Chromium's `LOG(FATAL)` when every fallback mode - hardware, software GL,
 * display compositor - has been tried and failed), which kills the whole
 * app synchronously. Sentry's transport is async, so a live report queued at
 * that moment never transmits. The record on disk is what survives;
 * `readPendingGpuEscalation` / `clearGpuEscalation` let the next boot report
 * it once, the same way a minidump itself arrives with `found_at_startup`.
 *
 * WHY EVERY DEATH WRITES, not only a latch at 3. The threshold used to gate
 * the write, mirroring Chromium's own 3-crashes-in-5-minutes judgment. Two
 * things made that wrong:
 *
 *   1. The killing death probably never reaches JS at all. Chromium calls
 *      `GpuProcessHost::RecordProcessCrash` (and therefore the LOG(FATAL))
 *      from the delegate, BEFORE the observer notification Electron emits
 *      `child-process-gone` from. So whatever is going to be on disk has to
 *      already be there.
 *   2. DESKTOP-18's install died 8 to 12 seconds after launch, seven runs
 *      running. A threshold that needs three observed deaths first is racing
 *      a window that short for no benefit.
 *
 * The threshold did not disappear, it MOVED to report time
 * (`shouldReportEscalation`), where it can also consider how the previous run
 * ended. Writing is cheap and local; reporting is what must not cry wolf.
 *
 * Telemetry still follows the restart-policy precedent: `gpu_process_gone`
 * ticks Aptabase on the FIRST death and again when the count crosses the
 * threshold (never once per death), because an unbounded per-crash count is
 * exactly what made three utility-process crashes read as "71 crashes a day"
 * before that policy existed.
 */

/** One GPU death, in order. The SEQUENCE is the diagnosis: it names which
 *  rung of Chromium's fallback ladder was current each time, which a single
 *  end-state snapshot cannot. `compositing` and `webgl` are the two
 *  `app.getGPUFeatureStatus()` values that move as Chromium walks that
 *  ladder; the full status of the latest death is kept separately on the
 *  record. */
export interface GpuDeathRecord {
  reason: string;
  exitCode: number | null;
  at: string;
  compositing: string;
  webgl: string;
}

export interface GpuHealthOptions {
  /** Deaths within the decay window before Aptabase's second tick fires. No
   *  longer gates the durable write, which happens on every death. */
  maxCrashes?: number;
  /** Quiet period after which the crash count resets. */
  decayMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Reads Chromium's current GPU mode at the moment of THIS death (Electron's
   *  `app.getGPUFeatureStatus()`, via the caller - this module stays
   *  Electron-free). Read on every death now that every death writes. Called
   *  inside the write's own try/catch, never in the argument expression: a
   *  throw out here would lose the write AND escape into the
   *  `child-process-gone` emit. Omitted in most tests; defaults to `{}`. */
  getFeatureStatus?: () => Record<string, string>;
}

/** Matches Chromium's own 3-crashes-in-5-minutes judgment. Now the REPORT
 *  threshold and the Aptabase latch point, not the write threshold. */
const DEFAULT_MAX_CRASHES = 3;
const DEFAULT_DECAY_MS = 5 * 60_000;

/** A chronic looper must not grow the file without bound. `count` stays the
 *  true total, so trimming the middle costs no information that matters:
 *  the first deaths name the rung that failed initially and the last name
 *  where it ended up. */
const MAX_DEATHS = 20;
/** Derived, not a second independent number. `appendDeath` bounds the array
 *  only while this stays below MAX_DEATHS: at or above it, the splice lands
 *  past the end, removes nothing, and the array grows without limit again.
 *  Half is the split that keeps the opening and closing rungs in equal
 *  measure, and deriving it means lowering MAX_DEATHS can never silently
 *  reopen that. */
const DEATHS_HEAD = Math.floor(MAX_DEATHS / 2);

/** The durable record, rewritten on every death. Bounded to a single latest
 *  incident, never a growing list - a later, separate incident in the same
 *  run (after a decay reset) overwrites it. */
export interface GpuEscalationRecord {
  /** The LATEST death's reason and exit code, kept as scalars because the
   *  Sentry tags need them flat. The per-death history is in `deaths`. */
  reason: string;
  exitCode: number | null;
  /** Total deaths counted in the window, which can exceed `deaths.length`
   *  once the middle has been trimmed. */
  count: number;
  firstAt: string;
  lastAt: string;
  appVersion: string;
  /** `app.getGPUFeatureStatus()` at the LATEST death. This is the ESCALATING
   *  run's state, not the reporting run's - the boot that reads and reports
   *  this record may have come up on working hardware GL. Read alongside a
   *  live `getGPUFeatureStatus()` call at report time, never in place of one. */
  featureStatus: Record<string, string>;
  deaths: GpuDeathRecord[];
}

type CrashPhase = 'first' | 'latched';

let crashCount = 0;
let firstCrashAt: number | null = null;
let lastCrashAt: number | null = null;
let deaths: GpuDeathRecord[] = [];
/** Per-run Aptabase phase gate, mirroring restart-policy.ts's
 *  `trackedCrashPhases` (there keyed by service; GPU has only one). This
 *  Set alone is what holds the telemetry to two ticks per run: it is NOT
 *  cleared by a decay reset, so a second incident later in the same run
 *  updates the record without ticking Aptabase again. It does not gate the
 *  write, which happens on every death. */
const trackedPhases = new Set<CrashPhase>();

/** Forget all module state (vitest shares module instances). */
export function resetGpuHealthForTests(): void {
  crashCount = 0;
  firstCrashAt = null;
  lastCrashAt = null;
  deaths = [];
  trackedPhases.clear();
}

function decayIfQuiet(nowMs: number, decayMs: number): void {
  if (crashCount === 0 || lastCrashAt === null) return;
  if (nowMs - lastCrashAt < decayMs) return;
  crashCount = 0;
  firstCrashAt = null;
  lastCrashAt = null;
  deaths = [];
}

function trackPhaseOnce(phase: CrashPhase, reason: string, exitCode: number | null): void {
  if (trackedPhases.has(phase)) return;
  trackedPhases.add(phase);
  trackEvent('gpu_process_gone', { reason, exitCode: exitCode ?? -1, phase });
}

function appendDeath(death: GpuDeathRecord): void {
  deaths.push(death);
  if (deaths.length > MAX_DEATHS) {
    // Trim from the middle so the first and last deaths both survive.
    deaths.splice(DEATHS_HEAD, 1);
  }
}

/** Never throws. Mirrors run-uptime.ts's writeRun: an unwritable config dir
 *  costs this one record, nothing more. mkdir first, matching
 *  crash-capture.ts's writeRecord, so a fresh install (configDir not yet
 *  created) does not silently drop the very first write. */
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
      // Unwritable config dir: give up on this record.
    }
  }
}

/**
 * Record a GPU child-process-gone death. Callers filter to non-`clean-exit`
 * GPU events before calling this (crash-capture.ts already does, for the
 * local crash-record write this complements).
 *
 * Writes on EVERY death (see the module doc). The report threshold lives in
 * `shouldReportEscalation`, not here.
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
  if (crashCount >= maxCrashes) trackPhaseOnce('latched', reason, normalizedExitCode);

  // Inside the try so a throwing getFeatureStatus cannot lose the write or
  // escape into the child-process-gone emit (see GpuHealthOptions).
  let featureStatus: Record<string, string>;
  try {
    featureStatus = options.getFeatureStatus?.() ?? {};
  } catch {
    featureStatus = {};
  }

  appendDeath({
    reason,
    exitCode: normalizedExitCode,
    at: new Date(nowMs).toISOString(),
    compositing: featureStatus.gpu_compositing ?? 'unknown',
    webgl: featureStatus.webgl ?? 'unknown',
  });

  writeEscalation(filePath, {
    reason,
    exitCode: normalizedExitCode,
    count: crashCount,
    firstAt: new Date(firstCrashAt).toISOString(),
    lastAt: new Date(nowMs).toISOString(),
    appVersion,
    featureStatus,
    deaths: [...deaths],
  });
}

/** A missing file, a pre-upgrade config dir, or a corrupt record all read as
 *  "nothing pending" - the same stance `run-uptime.ts`'s `readPreviousRun`
 *  takes for the same reasons. `featureStatus` and `deaths` tolerate a
 *  missing or wrong-shaped value rather than invalidating the whole record:
 *  they are context, not the fact that matters (a GPU death happened). A
 *  record written before `deaths` existed reads back with an empty one. */
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
    // Normalized, not just filtered. A predicate that asserts `is
    // GpuDeathRecord` while checking only two of the five fields hands the
    // Sentry context an object the type system swears is complete and which
    // is actually missing `compositing` / `webgl` / `exitCode`. Nothing
    // throws (a missing property reads `undefined` and JSON.stringify drops
    // it), so the only symptom is a triage that silently lost the very
    // sequence this record exists to carry. The two identifying fields still
    // gate an entry in or out; the rest fall back the same way the
    // record-level `exitCode` and `featureStatus` above already do, and
    // 'unknown' is what appendDeath itself writes when a mode is unavailable.
    // Widened back to `unknown` first, deliberately. `parsed` is a
    // `Partial<GpuEscalationRecord>` cast over `JSON.parse`, so the element
    // type already CLAIMS to be a GpuDeathRecord while the bytes on disk
    // promise nothing, and validating against that claim would check the
    // cast rather than the data.
    const rawDeaths: unknown[] = Array.isArray(parsed.deaths) ? (parsed.deaths as unknown[]) : [];
    const deathList: GpuDeathRecord[] = rawDeaths.flatMap((entry): GpuDeathRecord[] => {
      if (!entry || typeof entry !== 'object') return [];
      const death = entry as Record<string, unknown>;
      // The two identifying fields gate an entry in or out. The rest fall
      // back the same way the record-level `exitCode` and `featureStatus`
      // do, and 'unknown' is exactly what appendDeath writes when Chromium
      // reports no value for a mode.
      if (typeof death.reason !== 'string' || typeof death.at !== 'string') return [];
      return [
        {
          reason: death.reason,
          exitCode: typeof death.exitCode === 'number' ? death.exitCode : null,
          at: death.at,
          compositing: typeof death.compositing === 'string' ? death.compositing : 'unknown',
          webgl: typeof death.webgl === 'string' ? death.webgl : 'unknown',
        },
      ];
    });
    return {
      reason: parsed.reason,
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
      count: parsed.count,
      firstAt: parsed.firstAt,
      lastAt: parsed.lastAt,
      appVersion: parsed.appVersion,
      featureStatus,
      deaths: deathList,
    };
  } catch {
    return null;
  }
}

/**
 * True when this record was written by the run that is asking, rather than by
 * a previous one.
 *
 * This exists because the WRITER is installed at module scope
 * (`installDiagnostics`, index.ts) while the READER runs inside
 * `app.whenReady()` after `createWindow()` and an `await`. A GPU that
 * crash-loops from startup writes a record in that gap, and without this
 * guard the same run reads it, clears it, and reports it - with the async
 * Sentry POST racing the LOG(FATAL) that is about to kill the process. The
 * record is then gone and the next launch finds nothing pending. DESKTOP-18's
 * seven runs each died 8 to 12 seconds in, entirely inside that window.
 *
 * An undateable record counts as a previous run's: reporting one twice is
 * recoverable, losing one is not.
 */
export function isEscalationFromCurrentRun(record: GpuEscalationRecord, processStartIso: string): boolean {
  const lastAt = Date.parse(record.lastAt);
  const processStart = Date.parse(processStartIso);
  if (!Number.isFinite(lastAt) || !Number.isFinite(processStart)) return false;
  return lastAt >= processStart;
}

/** How close a GPU death has to be to the previous run's last known sign of
 *  life to count as part of how that run ended. One run-uptime checkpoint
 *  interval (60s) plus slack: the checkpoint is the only clock we have for an
 *  abrupt end, so the tolerance has to exceed its granularity. */
const DEATH_NEAR_RUN_END_MS = 90_000;

export interface EscalationReportContext {
  /** `previousRunLaunchProps().lastRunExit` - 'clean' | 'failsafe' | 'abrupt'. */
  previousRunExit: string | null;
  /** The previous run's last `at` checkpoint (run-uptime.ts). Null on a first
   *  run or a pre-upgrade record. */
  lastKnownAliveAt: string | null;
}

/**
 * Whether the previous run looks like it DIED of this GPU failure, rather
 * than merely having had one.
 *
 * Both halves are load-bearing. `abrupt` alone is far too broad: it means
 * only that no exit was recorded, which covers a renderer OOM (DESKTOP-16's
 * shape), a native PTY crash, a task-manager kill, and a power loss. Pairing
 * it with "and the GPU died once, at some point" would blame the graphics
 * process for a death it had nothing to do with. So the death also has to sit
 * near the end of that run.
 *
 * This is the condition that engages safe mode, because it is the one that
 * means the app could not survive its own launch.
 */
export function isDeathNearRunEnd(record: GpuEscalationRecord, context: EscalationReportContext): boolean {
  if (context.previousRunExit !== 'abrupt') return false;
  if (!context.lastKnownAliveAt) return false;
  const lastDeath = Date.parse(record.lastAt);
  const lastAlive = Date.parse(context.lastKnownAliveAt);
  if (!Number.isFinite(lastDeath) || !Number.isFinite(lastAlive)) return false;
  return lastDeath >= lastAlive - DEATH_NEAR_RUN_END_MS;
}

/**
 * Whether a pending record is worth a Sentry issue. Deliberately WIDER than
 * `isDeathNearRunEnd`: a run that hit the threshold and then exited cleanly
 * means Chromium fell back on its own and survived, which is worth knowing
 * about even though the user needs no recovery and sees nothing.
 */
export function shouldReportEscalation(
  record: GpuEscalationRecord,
  context: EscalationReportContext,
  options: { maxCrashes?: number } = {},
): boolean {
  if (record.count >= (options.maxCrashes ?? DEFAULT_MAX_CRASHES)) return true;
  return isDeathNearRunEnd(record, context);
}

/**
 * Cut `app.getGPUInfo('complete')` down to the fields a triage would actually
 * read.
 *
 * Measured on Electron 41: the raw object serializes to about 6.5-7 KB, and it
 * shares the `gpu_process` Sentry context with the `deaths` sequence. If that
 * context is ever truncated, the sequence is what gets lost, and the sequence
 * is the entire reason this record carries per-death detail at all. So the
 * open-ended half is trimmed and the bounded half keeps its room.
 *
 * `glRenderer` is the field that actually names a software fallback in
 * practice ("Microsoft Basic Render Driver" on a Windows run with
 * --disable-gpu). `isSoftwareRendering` came back undefined on that same run,
 * so it is kept only as a cheap extra where a platform does populate it, never
 * relied on.
 *
 * Takes `unknown` so this module stays Electron-free; it only reshapes a plain
 * object and never throws on a shape it does not recognize.
 */
export function summarizeGpuInfo(info: unknown): Record<string, unknown> | null {
  if (!info || typeof info !== 'object') return null;
  const source = info as Record<string, unknown>;
  const auxAttributes = (source.auxAttributes ?? {}) as Record<string, unknown>;
  const devices = Array.isArray(source.gpuDevice) ? source.gpuDevice : [];
  return {
    // The adapters themselves: which one was active, and on what driver.
    gpuDevice: devices.slice(0, 4).map((entry) => {
      const device = (entry ?? {}) as Record<string, unknown>;
      return {
        vendorId: device.vendorId,
        deviceId: device.deviceId,
        driverVersion: device.driverVersion,
        driverVendor: device.driverVendor,
        active: device.active,
      };
    }),
    machineModelName: source.machineModelName,
    machineModelVersion: source.machineModelVersion,
    glRenderer: auxAttributes.glRenderer,
    glVendor: auxAttributes.glVendor,
    glVersion: auxAttributes.glVersion,
    isSoftwareRendering: auxAttributes.isSoftwareRendering,
  };
}

/** Best-effort. Called after a record has been reported, so it fires once
 *  rather than on every subsequent launch. A missing file is not an error.
 *
 *  `onlyIfLastAt` makes this a compare-and-clear: a crash loop can write a
 *  FRESH record between the read and this call, and an unconditional unlink
 *  would take it. Pass the `lastAt` that was actually reported. */
export function clearGpuEscalation(filePath: string, options: { onlyIfLastAt?: string } = {}): void {
  try {
    if (options.onlyIfLastAt !== undefined) {
      const current = readPendingGpuEscalation(filePath);
      if (current && current.lastAt !== options.onlyIfLastAt) return;
    }
    fs.unlinkSync(filePath);
  } catch {
    // Missing, or unwritable: nothing more to do either way.
  }
}
