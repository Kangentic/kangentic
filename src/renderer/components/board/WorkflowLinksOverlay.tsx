import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBoardStore } from '../../stores/board-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { WorkflowDetail } from '../../../shared/types';
import { motionReduced } from '../../utils/motion-reduced';
import { ARROWHEAD_PATH, ARROWHEAD_STROKES, arrowheadLength, linkPaths, type CardBox, type LinkRequest } from './workflow-links-geometry';

/** The colored line's width; its halo is wider. */
const LINE_WIDTH = 2;
const CLIP_ID = 'workflow-links-overlay-clip';

/**
 * The board's links overlay for one workflow card (#732 board 8): lines from
 * what it waits for into it, and from it to what waits for it, with those
 * cards ringed and every other card dimmed, the Done drop zone and the
 * Completed header with them. The pointer resting on a card's strip previews
 * it until the pointer leaves; the strip's links button, Show workflow links in
 * the card's menu and a refused move keep it (`WorkflowLinksButton`). The lines
 * are the whole overlay: nothing is added to the toolbar.
 *
 * The cards are found by `data-task-id` inside the board's lanes only (the
 * drag overlay, the flying card and task windows carry the attribute too). A
 * related card that is not rendered (pushed out of the Done column's list)
 * draws no line. The lines are measured on the frame the overlay opens, then
 * at most once per animation frame on a scroll, a resize, a card changing
 * height, or a board change.
 *
 * The lines read as the Workflows canvas draws a selected task's links: the
 * same colors, arrowheads and flowing dashes (`workflow-link-flow` in
 * index.css), so a link looks the same on both. A line to a card scrolled out
 * of view keeps running toward it, and is clipped to the lanes below the
 * header row: it leaves view under the headers, the way a scrolled card does,
 * and never paints over a column's name, the toolbar or the panel below.
 * A board drag clears it (`useBoardDragDrop`), so a refused drop never leaves
 * it measuring under the next drag. Escape or a pointer press on empty board
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
}

function relationsOf(focusId: string, detail: WorkflowDetail): Relations {
  const placeOf = new Map(detail.tasks.map((task) => [task.key, task.place]));
  return {
    focusId,
    blockers: detail.links
      .filter((link) => link.blockedKey === focusId)
      .map((link) => ({ id: link.blockerKey, done: placeOf.get(link.blockerKey) === 'done' })),
    dependents: detail.links.filter((link) => link.blockerKey === focusId).map((link) => link.blockedKey),
  };
}

/** A card's box relative to the board, which the overlay's SVG fills. */
function boxIn(rect: DOMRect, origin: DOMRect): CardBox {
  return { left: rect.left - origin.left, right: rect.right - origin.left, top: rect.top - origin.top, height: rect.height };
}

/**
 * The overlay fades in and out over this long, lines, rings and dimming
 * together, so a look at a card's links eases onto the board rather than
 * flashing it dark. Motion off, it switches at once.
 */
const FADE_MS = 180;

/**
 * Where the fade is. `enter` puts the rules in place with nothing visible yet
 * (the rings transparent, the cards at their own opacity); a frame later
 * `shown` sets the look, which the rules' transitions ease into. `exit` takes
 * the look away under the same transitions, and the overlay unmounts after.
 */
type Phase = 'enter' | 'shown' | 'exit';

/**
 * CSS that rings the focus and its relations and dims the rest of the board:
 * every other lane card, the Completed header, and the Done drop zone as one
 * piece. A drop zone holding a related card (one still flying into Done)
 * stays lit and dims its other cards one by one instead, so no card is dimmed
 * twice over. Outside `shown` the same rules carry only their transitions, so
 * the look eases in and out: the rings go from and to transparent, and a
 * dimmed card from and to its own opacity.
 */
