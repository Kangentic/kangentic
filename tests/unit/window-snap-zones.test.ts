import { describe, it, expect } from 'vitest';
import {
  classifySnapZone,
  nextSnap,
  type SnapZone,
} from '../../src/renderer/window-manager/dnd/snap-zones';

describe('classifySnapZone', () => {
  it('recognizes maximized, top-half, side halves, and corners from the rendered rect', () => {
    expect(classifySnapZone({ x: 0, y: 0, w: 1, h: 1 })).toBe('maximized');
    expect(classifySnapZone({ x: 0, y: 0, w: 1, h: 0.5 })).toBe('top-half');
    expect(classifySnapZone({ x: 0, y: 0, w: 0.5, h: 1 })).toBe('left-half');
    expect(classifySnapZone({ x: 0.5, y: 0, w: 0.5, h: 1 })).toBe('right-half');
    expect(classifySnapZone({ x: 0, y: 0, w: 0.5, h: 0.5 })).toBe('top-left');
    expect(classifySnapZone({ x: 0.5, y: 0, w: 0.5, h: 0.5 })).toBe('top-right');
    expect(classifySnapZone({ x: 0, y: 0.5, w: 0.5, h: 0.5 })).toBe('bottom-left');
    expect(classifySnapZone({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })).toBe('bottom-right');
  });

  it('treats an arbitrary centered window as floating', () => {
    expect(classifySnapZone({ x: 0.2, y: 0.15, w: 0.58, h: 0.7 })).toBe('floating');
  });

  it('tolerates a small seam gap / rounding around a tiled half', () => {
    expect(classifySnapZone({ x: 0.503, y: 0.004, w: 0.495, h: 0.99 })).toBe('right-half');
  });
});

describe('nextSnap transition table', () => {
  it('floating: left/right dock to a half, up maximizes, down is a no-op', () => {
    expect(nextSnap('floating', 'left')).toEqual({ kind: 'dock', edge: 'left' });
    expect(nextSnap('floating', 'right')).toEqual({ kind: 'dock', edge: 'right' });
    expect(nextSnap('floating', 'up')).toEqual({ kind: 'maximize' });
    expect(nextSnap('floating', 'down')).toEqual({ kind: 'none' });
  });

  it('the UP ladder never dead-ends: corner -> maximize -> top-half', () => {
    expect(nextSnap('top-left', 'up')).toEqual({ kind: 'maximize' });
    expect(nextSnap('top-right', 'up')).toEqual({ kind: 'maximize' });
    expect(nextSnap('maximized', 'up')).toMatchObject({ kind: 'snap', zone: 'top-half' });
    expect(nextSnap('top-half', 'up')).toEqual({ kind: 'none' });
  });

  it('DOWN reverses the top of the ladder: top-half -> maximize -> restore', () => {
    expect(nextSnap('top-half', 'down')).toEqual({ kind: 'maximize' });
    expect(nextSnap('maximized', 'down')).toEqual({ kind: 'restore' });
  });

  it('maximized snaps to a side half on left/right', () => {
    expect(nextSnap('maximized', 'left')).toEqual({ kind: 'dock', edge: 'left' });
    expect(nextSnap('maximized', 'right')).toEqual({ kind: 'dock', edge: 'right' });
  });

  it('a half goes up/down to its corners and across to the other half', () => {
    expect(nextSnap('left-half', 'up')).toMatchObject({ kind: 'snap', zone: 'top-left' });
    expect(nextSnap('left-half', 'down')).toMatchObject({ kind: 'snap', zone: 'bottom-left' });
    expect(nextSnap('left-half', 'right')).toEqual({ kind: 'dock', edge: 'right' });
    expect(nextSnap('left-half', 'left')).toEqual({ kind: 'none' });
    expect(nextSnap('right-half', 'up')).toMatchObject({ kind: 'snap', zone: 'top-right' });
    expect(nextSnap('right-half', 'left')).toEqual({ kind: 'dock', edge: 'left' });
  });

  it('a corner descends back to its half and moves across to the sibling corner', () => {
    expect(nextSnap('top-left', 'down')).toEqual({ kind: 'dock', edge: 'left' });
    expect(nextSnap('top-left', 'right')).toMatchObject({ kind: 'snap', zone: 'top-right' });
    expect(nextSnap('bottom-right', 'up')).toEqual({ kind: 'dock', edge: 'right' });
    expect(nextSnap('bottom-right', 'left')).toMatchObject({ kind: 'snap', zone: 'bottom-left' });
    expect(nextSnap('bottom-right', 'down')).toEqual({ kind: 'none' });
  });

  it('the top half moves across to the top corners', () => {
    expect(nextSnap('top-half', 'left')).toMatchObject({ kind: 'snap', zone: 'top-left' });
    expect(nextSnap('top-half', 'right')).toMatchObject({ kind: 'snap', zone: 'top-right' });
  });
});

// Compile-time exhaustiveness: every zone is named in the table above.
const _zonesCovered: Record<SnapZone, true> = {
  maximized: true,
  floating: true,
  'left-half': true,
  'right-half': true,
  'top-half': true,
  'top-left': true,
  'top-right': true,
  'bottom-left': true,
  'bottom-right': true,
};
void _zonesCovered;
