/**
 * The Command Terminal panel's place per grid shape (`src/shared/command-terminal-panel.ts`):
 * which shape a count tiles in, which saved place a shape shows, and how a shape with no place
 * of its own grows around another's center. A wrong answer here moves a user's panel somewhere
 * they did not put it, or leaves it at the bigger shape's box after a Stop.
 */

import { describe, expect, it } from 'vitest';
import {
  commandTerminalPanelShape,
  growPlaceAroundCenter,
  readPanelPlaces,
  resolvePanelPlace,
} from '../../src/shared/command-terminal-panel';
import type { CommandTerminalPanelGeometry, CommandTerminalPanelPlaces } from '../../src/shared/types';

const AREA = { width: 2000, height: 1000 };
/** Two terminals at the floor beside the rail: 1462 by 242. */
const TWO_MIN = { width: 1462, height: 242 };
const ONE_MIN = { width: 832, height: 242 };
const DEFAULT_PLACE: CommandTerminalPanelGeometry = { x: 0.2, y: 0.15, w: 0.6, h: 0.7, maximized: false };

function place(x: number, y: number, w: number, h: number, maximized = false): CommandTerminalPanelGeometry {
  return { x, y, w, h, maximized };
}

function centerOf(geometry: CommandTerminalPanelGeometry): { x: number; y: number } {
  return { x: (geometry.x + geometry.w / 2) * AREA.width, y: (geometry.y + geometry.h / 2) * AREA.height };
}

function resolve(places: CommandTerminalPanelPlaces, shape: 'one' | 'two' | 'grid', options: { legacy?: CommandTerminalPanelGeometry | null; minSize?: { width: number; height: number } } = {}) {
  return resolvePanelPlace({
    places,
    legacy: options.legacy ?? null,
    shape,
    area: AREA,
    minSize: options.minSize ?? ONE_MIN,
    defaultGeometry: DEFAULT_PLACE,
  });
}

describe('commandTerminalPanelShape', () => {
  it('tiles none or one terminal as one, two as two, and three and four as the same grid', () => {
    expect(commandTerminalPanelShape(0)).toBe('one');
    expect(commandTerminalPanelShape(1)).toBe('one');
    expect(commandTerminalPanelShape(2)).toBe('two');
    expect(commandTerminalPanelShape(3)).toBe('grid');
    expect(commandTerminalPanelShape(4)).toBe('grid');
  });
});

