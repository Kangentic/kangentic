/**
 * Where an annotation badge goes on the page (decision 45 in the embedded
 * browser decision log). The layout is SOURCE TEXT the guest page runs, so this
 * runs that same text through `new Function` rather than an import: a test of a
 * compiled copy could pass while the page ran something else.
 */
import { describe, it, expect } from 'vitest';
import { ANNOTATION_LAYOUT_SOURCE } from '../../src/renderer/components/browser/annotations/annotation-layout';

interface Point { x: number; y: number }
interface Rect { x: number; y: number; width: number; height: number }
type LayoutItem =
  | { key: string; kind: 'element'; rect: Rect }
  | { key: string; kind: 'drawing'; strokes: Point[][] };
interface Layout {
  kngPlaceBadges: (input: { pageWidth: number; blocked?: Rect[]; items: LayoutItem[] }) => Record<string, Point>;
  kngStrokeBox: (strokes: Point[][]) => Rect | null;
}

const layout = new Function(`${ANNOTATION_LAYOUT_SOURCE}\nreturn { kngPlaceBadges, kngStrokeBox };`)() as Layout;

const PAGE_WIDTH = 1280;
const place = (items: LayoutItem[], blocked: Rect[] = []) => layout.kngPlaceBadges({ pageWidth: PAGE_WIDTH, blocked, items });

describe('annotation badge layout', () => {
  it("centres an element's badge on its top-left corner", () => {
    const badges = place([{ key: 'e', kind: 'element', rect: { x: 32, y: 128, width: 320, height: 34 } }]);
    expect(badges.e).toEqual({ x: 32, y: 128 });
  });

  it("centres a drawing's badge on the first point drawn, whatever its shape", () => {
    const circle = [[{ x: 62, y: 214 }, { x: 26, y: 260 }, { x: 180, y: 284 }, { x: 70, y: 218 }]];
    expect(place([{ key: 'd', kind: 'drawing', strokes: circle }]).d).toEqual({ x: 62, y: 214 });
  });

  it('keeps a badge 9px inside the page', () => {
    const atEdge = place([
      { key: 'left', kind: 'element', rect: { x: 0, y: 0, width: 10, height: 10 } },
      { key: 'right', kind: 'drawing', strokes: [[{ x: PAGE_WIDTH + 5, y: 400 }, { x: PAGE_WIDTH - 200, y: 500 }]] },
    ]);
    expect(atEdge.left).toEqual({ x: 9, y: 9 });
    expect(atEdge.right.x).toBe(PAGE_WIDTH - 9);
  });

  it("walks a drawing's badge forward along its own stroke off another badge", () => {
    const badges = place([
      { key: 'element', kind: 'element', rect: { x: 40, y: 44, width: 110, height: 34 } },
      { key: 'drawing', kind: 'drawing', strokes: [[{ x: 40, y: 44 }, { x: 50, y: 44 }, { x: 70, y: 44 }, { x: 90, y: 44 }]] },
    ]);
    expect(badges.drawing).toEqual({ x: 70, y: 44 });
  });

  it('walks a drawing badge out from under the floating bar', () => {
    const bar = { x: 300, y: 0, width: 100, height: 40 };
    const badges = place([
      { key: 'drawing', kind: 'drawing', strokes: [[{ x: 350, y: 20 }, { x: 350, y: 40 }, { x: 350, y: 60 }]] },
    ], [bar]);
    expect(badges.drawing).toEqual({ x: 350, y: 60 });
  });

  it('keeps the first point when nothing along the stroke is clear', () => {
    const bar = { x: 0, y: 0, width: PAGE_WIDTH, height: 200 };
    const badges = place([{ key: 'drawing', kind: 'drawing', strokes: [[{ x: 100, y: 50 }, { x: 200, y: 60 }]] }], [bar]);
    expect(badges.drawing).toEqual({ x: 100, y: 50 });
  });

  it('puts a tiny mark\'s badge just left of it, so the badge never hides it', () => {
    const tick = [[{ x: 86, y: 34 }, { x: 92, y: 42 }, { x: 104, y: 24 }]];
    expect(place([{ key: 'tick', kind: 'drawing', strokes: tick }]).tick).toEqual({ x: 75, y: 33 });
    // A short underline is wide enough to keep the default.
    const underline = [[{ x: 110, y: 60 }, { x: 200, y: 60 }]];
    expect(place([{ key: 'line', kind: 'drawing', strokes: underline }]).line).toEqual({ x: 110, y: 60 });
  });

  it('places elements first, so a drawing makes way for an element badge drawn after it in the list', () => {
    const badges = place([
      { key: 'drawing', kind: 'drawing', strokes: [[{ x: 200, y: 200 }, { x: 260, y: 200 }]] },
      { key: 'element', kind: 'element', rect: { x: 200, y: 200, width: 50, height: 20 } },
    ]);
    expect(badges.element).toEqual({ x: 200, y: 200 });
    expect(badges.drawing).toEqual({ x: 260, y: 200 });
  });

  it('measures the box around every stroke of a drawing', () => {
    expect(layout.kngStrokeBox([[{ x: 470, y: 280 }, { x: 250, y: 228 }], [{ x: 260, y: 300 }]])).toEqual({
      x: 250, y: 228, width: 220, height: 72,
    });
    expect(layout.kngStrokeBox([])).toBeNull();
  });
});
