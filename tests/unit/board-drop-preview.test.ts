/**
 * Unit tests for the cross-column drop gap's pure half
 * (`src/renderer/utils/board-drop-preview.ts`).
 *
 * `getInsertionIndex` is the ONE function the drag preview and `handleDragEnd`
 * both call, so where the target lane's cards part is where the card lands.
 * Its rule is the one dnd-kit's own sorting uses in a card's own column: the
 * slot nearest the ghost's center, so the gap stays under the ghost and swaps
 * halfway between two slots. The old rule compared the POINTER to the middle
 * of the card under it, which flipped at a card's middle and opened the gap
 * beside the ghost.
 *
 * `rawDropPosition` turns that slot into the raw stored position a cross-column
 * move hands main. It equals the slot on a dense lane and differs from it on a
 * lane whose positions have gaps (0, 5, 9), which is the case it exists for.
 *
 * The DOM half's attribute bookkeeping (applyDropGap, closeDropGap,
 * settleDropGap, releaseDropSettle, clearDropGapDom) reads and writes only
 * attributes and one custom property, so it is covered here against fake
 * elements: which cards are written, and that a card the gap leaves keeps no
 * trace of it. What needs a real layout stays in the UI tier
 * (`tests/ui/board-cross-column-drop-gap.spec.ts`): where placeDropSlot puts the
 * slot card, the copy of the dragged card it shows, and the motion.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Task } from '../../src/shared/types';
import {
  CARD_GAP_PX,
  applyDropGap,
  clearDropGapDom,
  closeDropGap,
  dropGapTarget,
  getInsertionIndex,
  laneTasksForDrop,
  rawDropPosition,
  releaseDropSettle,
  settleDropGap,
  slotIndexAt,
  type CardSpan,
} from '../../src/renderer/utils/board-drop-preview';
import { RESTING_TRANSFORM } from '../../src/renderer/components/board/resting-transform';

const CARD_HEIGHT = 66;

/** Three 66px cards 8px apart, the board's own spacing. */
const THREE_CARDS: CardSpan[] = [0, 1, 2].map((index) => ({
  top: index * (CARD_HEIGHT + CARD_GAP_PX),
  bottom: index * (CARD_HEIGHT + CARD_GAP_PX) + CARD_HEIGHT,
}));

/** Where an incoming card of `height` would sit in `slot`: its center. */
function slotCenter(spans: readonly CardSpan[], slot: number, height: number): number {
  const top = slot < spans.length ? spans[slot].top : spans[spans.length - 1].bottom + CARD_GAP_PX;
  return top + height / 2;
}

describe('slotIndexAt', () => {
  it('opens the slot whose place the ghost is centered on', () => {
    for (let slot = 0; slot <= THREE_CARDS.length; slot++) {
      expect(slotIndexAt(slotCenter(THREE_CARDS, slot, CARD_HEIGHT), THREE_CARDS, CARD_HEIGHT, CARD_GAP_PX)).toBe(slot);
    }
  });

  it('keeps the slot under the ghost past the middle of its card, and swaps halfway to the next slot', () => {
    const slotOne = slotCenter(THREE_CARDS, 1, CARD_HEIGHT);
    const slotTwo = slotCenter(THREE_CARDS, 2, CARD_HEIGHT);
    const halfway = (slotOne + slotTwo) / 2;
    // Just below card 1's own middle: the old pointer-vs-middle rule had
    // already moved the gap below card 1 here, beside the ghost.
    expect(slotIndexAt(slotOne + 2, THREE_CARDS, CARD_HEIGHT, CARD_GAP_PX)).toBe(1);
    expect(slotIndexAt(halfway - 1, THREE_CARDS, CARD_HEIGHT, CARD_GAP_PX)).toBe(1);
    expect(slotIndexAt(halfway + 1, THREE_CARDS, CARD_HEIGHT, CARD_GAP_PX)).toBe(2);
  });

  it('takes the end slot once the ghost is past the last card', () => {
    const lastSlot = slotCenter(THREE_CARDS, 2, CARD_HEIGHT);
    const endSlot = slotCenter(THREE_CARDS, 3, CARD_HEIGHT);
    expect(slotIndexAt((lastSlot + endSlot) / 2 + 1, THREE_CARDS, CARD_HEIGHT, CARD_GAP_PX)).toBe(3);
    expect(slotIndexAt(endSlot + 500, THREE_CARDS, CARD_HEIGHT, CARD_GAP_PX)).toBe(3);
  });

  it('is slot 0 in a lane with no cards', () => {
    expect(slotIndexAt(500, [], CARD_HEIGHT, CARD_GAP_PX)).toBe(0);
  });

  it('measures slots by the incoming card, so a taller or shorter card swaps at its own halfway points', () => {
    const tall = 140;
    const short = 40;
    for (const height of [tall, short]) {
      const slotOne = slotCenter(THREE_CARDS, 1, height);
      const slotTwo = slotCenter(THREE_CARDS, 2, height);
      expect(slotIndexAt(slotOne, THREE_CARDS, height, CARD_GAP_PX)).toBe(1);
      expect(slotIndexAt((slotOne + slotTwo) / 2 - 1, THREE_CARDS, height, CARD_GAP_PX)).toBe(1);
      expect(slotIndexAt((slotOne + slotTwo) / 2 + 1, THREE_CARDS, height, CARD_GAP_PX)).toBe(2);
    }
  });
});

