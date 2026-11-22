/**
 * The priority level meter (task #1137, equal bars since #1160) carries a level's rank in its
 * lit-bar count, so two levels never differ by color alone. Its numbers and rules come from
 * `@kangentic/branding`'s `assets/priority/meter.json`, which the phone draws from too, and that
 * contract ships worked tables "to test an implementation against". These run the desktop's
 * real functions over those tables, so the desktop cannot drift from the phone.
 */
import { describe, expect, it } from 'vitest';
import meterContract from '@kangentic/branding/assets/priority/meter.json';
import {
  priorityMeterBars,
  priorityMeterWidth,
  snapToDevicePixels,
} from '../../src/renderer/components/backlog/PriorityMeter';

describe('priorityMeterBars against the branding contract', () => {
  it.each(meterContract.examples)('levelCount $levelCount, level $level', (example) => {
    const bars = priorityMeterBars(example.level, example.levelCount);
    expect(bars).toHaveLength(example.opacities.length);
    expect(bars.filter((bar) => bar.filled)).toHaveLength(example.lit);
    expect(bars.map((bar) => bar.opacity)).toEqual(example.opacities);
    expect(priorityMeterWidth(example.levelCount)).toBe(example.width);
  });

  it('lights bars from the left', () => {
    expect(priorityMeterBars(2, 5).map((bar) => bar.filled)).toEqual([true, true, false, false]);
  });
});

describe('priorityMeterWidth at a display scale', () => {
  // The Priority picker sizes its glyph slot with this, so it must be the width the meter draws.
  const barCount = 4; // a 5-level scale
  it.each(meterContract.pixelSnap.examples)('5 levels at $dpr x', (example) => {
    const deviceWidth = barCount * example.device.width + (barCount - 1) * example.device.gap;
    expect(priorityMeterWidth(5, example.dpr) * example.dpr).toBeCloseTo(deviceWidth, 6);
  });

  it('differs from the 1x width at 1.25x', () => {
    expect(priorityMeterWidth(5, 1.25)).not.toBeCloseTo(priorityMeterWidth(5, 1), 6);
  });
});

describe('snapToDevicePixels against the branding contract', () => {
  it.each(meterContract.pixelSnap.examples)('at $dpr x', (example) => {
    const { width, gap, height } = meterContract.bar;
    // Whole device pixels at that scale, the same for every bar.
    expect(snapToDevicePixels(width, example.dpr) * example.dpr).toBeCloseTo(example.device.width, 6);
    expect(snapToDevicePixels(gap, example.dpr) * example.dpr).toBeCloseTo(example.device.gap, 6);
    expect(snapToDevicePixels(height, example.dpr) * example.dpr).toBeCloseTo(example.device.height, 6);
  });
});
