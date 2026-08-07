/**
 * Unit tests for the renderer lag recorder's background-throttle classification
 * (`src/devtools/renderer/lag-recorder.ts`).
 *
 * While the window is hidden, Chromium throttles the 100ms sampler to >=1s, so
 * every hidden sample reads as a ~900ms "spike". These must be routed to the
 * hidden counters instead of the real-freeze ring so background throttling does
 * not pollute freeze diagnosis. The sampler's lag is derived from
 * `performance.now()`, which the test controls to simulate spikes deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const docStub = { hidden: false };
let nowValue = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  nowValue = 0;
  docStub.hidden = false;
  vi.stubGlobal('document', docStub);
  vi.spyOn(performance, 'now').mockImplementation(() => nowValue);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadRecorder() {
  return import('../../src/devtools/renderer/lag-recorder');
}

/** Advance `performance.now` by (100ms interval + extraLagMs) then fire one tick. */
function tick(extraLagMs: number): void {
  nowValue += 100 + extraLagMs;
  vi.advanceTimersByTime(100);
}

describe('renderer lag recorder - background throttle classification', () => {
  it('records a visible spike in the ring and the visible counters', async () => {
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    tick(200); // visible, lag 200 >= 75 threshold

    const report = recorder.getRendererLagReport();
    expect(report.spikeCount).toBe(1);
    expect(report.recentSpikes).toHaveLength(1);
    expect(report.hiddenSpikeCount).toBe(0);
    recorder.stopRendererLagRecorder();
  });

  it('routes a hidden-window spike to the hidden counters, not the ring', async () => {
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    docStub.hidden = true;
    tick(900); // throttled ~900ms artifact

    const report = recorder.getRendererLagReport();
    expect(report.hiddenSpikeCount).toBe(1);
    expect(report.maxHiddenLagMs).toBeGreaterThanOrEqual(900);
    expect(report.spikeCount).toBe(0);
    expect(report.recentSpikes).toHaveLength(0);
    recorder.stopRendererLagRecorder();
  });

  it('classifies the first sample after foregrounding as a throttle artifact', async () => {
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    docStub.hidden = true;
    tick(900); // hidden artifact -> hiddenSpikeCount 1

    // Foreground again: the first visible sample still carries the throttle
    // backlog, so it must be classified as an artifact (via lastSampleHidden).
    docStub.hidden = false;
    tick(500);

    const report = recorder.getRendererLagReport();
    expect(report.hiddenSpikeCount).toBe(2);
    expect(report.spikeCount).toBe(0);
    recorder.stopRendererLagRecorder();
  });

  it('mirrors document.hidden into the report', async () => {
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    expect(recorder.getRendererLagReport().documentHidden).toBe(false);
    docStub.hidden = true;
    expect(recorder.getRendererLagReport().documentHidden).toBe(true);
    recorder.stopRendererLagRecorder();
  });
});

/**
 * The long-animation-frame ring. The sampler above says WHEN the thread blocked; this says
 * WHAT ran. It is a separate entry type with its own support story, so the two things worth
 * pinning are that an unsupporting runtime degrades to `'unavailable'` rather than an empty
 * array (an empty array reads as "nothing was slow", which is the wrong conclusion), and that
 * the entry mapping is right - a wrong `renderMs`/`styleLayoutMs` derivation would silently
 * point every future diagnosis at the wrong layer.
 */
