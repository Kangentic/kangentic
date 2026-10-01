/**
 * A CPU profile of the main process that is saved whenever main stalls (dev
 * builds only, behind `developer.stallProfiler`).
 *
 * Labelled spans (`timeSyncWork`) name the work someone thought to wrap; a
 * stall in anything else shows up in the lag monitor as a duration with no
 * cause. This profiler closes that gap without anyone adding a label: V8's
 * sampling profiler runs over the whole main thread, a check every
 * `CHECK_MS` looks for a stall, and on one the profile is stopped, the stall's
 * last `TAIL_MS` is summarised into the lag report, the full profile is saved
 * as a `.cpuprofile`, and profiling starts again.
 *
 * Restarting is the expensive part: V8 re-logs every compiled function when a
 * profile starts, measured at 43 to 60 ms of main on 2026-09-30. So the profile
 * runs continuously and restarts only after a stall, or every
 * `MAX_PROFILE_MS` to bound its memory, never on a short timer. The restart is
 * kept out of the numbers: the lag monitor's delay window is closed just
 * before it (so the stall it reacted to is counted) and the window that holds
 * it is marked `stall-profiler`, and the profiler skips its own next check so
 * the restart cannot trigger another. The stop is recorded as the
 * `devtools:profiler-stop` span.
 *
 * A pass/fail measurement runs with this off; it is for naming a stall that
 * run found, not for counting stalls.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { Session } from 'node:inspector/promises';
import type { Profiler } from 'node:inspector';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import {
  closeDelayWindow,
  DELAY_BACKSTOP_MS,
  DELAY_RESOLUTION_MS,
  markCurrentDelayWindow,
  NANOSECONDS_PER_MS,
  recordSyncSpan,
  slowSyncWorkSince,
} from '../../main/diagnostics/event-loop-lag';

const CHECK_MS = 1_000;
/** A profile running this long with no stall restarts without being saved. */
const MAX_PROFILE_MS = 5 * 60_000;
/** The part of a profile that is summarised: the stall happened within it. */
const TAIL_MS = 3_000;
/** Microseconds between samples. */
const SAMPLING_INTERVAL_US = 1_000;
/** Profiles kept on disk; older ones are removed. */
const KEEP_FILES = 20;
const SUMMARY_RING_SIZE = 50;
const TOP_FRAMES = 8;
const STACK_DEPTH = 12;
const PROFILER_STOP_LABEL = 'devtools:profiler-stop';
const RESTART_NOTE = 'stall-profiler';

export interface StallFrame {
  functionName: string;
  /** `file:line`, with the file reduced to its last two path segments. */
  location: string;
  selfMs: number;
}

export interface StallProfileSummary {
  /** UTC ISO timestamp of the check that found the stall. */
  detectedAt: string;
  /** The longest event-loop delay seen in the second before the check. */
  maxDelayMs: number;
  /** Labelled spans of 16 ms or more in that second. */
  slowSpans: Array<{ label: string; ms: number }>;
  /** The longest run of consecutive non-idle samples in the tail, in ms. */
  longestBusyRunMs: number | null;
  /** The functions with the most self time inside that run. */
  topFrames: StallFrame[];
  /** The stack of the top frame, root first. */
  heaviestStack: string[];
  /** How long stopping the profiler held main. */
  profilerStopMs: number;
  /** The saved `.cpuprofile`, or null when the write failed. */
  file: string | null;
}

let session: Session | null = null;
let directory: string | null = null;
let delayHistogram: IntervalHistogram | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let profileStartedAtMs = 0;
let lastCheckAtMs = 0;
let restarting = false;
/** Set by a restart: the next check would see the restart's own block. */
let skipNextCheck = false;
const summaries: StallProfileSummary[] = [];

/** Start profiling, saving stall profiles under `profileDirectory`. Idempotent. */
export async function startStallProfiler(profileDirectory: string): Promise<void> {
  if (session) return;
  directory = profileDirectory;
  const profilerSession = new Session();
  profilerSession.connect();
  session = profilerSession;
  try {
    await profilerSession.post('Profiler.enable');
    await profilerSession.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
    closeDelayWindow();
    await profilerSession.post('Profiler.start');
    markCurrentDelayWindow(RESTART_NOTE);
  } catch (error) {
    console.warn('[stall-profiler] could not start:', error);
    stopStallProfiler();
    return;
  }
  delayHistogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  delayHistogram.enable();
  profileStartedAtMs = Date.now();
  lastCheckAtMs = profileStartedAtMs;
  skipNextCheck = true;
  checkTimer = setInterval(() => {
    void check();
  }, CHECK_MS);
  checkTimer.unref();
}

/** Stop profiling. Synchronous, so the quit path can call it. */
export function stopStallProfiler(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  delayHistogram?.disable();
  delayHistogram = null;
  if (session) {
    try {
      session.disconnect();
    } catch {
      // Already gone.
    }
    session = null;
  }
}

