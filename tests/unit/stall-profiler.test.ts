import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Profiler } from 'node:inspector';
import { recordSyncSpan, relaySlowSyncSpans } from '../../src/main/diagnostics/event-loop-lag';
import {
  ROLL_MS,
  SAVE_COOLDOWN_MS,
  STALL_THRESHOLD_MS,
  StallProfiler,
  summarizeBusyProfile,
  summarizeProfile,
  type RunningProfile,
  type StallProfileSummary,
} from '../../src/devtools/main/stall-profiler';

/** The longest busy run of the real profile fixture, as `summarizeProfile` returned it. */
const LONGEST_BUSY_RUN_OF_REAL_PROFILE_MS = 69.4;

/** root -> (idle); root -> dispatch -> parseTranscript. */
function profileOf(samples: number[]): Profiler.Profile {
  const frame = (functionName: string, url: string, lineNumber: number) => ({
    functionName, scriptId: '1', url, lineNumber, columnNumber: 0,
  });
  return {
    nodes: [
      { id: 1, callFrame: frame('(root)', '', 0), children: [2, 3] },
      { id: 2, callFrame: frame('(idle)', '', 0) },
      { id: 3, callFrame: frame('dispatch', 'file:///app/main/ipc/router.js', 9), children: [4] },
      { id: 4, callFrame: frame('parseTranscript', 'file:///app/main/agent/transcript-parser.js', 41) },
    ],
    startTime: 0,
    endTime: samples.length * 1000,
    samples,
    // One millisecond between samples.
    timeDeltas: samples.map(() => 1000),
  };
}

