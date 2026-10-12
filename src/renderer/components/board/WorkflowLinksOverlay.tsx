import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBoardStore } from '../../stores/board-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { WorkflowDetail } from '../../../shared/types';
import { motionReduced } from '../../utils/motion-reduced';
import { transitiveReduction } from '../workflows/workflow-layout';
import { canBlock, canWait } from '../workflows/workflow-graph';
import { ARROWHEAD_PATH, ARROWHEAD_STROKES, PORT_RADIUS, arrowheadLength, linkPaths, linkPorts, type CardBox, type LinkRequest, type Port } from './workflow-links-geometry';

/** The colored line's width; its halo is wider. */
const LINE_WIDTH = 2;
const CLIP_ID = 'workflow-links-overlay-clip';

/**
 * The board's links overlay for one workflow card (#732 board 8): lines from
 * what it waits for into it, and from it to what waits for it, and the card
 * itself in the accent border the canvas gives its selected card. No other
 * card changes, as on the canvas. The pointer resting on a card previews it
 * until the pointer leaves the card (`card-links-preview.ts`); a refused move
 * keeps it. The lines are the whole overlay: nothing is added to the toolbar.
 *
 * The cards are found by `data-task-id` inside the board's lanes only (the
 * drag overlay, the flying card and task windows carry the attribute too). A
 * related card that is not rendered (pushed out of the Done column's list)
 * draws no line. The lines are measured on the frame the overlay opens, then
 * at most once per animation frame on a scroll, a resize, a card changing
 * height, or a board change, and every frame while the focused card is
 * dragged and for `DROP_SETTLE_MS` after its drop.
 *
 * The lines read as the Workflows canvas draws a selected task's links: the
 * same colors, arrowheads and flowing dashes (`workflow-link-flow` in
 * index.css), the same trimmed set (a link another path covers is left out),
 * and the same ports: one point per side of a card at its title row, which
 * every line on that side leaves or reaches, drawn as a ring only where the
 * canvas draws one. So a link looks the same on both. A line to a card scrolled out
 * of view keeps running toward it, and is clipped to the lanes below the
 * header row: it leaves view under the headers, the way a scrolled card does,
 * and never paints over a column's name, the toolbar or the panel below.
 * A drag of any other card clears it (`useBoardDragDrop`), so a refused drop
 * never leaves it measuring under the next drag; a drag of the focused card
 * keeps it, and its lines follow the card. Escape or a pointer press on empty board
 * space clears it too, from the moment its load starts.
 *
 * The lines are an SVG drawn from measured card boxes, not an icon, as the
 * commit graph's is (`CommitGraphSvg.tsx`), so the Lucide-only icon rule
 * (`ui-conventions.md`) does not cover them.
 */

interface Segment {
  key: string;
  path: string;
  color: string;
  marker: 'done' | 'pending' | 'dependent';
}

/** A selected task's link colors on the canvas (`WorkflowEdge`'s `lookOf`). */
const COLORS = {
  done: 'var(--color-active)',
  pending: 'var(--color-fg-muted)',
  dependent: 'var(--color-accent-fg)',
} as const;

const NO_SEGMENTS: Segment[] = [];
const NO_PORTS: Port[] = [];

/** Where the lines may paint, in the board's coordinates: the lanes below the header row. */
interface ClipArea {
  top: number;
  height: number;
  width: number;
}

function sameClip(previous: ClipArea | null, next: ClipArea | null): boolean {
  return previous === next || (previous !== null && next !== null
    && previous.top === next.top && previous.height === next.height && previous.width === next.width);
}

function samePorts(previous: readonly Port[], next: readonly Port[]): boolean {
  return previous.length === next.length
    && previous.every((port, index) => port.key === next[index].key && port.x === next[index].x && port.y === next[index].y);
}

function sameSegments(previous: readonly Segment[], next: readonly Segment[]): boolean {
  return previous.length === next.length
    && previous.every((segment, index) => segment.key === next[index].key
      && segment.path === next[index].path
      && segment.marker === next[index].marker);
}

interface Relations {
  focusId: string;
  /** Tasks the focus waits for, with whether each is done. */
  blockers: Array<{ id: string; done: boolean }>;
  /** Tasks that wait for the focus. */
  dependents: string[];
  /** Cards that draw an outgoing port, as on the canvas: any not yet done (`canBlock`). */
  canGive: ReadonlySet<string>;
  /** Cards that draw an incoming port, as on the canvas: only those not yet started (`canWait`). */
  canTake: ReadonlySet<string>;
}

/**
 * The focus card's links as the Workflows canvas draws them: a link another
 * path already covers (#9 to #12 when #12 waits for #10, which waits for #9)
 * is left out on both, since it changes nothing about when the task starts.
 * The card's footer and the inspector still count every blocker.
 */