describe('renderer lag recorder - long animation frames', () => {
  beforeEach(() => {
    observeCalls.length = 0;
  });

  interface FakeScript {
    duration: number;
    sourceURL?: string;
    sourceFunctionName?: string;
    invokerType?: string;
    invoker?: string;
    forcedStyleAndLayoutDuration?: number;
  }
  interface FakeFrame {
    startTime: number;
    duration: number;
    blockingDuration?: number;
    renderStart?: number;
    styleAndLayoutStart?: number;
    scripts?: FakeScript[];
  }

  /**
   * Install a PerformanceObserver stub that reports support and captures the callback.
   * `disconnect()` models a real PerformanceObserver's teardown: once disconnected, it must
   * stop delivering entries, so `emit()` after `disconnect()` is a no-op. That is what makes
   * a missing `disconnect()` call in the recorder's own `stopRendererLagRecorder()` observable.
   *
   * A start -> stop -> restart cycle constructs a NEW FakeObserver instance, exactly as a real
   * PerformanceObserver cannot be reused after `disconnect()` either - so the constructor resets
   * `disconnected` for the fresh instance, and `emit()` always targets whichever instance was
   * constructed most recently. `observeCalls` accumulates every `observe()` call's options across
   * every instance the stub ever constructs, so a test spanning a restart can inspect both calls.
   */
  const observeCalls: Array<{ type?: string; buffered?: boolean }> = [];

  function stubObserver(supported: boolean): { emit: (frames: FakeFrame[]) => void } {
    let capturedCallback: ((list: { getEntries: () => FakeFrame[] }) => void) | null = null;
    let disconnected = false;
    class FakeObserver {
      static supportedEntryTypes = supported ? ['long-animation-frame'] : ['longtask'];
      constructor(callback: (list: { getEntries: () => FakeFrame[] }) => void) {
        capturedCallback = callback;
        disconnected = false;
      }
      observe(options?: { type?: string; buffered?: boolean }): void {
        observeCalls.push(options ?? {});
      }
      disconnect(): void {
        disconnected = true;
      }
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    return {
      emit: (frames) => {
        if (disconnected) return;
        capturedCallback?.({ getEntries: () => frames });
      },
    };
  }

  it('reports `unavailable`, not an empty ring, where the entry type is unsupported', async () => {
    stubObserver(false);
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    expect(recorder.getRendererLagReport().recentLongFrames).toBe('unavailable');
    recorder.stopRendererLagRecorder();
  });

  it('derives render and style/layout durations from their start offsets', async () => {
    const observer = stubObserver(true);
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    // A 200ms frame starting at t=1000. Rendering began 60ms before the end, and style and
    // layout 25ms before the end. Both are reported as start OFFSETS, not durations, so the
    // recorder has to subtract them from the frame's end.
    observer.emit([{
      startTime: 1000,
      duration: 200,
      blockingDuration: 150,
      renderStart: 1140,
      styleAndLayoutStart: 1175,
      scripts: [],
    }]);

    const frames = recorder.getRendererLagReport().recentLongFrames;
    expect(frames).not.toBe('unavailable');
    const [frame] = frames as Exclude<typeof frames, 'unavailable'>;
    expect(frame.durationMs).toBe(200);
    expect(frame.blockingMs).toBe(150);
    expect(frame.renderMs).toBe(60);
    expect(frame.styleLayoutMs).toBe(25);
    // Wall clock, so the entry joins to a `recentSpikes` timestamp.
    expect(frame.at).toBe(new Date(performance.timeOrigin + 1000).toISOString());
    recorder.stopRendererLagRecorder();
  });

  it('keeps the heaviest scripts, drops trivial ones, and carries forced-layout time', async () => {
    const observer = stubObserver(true);
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    observer.emit([{
      startTime: 0,
      duration: 120,
      scripts: [
        { duration: 3, sourceURL: 'noise.ts' },
        { duration: 80, sourceURL: 'heavy.ts', sourceFunctionName: 'initTerminal', invokerType: 'user-callback', invoker: 'FrameRequestCallback', forcedStyleAndLayoutDuration: 12 },
        { duration: 30, sourceURL: 'medium.ts' },
      ],
    }]);

    const frames = recorder.getRendererLagReport().recentLongFrames;
    const [frame] = frames as Exclude<typeof frames, 'unavailable'>;
    // The 3ms script is below the floor and must not dilute the attribution.
    expect(frame.scripts.map((script) => script.sourceURL)).toEqual(['heavy.ts', 'medium.ts']);
    expect(frame.scripts[0].durationMs).toBe(80);
    expect(frame.scripts[0].forcedLayoutMs).toBe(12);
    expect(frame.scripts[0].sourceFunctionName).toBe('initTerminal');
    expect(frame.scripts[0].invoker).toBe('FrameRequestCallback');
    recorder.stopRendererLagRecorder();
  });

  it('bounds the ring, keeping the most recent frames', async () => {
    const observer = stubObserver(true);
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    for (let index = 0; index < 80; index++) {
      observer.emit([{ startTime: index, duration: 60 + index, scripts: [] }]);
    }

    const frames = recorder.getRendererLagReport().recentLongFrames as Exclude<
      ReturnType<typeof recorder.getRendererLagReport>['recentLongFrames'], 'unavailable'
    >;
    expect(frames).toHaveLength(60);
    // Oldest evicted: the survivors are the last 60 emitted (indices 20..79).
    expect(frames[0].durationMs).toBe(80);
    expect(frames[frames.length - 1].durationMs).toBe(139);
    recorder.stopRendererLagRecorder();
  });

  it('caps the attributed scripts per frame at the 5 heaviest, dropping the rest', async () => {
    const observer = stubObserver(true);
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    // 8 scripts, all above the 5ms floor, so every one of them is a candidate for
    // attribution before the per-frame cap applies.
    const scriptDurations = [90, 10, 70, 20, 60, 30, 50, 40];
    observer.emit([{
      startTime: 0,
      duration: 200,
      scripts: scriptDurations.map((duration, scriptIndex) => ({
        duration,
        sourceURL: `script-${scriptIndex}.ts`,
      })),
    }]);

    const frames = recorder.getRendererLagReport().recentLongFrames;
    const [frame] = frames as Exclude<typeof frames, 'unavailable'>;
    expect(frame.scripts).toHaveLength(5);
    expect(frame.scripts.map((script) => script.durationMs)).toEqual([90, 70, 60, 50, 40]);
    recorder.stopRendererLagRecorder();
  });

  it('sorts attributed scripts heaviest first, independent of emission order', async () => {
    const observer = stubObserver(true);
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    // The medium script is emitted BEFORE the heavy one, so a correct heaviest-first
    // sort has to reorder them, not just pass emission order through unchanged.
    observer.emit([{
      startTime: 0,
      duration: 120,
      scripts: [
        { duration: 30, sourceURL: 'medium.ts' },
        { duration: 80, sourceURL: 'heavy.ts' },
      ],
    }]);

    const frames = recorder.getRendererLagReport().recentLongFrames;
    const [frame] = frames as Exclude<typeof frames, 'unavailable'>;
    expect(frame.scripts.map((script) => script.sourceURL)).toEqual(['heavy.ts', 'medium.ts']);
    recorder.stopRendererLagRecorder();
  });

  it('disconnects the observer on stop, so a frame emitted afterward is never recorded', async () => {
    const observer = stubObserver(true);
    const recorder = await loadRecorder();
    recorder.startRendererLagRecorder();

    observer.emit([{ startTime: 0, duration: 60, scripts: [] }]);
    const framesBeforeStop = recorder.getRendererLagReport().recentLongFrames;
    expect(framesBeforeStop).not.toBe('unavailable');
    expect(framesBeforeStop as Exclude<typeof framesBeforeStop, 'unavailable'>).toHaveLength(1);

    recorder.stopRendererLagRecorder();

    // Emitted after stop: a disconnected observer must not deliver this to the
    // recorder's callback at all, so the ring must not grow past the pre-stop entry.
    observer.emit([{ startTime: 1000, duration: 60, scripts: [] }]);
    const framesAfterStop = recorder.getRendererLagReport().recentLongFrames;
    expect(framesAfterStop).not.toBe('unavailable');
    expect(framesAfterStop as Exclude<typeof framesAfterStop, 'unavailable'>).toHaveLength(1);
  });

  it('replays the buffered entry backlog only on the FIRST attach, and the ring survives a stop -> restart', async () => {
    // `startLongFrameObserver`'s `observe({ buffered: !longFrameSupported })` is a new branch
    // this commit introduced with no covering assertion anywhere. A dev remount of
    // DevtoolsBootstrap (or a manual stop/restart) reconnects the observer, and if that second
    // `observe()` call also asked for the buffered backlog, the browser would replay frames the
    // ring already carries - a duplicated spike that reads as a real repeat, exactly the wrong
    // conclusion for a tool whose entire job is attribution.
    const observer = stubObserver(true);
    const recorder = await loadRecorder();

    recorder.startRendererLagRecorder();
    expect(observeCalls).toHaveLength(1);
    expect(observeCalls[0].type).toBe('long-animation-frame');
    expect(observeCalls[0].buffered).toBe(true);

    observer.emit([{ startTime: 0, duration: 60, scripts: [] }]);
    recorder.stopRendererLagRecorder();

    // Restart constructs a fresh PerformanceObserver (a real one cannot be reused after
    // `disconnect()`), which is a SECOND `observe()` call - it must not ask for `buffered` this
    // time, or the entry recorded before stop would be double-counted by the browser's replay.
    recorder.startRendererLagRecorder();
    expect(observeCalls).toHaveLength(2);
    expect(observeCalls[1].type).toBe('long-animation-frame');
    expect(observeCalls[1].buffered).toBe(false);

    // The ring itself is a flight recorder that survives the stop: still exactly the one frame
    // recorded before stop, not reset to empty and not doubled by a buffered replay after
    // restart.
    const frames = recorder.getRendererLagReport().recentLongFrames;
    expect(frames).not.toBe('unavailable');
    expect(frames as Exclude<typeof frames, 'unavailable'>).toHaveLength(1);

    recorder.stopRendererLagRecorder();
  });
});
