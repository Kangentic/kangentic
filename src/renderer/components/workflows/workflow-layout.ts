/**
 * The Workflows canvas's automatic layout, pure: no React, no store, so it is
 * computed once per structural change (tasks, links, hand-placed positions)
 * and never during a drag.
 *
 * A layered layout, the shape CI pipelines draw (GitLab `needs`):
 *
 * - **Layers** by longest path: a task sits one column right of the furthest
 *   task it waits for, so every link points rightwards. A task that waits for
 *   nothing sits just before the earliest task that waits on it, as dagre
 *   places one, so a column says how far down the chain a task is, not when
 *   it can start (the run order says that).
 * - **Lanes** for a link that skips a column: it gets a dummy node in each
 *   column it crosses, ordered with the cards, so its line runs through that
 *   column's open space (above, between or below its cards) and never under a
 *   card. Dummy slots are `LANE_GAP` tall, so lanes stack without crossing,
 *   and a lane keeps `LANE_CLEARANCE` from every card's edge.
 * - **Order** within a column by barycenter sweeps (the average position of a
 *   node's neighbours in the next column over), which keeps crossings low.
 * - **Transitive reduction**: a link another path already implies (A to C when
 *   A to B to C exists) is kept as data and in the inspector, but not drawn.
 *
 * A card a hand moved keeps its place (`canvasX`/`canvasY`); its links are
 * drawn straight to it rather than through lanes laid out for the automatic
 * positions.
 */

export const CARD_WIDTH = 256;
export const COLUMN_GAP = 96;
export const ROW_GAP = 20;
export const LANE_GAP = 12;
/** How far a lane runs from the edge of any card in its column, above or below it. */
export const LANE_CLEARANCE = 12;
/**
 * Where a link meets a card: the middle of its title row, under the workflow
 * strip. The same on every card: a card that names its project (#732 board 17)
 * names it in the strip.
 */
export const PORT_OFFSET_Y = 49;
/** How far apart two links leaving or arriving at one card start. */
export const PORT_SPREAD = 8;

export interface LayoutTask {
  key: string;
  /** The card's height on the canvas. */
  height: number;
  canvasX: number | null;
  canvasY: number | null;
}

export interface LayoutLink {
  blockerKey: string;
  blockedKey: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface LaidOutEdge {
  id: string;
  blockerKey: string;
  blockedKey: string;
  /**
   * Fixed points the line passes through between its two ends, left to
   * right: each crossed column's left and right edge at its lane. Empty for
   * adjacent columns or a hand-placed end.
   */
  waypoints: Point[];
  /** Vertical offset of the line's start from the blocker's port, so several links fan out. */
  sourceOffset: number;
  /** Vertical offset of the line's end from the waiting task's port. */
  targetOffset: number;
}

export interface WorkflowLayout {
  positions: Map<string, Point>;
  /** The automatic position of every card, whether or not a hand moved it. */
  automaticPositions: Map<string, Point>;
  /** The links drawn: the transitive reduction. */
  edges: LaidOutEdge[];
  /** Column index per card on the canvas. The inspector's run order is `runOrder` in workflow-graph.ts, not this. */
  layers: Map<string, number>;
}

interface LayerItem {
  /** A card key, or a dummy for an edge crossing this column. */
  id: string;
  dummyOf: string | null;
  height: number;
}

export function edgeId(blockerKey: string, blockedKey: string): string {
  return `${blockerKey}->${blockedKey}`;
}

/**
 * Each task's column: one right of the furthest task it waits for. A task that
 * waits for nothing sits in the column just before the earliest task that waits
 * on it, so its links are one column long (Final 2, B); one that nothing waits
 * on either stays in the first column.
 */
export function computeLayers(keys: readonly string[], links: readonly LayoutLink[]): Map<string, number> {
  const known = new Set(keys);
  const blockersOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();
  for (const link of links) {
    if (!known.has(link.blockerKey) || !known.has(link.blockedKey)) continue;
    const list = blockersOf.get(link.blockedKey) ?? [];
    list.push(link.blockerKey);
    blockersOf.set(link.blockedKey, list);
    const dependents = dependentsOf.get(link.blockerKey) ?? [];
    dependents.push(link.blockedKey);
    dependentsOf.set(link.blockerKey, dependents);
  }
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (key: string): number => {
    const cached = layers.get(key);
    if (cached !== undefined) return cached;
    // A cycle never reaches here (links are refused when they would close one),
    // but a defensive stop keeps a corrupt plan from overflowing the stack.
    if (visiting.has(key)) return 0;
    visiting.add(key);
    let layer = 0;
    for (const blocker of blockersOf.get(key) ?? []) layer = Math.max(layer, layerOf(blocker) + 1);
    visiting.delete(key);
    layers.set(key, layer);
    return layer;
  };
  for (const key of keys) layerOf(key);
  // One pass is enough: only a task with no blocker moves, and no other
  // task's column depends on where one of those sits. Every one of its
  // dependents stays at least a column to its right, so links still point
  // rightwards.
  for (const key of keys) {
    const dependents = dependentsOf.get(key);
    if ((blockersOf.get(key)?.length ?? 0) > 0 || !dependents || dependents.length === 0) continue;
    layers.set(key, Math.max(0, Math.min(...dependents.map((dependent) => layers.get(dependent) ?? 0)) - 1));
  }
  return layers;
}

/** The links no other path implies. */
export function transitiveReduction(keys: readonly string[], links: readonly LayoutLink[]): LayoutLink[] {
  const known = new Set(keys);
  const valid = links.filter((link) => known.has(link.blockerKey) && known.has(link.blockedKey) && link.blockerKey !== link.blockedKey);
  const next = new Map<string, Set<string>>();
  for (const link of valid) {
    const set = next.get(link.blockerKey) ?? new Set<string>();
    set.add(link.blockedKey);
    next.set(link.blockerKey, set);
  }
  // Can `to` be reached from `from` by a path of two or more links?
  const reachableIndirectly = (from: string, to: string): boolean => {
    const stack: string[] = [];
    for (const middle of next.get(from) ?? []) if (middle !== to) stack.push(middle);
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const following of next.get(current) ?? []) stack.push(following);
    }
    return false;
  };
  const seenPairs = new Set<string>();
  return valid.filter((link) => {
    const id = edgeId(link.blockerKey, link.blockedKey);
    if (seenPairs.has(id)) return false;
    seenPairs.add(id);
    return !reachableIndirectly(link.blockerKey, link.blockedKey);
  });
}

