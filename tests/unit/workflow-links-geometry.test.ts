/**
 * The links overlay's line geometry (#732 board 8): a card meets its lines as
 * a Workflows canvas card does, at one port per side, a 10px ring centred on
 * its facing edge at the middle of its title row. Every line on that side
 * leaves from or arrives at that port: it starts at the ring's outer edge,
 * and stops one arrowhead short of it so the arrow's tip lands on the ring.
 */
import { describe, expect, it } from 'vitest';
import { PORT_RADIUS, arrowheadLength, linkPaths, linkPorts, type CardBox, type LinkRequest } from '../../src/renderer/components/board/workflow-links-geometry';

function box(left: number, top: number, portY?: number): CardBox {
  return { left, right: left + 240, top, height: 120, portY };
}

/** The path's start and end points, read back out of its `M x y C ..., x y` form. */
function ends(path: string): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
  return { start: { x: numbers[0], y: numbers[1] }, end: { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] } };
}

/** The focus card, its title row's middle measured at 147. */
const FOCUS = box(600, 100, 147);

describe('the links overlay geometry', () => {
  it('runs a line from the blocker\'s port to the dependent\'s, each at its title row, ring edge to ring edge', () => {
    const [only] = linkPaths([{ key: 'out:a', fromId: 'focus', from: FOCUS, toId: 'a', to: box(1000, 300, 349) }]);
    const { start, end } = ends(only.path);
    expect(start).toEqual({ x: 840 + PORT_RADIUS, y: 147 });
    expect(end).toEqual({ x: 1000 - PORT_RADIUS, y: 349 });
  });

  it('leaves every line on one side of a card from the same port, as the canvas does', () => {
    const links: LinkRequest[] = [
      { key: 'out:lower', fromId: 'focus', from: FOCUS, toId: 'lower', to: box(100, 700) },
      { key: 'out:upper', fromId: 'focus', from: FOCUS, toId: 'upper', to: box(100, 500) },
    ];
    const paths = linkPaths(links).map((link) => ends(link.path).start);
    expect(paths).toEqual([{ x: 600 - PORT_RADIUS, y: 147 }, { x: 600 - PORT_RADIUS, y: 147 }]);
  });

  it('gives one port per side of a card, however many lines meet it, saying whether lines leave or arrive there', () => {
    const links: LinkRequest[] = [
      // Two dependents to the left leave from the focus card's left port.
      { key: 'out:left-a', fromId: 'focus', from: FOCUS, toId: 'left-a', to: box(100, 300) },
      { key: 'out:left-b', fromId: 'focus', from: FOCUS, toId: 'left-b', to: box(100, 500) },
      // A blocker to the right comes in on its right port.
      { key: 'in:blocker', fromId: 'blocker', from: box(1200, 400), toId: 'focus', to: FOCUS },
    ];
    const ports = linkPorts(links);
    expect(ports.map((port) => port.key).sort()).toEqual(['blocker:left', 'focus:left', 'focus:right', 'left-a:right', 'left-b:right']);
    // Centred on the edge, at the title row.
    expect(ports.find((port) => port.key === 'focus:left')).toEqual({ key: 'focus:left', cardId: 'focus', x: 600, y: 147, outgoing: true, incoming: false });
    expect(ports.find((port) => port.key === 'focus:right')).toEqual({ key: 'focus:right', cardId: 'focus', x: 840, y: 147, outgoing: false, incoming: true });
    // Each far end says what meets it there, for the caller to draw it as the canvas would.
    expect(ports.find((port) => port.key === 'blocker:left')).toMatchObject({ outgoing: true, incoming: false });
    expect(ports.find((port) => port.key === 'left-a:right')).toMatchObject({ outgoing: false, incoming: true });
  });

  it('stops each line one arrowhead short of the port it points at, whichever way it arrives', () => {
    // The arrowhead is 9 units of its 10-unit box, drawn 5 stroke widths wide.
    expect(arrowheadLength(2)).toBe(9);
    expect(arrowheadLength(1.5)).toBe(6.75);
    const inset = arrowheadLength(2);
    const links: LinkRequest[] = [
      // Arrives moving right, on the dependent's left port.
      { key: 'out:right', fromId: 'focus', from: FOCUS, toId: 'right', to: box(1000, 300) },
      // Arrives moving left, on the dependent's right port.
      { key: 'out:left', fromId: 'focus', from: FOCUS, toId: 'left', to: box(100, 300) },
      // Same column: bows out past both right edges and arrives moving left.
      { key: 'out:below', fromId: 'focus', from: FOCUS, toId: 'below', to: box(600, 500) },
    ];
    const paths = new Map(linkPaths(links, inset).map((link) => [link.key, ends(link.path)]));
    expect(paths.get('out:right')!.end.x).toBe(1000 - PORT_RADIUS - inset);
    expect(paths.get('out:left')!.end.x).toBe(100 + 240 + PORT_RADIUS + inset);
    expect(paths.get('out:below')!.end.x).toBe(600 + 240 + PORT_RADIUS + inset);
    // The start never moves.
    expect(paths.get('out:right')!.start.x).toBe(840 + PORT_RADIUS);
  });

  it('puts a card with no measured title row\'s port near its top', () => {
    const [only] = linkPaths([{ key: 'out:a', fromId: 'focus', from: box(600, 100), toId: 'a', to: box(1000, 300) }]);
    expect(ends(only.path).start.y).toBe(100 + 44);
  });
});
