/**
 * The Workflows canvas layout: columns by the furthest blocker, a task that
 * waits for nothing beside the first task that waits on it, only the links no
 * other path implies are drawn, a link that skips a column runs through a lane
 * in that column at least 12px clear of every card, and a hand-placed card
 * keeps its place.
 */
import { describe, it, expect } from 'vitest';
import {
  CARD_WIDTH,
  COLUMN_GAP,
  LANE_CLEARANCE,
  computeLayers,
  layoutWorkflow,
  smoothPath,
  transitiveReduction,
  type LayoutLink,
  type LayoutTask,
  type WorkflowLayout,
} from '../../src/renderer/components/workflows/workflow-layout';

const task = (key: string, extra: Partial<LayoutTask> = {}): LayoutTask => ({ key, height: 200, canvasX: null, canvasY: null, ...extra });
const link = (blockerKey: string, blockedKey: string): LayoutLink => ({ blockerKey, blockedKey });

/** The running workflow the sign-off drew (#411 to #419): two done, one in Merge, one in Executing, five in To Do. */
const BOARD_KEYS = [411, 412, 413, 414, 419, 415, 416, 417, 418].map((number) => `t${number}`);
const BOARD_LINKS = ([[411, 413], [412, 414], [413, 415], [413, 416], [414, 417], [415, 418], [416, 418], [417, 418], [419, 418]] as const)
  .map(([blocker, blocked]) => link(`t${blocker}`, `t${blocked}`));
/** The canvas heights: a done card (132) beside the default density's (204). */
const BOARD_HEIGHTS: Record<string, number> = { t411: 132, t412: 132 };
const boardTasks = (): LayoutTask[] => BOARD_KEYS.map((key) => task(key, { height: BOARD_HEIGHTS[key] ?? 204 }));

type LanePlace = 'above' | 'between' | 'below';

/**
 * Every column a drawn link crosses through a lane, with where the lane runs
 * among that column's cards and how close it comes to the nearest card edge.
 * A lane inside a card reports a negative clearance.
 */
function lanePassages(layout: WorkflowLayout, tasks: readonly LayoutTask[]): Array<{ edge: string; place: LanePlace; clearance: number }> {
  const heightOf = new Map(tasks.map((entry) => [entry.key, entry.height]));
  const passages: Array<{ edge: string; place: LanePlace; clearance: number }> = [];
  for (const edge of layout.edges) {
    for (let index = 0; index < edge.waypoints.length; index += 2) {
      const laneY = edge.waypoints[index].y;
      const columnX = edge.waypoints[index].x;
      const cards = [...layout.automaticPositions]
        .filter(([, position]) => position.x === columnX)
        .map(([key, position]) => ({ top: position.y, bottom: position.y + (heightOf.get(key) ?? 0) }));
      if (cards.length === 0) continue;
      const clearance = Math.min(...cards.map((card) => (
        laneY > card.top && laneY < card.bottom ? -1 : Math.min(Math.abs(laneY - card.top), Math.abs(laneY - card.bottom))
      )));
      const place: LanePlace = cards.every((card) => laneY < card.top) ? 'above' : cards.every((card) => laneY > card.bottom) ? 'below' : 'between';
      passages.push({ edge: edge.id, place, clearance });
    }
  }
  return passages;
}

/** A deterministic pseudo-random source (mulberry32), so the generated workflows are the same on every run. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A workflow of `size` tasks at mixed canvas heights, each link pointing from an earlier task to a later one. */
function generatedWorkflow(seed: number, size: number): { tasks: LayoutTask[]; links: LayoutLink[] } {
  const random = seededRandom(seed);
  const heights = [132, 204, 224];
  const tasks = Array.from({ length: size }, (_, index) => task(`g${index}`, { height: heights[Math.floor(random() * heights.length)] }));
  const links: LayoutLink[] = [];
  for (let from = 0; from < size; from++) {
    for (let to = from + 1; to < size; to++) if (random() < 0.22) links.push(link(`g${from}`, `g${to}`));
  }
  return { tasks, links };
}

