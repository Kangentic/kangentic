import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useBoardStore } from '../../stores/board-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { WorkflowDetail } from '../../../shared/types';

/**
 * The board's links overlay for one workflow card (#732 board 8): lines from
 * what it waits for into it, and from it to what waits for it, with those
 * cards ringed and every other card dimmed. It opens from Show workflow links
 * in the card's menu or from a refused move, never on hover, and the lines
 * are the whole overlay: nothing is added to the toolbar.
 *
 * The cards are found by `data-task-id` inside the board's lanes only (the
 * drag overlay, the flying card and task windows carry the attribute too) and
 * measured once per scroll, resize or board change, never per frame. Escape
 * or a pointer press on empty board space clears it.
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
  dependent: 'var(--color-accent)',
} as const;

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

/** Where a line meets a card: the facing edge, at the title row. */
function anchor(rect: DOMRect, side: 'left' | 'right', origin: DOMRect): { x: number; y: number } {
  return {
    x: (side === 'left' ? rect.left - 2 : rect.right + 2) - origin.left,
    y: rect.top + Math.min(rect.height / 2, 44) - origin.top,
  };
}

function curveBetween(from: DOMRect, to: DOMRect, origin: DOMRect): string {
  const sameColumn = Math.abs(from.left - to.left) < 24;
  if (sameColumn) {
    // Both in one column: leave and enter on the right edge, bowed outward.
    const start = anchor(from, 'right', origin);
    const end = anchor(to, 'right', origin);
    const bow = 56;
    return `M ${start.x} ${start.y} C ${start.x + bow} ${start.y}, ${end.x + bow} ${end.y}, ${end.x} ${end.y}`;
  }
  const rightward = to.left > from.left;
  const start = anchor(from, rightward ? 'right' : 'left', origin);
  const end = anchor(to, rightward ? 'left' : 'right', origin);
  const handle = Math.max(48, Math.abs(end.x - start.x) * 0.5) * (rightward ? 1 : -1);
  return `M ${start.x} ${start.y} C ${start.x + handle} ${start.y}, ${end.x - handle} ${end.y}, ${end.x} ${end.y}`;
}

/** CSS that rings the focus and its relations and dims every other lane card. */
function focusStyle(relations: Relations): string {
  const related = [relations.focusId, ...relations.blockers.map((blocker) => blocker.id), ...relations.dependents];
  const quoted = (id: string) => `[data-task-id="${CSS.escape(id)}"]`;
  const keep = related.map((id) => `:not(${quoted(id)})`).join('');
  return [
    `[data-board-lanes] [data-task-id]${keep} { opacity: 0.3 !important; transition: opacity 150ms ease-out; }`,
    `[data-board-lanes] ${quoted(relations.focusId)} { outline: 2px solid color-mix(in srgb, var(--color-fg-faint) 75%, transparent); outline-offset: 1px; }`,
    ...relations.blockers.map((blocker) => `[data-board-lanes] ${quoted(blocker.id)} { outline: 1px solid color-mix(in srgb, ${blocker.done ? COLORS.done : COLORS.pending} 60%, transparent); outline-offset: 1px; }`),
    ...relations.dependents.map((id) => `[data-board-lanes] ${quoted(id)} { outline: 1px solid color-mix(in srgb, ${COLORS.dependent} 55%, transparent); outline-offset: 1px; }`),
  ].join('\n');
}

export function WorkflowLinksOverlay({ boardRef }: { boardRef: React.RefObject<HTMLDivElement | null> }) {
  const linkFocus = useWorkflowStore((state) => state.linkFocus);
  const tasks = useBoardStore((state) => state.tasks);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [measureTick, setMeasureTick] = useState(0);

  const relations = useMemo(
    () => (linkFocus ? relationsOf(linkFocus.taskId, linkFocus.detail) : null),
    [linkFocus],
  );

  // Off the board, the overlay goes: a view or project switch ends it.
  useEffect(() => () => useWorkflowStore.getState().clearLinks(), []);

  const measure = useCallback(() => setMeasureTick((tick) => tick + 1), []);

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!relations || !board) {
      setSegments([]);
      return;
    }
    const lanes = board.querySelector('[data-board-lanes]');
    const origin = board.getBoundingClientRect();
    const rectOf = (id: string): DOMRect | null => {
      const card = lanes?.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
      return card ? card.getBoundingClientRect() : null;
    };
    const focusRect = rectOf(relations.focusId);
    if (!focusRect) {
      setSegments([]);
      return;
    }
    const next: Segment[] = [];
    for (const blocker of relations.blockers) {
      const rect = rectOf(blocker.id);
      if (rect) next.push({ key: `in:${blocker.id}`, path: curveBetween(rect, focusRect, origin), color: blocker.done ? COLORS.done : COLORS.pending, marker: blocker.done ? 'done' : 'pending' });
    }
    for (const id of relations.dependents) {
      const rect = rectOf(id);
      if (rect) next.push({ key: `out:${id}`, path: curveBetween(focusRect, rect, origin), color: COLORS.dependent, marker: 'dependent' });
    }
    setSegments(next);
  }, [boardRef, relations, tasks, swimlanes, measureTick]);

  // Re-measure when anything that moves a card on screen happens: a lane or
  // the board scrolls (capture, since scroll does not bubble), or the window
  // resizes. One measure per animation frame at most.
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
    return () => {
      board.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [boardRef, relations, measure]);

  // Clear on a press on empty board space, or Escape. Escape here is the
  // structural kind (keybindings-registry.md): it acts only when nothing else
  // took the key, a dialog, a menu or a task window, all of which handle
  // Escape themselves and keep focus inside them.
  useEffect(() => {
    const board = boardRef.current;
    if (!relations || !board) return undefined;
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
  }, [boardRef, relations]);

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
            <marker key={kind} id={`workflow-link-${kind}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0 1 L9 5 L0 9 z" fill={COLORS[kind]} />
            </marker>
          ))}
        </defs>
        {segments.map((segment) => (
          <g key={segment.key} data-testid="workflow-link-line" data-link={segment.key}>
            <path d={segment.path} fill="none" stroke="var(--color-surface)" strokeWidth={6} strokeLinecap="round" opacity={0.85} />
            <path d={segment.path} fill="none" stroke={segment.color} strokeWidth={2} strokeLinecap="round" markerEnd={`url(#workflow-link-${segment.marker})`} />
          </g>
        ))}
      </svg>
    </>
  );
}
