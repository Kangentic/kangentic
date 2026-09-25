import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createHostMemoryPressureState,
  evaluateHostMemoryPressure,
  getLastHostMemorySample,
  pressureThreshold,
  sampleHostMemory,
  startHostMemorySampler,
  type HostMemorySample,
} from '../../src/main/diagnostics/host-memory';

function sample(overrides: Partial<HostMemorySample> = {}): HostMemorySample {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    platform: 'win32',
    commitLimitBytes: 96_432_717_824, // the real DESKTOP-16 machine
    commitRemainingBytes: 50_000_000_000, // plenty of headroom by default
    physicalTotalBytes: 34_060_931_072,
    physicalFreeBytes: 5_005_045_760,
    ...overrides,
  };
}

const GB = 1024 * 1024 * 1024;

describe('evaluateHostMemoryPressure', () => {
  it('does not warn while headroom stays above the threshold', () => {
    const state = createHostMemoryPressureState();
    for (let tick = 0; tick < 10; tick++) {
      const decision = evaluateHostMemoryPressure(sample({ commitRemainingBytes: 10 * GB }), state, tick * 60_000);
      expect(decision).toBe('none');
    }
  });

  it('reproduces the real DESKTOP-16 event: 89.8 GB limit, 2.15 MB remaining', () => {
    const state = createHostMemoryPressureState();
    const decision = evaluateHostMemoryPressure(
      sample({ commitLimitBytes: 96_432_717_824, commitRemainingBytes: 2_256_896 }),
      state,
      0
    );
    expect(decision).toBe('pressure');
  });

  it('is edge-triggered: 10 consecutive ticks below the line warn exactly once', () => {
    const state = createHostMemoryPressureState();
    const lowSample = sample({ commitRemainingBytes: 100 * 1024 * 1024 }); // 100 MB, well under 2 GB
    const results = Array.from({ length: 10 }, (_unused, tick) =>
      evaluateHostMemoryPressure(lowSample, state, tick * 60_000)
    );
    expect(results.filter((decision) => decision === 'pressure')).toHaveLength(1);
    expect(results[0]).toBe('pressure');
  });

  it('does not re-arm on a partial recovery (must clear the hysteresis line, not just the threshold)', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);
    // First warning.
    expect(evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold / 2 }), state, 0)).toBe('pressure');
    // Recovers to just above the threshold but below 2x it (the hysteresis line).
    // A partial recovery is deliberately NOT reported as recovered: the
    // hysteresis line is the module's definition of "recovered", not the
    // threshold, so the toast must not clear here either.
    expect(evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold * 1.2 }), state, 60_000)).toBe('none');
    // Dips back under the threshold - must NOT warn again, since it never cleared hysteresis.
    const decisionAgain = evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold / 2 }), state, 120_000);
    expect(decisionAgain).toBe('none');
  });

  it('re-arms once headroom recovers past 2x the threshold, and warns again on the next dip', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);
    expect(evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold / 2 }), state, 0)).toBe('pressure');
    // Fully recovers past the hysteresis line.
    evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold * 3 }), state, 60_000);
    // Dips back under, long after the minimum interval - should warn again.
    const decisionAgain = evaluateHostMemoryPressure(
      sample({ commitRemainingBytes: threshold / 2 }),
      state,
      2 * 60 * 60_000
    );
    expect(decisionAgain).toBe('pressure');
  });

  it('holds a 30-minute floor between warnings even while oscillating across the line', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);
    const below = sample({ commitRemainingBytes: threshold / 2 });
    const recovered = sample({ commitRemainingBytes: threshold * 3 });

    expect(evaluateHostMemoryPressure(below, state, 0)).toBe('pressure');
    // Oscillate every minute for 20 minutes - each recovery re-arms, each dip
    // is still inside the 30-minute floor, so none of these may warn.
    let anyWarnedInsideFloor = false;
    for (let minute = 1; minute <= 20; minute++) {
      evaluateHostMemoryPressure(recovered, state, minute * 60_000);
      if (evaluateHostMemoryPressure(below, state, minute * 60_000 + 30_000) === 'pressure') {
        anyWarnedInsideFloor = true;
      }
    }
    expect(anyWarnedInsideFloor).toBe(false);
    // Past the 30-minute floor, a fresh dip may warn again.
    evaluateHostMemoryPressure(recovered, state, 31 * 60_000);
    expect(evaluateHostMemoryPressure(below, state, 32 * 60_000)).toBe('pressure');
  });

  it('never warns when the platform has no commit reading (macOS/Linux)', () => {
    const state = createHostMemoryPressureState();
    const decision = evaluateHostMemoryPressure(
      sample({ platform: 'darwin', commitLimitBytes: null, commitRemainingBytes: null }),
      state,
      0
    );
    expect(decision).toBe('none');
  });

  it('never warns and never divides by zero on a degraded zero-limit reading', () => {
    const state = createHostMemoryPressureState();
    const decision = evaluateHostMemoryPressure(
      sample({ commitLimitBytes: 0, commitRemainingBytes: 0 }),
      state,
      0
    );
    expect(decision).toBe('none');
  });

  it('uses the relative arm on a small machine (8 GB limit -> ~400 MB threshold)', () => {
    const state = createHostMemoryPressureState();
    const limit = 8 * GB;
    // Just above 5% of 8 GB (400 MB) - must not warn.
    expect(evaluateHostMemoryPressure(sample({ commitLimitBytes: limit, commitRemainingBytes: 0.06 * limit }), state, 0)).toBe('none');
    // Just below 5% of 8 GB - must warn.
    expect(evaluateHostMemoryPressure(sample({ commitLimitBytes: limit, commitRemainingBytes: 0.04 * limit }), state, 60_000)).toBe('pressure');
  });

  it('uses the absolute arm on a large machine (89.8 GB limit -> 2 GB threshold, not 5%)', () => {
    const state = createHostMemoryPressureState();
    const limit = 96_432_717_824; // 5% of this is ~4.5 GB, far above the 2 GB absolute floor
    // 3 GB remaining: above the 2 GB absolute floor, so no warning even though
    // it is well under 5% of the limit.
    expect(evaluateHostMemoryPressure(sample({ commitLimitBytes: limit, commitRemainingBytes: 3 * GB }), state, 0)).toBe('none');
    // 1 GB remaining: below the 2 GB absolute floor.
    expect(evaluateHostMemoryPressure(sample({ commitLimitBytes: limit, commitRemainingBytes: 1 * GB }), state, 60_000)).toBe('pressure');
  });

  it('reports a healthy first tick from a fresh state as none, not recovered (the cold-boot case)', () => {
    // createHostMemoryPressureState() seeds armed: true, so a machine that has
    // never warned must not be reported as "recovered" on its very first
    // healthy tick above the hysteresis line.
    const state = createHostMemoryPressureState();
    const decision = evaluateHostMemoryPressure(sample({ commitRemainingBytes: 10 * GB }), state, 0);
    expect(decision).toBe('none');
  });

  it('reports recovered exactly once across 10 consecutive healthy ticks after a warning', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);
    expect(evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold / 2 }), state, 0)).toBe('pressure');

    const healthy = sample({ commitRemainingBytes: threshold * 3 });
    const results = Array.from({ length: 10 }, (_unused, tick) =>
      evaluateHostMemoryPressure(healthy, state, (tick + 1) * 60_000)
    );
    expect(results.filter((decision) => decision === 'recovered')).toHaveLength(1);
    expect(results[0]).toBe('recovered');
  });

  it('does not report recovered for a partial recovery (grey zone between threshold and the hysteresis line)', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);
    expect(evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold / 2 }), state, 0)).toBe('pressure');
    const decision = evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold * 1.2 }), state, 60_000);
    expect(decision).toBe('none');
  });

  it('does not report recovered when a dip was blocked by the minimum interval (armed stays true, nothing latched)', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);
    const below = sample({ commitRemainingBytes: threshold / 2 });
    const recovered = sample({ commitRemainingBytes: threshold * 3 });

    expect(evaluateHostMemoryPressure(below, state, 0)).toBe('pressure');
    // Fully recovers, then dips again inside the 30-minute floor - blocked,
    // so armed stays true and nothing was (re-)latched.
    expect(evaluateHostMemoryPressure(recovered, state, 60_000)).toBe('recovered');
    expect(evaluateHostMemoryPressure(below, state, 5 * 60_000)).toBe('none');
    // The following healthy tick must not report a spurious recovery: the
    // dip above never actually latched a new warning.
    const decision = evaluateHostMemoryPressure(recovered, state, 6 * 60_000);
    expect(decision).toBe('none');
  });

  it('never reports recovered for a degraded sample after a warning latches, and leaves the latch untouched', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);

    // Latches a warning.
    expect(evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold / 2 }), state, 0)).toBe('pressure');
    expect(state.armed).toBe(false);
    const lastWarnedAtAfterPressure = state.lastWarnedAt;

    // A degraded sample with no commit reading at all must return 'none',
    // not fabricate a recovery, and must not silently re-arm the latch.
    const decisionForNoReading = evaluateHostMemoryPressure(
      sample({ commitLimitBytes: null, commitRemainingBytes: null }),
      state,
      60_000
    );
    expect(decisionForNoReading).toBe('none');
    expect(state.armed).toBe(false);
    expect(state.lastWarnedAt).toBe(lastWarnedAtAfterPressure);

    // Same invariant for a degraded zero-limit reading.
    const decisionForZeroLimit = evaluateHostMemoryPressure(
      sample({ commitLimitBytes: 0, commitRemainingBytes: 0 }),
      state,
      120_000
    );
    expect(decisionForZeroLimit).toBe('none');
    expect(state.armed).toBe(false);
    expect(state.lastWarnedAt).toBe(lastWarnedAtAfterPressure);

    // A genuinely recovered sample (at the hysteresis line) still reports
    // 'recovered': the degraded ticks above must not have permanently
    // stranded the state machine.
    const decisionForRecovery = evaluateHostMemoryPressure(
      sample({ commitRemainingBytes: threshold * 2 }),
      state,
      180_000
    );
    expect(decisionForRecovery).toBe('recovered');
  });
});

