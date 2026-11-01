/**
 * The one fold rule the project sidebar's divider and the Command Terminal
 * rail's edge share (src/renderer/utils/folding-edge-drag.ts): follow the
 * pointer down to the minimum, hold there until the pointer passes half of it,
 * then fold, and open again at the minimum on the way back.
 */
import { describe, it, expect } from 'vitest';
import { resolveFoldingEdgeDrag } from '../../src/renderer/utils/folding-edge-drag';

const EDGE = { minWidth: 200, maxWidth: 400 };

describe('resolveFoldingEdgeDrag', () => {
  it('follows the pointer between the minimum and the maximum, in whole pixels', () => {
    expect(resolveFoldingEdgeDrag({ ...EDGE, raw: 230 })).toEqual({ collapsed: false, width: 230 });
    expect(resolveFoldingEdgeDrag({ ...EDGE, raw: 301.6 })).toEqual({ collapsed: false, width: 302 });
    expect(resolveFoldingEdgeDrag({ ...EDGE, raw: 900 })).toEqual({ collapsed: false, width: 400 });
  });

  it('holds at the minimum, still open, from the minimum down to half of it', () => {
    expect(resolveFoldingEdgeDrag({ ...EDGE, raw: 199 })).toEqual({ collapsed: false, width: 200 });
    expect(resolveFoldingEdgeDrag({ ...EDGE, raw: 150 })).toEqual({ collapsed: false, width: 200 });
    expect(resolveFoldingEdgeDrag({ ...EDGE, raw: 100 })).toEqual({ collapsed: false, width: 200 });
  });

  it('folds only past half the minimum, the strip included', () => {
    expect(resolveFoldingEdgeDrag({ ...EDGE, raw: 99 })).toEqual({ collapsed: true, width: 200 });
    expect(resolveFoldingEdgeDrag({ ...EDGE, raw: 36 })).toEqual({ collapsed: true, width: 200 });
    expect(resolveFoldingEdgeDrag({ ...EDGE, raw: -50 })).toEqual({ collapsed: true, width: 200 });
  });

  it('caps at a maximum the room allows, never under the minimum', () => {
    expect(resolveFoldingEdgeDrag({ raw: 380, minWidth: 200, maxWidth: 248 })).toEqual({ collapsed: false, width: 248 });
    expect(resolveFoldingEdgeDrag({ raw: 380, minWidth: 200, maxWidth: 200 })).toEqual({ collapsed: false, width: 200 });
    // A room narrower than the minimum still leaves the panel at its minimum.
    expect(resolveFoldingEdgeDrag({ raw: 380, minWidth: 200, maxWidth: 150 })).toEqual({ collapsed: false, width: 200 });
  });
});
