/**
 * A board card's resting transform (`RESTING_TRANSFORM`, from
 * `resting-transform.ts`, which TaskCard.tsx reads).
 *
 * When a drag starts, dnd-kit gives every card in the dragged card's column its
 * own zero transform and sets the sortable `transition` in the same commit. A
 * resting card written as `translate3d(0, 0, 0)` is the same matrix but a
 * different STRING to the browser, so each of those cards started a 200ms
 * transition from identity to identity (about 5ms of paint and layerize on the
 * frame that first draws the overlay at 90 workflow cards in To Do). Spelling
 * the resting value exactly as dnd-kit spells its zero starts none.
 *
 * The first two tests compare strings, a unit-sized fact. The second oracle is
 * the library's own sortable strategy, so the pin follows dnd-kit if it ever
 * changes how it writes a zero. The third renders the real card to markup, with
 * react-dom/server and no DOM, and reads the transform it painted.
 */
import { describe, it, expect } from 'vitest';
import { CSS } from '@dnd-kit/utilities';
import { verticalListSortingStrategy } from '@dnd-kit/sortable';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { RESTING_TRANSFORM } from '../../src/renderer/components/board/resting-transform';
import { TaskCard } from '../../src/renderer/components/board/TaskCard';
import type { Task } from '../../src/shared/types';

function rect(top: number): { top: number; left: number; bottom: number; right: number; width: number; height: number } {
  return { top, left: 0, bottom: top + 80, right: 300, width: 300, height: 80 };
}

describe('RESTING_TRANSFORM', () => {
  it('is the string dnd-kit writes for its own zero transform', () => {
    expect(RESTING_TRANSFORM).toBe(CSS.Transform.toString({ x: 0, y: 0, scaleX: 1, scaleY: 1 }));
  });

  it('is what dnd-kit hands a card its list strategy does not displace', () => {
    const rects = [rect(0), rect(90), rect(180)];
    // Card 0 is lifted and hovers over itself, so the card at index 2 neither
    // shifts up nor down: the strategy answers with its zero transform.
    const bystander = verticalListSortingStrategy({
      activeIndex: 0,
      activeNodeRect: rects[0],
      index: 2,
      overIndex: 0,
      rects,
    });

    expect(bystander).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
    expect(RESTING_TRANSFORM).toBe(CSS.Transform.toString(bystander));
  });

  it('is what the board card draws at rest', () => {
    // The real card, server-rendered under a real DndContext with no drag in
    // progress: useSortable hands it no transform, so the style it paints is
    // the fallback. react-dom/server needs no DOM.
    const task = {
      id: 'task-resting', display_id: 1, title: 'Resting card', description: '', swimlane_id: 'lane-1', position: 0,
      agent: 'claude', session_id: null, worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
      base_branch: null, use_worktree: null, labels: [], priority: 0, attachment_count: 0, archived_at: null,
      created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
    } as unknown as Task;

    const markup = renderToStaticMarkup(
      createElement(I18nProvider, { i18n },
        createElement(DndContext, null,
          createElement(SortableContext, { items: [task.id] }, createElement(TaskCard, { task })))),
    );

    const cardRoot = markup.match(/^<div style="([^"]*)"[^>]*data-task-id="task-resting"/);
    expect(cardRoot, 'the card root with its style was not found at the start of the markup').not.toBeNull();
    const restingStyle = cardRoot![1].split(';').find((declaration) => declaration.startsWith('transform:'));
    expect(restingStyle).toBe(`transform:${RESTING_TRANSFORM}`);
  });
});
