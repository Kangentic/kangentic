/**
 * Host-level memory sampling (Sentry DESKTOP-16).
 *
 * The readings go on crash reports and the give-up dialog, and they hold the
 * workflow's automatic nudges while memory reads low
 * (`workflow-memory-gate.ts`). Nothing here warns anyone or stops an agent. An
 * earlier warning toast and a pause of waiting agents were removed: a low
 * reading was a short spell of reservations on a limit that grows, and the
 * load came from working agents the pause never touched. A low spell now leaves
 * one log line when it starts and one when it ends.
 *
 * DESKTOP-16 was a renderer OOM where the crashing renderer held 179 MB
 * (smaller than a healthy long-running dogfood session) while the HOST had
 * 2.15 MB of Windows commit charge left out of an 89.8 GB limit, with 4.66 GB
 * of physical RAM still free. That is commit exhaustion, not a renderer leak
 * or physical RAM exhaustion: the OS refused an ordinary 6.9 MB allocation
 * because the machine's pagefile-backed commit charge was fully spent, and
 * Kangentic had no visibility into that dimension at all. An `os.freemem()`
 * style check would not have caught it, since physical memory was fine.
 *
 * `process.getSystemMemoryInfo()`'s `swapTotal` / `swapFree` map DIRECTLY onto
 * the Windows commit limit / commit remaining, confirmed empirically
 * (2026-09-16): reading it against `Win32_OperatingSystem`'s
 * `TotalVirtualMemorySize` / `FreeVirtualMemory` on the same machine at the
 * same moment matched (73.14 GB / ~15 GB on both sides). This holds despite
 * the "swap" naming: on Windows, Chromium passes `GlobalMemoryStatusEx`'s
 * `ullTotalPageFile` / `ullAvailPageFile` straight through, which ARE the
 * commit figures, not merely the pagefile's on-disk size. Linux reports real
 * swap through the same fields, a different resource with no equivalent hard
 * OOM cliff, so this module reports a commit reading on win32 only and stays
 * null everywhere else rather than asserting an unverified mapping.
 *
 * Linux gets its own reading instead: `available` (Electron 44+, Linux only) is
 * the kernel's MemAvailable, its estimate of what can be allocated without
 * swapping. `free` there is MemFree, which excludes page cache and other
 * reclaimable memory and so reads near zero on a perfectly healthy machine,
 * which made the recorded figure useless for judging a Linux crash.
 *
 * Whether memory reads low is judged on every platform, each by its own signal
 * (`memoryHeadroom`):
 *   - Windows: commit headroom.
 *   - Linux: RAM plus swap, `available + swapFree` against `total + swapTotal`,
 *     through the same threshold and recovery line. MemAvailable alone reads
 *     low on a healthy machine that keeps cold pages in swap.
 *   - macOS: the kernel's own verdict, `kern.memorystatus_vm_pressure_level`
 *     (1 normal, 2 warn, 4 critical). Critical is low and normal is not. Warn
 *     alone says too little: a machine sat at warn on every check with 36% of
 *     its memory free and its swap 94% full.
 *     Swap is no ceiling there, since macOS adds swap files as it needs them,
 *     and if room really runs out the level goes to critical. So warn is judged
 *     by the kernel's own free percentage (`kern.memorystatus_level`) against
 *     the threshold and recovery line the other platforms use. `os.freemem` is
 *     not that figure: it leaves out memory the kernel can reclaim. Both are
 *     read through `sysctl` off the main thread after each tick and reported on
 *     the next, so they are one tick late; a reading older than two ticks
 *     counts as unknown.
 */

import type { HostMemorySample } from '../../shared/types';
import { execFileAsync } from '../utility-process/off-main-exec';

export type { HostMemorySample };

const BYTES_PER_KB = 1024;

