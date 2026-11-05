import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The macOS pressure level is read through `sysctl` off the main thread. Only
// the sampler's wiring test reaches it; every other test here stubs a platform
// that never reads, or injects its own reader.
const mocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
}));
vi.mock('../../src/main/utility-process/off-main-exec', () => ({ execFileAsync: mocks.execFileAsync }));

import {
  createLowMemoryLatch,
  createLowMemorySpellState,
  createMacSysctlReader,
  getLastHostMemorySample,
  memoryHeadroom,
  sampleAsRead,
  setSimulatedLowMemory,
  parseMacFreePercent,
  parseMacSysctlInteger,
  pressureThreshold,
  recoveryLine,
  sampleHostMemory,
  simulateLowMemorySample,
  startHostMemorySampler,
  trackLowMemorySpell,
  updateLowMemoryLatch,
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
    physicalAvailableBytes: null,
    ...overrides,
  };
}

const GB = 1024 * 1024 * 1024;

describe('updateLowMemoryLatch', () => {
  const readLatch = (reading: HostMemorySample, latch = createLowMemoryLatch()): boolean =>
    updateLowMemoryLatch(memoryHeadroom(reading), latch);

  it('stays off while headroom stays above the threshold', () => {
    expect(readLatch(sample({ commitRemainingBytes: 10 * GB }))).toBe(false);
  });

  it('turns on for the real DESKTOP-16 reading: 89.8 GB limit, 2.15 MB remaining', () => {
    expect(readLatch(sample({ commitLimitBytes: 96_432_717_824, commitRemainingBytes: 2_254_438 }))).toBe(true);
  });

  it('holds through a partial recovery, and clears past the recovery line', () => {
    const threshold = pressureThreshold(sample().commitLimitBytes!);
    const latch = createLowMemoryLatch();
    expect(readLatch(sample({ commitRemainingBytes: threshold / 2 }), latch)).toBe(true);
    expect(readLatch(sample({ commitRemainingBytes: threshold * 1.2 }), latch)).toBe(true);
    expect(readLatch(sample({ commitRemainingBytes: threshold * 2 }), latch)).toBe(false);
  });

  it('keeps a latch off in the band between the threshold and the recovery line', () => {
    const threshold = pressureThreshold(sample().commitLimitBytes!);
    expect(readLatch(sample({ commitRemainingBytes: threshold * 1.2 }))).toBe(false);
  });

  it('uses the relative arm on a small machine (8 GB limit -> ~400 MB threshold)', () => {
    const limit = 8 * GB;
    expect(readLatch(sample({ commitLimitBytes: limit, commitRemainingBytes: 0.06 * limit }))).toBe(false);
    expect(readLatch(sample({ commitLimitBytes: limit, commitRemainingBytes: 0.04 * limit }))).toBe(true);
  });

  it('uses the absolute arm on a large machine (89.8 GB limit -> 2 GB threshold, not 5%)', () => {
    const limit = 96_432_717_824;
    expect(readLatch(sample({ commitLimitBytes: limit, commitRemainingBytes: 3 * GB }))).toBe(false);
    expect(readLatch(sample({ commitLimitBytes: limit, commitRemainingBytes: 1 * GB }))).toBe(true);
  });

  it('leaves the latch alone on a missing reading, which reads as not low', () => {
    const latch = createLowMemoryLatch();
    readLatch(sample({ commitRemainingBytes: 1 * GB }), latch);
    expect(updateLowMemoryLatch(null, latch)).toBe(false);
    expect(latch.active).toBe(true);
  });
});