function makeTask(id: string, swimlaneId: string, position: number): Task {
  return { id, swimlane_id: swimlaneId, position } as Task;
}

interface FakeRect { top: number; left: number; width: number; height: number; right: number; bottom: number }

function rect(top: number, height: number): FakeRect {
  return { top, height, left: 0, width: 272, right: 272, bottom: top + height };
}

/** The slice of a dnd-kit drag event `getInsertionIndex` reads. */
function dragEvent(options: {
  ghostTop: number | null;
  ghostHeight?: number;
  overId: string | null;
  collisions: Array<{ id: string; top?: number; height?: number }>;
}): Parameters<typeof getInsertionIndex>[0] {
  const ghostHeight = options.ghostHeight ?? CARD_HEIGHT;
  return {
    active: {
      id: 'dragged',
      data: { current: undefined },
      rect: { current: { initial: null, translated: options.ghostTop === null ? null : rect(options.ghostTop, ghostHeight) } },
    },
    over: options.overId === null ? null : { id: options.overId, rect: rect(0, 0), disabled: false, data: { current: undefined } },
    collisions: options.collisions.map((collision) => ({
      id: collision.id,
      data: {
        droppableContainer: {
          rect: { current: collision.top === undefined ? null : rect(collision.top, collision.height ?? CARD_HEIGHT) },
        },
      },
    })),
  } as unknown as Parameters<typeof getInsertionIndex>[0];
}

const LANE = 'lane-planning';
const PLANNING = [makeTask('a', LANE, 0), makeTask('b', LANE, 1), makeTask('c', LANE, 2)];
const PLANNING_COLLISIONS = PLANNING.map((task, index) => ({ id: task.id, top: THREE_CARDS[index].top }));