export interface SampleHostMemoryOptions {
  /** The cached macOS pressure level (see `createMacSysctlReader`). */
  memoryPressureLevel?: number | null;
  /** The cached macOS free percentage, read the same way. */
  memoryFreePercent?: number | null;
}

/** Only Windows' swapTotal/swapFree have been verified to mean commit
 *  limit/remaining (see the module header). Treat every other platform as
 *  having no commit reading rather than guessing. */
function hasVerifiedCommitReading(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

export function sampleHostMemory(options: SampleHostMemoryOptions = {}): HostMemorySample {
  const info = process.getSystemMemoryInfo();
  const commitReading = hasVerifiedCommitReading(process.platform);
  const isLinux = process.platform === 'linux';
  return {
    ts: new Date().toISOString(),
    platform: process.platform,
    commitLimitBytes: commitReading && info.swapTotal != null ? info.swapTotal * BYTES_PER_KB : null,
    commitRemainingBytes: commitReading && info.swapFree != null ? info.swapFree * BYTES_PER_KB : null,
    physicalTotalBytes: info.total * BYTES_PER_KB,
    physicalFreeBytes: info.free * BYTES_PER_KB,
    physicalAvailableBytes: isLinux && typeof info.available === 'number' ? info.available * BYTES_PER_KB : null,
    swapTotalBytes: isLinux && info.swapTotal != null ? info.swapTotal * BYTES_PER_KB : null,
    swapFreeBytes: isLinux && info.swapFree != null ? info.swapFree * BYTES_PER_KB : null,
    memoryPressureLevel: process.platform === 'darwin' ? options.memoryPressureLevel ?? null : null,
    memoryFreePercent: process.platform === 'darwin' ? options.memoryFreePercent ?? null : null,
  };
}

let lastSample: HostMemorySample | null = null;

/**
 * Read synchronously (e.g. from `crash-capture.ts` at crash time). Never
 * re-samples: crash time is not the moment to call an OS API that may itself
 * need to allocate.
 */
export function getLastHostMemorySample(): HostMemorySample | null {
  return lastSample;
}

/** Absolute floor: DESKTOP-16's failed allocation was 6.9 MB against 2.15 MB
 *  remaining, so 2 GB gives roughly three orders of magnitude of runway. */
const ABSOLUTE_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;
/** Relative floor: keeps a small machine (an 8 GB commit limit resolves to
 *  400 MB) from reading low at a headroom that is actually normal for it. The
 *  smaller of the two arms wins. */
const RELATIVE_THRESHOLD_FRACTION = 0.05;
/** A low spell ends only once headroom recovers past this multiple of the
 *  threshold, so a value oscillating around the line cannot start a new spell
 *  on every tick (hysteresis). */
const HYSTERESIS_MULTIPLIER = 2;

const BYTES_PER_GB = 1024 * 1024 * 1024;

/** Exported so the boundary tests measure against the real formula instead of
 *  a hand-copied one that would silently keep passing if a constant changed. */
export function pressureThreshold(commitLimitBytes: number): number {
  return Math.min(ABSOLUTE_THRESHOLD_BYTES, commitLimitBytes * RELATIVE_THRESHOLD_FRACTION);
}

/** The headroom past which a low-memory latch clears (`updateLowMemoryLatch`). */
export function recoveryLine(limitBytes: number): number {
  return pressureThreshold(limitBytes) * HYSTERESIS_MULTIPLIER;
}

/**
 * How much room the machine has, in the form its platform can measure. Bytes
 * on Windows (commit), Linux (RAM plus swap) and macOS at the warn level (RAM
 * from the kernel's free percentage), judged against `pressureThreshold` and
 * `recoveryLine`; a kernel verdict on macOS at normal and critical.
 */
export type MemoryHeadroom =
  | { kind: 'bytes'; remainingBytes: number; limitBytes: number }
  | { kind: 'level'; low: boolean };

const MAC_NORMAL_PRESSURE_LEVEL = 1;
const MAC_WARN_PRESSURE_LEVEL = 2;
const MAC_CRITICAL_PRESSURE_LEVEL = 4;

/**
 * The sample's headroom, or null when this platform's reading is missing or
 * unrecognized. Pure: the latch below and the workflow's memory gate read it.
 */
export function memoryHeadroom(sample: HostMemorySample): MemoryHeadroom | null {
  if (sample.platform === 'win32') {
    const { commitLimitBytes, commitRemainingBytes } = sample;
    if (commitLimitBytes === null || commitRemainingBytes === null || commitLimitBytes <= 0) return null;
    return { kind: 'bytes', remainingBytes: commitRemainingBytes, limitBytes: commitLimitBytes };
  }
  if (sample.platform === 'linux') {
    const available = sample.physicalAvailableBytes;
    if (available === null || sample.physicalTotalBytes <= 0) return null;
    const swapTotal = sample.swapTotalBytes ?? 0;
    const swapFree = sample.swapFreeBytes ?? 0;
    return {
      kind: 'bytes',
      remainingBytes: available + swapFree,
      limitBytes: sample.physicalTotalBytes + swapTotal,
    };
  }
  if (sample.platform === 'darwin') {
    const level = sample.memoryPressureLevel ?? null;
    if (level === null) return null;
    if (level === MAC_CRITICAL_PRESSURE_LEVEL) return { kind: 'level', low: true };
    if (level === MAC_NORMAL_PRESSURE_LEVEL) return { kind: 'level', low: false };
    if (level !== MAC_WARN_PRESSURE_LEVEL) return null;
    const freePercent = sample.memoryFreePercent ?? null;
    if (freePercent === null || sample.physicalTotalBytes <= 0) return null;
    return {
      kind: 'bytes',
      remainingBytes: sample.physicalTotalBytes * (freePercent / 100),
      limitBytes: sample.physicalTotalBytes,
    };
  }
  return null;
}

/** `sysctl -n` prints the value and a newline. Anything else is unknown. */
export function parseMacSysctlInteger(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** `kern.memorystatus_level` prints a percentage. Anything else is unknown. */
export function parseMacFreePercent(stdout: string): number | null {
  const percent = parseMacSysctlInteger(stdout);
  return percent !== null && percent <= 100 ? percent : null;
}

/** Reads one macOS sysctl once, off the main thread. Null on any failure. */
async function readMacSysctl(name: string, parse: (stdout: string) => number | null): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', name], { timeout: 2000 });
    return parse(stdout);
  } catch {
    return null;
  }
}