describe('trackLowMemorySpell', () => {
  const headroomOf = (remainingGb: number, limitGb = 78.6) =>
    memoryHeadroom(sample({ commitLimitBytes: limitGb * GB, commitRemainingBytes: remainingGb * GB }));
  const minutes = (count: number): number => count * 60_000;

  it('says nothing on a healthy machine', () => {
    const state = createLowMemorySpellState();
    for (let tick = 0; tick < 5; tick++) {
      expect(trackLowMemorySpell(headroomOf(30), state, minutes(tick))).toBeNull();
    }
  });

  it('logs once when a spell starts, and stays quiet while it lasts', () => {
    const state = createLowMemorySpellState();
    expect(trackLowMemorySpell(headroomOf(0.9), state, 0)).toBe('Memory reads low: 0.9 GB left of 78.6 GB.');
    expect(trackLowMemorySpell(headroomOf(1.5), state, minutes(1))).toBeNull();
    expect(trackLowMemorySpell(headroomOf(3), state, minutes(2))).toBeNull();
  });

  it('logs how long a spell lasted, how low it went and that the limit moved', () => {
    const state = createLowMemorySpellState();
    trackLowMemorySpell(headroomOf(1.5, 78.6), state, 0);
    trackLowMemorySpell(headroomOf(0.9, 78.6), state, minutes(2));
    expect(trackLowMemorySpell(headroomOf(9, 85), state, minutes(6)))
      .toBe('Memory recovered after 6 min: lowest 0.9 GB left, limit 78.6 GB then 85.0 GB.');
  });

  it('names one limit when it did not move', () => {
    const state = createLowMemorySpellState();
    trackLowMemorySpell(headroomOf(1), state, 0);
    expect(trackLowMemorySpell(headroomOf(9), state, minutes(1)))
      .toBe('Memory recovered after 1 min: lowest 1.0 GB left, limit 78.6 GB.');
  });

  it('starts a new spell after one ends', () => {
    const state = createLowMemorySpellState();
    trackLowMemorySpell(headroomOf(1), state, 0);
    trackLowMemorySpell(headroomOf(9), state, minutes(1));
    expect(trackLowMemorySpell(headroomOf(1), state, minutes(2))).toBe('Memory reads low: 1.0 GB left of 78.6 GB.');
  });

  it('leaves a spell open across a missing reading', () => {
    const state = createLowMemorySpellState();
    trackLowMemorySpell(headroomOf(1), state, 0);
    expect(trackLowMemorySpell(null, state, minutes(1))).toBeNull();
    expect(trackLowMemorySpell(headroomOf(9), state, minutes(2))).toContain('after 2 min');
  });

  it('logs a spell a platform reports only as a level', () => {
    const state = createLowMemorySpellState();
    expect(trackLowMemorySpell({ kind: 'level', low: true }, state, 0))
      .toBe('Memory reads low: the system reports critical pressure.');
    expect(trackLowMemorySpell({ kind: 'level', low: false }, state, minutes(3))).toBe('Memory recovered after 3 min.');
  });
});

describe('simulateLowMemorySample', () => {
  it.each([
    ['win32', sample()],
    ['linux', sample({ platform: 'linux', commitLimitBytes: null, commitRemainingBytes: null, physicalAvailableBytes: 8 * GB, swapTotalBytes: GB, swapFreeBytes: GB })],
    ['darwin', sample({ platform: 'darwin', commitLimitBytes: null, commitRemainingBytes: null, memoryPressureLevel: 1 })],
  ])('reads as low on %s', (_platform, reading) => {
    expect(updateLowMemoryLatch(memoryHeadroom(simulateLowMemorySample(reading)), createLowMemoryLatch())).toBe(true);
  });
});

/**
 * The simulation is dev only. vitest defines `__KANGENTIC_DEV__` as false, the
 * same value a production build has, so this pins that a production build
 * ignores the switch. The simulated branch itself is covered by
 * simulateLowMemorySample above.
 */
