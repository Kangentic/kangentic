/**
 * A CPU profile of the main process that is saved whenever main stalls (dev
 * builds only, behind `developer.stallProfiler`).
 *
 * Labelled spans (`timeSyncWork`) name the work someone thought to wrap; a
 * stall in anything else shows up in the lag monitor as a duration with no
 * cause. This profiler closes that gap without anyone adding a label: V8's
 * sampling profiler runs over the whole main thread, a check every
 * `CHECK_MS` looks for a stall, and on one the profile is saved as a
 * `.cpuprofile` and its stall is summarised into the lag report.
 *
 * Starting a profiler from nothing is the expensive part: V8 walks the whole
 * heap to log every compiled function. That was 43 to 60 ms of main on
 * 2026-09-30 and 185 to 276 ms on 2026-11-24, when each save and each five
 * minute restart paid it and turned a 25 ms delay into a 200 ms stall. V8 only
 * pays it when the profiler goes from no profile to one, so two profiles run
 * at all times, staggered by `ROLL_MS`, and a new one always starts before the
 * older one stops. Measured that way, a start costs 0.02 to 0.08 ms and a stop
 * 0.03 to 0.23 ms. The cold start is paid once, when the profiler is switched
 * on.
 *
 * `v8.startCpuProfile()` is the one API that lets two profiles overlap on one
 * profiler, and its `stop()` returns the `.cpuprofile` text, which is written
 * to disk as it is. Only the summary parses it, on a later turn.
 *
 * A save closes the lag monitor's delay window first, so the stall it reacted
 * to sits in a window of its own, and notes the window that follows
 * `stall-profiler`. A roll notes nothing. Every piece of the profiler's own
 * work is a `diag:stall-profiler:*` span, which is how the diagnostics budget
 * (`diagnostics-budget.ts`) checks that it stays cheap.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as v8 from 'node:v8';
import type { Profiler } from 'node:inspector';
import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks';
import {
  closeDelayWindow,
  DELAY_RESOLUTION_MS,
  markCurrentDelayWindow,
  NANOSECONDS_PER_MS,
  recordSyncSpan,
  slowSyncWorkSince,
  SPIKE_THRESHOLD_MS,
} from '../../main/diagnostics/event-loop-lag';

const CHECK_MS = 1_000;
/**
 * A delay this long is a stall worth a profile: the lag monitor's own spike
 * line. Readings under about 65 ms were timer noise in the 2026-11-24 data (a
 * 25.6 ms delay over a 17 ms busy run, 45.2 ms over 3 ms); from there up the
 * delay and the profile's busy run agreed.
 */
export const STALL_THRESHOLD_MS = SPIKE_THRESHOLD_MS;
/**
 * How far apart the two running profiles start. A saved profile covers up to
 * two of these. The first one after a start, or one saved soon after another,
 * covers less.
 */
export const ROLL_MS = 15_000;
/** Stalls this close together share one saved profile. */
export const SAVE_COOLDOWN_MS = 5_000;
/** The summary reaches back this far before the check that preceded the stall. */
const TAIL_MARGIN_MS = 1_000;
/** The least of a profile that is summarised. */
const MIN_TAIL_MS = 3_000;
/**
 * How far past the profiler's own block a delay reading may sit and still be
 * that block: the histogram's timer adds up to one 15.6 ms Windows tick at
 * each end. The Windows figure is used on every platform. On a 1 ms timer it
 * excuses up to 28 ms too much, and only after an own block of 43 ms or more,
 * which the diagnostics budget already reports as a hold.
 */
const OWN_BLOCK_SLACK_MS = 32;
/** Profiles kept on disk; older ones are removed. Each covers about 30 s at most. */
const KEEP_FILES = 60;
const SUMMARY_RING_SIZE = 50;
const TOP_FRAMES = 8;
const STACK_DEPTH = 12;
const OWN_LABEL_PREFIX = 'diag:stall-profiler:';
const START_LABEL = `${OWN_LABEL_PREFIX}start`;
const ROLL_LABEL = `${OWN_LABEL_PREFIX}roll`;
const SAVE_LABEL = `${OWN_LABEL_PREFIX}save`;
const SUMMARY_LABEL = `${OWN_LABEL_PREFIX}summary`;
/** The note on the delay window that follows a save. */
export const SAVE_NOTE = 'stall-profiler';