const readMacPressureLevel = (): Promise<number | null> => readMacSysctl('kern.memorystatus_vm_pressure_level', parseMacSysctlInteger);
const readMacFreePercent = (): Promise<number | null> => readMacSysctl('kern.memorystatus_level', parseMacFreePercent);

export interface MacSysctlReader {
  /** The cached value, or null when there is none or it is older than `maxAgeMs`. */
  current(now: number, maxAgeMs: number): number | null;
  /** Start one read unless one is already running. Its result is cached for the next `current`. */
  refresh(): void;
  /** Stops a read still running from writing the cache. */
  dispose(): void;
}

/**
 * The cache behind one macOS sysctl. The sampler's tick is synchronous, and a
 * `sysctl` run is not, so each tick reads what the previous tick's run cached
 * and starts the next run. `clock` is injectable for tests.
 */
export function createMacSysctlReader(
  read: () => Promise<number | null>,
  clock: () => number = Date.now,
): MacSysctlReader {
  let cached: { value: number; readAt: number } | null = null;
  let reading = false;
  let disposed = false;
  return {
    current(now, maxAgeMs) {
      if (!cached || now - cached.readAt > maxAgeMs) return null;
      return cached.value;
    },
    refresh() {
      if (reading || disposed) return;
      reading = true;
      void read()
        .then((value) => {
          if (disposed) return;
          cached = value === null ? null : { value, readAt: clock() };
        })
        .catch(() => {
          if (!disposed) cached = null;
        })
        .finally(() => {
          reading = false;
        });
    },
    dispose() {
      disposed = true;
    },
  };
}

