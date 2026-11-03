/**
 * The Command Terminal panel's place, one per grid shape: one terminal, two
 * side by side, and three or four in two columns by two rows. Three and four
 * share a place because they share the grid's minimum, so going from three to
 * four never moves the panel. Places are global, like the panel itself: every
 * project showing the same shape shows the same place, and stopping a terminal
 * brings the smaller shape's place back.
 *
 * Expand never switches places: the shape comes from how many terminals the
 * panel tiles, not how many are on screen.
 *
 * Fractions of the area between the title bar and the status bar, as the
 * panel saves them (`AppConfig.commandTerminalPanelByShape`).
 */

import type { CommandTerminalPanelGeometry, CommandTerminalPanelPlaces, CommandTerminalPanelShape } from './types';

/** The shapes in order of size; the nearest saved shape is found along it. */
const COMMAND_TERMINAL_PANEL_SHAPES: readonly CommandTerminalPanelShape[] = ['one', 'two', 'grid'];

/** A width and height in pixels. */
export interface PanelAreaSize {
  width: number;
  height: number;
}

/** The shape the panel tiles `terminalCount` terminals in. */
export function commandTerminalPanelShape(terminalCount: number): CommandTerminalPanelShape {
  if (terminalCount >= 3) return 'grid';
  if (terminalCount === 2) return 'two';
  return 'one';
}

/**
 * A saved place whose numbers can be laid out. config.json is the user's to
 * edit, and a place with a missing or non-numeric field would size the panel to
 * NaN and leave it nowhere on screen.
 */
function isUsablePanelGeometry(geometry: unknown): geometry is CommandTerminalPanelGeometry {
  if (!geometry || typeof geometry !== 'object') return false;
  const candidate = geometry as Record<string, unknown>;
  return [candidate.x, candidate.y, candidate.w, candidate.h].every((value) => typeof value === 'number' && Number.isFinite(value));
}

/** The usable places in a saved value, under the shapes the panel knows. Anything else is dropped. */
export function readPanelPlaces(raw: unknown): CommandTerminalPanelPlaces {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const saved = raw as Record<string, unknown>;
  const places: CommandTerminalPanelPlaces = {};
  for (const shape of COMMAND_TERMINAL_PANEL_SHAPES) {
    const entry = saved[shape];
    if (isUsablePanelGeometry(entry)) places[shape] = entry;
  }
  return places;
}

/**
 * `base` grown around its center to at least `minSize`, never past the area,
 * and moved only as far as it takes to stay inside it. A place that already
 * holds the minimum comes back as it is, so a fallback that fits moves nothing.
 * Its `maximized` is kept: a terminal added to a maximized panel leaves it
 * maximized.
 */
export function growPlaceAroundCenter(
  base: CommandTerminalPanelGeometry,
  area: PanelAreaSize,
  minSize: PanelAreaSize,
): CommandTerminalPanelGeometry {
  if (area.width <= 0 || area.height <= 0) return base;
  const baseWidth = base.w * area.width;
  const baseHeight = base.h * area.height;
  if (baseWidth >= minSize.width && baseHeight >= minSize.height) return base;
  const width = Math.min(area.width, Math.max(baseWidth, minSize.width));
  const height = Math.min(area.height, Math.max(baseHeight, minSize.height));
  const centerX = (base.x + base.w / 2) * area.width;
  const centerY = (base.y + base.h / 2) * area.height;
  const left = Math.min(Math.max(0, centerX - width / 2), area.width - width);
  const top = Math.min(Math.max(0, centerY - height / 2), area.height - height);
  return {
    x: left / area.width,
    y: top / area.height,
    w: width / area.width,
    h: height / area.height,
    maximized: base.maximized === true,
  };
}

/** Where a resolved place came from: its own entry, another shape's, the single place from before shapes, or the default. */
export type PanelPlaceSource = 'own' | 'nearest' | 'legacy' | 'default';

export interface ResolvedPanelPlace {
  geometry: CommandTerminalPanelGeometry;
  source: PanelPlaceSource;
}

/** The saved shape nearest `shape` along the size order, the smaller one on a tie, or null. */
function nearestSavedShape(places: CommandTerminalPanelPlaces, shape: CommandTerminalPanelShape): CommandTerminalPanelShape | null {
  const index = COMMAND_TERMINAL_PANEL_SHAPES.indexOf(shape);
  for (let distance = 1; distance < COMMAND_TERMINAL_PANEL_SHAPES.length; distance += 1) {
    const smaller = COMMAND_TERMINAL_PANEL_SHAPES[index - distance];
    if (smaller && places[smaller]) return smaller;
    const larger = COMMAND_TERMINAL_PANEL_SHAPES[index + distance];
    if (larger && places[larger]) return larger;
  }
  return null;
}

/**
 * The place the panel shows for `shape`: its own saved place as it is, else the
 * nearest saved shape's, else the single place saved before places were kept
 * per shape, else `defaultGeometry`. Every place but its own is grown around its
 * center to `minSize`, the shape's grid at the floor beside the rail, and kept
 * inside the area.
 *
 * The nearest saved shape outranks the old single place: a user who moves the
 * one-terminal panel after updating and then adds a terminal sees the panel
 * grow where they put it, not jump back to where it sat before the update.
 */
export function resolvePanelPlace(input: {
  places: CommandTerminalPanelPlaces;
  legacy: CommandTerminalPanelGeometry | null | undefined;
  shape: CommandTerminalPanelShape;
  area: PanelAreaSize;
  minSize: PanelAreaSize;
  defaultGeometry: CommandTerminalPanelGeometry;
}): ResolvedPanelPlace {
  const own = input.places[input.shape];
  if (own) return { geometry: own, source: 'own' };
  const nearest = nearestSavedShape(input.places, input.shape);
  const nearestPlace = nearest ? input.places[nearest] : undefined;
  if (nearestPlace) return { geometry: growPlaceAroundCenter(nearestPlace, input.area, input.minSize), source: 'nearest' };
  if (isUsablePanelGeometry(input.legacy)) {
    return { geometry: growPlaceAroundCenter(input.legacy, input.area, input.minSize), source: 'legacy' };
  }
  return { geometry: growPlaceAroundCenter(input.defaultGeometry, input.area, input.minSize), source: 'default' };
}