describe('summarizeProfile', () => {
  it('names the heaviest functions of the longest busy run, and its stack', () => {
    // A 4 ms busy run (three samples in the parser, one in its caller), and a
    // shorter 1 ms one later.
    const summary = summarizeProfile(profileOf([2, 2, 4, 4, 4, 3, 2, 4, 2]));

    expect(summary.longestBusyRunMs).toBe(4);
    expect(summary.topFrames).toEqual([
      { functionName: 'parseTranscript', location: 'agent/transcript-parser.js:42', selfMs: 3 },
      { functionName: 'dispatch', location: 'ipc/router.js:10', selfMs: 1 },
    ]);
    expect(summary.heaviestStack).toEqual([
      'dispatch ipc/router.js:10',
      'parseTranscript agent/transcript-parser.js:42',
    ]);
  });

  it('summarises only the tail it is given, where the stall happened', () => {
    // An early 3 ms busy run in the caller, then a 2 ms one in the parser at
    // the end. Only the last 4 ms are the tail.
    const summary = summarizeProfile(profileOf([3, 3, 3, 2, 2, 2, 2, 4, 4, 2]), 4);

    expect(summary.longestBusyRunMs).toBe(2);
    expect(summary.topFrames.map((frame) => frame.functionName)).toEqual(['parseTranscript']);
  });

  it('keeps the profiler\'s own start out of the functions a stall is blamed on, and in the run\'s length', () => {
    // A launch's first profile opens inside v8.startCpuProfile: 59 ms of the
    // profiler's heap walk, then the boot work that was the real stall.
    const startFrame = { functionName: 'startCpuProfile', scriptId: '9', url: 'node:v8', lineNumber: 196, columnNumber: 0 };
    const base = profileOf([5, 5, 5, 4, 4, 2]);
    const profile: Profiler.Profile = {
      ...base,
      nodes: [
        { ...base.nodes[0], children: [2, 3, 5] },
        ...base.nodes.slice(1),
        { id: 5, callFrame: startFrame },
      ],
    };

    const summary = summarizeProfile(profile);

    expect(summary.longestBusyRunMs).toBe(5);
    expect(summary.topFrames.map((frame) => frame.functionName)).toEqual(['parseTranscript']);
    expect(summary.heaviestStack).toEqual([
      'dispatch ipc/router.js:10',
      'parseTranscript agent/transcript-parser.js:42',
    ]);
  });

  /**
   * `v8-cpu-profile-node-24.15.0.cpuprofile` is the text `v8.startCpuProfile().stop()`
   * returned on Node 24.15.0, for a script that started a profile, idled
   * about 40 ms, then ran a busy `dispatch` > `parseTranscript` > `burn` loop
   * and stopped. The only edit to V8's output is the capture script's own
   * frame URLs, rewritten to `file:///mock/app/capture-cpuprofile.mjs`. Every
   * other profile in this file is hand-built, so these two read the real shape.
   */
  const REAL_PROFILE_PATH = path.join(__dirname, '..', 'fixtures', 'v8-cpu-profile-node-24.15.0.cpuprofile');

  function readRealProfile(): Profiler.Profile {
    return JSON.parse(fs.readFileSync(REAL_PROFILE_PATH, 'utf-8')) as Profiler.Profile;
  }

  it('summarises a profile V8 really wrote: the burn stack is blamed, the profiler\'s own start is not', () => {
    const summary = summarizeProfile(readRealProfile());

    expect(summary.longestBusyRunMs).toBe(LONGEST_BUSY_RUN_OF_REAL_PROFILE_MS);
    const topNames = summary.topFrames.map((frame) => frame.functionName);
    expect(topNames).toContain('burn');
    for (const unblamed of ['startCpuProfile', '(idle)', '(root)']) {
      expect(topNames).not.toContain(unblamed);
    }
    const stackNames = summary.heaviestStack.map((entry) => entry.split(' ')[0]);
    const dispatchAt = stackNames.indexOf('dispatch');
    const parseAt = stackNames.indexOf('parseTranscript');
    const burnAt = stackNames.indexOf('burn');
    expect(dispatchAt).toBeGreaterThanOrEqual(0);
    expect(parseAt).toBeGreaterThan(dispatchAt);
    expect(burnAt).toBeGreaterThan(parseAt);
  });

  it('keeps V8\'s real cold-start frame in the run\'s length and out of the functions blamed for it', () => {
    // Sample 0 is the real `startCpuProfile` frame in `node:v8` (a 52.965 ms
    // delta: the profiler's cold start), then 26 idle samples. Kept alone, the
    // start is the longest busy run. This goes red if V8 names that frame
    // anything `isProfilerStartFrame` does not match.
    const profile = readRealProfile();
    const coldStartOnly: Profiler.Profile = {
      ...profile,
      samples: profile.samples.slice(0, 27),
      timeDeltas: profile.timeDeltas.slice(0, 27),
    };

    const summary = summarizeProfile(coldStartOnly);

    expect(summary.longestBusyRunMs).toBe(53);
    expect(summary.topFrames).toEqual([]);
    expect(summary.heaviestStack).toEqual([]);
  });

  it('counts the whole window when the profile marks no idle samples', () => {
    const summary = summarizeProfile(profileOf([4, 3, 4]));

    expect(summary.longestBusyRunMs).toBeNull();
    expect(summary.topFrames.map((frame) => [frame.functionName, frame.selfMs])).toEqual([
      ['parseTranscript', 2],
      ['dispatch', 1],
    ]);
  });
});

describe('summarizeBusyProfile', () => {
  it('adds up every busy sample and ranks functions by self time', () => {
    const profile: Profiler.Profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, children: [2, 3, 4] },
        { id: 2, callFrame: { functionName: '(idle)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 } },
        { id: 3, callFrame: { functionName: 'parse', scriptId: '1', url: 'file:///app/node_modules/xterm-headless.js', lineNumber: 9, columnNumber: 0 } },
        { id: 4, callFrame: { functionName: 'spawn', scriptId: '2', url: 'node:child_process', lineNumber: 0, columnNumber: 0 } },
      ],
      startTime: 0,
      endTime: 6000,
      samples: [2, 3, 3, 2, 3, 4],
      timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000],
    };
    const summary = summarizeBusyProfile(profile);
    expect(summary.sampledMs).toBe(6);
    expect(summary.busyMs).toBe(4);
    expect(summary.topFrames[0]).toEqual({ functionName: 'parse', location: 'node_modules/xterm-headless.js:10', selfMs: 3 });
    expect(summary.topFrames[1].functionName).toBe('spawn');
  });

  it('keeps every busy run, where summarizeProfile keeps only the longest', () => {
    // Two busy runs split by idle: 3 ms in the parser, then 2 ms in its caller.
    const summary = summarizeBusyProfile(profileOf([4, 4, 4, 2, 3, 3, 2]));

    expect(summary.busyMs).toBe(5);
    expect(summary.topFrames.map((frame) => [frame.functionName, frame.selfMs])).toEqual([
      ['parseTranscript', 3],
      ['dispatch', 2],
    ]);
  });
});