export interface LowMemoryLatch {
  /** True from the drop below the threshold until headroom clears the recovery line. */
  active: boolean;
}

export function createLowMemoryLatch(): LowMemoryLatch {
  return { active: false };
}

/**
 * Whether memory reads low after this reading. Mutates `latch`: it turns on
 * below the threshold and off past the recovery line, so a reading in between
 * keeps whatever it was. A missing reading changes nothing and reads as not low.
 */
export function updateLowMemoryLatch(headroom: MemoryHeadroom | null, latch: LowMemoryLatch): boolean {
  if (headroom === null) return false;
  if (headroom.kind === 'level') {
    latch.active = headroom.low;
    return latch.active;
  }
  if (headroom.remainingBytes < pressureThreshold(headroom.limitBytes)) {
    latch.active = true;
  } else if (headroom.remainingBytes >= recoveryLine(headroom.limitBytes)) {
    latch.active = false;
  }
  return latch.active;
}

interface LowMemorySpell {
  startedAt: number;
  /** Null until a reading in bytes arrives: macOS reports a level at normal and critical. */
  lowestRemainingBytes: number | null;
  firstLimitBytes: number | null;
  lastLimitBytes: number | null;
}

export interface LowMemorySpellState {
  latch: LowMemoryLatch;
  spell: LowMemorySpell | null;
}

export function createLowMemorySpellState(): LowMemorySpellState {
  return { latch: createLowMemoryLatch(), spell: null };
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
}

function spellStartLine(headroom: MemoryHeadroom): string {
  if (headroom.kind === 'level') return 'Memory reads low: the system reports critical pressure.';
  return `Memory reads low: ${formatGigabytes(headroom.remainingBytes)} left of ${formatGigabytes(headroom.limitBytes)}.`;
}

function spellEndLine(spell: LowMemorySpell, now: number): string {
  const minutes = Math.max(1, Math.round((now - spell.startedAt) / 60_000));
  const { lowestRemainingBytes, firstLimitBytes, lastLimitBytes } = spell;
  if (lowestRemainingBytes === null || firstLimitBytes === null || lastLimitBytes === null) {
    return `Memory recovered after ${minutes} min.`;
  }
  const limits = firstLimitBytes === lastLimitBytes
    ? formatGigabytes(lastLimitBytes)
    : `${formatGigabytes(firstLimitBytes)} then ${formatGigabytes(lastLimitBytes)}`;
  return `Memory recovered after ${minutes} min: lowest ${formatGigabytes(lowestRemainingBytes)} left, limit ${limits}.`;
}

/**
 * The line a low spell logs on this reading, or null. One when it starts and
 * one when it ends, with how long it lasted, how low it went and whether the
 * limit moved, so a spell can be read back from the logs when diagnosing a
 * crash. A missing reading changes nothing. Mutates `state`.
 */
export function trackLowMemorySpell(headroom: MemoryHeadroom | null, state: LowMemorySpellState, now: number): string | null {
  if (headroom === null) return null;
  const low = updateLowMemoryLatch(headroom, state.latch);
  const bytes = headroom.kind === 'bytes' ? headroom : null;
  if (state.spell === null) {
    if (!low) return null;
    state.spell = {
      startedAt: now,
      lowestRemainingBytes: bytes?.remainingBytes ?? null,
      firstLimitBytes: bytes?.limitBytes ?? null,
      lastLimitBytes: bytes?.limitBytes ?? null,
    };
    return spellStartLine(headroom);
  }
  const { spell } = state;
  if (bytes) {
    spell.lowestRemainingBytes = Math.min(spell.lowestRemainingBytes ?? bytes.remainingBytes, bytes.remainingBytes);
    spell.firstLimitBytes ??= bytes.limitBytes;
    spell.lastLimitBytes = bytes.limitBytes;
  }
  if (low) return null;
  state.spell = null;
  return spellEndLine(spell, now);
}

