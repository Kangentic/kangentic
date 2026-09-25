import { describe, it, expect } from 'vitest';
import {
  createRendererReloadGate,
  isRecoverableRendererDeath,
  formatHostMemoryDetailLine,
  RENDERER_RELOAD_MAX,
  RENDERER_RELOAD_WINDOW_MS,
} from '../../src/main/diagnostics/renderer-recovery';
import type { HostMemorySample } from '../../src/shared/types';

describe('isRecoverableRendererDeath', () => {
  it('recovers from oom and crashed', () => {
    expect(isRecoverableRendererDeath('oom')).toBe(true);
    expect(isRecoverableRendererDeath('crashed')).toBe(true);
  });

  it('never reloads for clean-exit or killed - those are usually us', () => {
    expect(isRecoverableRendererDeath('clean-exit')).toBe(false);
    expect(isRecoverableRendererDeath('killed')).toBe(false);
    expect(isRecoverableRendererDeath('launch-failed')).toBe(false);
    expect(isRecoverableRendererDeath('integrity-failure')).toBe(false);
  });
});

describe('createRendererReloadGate', () => {
  it('allows reloads up to the cap', () => {
    const gate = createRendererReloadGate();
    for (let attempt = 0; attempt < RENDERER_RELOAD_MAX; attempt++) {
      expect(gate.tryReload(attempt * 1000)).toBe(true);
    }
  });

  it('denies once the cap is reached within the window', () => {
    const gate = createRendererReloadGate();
    for (let attempt = 0; attempt < RENDERER_RELOAD_MAX; attempt++) {
      gate.tryReload(attempt * 1000);
    }
    expect(gate.tryReload(RENDERER_RELOAD_MAX * 1000)).toBe(false);
  });

  it('never exceeds the cap even with many more attempts', () => {
    const gate = createRendererReloadGate();
    let allowed = 0;
    for (let attempt = 0; attempt < RENDERER_RELOAD_MAX * 5; attempt++) {
      if (gate.tryReload(attempt * 1000)) allowed++;
    }
    expect(allowed).toBe(RENDERER_RELOAD_MAX);
  });

  it('re-allows a reload once the oldest attempt rolls outside the window', () => {
    const gate = createRendererReloadGate();
    // Spread the three attempts out so only the OLDEST rolls off the window
    // at the boundary checked below (a tight cluster would drop more than
    // one at once and the test would not isolate the boundary).
    expect(gate.tryReload(0)).toBe(true);
    expect(gate.tryReload(100)).toBe(true);
    expect(gate.tryReload(200)).toBe(true);
    // Still inside the window for all three: denied.
    expect(gate.tryReload(RENDERER_RELOAD_WINDOW_MS - 1)).toBe(false);
    // Exactly at the window boundary from the FIRST attempt (t=0): that one
    // attempt has rolled off (strictly less-than), freeing one slot.
    expect(gate.tryReload(RENDERER_RELOAD_WINDOW_MS)).toBe(true);
    // The slot is consumed again immediately - denied.
    expect(gate.tryReload(RENDERER_RELOAD_WINDOW_MS + 1)).toBe(false);
  });
});

function sample(overrides: Partial<HostMemorySample> = {}): HostMemorySample {
  return {
    ts: '2026-09-16T14:24:24.000Z',
    platform: 'win32',
    commitLimitBytes: 96_432_717_824,
    commitRemainingBytes: 2_256_896,
    physicalTotalBytes: 34_060_931_072,
    physicalFreeBytes: 5_005_045_760,
    ...overrides,
  };
}

describe('formatHostMemoryDetailLine', () => {
  it('reports the last known commit headroom in whole megabytes', () => {
    const line = formatHostMemoryDetailLine(sample({ commitRemainingBytes: 2_256_896 }));
    expect(line).toContain('2 MB');
  });

  it('returns null when there is no sample yet', () => {
    expect(formatHostMemoryDetailLine(null)).toBeNull();
  });

  it('returns null when the platform has no commit reading, rather than printing "unknown"', () => {
    expect(formatHostMemoryDetailLine(sample({ platform: 'darwin', commitRemainingBytes: null }))).toBeNull();
  });
});
