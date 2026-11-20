/**
 * The priority level meter (task #1137) carries a level's rank in its bar count, so two levels
 * never differ by color alone. These pin the bars `priorityMeterBars` hands every surface that
 * draws priority: the backlog table, board cards, task detail, the Agent Monitor and the
 * Priorities popover.
 */
import { describe, expect, it } from 'vitest';
import { priorityMeterBars, priorityMeterWidth } from '../../src/renderer/components/backlog/PriorityMeter';

/** The seeded scale: None, Low, Medium, High, Urgent. */
const SEEDED_LEVELS = 5;

function filledCount(level: number, levelCount: number): number {
  return priorityMeterBars(level, levelCount).filter((bar) => bar.filled).length;
}

describe('priorityMeterBars', () => {
  it('draws one bar per level above None, filled up to the level', () => {
    expect(priorityMeterBars(2, SEEDED_LEVELS)).toHaveLength(4);
    expect([0, 1, 2, 3, 4].map((level) => filledCount(level, SEEDED_LEVELS))).toEqual([0, 1, 2, 3, 4]);
  });

  it('rises from 5px to 14px, each bar at least as tall as the one before', () => {
    const heights = priorityMeterBars(4, SEEDED_LEVELS).map((bar) => bar.heightPx);
    expect(heights[0]).toBe(5);
    expect(heights[heights.length - 1]).toBe(14);
    heights.slice(1).forEach((height, index) => expect(height).toBeGreaterThanOrEqual(heights[index]));
  });

  it('follows the scale: a seven-level scale has six bars, so every meter changes with it', () => {
    expect(priorityMeterBars(2, 7)).toHaveLength(6);
    expect(filledCount(2, 7)).toBe(2);
  });

  it('fills every bar for a level past the end of the scale', () => {
    expect(filledCount(9, SEEDED_LEVELS)).toBe(4);
  });

  it('keeps one bar for a scale of None alone', () => {
    expect(priorityMeterBars(0, 1)).toEqual([{ heightPx: 5, filled: false }]);
  });
});

describe('priorityMeterWidth', () => {
  it('is 3px per bar with 2px between them', () => {
    expect(priorityMeterWidth(SEEDED_LEVELS)).toBe(18);
    expect(priorityMeterWidth(7)).toBe(28);
  });
});
