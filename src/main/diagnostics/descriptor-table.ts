/**
 * How full main's file descriptor table is (Sentry DESKTOP-59).
 *
 * DESKTOP-59 was `EMFILE: open failed` from a config write on Windows: main held
 * every slot of the C runtime's descriptor table (8192), and nothing said
 * whether that table had filled over hours or in a burst. libuv opens a file
 * with `CreateFileW` and then takes a CRT descriptor with `_open_osfhandle`, and
 * EMFILE is that second call finding no free slot. SQLite, `fs.watch`, node-pty's
 * pipes and child stdio use Win32 handles, not CRT descriptors, and the pty host
 * and the retrieval worker are other processes with tables of their own.
 *
 * The probe opens the null device through the same `fs.openSync` path, reads
 * the descriptor number it got, and closes it. The CRT hands out the lowest free
 * slot, the way POSIX requires, so that number is how many slots below it are
 * held. Measured on Windows with Node 24 and with Electron 45.4.1 (the
 * DESKTOP-59 release) alike: after 20 opens, closing descriptors 8 and 15 made
 * the next two opens return 8 and 15, and after 3000 more opens the next was
 * 3023. A table with holes reads
 * lower than its true count, so this is a floor, and a climbing floor is a leak.
 * On macOS and Linux the same number also counts sockets and pipes, since there
 * every one of those is a descriptor.
 *
 * Nothing here reports by itself. `index.ts` wires the one report a run sends
 * when the table crosses `DEFAULT_HIGH_MARK`, and `error-reporting.ts` adds the
 * readings to any EMFILE report main sends (`getDescriptorTableContext`). Every
 * value that leaves is a bucket, never a raw count.
 */

import fs from 'node:fs';
import os from 'node:os';
import type { DescriptorReading } from '../../shared/types';

export type { DescriptorReading };

/** Every value a descriptor count tag can take. */
export const DESCRIPTOR_BUCKETS = [
  '<64',
  '64-255',
  '256-1023',
  '1024-2047',
  '2048-4095',
  '4096-8191',
  '8192+',
  'full',
  'unknown',
] as const;

export type DescriptorBucket = (typeof DESCRIPTOR_BUCKETS)[number];

/** Every value the uptime tag can take. */
export const UPTIME_BUCKET_LABELS = ['<10m', '10m-1h', '1-4h', '4-12h', '12-24h', '1-3d', '3d+'] as const;

export type UptimeBucket = (typeof UPTIME_BUCKET_LABELS)[number];

/** What a report carries: fixed buckets only. A type alias, so it fits a `Record<string, string>`. */
export type DescriptorTableTags = {
  descriptor_latest: DescriptorBucket;
  descriptor_peak: DescriptorBucket;
  uptime: UptimeBucket;
  pty_host_in_main: 'true' | 'false';
};

export interface DescriptorProbeDeps {
  open: (filePath: string, flags: string) => number;
  close: (descriptor: number) => void;
  devNull: string;
}

const REAL_DEPS: DescriptorProbeDeps = {
  open: (filePath, flags) => fs.openSync(filePath, flags),
  close: (descriptor) => fs.closeSync(descriptor),
  devNull: os.devNull,
};

/** The codes an open returns when there is no slot left: this process's table, or the system's. */
const TABLE_FULL_CODES: ReadonlySet<string> = new Set(['EMFILE', 'ENFILE']);

/** One reading: open the null device, keep its descriptor number, close it. */
export function readLowestFreeDescriptor(deps: DescriptorProbeDeps = REAL_DEPS): DescriptorReading {
  let descriptor: number;
  try {
    descriptor = deps.open(deps.devNull, 'r');
  } catch (error) {
    // report-ok: an EMFILE here is the reading itself (the table is full); any other failure leaves the reading unknown
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' && TABLE_FULL_CODES.has(code) ? 'full' : null;
  }
  try {
    deps.close(descriptor);
  } catch {
    // report-ok: the probe's own null-device handle; a failed close costs one slot and does not change this reading
  }
  return descriptor;
}

const COUNT_BUCKETS: ReadonlyArray<readonly [number, DescriptorBucket]> = [
  [64, '<64'],
  [256, '64-255'],
  [1024, '256-1023'],
  [2048, '1024-2047'],
  [4096, '2048-4095'],
  [8192, '4096-8191'],
];

export function bucketDescriptorReading(reading: DescriptorReading): DescriptorBucket {
  if (reading === null) return 'unknown';
  if (reading === 'full') return 'full';
  for (const [below, bucket] of COUNT_BUCKETS) {
    if (reading < below) return bucket;
  }
  return '8192+';
}

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

const UPTIME_BUCKETS: ReadonlyArray<readonly [number, UptimeBucket]> = [
  [10 * MINUTE_SECONDS, '<10m'],
  [HOUR_SECONDS, '10m-1h'],
  [4 * HOUR_SECONDS, '1-4h'],
  [12 * HOUR_SECONDS, '4-12h'],
  [DAY_SECONDS, '12-24h'],
  [3 * DAY_SECONDS, '1-3d'],
];

