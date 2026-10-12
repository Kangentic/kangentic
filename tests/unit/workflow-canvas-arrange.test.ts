/**
 * What Auto layout changed on the Workflows canvas (canvas-arrange.ts): the
 * cards whose place moved, which slide, and the links whose drawing is no
 * longer where they are mid-slide, which hide until the cards arrive. That the
 * slide runs and ends is checked in the UI tier (tests/ui/workflows-view.spec.ts).
 */
import { describe, it, expect } from 'vitest';
import { arrangeChange, arrangeStart, edgeShape } from '../../src/renderer/components/workflows/canvas-arrange';
import type { LaidOutEdge } from '../../src/renderer/components/workflows/workflow-layout';

const edge = (blockerKey: string, blockedKey: string, waypoints: LaidOutEdge['waypoints'] = []): LaidOutEdge => ({
  id: `${blockerKey}->${blockedKey}`, blockerKey, blockedKey, waypoints,
});
const place = (id: string, x: number, y: number) => ({ id, position: { x, y } });

describe('arrangeChange', () => {
  const edgesBefore = [edge('a', 'b'), edge('c', 'd'), edge('e', 'f', [{ x: 300, y: 40 }])];
  const start = arrangeStart([place('a', 0, 0), place('b', 352, 0), place('c', 0, 200), place('d', 352, 200), place('e', 0, 400), place('f', 704, 400)], edgesBefore);

  it('is null until a card has moved: the new places have not landed', () => {
    expect(arrangeChange(start, [place('a', 0, 0), place('b', 352, 0)], edgesBefore)).toBeNull();
  });

  it('names the moved cards and hides the links that touch them', () => {
    const change = arrangeChange(start, [place('a', 0, 0), place('b', 352, 120), place('c', 0, 200), place('d', 352, 200)], edgesBefore);
    expect([...change!.movedKeys]).toEqual(['b']);
    expect([...change!.hiddenEdgeIds]).toEqual(['a->b']);
  });

  it('hides a link whose lanes changed even when neither of its cards moved', () => {
    const rerouted = [edge('a', 'b'), edge('c', 'd'), edge('e', 'f', [{ x: 300, y: 64 }])];
    const change = arrangeChange(start, [place('a', 0, 0), place('b', 352, 120), place('e', 0, 400), place('f', 704, 400)], rerouted);
    expect([...change!.hiddenEdgeIds].sort()).toEqual(['a->b', 'e->f']);
  });

  it('ignores a card that was not on the canvas at the start', () => {
    expect(arrangeChange(start, [place('new', 900, 0)], edgesBefore)).toBeNull();
  });
});

describe('edgeShape', () => {
  it('differs when the lanes do, and only then', () => {
    expect(edgeShape(edge('a', 'b'))).toBe(edgeShape(edge('x', 'y')));
    expect(edgeShape(edge('a', 'b', [{ x: 1, y: 2 }]))).not.toBe(edgeShape(edge('a', 'b')));
  });
});
