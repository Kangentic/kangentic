/**
 * The board toolbar's collapse ladder: which step the row takes for the widths it
 * measured, and the attributes that step puts on the row for the classes to key
 * off. The measurement itself needs a laid-out row, so the UI tier covers it
 * (`tests/ui/toolbar-narrow-window.spec.ts`, which sweeps the row in English and
 * in a longer language).
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import {
  TOOLBAR_COLLAPSE,
  TOOLBAR_COLLAPSE_STEP_COUNT,
  TOOLBAR_SEARCH_ROOM_PX,
  chooseCollapseStep,
  collapseStepAttributes,
} from '../../src/renderer/components/board/toolbar-collapse';

/** Fixed widths shaped like the board branch's in English, step 0 to 3 (illustrative, not measured here). */
const BOARD_COSTS = [728, 575, 431, 318];

describe('chooseCollapseStep', () => {
  it('keeps every label while the widest step still leaves the search its room', () => {
    expect(chooseCollapseStep(BOARD_COSTS, 1200)).toBe(0);
  });

  it('takes the least collapsed step that leaves the search its room', () => {
    expect(chooseCollapseStep(BOARD_COSTS, 800)).toBe(1);
    expect(chooseCollapseStep(BOARD_COSTS, 600)).toBe(2);
    expect(chooseCollapseStep(BOARD_COSTS, 500)).toBe(3);
  });

  it('fits a step whose width plus the room is exactly the row', () => {
    const exact = BOARD_COSTS[1] + TOOLBAR_SEARCH_ROOM_PX;
    expect(chooseCollapseStep(BOARD_COSTS, exact)).toBe(1);
    expect(chooseCollapseStep(BOARD_COSTS, exact - 1)).toBe(2);
  });

  it('takes the last step when not even it leaves the room, since there is nothing left to give', () => {
    expect(chooseCollapseStep(BOARD_COSTS, 300)).toBe(3);
    expect(chooseCollapseStep(BOARD_COSTS, 0)).toBe(3);
  });

  it('collapses earlier for a longer language, at the same row width', () => {
    // Longer labels are wider at every step, so the same 800px row that keeps the
    // switcher's words in English has to give them up.
    const russianCosts = [905, 690, 470, 340];
    expect(chooseCollapseStep(BOARD_COSTS, 800)).toBe(1);
    expect(chooseCollapseStep(russianCosts, 800)).toBe(2);
  });

  it('takes the room it is given', () => {
    expect(chooseCollapseStep(BOARD_COSTS, 800, 300)).toBe(2);
  });

  it('answers the first step for a row it could not measure', () => {
    expect(chooseCollapseStep([], 800)).toBe(0);
  });
});

describe('collapseStepAttributes', () => {
  it('marks each rung that has collapsed, and nothing at step 0', () => {
    expect(collapseStepAttributes(0)).toEqual({
      'data-collapse-step': '0',
      'data-collapse-filters': undefined,
      'data-collapse-switcher': undefined,
      'data-collapse-primary': undefined,
    });
    expect(collapseStepAttributes(2)).toEqual({
      'data-collapse-step': '2',
      'data-collapse-filters': '',
      'data-collapse-switcher': '',
      'data-collapse-primary': undefined,
    });
    expect(collapseStepAttributes(TOOLBAR_COLLAPSE_STEP_COUNT - 1)).toEqual({
      'data-collapse-step': '3',
      'data-collapse-filters': '',
      'data-collapse-switcher': '',
      'data-collapse-primary': '',
    });
  });

  it('names every attribute the collapse classes key off, so a renamed rung cannot leave a class keyed to nothing', () => {
    const classes = [
      TOOLBAR_COLLAPSE.filterControl.button,
      TOOLBAR_COLLAPSE.filterControl.label,
      TOOLBAR_COLLAPSE.filterControl.buttonWithCount ?? '',
      TOOLBAR_COLLAPSE.viewSwitcherLabel,
      TOOLBAR_COLLAPSE.viewSwitcherIcon,
      TOOLBAR_COLLAPSE.viewSwitcherSpacing,
      TOOLBAR_COLLAPSE.primaryAction.button,
      TOOLBAR_COLLAPSE.primaryAction.label,
      TOOLBAR_COLLAPSE.divider,
    ].join(' ');
    const keyed = new Set([...classes.matchAll(/group-data-\[([a-z-]+)\]\/toolbar:/g)].map((match) => `data-${match[1]}`));
    const set = new Set(Object.keys(collapseStepAttributes(TOOLBAR_COLLAPSE_STEP_COUNT - 1)));
    expect(keyed.size).toBeGreaterThan(0);
    for (const attribute of keyed) expect(set, `${attribute} is keyed by a class but never set`).toContain(attribute);
  });
});
