/**
 * The web demo's pointer picks cream or ink from the ground under it (demo/pointer.ts), with the
 * threshold `@kangentic/branding`'s pointer.json ships. A visitor loses the dot if the math or the
 * threshold drifts: an ink dot over a terminal, or a cream one over a light panel, is invisible.
 * Also the tone a draw takes when no ground was read, the eight points the ground is read from,
 * and the mean over the readings that exist. The DOM walk that finds the ground is covered in the
 * demo tier (tests/demo/static-demo.spec.ts).
 */
import { describe, expect, it } from 'vitest';
import pointerSpec from '@kangentic/branding/assets/pointer/pointer.json';
import { groundSamplePoints, meanLuminance, nextTone, relativeLuminance, TONE_HYSTERESIS, toneForLuminance, toneToDraw } from '../../demo/pointer';

function hexLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return relativeLuminance((value >> 16) & 255, (value >> 8) & 255, value & 255);
}

describe('the demo pointer tone', () => {
  it('reads the package threshold by default', () => {
    expect(pointerSpec.tones.rule.creamBelow).toBe(0.4);
    expect(toneForLuminance(0.39)).toBe('cream');
    expect(toneForLuminance(0.4)).toBe('ink');
  });

  it('measures black and white at the ends of the scale', () => {
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 6);
  });

  it('draws cream over the terminal and the dark theme surfaces', () => {
    // #0c0c0c is the terminal's fixed background in every theme (TERMINAL_DEFAULT_COLORS).
    for (const ground of ['#0c0c0c', '#2d2017', '#18181b', '#0f1923']) {
      expect(toneForLuminance(hexLuminance(ground)), ground).toBe('cream');
    }
  });

  it('draws ink over the light theme surfaces and a light panel header', () => {
    for (const ground of ['#f6f1e8', '#faf6ee', '#f5f5f4', '#edf3f8']) {
      expect(toneForLuminance(hexLuminance(ground)), ground).toBe('ink');
    }
  });

  it('holds a drawn tone on a ground that straddles the threshold', () => {
    // A dot on the edge between clay's light rail and a black terminal reads half of each.
    const straddle = (hexLuminance('#faf6ee') + hexLuminance('#0c0c0c')) / 2;
    expect(Math.abs(straddle - 0.4)).toBeLessThan(TONE_HYSTERESIS);
    expect(nextTone('cream', straddle)).toBe('cream');
    expect(nextTone('ink', straddle)).toBe('ink');
  });

  it('changes a drawn tone once the ground clears the band', () => {
    expect(nextTone(null, 0.42)).toBe('ink');
    expect(nextTone('cream', hexLuminance('#faf6ee'))).toBe('ink');
    expect(nextTone('ink', hexLuminance('#0c0c0c'))).toBe('cream');
  });

  it('keeps the drawn tone when no ground was read, and takes the package default before any', () => {
    expect(pointerSpec.tones.default).toBe('cream');
    expect(toneToDraw(null, null)).toBe('cream');
    expect(toneToDraw('cream', null)).toBe('cream');
    expect(toneToDraw('ink', null)).toBe('ink');
  });

  it('follows nextTone, hysteresis included, when a ground was read', () => {
    const straddle = (hexLuminance('#faf6ee') + hexLuminance('#0c0c0c')) / 2;
    expect(toneToDraw('cream', straddle)).toBe('cream');
    expect(toneToDraw('ink', straddle)).toBe('ink');
    expect(toneToDraw(null, 0.42)).toBe('ink');
    expect(toneToDraw('cream', 0.9)).toBe('ink');
    expect(toneToDraw('ink', 0)).toBe('cream');
  });
});

describe('the demo pointer ground reading', () => {
  const center = { x: 300, y: 200 };

  for (const hostScale of [1, 0.5]) {
    it(`reads eight points evenly around the halo's edge at host scale ${hostScale}`, () => {
      const radius = pointerSpec.dot.halo.diameter / 2 / hostScale;
      const points = groundSamplePoints(center, hostScale);
      expect(points).toHaveLength(8);
      for (const point of points) {
        expect(Math.hypot(point.x - center.x, point.y - center.y)).toBeCloseTo(radius, 6);
      }
      // Evenly spaced: every neighbour is the same chord apart, a full turn around.
      const chord = 2 * radius * Math.sin(Math.PI / 8);
      for (let index = 0; index < points.length; index++) {
        const next = points[(index + 1) % points.length];
        expect(Math.hypot(next.x - points[index].x, next.y - points[index].y)).toBeCloseTo(chord, 6);
      }
    });
  }

  it('averages only the readings that exist', () => {
    expect(meanLuminance([0.2, null, 0.6, null])).toBeCloseTo(0.4, 9);
    expect(meanLuminance([0.5])).toBe(0.5);
  });

  it('reads no ground when every reading is empty', () => {
    expect(meanLuminance([null, null, null])).toBeNull();
    expect(meanLuminance([])).toBeNull();
  });
});