export interface StallFrame {
  functionName: string;
  /** `file:line`, with the file reduced to its last two path segments. */
  location: string;
  selfMs: number;
}

export interface StallProfileSummary {
  /** UTC ISO timestamp of the check that found the stall. */
  detectedAt: string;
  /** The longest event-loop delay seen in the checks this profile covers. */
  maxDelayMs: number;
  /** Labelled spans of 16 ms or more in those checks. */
  slowSpans: Array<{ label: string; ms: number }>;
  /** How many one-second checks found a stall before this profile was saved. */
  stalledChecks: number;
  /** The longest run of consecutive non-idle samples in the tail, in ms. */
  longestBusyRunMs: number | null;
  /** The functions with the most self time inside that run. */
  topFrames: StallFrame[];
  /** The stack of the top frame, root first. */
  heaviestStack: string[];
  /** How long the saved profile ran, in ms. */
  profileMs: number;
  /** How long starting the next profile and stopping this one held main. */
  saveMs: number;
  /** How long parsing and summarising the profile held main, on a later turn. */
  summaryMs: number;
  /** The saved `.cpuprofile`, or null when the write failed. */
  file: string | null;
}

/** A CPU profile that is recording. `stop()` ends it and returns its `.cpuprofile` JSON. */
export interface RunningProfile {
  stop(): string;
}

export interface StallProfilerDependencies {
  /** Start one more profile on the shared profiler. */
  startProfile: () => RunningProfile;
  /**
   * The longest event-loop delay since the reading was last reset, in ms. It
   * must start measuring after `start()` returns, so the cold start is never
   * in a reading.
   */
  readMaxDelayMs: () => number;
  /** Start the delay reading over. */
  resetDelayReading: () => void;
  /** Epoch milliseconds. */
  now: () => number;
  /** Write a stall's profile text and return its path, or null when it could not be written. */
  writeProfile: (detectedAtMs: number, text: string) => Promise<string | null>;
  /** Told each finished summary, after its file is written. */
  onSummary: (summary: StallProfileSummary) => void;
  /** End the lag monitor's current delay window now (`closeDelayWindow`). */
  closeDelayWindow: () => void;
  /** Give the lag monitor's open delay window a note (`markCurrentDelayWindow`). */
  markDelayWindow: (note: string) => void;
  /** A monotonic clock in ms, for timing the profiler's own work. */
  elapsedNow: () => number;
}

interface LiveProfile {
  profile: RunningProfile;
  startedAtMs: number;
}

/** Stalls found since the last save, waiting for the next one. */
interface PendingStall {
  detectedAtMs: number;
  /** The check before the first stalled one: the stall began after it. */
  windowStartMs: number;
  maxDelayMs: number;
  slowSpans: StallProfileSummary['slowSpans'];
  stalledChecks: number;
}

/**
 * Two overlapping profiles, a stall check, and what happens on a stall. The
 * timer, the delay histogram and the disk are the caller's (see
 * `startStallProfiler`), so a test drives `check()` with its own clock.
 */
export class StallProfiler {
  private older: LiveProfile | null = null;
  private newer: LiveProfile | null = null;
  private lastCheckAtMs = 0;
  /** The last roll or save: the next roll is due `ROLL_MS` after it. */
  private lastTurnoverAtMs = 0;
  private lastSaveAtMs = Number.NEGATIVE_INFINITY;
  private pending: PendingStall | null = null;
  /**
   * The longest block the profiler itself put on main since the last check.
   * The next check's delay reading may be that block, so a reading no longer
   * than it (plus the timer's slack) is not a stall. A longer one still is.
   */
  private ownBlockMs = 0;
  private readonly summaries: StallProfileSummary[] = [];

  constructor(private readonly dependencies: StallProfilerDependencies) {}

  get running(): boolean {
    return this.older !== null;
  }

  getSummaries(): StallProfileSummary[] {
    return [...this.summaries];
  }