let simulatedLowMemory = false;

/**
 * Dev only (`/preview`): read every sample as low memory, so the workflow's
 * memory gate and the spell log can be watched without exhausting the machine.
 * Set through `dev.simulateLowMemory`.
 */
export function setSimulatedLowMemory(on: boolean): void {
  simulatedLowMemory = on;
}

/**
 * The sample as every low-memory reader sees it: forced low while dev's
 * `dev.simulateLowMemory` is on. Production builds drop the simulation
 * (`__KANGENTIC_DEV__`).
 */
export function sampleAsRead(sample: HostMemorySample): HostMemorySample {
  return __KANGENTIC_DEV__ && simulatedLowMemory ? simulateLowMemorySample(sample) : sample;
}

/** The sample with this platform's reading forced low. */
export function simulateLowMemorySample(sample: HostMemorySample): HostMemorySample {
  return {
    ...sample,
    commitRemainingBytes: sample.commitLimitBytes === null ? null : 0,
    physicalAvailableBytes: sample.physicalAvailableBytes === null ? null : 0,
    swapFreeBytes: sample.swapFreeBytes === null || sample.swapFreeBytes === undefined ? sample.swapFreeBytes : 0,
    memoryPressureLevel: sample.platform === 'darwin' ? 4 : sample.memoryPressureLevel,
  };
}

export interface HostMemorySamplerOptions {
  /** Called on every tick - the attach point for a Sentry context, so whatever
   *  event fires next carries the freshest sample, and for the workflow's
   *  memory gate. */
  onSample?: (sample: HostMemorySample) => void;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Starts the periodic sampler. Returns a disposer. `clearInterval` is
 * synchronous, so this needs no drain on the quit path (see
 * .claude/rules/synchronous-shutdown.md) - just call the disposer from
 * `clearPendingTimers`, same as the other module-scope intervals in
 * `src/main/index.ts`.
 */
export function startHostMemorySampler(options: HostMemorySamplerOptions): () => void {
  const spellState = createLowMemorySpellState();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const pressureLevel = process.platform === 'darwin' ? createMacSysctlReader(readMacPressureLevel) : null;
  // Its own read: an unknown name fails a whole sysctl run, and the level must
  // survive a macOS that lacks this one.
  const freePercent = process.platform === 'darwin' ? createMacSysctlReader(readMacFreePercent) : null;
  const tick = (): void => {
    // A diagnostics sampler must never be the thing that crashes the app it
    // is trying to protect - an uncaught throw here would surface every 60s
    // via the global uncaughtException handler for the life of the process.
    try {
      const sample = sampleHostMemory({
        memoryPressureLevel: pressureLevel?.current(Date.now(), intervalMs * 2) ?? null,
        memoryFreePercent: freePercent?.current(Date.now(), intervalMs * 2) ?? null,
      });
      lastSample = sample;
      const spellLine = trackLowMemorySpell(memoryHeadroom(sampleAsRead(sample)), spellState, Date.now());
      // A warning, so it reaches the log without Persist Console Logs on.
      if (spellLine !== null) console.warn(`[host-memory] ${spellLine}`);
      options.onSample?.(sample);
    } catch (error) {
      console.error('[host-memory] Sampling tick failed:', error);
    }
    pressureLevel?.refresh();
    freePercent?.refresh();
  };
  const interval = setInterval(tick, intervalMs);
  interval.unref();
  // The first macOS reading is ready for the first tick rather than the second.
  pressureLevel?.refresh();
  freePercent?.refresh();
  return () => {
    clearInterval(interval);
    pressureLevel?.dispose();
    freePercent?.dispose();
  };
}