/**
 * sampleHostMemory() is the ONLY platform-branched function in this module.
 * `process.getSystemMemoryInfo()` is Electron-only and does not exist under
 * vitest's plain node environment, so it must be stubbed - there is no real
 * implementation to fall back to. `process.platform` is a value property
 * (not an accessor), so `vi.spyOn(process, 'platform', 'get')` cannot bind
 * it; `Object.defineProperty` is the right tool, with the original
 * descriptor restored afterward so this behaves identically on Windows,
 * macOS, Linux, and CI (see .claude/rules/cross-platform-parity.md).
 */
describe('sampleHostMemory', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalGetSystemMemoryInfo = (
    process as unknown as { getSystemMemoryInfo?: () => Record<string, number> }
  ).getSystemMemoryInfo;

  function stubPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  function stubMemoryInfo(info: { total: number; free: number; swapTotal: number; swapFree: number }): void {
    (process as unknown as { getSystemMemoryInfo: () => typeof info }).getSystemMemoryInfo = () => info;
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    if (originalGetSystemMemoryInfo) {
      (process as unknown as { getSystemMemoryInfo: () => Record<string, number> }).getSystemMemoryInfo =
        originalGetSystemMemoryInfo;
    } else {
      delete (process as unknown as { getSystemMemoryInfo?: () => Record<string, number> }).getSystemMemoryInfo;
    }
  });

  it('converts KB to bytes (x1024) and reports the commit fields on win32, the only verified platform', () => {
    stubPlatform('win32');
    // Four DISTINCT values, so a cross-wiring bug (physical fields fed from
    // swap, or vice versa) would be visible, not masked by a shared scale.
    stubMemoryInfo({ total: 111_000, free: 222_000, swapTotal: 333_000, swapFree: 444_000 });

    const result = sampleHostMemory();

    // Proves the platform stub is actually live: without this, a no-op
    // defineProperty would still pass every field assertion below by luck of
    // whatever OS the test happens to run on.
    expect(result.platform).toBe('win32');
    expect(result.physicalTotalBytes).toBe(111_000 * 1024);
    expect(result.physicalFreeBytes).toBe(222_000 * 1024);
    expect(result.commitLimitBytes).toBe(333_000 * 1024);
    expect(result.commitRemainingBytes).toBe(444_000 * 1024);
  });

  it('reports null commit fields on a platform with no verified commit reading, even when swapTotal/swapFree are present', () => {
    stubPlatform('linux');
    stubMemoryInfo({ total: 111_000, free: 222_000, swapTotal: 333_000, swapFree: 444_000 });

    const result = sampleHostMemory();

    // Same non-vacuity concern as above, on the opposite branch: CI runs this
    // suite on Linux, so this is the case that must not pass by accident.
    expect(result.platform).toBe('linux');
    expect(result.physicalTotalBytes).toBe(111_000 * 1024);
    expect(result.physicalFreeBytes).toBe(222_000 * 1024);
    expect(result.commitLimitBytes).toBeNull();
    expect(result.commitRemainingBytes).toBeNull();
  });
});

