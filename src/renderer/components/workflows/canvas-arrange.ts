import type { LaidOutEdge, Point } from './workflow-layout';

/**
 * Auto layout's slide: what moved when the cards went back to the automatic
 * layout, so the canvas slides those cards (a CSS transform transition, no
 * render per frame) and hides the links they carry while they move. A link's
 * drawing is computed from the final places, so drawn mid-slide it would run
 * to where its cards are going rather than where they are.
 */

/** The canvas as it stood when Auto layout was pressed. */
export interface ArrangeStart {
  places: ReadonlyMap<string, Point>;
  /** Each link's drawing, so a link whose lanes changed hides even when neither end moved. */
  edgeShapes: ReadonlyMap<string, string>;
}

/** What the new places changed. */
export interface ArrangeChange {
  movedKeys: ReadonlySet<string>;
  hiddenEdgeIds: ReadonlySet<string>;
}

/** A link's drawing, as one comparable value. */
export function edgeShape(edge: Pick<LaidOutEdge, 'waypoints' | 'sourceOffset' | 'targetOffset'>): string {
  return JSON.stringify([edge.sourceOffset, edge.targetOffset, edge.waypoints]);
}

export function arrangeStart(places: Iterable<{ id: string; position: Point }>, edges: readonly LaidOutEdge[]): ArrangeStart {
  return {
    places: new Map(Array.from(places, (node) => [node.id, { x: node.position.x, y: node.position.y }])),
    edgeShapes: new Map(edges.map((edge) => [edge.id, edgeShape(edge)])),
  };
}

/**
 * The cards whose place differs from the start, and the links that touch one
 * or whose drawing changed. Null while no card has moved: the new places have
 * not landed yet.
 */
export function arrangeChange(
  start: ArrangeStart,
  places: Iterable<{ id: string; position: Point }>,
  edges: readonly LaidOutEdge[],
): ArrangeChange | null {
  const movedKeys = new Set<string>();
  for (const node of places) {
    const before = start.places.get(node.id);
    if (before && (before.x !== node.position.x || before.y !== node.position.y)) movedKeys.add(node.id);
  }
  if (movedKeys.size === 0) return null;
  const hiddenEdgeIds = new Set(edges
    .filter((edge) => movedKeys.has(edge.blockerKey) || movedKeys.has(edge.blockedKey) || start.edgeShapes.get(edge.id) !== edgeShape(edge))
    .map((edge) => edge.id));
  return { movedKeys, hiddenEdgeIds };
}
