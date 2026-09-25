import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../config/board-config/atomic-write';
import { trackEvent } from '../analytics/analytics';
import type { LinuxProcessSnapshot, ZygoteState } from './linux-gpu-zygote';

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
 *   1. The killing death never reaches JS. Chromium calls
 *      `GpuProcessHost::RecordProcessCrash` (and therefore the LOG(FATAL))
 *      from the delegate, BEFORE the observer notification Electron emits
 *      `child-process-gone` from. Measured on Linux in Electron 41: six
 *      SIGKILLs of the GPU process produced five `child-process-gone` events
 *      and then the fatal. So whatever is going to be on disk has to already
 *      be there.
 *   2. DESKTOP-18's install died 8 to 12 seconds after launch, seven runs
 *      running. A threshold that needs three observed deaths first is racing
 *      a window that short for no benefit.
 *
 * The threshold did not disappear, it MOVED to report time
 * (`shouldReportEscalation`), where it can also consider how the previous run
 * ended. Writing is cheap and local; reporting is what must not cry wolf.
 *
 * WHY A FALLBACK WRITES TOO (DESKTOP-W). Some GPU failures reach JS as no
 * death at all, so a whole incident can end in the fatal with nothing on disk:
 *
 *   - A launch failure. Electron overrides `BrowserChildProcessCrashed` and
 *     `...Killed` but not `BrowserChildProcessLaunchFailed`, so a GPU process
 *     that fails to START emits nothing, ever.
 *   - A death Chromium reads as a normal termination. On Linux the GPU process
 *     forks from the unsandboxed zygote, and when that zygote cannot answer,
 *     `GetTerminationStatus` defaults to NORMAL_TERMINATION, which
 *     `OnChildDisconnected` drops without a crash count or an observer.
 *
 * A dead zygote produces both at once: the GPU's death is silent, and every
 * relaunch through it is a launch failure. Reproduced on Linux in Electron 41
 * by killing the unsandboxed zygote and then the GPU process: six launch
 * failures inside 2 ms, then the fatal, and not one `child-process-gone`.
 *
 * What does reach JS on every desktop route to the fatal is the fallback to
 * Chromium's last rung. `FallBackToNextGpuMode` into DISPLAY_COMPOSITOR calls
 * `OnGpuBlocked`, which notifies `gpu-info-update`, and from then on
 * `app.getGPUFeatureStatus().gpu_compositing` reads degraded. The notify is
 * posted a full GPU launch round trip before the fatal, so queue order, not
 * timing slack, is what puts the listener first. In the reproduction the
 * listener's synchronous write was on disk before the process died, in the
 * same millisecond as the fatal.
 * `recordGpuModeObservation` records that transition and moves `lastAt`, so
 * the next launch's near-end check counts it as a GPU death.
 *
 * Only a transition AWAY from hardware compositing writes, with one exception.
 * A machine that is degraded from its first read (our own software mode, a
 * blocklisted driver, a VM) never had hardware to lose, and its boot-time
 * status churn would otherwise write a record on every launch. The exception
 * is Linux with the GPU's zygote already dead (`linux-gpu-zygote.ts`): that
 * is never a normal state, so a degraded read then writes whatever came
 * before it. Three shapes stay uncovered:
 *
 *   - a machine that already sits on the last rung, whose fatal comes with no
 *     further `gpu-info-update` at all;
 *   - a Linux machine that never composited on the GPU and whose zygote is
 *     alive but cannot fork (at the process limit, say);
 *   - a Windows or macOS machine that never composited on the GPU, where
 *     there is no zygote to check.
 *
 * On Linux each fallback also records whether that zygote was alive and how
 * close the user was to their process limit. A dead zygote and a failed fork
 * both produce DESKTOP-W's stack, and they need different fixes.
 *
 * A boot-time write can overwrite a previous run's record before the report
 * block in whenReady reads it, because the writers are installed at module
 * scope and each write rebuilds the file from this run's state alone. The
 * recovery decision is not affected. It reads the record at module scope,
 * before any GPU process exists, and the software mode it engages never reads
 * hardware, so it never writes. What can be lost is the report of anything the
 * previous run survived: a fallback, or a crash loop that reached the report
 * threshold.
 *
 * Telemetry still follows the restart-policy precedent: `gpu_process_gone`
 * ticks Aptabase on the FIRST death and again when the count crosses the
 * threshold (never once per death), because an unbounded per-crash count is
 * exactly what made three utility-process crashes read as "71 crashes a day"
 * before that policy existed.
 */