/**
 * The sampler's tick must never let a diagnostics failure become a recurring
 * uncaughtException - it runs every 60s for the life of the process. Uses
 * fake timers with an injectable intervalMs so this needs no real 60s wait.
 */
describe('startHostMemorySampler', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalGetSystemMemoryInfo = (
    process as unknown as { getSystemMemoryInfo?: () => Record<string, number> }
  ).getSystemMemoryInfo;

  function stubMemoryInfo(info: { total: number; free: number; swapTotal: number; swapFree: number }): void {
    (process as unknown as { getSystemMemoryInfo: () => typeof info }).getSystemMemoryInfo = () => info;
  }

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    if (originalGetSystemMemoryInfo) {
      (process as unknown as { getSystemMemoryInfo: () => Record<string, number> }).getSystemMemoryInfo =
        originalGetSystemMemoryInfo;
    } else {
      delete (process as unknown as { getSystemMemoryInfo?: () => Record<string, number> }).getSystemMemoryInfo;
    }
  });

  it('keeps ticking and logs, rather than propagating, when onSample throws', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 1000, swapFree: 1000 });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSample = vi.fn().mockImplementationOnce(() => {
      throw new Error('diagnostics boom');
    });

    const dispose = startHostMemorySampler({
      getActiveAgentCount: () => 0,
      onPressure: vi.fn(),
      onRecovery: vi.fn(),
      onSample,
      intervalMs: 1000,
    });

    // First tick throws inside onSample; must be caught and logged, not
    // escape to the global uncaughtException handler.
    vi.advanceTimersByTime(1000);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    // The interval must still be alive for the second tick.
    vi.advanceTimersByTime(1000);
    expect(onSample).toHaveBeenCalledTimes(2);

    dispose();
    vi.advanceTimersByTime(2000);
    expect(onSample).toHaveBeenCalledTimes(2);

    consoleErrorSpy.mockRestore();
  });

  it('keeps ticking, rather than propagating, when onPressure throws', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // A high limit with almost nothing remaining crosses the pressure line on
    // every tick, so onPressure fires (and throws) on tick one and again on
    // tick two once armed has to be tested indirectly via onSample's count.
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 1 });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onPressure = vi.fn().mockImplementation(() => {
      throw new Error('pressure handler boom');
    });
    const onSample = vi.fn();

    const dispose = startHostMemorySampler({
      getActiveAgentCount: () => 1,
      onPressure,
      onRecovery: vi.fn(),
      onSample,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(onPressure).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    // The interval survives the throw and keeps sampling on the next tick.
    vi.advanceTimersByTime(1000);
    expect(onSample).toHaveBeenCalledTimes(2);

    dispose();
    consoleErrorSpy.mockRestore();
  });

  it('keeps ticking, rather than propagating, when onRecovery throws', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Tick 1 crosses below the line (warns); tick 2 crosses back above the
    // hysteresis line (recovers, and onRecovery throws).
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 1 });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRecovery = vi.fn().mockImplementation(() => {
      throw new Error('recovery handler boom');
    });
    const onSample = vi.fn();

    const dispose = startHostMemorySampler({
      getActiveAgentCount: () => 0,
      onPressure: vi.fn(),
      onRecovery,
      onSample,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(onRecovery).not.toHaveBeenCalled();

    // Fully recover past the hysteresis line.
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 50_000_000 });
    vi.advanceTimersByTime(1000);
    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    // The interval survives the throw and keeps sampling on the next tick.
    vi.advanceTimersByTime(1000);
    expect(onSample).toHaveBeenCalledTimes(3);

    dispose();
    consoleErrorSpy.mockRestore();
  });

  it('reads getActiveAgentCount only on a pressure crossing and threads its exact value into onPressure', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Healthy headroom on tick 1: no pressure crossing.
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 50_000_000 });
    const getActiveAgentCount = vi.fn(() => 7);
    const onPressure = vi.fn();

    const dispose = startHostMemorySampler({
      getActiveAgentCount,
      onPressure,
      onRecovery: vi.fn(),
      intervalMs: 1000,
    });

    // No crossing yet: getActiveAgentCount must be read LIVE at warning time
    // (the module docstring's contract), not on every tick - a hoisted read
    // would poll the session manager every 60s for no reason.
    vi.advanceTimersByTime(1000);
    expect(getActiveAgentCount).not.toHaveBeenCalled();
    expect(onPressure).not.toHaveBeenCalled();

    // Starve remaining commit so tick 2 crosses the threshold.
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 1 });
    vi.advanceTimersByTime(1000);

    expect(getActiveAgentCount).toHaveBeenCalledTimes(1);
    expect(onPressure).toHaveBeenCalledTimes(1);
    // A transposed or hardcoded argument (e.g. always 0, or the sample twice)
    // would pass every other test in this file but fail here.
    const [sampleArgument, activeAgentCountArgument] = onPressure.mock.calls[0];
    expect(activeAgentCountArgument).toBe(7);
    expect(sampleArgument.commitRemainingBytes).toBe(1 * 1024);

    dispose();
  });

  it('never reads getActiveAgentCount on a recovery crossing, and threads the sample into onRecovery', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Tick 1: below the line, warns.
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 1 });
    const getActiveAgentCount = vi.fn(() => 7);
    const onRecovery = vi.fn();

    const dispose = startHostMemorySampler({
      getActiveAgentCount,
      onPressure: vi.fn(),
      onRecovery,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(getActiveAgentCount).toHaveBeenCalledTimes(1);

    // Tick 2: fully recovers past the hysteresis line.
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 50_000_000 });
    vi.advanceTimersByTime(1000);

    expect(onRecovery).toHaveBeenCalledTimes(1);
    // Recovery needs no agent count - the read above must not have happened
    // again for this tick.
    expect(getActiveAgentCount).toHaveBeenCalledTimes(1);
    const [sampleArgument] = onRecovery.mock.calls[0];
    expect(sampleArgument.commitRemainingBytes).toBe(50_000_000 * 1024);

    dispose();
  });

  it('records every tick sample in getLastHostMemorySample(), even a tick with no pressure crossing', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Healthy headroom: onPressure never fires this tick, but the crash-time
    // reader (crash-capture.ts, and the give-up dialog's detail line) must
    // still see a fresh sample recorded regardless.
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 50_000_000 });

    const dispose = startHostMemorySampler({
      getActiveAgentCount: () => 0,
      onPressure: vi.fn(),
      onRecovery: vi.fn(),
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    const sample = getLastHostMemorySample();
    expect(sample).not.toBeNull();
    expect(sample?.commitRemainingBytes).toBe(50_000_000 * 1024);

    dispose();
  });
});