describe('getInsertionIndex', () => {
  it('inserts at the slot the ghost is centered on', () => {
    const event = dragEvent({ ghostTop: THREE_CARDS[1].top, overId: 'b', collisions: PLANNING_COLLISIONS });
    expect(getInsertionIndex(event, PLANNING)).toBe(1);
  });

  it('reads the slot from the card rects even when `over` is the lane itself', () => {
    // Tier 2 offers the lane's own droppable for a cross-column drag, and its
    // mid-list center can win closestCenter while the ghost sits on a middle
    // card. That must not send the card to the end.
    const event = dragEvent({
      ghostTop: THREE_CARDS[1].top,
      overId: LANE,
      collisions: [{ id: LANE, top: 0, height: 400 }, ...PLANNING_COLLISIONS],
    });
    expect(getInsertionIndex(event, PLANNING)).toBe(1);
  });

  it('is the end when no card of the lane is among the collisions (an empty lane, or between columns)', () => {
    const emptyLane = dragEvent({ ghostTop: 20, overId: LANE, collisions: [{ id: LANE, top: 0, height: 400 }] });
    expect(getInsertionIndex(emptyLane, [])).toBe(0);
    const betweenColumns = dragEvent({ ghostTop: 20, overId: LANE, collisions: [{ id: LANE, top: 0, height: 400 }] });
    expect(getInsertionIndex(betweenColumns, PLANNING)).toBe(PLANNING.length);
  });

  it('ignores collisions that are not cards of the lane', () => {
    const event = dragEvent({
      ghostTop: THREE_CARDS[2].top,
      overId: 'c',
      collisions: [{ id: 'card-in-another-lane', top: THREE_CARDS[0].top }, ...PLANNING_COLLISIONS],
    });
    expect(getInsertionIndex(event, PLANNING)).toBe(2);
  });

  it('maps a slot among the rendered cards onto the lane order when a filter hides some', () => {
    // b is filtered off the board, so only a, c and d are rendered, in that order.
    const lane = [makeTask('a', LANE, 0), makeTask('b', LANE, 1), makeTask('c', LANE, 2), makeTask('d', LANE, 3)];
    const rendered = [
      { id: 'a', top: THREE_CARDS[0].top },
      { id: 'c', top: THREE_CARDS[1].top },
      { id: 'd', top: THREE_CARDS[2].top },
    ];
    // On c's place: before c, which is index 2 in the lane.
    expect(getInsertionIndex(dragEvent({ ghostTop: THREE_CARDS[1].top, overId: 'c', collisions: rendered }), lane)).toBe(2);
    // Past d: after d.
    expect(getInsertionIndex(dragEvent({ ghostTop: THREE_CARDS[2].bottom + 60, overId: 'd', collisions: rendered }), lane)).toBe(4);
  });

  it('is 0 with no target and the end with no measured ghost, as before', () => {
    expect(getInsertionIndex(dragEvent({ ghostTop: 0, overId: null, collisions: PLANNING_COLLISIONS }), PLANNING)).toBe(0);
    expect(getInsertionIndex(dragEvent({ ghostTop: null, overId: 'a', collisions: PLANNING_COLLISIONS }), PLANNING)).toBe(PLANNING.length);
  });

  it.each([
    ['c, a, b', ['c', 'a', 'b']],
    ['b, c, a', ['b', 'c', 'a']],
    ['c, b, a', ['c', 'b', 'a']],
    ['b, a, c', ['b', 'a', 'c']],
    ['a, c, b', ['a', 'c', 'b']],
  ])('finds the slot the ghost is centered on when the collisions arrive nearest first as %s', (_label, arrivalOrder) => {
    // closestCenter hands the lane's cards back by distance from the ghost, not
    // top to bottom. The slot is read against the cards in lane order, so the
    // end slot (after the last card) must still be the end.
    const collisions = arrivalOrder.map((id) => ({
      id,
      top: THREE_CARDS[PLANNING.findIndex((task) => task.id === id)].top,
    }));
    for (let slot = 0; slot <= PLANNING.length; slot++) {
      const ghostTop = slotCenter(THREE_CARDS, slot, CARD_HEIGHT) - CARD_HEIGHT / 2;
      const event = dragEvent({ ghostTop, overId: 'a', collisions });
      expect(getInsertionIndex(event, PLANNING), `ghost centered on slot ${slot}`).toBe(slot);
    }
    const pastTheEnd = dragEvent({ ghostTop: THREE_CARDS[2].bottom + 60, overId: 'a', collisions });
    expect(getInsertionIndex(pastTheEnd, PLANNING)).toBe(PLANNING.length);
  });

  it('skips a lane card whose droppable has no measured rect, and maps the cards that have one', () => {
    const collisions = [
      { id: 'a', top: undefined },
      { id: 'b', top: THREE_CARDS[1].top },
      { id: 'c', top: THREE_CARDS[2].top },
    ];
    // b and c are rendered (lane indexes 1 and 2); a is not measured.
    expect(getInsertionIndex(dragEvent({ ghostTop: THREE_CARDS[1].top, overId: 'b', collisions }), PLANNING)).toBe(1);
    expect(getInsertionIndex(dragEvent({ ghostTop: THREE_CARDS[2].top, overId: 'c', collisions }), PLANNING)).toBe(2);
    expect(getInsertionIndex(dragEvent({ ghostTop: THREE_CARDS[2].bottom + 60, overId: 'c', collisions }), PLANNING)).toBe(3);
  });

  it('is the end when no lane card has a measured rect', () => {
    const collisions = PLANNING.map((task) => ({ id: task.id, top: undefined }));
    expect(getInsertionIndex(dragEvent({ ghostTop: THREE_CARDS[0].top, overId: 'a', collisions }), PLANNING)).toBe(PLANNING.length);
  });
});

