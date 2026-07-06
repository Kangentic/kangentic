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
