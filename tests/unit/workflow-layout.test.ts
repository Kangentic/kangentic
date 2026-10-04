/**
 * The Workflows canvas layout: columns by the furthest blocker, only the links
 * no other path implies are drawn, a link that skips a column runs through a
 * lane in that column (never under a card), and a hand-placed card keeps its
 * place.
 */
import { describe, it, expect } from 'vitest';
import {
  CARD_WIDTH,
  COLUMN_GAP,
  computeLayers,
  layoutWorkflow,
  smoothPath,
  transitiveReduction,
  type LayoutLink,
  type LayoutTask,
} from '../../src/renderer/components/workflows/workflow-layout';

const task = (key: string, extra: Partial<LayoutTask> = {}): LayoutTask => ({ key, height: 200, canvasX: null, canvasY: null, ...extra });
const link = (blockerKey: string, blockedKey: string): LayoutLink => ({ blockerKey, blockedKey });

describe('workflow layout', () => {
  it('puts each task one column right of the furthest task it waits for', () => {
    const layers = computeLayers(['api', 'ui', 'docs', 'alerts'], [link('api', 'ui'), link('ui', 'docs'), link('api', 'docs')]);
    expect(Object.fromEntries(layers)).toEqual({ api: 0, ui: 1, docs: 2, alerts: 0 });
  });

  it('hides a link another path already implies', () => {
    const drawn = transitiveReduction(['a', 'b', 'c'], [link('a', 'b'), link('b', 'c'), link('a', 'c')]);
    expect(drawn).toEqual([link('a', 'b'), link('b', 'c')]);
  });

  it('lays a column-skipping link through a lane, never through a card', () => {
    // a -> b -> c, and d (column 0) -> c (column 2): d's link crosses column 1.
    const layout = layoutWorkflow([task('a'), task('b'), task('c'), task('d')], [link('a', 'b'), link('b', 'c'), link('d', 'c')]);
    const skipping = layout.edges.find((edge) => edge.blockerKey === 'd')!;
    expect(skipping.waypoints).toHaveLength(2);
    const columnOneX = CARD_WIDTH + COLUMN_GAP;
    expect(skipping.waypoints.map((point) => point.x)).toEqual([columnOneX, columnOneX + CARD_WIDTH]);
    const laneY = skipping.waypoints[0].y;
    const cardB = layout.positions.get('b')!;
    const insideB = laneY > cardB.y && laneY < cardB.y + 200;
    expect(insideB).toBe(false);
  });

  it('keeps a hand-placed card where it was put, and draws its links straight', () => {
    const layout = layoutWorkflow(
      [task('a'), task('b'), task('c', { canvasX: 900, canvasY: 40 })],
      [link('a', 'b'), link('b', 'c'), link('a', 'c')],
    );
    expect(layout.positions.get('c')).toEqual({ x: 900, y: 40 });
    expect(layout.automaticPositions.get('c')?.x).toBe(2 * (CARD_WIDTH + COLUMN_GAP));
    expect(layout.edges.every((edge) => edge.blockedKey !== 'c' || edge.waypoints.length === 0)).toBe(true);
  });

  it('fans several links out of one card in the order of their targets', () => {
    const layout = layoutWorkflow([task('a'), task('b'), task('c')], [link('a', 'b'), link('a', 'c')]);
    const offsets = layout.edges.map((edge) => edge.sourceOffset);
    expect(new Set(offsets).size).toBe(2);
    expect(offsets.reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it('is stable: the same input gives the same positions', () => {
    const tasks = Array.from({ length: 30 }, (_, index) => task(`t${index}`));
    const links = Array.from({ length: 29 }, (_, index) => link(`t${Math.floor(index / 2)}`, `t${index + 1}`));
    const first = layoutWorkflow(tasks, links);
    const second = layoutWorkflow(tasks, links);
    expect([...second.positions]).toEqual([...first.positions]);
  });

  it('draws a horizontal hop straight and a sloped one as a curve', () => {
    expect(smoothPath([{ x: 0, y: 10 }, { x: 100, y: 10 }])).toBe('M 0,10 L 100,10');
    expect(smoothPath([{ x: 0, y: 0 }, { x: 100, y: 50 }])).toMatch(/^M 0,0 C /);
  });
});
