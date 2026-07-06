import { describe, it, expect } from 'vitest';

/**
 * Unit coverage for the pure `laneColor` helper in
 * src/renderer/components/dialogs/task-detail/graph/CommitGraphSvg.tsx.
 *
 * The module also exports the memoized CommitGraphSvg React component, but
 * `laneColor` and `LANE_COLORS` have no DOM or hook dependencies (the file's
 * only runtime import is `memo` from React), so importing the named exports
 * directly resolves cleanly under vitest's on-the-fly TypeScript transform -
 * the same pattern established in dialog-maximize.test.ts for a sibling
 * pure-function-plus-component module.
 */
import { laneColor, LANE_COLORS } from '../../src/renderer/components/dialogs/task-detail/graph/CommitGraphSvg';

describe('laneColor', () => {
  it('returns the color at the given index for lanes within range', () => {
    expect(laneColor(0)).toBe(LANE_COLORS[0]);
    expect(laneColor(1)).toBe(LANE_COLORS[1]);
    expect(laneColor(LANE_COLORS.length - 1)).toBe(LANE_COLORS[LANE_COLORS.length - 1]);
  });

  it('wraps around via modulo once the lane index reaches LANE_COLORS.length', () => {
    expect(laneColor(LANE_COLORS.length)).toBe(LANE_COLORS[0]);
    expect(laneColor(LANE_COLORS.length + 1)).toBe(LANE_COLORS[1]);
  });

  it('returns a defined LANE_COLORS entry for every lane across two full cycles', () => {
    for (let lane = 0; lane < LANE_COLORS.length * 2; lane += 1) {
      const color = laneColor(lane);
      expect(color).toBeDefined();
      expect(LANE_COLORS).toContain(color);
    }
  });
});
