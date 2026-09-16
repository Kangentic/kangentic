import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createHostMemoryPressureState,
  evaluateHostMemoryPressure,
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
      const warned = evaluateHostMemoryPressure(sample({ commitRemainingBytes: 10 * GB }), state, tick * 60_000);
      expect(warned).toBe(false);
    }
  });

  it('reproduces the real DESKTOP-16 event: 89.8 GB limit, 2.15 MB remaining', () => {
    const state = createHostMemoryPressureState();
    const warned = evaluateHostMemoryPressure(
      sample({ commitLimitBytes: 96_432_717_824, commitRemainingBytes: 2_256_896 }),
      state,
      0
    );
    expect(warned).toBe(true);
  });

  it('is edge-triggered: 10 consecutive ticks below the line warn exactly once', () => {
    const state = createHostMemoryPressureState();
    const lowSample = sample({ commitRemainingBytes: 100 * 1024 * 1024 }); // 100 MB, well under 2 GB
    const results = Array.from({ length: 10 }, (_unused, tick) =>
      evaluateHostMemoryPressure(lowSample, state, tick * 60_000)
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[0]).toBe(true);
  });

  it('does not re-arm on a partial recovery (must clear the hysteresis line, not just the threshold)', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);
    // First warning.
    expect(evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold / 2 }), state, 0)).toBe(true);
    // Recovers to just above the threshold but below 2x it (the hysteresis line).
    evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold * 1.2 }), state, 60_000);
    // Dips back under the threshold - must NOT warn again, since it never cleared hysteresis.
    const warnedAgain = evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold / 2 }), state, 120_000);
    expect(warnedAgain).toBe(false);
  });

  it('re-arms once headroom recovers past 2x the threshold, and warns again on the next dip', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);
    expect(evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold / 2 }), state, 0)).toBe(true);
    // Fully recovers past the hysteresis line.
    evaluateHostMemoryPressure(sample({ commitRemainingBytes: threshold * 3 }), state, 60_000);
    // Dips back under, long after the minimum interval - should warn again.
    const warnedAgain = evaluateHostMemoryPressure(
      sample({ commitRemainingBytes: threshold / 2 }),
      state,
      2 * 60 * 60_000
    );
    expect(warnedAgain).toBe(true);
  });

  it('holds a 30-minute floor between warnings even while oscillating across the line', () => {
    const state = createHostMemoryPressureState();
    const threshold = pressureThreshold(96_432_717_824);
    const below = sample({ commitRemainingBytes: threshold / 2 });
    const recovered = sample({ commitRemainingBytes: threshold * 3 });

    expect(evaluateHostMemoryPressure(below, state, 0)).toBe(true);
    // Oscillate every minute for 20 minutes - each recovery re-arms, each dip
    // is still inside the 30-minute floor, so none of these may warn.
    let anyWarnedInsideFloor = false;
    for (let minute = 1; minute <= 20; minute++) {
      evaluateHostMemoryPressure(recovered, state, minute * 60_000);
      if (evaluateHostMemoryPressure(below, state, minute * 60_000 + 30_000)) {
        anyWarnedInsideFloor = true;
      }
    }
    expect(anyWarnedInsideFloor).toBe(false);
    // Past the 30-minute floor, a fresh dip may warn again.
    evaluateHostMemoryPressure(recovered, state, 31 * 60_000);
    expect(evaluateHostMemoryPressure(below, state, 32 * 60_000)).toBe(true);
  });

  it('never warns when the platform has no commit reading (macOS/Linux)', () => {
    const state = createHostMemoryPressureState();
    const warned = evaluateHostMemoryPressure(
      sample({ platform: 'darwin', commitLimitBytes: null, commitRemainingBytes: null }),
      state,
      0
    );
    expect(warned).toBe(false);
  });

  it('never warns and never divides by zero on a degraded zero-limit reading', () => {
    const state = createHostMemoryPressureState();
    const warned = evaluateHostMemoryPressure(
      sample({ commitLimitBytes: 0, commitRemainingBytes: 0 }),
      state,
      0
    );
    expect(warned).toBe(false);
  });

  it('uses the relative arm on a small machine (8 GB limit -> ~400 MB threshold)', () => {
    const state = createHostMemoryPressureState();
    const limit = 8 * GB;
    // Just above 5% of 8 GB (400 MB) - must not warn.
    expect(evaluateHostMemoryPressure(sample({ commitLimitBytes: limit, commitRemainingBytes: 0.06 * limit }), state, 0)).toBe(false);
    // Just below 5% of 8 GB - must warn.
    expect(evaluateHostMemoryPressure(sample({ commitLimitBytes: limit, commitRemainingBytes: 0.04 * limit }), state, 60_000)).toBe(true);
  });

  it('uses the absolute arm on a large machine (89.8 GB limit -> 2 GB threshold, not 5%)', () => {
    const state = createHostMemoryPressureState();
    const limit = 96_432_717_824; // 5% of this is ~4.5 GB, far above the 2 GB absolute floor
    // 3 GB remaining: above the 2 GB absolute floor, so no warning even though
    // it is well under 5% of the limit.
    expect(evaluateHostMemoryPressure(sample({ commitLimitBytes: limit, commitRemainingBytes: 3 * GB }), state, 0)).toBe(false);
    // 1 GB remaining: below the 2 GB absolute floor.
    expect(evaluateHostMemoryPressure(sample({ commitLimitBytes: limit, commitRemainingBytes: 1 * GB }), state, 60_000)).toBe(true);
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
});

