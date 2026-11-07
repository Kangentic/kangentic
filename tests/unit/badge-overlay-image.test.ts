/**
 * The Windows overlay's label and drawing. The script runs here in a recording
 * canvas, because it is what reaches the renderer: a shape drawn to the frame's edge
 * has its outer pixels cut when Windows scales it, which is how the pill went flat.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ nativeImage: {} }));

import { BADGE_FILL, overlayDrawScript, overlayLabel } from '../../src/main/notifications/badge-overlay-image';

interface Drawn {
  fills: string[];
  fonts: string[];
  texts: string[];
  arcs: number[][];
  roundRects: number[][];
  sizes: number[];
}

function runScript(label: string): { drawn: Drawn; result: unknown } {
  const drawn: Drawn = { fills: [], fonts: [], texts: [], arcs: [], roundRects: [], sizes: [] };
  const context = {
    scale: () => undefined,
    beginPath: () => undefined,
    fill() { drawn.fills.push(this.fillStyle); },
    arc: (...args: number[]) => { drawn.arcs.push(args); },
    roundRect: (...args: number[]) => { drawn.roundRects.push(args); },
    fillText(text: string) { drawn.texts.push(text); drawn.fonts.push(this.font); },
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  };
  const canvas = {
    width: 0,
    getContext: () => context,
    toDataURL() { drawn.sizes.push(this.width); return `data:image/png;${this.width}`; },
    height: 0,
  };
  const fakeDocument = { createElement: () => canvas };
  const result = new Function('document', `return ${overlayDrawScript(label)}`)(fakeDocument) as unknown;
  return { drawn, result };
}

describe('overlayLabel', () => {
  it.each([
    [0, null],
    [-1, null],
    [1, '1'],
    [9, '9'],
    [10, '9+'],
    [104, '9+'],
  ])('%i reads %s', (count, label) => {
    expect(overlayLabel(count)).toBe(label);
  });
});

describe('overlayDrawScript', () => {
  it('draws white on the badge red at both sizes', () => {
    const { drawn, result } = runScript('3');
    expect(drawn.sizes).toEqual([16, 32]);
    expect(result).toEqual(['data:image/png;16', 'data:image/png;32']);
    expect(drawn.fills[0]).toBe(BADGE_FILL);
    expect(drawn.texts).toEqual(['3', '3']);
  });

  it('puts a digit in a circle that stays inside the frame', () => {
    const { drawn } = runScript('7');
    expect(drawn.roundRects).toEqual([]);
    const [centerX, centerY, radius] = drawn.arcs[0];
    expect(centerX - radius).toBeGreaterThan(0);
    expect(centerX + radius).toBeLessThan(16);
    expect(centerY - radius).toBeGreaterThan(0);
  });

  it('puts 9+ in a fully rounded pill that stays inside the frame, so its ends are never cut', () => {
    const { drawn } = runScript('9+');
    expect(drawn.arcs).toEqual([]);
    const [left, top, width, height, radius] = drawn.roundRects[0];
    expect(left).toBeGreaterThan(0);
    expect(left + width).toBeLessThan(16);
    expect(top).toBeGreaterThan(0);
    expect(top + height).toBeLessThan(16);
    expect(radius).toBe(height / 2);
  });

  it('sets 9+ smaller than a digit, in a real bold font', () => {
    expect(runScript('9+').drawn.fonts[0]).toContain('700 9.5px');
    expect(runScript('9').drawn.fonts[0]).toContain('700 11px');
  });
});