  /** Start both profiles. The first pays the cold start. Idempotent. */
  start(): void {
    if (this.older) return;
    // The cold start's block belongs to the profiler, not the app, and closing
    // the lag monitor's delay window right before it keeps it out of the app's
    // numbers. Closing a window resets the monitor's histogram, and a reset
    // histogram has no baseline: it records nothing until its timer has fired
    // once, so a block that follows the reset with no loop turn between is
    // never recorded (measured on Node 24.22: a 200 ms block read as 16 ms).
    // The start's cost is on record as the `diag:stall-profiler:start` span.
    this.dependencies.closeDelayWindow();
    const startedAt = this.dependencies.elapsedNow();
    const first = this.dependencies.startProfile();
    recordSyncSpan(START_LABEL, this.dependencies.elapsedNow() - startedAt);
    const now = this.dependencies.now();
    this.older = { profile: first, startedAtMs: now };
    this.newer = { profile: this.dependencies.startProfile(), startedAtMs: now };
    this.lastCheckAtMs = now;
    this.lastTurnoverAtMs = now;
    // No own block is noted for the cold start: the delay reader is switched
    // on after this returns, so its first reading never holds the start.
  }

  /** Remember a block the profiler itself put on main, for the next check to excuse. */
  private noteOwnBlock(heldMs: number): void {
    this.ownBlockMs = Math.max(this.ownBlockMs, heldMs);
  }

  /** Stop both profiles and forget any stall not yet saved. Synchronous, for the quit path. */
  stop(): void {
    for (const live of [this.older, this.newer]) {
      try {
        live?.profile.stop();
      } catch {
        // Already stopped, or the profiler is gone with the process.
      }
    }
    this.older = null;
    this.newer = null;
    this.pending = null;
  }

  /** Look for a stall since the last check, then save, roll, or do nothing. */
  check(): void {
    if (!this.older || !this.newer) return;
    const now = this.dependencies.now();
    const maxDelayMs = this.dependencies.readMaxDelayMs();
    const windowStartMs = this.lastCheckAtMs;
    this.lastCheckAtMs = now;
    const ownBlockMs = this.ownBlockMs;
    this.ownBlockMs = 0;
    if (maxDelayMs >= STALL_THRESHOLD_MS) {
      // The reading starts over only here, once it has reported a delay. A
      // reset costs the histogram its baseline, so one on every check hid any
      // stall that began within a timer tick of the check: 15.6 ms of every
      // second on Windows.
      this.dependencies.resetDelayReading();
      const isOwnBlock = ownBlockMs > 0 && maxDelayMs <= ownBlockMs + OWN_BLOCK_SLACK_MS;
      if (!isOwnBlock) this.notePendingStall(now, windowStartMs, maxDelayMs);
    }

    if (this.pending) {
      // No roll while a stall waits: the older profile is the one that holds it.
      if (now - this.lastSaveAtMs >= SAVE_COOLDOWN_MS) this.save(now, this.pending);
      return;
    }
    if (now - this.lastTurnoverAtMs >= ROLL_MS) this.roll(now);
  }

  private notePendingStall(now: number, windowStartMs: number, maxDelayMs: number): void {
    const slowSpans = slowSyncWorkSince(windowStartMs)
      .filter((span) => !span.label.startsWith(OWN_LABEL_PREFIX))
      .map((span) => ({ label: span.label, ms: span.ms }));
    if (!this.pending) {
      this.pending = { detectedAtMs: now, windowStartMs, maxDelayMs, slowSpans, stalledChecks: 1 };
      return;
    }
    this.pending.maxDelayMs = Math.max(this.pending.maxDelayMs, maxDelayMs);
    this.pending.slowSpans.push(...slowSpans);
    this.pending.stalledChecks += 1;
  }

