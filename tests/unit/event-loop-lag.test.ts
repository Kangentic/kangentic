/**
 * Unit tests for `src/main/diagnostics/event-loop-lag.ts`.
 *
 * The module is a flight-recorder singleton: module-level state (timer, sample
 * accumulators, ring buffer) is never externally reset. Tests use
 * vi.resetModules() + a fresh dynamic import per test to isolate that state.
 *
 * vi.useFakeTimers() drives setInterval without real delays. A spy on
 * performance.now() lets each test inject specific "lag" values into the
 * callback, so spike detection and ring-buffer behaviour are deterministic.
 *
 * Mechanism:
 *   lag = performance.now()[callback] - performance.now()[start] - SAMPLE_INTERVAL_MS
 *
 * SPIKE_THRESHOLD_MS = 75 (lag >= 75 -> spike)
 * RING_SIZE          = 120 (oldest spike is evicted when the ring overflows)
 * SAMPLE_INTERVAL_MS = 100
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('event-loop-lag monitor', () => {
  beforeEach(() => {
    // Install fake timers BEFORE resetting modules so the fresh module import
    // sees fake setInterval / Date.now / performance.now as globals.
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Helper: always returns a fresh module instance with isolated singleton state.
  async function loadMonitor() {
    return import('../../src/main/diagnostics/event-loop-lag');
  }

  it('report returns non-monitoring defaults before start', async () => {
    const { getEventLoopLagReport } = await loadMonitor();
    const report = getEventLoopLagReport();
    expect(report.monitoring).toBe(false);
    expect(report.monitoringForMs).toBeNull();
    expect(report.samples).toBe(0);
    expect(report.spikeCount).toBe(0);
    expect(report.recentSpikes).toHaveLength(0);
    // Constants are published in the report so callers can interpret the data.
    expect(report.sampleIntervalMs).toBeGreaterThan(0);
    expect(report.spikeThresholdMs).toBeGreaterThan(0);
  });

  it('start transitions monitoring to true; stop transitions it back to false', async () => {
    const { startEventLoopLagMonitor, stopEventLoopLagMonitor, getEventLoopLagReport } =
      await loadMonitor();

    startEventLoopLagMonitor();
    expect(getEventLoopLagReport().monitoring).toBe(true);

    stopEventLoopLagMonitor();
    expect(getEventLoopLagReport().monitoring).toBe(false);
  });

  it('start is idempotent: a second call registers no additional interval', async () => {
    const { startEventLoopLagMonitor, stopEventLoopLagMonitor, getEventLoopLagReport } =
      await loadMonitor();

    startEventLoopLagMonitor();
    startEventLoopLagMonitor(); // no-op: timer is already set

    // Two 100ms ticks; a single interval produces exactly 2 samples.
    // If two intervals were registered, samples would be 4.
    vi.advanceTimersByTime(200);
    expect(getEventLoopLagReport().samples).toBe(2);

    stopEventLoopLagMonitor();
  });

  it('stop is a no-op when the monitor has not been started', async () => {
    const { stopEventLoopLagMonitor, getEventLoopLagReport } = await loadMonitor();
    expect(() => stopEventLoopLagMonitor()).not.toThrow();
    expect(getEventLoopLagReport().monitoring).toBe(false);
  });

  it('samples increment once per interval tick', async () => {
    const { startEventLoopLagMonitor, stopEventLoopLagMonitor, getEventLoopLagReport } =
      await loadMonitor();

    startEventLoopLagMonitor();
    vi.advanceTimersByTime(300); // 3 ticks at 100ms each
    expect(getEventLoopLagReport().samples).toBe(3);
    stopEventLoopLagMonitor();
  });

  it('monitoringForMs reflects the elapsed time since start', async () => {
    const { startEventLoopLagMonitor, stopEventLoopLagMonitor, getEventLoopLagReport } =
      await loadMonitor();

    startEventLoopLagMonitor(); // startedAtMs = Date.now() (fake)
    vi.advanceTimersByTime(500); // fake clock advances by exactly 500ms
    const { monitoringForMs } = getEventLoopLagReport();
    stopEventLoopLagMonitor();

    // Fake timers advance Date.now() precisely; the delta must be 500ms.
    expect(monitoringForMs).toBe(500);
  });

  it('records a spike when the interval lag meets the threshold (>= 75ms)', async () => {
    const { startEventLoopLagMonitor, stopEventLoopLagMonitor, getEventLoopLagReport } =
      await loadMonitor();

    // start() reads performance.now() once for lastFire.
    // The interval callback reads it again: lag = now - lastFire - 100ms.
    // 200 - 0 - 100 = 100 >= 75 -> one spike of 100ms.
    const nowSequence = [0, 200];
    let nowIndex = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowSequence[nowIndex++] ?? 200);

    startEventLoopLagMonitor();   // call 0: lastFire = 0
    vi.advanceTimersByTime(100);  // fires callback: call 1, now = 200, lag = 100

    const report = getEventLoopLagReport();
    stopEventLoopLagMonitor();

    expect(report.spikeCount).toBe(1);
    expect(report.maxLagMs).toBe(100);
    expect(report.recentSpikes).toHaveLength(1);
    expect(report.recentSpikes[0].lagMs).toBe(100);
    // Timestamp must be a valid ISO 8601 string.
    expect(report.recentSpikes[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('does not record a spike when the lag is below the threshold (< 75ms)', async () => {
    const { startEventLoopLagMonitor, stopEventLoopLagMonitor, getEventLoopLagReport } =
      await loadMonitor();

    // 174 - 0 - 100 = 74 < 75 -> no spike recorded.
    const nowSequence = [0, 174];
    let nowIndex = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowSequence[nowIndex++] ?? 174);

    startEventLoopLagMonitor();
    vi.advanceTimersByTime(100); // lag = 74, below SPIKE_THRESHOLD_MS

    const report = getEventLoopLagReport();
    stopEventLoopLagMonitor();

    expect(report.spikeCount).toBe(0);
    expect(report.recentSpikes).toHaveLength(0);
  });

  it('maxLagMs tracks the worst (highest) spike seen across multiple samples', async () => {
    const { startEventLoopLagMonitor, stopEventLoopLagMonitor, getEventLoopLagReport } =
      await loadMonitor();

    // cb1: now = 200, lastFire = 0,   lag = 100ms -> spike
    // cb2: now = 600, lastFire = 200, lag = 300ms -> spike (worst)
    const nowSequence = [0, 200, 600];
    let nowIndex = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowSequence[nowIndex++] ?? 600);

    startEventLoopLagMonitor();
    vi.advanceTimersByTime(100); // cb1: lag = 100
    vi.advanceTimersByTime(100); // cb2: lag = 300

    const report = getEventLoopLagReport();
    stopEventLoopLagMonitor();

    expect(report.spikeCount).toBe(2);
    expect(report.maxLagMs).toBe(300);
  });

  it('trims recentSpikes to the ring capacity (120) after overflow', async () => {
    const { startEventLoopLagMonitor, stopEventLoopLagMonitor, getEventLoopLagReport } =
      await loadMonitor();

    // Each performance.now() call returns a value 200ms ahead of the previous.
    // start() call: lastFire = 0.
    // Callback n: now = n * 200, lag = 200 - 100 = 100ms (>= 75) -> spike.
    // All 121 callbacks produce spikes; the ring trims to its cap of 120 entries.
    let fakeNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      const value = fakeNow;
      fakeNow += 200;
      return value;
    });

    startEventLoopLagMonitor(); // fakeNow: 0 -> 200; lastFire = 0
    vi.advanceTimersByTime(12100); // 121 ticks at 100ms; each lag = 100ms

    const report = getEventLoopLagReport();
    stopEventLoopLagMonitor();

    // Total spikes fired = 121; the ring evicts the oldest once it exceeds 120.
    expect(report.spikeCount).toBe(121);
    expect(report.recentSpikes).toHaveLength(120);
    // Every retained entry should carry the simulated 100ms lag.
    expect(report.recentSpikes.every((spike) => spike.lagMs === 100)).toBe(true);
  });

  it('recentSpikes in the returned report is an independent copy', async () => {
    const { startEventLoopLagMonitor, stopEventLoopLagMonitor, getEventLoopLagReport } =
      await loadMonitor();

    const nowSequence = [0, 200];
    let nowIndex = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowSequence[nowIndex++] ?? 200);

    startEventLoopLagMonitor();
    vi.advanceTimersByTime(100); // one spike

    const firstReport = getEventLoopLagReport();
    // Mutate the returned array.
    firstReport.recentSpikes.length = 0;

    // A fresh report must still see the spike in the live ring buffer.
    const secondReport = getEventLoopLagReport();
    stopEventLoopLagMonitor();

    expect(secondReport.recentSpikes).toHaveLength(1);
  });
});