/**
 * The rolling profiler, driven with a fake profile source and clock.
 *
 * What it protects: V8 walks the whole heap whenever a profiler starts with no
 * profile running (185 to 276 ms on the dogfood app's heap). The profiler
 * that shipped before stopped its only profile on every save and every five
 * minutes, so each one froze the app it was measuring.
 */
describe('StallProfiler', () => {
  const CHECK_MS = 1_000;

  interface HarnessOptions {
    profileText?: () => string;
    /** How long the first start holds main: V8's heap walk. */
    coldStartMs?: number;
    /** How long each later stop holds main. */
    stopMs?: number;
  }

  function createHarness(options: HarnessOptions = {}) {
    const profileText = options.profileText ?? (() => JSON.stringify(profileOf([2, 4, 2])));
    let nowMs = Date.UTC(2026, 10, 24, 4, 0, 0);
    let elapsedMs = 0;
    /** The longest delay since the profiler last reset the reading, as the histogram holds it. */
    let delayReadingMs = 0;
    let delayResets = 0;
    let liveProfiles = 0;
    let startedProfiles = 0;
    /** The live profile count right after each stop: zero means the profiler tore down. */
    const liveAfterStop: number[] = [];
    /** Every call into the lag monitor's delay windows, in order. */
    const windowCalls: string[] = [];
    const writeProfile = vi.fn(async (_detectedAtMs: number, _text: string): Promise<string | null> => 'saved.cpuprofile');
    const summaries: StallProfileSummary[] = [];
    const profiler = new StallProfiler({
      startProfile: (): RunningProfile => {
        if (startedProfiles === 0) elapsedMs += options.coldStartMs ?? 0;
        liveProfiles += 1;
        startedProfiles += 1;
        return {
          stop: () => {
            elapsedMs += options.stopMs ?? 0;
            liveProfiles -= 1;
            liveAfterStop.push(liveProfiles);
            return profileText();
          },
        };
      },
      readMaxDelayMs: () => delayReadingMs,
      resetDelayReading: () => {
        delayReadingMs = 0;
        delayResets += 1;
      },
      now: () => nowMs,
      elapsedNow: () => elapsedMs,
      writeProfile,
      onSummary: (summary) => summaries.push(summary),
      closeDelayWindow: () => windowCalls.push('close'),
      markDelayWindow: (note) => windowCalls.push(`mark:${note}`),
    });
    /**
     * One check, `sinceLastCheckMs` after the last, in a second whose longest
     * event-loop delay was `delayMs`. The reading keeps its maximum until the
     * profiler resets it, as the real histogram does.
     */
    const check = (delayMs = 0, sinceLastCheckMs = CHECK_MS): void => {
      nowMs += sinceLastCheckMs;
      delayReadingMs = Math.max(delayReadingMs, delayMs);
      profiler.check();
    };
    /** Start, and spend the one check the cold start's own block is excused from. */
    const startAndSettle = (): void => {
      profiler.start();
      check();
    };
    return {
      profiler,
      check,
      startAndSettle,
      writeProfile,
      summaries,
      liveAfterStop,
      windowCalls,
      delayResets: () => delayResets,
      liveProfiles: () => liveProfiles,
      startedProfiles: () => startedProfiles,
    };
  }

  it('never stops its last running profile, across rolls and saves', () => {
    const harness = createHarness();
    harness.startAndSettle();
    // Two minutes: eight rolls, with a stall every twenty seconds.
    for (let second = 1; second <= 120; second++) {
      harness.check(second % 20 === 0 ? 150 : 0);
    }

    expect(harness.liveAfterStop.length).toBeGreaterThan(8);
    // Two stay running after every stop: the next one started first.
    expect(Math.min(...harness.liveAfterStop)).toBe(2);
    expect(harness.liveProfiles()).toBe(2);
  });

  it('saves nothing for a delay under the stall line, and saves at it', () => {
    const harness = createHarness();
    harness.startAndSettle();

    harness.check(STALL_THRESHOLD_MS - 1);
    expect(harness.writeProfile).not.toHaveBeenCalled();

    harness.check(STALL_THRESHOLD_MS);
    expect(harness.writeProfile).toHaveBeenCalledTimes(1);
  });

  it('catches a stall in the launch\'s first second, however long its own cold start was', () => {
    // The delay reader starts after start() returns, so the first reading is
    // the app's alone. Excusing that check, as the old profiler did, hid a
    // 124 ms boot block in a preview run.
    const harness = createHarness({ coldStartMs: 200 });
    harness.profiler.start();

    harness.check(124);

    expect(harness.writeProfile).toHaveBeenCalledTimes(1);
  });

  it('does not feed on its own save: a slow one is excused once, and a real stall after it is not', () => {
    const harness = createHarness({ stopMs: 90 });
    harness.startAndSettle();

    harness.check(120);
    expect(harness.writeProfile).toHaveBeenCalledTimes(1);

    // The save's own 90 ms shows up in the next reading. Without the excuse
    // this is a second save, which holds main again: the chain of 2026-11-24.
    harness.check(100);
    for (let elapsedMs = 2 * CHECK_MS; elapsedMs <= SAVE_COOLDOWN_MS; elapsedMs += CHECK_MS) harness.check();
    expect(harness.writeProfile).toHaveBeenCalledTimes(1);

    harness.check(400);
    expect(harness.writeProfile).toHaveBeenCalledTimes(2);
  });

  it('closes the delay window right before its cold start, and notes only the window after a save', () => {
    const harness = createHarness();
    harness.profiler.start();
    // A close resets the lag monitor's histogram, which then records nothing
    // until its timer fires again, so the start's own block is in no window.
    expect(harness.windowCalls).toEqual(['close']);

    // Rolls touch no window.
    for (let elapsedMs = 0; elapsedMs <= ROLL_MS; elapsedMs += CHECK_MS) harness.check();
    expect(harness.windowCalls).toEqual(['close']);

    // A save closes the window holding the stall, then notes the one after it.
    harness.check(150);
    expect(harness.windowCalls.slice(1)).toEqual(['close', 'mark:stall-profiler']);
  });

  it('starts its delay reading over only after a delay it reported, never on a quiet check', () => {
    // A reset costs the histogram its baseline, so the reading misses any
    // stall that begins before its timer fires again. Resetting on every
    // check, as the old profiler did, opened that gap once a second.
    const harness = createHarness();
    harness.startAndSettle();
    for (let second = 0; second < 10; second++) harness.check(40);
    expect(harness.delayResets()).toBe(0);

    harness.check(150);
    expect(harness.delayResets()).toBe(1);

    // One stall is one save: the reading did not carry it into the next check.
    for (let elapsedMs = 0; elapsedMs <= SAVE_COOLDOWN_MS; elapsedMs += CHECK_MS) harness.check();
    expect(harness.writeProfile).toHaveBeenCalledTimes(1);
  });

  it('rolls every ROLL_MS without writing anything', () => {
    const harness = createHarness();
    harness.startAndSettle();
    const startedBeforeRoll = harness.startedProfiles();

    for (let elapsedMs = CHECK_MS; elapsedMs <= ROLL_MS; elapsedMs += CHECK_MS) harness.check();

    expect(harness.startedProfiles()).toBe(startedBeforeRoll + 1);
    expect(harness.liveAfterStop).toEqual([2]);
    expect(harness.writeProfile).not.toHaveBeenCalled();
  });

  it('writes the text stop() returned, as it is', async () => {
    // Spacing and key order no JSON.stringify would produce: a re-serialized
    // profile would not match, and re-serializing 0.6 MB is what held main.
    const profile = profileOf([2, 4, 4, 2]);
    const text = `{ "timeDeltas":${JSON.stringify(profile.timeDeltas)},\n  "samples":${JSON.stringify(profile.samples)}, "startTime":0, "endTime":4000, "nodes":${JSON.stringify(profile.nodes)} }`;
    const harness = createHarness({ profileText: () => text });
    harness.startAndSettle();

    harness.check(120);
    await vi.waitFor(() => expect(harness.summaries).toHaveLength(1));

    expect(harness.writeProfile.mock.calls[0][1]).toBe(text);
    expect(harness.summaries[0]).toMatchObject({
      maxDelayMs: 120,
      stalledChecks: 1,
      file: 'saved.cpuprofile',
      topFrames: [{ functionName: 'parseTranscript', location: 'agent/transcript-parser.js:42', selfMs: 2 }],
    });
  });

  it('folds stalls inside the cooldown into one save, and holds the roll until then', async () => {
    const harness = createHarness();
    harness.startAndSettle();

    harness.check(100);
    expect(harness.writeProfile).toHaveBeenCalledTimes(1);

    // Two more stalls, one and two seconds after that save.
    harness.check(200);
    harness.check(90);
    const stopsWhileWaiting = harness.liveAfterStop.length;
    expect(harness.writeProfile).toHaveBeenCalledTimes(1);

    for (let elapsedMs = 3 * CHECK_MS; elapsedMs <= SAVE_COOLDOWN_MS; elapsedMs += CHECK_MS) harness.check();
    expect(harness.liveAfterStop.length).toBe(stopsWhileWaiting + 1);
    expect(harness.writeProfile).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(harness.summaries).toHaveLength(2));
    expect(harness.summaries[1]).toMatchObject({ maxDelayMs: 200, stalledChecks: 2 });
  });

  it('summarises back to the check before the stall, so a block longer than the default tail is whole', async () => {
    // One second idle, a 3.9 s block, then 0.1 s idle. The last 3 s alone
    // would report a 2.9 s run.
    const samples = [...Array<number>(10).fill(2), ...Array<number>(39).fill(4), 2];
    const longBlock: Profiler.Profile = { ...profileOf(samples), timeDeltas: samples.map(() => 100_000) };
    const harness = createHarness({ profileText: () => JSON.stringify(longBlock) });
    harness.startAndSettle();

    // The block held the check itself: it runs four seconds late.
    harness.check(3_900, 5_000);
    await vi.waitFor(() => expect(harness.summaries).toHaveLength(1));

    expect(harness.summaries[0].longestBusyRunMs).toBe(3_900);
  });

  it('still reports a stall whose profile could not be written', async () => {
    const harness = createHarness();
    harness.writeProfile.mockResolvedValueOnce(null);
    harness.startAndSettle();

    harness.check(150);
    await vi.waitFor(() => expect(harness.summaries).toHaveLength(1));

    expect(harness.summaries[0].file).toBeNull();
    expect(harness.summaries[0].topFrames.length).toBeGreaterThan(0);
  });

  it('stops both profiles when it is switched off', () => {
    const harness = createHarness();
    harness.startAndSettle();

    harness.profiler.stop();

    expect(harness.liveProfiles()).toBe(0);
    expect(harness.profiler.running).toBe(false);
  });

  describe('a roll that fails', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** A profiler whose profiles count their own `stop()` calls, with chosen failures. */
    function createFailingProfiler(failures: { stopThrowsForProfile?: number; startThrowsAtCall?: number }) {
      let nowMs = Date.UTC(2026, 10, 24, 4, 0, 0);
      let startCalls = 0;
      /** How many times each started profile's stop() was called, by start order. */
      const stopCalls: number[] = [];
      const profiler = new StallProfiler({
        startProfile: (): RunningProfile => {
          const profileNumber = startCalls;
          startCalls += 1;
          if (failures.startThrowsAtCall === profileNumber) throw new Error('profiler gone');
          stopCalls[profileNumber] = 0;
          return {
            stop: () => {
              stopCalls[profileNumber] += 1;
              if (failures.stopThrowsForProfile === profileNumber) throw new Error('already stopped');
              return JSON.stringify(profileOf([2, 4, 2]));
            },
          };
        },
        readMaxDelayMs: () => 0,
        resetDelayReading: () => undefined,
        now: () => nowMs,
        elapsedNow: () => 0,
        writeProfile: async () => 'saved.cpuprofile',
        onSummary: () => undefined,
        closeDelayWindow: () => undefined,
        markDelayWindow: () => undefined,
      });
      /** Start, then reach the first roll. */
      const startAndReachRoll = (): void => {
        profiler.start();
        nowMs += ROLL_MS;
        profiler.check();
      };
      return { profiler, stopCalls, startAndReachRoll };
    }

    it('ends stopped with every profile it ever started stopped, the one the failing roll started included', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // Profile 0 is the older one the roll stops; its stop() throws. Profile 2
      // is started inside the roll, before that stop, and sits in neither slot.
      const harness = createFailingProfiler({ stopThrowsForProfile: 0 });

      harness.startAndReachRoll();

      expect(harness.profiler.running).toBe(false);
      expect(harness.stopCalls).toHaveLength(3);
      for (const calls of harness.stopCalls) expect(calls).toBeGreaterThanOrEqual(1);
    });

    it('ends stopped with both earlier profiles stopped when the next profile cannot start', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const harness = createFailingProfiler({ startThrowsAtCall: 2 });

      harness.startAndReachRoll();

      expect(harness.profiler.running).toBe(false);
      expect(harness.stopCalls).toEqual([1, 1]);
    });
  });

  it('leaves a stall\'s own profiler spans out of its slow spans, and keeps every other label', async () => {
    // The ring stamps spans with the real clock, and the check reads them
    // against the harness's, so both are pinned to one date.
    vi.useFakeTimers({ toFake: ['Date'] });
    relaySlowSyncSpans(() => undefined);
    try {
      const harness = createHarness();
      harness.startAndSettle();
      vi.setSystemTime(Date.UTC(2026, 10, 24, 4, 0, 1, 500));
      recordSyncSpan('diag:stall-profiler:save', 40);
      recordSyncSpan('db:transaction', 30);
      recordSyncSpan('diag:stall-profiler:summary', 25);
      recordSyncSpan('config:project-read', 20);

      harness.check(150);
      vi.useRealTimers();
      await vi.waitFor(() => expect(harness.summaries).toHaveLength(1));

      expect(harness.summaries[0].slowSpans).toEqual([
        { label: 'db:transaction', ms: 30 },
        { label: 'config:project-read', ms: 20 },
      ]);
    } finally {
      relaySlowSyncSpans(null);
      vi.useRealTimers();
    }
  });

  it('forgets a stall noted inside the save cooldown when it is switched off, so a restart does not save it', async () => {
    const harness = createHarness();
    harness.startAndSettle();
    harness.check(100);
    expect(harness.writeProfile).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(harness.summaries).toHaveLength(1));

    // A second stall inside the cooldown is noted and waits for it to pass.
    harness.check(120);
    expect(harness.writeProfile).toHaveBeenCalledTimes(1);

    harness.profiler.stop();
    harness.profiler.start();
    // Past the cooldown, with nothing stalled since the restart.
    harness.check(0, SAVE_COOLDOWN_MS);

    expect(harness.writeProfile).toHaveBeenCalledTimes(1);
    expect(harness.summaries).toHaveLength(1);
  });
});