export function layoutWorkflow(tasks: readonly LayoutTask[], links: readonly LayoutLink[]): WorkflowLayout {
  const keys = tasks.map((task) => task.key);
  const heightOf = new Map(tasks.map((task) => [task.key, task.height]));
  const layers = computeLayers(keys, links);
  const drawn = transitiveReduction(keys, links);
  const columnCount = keys.length === 0 ? 0 : Math.max(...keys.map((key) => layers.get(key) ?? 0)) + 1;

  // Columns of items: cards, then a dummy per drawn edge per crossed column.
  const columns: LayerItem[][] = Array.from({ length: columnCount }, () => []);
  for (const key of keys) columns[layers.get(key) ?? 0].push({ id: key, dummyOf: null, height: heightOf.get(key) ?? 0 });
  const chainOf = new Map<string, string[]>();
  for (const link of drawn) {
    const from = layers.get(link.blockerKey) ?? 0;
    const to = layers.get(link.blockedKey) ?? 0;
    const chain: string[] = [];
    for (let layer = from + 1; layer < to; layer++) {
      const id = `dummy:${edgeId(link.blockerKey, link.blockedKey)}:${layer}`;
      columns[layer].push({ id, dummyOf: edgeId(link.blockerKey, link.blockedKey), height: 0 });
      chain.push(id);
    }
    chainOf.set(edgeId(link.blockerKey, link.blockedKey), chain);
  }

  // Neighbour lists through the dummy chains, for the barycenter sweeps.
  const upper = new Map<string, string[]>();
  const lower = new Map<string, string[]>();
  const connect = (left: string, right: string): void => {
    (lower.get(left) ?? lower.set(left, []).get(left)!).push(right);
    (upper.get(right) ?? upper.set(right, []).get(right)!).push(left);
  };
  for (const link of drawn) {
    const path = [link.blockerKey, ...(chainOf.get(edgeId(link.blockerKey, link.blockedKey)) ?? []), link.blockedKey];
    for (let index = 0; index + 1 < path.length; index++) connect(path[index], path[index + 1]);
  }

  // Barycenter ordering, a few sweeps each way. Ties keep the incoming order,
  // which is the plan's own order, so the layout is stable across reloads.
  const indexIn = new Map<string, number>();
  const reindex = (column: LayerItem[]): void => column.forEach((item, index) => indexIn.set(item.id, index));
  columns.forEach(reindex);
  const sortBy = (column: LayerItem[], neighbours: Map<string, string[]>): void => {
    const weight = new Map<string, number>();
    column.forEach((item, index) => {
      const around = neighbours.get(item.id) ?? [];
      weight.set(item.id, around.length === 0 ? index : around.reduce((sum, id) => sum + (indexIn.get(id) ?? 0), 0) / around.length);
    });
    column.sort((left, right) => (weight.get(left.id)! - weight.get(right.id)!) || ((indexIn.get(left.id) ?? 0) - (indexIn.get(right.id) ?? 0)));
    reindex(column);
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let layer = 1; layer < columns.length; layer++) sortBy(columns[layer], upper);
    for (let layer = columns.length - 2; layer >= 0; layer--) sortBy(columns[layer], lower);
  }

  // Coordinates: stack each column, centred against the tallest column. Cards
  // sit a row gap apart and lanes a lane apart. A lane keeps LANE_CLEARANCE
  // from the card above or below it, measured from the lane's line at the
  // middle of its slot, so a link never runs along a card's edge.
  const laneEdgeGap = LANE_CLEARANCE - LANE_GAP / 2;
  const gapBefore = (previous: LayerItem | undefined, item: LayerItem): number => {
    if (!previous) return 0;
    if (previous.dummyOf && item.dummyOf) return 0;
    if (previous.dummyOf || item.dummyOf) return laneEdgeGap;
    return ROW_GAP;
  };
  const stackHeight = (column: LayerItem[]): number => column.reduce(
    (sum, item, index) => sum + gapBefore(column[index - 1], item) + (item.dummyOf ? LANE_GAP : item.height),
    0,
  );
  const tallest = Math.max(0, ...columns.map(stackHeight));
  const automaticPositions = new Map<string, Point>();
  const laneY = new Map<string, number>();
  columns.forEach((column, layer) => {
    const x = layer * (CARD_WIDTH + COLUMN_GAP);
    let y = (tallest - stackHeight(column)) / 2;
    column.forEach((item, index) => {
      y += gapBefore(column[index - 1], item);
      if (item.dummyOf) {
        laneY.set(item.id, y + LANE_GAP / 2);
        y += LANE_GAP;
      } else {
        automaticPositions.set(item.id, { x, y });
        y += item.height;
      }
    });
  });

  const handPlaced = new Set<string>();
  const positions = new Map<string, Point>();
  for (const task of tasks) {
    if (task.canvasX !== null && task.canvasY !== null) {
      positions.set(task.key, { x: task.canvasX, y: task.canvasY });
      handPlaced.add(task.key);
    } else {
      positions.set(task.key, automaticPositions.get(task.key) ?? { x: 0, y: 0 });
    }
  }

  // Fan the links out at each card: outgoing in the order of their targets,
  // incoming in the order of their sources, so no two share an end point.
  const outgoing = new Map<string, LayoutLink[]>();
  const incoming = new Map<string, LayoutLink[]>();
  for (const link of drawn) {
    (outgoing.get(link.blockerKey) ?? outgoing.set(link.blockerKey, []).get(link.blockerKey)!).push(link);
    (incoming.get(link.blockedKey) ?? incoming.set(link.blockedKey, []).get(link.blockedKey)!).push(link);
  }
  const yOf = (key: string): number => positions.get(key)?.y ?? 0;
  const spread = (index: number, count: number): number => (index - (count - 1) / 2) * PORT_SPREAD;
  const sourceOffset = new Map<string, number>();
  const targetOffset = new Map<string, number>();
  for (const list of outgoing.values()) {
    list.sort((left, right) => yOf(left.blockedKey) - yOf(right.blockedKey));
    list.forEach((link, index) => sourceOffset.set(edgeId(link.blockerKey, link.blockedKey), spread(index, list.length)));
  }
  for (const list of incoming.values()) {
    list.sort((left, right) => yOf(left.blockerKey) - yOf(right.blockerKey));
    list.forEach((link, index) => targetOffset.set(edgeId(link.blockerKey, link.blockedKey), spread(index, list.length)));
  }

  const edges: LaidOutEdge[] = drawn.map((link) => {
    const id = edgeId(link.blockerKey, link.blockedKey);
    const straight = handPlaced.has(link.blockerKey) || handPlaced.has(link.blockedKey);
    const waypoints: Point[] = [];
    if (!straight) {
      for (const dummyId of chainOf.get(id) ?? []) {
        const layer = Number(dummyId.slice(dummyId.lastIndexOf(':') + 1));
        const x = layer * (CARD_WIDTH + COLUMN_GAP);
        const y = laneY.get(dummyId) ?? 0;
        waypoints.push({ x, y }, { x: x + CARD_WIDTH, y });
      }
    }
    return {
      id,
      blockerKey: link.blockerKey,
      blockedKey: link.blockedKey,
      waypoints,
      sourceOffset: sourceOffset.get(id) ?? 0,
      targetOffset: targetOffset.get(id) ?? 0,
    };
  });

  return { positions, automaticPositions, edges, layers };
}

/**
 * A smooth line through `points`, leaving and arriving horizontally: each hop
 * is a cubic curve whose handles sit half the hop's width along the
 * horizontal, so a line crossing a column's lane is a straight run.
 */
export function smoothPath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  let path = `M ${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    if (from.y === to.y) {
      path += ` L ${to.x},${to.y}`;
      continue;
    }
    const handle = Math.max(24, Math.abs(to.x - from.x) / 2);
    path += ` C ${from.x + handle},${from.y} ${to.x - handle},${to.y} ${to.x},${to.y}`;
  }
  return path;
}
