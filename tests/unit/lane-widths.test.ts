/**
 * The board's column widths (src/renderer/components/board/lane-widths.ts).
 *
 * Eight columns did not fit a 2124px board at a fixed 288px (#1056), so a
 * column is now shared, shrunk to its header, or collapsed to a strip, and
 * Fill sizes the columns to the window. These pin the rule that picks the
 * shape and the widths each setting allows. A person loses two things if one
 * drifts: Fill stops fitting the board it was added for (it did, at a 256px
 * floor), or Narrow, Default and Wide start changing width on their own and
 * every card reflows when another column empties.
 */

import { describe, it, expect } from 'vitest';
import {
  COLLAPSED_LANE_WIDTH_PX,
  FILL_FLOOR_PX,
  SHRUNK_LANE_WIDTH_PROPERTY,
  laneFlexStyle,
  laneShape,
  laneShapesKey,
  laneWidthRange,
} from '../../src/renderer/components/board/lane-widths';

describe('laneShape', () => {
  const lane = { collapsed: false, occupied: true, isDone: false, shrinkEmpty: true };

  it('a column with tasks shares the row', () => {
    expect(laneShape(lane)).toBe('shared');
  });

  it('an empty column shrinks to its header', () => {
    expect(laneShape({ ...lane, occupied: false })).toBe('shrunk');
  });

  it('an empty column keeps its width with Shrink empty columns off', () => {
    expect(laneShape({ ...lane, occupied: false, shrinkEmpty: false })).toBe('shared');
  });

  it('Done never shrinks: its completed tasks are archived, so it always reads as empty', () => {
    expect(laneShape({ ...lane, occupied: false, isDone: true })).toBe('shared');
  });

  it('a column the user collapsed is a strip whether or not it holds tasks', () => {
    expect(laneShape({ ...lane, collapsed: true })).toBe('collapsed');
    expect(laneShape({ ...lane, collapsed: true, occupied: false })).toBe('collapsed');
    expect(laneShape({ ...lane, collapsed: true, occupied: false, isDone: true })).toBe('collapsed');
  });
});

describe('laneWidthRange', () => {
  it('Narrow is fixed at 240px', () => {
    expect(laneWidthRange('narrow')).toEqual({ minPx: 240, maxPx: 240 });
  });

  it('Default is fixed at 288px, the width the board has always had', () => {
    expect(laneWidthRange('default')).toEqual({ minPx: 288, maxPx: 288 });
  });

  it('Wide is fixed at 384px', () => {
    expect(laneWidthRange('wide')).toEqual({ minPx: 384, maxPx: 384 });
  });

  it('Fill has no cap, and a floor well under Narrow so it can fit a crowded board', () => {
    expect(laneWidthRange('fill')).toEqual({ minPx: FILL_FLOOR_PX, maxPx: null });
    expect(FILL_FLOOR_PX).toBeLessThan(laneWidthRange('narrow').minPx);
  });
});

describe('laneFlexStyle', () => {
  it('a column at a fixed width neither grows past it nor shrinks below it', () => {
    expect(laneFlexStyle('shared', laneWidthRange('default'))).toEqual({
      flex: '1 0 288px',
      minWidth: '288px',
      maxWidth: '288px',
    });
  });

  it('a shared column under Fill grows from its floor with no cap', () => {
    expect(laneFlexStyle('shared', laneWidthRange('fill'))).toEqual({
      flex: `1 0 ${FILL_FLOOR_PX}px`,
      minWidth: `${FILL_FLOOR_PX}px`,
    });
  });

  it('a shrunk column takes the shrunk columns shared width, or its own content width until that is measured', () => {
    // Every empty column is one width (the widest empty one's header), so a row
    // of them does not read as clutter. The board measures and sets the property.
    expect(laneFlexStyle('shrunk', laneWidthRange('default'))).toEqual({
      flex: '0 0 auto',
      width: `var(${SHRUNK_LANE_WIDTH_PROPERTY}, max-content)`,
      maxWidth: '288px',
    });
    // Fill has no cap of its own, so a long name stops at Wide.
    expect(laneFlexStyle('shrunk', laneWidthRange('fill')).maxWidth).toBe('384px');
  });

  it('a collapsed column is the strip width under every setting', () => {
    for (const setting of ['narrow', 'default', 'wide', 'fill'] as const) {
      expect(laneFlexStyle('collapsed', laneWidthRange(setting))).toEqual({
        flex: `0 0 ${COLLAPSED_LANE_WIDTH_PX}px`,
        width: `${COLLAPSED_LANE_WIDTH_PX}px`,
      });
    }
  });

  it('eight columns with tasks fit a 2124px row under Fill', () => {
    // The case from task 1056, measured in a preview: a 2124px row, eight
    // columns, seven 16px gaps. With a 256px floor the row needed 2160px and
    // scrolled, with Fill selected. The floor has to leave room to fit.
    const { minPx } = laneWidthRange('fill');
    expect(8 * minPx + 7 * 16).toBeLessThanOrEqual(2124);
  });

  it('eight columns with tasks fit that row at Narrow', () => {
    // At 256px Narrow needed 2160px and missed by 36px, so the one fixed width
    // meant for a crowded board did not fit the board this task started from.
    const { minPx } = laneWidthRange('narrow');
    expect(8 * minPx + 7 * 16).toBeLessThanOrEqual(2124);
  });
});

describe('laneShapesKey', () => {
  it('changes when a column changes shape and holds when none does', () => {
    const before = laneShapesKey([{ id: 'a', shape: 'shared' }, { id: 'b', shape: 'shrunk' }]);
    expect(laneShapesKey([{ id: 'a', shape: 'shared' }, { id: 'b', shape: 'shrunk' }])).toBe(before);
    expect(laneShapesKey([{ id: 'a', shape: 'shared' }, { id: 'b', shape: 'shared' }])).not.toBe(before);
  });
});