  /**
   * Start the next profile, then stop the older one. In that order, always: a
   * stop that leaves no profile running tears the profiler down, and the next
   * start pays the heap walk again. Returns the stopped profile's text and how
   * long the swap held main, or null when it failed and the profiler stopped.
   */
  private turnOver(now: number): { text: string; stopped: LiveProfile; heldMs: number } | null {
    const stopped = this.older;
    const kept = this.newer;
    if (!stopped || !kept) return null;
    const startedAt = this.dependencies.elapsedNow();
    let next: RunningProfile | null = null;
    try {
      next = this.dependencies.startProfile();
      const text = stopped.profile.stop();
      this.older = kept;
      this.newer = { profile: next, startedAtMs: now };
      this.lastTurnoverAtMs = now;
      const heldMs = this.dependencies.elapsedNow() - startedAt;
      this.noteOwnBlock(heldMs);
      return { text, stopped, heldMs };
    } catch (error) {
      console.warn('[stall-profiler] could not roll the profile; stopping:', error);
      // The profile just started is in neither slot yet, so `stop()` below
      // would miss it and it would record until the process ends.
      try {
        next?.stop();
      } catch {
        // Already stopped, or the profiler is gone with the process.
      }
      this.stop();
      return null;
    }
  }

  private roll(now: number): void {
    const turned = this.turnOver(now);
    if (turned) recordSyncSpan(ROLL_LABEL, turned.heldMs);
  }

  private save(now: number, stall: PendingStall): void {
    this.pending = null;
    // End the window holding the stall, so it is counted; the window holding
    // the save is marked below.
    this.dependencies.closeDelayWindow();
    const turned = this.turnOver(now);
    if (!turned) return;
    recordSyncSpan(SAVE_LABEL, turned.heldMs);
    this.dependencies.markDelayWindow(SAVE_NOTE);
    this.lastSaveAtMs = now;
    const tailMs = Math.max(MIN_TAIL_MS, now - stall.windowStartMs + TAIL_MARGIN_MS);
    void this.finishSave(stall, turned.text, {
      saveMs: turned.heldMs,
      profileMs: now - turned.stopped.startedAtMs,
      tailMs,
    });
  }