function focusStyle(relations: Relations, phase: Phase, motion: boolean): string {
  const shown = phase === 'shown';
  const ease = motion ? ` transition: opacity ${FADE_MS}ms ease-out, outline-color ${FADE_MS}ms ease-out;` : '';
  const dim = `${shown ? 'opacity: 0.3 !important;' : ''}${ease}`;
  const ring = (width: number, color: string) => `outline: ${width}px solid ${shown ? color : 'transparent'}; outline-offset: 1px;${ease}`;
  const related = [relations.focusId, ...relations.blockers.map((blocker) => blocker.id), ...relations.dependents];
  const quoted = (id: string) => `[data-task-id="${CSS.escape(id)}"]`;
  const keep = related.map((id) => `:not(${quoted(id)})`).join('');
  const anyRelated = related.map(quoted).join(', ');
  const dropZone = '[data-board-lanes] [data-done-drop-zone]';
  return [
    `[data-board-lanes] [data-task-id]${keep}:not([data-done-drop-zone] *) { ${dim} }`,
    `${dropZone}:not(:has(${anyRelated})) { ${dim} }`,
    `${dropZone}:has(${anyRelated}) [data-task-id]${keep} { ${dim} }`,
    `[data-board-lanes] [data-done-completed-header] { ${dim} }`,
    `[data-board-lanes] ${quoted(relations.focusId)} { ${ring(2, 'color-mix(in srgb, var(--color-fg-muted) 75%, transparent)')} }`,
    ...relations.blockers.map((blocker) => `[data-board-lanes] ${quoted(blocker.id)} { ${ring(1, `color-mix(in srgb, ${blocker.done ? COLORS.done : COLORS.pending} 60%, transparent)`)} }`),
    ...relations.dependents.map((id) => `[data-board-lanes] ${quoted(id)} { ${ring(1, `color-mix(in srgb, ${COLORS.dependent} 55%, transparent)`)} }`),
  ].join('\n');
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
  const [clip, setClip] = useState<ClipArea | null>(null);

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
    const relations = drawnRelations;
    if (!relations || !board) {
      setSegments(NO_SEGMENTS);
      return;
    }
    const lanes = board.querySelector('[data-board-lanes]');
    const origin = board.getBoundingClientRect();
    const boxOf = (id: string): CardBox | null => {
      const card = lanes?.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
      return card ? boxIn(card.getBoundingClientRect(), origin) : null;
    };
    const focusBox = boxOf(relations.focusId);
    if (!focusBox) {
      setSegments(NO_SEGMENTS);
      return;
    }
    // A related card that is not rendered (out of the Done column's list) has no box, and no line.
    const requests: LinkRequest[] = [];
    const looks: Array<Pick<Segment, 'color' | 'marker'>> = [];
    for (const blocker of relations.blockers) {
      const box = boxOf(blocker.id);
      if (!box) continue;
      requests.push({ key: `in:${blocker.id}`, fromId: blocker.id, from: box, toId: relations.focusId, to: focusBox });
      looks.push(blocker.done ? { color: COLORS.done, marker: 'done' } : { color: COLORS.pending, marker: 'pending' });
    }
    for (const id of relations.dependents) {
      const box = boxOf(id);
      if (!box) continue;
      requests.push({ key: `out:${id}`, fromId: relations.focusId, from: focusBox, toId: id, to: box });
      looks.push({ color: COLORS.dependent, marker: 'dependent' });
    }
    const next = linkPaths(requests, arrowheadLength(LINE_WIDTH)).map(({ key, path }, index): Segment => ({ key, path, ...looks[index] }));
    setSegments((previous) => (sameSegments(previous, next) ? previous : next));

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
    board.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const unsubscribe = useBoardStore.subscribe((state, previous) => {
      if (state.tasks !== previous.tasks || state.swimlanes !== previous.swimlanes || state.archivedTasks !== previous.archivedTasks) {
        // The cards just re-rendered: watch the ones on the board now.
        requestAnimationFrame(observeCards);
        schedule();
      }
    });
    return () => {
      board.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      unsubscribe();
      resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
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
        </g>
      </svg>
    </>
  );
}