describe('laneTasksForDrop', () => {
  it("is the lane's cards in position order, without the dragged card", () => {
    const tasks = [
      makeTask('c', LANE, 2),
      makeTask('other-lane', 'lane-todo', 0),
      makeTask('a', LANE, 0),
      makeTask('dragged', LANE, 1),
      makeTask('b', LANE, 1),
    ];
    expect(laneTasksForDrop(tasks, LANE, 'dragged').map((task) => task.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('rawDropPosition', () => {
  // `TaskRepository.move` reads its target as a RAW stored position: it shifts
  // the lane's rows at or past it and writes the card there. Archiving leaves a
  // lane's positions as they were, so a lane can sit at 0, 5, 9, and handing
  // move() the slot INDEX would land the card a slot early, beside the gap.
  const gappedLane = [makeTask('a', LANE, 0), makeTask('b', LANE, 5), makeTask('c', LANE, 9)];

  it('is the raw position of the card holding the slot, and one past the last card for the end slot, on a gapped lane (0, 5, 9)', () => {
    expect(rawDropPosition(gappedLane, 0)).toBe(0);
    expect(rawDropPosition(gappedLane, 1)).toBe(5);
    expect(rawDropPosition(gappedLane, 2)).toBe(9);
    expect(rawDropPosition(gappedLane, 3)).toBe(10);
  });

  it('is the slot index itself on a dense lane (0, 1, 2)', () => {
    for (let slot = 0; slot <= PLANNING.length; slot++) {
      expect(rawDropPosition(PLANNING, slot)).toBe(slot);
    }
  });

  it('anchors slot 0 on the first card even when the lane does not start at 0', () => {
    const offsetLane = [makeTask('a', LANE, 3), makeTask('b', LANE, 4)];
    expect(rawDropPosition(offsetLane, 0)).toBe(3);
    expect(rawDropPosition(offsetLane, 2)).toBe(5);
  });

  it('is one past the last card for any slot at or past the end', () => {
    expect(rawDropPosition(gappedLane, 4)).toBe(10);
    expect(rawDropPosition(gappedLane, 99)).toBe(10);
  });

  it('is 0 in an empty lane', () => {
    expect(rawDropPosition([], 0)).toBe(0);
  });
});

describe('dropGapTarget', () => {
  const base = {
    activeId: 'task-1',
    originLaneId: 'lane-todo',
    targetLaneId: LANE,
    doneLaneId: 'lane-done',
    lockedLaneId: null,
    refused: false,
  };

  it('parts the target lane for a card from another column', () => {
    expect(dropGapTarget(base)).toBe(LANE);
  });

  it.each([
    ['a column drag', { activeId: `column:${LANE}` }],
    ['no target', { targetLaneId: null }],
    ['no origin', { originLaneId: null }],
    ["the card's own lane (dnd-kit parts that one)", { targetLaneId: 'lane-todo' }],
    ['Done (it has its own drop zone)', { targetLaneId: 'lane-done' }],
    ['a locked workflow card', { lockedLaneId: 'lane-todo' }],
    ['a move the workflow lock refuses', { refused: true }],
  ])('parts nothing for %s', (_label, overrides) => {
    expect(dropGapTarget({ ...base, ...overrides })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The DOM half's attribute bookkeeping, against fake elements. The fakes keep
// real state (an attribute set, a property map) and count every write, so a
// test can say which cards a call touched and what a card was left carrying.
// An unknown selector throws, so a selector that drifts fails loudly instead
// of matching nothing.
// ---------------------------------------------------------------------------

const SHIFT_ATTRIBUTE = 'data-drop-shift';
const SETTLE_ATTRIBUTE = 'data-drop-settle';
const GAP_PROPERTY = '--drop-gap';

function createFakeCard(taskId: string, markedAttributes: string[] = []) {
  const attributes = new Set<string>(markedAttributes);
  const properties = new Map<string, string>();
  return {
    dataset: { taskId },
    attributes,
    properties,
    hasAttribute: vi.fn((name: string) => attributes.has(name)),
    setAttribute: vi.fn((name: string) => { attributes.add(name); }),
    removeAttribute: vi.fn((name: string) => { attributes.delete(name); }),
    style: {
      // A real CSSStyleDeclaration answers '' for a property that is not set.
      getPropertyValue: vi.fn((name: string) => properties.get(name) ?? ''),
      setProperty: vi.fn((name: string, value: string) => { properties.set(name, value); }),
      removeProperty: vi.fn((name: string) => { properties.delete(name); }),
    },
  };
}
type FakeCard = ReturnType<typeof createFakeCard>;

function createFakeSlot(visible: boolean) {
  const attributes = new Set<string>(['data-drop-slot']);
  if (visible) attributes.add('data-visible');
  return {
    attributes,
    hasAttribute: vi.fn((name: string) => attributes.has(name)),
    removeAttribute: vi.fn((name: string) => { attributes.delete(name); }),
    replaceChildren: vi.fn(),
  };
}
type FakeSlot = ReturnType<typeof createFakeSlot>;

/** The list `applyDropGap` and `closeDropGap` walk: its direct cards, and its slot card if it has one. */
function createFakeList(cards: FakeCard[], slot: FakeSlot | null): HTMLElement {
  return {
    querySelectorAll: vi.fn((selector: string) => {
      if (selector === ':scope > [data-task-id]') return cards;
      throw new Error(`Unexpected querySelectorAll selector: ${selector}`);
    }),
    querySelector: vi.fn((selector: string) => {
      if (selector === ':scope > [data-drop-slot]') return slot;
      throw new Error(`Unexpected querySelector selector: ${selector}`);
    }),
  } as unknown as HTMLElement;
}

/** Every attribute or style write a card took: the number a call that leaves the card alone must keep at zero. */
function writeCount(card: FakeCard): number {
  return card.setAttribute.mock.calls.length
    + card.removeAttribute.mock.calls.length
    + card.style.setProperty.mock.calls.length
    + card.style.removeProperty.mock.calls.length;
}

function clearCallHistory(cards: FakeCard[]): void {
  for (const card of cards) {
    card.setAttribute.mockClear();
    card.removeAttribute.mockClear();
    card.style.setProperty.mockClear();
    card.style.removeProperty.mockClear();
  }
}

describe('applyDropGap', () => {
  const lane = [makeTask('a', LANE, 0), makeTask('b', LANE, 1), makeTask('c', LANE, 2)];

  function freshLane() {
    const cards = lane.map((task) => createFakeCard(task.id));
    return { cards, cardA: cards[0], cardB: cards[1], cardC: cards[2], list: createFakeList(cards, null) };
  }

  it('shifts every card at or past the slot, with the gap value, and leaves the cards before it alone', () => {
    const { cards, cardA, list } = freshLane();

    applyDropGap(list, lane, 1, 74);

    expect(cards.map((card) => card.attributes.has(SHIFT_ATTRIBUTE))).toEqual([false, true, true]);
    expect(cards.map((card) => card.properties.get(GAP_PROPERTY))).toEqual([undefined, '74px', '74px']);
    expect(writeCount(cardA)).toBe(0);
  });

  it('takes both the shift and the gap value from a card the slot moves past', () => {
    const { cardB, cardC, list } = freshLane();
    applyDropGap(list, lane, 1, 74);

    applyDropGap(list, lane, 2, 74);

    expect(cardB.attributes.has(SHIFT_ATTRIBUTE)).toBe(false);
    // The stray property is the regression: with only the attribute removed, a
    // card out of the gap kept `--drop-gap`, and clearDropGapDom finds cards by
    // their attributes, so it could never find that one again.
    expect(cardB.properties.has(GAP_PROPERTY)).toBe(false);
    expect(cardC.attributes.has(SHIFT_ATTRIBUTE)).toBe(true);
    expect(cardC.properties.get(GAP_PROPERTY)).toBe('74px');
  });

  it('writes only the card that crosses the slot when the slot moves by one, down and then up', () => {
    const { cards, cardA, cardB, cardC, list } = freshLane();
    applyDropGap(list, lane, 1, 74);
    clearCallHistory(cards);

    applyDropGap(list, lane, 2, 74);

    // b leaves the gap: its attribute and its value, once each. a and c are
    // already in the state slot 2 gives them, so nothing is written to either.
    expect(cardB.removeAttribute).toHaveBeenCalledTimes(1);
    expect(cardB.style.removeProperty).toHaveBeenCalledTimes(1);
    expect(cardB.setAttribute).not.toHaveBeenCalled();
    expect(cardB.style.setProperty).not.toHaveBeenCalled();
    expect(writeCount(cardA)).toBe(0);
    expect(writeCount(cardC)).toBe(0);

    clearCallHistory(cards);

    applyDropGap(list, lane, 1, 74);

    // b enters the gap: its attribute and its value, once each.
    expect(cardB.setAttribute).toHaveBeenCalledTimes(1);
    expect(cardB.style.setProperty).toHaveBeenCalledTimes(1);
    expect(cardB.removeAttribute).not.toHaveBeenCalled();
    expect(cardB.style.removeProperty).not.toHaveBeenCalled();
    expect(writeCount(cardA)).toBe(0);
    expect(writeCount(cardC)).toBe(0);
  });

  it('rewrites only the gap value, never the attribute, when the gap size changes under the same slot', () => {
    const { cards, cardA, cardB, cardC, list } = freshLane();
    applyDropGap(list, lane, 1, 74);
    clearCallHistory(cards);

    applyDropGap(list, lane, 1, 82);

    expect(cardB.properties.get(GAP_PROPERTY)).toBe('82px');
    expect(cardC.properties.get(GAP_PROPERTY)).toBe('82px');
    expect(cardB.setAttribute).not.toHaveBeenCalled();
    expect(cardC.setAttribute).not.toHaveBeenCalled();
    expect(writeCount(cardA)).toBe(0);
  });
});

describe('closeDropGap', () => {
  const lane = [makeTask('a', LANE, 0), makeTask('b', LANE, 1), makeTask('c', LANE, 2)];

  it('takes both the shift and the gap value from every card, in a list with no slot card', () => {
    const cards = lane.map((task) => createFakeCard(task.id));
    const list = createFakeList(cards, null);
    applyDropGap(list, lane, 0, 74);
    expect(cards.map((card) => card.attributes.has(SHIFT_ATTRIBUTE))).toEqual([true, true, true]);

    closeDropGap(list);

    for (const card of cards) {
      expect(card.attributes.has(SHIFT_ATTRIBUTE)).toBe(false);
      expect(card.properties.has(GAP_PROPERTY)).toBe(false);
    }
  });

  it('clears a gap value a card carries without the shift attribute', () => {
    const strayCard = createFakeCard('a');
    strayCard.properties.set(GAP_PROPERTY, '74px');

    closeDropGap(createFakeList([strayCard], null));

    expect(strayCard.properties.has(GAP_PROPERTY)).toBe(false);
  });

  it("hides the list's slot card and empties its copy", () => {
    const slot = createFakeSlot(true);

    closeDropGap(createFakeList([], slot));

    expect(slot.attributes.has('data-visible')).toBe(false);
    expect(slot.replaceChildren).toHaveBeenCalledTimes(1);
    expect(slot.replaceChildren).toHaveBeenCalledWith();
  });
});

describe('clearDropGapDom', () => {
  /** A root whose `querySelectorAll` answers the attribute-presence selectors the clear uses, from the elements' live attributes. */
  function createFakeRoot(elements: Array<{ attributes: Set<string> }>): ParentNode {
    return {
      querySelectorAll: (selector: string) => elements.filter((element) => selector.split(',').some((group) => {
        const required = [...group.matchAll(/\[([\w-]+)\]/g)].map((match) => match[1]);
        return required.length > 0 && required.every((attributeName) => element.attributes.has(attributeName));
      })),
    } as unknown as ParentNode;
  }

  it('removes the shift and settle attributes and the gap value from every marked card, and hides every slot', () => {
    const shifted = createFakeCard('a', [SHIFT_ATTRIBUTE]);
    shifted.properties.set(GAP_PROPERTY, '74px');
    const settled = createFakeCard('b', [SETTLE_ATTRIBUTE]);
    settled.properties.set(GAP_PROPERTY, '0px');
    const shiftedAndSettled = createFakeCard('c', [SHIFT_ATTRIBUTE, SETTLE_ATTRIBUTE]);
    shiftedAndSettled.properties.set(GAP_PROPERTY, '74px');
    const unmarked = createFakeCard('d');
    const visibleSlot = createFakeSlot(true);
    const hiddenSlot = createFakeSlot(false);
    const root = createFakeRoot([shifted, settled, shiftedAndSettled, unmarked, visibleSlot, hiddenSlot]);

    clearDropGapDom(root);

    for (const markedCard of [shifted, settled, shiftedAndSettled]) {
      expect(markedCard.attributes.has(SHIFT_ATTRIBUTE)).toBe(false);
      expect(markedCard.attributes.has(SETTLE_ATTRIBUTE)).toBe(false);
      expect(markedCard.properties.has(GAP_PROPERTY)).toBe(false);
    }
    expect(writeCount(unmarked)).toBe(0);
    for (const slot of [visibleSlot, hiddenSlot]) {
      expect(slot.attributes.has('data-visible')).toBe(false);
      expect(slot.removeAttribute).toHaveBeenCalledWith('data-visible');
      expect(slot.replaceChildren).toHaveBeenCalledTimes(1);
      expect(slot.replaceChildren).toHaveBeenCalledWith();
    }
  });

  it('does nothing to a document with no gap in it', () => {
    const card = createFakeCard('a');

    clearDropGapDom(createFakeRoot([card]));

    expect(writeCount(card)).toBe(0);
  });
});

describe('index.css drop gap rules', () => {
  const css =fs.readFileSync(path.join(__dirname, '../../src/renderer/index.css'), 'utf8');

  function ruleBody(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} rule is missing from index.css`).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start));
  }

  it('holds a settled card at the resting transform, through the variable so the minifier cannot fold it', () => {
    // Lifting the settle must change nothing on screen: the card's own inline
    // transform is RESTING_TRANSFORM by then, and a different function list
    // for the same matrix starts a transition (resting-transform.ts). A
    // literal `translate3d(0px, 0px, 0)` here shipped as the 2D `translate(0)`
    // after minification, so the rule reads --drop-gap, which settleDropGap
    // sets to 0px.
    const settle = ruleBody('[data-drop-settle]');
    const transform = /transform: ([^;!]+) !important/.exec(settle)?.[1];
    expect(transform).toBe('translate3d(0px, var(--drop-gap), 0) scaleX(1) scaleY(1)');
    expect(transform?.replace('var(--drop-gap)', '0px')).toBe(RESTING_TRANSFORM);
  });

  it('settles a shifted card with --drop-gap at 0px, and the release takes the variable away', () => {
    const attributes = new Set<string>(['data-drop-shift']);
    const properties = new Map<string, string>([['--drop-gap', '76px']]);
    const card = {
      setAttribute: (name: string) => attributes.add(name),
      removeAttribute: (name: string) => attributes.delete(name),
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    };
    const root = {
      querySelectorAll: (selector: string) => {
        if (selector === '[data-drop-shift]') return attributes.has('data-drop-shift') ? [card] : [];
        if (selector === '[data-drop-settle]') return attributes.has('data-drop-settle') ? [card] : [];
        return [];
      },
    } as unknown as ParentNode;

    settleDropGap(root);
    expect([...attributes]).toEqual(['data-drop-settle']);
    expect(properties.get('--drop-gap')).toBe('0px');

    releaseDropSettle(root);
    expect(attributes.size).toBe(0);
    expect(properties.has('--drop-gap')).toBe(false);
  });

  it("shifts a card with the same transform function list, so dnd-kit's inline transition interpolates it", () => {
    expect(RESTING_TRANSFORM).toBe('translate3d(0px, 0px, 0) scaleX(1) scaleY(1)');
    expect(ruleBody('[data-drop-shift]')).toContain('transform: translate3d(0px, var(--drop-gap), 0) scaleX(1) scaleY(1) !important');
  });

  it('registers --drop-gap as non-inherited, so writing it restyles only the card it is on', () => {
    expect(ruleBody('@property --drop-gap')).toContain('inherits: false');
  });
});