export function isStallProfilerRunning(): boolean {
  return session !== null;
}

export function getStallProfiles(): StallProfileSummary[] {
  return [...summaries];
}

/** The directory profiles are saved to, beside the app's own data. */
export function stallProfileDirectory(userDataPath: string): string {
  return path.join(userDataPath, 'stall-profiles');
}

/** Longest on-demand capture, so a forgotten request cannot grow without bound. */
const MAX_CAPTURE_MS = 120_000;

/**
 * Profile the main process for `durationMs` and save the whole profile, for a
 * measured scenario (a terminal flood, a spawn burst) whose cost is many short
 * spans rather than one stall the stall profiler would keep. Starting costs
 * main the same 43 to 60 ms as a restart, inside the capture.
 */
export async function captureCpuProfile(
  profileDirectory: string,
  durationMs: number,
): Promise<{ file: string | null; durationMs: number } & ReturnType<typeof summarizeProfile>> {
  const boundedMs = Math.max(100, Math.min(MAX_CAPTURE_MS, Math.round(durationMs)));
  const captureSession = new Session();
  captureSession.connect();
  try {
    await captureSession.post('Profiler.enable');
    await captureSession.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
    await captureSession.post('Profiler.start');
    await new Promise((resolve) => setTimeout(resolve, boundedMs));
    const { profile } = await captureSession.post('Profiler.stop');
    let file: string | null = null;
    try {
      await fsPromises.mkdir(profileDirectory, { recursive: true });
      file = path.join(profileDirectory, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
      await fsPromises.writeFile(file, JSON.stringify(profile), 'utf-8');
    } catch (error) {
      console.warn('[cpu-profile] could not save the capture:', error);
      file = null;
    }
    return { file, durationMs: boundedMs, ...summarizeProfile(profile) };
  } finally {
    captureSession.disconnect();
  }
}

async function check(): Promise<void> {
  const profilerSession = session;
  const histogram = delayHistogram;
  if (!profilerSession || !histogram || restarting) return;
  const now = Date.now();
  const maxDelayMs = histogram.count > 0 ? histogram.max / NANOSECONDS_PER_MS : 0;
  histogram.reset();
  const slowSpans = slowSyncWorkSince(lastCheckAtMs)
    .filter((span) => span.label !== PROFILER_STOP_LABEL)
    .map((span) => ({ label: span.label, ms: span.ms }));
  lastCheckAtMs = now;
  if (skipNextCheck) {
    skipNextCheck = false;
    return;
  }

  const stalled = maxDelayMs >= DELAY_BACKSTOP_MS || slowSpans.length > 0;
  if (!stalled && now - profileStartedAtMs < MAX_PROFILE_MS) return;
  await restart(profilerSession, stalled ? { detectedAt: now, maxDelayMs, slowSpans } : null);
}

/** Stop the profile, keep it when a stall was found, and start a new one. */
async function restart(
  profilerSession: Session,
  stall: { detectedAt: number; maxDelayMs: number; slowSpans: StallProfileSummary['slowSpans'] } | null,
): Promise<void> {
  restarting = true;
  try {
    // End the window holding the stall, so it is counted; the restart's own
    // window is marked below.
    closeDelayWindow();
    const stopStartedAt = performance.now();
    const { profile } = await profilerSession.post('Profiler.stop');
    const profilerStopMs = performance.now() - stopStartedAt;
    recordSyncSpan(PROFILER_STOP_LABEL, profilerStopMs);
    const kept = stall
      ? {
        summary: {
          detectedAt: new Date(stall.detectedAt).toISOString(),
          maxDelayMs: Math.round(stall.maxDelayMs * 10) / 10,
          slowSpans: stall.slowSpans,
          profilerStopMs: Math.round(profilerStopMs),
          ...summarizeProfile(profile, TAIL_MS),
        },
        serialized: JSON.stringify(profile),
        detectedAt: stall.detectedAt,
      }
      : null;
    if (session === profilerSession) await profilerSession.post('Profiler.start');
    markCurrentDelayWindow(RESTART_NOTE);
    delayHistogram?.reset();
    skipNextCheck = true;
    profileStartedAtMs = Date.now();
    lastCheckAtMs = profileStartedAtMs;

    if (kept) {
      const file = await saveProfile(kept.serialized, kept.detectedAt);
      summaries.push({ ...kept.summary, file });
      while (summaries.length > SUMMARY_RING_SIZE) summaries.shift();
    }
  } catch (error) {
    console.warn('[stall-profiler] restart failed; stopping:', error);
    stopStallProfiler();
  } finally {
    restarting = false;
  }
}

async function saveProfile(serialized: string, detectedAt: number): Promise<string | null> {
  if (!directory) return null;
  try {
    await fsPromises.mkdir(directory, { recursive: true });
    const file = path.join(directory, `main-${new Date(detectedAt).toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
    await fsPromises.writeFile(file, serialized, 'utf-8');
    await pruneProfiles(directory);
    return file;
  } catch (error) {
    console.warn('[stall-profiler] could not save a profile:', error);
    return null;
  }
}

/** Keep the newest stall profiles. On-demand captures (`capture-*`) are left
 *  alone: they sort first, so counting them here deleted a capture before the
 *  caller could read it. */
async function pruneProfiles(profileDirectory: string): Promise<void> {
  const names = (await fsPromises.readdir(profileDirectory))
    .filter((name) => name.startsWith('main-') && name.endsWith('.cpuprofile'))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_FILES))) {
    await fsPromises.rm(path.join(profileDirectory, name), { force: true });
  }
}

/**
 * The heaviest functions of a profile's last `tailMs` (the whole profile when
 * omitted). When the profile marks idle samples, only the longest run of
 * consecutive non-idle samples counts: that run is the stall.
 */
export function summarizeProfile(profile: Profiler.Profile, tailMs?: number): Pick<
  StallProfileSummary, 'longestBusyRunMs' | 'topFrames' | 'heaviestStack'
> {
  const nodesById = new Map<number, Profiler.ProfileNode>();
  const parentById = new Map<number, number>();
  for (const node of profile.nodes) {
    nodesById.set(node.id, node);
    for (const childId of node.children ?? []) parentById.set(childId, node.id);
  }
  const allSamples = profile.samples ?? [];
  const allDeltasMs = (profile.timeDeltas ?? []).map((deltaUs) => deltaUs / 1000);

  // Keep the tail: walk back from the end until `tailMs` is covered.
  let firstIndex = 0;
  if (tailMs !== undefined) {
    let coveredMs = 0;
    firstIndex = allSamples.length;
    while (firstIndex > 0 && coveredMs < tailMs) {
      firstIndex -= 1;
      coveredMs += allDeltasMs[firstIndex] ?? 0;
    }
  }
  const samples = allSamples.slice(firstIndex);
  const deltasMs = allDeltasMs.slice(firstIndex);
  const isIdle = (nodeId: number): boolean => nodesById.get(nodeId)?.callFrame.functionName === '(idle)';

  let runStart = 0;
  let runEnd = samples.length;
  let longestBusyRunMs: number | null = null;
  if (samples.some(isIdle)) {
    let bestMs = 0;
    let currentStart = -1;
    let currentMs = 0;
    for (let index = 0; index <= samples.length; index++) {
      const busy = index < samples.length && !isIdle(samples[index]);
      if (busy) {
        if (currentStart < 0) {
          currentStart = index;
          currentMs = 0;
        }
        currentMs += deltasMs[index] ?? 0;
      } else if (currentStart >= 0) {
        if (currentMs > bestMs) {
          bestMs = currentMs;
          runStart = currentStart;
          runEnd = index;
        }
        currentStart = -1;
      }
    }
    longestBusyRunMs = Math.round(bestMs * 10) / 10;
  }

  const selfMsByKey = new Map<string, StallFrame & { nodeId: number }>();
  for (let index = runStart; index < runEnd; index++) {
    const node = nodesById.get(samples[index]);
    if (!node || node.callFrame.functionName === '(idle)' || node.callFrame.functionName === '(root)') continue;
    const location = frameLocation(node.callFrame);
    const functionName = node.callFrame.functionName || '(anonymous)';
    const key = `${functionName}@${location}`;
    const entry = selfMsByKey.get(key) ?? { functionName, location, selfMs: 0, nodeId: node.id };
    entry.selfMs += deltasMs[index] ?? 0;
    selfMsByKey.set(key, entry);
  }
  const ranked = [...selfMsByKey.values()].sort((left, right) => right.selfMs - left.selfMs);

  const heaviestStack: string[] = [];
  if (ranked.length > 0) {
    let nodeId: number | undefined = ranked[0].nodeId;
    while (nodeId !== undefined && heaviestStack.length < STACK_DEPTH) {
      const node = nodesById.get(nodeId);
      if (!node || node.callFrame.functionName === '(root)') break;
      heaviestStack.unshift(`${node.callFrame.functionName || '(anonymous)'} ${frameLocation(node.callFrame)}`.trim());
      nodeId = parentById.get(nodeId);
    }
  }

  return {
    longestBusyRunMs,
    topFrames: ranked.slice(0, TOP_FRAMES).map(({ functionName, location, selfMs }) => ({
      functionName,
      location,
      selfMs: Math.round(selfMs * 10) / 10,
    })),
    heaviestStack,
  };
}

function frameLocation(callFrame: Profiler.ProfileNode['callFrame']): string {
  if (!callFrame.url) return '';
  const segments = callFrame.url.replace(/\\/g, '/').split('/');
  return `${segments.slice(-2).join('/')}:${callFrame.lineNumber + 1}`;
}
