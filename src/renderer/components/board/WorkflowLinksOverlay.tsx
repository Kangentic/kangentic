import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useBoardStore } from '../../stores/board-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { WorkflowDetail } from '../../../shared/types';
import { ARROWHEAD_PATH, ARROWHEAD_STROKES, arrowheadLength, linkPaths, type CardBox, type LinkRequest } from './workflow-links-geometry';

/** The colored line's width; its halo is wider. */
const LINE_WIDTH = 2;

/**
 * The board's links overlay for one workflow card (#732 board 8): lines from
 * what it waits for into it, and from it to what waits for it, with those
 * cards ringed and every other card dimmed, the Done drop zone and the
 * Completed header with them. It opens from Show workflow links in the card's
 * menu or from a refused move, never on hover, and the lines are the whole
 * overlay: nothing is added to the toolbar.
 *
 * The cards are found by `data-task-id` inside the board's lanes only (the
 * drag overlay, the flying card and task windows carry the attribute too). A
 * related card that is not rendered (pushed out of the Done column's list)
 * draws no line. The lines are measured on the frame the overlay opens, then
 * at most once per animation frame on a scroll, a resize or a board change.
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

const COLORS = {
  done: 'var(--color-active)',
  pending: 'var(--color-fg-faint)',
  dependent: 'var(--color-accent-fg)',
} as const;

const NO_SEGMENTS: Segment[] = [];

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

const DIM = 'opacity: 0.3 !important; transition: opacity 150ms ease-out;';

/**
 * CSS that rings the focus and its relations and dims the rest of the board:
 * every other lane card, the Completed header, and the Done drop zone as one
 * piece. A drop zone holding a related card (one still flying into Done)
 * stays lit and dims its other cards one by one instead, so no card is dimmed
 * twice over.
 */
function focusStyle(relations: Relations): string {
  const related = [relations.focusId, ...relations.blockers.map((blocker) => blocker.id), ...relations.dependents];
  const quoted = (id: string) => `[data-task-id="${CSS.escape(id)}"]`;
  const keep = related.map((id) => `:not(${quoted(id)})`).join('');
  const anyRelated = related.map(quoted).join(', ');
  const dropZone = '[data-board-lanes] [data-done-drop-zone]';
  return [
    `[data-board-lanes] [data-task-id]${keep}:not([data-done-drop-zone] *) { ${DIM} }`,
    `${dropZone}:not(:has(${anyRelated})) { ${DIM} }`,
    `${dropZone}:has(${anyRelated}) [data-task-id]${keep} { ${DIM} }`,
    `[data-board-lanes] [data-done-completed-header] { ${DIM} }`,
    `[data-board-lanes] ${quoted(relations.focusId)} { outline: 2px solid color-mix(in srgb, var(--color-fg-muted) 75%, transparent); outline-offset: 1px; }`,
    ...relations.blockers.map((blocker) => `[data-board-lanes] ${quoted(blocker.id)} { outline: 1px solid color-mix(in srgb, ${blocker.done ? COLORS.done : COLORS.pending} 60%, transparent); outline-offset: 1px; }`),
    ...relations.dependents.map((id) => `[data-board-lanes] ${quoted(id)} { outline: 1px solid color-mix(in srgb, ${COLORS.dependent} 55%, transparent); outline-offset: 1px; }`),
  ].join('\n');
}

export function WorkflowLinksOverlay({ boardRef }: { boardRef: React.RefObject<HTMLDivElement | null> }) {
  const linkFocus = useWorkflowStore((state) => state.linkFocus);
  const linkFocusLoading = useWorkflowStore((state) => state.linkFocusLoading);
  const [segments, setSegments] = useState<Segment[]>(NO_SEGMENTS);

  const relations = useMemo(
    () => (linkFocus ? relationsOf(linkFocus.taskId, linkFocus.detail) : null),
    [linkFocus],
  );

  // Off the board, the overlay goes: a view or project switch ends it.
  useEffect(() => () => useWorkflowStore.getState().clearLinks(), []);

  const measure = useCallback(() => {
    const board = boardRef.current;
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
  }, [boardRef, relations]);

  // The first measure is synchronous, so the lines appear on the frame the
  // overlay opens.
  useLayoutEffect(() => { measure(); }, [measure]);

  // Then re-measure when anything that moves a card on screen happens: a lane
  // or the board scrolls (capture, since scroll does not bubble), the window
  // resizes, or the board's tasks or columns change. One measure per animation
  // frame at most, and nothing at all while the overlay is closed: the board
  // store is read through a subscription, so a closed overlay never re-renders.
  useEffect(() => {
    const board = boardRef.current;
    if (!relations || !board) return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    board.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const unsubscribe = useBoardStore.subscribe((state, previous) => {
      if (state.tasks !== previous.tasks || state.swimlanes !== previous.swimlanes || state.archivedTasks !== previous.archivedTasks) schedule();
    });
    return () => {
      board.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [boardRef, relations, measure]);

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

  if (!relations) return null;
  return (
    <>
      <style data-testid="workflow-links-style">{focusStyle(relations)}</style>
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none z-[1] overflow-visible"
        aria-hidden="true"
        data-testid="workflow-links-overlay"
        data-focus-task-id={relations.focusId}
      >
        <defs>
          {(Object.keys(COLORS) as Array<keyof typeof COLORS>).map((kind) => (
            <marker key={kind} id={`workflow-link-${kind}`} viewBox="0 0 10 10" refX="0" refY="5" markerWidth={ARROWHEAD_STROKES} markerHeight={ARROWHEAD_STROKES} orient="auto">
              <path d={ARROWHEAD_PATH} fill={COLORS[kind]} />
            </marker>
          ))}
        </defs>
        {segments.map((segment) => (
          <g key={segment.key} data-testid="workflow-link-line" data-link={segment.key}>
            <path d={segment.path} fill="none" stroke="var(--color-surface)" strokeWidth={6} strokeLinecap="round" opacity={0.85} />
            <path d={segment.path} fill="none" stroke={segment.color} strokeWidth={LINE_WIDTH} strokeLinecap="round" markerEnd={`url(#workflow-link-${segment.marker})`} />
          </g>
        ))}
      </svg>
    </>
  );
}
