/**
 * Where the links overlay's lines run (#732 board 8), as pure geometry over
 * card boxes already measured relative to the board. Free of the DOM, so the
 * ports are pinned by a unit test rather than by reading pixels.
 *
 * A card meets its lines as a Workflows canvas card does: at a port, a 10px
 * ring centred on its facing edge at the middle of its title row. Every line
 * on that side of the card leaves from or arrives at that one port: a line
 * starts at the ring's outer edge and arrives with its arrowhead's tip on it.
 */

export interface CardBox {
  left: number;
  right: number;
  top: number;
  height: number;
  /** The middle of the card's title row, where its ports sit; absent, a point near the top. */
  portY?: number;
}

export interface LinkRequest {
  key: string;
  fromId: string;
  from: CardBox;
  toId: string;
  to: CardBox;
}

/** Half a port's 10px ring, the canvas's port (`WorkflowTaskNode`). */
export const PORT_RADIUS = 5;

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

/** A port: its card, the side it is on, its centre, and whether lines leave it, arrive at it, or both. */
export interface Port extends Point {
  key: string;
  cardId: string;
  outgoing: boolean;
  incoming: boolean;
}

/** A card's port on one side: centred on that edge, at the title row. */
function portOf(box: CardBox, side: Side): Point {
  return {
    x: side === 'left' ? box.left : box.right,
    y: box.portY ?? box.top + Math.min(box.height / 2, 44),
  };
}

/** The port's outer edge on that side, where a line meets it. */
function rimOf(box: CardBox, side: Side): Point {
  const port = portOf(box, side);
  return { x: port.x + (side === 'left' ? -PORT_RADIUS : PORT_RADIUS), y: port.y };
}

function sidesOf(from: CardBox, to: CardBox): { fromSide: Side; toSide: Side; sameColumn: boolean } {
  if (Math.abs(from.left - to.left) < SAME_COLUMN_TOLERANCE) return { fromSide: 'right', toSide: 'right', sameColumn: true };
  const rightward = to.left > from.left;
  return { fromSide: rightward ? 'right' : 'left', toSide: rightward ? 'left' : 'right', sameColumn: false };
}

/**
 * Each link's SVG path, from its blocker's port to its dependent's.
 * `endInset` stops each line that far short of the port it points at, back
 * along the horizontal it arrives on, for the arrowhead to fill.
 */
export function linkPaths(links: readonly LinkRequest[], endInset = 0): Array<{ key: string; path: string }> {
  return links.map((link) => {
    const sides = sidesOf(link.from, link.to);
    const start = rimOf(link.from, sides.fromSide);
    const rim = rimOf(link.to, sides.toSide);
    if (sides.sameColumn) {
      // It bows out past both right edges, so it arrives moving left.
      const end = { x: rim.x + endInset, y: rim.y };
      return {
        key: link.key,
        path: `M ${start.x} ${start.y} C ${start.x + SAME_COLUMN_BOW} ${start.y}, ${end.x + SAME_COLUMN_BOW} ${end.y}, ${end.x} ${end.y}`,
      };
    }
    const direction = sides.fromSide === 'right' ? 1 : -1;
    const end = { x: rim.x - direction * endInset, y: rim.y };
    const handle = Math.max(48, Math.abs(end.x - start.x) * 0.5) * direction;
    return {
      key: link.key,
      path: `M ${start.x} ${start.y} C ${start.x + handle} ${start.y}, ${end.x - handle} ${end.y}, ${end.x} ${end.y}`,
    };
  });
}

/**
 * The ports these links meet, one per side of a card however many lines share
 * it, each saying whether lines leave it (its card is a blocker there) or
 * arrive at it (its card waits there). Which of them to draw is the caller's:
 * the canvas draws a port only where it could take a new link.
 */
export function linkPorts(links: readonly LinkRequest[]): Port[] {
  const ports = new Map<string, Port>();
  const add = (cardId: string, box: CardBox, side: Side, role: 'outgoing' | 'incoming') => {
    const key = `${cardId}:${side}`;
    const port = ports.get(key) ?? { key, cardId, ...portOf(box, side), outgoing: false, incoming: false };
    port[role] = true;
    ports.set(key, port);
  };
  for (const link of links) {
    const sides = sidesOf(link.from, link.to);
    add(link.fromId, link.from, sides.fromSide, 'outgoing');
    add(link.toId, link.to, sides.toSide, 'incoming');
  }
  return [...ports.values()];
}