describe('resolvePanelPlace', () => {
  it('shows a shape its own place as saved, even under the minimum', () => {
    const own = place(0.1, 0.1, 0.2, 0.2);
    expect(resolve({ two: own }, 'two', { minSize: TWO_MIN })).toEqual({ geometry: own, source: 'own' });
  });

  it('gives three and four terminals one place', () => {
    const grid = place(0.05, 0.05, 0.9, 0.9);
    const places = { grid };
    expect(resolve(places, commandTerminalPanelShape(3)).geometry).toBe(grid);
    expect(resolve(places, commandTerminalPanelShape(4)).geometry).toBe(grid);
  });

  it('grows a shape with no place around the nearest saved shape center, and keeps that center', () => {
    const one = place(0.3, 0.2, 0.45, 0.6);
    const resolved = resolve({ one }, 'two', { minSize: TWO_MIN });
    expect(resolved.source).toBe('nearest');
    expect(resolved.geometry.w * AREA.width).toBeCloseTo(TWO_MIN.width, 6);
    expect(resolved.geometry.h).toBeCloseTo(one.h, 10);
    expect(centerOf(resolved.geometry).x).toBeCloseTo(centerOf(one).x, 6);
    expect(centerOf(resolved.geometry).y).toBeCloseTo(centerOf(one).y, 6);
  });

  it('prefers another shape the user placed over the single place from before shapes', () => {
    // After an update, the user moves the one-terminal panel and adds a terminal: the panel
    // grows where they put it, not back at the place from before the update.
    const legacy = place(0.0, 0.0, 0.8, 0.8);
    const one = place(0.5, 0.3, 0.3, 0.4);
    const resolved = resolve({ one }, 'two', { legacy, minSize: TWO_MIN });
    expect(resolved.source).toBe('nearest');
    expect(centerOf(resolved.geometry).y).toBeCloseTo(centerOf(one).y, 6);
  });

  it('takes the smaller shape on a tie, so two terminals grow from one rather than shrink from the grid', () => {
    const one = place(0.1, 0.1, 0.3, 0.3);
    const grid = place(0.0, 0.0, 1, 1);
    const resolved = resolve({ one, grid }, 'two', { minSize: TWO_MIN });
    expect(centerOf(resolved.geometry).y).toBeCloseTo(centerOf(one).y, 6);
    expect(resolved.geometry.h).toBeCloseTo(one.h, 10);
  });

  it('falls back to the single place from before shapes, unmoved where it already fits (no panel moves on update)', () => {
    const legacy = place(0.1, 0.12, 0.85, 0.7, true);
    expect(resolve({}, 'one', { legacy })).toEqual({ geometry: legacy, source: 'legacy' });
    expect(resolve({}, 'two', { legacy, minSize: TWO_MIN })).toEqual({ geometry: legacy, source: 'legacy' });
  });

  it('starts from the default when nothing was ever saved', () => {
    expect(resolve({}, 'one')).toEqual({ geometry: DEFAULT_PLACE, source: 'default' });
    const two = resolve({}, 'two', { minSize: TWO_MIN });
    expect(two.source).toBe('default');
    expect(centerOf(two.geometry).x).toBeCloseTo(centerOf(DEFAULT_PLACE).x, 6);
  });

  it('grows a shape from a larger saved shape when no smaller one is saved', () => {
    const grid = place(0.2, 0.2, 0.3, 0.3);
    const fromGridForTwo = resolve({ grid }, 'two', { minSize: TWO_MIN });
    expect(fromGridForTwo.source).toBe('nearest');
    expect(fromGridForTwo.geometry.w * AREA.width).toBeCloseTo(TWO_MIN.width, 6);
    expect(centerOf(fromGridForTwo.geometry).y).toBeCloseTo(centerOf(grid).y, 6);
    // The grid is two steps from one, and still the nearest saved shape.
    const fromGridForOne = resolve({ grid }, 'one', { minSize: ONE_MIN });
    expect(fromGridForOne.source).toBe('nearest');
    expect(fromGridForOne.geometry.w * AREA.width).toBeCloseTo(ONE_MIN.width, 6);
    expect(centerOf(fromGridForOne.geometry).x).toBeCloseTo(centerOf(grid).x, 6);
    expect(centerOf(fromGridForOne.geometry).y).toBeCloseTo(centerOf(grid).y, 6);
  });

  it('shows the grid the two-terminal place grown to the grid minimum when only two is saved', () => {
    const two = place(0.3, 0.4, 0.2, 0.2);
    const resolved = resolve({ two }, 'grid', { minSize: TWO_MIN });
    expect(resolved.source).toBe('nearest');
    expect(resolved.geometry.w * AREA.width).toBeCloseTo(TWO_MIN.width, 6);
    expect(centerOf(resolved.geometry).y).toBeCloseTo(centerOf(two).y, 6);
  });

  it('takes the nearer saved shape: two beats one for the grid, and an own place stays own', () => {
    const one = place(0.0, 0.0, 0.1, 0.1);
    const two = place(0.5, 0.6, 0.1, 0.1);
    const grid = place(0.4, 0.4, 0.2, 0.2);
    const resolved = resolve({ one, two }, 'grid', { minSize: TWO_MIN });
    expect(resolved.source).toBe('nearest');
    expect(centerOf(resolved.geometry).y).toBeCloseTo(centerOf(two).y, 6);
    expect(resolve({ one, grid }, 'grid')).toEqual({ geometry: grid, source: 'own' });
  });

  it('treats a legacy place with a non-finite or missing field as no legacy place', () => {
    const notANumber = { x: Number.NaN, y: 0, w: 1, h: 1, maximized: false } as unknown as CommandTerminalPanelGeometry;
    const missingHeight = { x: 0, y: 0, w: 1, maximized: false } as unknown as CommandTerminalPanelGeometry;
    expect(resolve({}, 'one', { legacy: notANumber }).source).toBe('default');
    expect(resolve({}, 'one', { legacy: missingHeight }).source).toBe('default');
  });

  it('keeps maximized from the place it grew from', () => {
    const one = place(0.3, 0.3, 0.2, 0.2, true);
    expect(resolve({ one }, 'two', { minSize: TWO_MIN }).geometry.maximized).toBe(true);
  });
});