/** One GPU death, in order. The SEQUENCE is the diagnosis: it shows how
 *  Chromium walked its fallback ladder, which a single end-state snapshot
 *  cannot. `compositing` and `webgl` are the two `app.getGPUFeatureStatus()`
 *  values that move as it does; the full status of the latest write is kept
 *  separately on the record.
 *
 *  They are read when `child-process-gone` fires, which is AFTER Chromium
 *  handled the death. So an entry names the rung the death left behind: the
 *  death that triggers a fallback already reads the lower rung. Measured on
 *  Windows, three kills read `enabled`, `enabled`, `disabled_software`, and
 *  the third was a hardware death. */
export interface GpuDeathRecord {
  reason: string;
  exitCode: number | null;
  at: string;
  compositing: string;
  webgl: string;
}

/** One observed step down Chromium's GPU ladder: the moment
 *  `app.getGPUFeatureStatus()` changed while compositing was no longer on the
 *  GPU. Unlike a death, this can be the ONLY trace of an incident (see the
 *  module doc). */
export interface GpuModeChangeRecord {
  at: string;
  compositing: string;
  webgl: string;
  /** Linux only: the GPU zygote and process-limit reading at this moment.
   *  Absent on other platforms. */
  linux?: LinuxProcessSnapshot;
}