describe('workflow layout', () => {
  it('puts each task one column right of the furthest task it waits for', () => {
    const layers = computeLayers(['api', 'ui', 'docs', 'alerts'], [link('api', 'ui'), link('ui', 'docs'), link('api', 'docs')]);
    expect(Object.fromEntries(layers)).toEqual({ api: 0, ui: 1, docs: 2, alerts: 0 });
  });

  it('puts a task that waits for nothing in the column just before the first task that waits on it', () => {
    // #419 waits for nothing and only #418 (column 3) waits on it: it sits in
    // column 2, beside #418's other blockers, instead of column 0 (Final 2, B).
    const layers = computeLayers([...BOARD_KEYS, 'lone'], BOARD_LINKS);
    expect(layers.get('t418')).toBe(3);
    expect(layers.get('t419')).toBe(2);
    // The other first tasks have a dependent one column over, so they stay put,
    // and a task linked to nothing at all stays in the first column.
    expect([layers.get('t411'), layers.get('t412'), layers.get('lone')]).toEqual([0, 0, 0]);
    // Its one link is now one column long, so it needs no lane.
    const layout = layoutWorkflow(boardTasks(), BOARD_LINKS);
    expect(layout.automaticPositions.get('t419')?.x).toBe(2 * (CARD_WIDTH + COLUMN_GAP));
    expect(layout.edges.find((edge) => edge.blockerKey === 't419')?.waypoints).toEqual([]);
  });

  it('measures "just before" from the earliest task that waits on it', () => {
    // `s` waits for nothing; `b` (column 1) and `d` (column 3) wait on it.
    const layers = computeLayers(['a', 'b', 'c', 'd', 's'], [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('s', 'b'), link('s', 'd')]);
    expect(layers.get('s')).toBe(0);
    // With only the later one waiting, it moves up beside that one's blocker.
    const later = computeLayers(['a', 'b', 'c', 'd', 's'], [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('s', 'd')]);
    expect(later.get('s')).toBe(2);
  });

  it('keeps a hand-moved task that waits for nothing where the hand put it', () => {
    const tasks = boardTasks().map((entry) => (entry.key === 't419' ? { ...entry, canvasX: 40, canvasY: 900 } : entry));
    const layout = layoutWorkflow(tasks, BOARD_LINKS);
    expect(layout.positions.get('t419')).toEqual({ x: 40, y: 900 });
    expect(layout.automaticPositions.get('t419')?.x).toBe(2 * (CARD_WIDTH + COLUMN_GAP));
  });

  it('hides a link another path already implies', () => {
    const drawn = transitiveReduction(['a', 'b', 'c'], [link('a', 'b'), link('b', 'c'), link('a', 'c')]);
    expect(drawn).toEqual([link('a', 'b'), link('b', 'c')]);
  });

  it('lays a column-skipping link through a lane, never through a card', () => {
    // a -> b -> c -> e, and a -> d -> e: d (column 1) to e (column 3) crosses column 2.
    const layout = layoutWorkflow(
      [task('a'), task('b'), task('c'), task('d'), task('e')],
      [link('a', 'b'), link('b', 'c'), link('c', 'e'), link('a', 'd'), link('d', 'e')],
    );
    const skipping = layout.edges.find((edge) => edge.blockerKey === 'd')!;
    expect(skipping.waypoints).toHaveLength(2);
    const columnTwoX = 2 * (CARD_WIDTH + COLUMN_GAP);
    expect(skipping.waypoints.map((point) => point.x)).toEqual([columnTwoX, columnTwoX + CARD_WIDTH]);
    const laneY = skipping.waypoints[0].y;
    const cardC = layout.positions.get('c')!;
    const insideC = laneY > cardC.y && laneY < cardC.y + 200;
    expect(insideC).toBe(false);
  });

  it('runs a lane at least 12px clear of the card it passes under (the two spots marked on Final 2)', () => {
    // #411 -> #419 gives #419 a blocker, so its link to #418 still skips
    // column 2 and runs under the cards there.
    const links = [...BOARD_LINKS, link('t411', 't419')];
    const tasks = boardTasks();
    const passages = lanePassages(layoutWorkflow(tasks, links), tasks);
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.filter((passage) => passage.clearance < LANE_CLEARANCE)).toEqual([]);
  });

  it('runs every lane at least 12px clear of every card, above, between or below', () => {
    const passages = Array.from({ length: 40 }, (_, seed) => generatedWorkflow(seed + 1, 12))
      .flatMap(({ tasks, links }) => lanePassages(layoutWorkflow(tasks, links), tasks));
    expect(passages.filter((passage) => passage.clearance < LANE_CLEARANCE)).toEqual([]);
    // The generated workflows put lanes in each place, so the check above is not vacuous.
    expect(new Set(passages.map((passage) => passage.place))).toEqual(new Set<LanePlace>(['above', 'between', 'below']));
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