function relationsOf(focusId: string, detail: WorkflowDetail): Relations {
  const placeOf = new Map(detail.tasks.map((task) => [task.key, task.place]));
  const drawn = transitiveReduction(detail.tasks.map((task) => task.key), detail.links);
  return {
    focusId,
    blockers: drawn
      .filter((link) => link.blockedKey === focusId)
      .map((link) => ({ id: link.blockerKey, done: placeOf.get(link.blockerKey) === 'done' })),
    dependents: drawn.filter((link) => link.blockerKey === focusId).map((link) => link.blockedKey),
    canGive: new Set(detail.tasks.filter(canBlock).map((task) => task.key)),
    canTake: new Set(detail.tasks.filter(canWait).map((task) => task.key)),
  };
}

/**
 * A card's box relative to the board, which the overlay's SVG fills, with its
 * ports at the middle of its title row (`data-card-title-row`), where a
 * Workflows canvas card has them. A compact Done card has no such row, and
 * keeps the point near its top.
 */
function boxOf(card: Element, origin: DOMRect): CardBox {
  const rect = card.getBoundingClientRect();
  const titleRow = card.querySelector('[data-card-title-row]')?.getBoundingClientRect();
  return {
    left: rect.left - origin.left,
    right: rect.right - origin.left,
    top: rect.top - origin.top,
    height: rect.height,
    portY: titleRow ? titleRow.top + titleRow.height / 2 - origin.top : undefined,
  };
}

/**
 * The overlay fades in and out over this long, the lines, their ports and the
 * focused card's border together, so a look at a card's links eases onto the
 * board. The canvas eases a link's change over the same 160ms (index.css).
 * Motion off, it switches at once.
 */
const FADE_MS = 160;

/**
 * Where the fade is. `enter` puts the rule in place with nothing visible yet;
 * once the layout is read, `shown` sets the look, which the transitions ease
 * into. `exit` takes the look away under the same transitions, and the
 * overlay unmounts after.
 */
type Phase = 'enter' | 'shown' | 'exit';

/**
 * CSS that marks the focused card as the Workflows canvas marks its selected
 * card: the accent border (`WorkflowCanvasCard`'s `SELECTED_BORDER_CLASS`).
 * The cards it is linked to get no ring and no card fades, as on the canvas:
 * the lines and their ports show the links. Outside `shown` the rule carries
 * only its transition, so the border eases in and out with the lines.
 */
function focusStyle(relations: Relations, phase: Phase, motion: boolean): string {
  const ease = motion ? ` transition: border-color ${FADE_MS}ms ease-out;` : '';
  const border = phase === 'shown' ? 'border-color: var(--color-accent) !important;' : '';
  return `[data-board-lanes] [data-task-id="${CSS.escape(relations.focusId)}"] { ${border}${ease} }`;
}

interface Drawn {
  relations: Relations;
  phase: Phase;
}

/** How long after a drop the lines keep following, while the cards settle into place. */
const DROP_SETTLE_MS = 300;

