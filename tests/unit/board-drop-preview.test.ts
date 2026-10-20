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
 * The DOM half (applyDropGap, placeDropSlot, the settle) needs a real layout,
 * so the UI tier covers it (`tests/ui/board-cross-column-drop-gap.spec.ts`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Task } from '../../src/shared/types';
import {
  CARD_GAP_PX,
  dropGapTarget,
  getInsertionIndex,
  laneTasksForDrop,
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

describe('index.css drop gap rules', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.css'), 'utf8');

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
