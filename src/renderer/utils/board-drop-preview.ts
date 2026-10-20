import type { ClientRect, Collision, DragMoveEvent } from '@dnd-kit/core';
import type { Task } from '../../shared/types';

/**
 * Where a card dragged into another column lands, and the DOM that shows it
 * before the drop: the target column's cards part under the ghost and a dimmed
 * copy of the card fills the slot, the way the card's own column already
 * behaves.
 *
 * The parting is a transform on each card at or past the slot, never a change
 * to which lane a card is in. dnd-kit measures droppables with transforms
 * ignored (`getTransformAgnosticClientRect`), so a shifted card feeds nothing
 * back into collision detection. Moving the card between lanes mid-drag is what
 * made `closestCenter` oscillate at the column boundary (`cd7b40c1b`).
 */

/** The gap `space-y-2` puts between cards in `[data-swimlane-task-list]` (Swimlane). */
export const CARD_GAP_PX = 8;

const SHIFT_ATTRIBUTE = 'data-drop-shift';
const SETTLE_ATTRIBUTE = 'data-drop-settle';
const GAP_PROPERTY = '--drop-gap';
const SLOT_SELECTOR = '[data-drop-slot]';
/** Shows the slot card. Without it the card is `display: none` (index.css says why). */
const SLOT_VISIBLE_ATTRIBUTE = 'data-visible';

/** The lane's cards a cross-column drop is indexed against: the order `handleDragEnd` inserts into. */
export function laneTasksForDrop(tasks: readonly Task[], laneId: string, activeId: string): Task[] {
  return tasks
    .filter((task) => task.swimlane_id === laneId && task.id !== activeId)
    .sort((a, b) => a.position - b.position);
}

/** A rendered card's static top and bottom edges, in the collision rects' coordinates. */
export interface CardSpan {
  top: number;
  bottom: number;
}

/**
 * The slot nearest the ghost's center, the rule dnd-kit's own sorting uses
 * (`closestCenter` on the collision rect), so the gap opens under the ghost and
 * swaps halfway between two slots. Slot `k` is where the incoming card would
 * sit if inserted before card `k`; the last slot follows the last card.
 * `spans` are in top-to-bottom order. Returns 0 to `spans.length`.
 */
export function slotIndexAt(
  ghostCenterY: number,
  spans: readonly CardSpan[],
  incomingHeight: number,
  gap: number,
): number {
  if (spans.length === 0) return 0;
  let nearestSlot = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let slot = 0; slot <= spans.length; slot++) {
    const slotTop = slot < spans.length ? spans[slot].top : spans[spans.length - 1].bottom + gap;
    const distance = Math.abs(ghostCenterY - (slotTop + incomingHeight / 2));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestSlot = slot;
    }
  }
  return nearestSlot;
}

/** The static rect dnd-kit measured for a collision's droppable, if it carries one. */
function collisionRect(collision: Collision): ClientRect | null {
  const container: unknown = collision.data?.droppableContainer;
  if (typeof container !== 'object' || container === null || !('rect' in container)) return null;
  const rectRef: unknown = container.rect;
  if (typeof rectRef !== 'object' || rectRef === null || !('current' in rectRef)) return null;
  const rect = rectRef.current as ClientRect | null;
  return rect ?? null;
}

/**
 * The index a cross-column drop inserts at, for the preview and the drop alike
 * (`handleDragEnd` calls this too, so the card lands where the gap was).
 *
 * The slot comes from the lane's card rects in `event.collisions` whatever
 * `over` is: tier 2 of the board's collision detection runs `closestCenter`
 * over every card of the target lane and, for a cross-column drag, the lane's
 * own droppable, whose mid-list center can win while the ghost sits on a middle
 * card. Only with no card of the lane among the collisions (an empty lane, or
 * the pointer between columns, where the fallback offers lanes alone) is the
 * slot the end.
 */
export function getInsertionIndex(
  event: Pick<DragMoveEvent, 'active' | 'over' | 'collisions'>,
  laneTasks: readonly Task[],
): number {
  if (!event.over) return 0;
  const ghost = event.active.rect.current.translated;
  if (!ghost) return laneTasks.length;

  const laneIndexById = new Map<string, number>();
  laneTasks.forEach((task, index) => laneIndexById.set(task.id, index));

  const rendered: Array<CardSpan & { laneIndex: number }> = [];
  for (const collision of event.collisions ?? []) {
    const laneIndex = laneIndexById.get(String(collision.id));
    if (laneIndex === undefined) continue;
    const rect = collisionRect(collision);
    if (rect) rendered.push({ laneIndex, top: rect.top, bottom: rect.top + rect.height });
  }
  if (rendered.length === 0) return laneTasks.length;
  rendered.sort((a, b) => a.laneIndex - b.laneIndex);

  const slot = slotIndexAt(ghost.top + ghost.height / 2, rendered, ghost.height, CARD_GAP_PX);
  // A board filter can hide cards, so a slot among the rendered cards maps to
  // the hidden-inclusive lane order: before the rendered card, or just after
  // the last one.
  return slot < rendered.length ? rendered[slot].laneIndex : rendered[rendered.length - 1].laneIndex + 1;
}