export interface GpuHealthOptions {
  /** Deaths within the decay window before Aptabase's second tick fires. No
   *  longer gates the durable write, which happens on every death. */
  maxCrashes?: number;
  /** Quiet period after which the crash count resets. */
  decayMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Reads Chromium's current GPU mode at the moment of THIS death or mode
   *  observation (Electron's `app.getGPUFeatureStatus()`, via the caller -
   *  this module stays Electron-free). Called inside a try/catch, never in the
   *  argument expression: a throw out here would lose the write AND escape
   *  into the Electron event emit. Omitted in most tests; defaults to `{}`. */
  getFeatureStatus?: () => Record<string, string>;
  /** Linux only (`linux-gpu-zygote.ts`). Read by `recordGpuModeObservation`
   *  on a degraded status only, so a healthy update never touches `/proc`. */
  readLinuxProcessSnapshot?: () => LinuxProcessSnapshot;
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
/** Chromium only ever steps DOWN its ladder within a run, so a handful of
 *  changes is the realistic ceiling. The cap is for a status that flickers. */
const MAX_MODE_CHANGES = 8;

/** `reason` on a record that holds a fallback but no death, which is the
 *  DESKTOP-W launch-failure shape. */
const HARDWARE_FALLBACK_REASON = 'hardware-fallback';

/** The durable record, rewritten on every death and every fallback. Bounded
 *  to a single latest incident, never a growing list. A later, separate crash
 *  burst in the same run (after a decay reset) replaces the deaths. The mode
 *  changes stay, because Chromium never climbs back up its ladder within a
 *  run, so a fallback is still current when the next burst arrives. */
export interface GpuEscalationRecord {
  /** The LATEST death's reason and exit code, kept as scalars because the
   *  Sentry tags need them flat. `'hardware-fallback'` and null when the
   *  record holds a fallback but no death. The per-death history is in
   *  `deaths`. */
  reason: string;
  exitCode: number | null;
  /** Total deaths counted in the window, which can exceed `deaths.length`
   *  once the middle has been trimmed. Deaths only: 0 on a fallback-only
   *  record. */
  count: number;
  /** The earliest and latest GPU failure this record knows of, a death or a
   *  fallback. `lastAt` is what every near-end and same-run check reads. */
  firstAt: string;
  lastAt: string;
  appVersion: string;
  /** `app.getGPUFeatureStatus()` at the LATEST write. This is the ESCALATING
   *  run's state, not the reporting run's - the boot that reads and reports
   *  this record may have come up on working hardware GL. Read alongside a
   *  live `getGPUFeatureStatus()` call at report time, never in place of one. */
  featureStatus: Record<string, string>;
  deaths: GpuDeathRecord[];
  /** Each observed step down the ladder, in order. Empty on a record written
   *  before these existed. */
  modeChanges: GpuModeChangeRecord[];
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

/** Per-run: whether Chromium was ever seen compositing on the GPU. A degraded
 *  read before that is where this machine starts, not a fallback. */
let hardwareCompositingSeen = false;
/** The feature status last recorded as a mode change, so an identical read
 *  writes nothing. `gpu-info-update` fires on every GPU process restart, and
 *  in DISPLAY_COMPOSITOR mode each one repeats the same degraded status. */
let lastModeChangeSignature: string | null = null;
let modeChanges: GpuModeChangeRecord[] = [];
let firstModeChangeAt: number | null = null;
let lastModeChangeAt: number | null = null;

/** Forget all module state (vitest shares module instances). */
export function resetGpuHealthForTests(): void {
  crashCount = 0;
  firstCrashAt = null;
  lastCrashAt = null;
  deaths = [];
  trackedPhases.clear();
  hardwareCompositingSeen = false;
  lastModeChangeSignature = null;
  modeChanges = [];
  firstModeChangeAt = null;
  lastModeChangeAt = null;
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

/** Append, then trim from the middle so the first and last entries both
 *  survive. The split point is derived from `maximum` rather than passed in,
 *  because a head at or above `maximum` would splice past the end, remove
 *  nothing, and let the list grow without limit again. */
function appendKeepingEnds<Entry>(list: Entry[], entry: Entry, maximum: number): void {
  list.push(entry);
  if (list.length > maximum) {
    list.splice(Math.floor(maximum / 2), 1);
  }
}

function readFeatureStatus(options: GpuHealthOptions): Record<string, string> | null {
  try {
    return options.getFeatureStatus?.() ?? {};
  } catch {
    return null;
  }
}

/** Build the durable record from module state and write it. Both writers go
 *  through here, so a death never drops a recorded fallback and a fallback
 *  never drops the deaths that led to it. */
function persistRecord(filePath: string, appVersion: string, featureStatus: Record<string, string>): void {
  const failureTimes = [firstCrashAt, lastCrashAt, firstModeChangeAt, lastModeChangeAt].filter(
    (value): value is number => value !== null,
  );
  if (failureTimes.length === 0) return;
  const latestDeath = deaths[deaths.length - 1];
  writeEscalation(filePath, {
    reason: latestDeath?.reason ?? HARDWARE_FALLBACK_REASON,
    exitCode: latestDeath?.exitCode ?? null,
    count: crashCount,
    firstAt: new Date(Math.min(...failureTimes)).toISOString(),
    lastAt: new Date(Math.max(...failureTimes)).toISOString(),
    appVersion,
    featureStatus,
    deaths: [...deaths],
    modeChanges: [...modeChanges],
  });
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

  // A throwing getFeatureStatus must not lose the write or escape into the
  // child-process-gone emit (see GpuHealthOptions).
  const featureStatus = readFeatureStatus(options) ?? {};

  appendKeepingEnds(
    deaths,
    {
      reason,
      exitCode: normalizedExitCode,
      at: new Date(nowMs).toISOString(),
      compositing: featureStatus.gpu_compositing ?? 'unknown',
      webgl: featureStatus.webgl ?? 'unknown',
    },
    MAX_DEATHS,
  );

  persistRecord(filePath, appVersion, featureStatus);
}

/** Every `gpu_compositing` value Chromium reports for GPU compositing starts
 *  with `enabled` (`enabled`, `enabled_on`, `enabled_readback`, ...). */
function isHardwareCompositing(compositing: string): boolean {
  return compositing.startsWith('enabled');
}

/** A value that names software or no compositing. Anything else (a missing or
 *  unrecognized value) is not evidence either way. */
function isDegradedCompositing(compositing: string): boolean {
  return compositing.startsWith('disabled') || compositing.startsWith('unavailable');
}

/** The whole status map, not just `gpu_compositing`: a SOFTWARE_GL rung and
 *  the DISPLAY_COMPOSITOR rung below it both read `disabled_software` there,
 *  and `lastAt` has to reach the second one. */
function featureStatusSignature(featureStatus: Record<string, string>): string {
  return JSON.stringify(Object.keys(featureStatus).sort().map((key) => [key, featureStatus[key]]));
}

function tryReadLinuxProcessSnapshot(options: GpuHealthOptions): LinuxProcessSnapshot | null {
  try {
    return options.readLinuxProcessSnapshot?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Record Chromium's GPU mode from a `gpu-info-update`. Writes when the run has
 * been seen compositing on the GPU and now is not, or when the status changes
 * again after that. On Linux it also writes when the GPU's zygote is dead,
 * with or without earlier hardware compositing. See the module doc for why
 * this is the one signal a launch-failure ladder leaves. Never throws.
 */
export function recordGpuModeObservation(
  filePath: string,
  appVersion: string,
  options: GpuHealthOptions = {},
): void {
  const featureStatus = readFeatureStatus(options);
  const compositing = featureStatus?.gpu_compositing;
  if (!featureStatus || typeof compositing !== 'string') return;

  if (isHardwareCompositing(compositing)) {
    hardwareCompositingSeen = true;
    lastModeChangeSignature = null;
    return;
  }
  if (!isDegradedCompositing(compositing)) return;

  const linux = tryReadLinuxProcessSnapshot(options);
  if (!hardwareCompositingSeen && linux?.zygote !== 'dead') return;

  const signature = featureStatusSignature(featureStatus);
  if (signature === lastModeChangeSignature) return;
  lastModeChangeSignature = signature;

  const nowMs = (options.now ?? Date.now)();
  if (firstModeChangeAt === null) firstModeChangeAt = nowMs;
  lastModeChangeAt = nowMs;
  const modeChange: GpuModeChangeRecord = {
    at: new Date(nowMs).toISOString(),
    compositing,
    webgl: featureStatus.webgl ?? 'unknown',
  };
  if (linux) modeChange.linux = linux;
  appendKeepingEnds(modeChanges, modeChange, MAX_MODE_CHANGES);

  // No decay here, unlike a death. Deaths from minutes ago may already be on
  // disk as a crash loop the next launch reports, and clearing them because a
  // fallback came later would overwrite that record with a fallback-only one.
  persistRecord(filePath, appVersion, featureStatus);
}

const ZYGOTE_STATES: readonly ZygoteState[] = ['alive', 'dead', 'unknown'];

/** A mode change's `linux` block, or null when absent or not an object. The
 *  zygote state has to be one of the three the probe writes, since a report
 *  that says "dead" on bad data would send a triage the wrong way. */
function normalizeLinuxProcessSnapshot(value: unknown): LinuxProcessSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  const zygote = ZYGOTE_STATES.find((state) => state === snapshot.zygote) ?? 'unknown';
  return {
    zygote,
    schedulingEntities: typeof snapshot.schedulingEntities === 'number' ? snapshot.schedulingEntities : null,
    maxUserProcesses: typeof snapshot.maxUserProcesses === 'string' ? snapshot.maxUserProcesses : null,
  };
}

/** A missing file, a pre-upgrade config dir, or a corrupt record all read as
 *  "nothing pending" - the same stance `run-uptime.ts`'s `readPreviousRun`
 *  takes for the same reasons. `featureStatus`, `deaths` and `modeChanges`
 *  tolerate a missing or wrong-shaped value rather than invalidating the whole
 *  record: they are context, not the fact that matters (a GPU failure
 *  happened, and when). A record written before `deaths` or `modeChanges`
 *  existed reads back with an empty one. */
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
    // 'unknown' is what the writer itself records when a mode is unavailable.
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
      // do, and 'unknown' is exactly what the writer records when Chromium
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
    // Same normalization as `deaths`, for the same reason. `at` is the one
    // identifying field.
    const rawModeChanges: unknown[] = Array.isArray(parsed.modeChanges) ? (parsed.modeChanges as unknown[]) : [];
    const modeChangeList: GpuModeChangeRecord[] = rawModeChanges.flatMap((entry): GpuModeChangeRecord[] => {
      if (!entry || typeof entry !== 'object') return [];
      const modeChange = entry as Record<string, unknown>;
      if (typeof modeChange.at !== 'string') return [];
      const normalized: GpuModeChangeRecord = {
        at: modeChange.at,
        compositing: typeof modeChange.compositing === 'string' ? modeChange.compositing : 'unknown',
        webgl: typeof modeChange.webgl === 'string' ? modeChange.webgl : 'unknown',
      };
      const linux = normalizeLinuxProcessSnapshot(modeChange.linux);
      if (linux) normalized.linux = linux;
      return [normalized];
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
      modeChanges: modeChangeList,
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
 * A fallback counts as a death here: `lastAt` is the latest of either. That
 * is what catches DESKTOP-W, whose launch failures leave only the fallback,
 * recorded moments before the fatal. The near-end half still applies, so a
 * machine that fell back at boot and died of something else twenty minutes
 * later is not blamed on its GPU.
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
 *
 * A fallback-only record (`count` 0) on a run that survived is NOT reported.
 * VMs and broken-GL machines can fall back at every boot, and a report per
 * launch from each of them would be noise that buries the real shape.
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