describe('sampleAsRead with the dev switch on, in a production build', () => {
  afterEach(() => {
    setSimulatedLowMemory(false);
  });

  it('returns the very sample it was given', () => {
    setSimulatedLowMemory(true);
    const reading = sample();

    expect(sampleAsRead(reading)).toBe(reading);
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

  function stubMemoryInfo(info: {
    total: number;
    free: number;
    swapTotal: number;
    swapFree: number;
    available?: number;
  }): void {
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

  // Linux's `free` is MemFree, which excludes page cache and reads near zero on a healthy
  // machine, so a recorded Linux sample said nothing about pressure. `available` is MemAvailable.
  it('records MemAvailable on linux, from `available`, kept apart from MemFree', () => {
    stubPlatform('linux');
    stubMemoryInfo({ total: 111_000, free: 222_000, swapTotal: 333_000, swapFree: 444_000, available: 555_000 });

    const result = sampleHostMemory();

    expect(result.platform).toBe('linux');
    expect(result.physicalAvailableBytes).toBe(555_000 * 1024);
    expect(result.physicalFreeBytes).toBe(222_000 * 1024);
  });

  it('reports no available reading on linux when the runtime does not supply one', () => {
    stubPlatform('linux');
    stubMemoryInfo({ total: 111_000, free: 222_000, swapTotal: 333_000, swapFree: 444_000 });

    expect(sampleHostMemory().physicalAvailableBytes).toBeNull();
  });

  it.each(['win32', 'darwin'] as const)('reports no available reading on %s, even if a value is present', (platform) => {
    stubPlatform(platform);
    stubMemoryInfo({ total: 111_000, free: 222_000, swapTotal: 333_000, swapFree: 444_000, available: 555_000 });

    const result = sampleHostMemory();

    expect(result.platform).toBe(platform);
    expect(result.physicalAvailableBytes).toBeNull();
  });

  // Headroom reads RAM plus swap on Linux.
  it('records swap on linux, in bytes', () => {
    stubPlatform('linux');
    stubMemoryInfo({ total: 111_000, free: 222_000, swapTotal: 333_000, swapFree: 444_000, available: 555_000 });

    const result = sampleHostMemory();

    expect(result.swapTotalBytes).toBe(333_000 * 1024);
    expect(result.swapFreeBytes).toBe(444_000 * 1024);
  });

  it.each(['win32', 'darwin'] as const)('reports no swap reading on %s, where swap means something else or nothing', (platform) => {
    stubPlatform(platform);
    stubMemoryInfo({ total: 111_000, free: 222_000, swapTotal: 333_000, swapFree: 444_000 });

    const result = sampleHostMemory();

    expect(result.swapTotalBytes).toBeNull();
    expect(result.swapFreeBytes).toBeNull();
  });

  it('carries the cached pressure level on darwin and drops it everywhere else', () => {
    stubMemoryInfo({ total: 111_000, free: 222_000 });

    stubPlatform('darwin');
    expect(sampleHostMemory({ memoryPressureLevel: 4 }).memoryPressureLevel).toBe(4);
    expect(sampleHostMemory().memoryPressureLevel).toBeNull();

    stubPlatform('win32');
    expect(sampleHostMemory({ memoryPressureLevel: 4 }).memoryPressureLevel).toBeNull();
  });
});

describe('memoryHeadroom', () => {
  it('reads commit headroom on Windows', () => {
    expect(memoryHeadroom(sample({ commitLimitBytes: 64 * GB, commitRemainingBytes: 3 * GB }))).toEqual({
      kind: 'bytes',
      remainingBytes: 3 * GB,
      limitBytes: 64 * GB,
    });
  });

  it('has no Windows reading without commit figures, or with a zero limit', () => {
    expect(memoryHeadroom(sample({ commitLimitBytes: null, commitRemainingBytes: null }))).toBeNull();
    expect(memoryHeadroom(sample({ commitLimitBytes: 0, commitRemainingBytes: 0 }))).toBeNull();
  });

  it('reads RAM plus swap on Linux, so a healthy machine with cold pages in swap is not low', () => {
    const headroom = memoryHeadroom(sample({
      platform: 'linux',
      commitLimitBytes: null,
      commitRemainingBytes: null,
      physicalTotalBytes: 16 * GB,
      physicalAvailableBytes: 1 * GB,
      swapTotalBytes: 8 * GB,
      swapFreeBytes: 6 * GB,
    }));

    expect(headroom).toEqual({ kind: 'bytes', remainingBytes: 7 * GB, limitBytes: 24 * GB });
  });

  it('reads RAM alone on Linux when the sample predates the swap fields', () => {
    const headroom = memoryHeadroom(sample({
      platform: 'linux',
      commitLimitBytes: null,
      commitRemainingBytes: null,
      physicalTotalBytes: 16 * GB,
      physicalAvailableBytes: 2 * GB,
    }));

    expect(headroom).toEqual({ kind: 'bytes', remainingBytes: 2 * GB, limitBytes: 16 * GB });
  });

  it('has no Linux reading without MemAvailable', () => {
    expect(memoryHeadroom(sample({ platform: 'linux', commitLimitBytes: null, commitRemainingBytes: null }))).toBeNull();
  });

  it.each([[4, true], [1, false]] as const)('reads macOS pressure level %i as low=%s', (level, low) => {
    expect(memoryHeadroom(sample({ platform: 'darwin', commitLimitBytes: null, commitRemainingBytes: null, memoryPressureLevel: level })))
      .toEqual({ kind: 'level', low });
  });

  describe('macOS at the warn level', () => {
    // A real report: 36 GB of RAM, level 2 on every check, 36% free, swap 94% full.
    const warnAt = (memoryFreePercent: number | null): HostMemorySample => sample({
      platform: 'darwin',
      commitLimitBytes: null,
      commitRemainingBytes: null,
      physicalTotalBytes: 36 * GB,
      memoryPressureLevel: 2,
      memoryFreePercent,
    });

    it('does not read as low with 36% of a 36 GB machine free', () => {
      expect(updateLowMemoryLatch(memoryHeadroom(warnAt(36)), createLowMemoryLatch())).toBe(false);
    });

    it('reads as low once the free percentage falls under the threshold', () => {
      expect(updateLowMemoryLatch(memoryHeadroom(warnAt(4)), createLowMemoryLatch())).toBe(true);
    });

    it('holds its latch between the threshold and the recovery line, and clears past it', () => {
      const latch = createLowMemoryLatch();
      updateLowMemoryLatch(memoryHeadroom(warnAt(4)), latch);
      expect(updateLowMemoryLatch(memoryHeadroom(warnAt(8)), latch)).toBe(true);
      expect(updateLowMemoryLatch(memoryHeadroom(warnAt(36)), latch)).toBe(false);
    });

    it('clears a critical latch once warn shows plenty free', () => {
      const latch = createLowMemoryLatch();
      const critical = sample({ platform: 'darwin', commitLimitBytes: null, commitRemainingBytes: null, memoryPressureLevel: 4 });
      updateLowMemoryLatch(memoryHeadroom(critical), latch);
      expect(updateLowMemoryLatch(memoryHeadroom(warnAt(36)), latch)).toBe(false);
    });

    it('has no reading without the free percentage', () => {
      expect(memoryHeadroom(warnAt(null))).toBeNull();
    });
  });

  it.each([null, 0, 3, 8])('has no macOS reading for level %s', (level) => {
    expect(memoryHeadroom(sample({ platform: 'darwin', commitLimitBytes: null, commitRemainingBytes: null, memoryPressureLevel: level })))
      .toBeNull();
  });

  it('has no reading on any other platform', () => {
    expect(memoryHeadroom(sample({ platform: 'freebsd' }))).toBeNull();
  });

  it('puts the recovery line at twice the threshold', () => {
    expect(recoveryLine(64 * GB)).toBe(pressureThreshold(64 * GB) * 2);
  });
});

describe('parseMacSysctlInteger', () => {
  it('reads the number sysctl prints, ignoring the newline', () => {
    expect(parseMacSysctlInteger('1\n')).toBe(1);
    expect(parseMacSysctlInteger(' 4 ')).toBe(4);
  });

  it('reads anything else as unknown', () => {
    expect(parseMacSysctlInteger('')).toBeNull();
    expect(parseMacSysctlInteger('sysctl: unknown oid')).toBeNull();
    expect(parseMacSysctlInteger('-1')).toBeNull();
  });
});

describe('parseMacFreePercent', () => {
  it('reads a percentage, and nothing past 100', () => {
    expect(parseMacFreePercent('36\n')).toBe(36);
    expect(parseMacFreePercent('0')).toBe(0);
    expect(parseMacFreePercent('100')).toBe(100);
    expect(parseMacFreePercent('101')).toBeNull();
    expect(parseMacFreePercent('sysctl: unknown oid')).toBeNull();
  });
});

describe('createMacSysctlReader', () => {
  async function settle(): Promise<void> {
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  }

  it('has nothing until a read lands, then serves it until it is older than the cap', async () => {
    let clock = 1_000;
    const reader = createMacSysctlReader(async () => 2, () => clock);

    expect(reader.current(clock, 120_000)).toBeNull();
    reader.refresh();
    await settle();

    expect(reader.current(clock, 120_000)).toBe(2);
    clock += 120_000;
    expect(reader.current(clock, 120_000)).toBe(2);
    expect(reader.current(clock + 1, 120_000)).toBeNull();
  });

  it('forgets the level when a read fails', async () => {
    let level: number | null = 4;
    const reader = createMacSysctlReader(async () => level, () => 1_000);
    reader.refresh();
    await settle();
    expect(reader.current(1_000, 120_000)).toBe(4);

    level = null;
    reader.refresh();
    await settle();
    expect(reader.current(1_000, 120_000)).toBeNull();
  });

  it('runs one read at a time', async () => {
    let finish: (level: number) => void = () => {};
    const read = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const reader = createMacSysctlReader(read, () => 1_000);

    reader.refresh();
    reader.refresh();
    expect(read).toHaveBeenCalledTimes(1);

    finish(1);
    await settle();
    reader.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps a read that lands after dispose out of the cache', async () => {
    let finish: (level: number) => void = () => {};
    const reader = createMacSysctlReader(() => new Promise<number>((resolve) => { finish = resolve; }), () => 1_000);

    reader.refresh();
    reader.dispose();
    finish(4);
    await settle();

    expect(reader.current(1_000, 120_000)).toBeNull();
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

  function stubMemoryInfo(info: {
    total: number;
    free: number;
    swapTotal: number;
    swapFree: number;
    available?: number;
  }): void {
    (process as unknown as { getSystemMemoryInfo: () => typeof info }).getSystemMemoryInfo = () => info;
  }

  beforeEach(() => {
    // Calls from a darwin test must not leak into a later test's count.
    mocks.execFileAsync.mockReset();
  });

  afterEach(() => {
    setSimulatedLowMemory(false);
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

  it('logs one warning when a low spell starts and one when it ends', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 50_000_000 });
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dispose = startHostMemorySampler({ intervalMs: 1000 });

    vi.advanceTimersByTime(1000);
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    // Past the threshold: one line, however many ticks it stays there.
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 1 });
    vi.advanceTimersByTime(3000);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy.mock.calls[0][0]).toMatch(/^\[host-memory\] Memory reads low: /);

    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 50_000_000 });
    vi.advanceTimersByTime(1000);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
    expect(consoleWarnSpy.mock.calls[1][0]).toMatch(/^\[host-memory\] Memory recovered after /);

    dispose();
    consoleWarnSpy.mockRestore();
  });

  it('logs no low-memory warning on a healthy sample with the dev switch on, in a production build', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 50_000_000 });
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setSimulatedLowMemory(true);

    const dispose = startHostMemorySampler({ intervalMs: 1000 });
    vi.advanceTimersByTime(3000);

    expect(consoleWarnSpy).not.toHaveBeenCalled();

    dispose();
    consoleWarnSpy.mockRestore();
  });

  it('still logs a spell on a tick whose onSample throws', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 1 });
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const dispose = startHostMemorySampler({
      onSample: () => {
        throw new Error('diagnostics boom');
      },
      intervalMs: 1000,
    });
    vi.advanceTimersByTime(1000);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

    dispose();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('records every tick sample in getLastHostMemorySample()', () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // The crash-time reader (crash-capture.ts, and the give-up dialog's detail
    // line) must see a fresh sample.
    stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 100_000_000, swapFree: 50_000_000 });

    const dispose = startHostMemorySampler({
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    const sample = getLastHostMemorySample();
    expect(sample).not.toBeNull();
    expect(sample?.commitRemainingBytes).toBe(50_000_000 * 1024);

    dispose();
  });

  describe('macOS pressure level', () => {
    const SYSCTL_ARGUMENTS = ['-n', 'kern.memorystatus_vm_pressure_level'];

    function startOnDarwin(onSample: (sample: HostMemorySample) => void): () => void {
      vi.useFakeTimers();
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 0, swapFree: 0 });
      return startHostMemorySampler({
        onSample,
        intervalMs: 1000,
      });
    }

    function levelOf(onSample: ReturnType<typeof vi.fn>, tickIndex: number): number | null | undefined {
      return (onSample.mock.calls[tickIndex][0] as HostMemorySample).memoryPressureLevel;
    }

    it('reads once at start, then hands each tick the level the run before it cached', async () => {
      const levels = ['1\n', '4\n'];
      mocks.execFileAsync.mockImplementation(async (_file: string, args: string[]) => ({
        stdout: args[1] === SYSCTL_ARGUMENTS[1] ? levels.shift() ?? '1\n' : '36\n',
        stderr: '',
      }));
      const levelReads = (): number => mocks.execFileAsync.mock.calls
        .filter((call) => (call[1] as string[])[1] === SYSCTL_ARGUMENTS[1]).length;
      const onSample = vi.fn();

      const dispose = startOnDarwin(onSample);

      // The first level is read ahead of the first tick, off the main thread.
      expect(levelReads()).toBe(1);
      expect(mocks.execFileAsync).toHaveBeenCalledWith('/usr/sbin/sysctl', SYSCTL_ARGUMENTS, expect.anything());

      // The first tick already carries the start-up read, and starts the next.
      await vi.advanceTimersByTimeAsync(1000);
      expect(levelOf(onSample, 0)).toBe(1);
      expect(levelReads()).toBe(2);

      // The second tick carries what the first tick's run read.
      await vi.advanceTimersByTimeAsync(1000);
      expect(levelOf(onSample, 1)).toBe(4);
      expect(levelReads()).toBe(3);

      dispose();
    });

    it('carries the free percentage beside the level, from a read of its own', async () => {
      mocks.execFileAsync.mockImplementation(async (_file: string, args: string[]) => {
        if (args[1] === SYSCTL_ARGUMENTS[1]) return { stdout: '2\n', stderr: '' };
        return { stdout: '36\n', stderr: '' };
      });
      const onSample = vi.fn();

      const dispose = startOnDarwin(onSample);
      await vi.advanceTimersByTimeAsync(1000);

      expect(levelOf(onSample, 0)).toBe(2);
      expect((onSample.mock.calls[0][0] as HostMemorySample).memoryFreePercent).toBe(36);

      dispose();
    });

    it('keeps the level when this macOS has no free percentage', async () => {
      mocks.execFileAsync.mockImplementation(async (_file: string, args: string[]) => {
        if (args[1] === SYSCTL_ARGUMENTS[1]) return { stdout: '4\n', stderr: '' };
        throw new Error('sysctl: unknown oid');
      });
      const onSample = vi.fn();

      const dispose = startOnDarwin(onSample);
      await vi.advanceTimersByTimeAsync(1000);

      expect(levelOf(onSample, 0)).toBe(4);
      expect((onSample.mock.calls[0][0] as HostMemorySample).memoryFreePercent).toBeNull();

      dispose();
    });

    it('counts a level older than two intervals as unknown, and not before', async () => {
      // The start-up read lands; every later run hangs, so the cache only ages.
      mocks.execFileAsync
        .mockResolvedValueOnce({ stdout: '4\n', stderr: '' })
        .mockImplementation(() => new Promise<never>(() => {}));
      const onSample = vi.fn();

      const dispose = startOnDarwin(onSample);

      await vi.advanceTimersByTimeAsync(1000);
      expect(levelOf(onSample, 0)).toBe(4);
      // Exactly two intervals old still counts.
      await vi.advanceTimersByTimeAsync(1000);
      expect(levelOf(onSample, 1)).toBe(4);
      // Past two intervals it is unknown rather than a stale verdict.
      await vi.advanceTimersByTimeAsync(1000);
      expect(levelOf(onSample, 2)).toBeNull();

      dispose();
    });

    // The reader's own dispose() is not observable through the sampler: the
    // cleared interval is the only caller of its refresh() and current(). The
    // reader's dispose behavior is pinned in createMacSysctlReader's tests.
    it('stops reading and sampling once the stop function has run', async () => {
      mocks.execFileAsync.mockResolvedValue({ stdout: '1\n', stderr: '' });
      const onSample = vi.fn();

      const dispose = startOnDarwin(onSample);
      await vi.advanceTimersByTimeAsync(2000);
      expect(onSample).toHaveBeenCalledTimes(2);
      const readsBeforeStop = mocks.execFileAsync.mock.calls.length;
      expect(readsBeforeStop).toBeGreaterThan(0);

      dispose();
      await vi.advanceTimersByTimeAsync(5000);

      // Neither a tick nor a read follows the stop.
      expect(mocks.execFileAsync).toHaveBeenCalledTimes(readsBeforeStop);
      expect(onSample).toHaveBeenCalledTimes(2);
    });

    it.each(['win32', 'linux'] as const)('never creates a reader on %s: no sysctl run, no level in the sample', async (platform) => {
      vi.useFakeTimers();
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      stubMemoryInfo({ total: 1000, free: 1000, swapTotal: 0, swapFree: 0 });
      mocks.execFileAsync.mockResolvedValue({ stdout: '4\n', stderr: '' });
      const onSample = vi.fn();

      const dispose = startHostMemorySampler({
        onSample,
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(3000);

      expect(onSample).toHaveBeenCalledTimes(3);
      expect(mocks.execFileAsync).not.toHaveBeenCalled();
      for (let tickIndex = 0; tickIndex < 3; tickIndex++) {
        expect(levelOf(onSample, tickIndex)).toBeNull();
      }

      dispose();
    });
  });
});