export function bucketUptime(seconds: number): UptimeBucket {
  for (const [below, bucket] of UPTIME_BUCKETS) {
    if (seconds < below) return bucket;
  }
  return '3d+';
}

/** Orders readings: unknown lowest, a full table highest. */
function rankOf(reading: DescriptorReading): number {
  if (reading === null) return -1;
  if (reading === 'full') return Number.POSITIVE_INFINITY;
  return reading;
}

/**
 * The reading past which a run reports once. A quarter of Windows' 8192, and
 * far past what a healthy run holds, so a leak is heard hours before the table
 * fills. It is set for Windows. On macOS and Linux the table's size is the soft
 * open-file limit, and where that is under 2048 the first report a leak sends
 * is the `full` one.
 */
export const DEFAULT_HIGH_MARK = 2048;

let ptyHostRunningInMain = false;

/**
 * Called when the pty host gave up restarting and its core moved into main
 * (`UtilityPtyHostTransport.switchToFallback`). From then on every terminal's
 * pipes and files are in this process, so a report says so.
 */
export function markPtyHostRunningInMain(): void {
  ptyHostRunningInMain = true;
}

function buildTags(latest: DescriptorReading, peak: DescriptorReading, uptimeSeconds: number): DescriptorTableTags {
  return {
    descriptor_latest: bucketDescriptorReading(latest),
    descriptor_peak: bucketDescriptorReading(peak),
    uptime: bucketUptime(uptimeSeconds),
    pty_host_in_main: ptyHostRunningInMain ? 'true' : 'false',
  };
}

export interface DescriptorTableProbeOptions {
  read: () => DescriptorReading;
  uptimeSeconds: () => number;
  highMark?: number;
  /** Called once per probe, the first time a reading reaches `highMark` or the table is full. */
  onHigh?: (tags: DescriptorTableTags) => void;
}

export interface DescriptorTableProbe {
  /** Takes one reading, keeps it and the run's peak, and calls `onHigh` on the first crossing. */
  tick(): DescriptorReading;
  reading(): { latest: DescriptorReading; peak: DescriptorReading };
  tags(): DescriptorTableTags;
}

export function createDescriptorTableProbe(options: DescriptorTableProbeOptions): DescriptorTableProbe {
  const highMark = options.highMark ?? DEFAULT_HIGH_MARK;
  let latest: DescriptorReading = null;
  let peak: DescriptorReading = null;
  let heardHigh = false;
  const tags = (): DescriptorTableTags => buildTags(latest, peak, options.uptimeSeconds());
  return {
    tick() {
      const reading = options.read();
      latest = reading;
      if (rankOf(reading) > rankOf(peak)) peak = reading;
      if (!heardHigh && rankOf(reading) >= highMark) {
        heardHigh = true;
        options.onHigh?.(tags());
      }
      return reading;
    },
    reading: () => ({ latest, peak }),
    tags,
  };
}

let liveProbe: DescriptorTableProbe | null = null;

/** The running probe's latest reading and peak, for a dev read from `/preview`. Null before it starts. */
export function getDescriptorTableReading(): { latest: DescriptorReading; peak: DescriptorReading } | null {
  return liveProbe?.reading() ?? null;
}

/**
 * The context an EMFILE report carries: the probe's buckets, and `at_report`, a
 * fresh reading that says whether the table is still full as the report goes
 * out. Before the probe starts, its two buckets read `unknown`.
 */
export function getDescriptorTableContext(read: () => DescriptorReading = readLowestFreeDescriptor): Record<string, string> {
  const probeTags: DescriptorTableTags = liveProbe?.tags() ?? buildTags(null, null, process.uptime());
  return { ...probeTags, at_report: bucketDescriptorReading(read()) };
}

export interface DescriptorTableProbeStartOptions {
  /** The one report a run sends when the table crosses the high mark. */
  onHigh: (tags: DescriptorTableTags) => void;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Starts the probe: one reading now, then one every `intervalMs` on an unref'd
 * timer. Returns a disposer, which `clearPendingTimers` in `index.ts` calls.
 * `clearInterval` is synchronous, so the quit path needs nothing more.
 */
export function startDescriptorTableProbe(options: DescriptorTableProbeStartOptions): () => void {
  const probe = createDescriptorTableProbe({
    read: () => readLowestFreeDescriptor(),
    uptimeSeconds: () => process.uptime(),
    onHigh: (tags) => {
      console.warn(`[descriptor-table] Main holds ${tags.descriptor_latest} file descriptors after ${tags.uptime} (pty host in main: ${tags.pty_host_in_main}).`);
      options.onHigh(tags);
    },
  });
  liveProbe = probe;
  const tick = (): void => {
    try {
      probe.tick();
    } catch (error) {
      // report-ok: a diagnostics tick must never throw into its timer; every open failure is already a reading, so only a bug here lands, and it logs
      console.error('[descriptor-table] Sampling tick failed:', error);
    }
  };
  tick();
  const interval = setInterval(tick, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  interval.unref();
  return () => {
    clearInterval(interval);
    if (liveProbe === probe) liveProbe = null;
  };
}
