/**
 * Unit tests for `restoredLaneOrder` (`src/shared/restore-lane-order.ts`).
 *
 * It is the one rule for where a task restored out of Done lands in its target
 * lane. Main's TASK_UNARCHIVE and TASK_BULK_UNARCHIVE write the order it
 * returns back as dense positions, and the renderer's optimistic restore and
 * the UI mock place the card by the same rule, so the card shows in the slot
 * main will write. It always returns an order: a whole number from 0 to the
 * number of OTHER cards (the end slot included) is honored, and anything else
 * puts the restored id last.
 */

import { describe, it, expect } from 'vitest';
import { restoredLaneOrder } from '../../src/shared/restore-lane-order';

const LANE = ['a', 'b', 'c'];

describe('restoredLaneOrder', () => {
  describe('an index inside the lane', () => {
    it('inserts the restored id at that index', () => {
      expect(restoredLaneOrder(LANE, 'restored', 1)).toEqual(['a', 'restored', 'b', 'c']);
    });

    it('inserts at index 0, ahead of every card', () => {
      expect(restoredLaneOrder(LANE, 'restored', 0)).toEqual(['restored', 'a', 'b', 'c']);
    });

    it('inserts at the last card index (length - 1), still ahead of the last card', () => {
      expect(restoredLaneOrder(LANE, 'restored', LANE.length - 1)).toEqual(['a', 'b', 'restored', 'c']);
    });

    it('honors the end slot (index == length), which places the id last', () => {
      expect(restoredLaneOrder(LANE, 'restored', LANE.length)).toEqual(['a', 'b', 'c', 'restored']);
    });

    it('leaves the lane it was given untouched', () => {
      const lane = ['a', 'b', 'c'];
      restoredLaneOrder(lane, 'restored', 1);
      expect(lane).toEqual(['a', 'b', 'c']);
    });
  });

  describe('an index that means "last"', () => {
    it.each([
      ['one past the end slot', LANE.length + 1],
      ['far past the end slot', 99],
      ['negative', -1],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['negative infinity', Number.NEGATIVE_INFINITY],
      ['omitted', undefined],
    ])('puts the id last for a %s index', (_label, requestedIndex) => {
      expect(restoredLaneOrder(LANE, 'restored', requestedIndex)).toEqual(['a', 'b', 'c', 'restored']);
    });

    it('returns just the id for an empty lane, whatever the index', () => {
      for (const requestedIndex of [undefined, 0, 1, -1]) {
        expect(restoredLaneOrder([], 'restored', requestedIndex)).toEqual(['restored']);
      }
    });
  });

  describe('a restored id that is already in the lane', () => {
    // The bound and the placement are both computed against the OTHER cards, so
    // the id is placed once however many times the lane listed it.
    const LANE_WITH_RESTORED = ['a', 'restored', 'b'];

    it('keeps it once, at the requested index among the other cards', () => {
      const result = restoredLaneOrder(LANE_WITH_RESTORED, 'restored', 1);
      expect(result).toEqual(['a', 'restored', 'b']);
      expect(result.filter((taskId) => taskId === 'restored')).toHaveLength(1);
    });

    it('moves it to index 0 without leaving the old copy behind', () => {
      const result = restoredLaneOrder(LANE_WITH_RESTORED, 'restored', 0);
      expect(result).toEqual(['restored', 'a', 'b']);
      expect(result.filter((taskId) => taskId === 'restored')).toHaveLength(1);
    });

    it('moves it up from the end of the lane to the requested index', () => {
      expect(restoredLaneOrder(['a', 'b', 'restored'], 'restored', 1)).toEqual(['a', 'restored', 'b']);
    });

    it('puts it last for index 2, the end slot of the two other cards', () => {
      // Counting the restored id the lane has three entries and 2 would be a
      // card slot; the bound is the lane WITHOUT it, so 2 is the end slot.
      const result = restoredLaneOrder(LANE_WITH_RESTORED, 'restored', 2);
      expect(result).toEqual(['a', 'b', 'restored']);
      expect(result.filter((taskId) => taskId === 'restored')).toHaveLength(1);
    });

    it('puts it last, once, for an index past the end slot and for none', () => {
      for (const requestedIndex of [3, 99, undefined]) {
        const result = restoredLaneOrder(LANE_WITH_RESTORED, 'restored', requestedIndex);
        expect(result).toEqual(['a', 'b', 'restored']);
        expect(result.filter((taskId) => taskId === 'restored')).toHaveLength(1);
      }
    });

    it('returns just the id for a lane holding nothing but the restored id', () => {
      expect(restoredLaneOrder(['restored'], 'restored', 0)).toEqual(['restored']);
    });
  });
});
