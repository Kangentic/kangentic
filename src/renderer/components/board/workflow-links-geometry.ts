/**
 * Where the links overlay's lines run (#732 board 8), as pure geometry over
 * card boxes already measured relative to the board. Free of the DOM, so the
 * fan is pinned by a unit test rather than by reading pixels.
 *
 * A line meets a card on its facing edge, at the title row. Several lines
 * meeting one side of one card fan out 10px apart around that point instead
 * of landing on it together, ordered by where each line's other end is, so
 * the lines in a fan do not cross each other.
 */

export interface CardBox {
  left: number;
  right: number;
  top: number;
  height: number;
}

export interface LinkRequest {
  key: string;
  fromId: string;
  from: CardBox;
  toId: string;
  to: CardBox;
}

/** Between two lines that meet the same side of the same card. */
export const FAN_SPACING = 10;

/**
 * The arrowhead both link drawings put on a line's end, this overlay and the
 * Workflows canvas (`WorkflowEdge`): a triangle in a 10-unit box with its base
 * at x 0 and its tip at x 9, drawn `ARROWHEAD_STROKES` stroke widths wide. Its
 * base sits on the line's end (`refX` 0) and the line stops one arrowhead
 * short of where the tip belongs, so no line runs under the arrow.
 */
export const ARROWHEAD_PATH = 'M0 1 L9 5 L0 9 z';
export const ARROWHEAD_STROKES = 5;
const ARROWHEAD_BOX = 10;
const ARROWHEAD_TIP = 9;

/** How long the arrowhead is on a line this wide, which is how far short of its end the line stops. */
export function arrowheadLength(strokeWidth: number): number {
  return (ARROWHEAD_TIP / ARROWHEAD_BOX) * ARROWHEAD_STROKES * strokeWidth;
}

/** Cards whose left edges are this close sit in one column. */
const SAME_COLUMN_TOLERANCE = 24;

/** How far a line between two cards of one column bows out past their right edges. */
const SAME_COLUMN_BOW = 56;

type Side = 'left' | 'right';

interface Point {
  x: number;
  y: number;
}

/** The facing edge, at the title row, before any fan offset. */
function anchor(box: CardBox, side: Side): Point {
  return {
    x: side === 'left' ? box.left - 2 : box.right + 2,
    y: box.top + Math.min(box.height / 2, 44),
  };
}

function sidesOf(from: CardBox, to: CardBox): { fromSide: Side; toSide: Side; sameColumn: boolean } {
  if (Math.abs(from.left - to.left) < SAME_COLUMN_TOLERANCE) return { fromSide: 'right', toSide: 'right', sameColumn: true };
  const rightward = to.left > from.left;
  return { fromSide: rightward ? 'right' : 'left', toSide: rightward ? 'left' : 'right', sameColumn: false };
}

interface Endpoint {
  linkIndex: number;
  end: 'from' | 'to';
  base: Point;
  /** Where the line's other end is, which orders the fan. */
  otherY: number;
}

/**
 * Each link's SVG path, its ends fanned where several meet one side of one
 * card. `endInset` stops each line that far short of the card it points at,
 * back along the horizontal it arrives on, for the arrowhead to fill.
 */
export function linkPaths(links: readonly LinkRequest[], endInset = 0): Array<{ key: string; path: string }> {
  const plans = links.map((link) => {
    const sides = sidesOf(link.from, link.to);
    return { link, sides, start: anchor(link.from, sides.fromSide), end: anchor(link.to, sides.toSide) };
  });

  const groups = new Map<string, Endpoint[]>();
  const join = (groupKey: string, endpoint: Endpoint) => {
    const group = groups.get(groupKey);
    if (group) group.push(endpoint);
    else groups.set(groupKey, [endpoint]);
  };
  plans.forEach((plan, linkIndex) => {
    join(`${plan.link.fromId}:${plan.sides.fromSide}`, { linkIndex, end: 'from', base: plan.start, otherY: plan.end.y });
    join(`${plan.link.toId}:${plan.sides.toSide}`, { linkIndex, end: 'to', base: plan.end, otherY: plan.start.y });
  });

  const offsets = plans.map(() => ({ from: 0, to: 0 }));
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((first, second) => first.otherY - second.otherY || first.linkIndex - second.linkIndex);
    ordered.forEach((endpoint, index) => {
      offsets[endpoint.linkIndex][endpoint.end] = (index - (ordered.length - 1) / 2) * FAN_SPACING;
    });
  }

  return plans.map((plan, linkIndex) => {
    const start = { x: plan.start.x, y: plan.start.y + offsets[linkIndex].from };
    const endY = plan.end.y + offsets[linkIndex].to;
    if (plan.sides.sameColumn) {
      // It bows out past both right edges, so it arrives moving left.
      const end = { x: plan.end.x + endInset, y: endY };
      return {
        key: plan.link.key,
        path: `M ${start.x} ${start.y} C ${start.x + SAME_COLUMN_BOW} ${start.y}, ${end.x + SAME_COLUMN_BOW} ${end.y}, ${end.x} ${end.y}`,
      };
    }
    const direction = plan.sides.fromSide === 'right' ? 1 : -1;
    const end = { x: plan.end.x - direction * endInset, y: endY };
    const handle = Math.max(48, Math.abs(end.x - start.x) * 0.5) * direction;
    return {
      key: plan.link.key,
      path: `M ${start.x} ${start.y} C ${start.x + handle} ${start.y}, ${end.x - handle} ${end.y}, ${end.x} ${end.y}`,
    };
  });
}