export function WorkflowLinksOverlay({ boardRef, dragging }: {
  boardRef: React.RefObject<HTMLDivElement | null>;
  /** A board drag is in flight. Only a drag of the focused card leaves the overlay up (`useBoardDragDrop`). */
  dragging: boolean;
}) {
  // The card and its workflow, not the whole focus: keeping a previewed card's
  // links changes only `kept`, and must not re-measure or redraw anything.
  const focusTaskId = useWorkflowStore((state) => state.linkFocus?.taskId ?? null);
  const focusDetail = useWorkflowStore((state) => state.linkFocus?.detail ?? null);
  const linkFocusLoading = useWorkflowStore((state) => state.linkFocusLoading);
  const [segments, setSegments] = useState<Segment[]>(NO_SEGMENTS);
  const [ports, setPorts] = useState<Port[]>(NO_PORTS);
  const [clip, setClip] = useState<ClipArea | null>(null);

  // The live focus. `drawnRelations` below is what is on screen, which outlives
  // it while the overlay fades out.
  const relations = useMemo(
    () => (focusTaskId && focusDetail ? relationsOf(focusTaskId, focusDetail) : null),
    [focusTaskId, focusDetail],
  );

  // What is drawn, which outlives the focus for the fade out. A new focus over
  // one already on screen (a kept card's reload, the keep moving to another
  // card) swaps in place; only an overlay coming up from nothing fades in.
  // Adjusted during render, React's pattern for state that follows a prop, so
  // no frame commits with the old focus.
  const motion = !motionReduced();
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  if (relations && drawn?.relations !== relations) {
    const phase: Phase = !motion ? 'shown' : drawn && drawn.phase !== 'exit' ? drawn.phase : 'enter';
    setDrawn({ relations, phase });
  } else if (!relations && drawn && drawn.phase !== 'exit') {
    setDrawn(motion ? { relations: drawn.relations, phase: 'exit' } : null);
  }
  const drawnRelations = drawn?.relations ?? null;
  const phase = drawn?.phase ?? null;

  // `exit` unmounts once its fade is done.
  useEffect(() => {
    if (phase !== 'exit') return undefined;
    const timer = window.setTimeout(() => setDrawn((current) => (current?.phase === 'exit' ? null : current)), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // Off the board, the overlay goes: a view or project switch ends it.
  useEffect(() => () => useWorkflowStore.getState().clearLinks(), []);

  const measure = useCallback(() => {
    const board = boardRef.current;
    if (!drawnRelations || !board) {
      setSegments(NO_SEGMENTS);
      setPorts(NO_PORTS);
      return;
    }
    const lanes = board.querySelector('[data-board-lanes]');
    const origin = board.getBoundingClientRect();
    const cardBox = (id: string): CardBox | null => {
      const card = lanes?.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
      return card ? boxOf(card, origin) : null;
    };
    const focusBox = cardBox(drawnRelations.focusId);
    if (!focusBox) {
      setSegments(NO_SEGMENTS);
      setPorts(NO_PORTS);
      return;
    }
    // A related card that is not rendered (out of the Done column's list) has no box, and no line.
    const requests: LinkRequest[] = [];
    const looks: Array<Pick<Segment, 'color' | 'marker'>> = [];
    for (const blocker of drawnRelations.blockers) {
      const box = cardBox(blocker.id);
      if (!box) continue;
      requests.push({ key: `in:${blocker.id}`, fromId: blocker.id, from: box, toId: drawnRelations.focusId, to: focusBox });
      looks.push(blocker.done ? { color: COLORS.done, marker: 'done' } : { color: COLORS.pending, marker: 'pending' });
    }
    for (const id of drawnRelations.dependents) {
      const box = cardBox(id);
      if (!box) continue;
      requests.push({ key: `out:${id}`, fromId: drawnRelations.focusId, from: focusBox, toId: id, to: box });
      looks.push({ color: COLORS.dependent, marker: 'dependent' });
    }
    const next = linkPaths(requests, arrowheadLength(LINE_WIDTH)).map(({ key, path }, index): Segment => ({ key, path, ...looks[index] }));
    setSegments((previous) => (sameSegments(previous, next) ? previous : next));
    // A port is drawn where the canvas draws one, where a new link could start
    // or end; a line still meets a card with no ring at that same point.
    const nextPorts = linkPorts(requests).filter((port) => (port.outgoing && drawnRelations.canGive.has(port.cardId))
      || (port.incoming && drawnRelations.canTake.has(port.cardId)));
    setPorts((previous) => (samePorts(previous, nextPorts) ? previous : nextPorts));

    // Every lane's card list starts at the bottom of the header row.
    const list = lanes?.querySelector('[data-swimlane-task-list]');
    const nextClip: ClipArea | null = lanes && list
      ? {
          top: Math.round(list.getBoundingClientRect().top - origin.top),
          height: Math.round(lanes.getBoundingClientRect().bottom - list.getBoundingClientRect().top),
          width: Math.round(origin.width),
        }
      : null;
    setClip((previous) => (sameClip(previous, nextClip) ? previous : nextClip));
  }, [boardRef, drawnRelations]);

  // The first measure is synchronous, so the lines appear on the frame the
  // overlay opens.
  useLayoutEffect(() => { measure(); }, [measure]);

  // `enter` is in the DOM with nothing visible, and the measure above has read
  // the layout, so the browser has computed it. Setting the look now renders
  // again before the paint, and the transitions ease from what was computed. No
  // animation frame is waited on: a hidden window gets none, and the overlay
  // must not stay invisible there.
  useLayoutEffect(() => {
    if (phase !== 'enter') return;
    boardRef.current?.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the second render before the paint is the point: a transition needs the computed `enter` look to start from.
    setDrawn((current) => (current?.phase === 'enter' ? { ...current, phase: 'shown' } : current));
  }, [boardRef, phase]);

  // Then re-measure when anything that moves a card on screen happens: a lane
  // or the board scrolls (capture, since scroll does not bubble), the window
  // resizes, or the board's tasks or columns change. One measure per animation
  // frame at most, and nothing at all while the overlay is closed: the board
  // store is read through a subscription, so a closed overlay never re-renders.
  useEffect(() => {
    const board = boardRef.current;
    if (!drawnRelations || !board) return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    // A card that grows or shrinks (an agent's trail updating under it) moves
    // every card below it with no scroll and no board change, so each card on
    // the board is watched for its size while the overlay is open.
    const resizeObserver = new ResizeObserver(schedule);
    const observeCards = () => {
      resizeObserver.disconnect();
      for (const card of board.querySelectorAll('[data-board-lanes] [data-task-id]')) resizeObserver.observe(card);
    };
    observeCards();
    // One re-observe per frame however many board changes land in it, and
    // cancelled with the rest: a pass that ran after the cleanup would hand
    // the disconnected observer every card again, measuring a focus that left.
    let observeFrame = 0;
    board.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const unsubscribe = useBoardStore.subscribe((state, previous) => {
      if (state.tasks !== previous.tasks || state.swimlanes !== previous.swimlanes || state.archivedTasks !== previous.archivedTasks) {
        // The cards just re-rendered: watch the ones on the board now.
        if (!observeFrame) observeFrame = requestAnimationFrame(() => { observeFrame = 0; observeCards(); });
        schedule();
      }
    });
    return () => {
      board.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      unsubscribe();
      resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (observeFrame) cancelAnimationFrame(observeFrame);
    };
  }, [boardRef, drawnRelations, measure]);

  // A drag slides the cards by transform, which no scroll, resize or board
  // change reports, so while the focused card is reordered the lines are
  // measured every frame, and for a moment after the drop while the cards
  // settle. Outside a drag this costs nothing.
  const followedDrag = useRef(false);
  useEffect(() => {
    if (!drawnRelations) return undefined;
    if (dragging) followedDrag.current = true;
    else if (!followedDrag.current) return undefined;
    else followedDrag.current = false;
    const until = dragging ? Number.POSITIVE_INFINITY : performance.now() + DROP_SETTLE_MS;
    let frame = 0;
    const follow = () => {
      measure();
      if (performance.now() < until) frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [dragging, drawnRelations, measure]);

  // Clear on a press on empty board space, or Escape. Escape here is the
  // structural kind (keybindings-registry.md): it acts only when nothing else
  // took the key, a dialog, a menu or a task window, all of which handle
  // Escape themselves and keep focus inside them. Both listen from the moment
  // a load starts, not only once it has drawn, so a clear made before the
  // first answer lands cancels that answer too.
  const listening = relations !== null || linkFocusLoading;
  useEffect(() => {
    const board = boardRef.current;
    if (!listening || !board) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('[data-task-id], button, a, input, [role="button"]')) return;
      useWorkflowStore.getState().clearLinks();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const active = document.activeElement;
      const focusOnBoard = !active || active === document.body || board.contains(active);
      if (!focusOnBoard) return;
      useWorkflowStore.getState().clearLinks();
    };
    board.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      board.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [boardRef, listening]);

  if (!drawn) return null;
  return (
    <>
      <style data-testid="workflow-links-style">{focusStyle(drawn.relations, drawn.phase, motion)}</style>
      <svg
        className="workflow-links-overlay absolute inset-0 w-full h-full pointer-events-none z-[1] overflow-visible"
        aria-hidden="true"
        data-testid="workflow-links-overlay"
        data-focus-task-id={drawn.relations.focusId}
        data-phase={drawn.phase}
        style={{ opacity: drawn.phase === 'shown' ? 1 : 0, transition: motion ? `opacity ${FADE_MS}ms ease-out` : undefined }}
      >
        <defs>
          {(Object.keys(COLORS) as Array<keyof typeof COLORS>).map((kind) => (
            <marker key={kind} id={`workflow-link-${kind}`} viewBox="0 0 10 10" refX="0" refY="5" markerWidth={ARROWHEAD_STROKES} markerHeight={ARROWHEAD_STROKES} orient="auto">
              <path d={ARROWHEAD_PATH} fill={COLORS[kind]} />
            </marker>
          ))}
          {clip && (
            <clipPath id={CLIP_ID}>
              <rect data-testid="workflow-links-clip" x={0} y={clip.top} width={clip.width} height={clip.height} />
            </clipPath>
          )}
        </defs>
        <g clipPath={clip ? `url(#${CLIP_ID})` : undefined}>
          {segments.map((segment) => (
            <g key={segment.key} data-testid="workflow-link-line" data-link={segment.key}>
              {/* The halo is the board's own: these lines cross cards, which the canvas's never do. */}
              <path d={segment.path} fill="none" stroke="var(--color-surface)" strokeWidth={6} strokeLinecap="round" opacity={0.85} />
              <path d={segment.path} className="workflow-link-flow" fill="none" stroke={segment.color} strokeWidth={LINE_WIDTH} strokeLinecap="round" markerEnd={`url(#workflow-link-${segment.marker})`} />
            </g>
          ))}
          {/* The canvas's port: a 10px ring in the accent on the surface, over the lines it joins. */}
          {ports.map((port) => (
            <circle
              key={port.key}
              data-testid="workflow-link-port"
              data-port={port.key}
              cx={port.x}
              cy={port.y}
              r={PORT_RADIUS - 1}
              fill="var(--color-surface)"
              stroke="var(--color-accent-fg)"
              strokeWidth={2}
            />
          ))}
        </g>
      </svg>
    </>
  );
}
