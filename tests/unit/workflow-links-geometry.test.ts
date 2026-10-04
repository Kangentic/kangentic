/**
 * The links overlay's line geometry (#732 board 8): several lines meeting one
 * side of one card fan 10px apart around the title row instead of landing on
 * one point, ordered by where each line's other end sits so a fan does not
 * cross itself. A lone line keeps the plain anchor.
 */
import { describe, expect, it } from 'vitest';
import { FAN_SPACING, linkPaths, type CardBox, type LinkRequest } from '../../src/renderer/components/board/workflow-links-geometry';

function box(left: number, top: number): CardBox {
  return { left, right: left + 240, top, height: 120 };
}

/** The path's start and end points, read back out of its `M x y C ..., x y` form. */
function ends(path: string): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
  return { start: { x: numbers[0], y: numbers[1] }, end: { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] } };
}

const FOCUS = box(600, 100);
const TITLE_ROW = 100 + 44;

describe('the links overlay geometry', () => {
  it('lands a lone line on the facing edge at the title row', () => {
    const [only] = linkPaths([{ key: 'out:a', fromId: 'focus', from: FOCUS, toId: 'a', to: box(1000, 300) }]);
    const { start, end } = ends(only.path);
    expect(start).toEqual({ x: 842, y: TITLE_ROW });
    expect(end).toEqual({ x: 998, y: 344 });
  });

  it('fans the lines that meet one side of one card 10px apart, upper other end on the upper slot', () => {
    const links: LinkRequest[] = [
      { key: 'out:lower', fromId: 'focus', from: FOCUS, toId: 'lower', to: box(100, 700) },
      { key: 'out:upper', fromId: 'focus', from: FOCUS, toId: 'upper', to: box(100, 500) },
    ];
    const paths = new Map(linkPaths(links).map((link) => [link.key, ends(link.path)]));
    const upper = paths.get('out:upper')!;
    const lower = paths.get('out:lower')!;
    // Both leave the focus card's left edge, spread around the title row.
    expect(upper.start.x).toBe(FOCUS.left - 2);
    expect(lower.start.x).toBe(FOCUS.left - 2);
    expect(lower.start.y - upper.start.y).toBe(FAN_SPACING);
    expect((upper.start.y + lower.start.y) / 2).toBe(TITLE_ROW);
    // Each far end meets a card of its own, so it is not fanned.
    expect(upper.end.y).toBe(544);
    expect(lower.end.y).toBe(744);
  });

  it('fans incoming and outgoing lines together when they share a side', () => {
    const links: LinkRequest[] = [
      // A blocker to the right comes in on the focus card's right edge.
      { key: 'in:blocker', fromId: 'blocker', from: box(1200, 400), toId: 'focus', to: FOCUS },
      // A dependent to the right leaves from that same edge.
      { key: 'out:dependent', fromId: 'focus', from: FOCUS, toId: 'dependent', to: box(1200, 0) },
    ];
    const paths = new Map(linkPaths(links).map((link) => [link.key, ends(link.path)]));
    const blockerEnd = paths.get('in:blocker')!.end;
    const dependentStart = paths.get('out:dependent')!.start;
    expect(blockerEnd.x).toBe(dependentStart.x);
    // The dependent sits higher on the board, so its line takes the upper slot.
    expect(blockerEnd.y - dependentStart.y).toBe(FAN_SPACING);
  });

  it('keeps lines on opposite sides of a card apart from each other', () => {
    const links: LinkRequest[] = [
      { key: 'out:left', fromId: 'focus', from: FOCUS, toId: 'left', to: box(100, 100) },
      { key: 'out:right', fromId: 'focus', from: FOCUS, toId: 'right', to: box(1200, 100) },
    ];
    for (const link of linkPaths(links)) expect(ends(link.path).start.y).toBe(TITLE_ROW);
  });
});