  /** Off the stall's own turn: write the text as it is, then parse it for the summary. */
  private async finishSave(
    stall: PendingStall,
    text: string,
    timing: { saveMs: number; profileMs: number; tailMs: number },
  ): Promise<void> {
    const file = await this.dependencies.writeProfile(stall.detectedAtMs, text);
    const summaryStartedAt = this.dependencies.elapsedNow();
    let parts: ReturnType<typeof summarizeProfile> = { longestBusyRunMs: null, topFrames: [], heaviestStack: [] };
    try {
      parts = summarizeProfile(JSON.parse(text) as Profiler.Profile, timing.tailMs);
    } catch (error) {
      console.warn('[stall-profiler] could not summarise a profile:', error);
    }
    const summaryMs = this.dependencies.elapsedNow() - summaryStartedAt;
    recordSyncSpan(SUMMARY_LABEL, summaryMs);
    this.noteOwnBlock(summaryMs);
    const summary: StallProfileSummary = {
      detectedAt: new Date(stall.detectedAtMs).toISOString(),
      maxDelayMs: roundTenth(stall.maxDelayMs),
      slowSpans: stall.slowSpans,
      stalledChecks: stall.stalledChecks,
      ...parts,
      profileMs: Math.round(timing.profileMs),
      saveMs: roundTenth(timing.saveMs),
      summaryMs: roundTenth(summaryMs),
      file,
    };
    this.summaries.push(summary);
    while (this.summaries.length > SUMMARY_RING_SIZE) this.summaries.shift();
    try {
      this.dependencies.onSummary(summary);
    } catch (error) {
      console.warn('[stall-profiler] the summary listener threw:', error);
    }
  }
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

let activeProfiler: StallProfiler | null = null;
let delayHistogram: ELDHistogram | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let summaryListener: ((summary: StallProfileSummary) => void) | null = null;
/** Summaries of a profiler that was switched off, so the report keeps them for the run. */
const earlierSummaries: StallProfileSummary[] = [];

/** Told each stall summary as it is finished. The lag journal writes them to disk. */
export function setStallSummaryListener(listener: ((summary: StallProfileSummary) => void) | null): void {
  summaryListener = listener;
}

/** Start profiling, saving stall profiles under `profileDirectory`. Idempotent. */
export function startStallProfiler(profileDirectory: string): void {
  if (activeProfiler?.running) return;
  // One that stopped itself on a failed roll: clear its timer before starting over.
  if (activeProfiler) stopStallProfiler();
  if (typeof v8.startCpuProfile !== 'function') {
    console.warn('[stall-profiler] this runtime has no v8.startCpuProfile; not started');
    return;
  }
  const histogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  const profiler = new StallProfiler({
    startProfile: () => v8.startCpuProfile(),
    readMaxDelayMs: () => (histogram.count > 0 ? histogram.max / NANOSECONDS_PER_MS : 0),
    resetDelayReading: () => histogram.reset(),
    now: () => Date.now(),
    writeProfile: (detectedAtMs, text) => saveProfile(profileDirectory, detectedAtMs, text),
    onSummary: (summary) => {
      // A save still writing its file when the profiler was switched off
      // finishes after `stopStallProfiler` copied the summaries. Keep it for
      // the report too.
      if (activeProfiler !== profiler) {
        earlierSummaries.push(summary);
        while (earlierSummaries.length > SUMMARY_RING_SIZE) earlierSummaries.shift();
      }
      summaryListener?.(summary);
    },
    closeDelayWindow,
    markDelayWindow: markCurrentDelayWindow,
    elapsedNow: () => performance.now(),
  });
  try {
    profiler.start();
  } catch (error) {
    console.warn('[stall-profiler] could not start:', error);
    profiler.stop();
    return;
  }
  histogram.enable();
  delayHistogram = histogram;
  activeProfiler = profiler;
  checkTimer = setInterval(() => profiler.check(), CHECK_MS);
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
  if (activeProfiler) {
    earlierSummaries.push(...activeProfiler.getSummaries());
    while (earlierSummaries.length > SUMMARY_RING_SIZE) earlierSummaries.shift();
    activeProfiler.stop();
    activeProfiler = null;
  }
}

export function isStallProfilerRunning(): boolean {
  return activeProfiler?.running === true;
}

export function getStallProfiles(): StallProfileSummary[] {
  return [...earlierSummaries, ...(activeProfiler?.getSummaries() ?? [])].slice(-SUMMARY_RING_SIZE);
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
 * spans rather than one stall the stall profiler would keep. It shares the
 * stall profiler's profiler, so starting is free while that runs, and costs
 * the cold start inside the capture when it does not.
 */
export async function captureCpuProfile(
  profileDirectory: string,
  durationMs: number,
): Promise<{ file: string | null; durationMs: number } & ReturnType<typeof summarizeProfile>> {
  const boundedMs = Math.max(100, Math.min(MAX_CAPTURE_MS, Math.round(durationMs)));
  const capture = v8.startCpuProfile();
  let text: string;
  try {
    await new Promise((resolve) => setTimeout(resolve, boundedMs));
  } finally {
    text = capture.stop();
  }
  const file = await saveCapture(profileDirectory, text);
  return { file, durationMs: boundedMs, ...summarizeProfile(JSON.parse(text) as Profiler.Profile) };
}

async function saveCapture(profileDirectory: string, text: string): Promise<string | null> {
  try {
    await fsPromises.mkdir(profileDirectory, { recursive: true });
    const file = path.join(profileDirectory, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
    await fsPromises.writeFile(file, text, 'utf-8');
    return file;
  } catch (error) {
    console.warn('[cpu-profile] could not save the capture:', error);
    return null;
  }
}

async function saveProfile(profileDirectory: string, detectedAtMs: number, text: string): Promise<string | null> {
  let file: string;
  try {
    await fsPromises.mkdir(profileDirectory, { recursive: true });
    file = path.join(profileDirectory, `main-${new Date(detectedAtMs).toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
    await fsPromises.writeFile(file, text, 'utf-8');
  } catch (error) {
    console.warn('[stall-profiler] could not save a profile:', error);
    return null;
  }
  // The profile is on disk by now. A prune that fails must not report it unsaved.
  await pruneProfiles(profileDirectory);
  return file;
}

/** Keep the newest stall profiles. On-demand captures (`capture-*`) are left
 *  alone: they sort first, so counting them here deleted a capture before the
 *  caller could read it. Never rejects. */
async function pruneProfiles(profileDirectory: string): Promise<void> {
  let names: string[];
  try {
    names = (await fsPromises.readdir(profileDirectory))
      .filter((name) => name.startsWith('main-') && name.endsWith('.cpuprofile'))
      .sort();
  } catch (error) {
    console.warn('[stall-profiler] could not list old profiles:', error);
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_FILES))) {
    try {
      await fsPromises.rm(path.join(profileDirectory, name), { force: true });
    } catch {
      // Held open by a scanner or a profile viewer (EBUSY or EPERM on
      // Windows). One file that will not go must not keep the rest, and the
      // next save tries it again.
    }
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
    longestBusyRunMs = roundTenth(bestMs);
  }

  const selfMsByKey = new Map<string, StallFrame & { nodeId: number }>();
  for (let index = runStart; index < runEnd; index++) {
    const node = nodesById.get(samples[index]);
    if (!node || node.callFrame.functionName === '(idle)' || node.callFrame.functionName === '(root)') continue;
    // A profile opens inside the call that started it. After a cold start
    // that is tens of ms of the profiler's own heap walk, which would top the
    // ranking of the launch's first stall. It stays in the run's length, since
    // main was held for it, and out of the functions the stall is blamed on.
    if (isProfilerStartFrame(node.callFrame)) continue;
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
      selfMs: roundTenth(selfMs),
    })),
    heaviestStack,
  };
}

/**
 * Where a thread spent its busy time over a whole profile: the share of
 * samples that were not idle, and the functions with the most self time
 * across all of them. Unlike `summarizeProfile`, which keeps only the longest
 * busy run (that run is a stall), this adds up every busy sample, because a
 * busy terminal host is many short slices, not one block. The scroll-latency
 * route summarizes the pty host's profile with it.
 */
export function summarizeBusyProfile(profile: Profiler.Profile, topCount = 15): {
  sampledMs: number;
  busyMs: number;
  topFrames: StallFrame[];
} {
  const nodesById = new Map<number, Profiler.ProfileNode>();
  for (const node of profile.nodes) nodesById.set(node.id, node);
  const samples = profile.samples ?? [];
  const deltasMs = (profile.timeDeltas ?? []).map((deltaUs) => deltaUs / 1000);
  let sampledMs = 0;
  let busyMs = 0;
  const selfMsByKey = new Map<string, StallFrame>();
  samples.forEach((nodeId, index) => {
    const deltaMs = deltasMs[index] ?? 0;
    sampledMs += deltaMs;
    const node = nodesById.get(nodeId);
    const functionName = node?.callFrame.functionName ?? '';
    // `(program)` (VM work outside JS) and `(garbage collector)` stay in: both hold the thread.
    if (!node || functionName === '(idle)' || functionName === '(root)') return;
    busyMs += deltaMs;
    const location = frameLocation(node.callFrame);
    const name = functionName || '(anonymous)';
    const key = `${name}@${location}`;
    const entry = selfMsByKey.get(key) ?? { functionName: name, location, selfMs: 0 };
    entry.selfMs += deltaMs;
    selfMsByKey.set(key, entry);
  });
  const topFrames = [...selfMsByKey.values()]
    .sort((left, right) => right.selfMs - left.selfMs)
    .slice(0, topCount)
    .map((frame) => ({ ...frame, selfMs: roundTenth(frame.selfMs) }));
  return { sampledMs: roundTenth(sampledMs), busyMs: roundTenth(busyMs), topFrames };
}

/** The call that starts a profile, `v8.startCpuProfile`. */
function isProfilerStartFrame(callFrame: Profiler.ProfileNode['callFrame']): boolean {
  return callFrame.functionName === 'startCpuProfile' && callFrame.url === 'node:v8';
}

function frameLocation(callFrame: Profiler.ProfileNode['callFrame']): string {
  if (!callFrame.url) return '';
  const segments = callFrame.url.replace(/\\/g, '/').split('/');
  return `${segments.slice(-2).join('/')}:${callFrame.lineNumber + 1}`;
}
