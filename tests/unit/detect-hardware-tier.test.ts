import { describe, it, expect, vi } from 'vitest';
import type { DictationHardwareProfile } from '../../src/shared/types';

// detect-hardware.ts imports `app` from electron for GPU detection, but
// `selectTier` is a pure function that only reads the pre-built profile.
// Mock the module so the import succeeds in the unit-test environment.
vi.mock('electron', () => ({
  app: { getGPUInfo: vi.fn(async () => ({ gpuDevice: [] })) },
}));

import { selectTier } from '../../src/main/transcription/hardware/detect-hardware';

/**
 * `selectTier(profile)` maps a hardware profile to a coarse engine tier using
 * three ordered checks:
 *
 *   1. GPU backend (cuda / metal) -> 'accurate-base' (GPU acceleration wins)
 *   2. cpuCores <= 2 OR totalRamGb < 4 -> 'streaming-tiny' (genuinely weak)
 *   3. cpuCores >= 4 -> 'accurate-base' (reasonable multi-core machine)
 *   4. fall-through (3 cores, >= 4 GB, no GPU) -> 'streaming-tiny' (conservative)
 */

function makeProfile(overrides: Partial<DictationHardwareProfile> = {}): DictationHardwareProfile {
  return {
    cpuModel: 'Test CPU 8-Core',
    cpuCores: 8,
    totalRamGb: 16,
    hasAvx2: false,
    gpu: 'none',
    platform: 'linux',
    arch: 'x64',
    ...overrides,
  };
}

describe('selectTier - GPU acceleration (branch 1, takes priority over cpu/ram)', () => {
  it('cuda -> accurate-base even on an otherwise weak machine', () => {
    expect(selectTier(makeProfile({ gpu: 'cuda', cpuCores: 1, totalRamGb: 2 }))).toBe('accurate-base');
  });

  it('metal -> accurate-base even on an otherwise weak machine', () => {
    expect(selectTier(makeProfile({ gpu: 'metal', cpuCores: 1, totalRamGb: 2 }))).toBe('accurate-base');
  });
});

describe('selectTier - weak machine (branch 2)', () => {
  it('cpuCores === 2 (boundary) -> streaming-tiny', () => {
    expect(selectTier(makeProfile({ cpuCores: 2, totalRamGb: 16, gpu: 'none' }))).toBe('streaming-tiny');
  });

  it('cpuCores === 1 -> streaming-tiny', () => {
    expect(selectTier(makeProfile({ cpuCores: 1, totalRamGb: 16, gpu: 'none' }))).toBe('streaming-tiny');
  });

  it('totalRamGb < 4 (e.g. 2 GB) -> streaming-tiny even with many cores', () => {
    expect(selectTier(makeProfile({ cpuCores: 8, totalRamGb: 2, gpu: 'none' }))).toBe('streaming-tiny');
  });

  it('totalRamGb === 3.9 (below 4 GB floor) -> streaming-tiny', () => {
    expect(selectTier(makeProfile({ cpuCores: 8, totalRamGb: 3.9, gpu: 'none' }))).toBe('streaming-tiny');
  });
});

describe('selectTier - capable multi-core machine (branch 3)', () => {
  it('cpuCores === 4 (boundary) with adequate RAM -> accurate-base', () => {
    expect(selectTier(makeProfile({ cpuCores: 4, totalRamGb: 8, gpu: 'none' }))).toBe('accurate-base');
  });

  it('cpuCores === 16 with adequate RAM -> accurate-base', () => {
    expect(selectTier(makeProfile({ cpuCores: 16, totalRamGb: 32, gpu: 'none' }))).toBe('accurate-base');
  });
});

describe('selectTier - fall-through (3 cores, adequate RAM, no GPU)', () => {
  it('3 cores + 8 GB + gpu none -> streaming-tiny (conservative default)', () => {
    // 3 cores misses the <=2 weak check AND the >=4 capable check.
    // totalRamGb=8 passes the <4 RAM guard. No GPU acceleration.
    // Falls to the terminal return: streaming-tiny.
    expect(selectTier(makeProfile({ cpuCores: 3, totalRamGb: 8, gpu: 'none' }))).toBe('streaming-tiny');
  });

  it('gpu unknown does not grant accurate-base (detection failure is conservative)', () => {
    expect(selectTier(makeProfile({ gpu: 'unknown', cpuCores: 3, totalRamGb: 8 }))).toBe('streaming-tiny');
  });
});