/**
 * The lane whose cards should part for this drag, or null when none should: a
 * column drag, no target, the card's own lane (dnd-kit parts that one already),
 * Done (it has its own drop zone), a locked workflow card, or a move the
 * workflow lock would refuse.
 */
export function dropGapTarget(input: {
  activeId: string;
  originLaneId: string | null;
  targetLaneId: string | null;
  doneLaneId: string | null;
  lockedLaneId: string | null;
  refused: boolean;
}): string | null {
  const { activeId, originLaneId, targetLaneId, doneLaneId, lockedLaneId, refused } = input;
  if (activeId.startsWith('column:')) return null;
  if (!targetLaneId || !originLaneId) return null;
  if (targetLaneId === originLaneId || targetLaneId === doneLaneId) return null;
  if (lockedLaneId || refused) return null;
  return targetLaneId;
}

/** The task list element of a lane (Swimlane's `data-swimlane-task-list`). */
export function laneTaskList(laneId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-swimlane-task-list="${CSS.escape(laneId)}"]`);
}

function renderedCards(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-task-id]'));
}

/**
 * Part the lane's rendered cards at `slot`: every card at or past it slides
 * down by `gapPx`. Attribute writes only; `index.css` turns `data-drop-shift`
 * into the transform, and dnd-kit's own inline transition animates it.
 */
export function applyDropGap(list: HTMLElement, laneTasks: readonly Task[], slot: number, gapPx: number): void {
  const shifted = new Set(laneTasks.slice(slot).map((task) => task.id));
  for (const card of renderedCards(list)) {
    if (card.dataset.taskId !== undefined && shifted.has(card.dataset.taskId)) {
      card.style.setProperty(GAP_PROPERTY, `${gapPx}px`);
      card.setAttribute(SHIFT_ATTRIBUTE, '');
    } else {
      card.removeAttribute(SHIFT_ATTRIBUTE);
    }
  }
}

/**
 * What a copy of a card must not carry: it is a picture of the card, never the
 * card. Without them a selector, a test or a screen reader that finds a card by
 * its task id, test id or focus stop would find the copy too.
 */
const LIVE_CARD_ATTRIBUTES = [
  'data-task-id', 'data-testid', 'id', 'tabindex', 'role',
  'aria-roledescription', 'aria-describedby', 'aria-description', 'aria-pressed', 'aria-disabled',
];

/**
 * A static copy of a card to fill the slot with, the way the dragged card fills
 * its slot in its own column. It is copied from the drag overlay's card, which
 * is the card as it will land: a card dragged out of Done is a compact row there
 * but a full card in the overlay. A copy rather than a second `TaskCard`, since
 * one rendered inside the drag would register a second sortable under the
 * dragged card's id.
 */
export function inertCardCopy(card: HTMLElement): HTMLElement {
  const copy = card.cloneNode(true) as HTMLElement;
  for (const element of [copy, ...copy.querySelectorAll('*')]) {
    for (const attribute of LIVE_CARD_ATTRIBUTES) element.removeAttribute(attribute);
  }
  // The overlay's lift, and dnd-kit's inline motion, are the overlay's alone.
  copy.classList.remove('shadow-xl');
  copy.style.removeProperty('transform');
  copy.style.removeProperty('transition');
  copy.style.removeProperty('opacity');
  return copy;
}

/**
 * Move the lane's slot card to `slot`. Its top is read from layout values
 * (`offsetTop`, `offsetHeight`), which transforms do not change, so it lands
 * where the gap opens: before the first rendered card at or past the slot,
 * after the last rendered card, or at the list's top padding when the lane
 * shows none. Already showing, it slides there with the cards; shown from
 * hidden, it is filled with a copy of `cardTemplate` (a blank card without
 * one) and fades in where it belongs (index.css).
 */
export function placeDropSlot(
  list: HTMLElement,
  laneTasks: readonly Task[],
  slot: number,
  heightPx: number,
  cardTemplate: HTMLElement | null,
): void {
  const slotElement = list.querySelector<HTMLElement>(`:scope > ${SLOT_SELECTOR}`);
  if (!slotElement) return;
  if (!slotElement.hasAttribute(SLOT_VISIBLE_ATTRIBUTE)) {
    slotElement.replaceChildren(...(cardTemplate ? [inertCardCopy(cardTemplate)] : []));
  }
  const cardById = new Map<string, HTMLElement>();
  for (const card of renderedCards(list)) {
    if (card.dataset.taskId !== undefined) cardById.set(card.dataset.taskId, card);
  }

  let top: number | null = null;
  for (let index = slot; index < laneTasks.length && top === null; index++) {
    const card = cardById.get(laneTasks[index].id);
    if (card) top = card.offsetTop;
  }
  for (let index = Math.min(slot, laneTasks.length) - 1; index >= 0 && top === null; index--) {
    const card = cardById.get(laneTasks[index].id);
    if (card) top = card.offsetTop + card.offsetHeight + CARD_GAP_PX;
  }
  if (top === null) top = Number.parseFloat(getComputedStyle(list).paddingTop) || 0;

  slotElement.style.height = `${heightPx}px`;
  slotElement.style.transform = `translate3d(0px, ${top}px, 0)`;
  slotElement.setAttribute(SLOT_VISIBLE_ATTRIBUTE, '');
}

/** Hide a slot card and drop its copy; the next placement fills it afresh. */
function hideDropSlot(slotElement: Element): void {
  slotElement.removeAttribute(SLOT_VISIBLE_ATTRIBUTE);
  slotElement.replaceChildren();
}

/** Close a lane's gap: its cards slide back and its slot card goes. */
export function closeDropGap(list: HTMLElement): void {
  for (const card of renderedCards(list)) card.removeAttribute(SHIFT_ATTRIBUTE);
  const slotElement = list.querySelector(`:scope > ${SLOT_SELECTOR}`);
  if (slotElement) hideDropSlot(slotElement);
}

/**
 * The drop landed: the dropped card is in the lane now, in the layout the gap
 * was showing. Each shifted card trades its shift for `data-drop-settle`, which
 * holds it at its resting transform with no transition, and the slot card goes,
 * so nothing on screen moves in this frame.
 *
 * The settle is held, not dropped a frame later: the insert gives every later
 * card a new index in its `SortableContext` while dnd-kit's `wasDragging` is
 * still true (50ms), so `useDerivedTransform` sets each of them an inline
 * transform back to its drag-start position and animates it home. Without the
 * hold the cards would jump up to where they were before the gap opened and
 * slide down again. `releaseDropSettle` lifts it once that has run its course.
 */
export function settleDropGap(root: ParentNode = document): void {
  for (const card of root.querySelectorAll<HTMLElement>(`[${SHIFT_ATTRIBUTE}]`)) {
    // The settle rule reads the same variable as the shift: at 0px it is the
    // card's resting transform (index.css says why it is not a literal).
    card.style.setProperty(GAP_PROPERTY, '0px');
    card.removeAttribute(SHIFT_ATTRIBUTE);
    card.setAttribute(SETTLE_ATTRIBUTE, '');
  }
  for (const slotElement of root.querySelectorAll(`${SLOT_SELECTOR}[${SLOT_VISIBLE_ATTRIBUTE}]`)) {
    hideDropSlot(slotElement);
  }
}

/** Lift a held settle. The card's own transform is the resting one by now, so nothing moves. */
export function releaseDropSettle(root: ParentNode = document): void {
  for (const card of root.querySelectorAll<HTMLElement>(`[${SETTLE_ATTRIBUTE}]`)) {
    card.removeAttribute(SETTLE_ATTRIBUTE);
    card.style.removeProperty(GAP_PROPERTY);
  }
}

/**
 * Remove every trace of a drop gap at once: shifts, settles, the gap values and
 * any visible slot card. The drag hook's exits and App.tsx's HMR handler call
 * it (Pattern D: an HMR mid-drag fires no dragEnd).
 */
export function clearDropGapDom(root: ParentNode = document): void {
  for (const card of root.querySelectorAll<HTMLElement>(`[${SHIFT_ATTRIBUTE}], [${SETTLE_ATTRIBUTE}]`)) {
    card.removeAttribute(SHIFT_ATTRIBUTE);
    card.removeAttribute(SETTLE_ATTRIBUTE);
    card.style.removeProperty(GAP_PROPERTY);
  }
  for (const slotElement of root.querySelectorAll(SLOT_SELECTOR)) hideDropSlot(slotElement);
}