describe('growPlaceAroundCenter', () => {
  it('moves a box whose center sits near an edge only as far as it takes to stay inside the area', () => {
    const nearRight = place(0.8, 0.4, 0.18, 0.2);
    const grown = growPlaceAroundCenter(nearRight, AREA, TWO_MIN);
    expect((grown.x + grown.w) * AREA.width).toBeCloseTo(AREA.width, 6);
    expect(grown.w * AREA.width).toBeCloseTo(TWO_MIN.width, 6);
    expect(grown.x).toBeGreaterThanOrEqual(0);
  });

  it('returns the base unchanged when the area has no size yet', () => {
    const base = place(0.4, 0.4, 0.2, 0.2);
    expect(growPlaceAroundCenter(base, { width: 0, height: 0 }, TWO_MIN)).toBe(base);
    expect(growPlaceAroundCenter(base, { width: 2000, height: 0 }, TWO_MIN)).toBe(base);
    expect(growPlaceAroundCenter(base, { width: 0, height: 1000 }, TWO_MIN)).toBe(base);
  });

  it('keeps a box whose center sits near the bottom or top edge inside the area', () => {
    const tallMin = { width: 100, height: 500 };
    const nearBottom = growPlaceAroundCenter(place(0.4, 0.85, 0.2, 0.1), AREA, tallMin);
    expect((nearBottom.y + nearBottom.h) * AREA.height).toBeCloseTo(AREA.height, 6);
    expect(nearBottom.h * AREA.height).toBeCloseTo(tallMin.height, 6);
    expect(nearBottom.y).toBeGreaterThanOrEqual(0);
    const nearTop = growPlaceAroundCenter(place(0.4, 0.0, 0.2, 0.1), AREA, tallMin);
    expect(nearTop.y).toBe(0);
    expect(nearTop.h * AREA.height).toBeCloseTo(tallMin.height, 6);
  });

  it('gives the whole area to a minimum the area cannot hold', () => {
    const grown = growPlaceAroundCenter(place(0.4, 0.4, 0.2, 0.2), { width: 1000, height: 600 }, TWO_MIN);
    expect(grown.x).toBe(0);
    expect(grown.w).toBe(1);
  });
});

describe('readPanelPlaces', () => {
  it('keeps only usable places under the shapes the panel knows', () => {
    const one = place(0.1, 0.1, 0.5, 0.5);
    const raw = { one, two: { x: 'left', y: 0, w: 1, h: 1 }, grid: null, three: one };
    expect(readPanelPlaces(raw)).toEqual({ one });
    expect(readPanelPlaces(null)).toEqual({});
    expect(readPanelPlaces([one])).toEqual({});
    expect(readPanelPlaces('one')).toEqual({});
  });

  it('drops a place with a non-finite or missing number', () => {
    const good = place(0.1, 0.1, 0.5, 0.5);
    const raw = {
      one: { x: 0, y: 0, w: 1 },
      two: { x: Number.NaN, y: 0, w: 1, h: 1, maximized: false },
      grid: { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 1, maximized: false },
    };
    expect(readPanelPlaces(raw)).toEqual({});
    expect(readPanelPlaces({ ...raw, two: good })).toEqual({ two: good });
  });

  it('keeps a place whose maximized flag is missing, as saved', () => {
    const withoutMaximized = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    expect(readPanelPlaces({ one: withoutMaximized })).toEqual({ one: withoutMaximized });
  });
});
