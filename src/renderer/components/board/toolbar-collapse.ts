/**
 * Where the board toolbar's controls drop their text labels as the row narrows.
 *
 * The app's floor is `minWidth: 900` (src/main/index.ts) and nothing clamps the
 * sidebar to the window (`useSidebarResize.ts` clamps only to [200, 400]), so at
 * the floor with a saved 400px sidebar the toolbar row gets
 * `900 - 400 - 1 (border) - 4 (resize handle) = 495px`. Its intrinsic width with
 * every label showing is about 975px on the board branch and 1100 on the backlog
 * branch in English, and more in German or Russian, so the row has to give up
 * half its width or more and still leave a usable search field.
 *
 * The ladder, widest to floor:
 *
 *   step 0       everything at full, search up to its 21rem cap
 *   step 1       Labels, Priorities, Filter and Import Tasks go icon-only
 *   step 2       Board / Backlog / Workflows go icon-only, keeping their counts
 *   step 3       Add column / New Task go icon-only, and the two dividers
 *                become gaps
 *
 * Nothing is hidden and nothing moves: an icon-only control is the same button in
 * the same place opening the same popover, with its text in a tooltip and its
 * `aria-label`. That is why there is no overflow menu here. The tooltip shows only
 * while the label is hidden (`filtersCollapsed`, `switcherCollapsed`,
 * `primaryCollapsed`): with the label showing it would only repeat it.
 *
 * ## The row picks its step by measuring
 *
 * The search is the only child that flexes, and it has a max but no min, so it
 * absorbs every pixel the row is short until it is a slot rather than a field.
 * Nothing about that is visible in a "does the row clip" check: the row fits
 * perfectly the whole way down. So each step fires where the step before it would
 * leave the search less than `TOOLBAR_SEARCH_ROOM_PX`.
 *
 * Where that happens depends on how wide the labels are, and that depends on the
 * language. The ladder used to be container queries at fixed widths, measured on
 * the English labels. In German, Russian or Hungarian the same widths left the
 * search 44px across between two steps. So `useToolbarCollapseStep` measures
 * instead, as `Tabs.tsx` does for its own row: it tries each step on the row,
 * reads what everything but the search takes (the search held at zero width for
 * the read, the whole pass inside one layout with no paint between), and keeps
 * the four widths. A resize then only picks the least collapsed step whose width
 * plus the room fits; a label, a count or the view changing measures again.
 * `chooseCollapseStep` is that choice, and it is pure.
 *
 * The room is what the fixed English widths left the search on the spec's seeded
 * row (three backlog items and one workflow): about 151 to 154px at the first two
 * steps and 168 at the last, so in English the first two steps land within a few
 * pixels of those widths and the last fires about 16px narrower.
 * `toolbar-narrow-window.spec.ts` sweeps the row and holds the search to its floor
 * at every width.
 *
 * At the absolute floor (495px, a 400px sidebar at a 900px window, 463px of
 * content) the backlog search is at its narrowest with both counts showing,
 * about 118px in English. A 1000+ item backlog keeps all four digits there and
 * leaves the search about 105px. That is a decision, not an oversight.
 * Shortening the count to "1.2k" at that one step would hide the number the pill
 * exists to show. The spec holds that case to its own, lower bound.
 *
 * Every class string below is a COMPLETE literal. Tailwind scans source text for
 * class candidates, so a variant composed from a variable at a call site would
 * never be generated. Each one keys off an attribute the hook's step sets on the
 * row (`group/toolbar`), so the base classes are the full state and each variant
 * is the collapsed one.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The toolbar row's classes. `group/toolbar` is what the collapse variants below
 * resolve against.
 *
 * `@container` is not there for container queries any more (no class here uses
 * one). Its inline-size containment keeps the row's width independent of its
 * content, so trying a step during the measurement cannot change the width the
 * step is chosen for. It also makes the row a stacking context and the containing
 * block for its in-flow popovers, which `toolbar-narrow-window.spec.ts` checks
 * still open over the board.
 */
export const TOOLBAR_ROW_CLASS = '@container group/toolbar';

/** The ladder's four steps, 0 (everything at full) to 3 (everything icon-only). */
export const TOOLBAR_COLLAPSE_STEP_COUNT = 4;

/**
 * The narrowest the search may get before the next step fires: roughly eleven
 * characters, which a one-to-three word board query lives in, plus the slack the
 * fixed English widths left it.
 */
export const TOOLBAR_SEARCH_ROOM_PX = 152;

/** Marks the search field's box, the one child the measurement holds at zero width. */
export const TOOLBAR_SEARCH_ATTRIBUTE = 'data-toolbar-search';

/** The row's step as React rendered it, which a measurement puts back when it ends. */
const COLLAPSE_STEP_ATTRIBUTE = 'data-collapse-step';

/**
 * The least collapsed step whose fixed width plus the search's room fits the
 * row's content width, or the last step when none does. `costs[step]` is what
 * everything but the search takes at that step.
 */
export function chooseCollapseStep(
  costs: readonly number[],
  available: number,
  searchRoom: number = TOOLBAR_SEARCH_ROOM_PX,
): number {
  for (let step = 0; step < costs.length; step += 1) {
    if (costs[step] + searchRoom <= available) return step;
  }
  return Math.max(0, costs.length - 1);
}

/** Whether Labels, Priorities, Filter and Import Tasks are icon-only at `step`. */
export function filtersCollapsed(step: number): boolean {
  return step >= 1;
}

/** Whether the Board / Backlog / Workflows switcher is icon-only at `step`. */
export function switcherCollapsed(step: number): boolean {
  return step >= 2;
}

/** Whether Add column / New Task are icon-only at `step`. */
export function primaryCollapsed(step: number): boolean {
  return step >= 3;
}

/**
 * The row's attributes for one step: the step itself, and one presence attribute
 * per rung that has collapsed, which the classes below key off.
 */
export function collapseStepAttributes(step: number): Record<`data-${string}`, string | undefined> {
  return {
    [COLLAPSE_STEP_ATTRIBUTE]: String(step),
    'data-collapse-filters': filtersCollapsed(step) ? '' : undefined,
    'data-collapse-switcher': switcherCollapsed(step) ? '' : undefined,
    'data-collapse-primary': primaryCollapsed(step) ? '' : undefined,
  };
}

function applyStepAttributes(row: HTMLElement, step: number): void {
  for (const [name, value] of Object.entries(collapseStepAttributes(step))) {
    if (value === undefined) row.removeAttribute(name);
    else row.setAttribute(name, value);
  }
}

function horizontalPadding(element: HTMLElement): { left: number; right: number } {
  const style = getComputedStyle(element);
  return { left: parseFloat(style.paddingLeft) || 0, right: parseFloat(style.paddingRight) || 0 };
}

/**
 * What everything but the search takes at each step, read on the row as it is
 * rendered. The search box is held at zero width and its group at its content
 * size, so the controls pack from the left and the last one's right edge is the
 * width the step needs. Every write is undone before this returns.
 */
function measureStepCosts(row: HTMLElement): number[] {
  const search = row.querySelector<HTMLElement>(`[${TOOLBAR_SEARCH_ATTRIBUTE}]`);
  const searchGroup = search?.parentElement ?? null;
  const contentLeft = row.getBoundingClientRect().left + horizontalPadding(row).left;
  const costs: number[] = [];
  if (search) search.style.flex = '0 0 0px';
  if (searchGroup && searchGroup !== row) searchGroup.style.flex = 'none';
  try {
    for (let step = 0; step < TOOLBAR_COLLAPSE_STEP_COUNT; step += 1) {
      applyStepAttributes(row, step);
      const last = row.lastElementChild as HTMLElement | null;
      if (!last) {
        costs.push(0);
        continue;
      }
      const marginRight = parseFloat(getComputedStyle(last).marginRight) || 0;
      costs.push(Math.ceil(last.getBoundingClientRect().right + marginRight - contentLeft));
    }
  } finally {
    if (search) search.style.flex = '';
    if (searchGroup && searchGroup !== row) searchGroup.style.flex = '';
  }
  return costs;
}

/**
 * The ladder step for the toolbar row `rowRef` points at. Render the row with
 * `collapseStepAttributes(step)` and `TOOLBAR_ROW_CLASS`.
 *
 * It measures on mount and whenever the row's content changes (a label, a count,
 * the view), and picks a step again whenever the row resizes. The step React
 * rendered is put back on the row after every measurement, so the attributes stay
 * React's.
 */
export function useToolbarCollapseStep(rowRef: RefObject<HTMLElement | null>): number {
  const [step, setStep] = useState(0);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let costs: number[] | null = null;

    const choose = (): void => {
      if (!costs) return;
      const padding = horizontalPadding(row);
      setStep(chooseCollapseStep(costs, row.clientWidth - padding.left - padding.right));
    };
    const measure = (): void => {
      const rendered = Number(row.getAttribute(COLLAPSE_STEP_ATTRIBUTE) ?? '0');
      try {
        costs = measureStepCosts(row);
      } finally {
        applyStepAttributes(row, rendered);
      }
      choose();
    };

    measure();
    const resizeObserver = new ResizeObserver(choose);
    resizeObserver.observe(row);
    // Content only: the attributes a step sets are not watched, so a measurement
    // never triggers another.
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(row, { childList: true, characterData: true, subtree: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [rowRef]);

  return step;
}

/**
 * The pair of classes a collapsible toolbar control needs: one for the button
 * (square once collapsed, its own padding before) and one for the label span. A
 * control that receives no pair renders at full width always, which is what
 * `ImportPopover`'s second mount site in `BacklogView`'s empty state wants.
 */
export interface ToolbarControlCollapse {
  button: string;
  label: string;
  /**
   * The button's classes while it carries a count pill after its label, in
   * place of `button`. Only the Filter button has one (its active-filter
   * count). The icon-only square is a fixed 36px, and the icon, its gap and an
   * 18px pill do not fit in it, so the button sizes to its content instead,
   * keeping the 34px height the row is built on. At the floor that costs the
   * search about 18px while a filter is active.
   */
  buttonWithCount?: string;
}

/** Everything one branch of the toolbar needs to run the ladder. */
export interface ToolbarCollapseClasses {
  /** Labels, Priorities, Filter, and Import Tasks. Collapse at step 1. */
  filterControl: ToolbarControlCollapse;
  /** Board / Backlog / Workflows. Collapse at step 2. */
  viewSwitcherLabel: string;
  /**
   * The switcher's icon, which REPLACES the label rather than joining it, so it
   * shows only once the label goes. Its `h-5` restores the 20px content height
   * the label's line box had, so the option keeps the padding-derived 34px the
   * rest of the row is built on once the text goes. Without it the content is
   * the 16px glyph, the option derives 30px instead, and the row reads ragged.
   */
  viewSwitcherIcon: string;
  /**
   * The switcher's option padding and gap, on the same step as its label: 12px a
   * side around a word, 4px around an icon alone (the control's own `tight`
   * value), with 2px before a count pill or mark instead of 6. The three
   * icon-only options and the two counts gave back 44px when measured, which at
   * the floor is the difference between a backlog search field and a slot.
   */
  viewSwitcherSpacing: string;
  /** Add column, or New Task. Last to give, at step 3: a primary action's word is worth most. */
  primaryAction: ToolbarControlCollapse;
  /**
   * The two group dividers. At step 3 they become 8px of gap instead of a rule:
   * with every control already an icon they are the only pixels left on the row
   * carrying no function, and the 26px they give back is the difference between
   * a backlog search field you can read and a slot you cannot.
   */
  divider: string;
}

/** The board and Workflows branches. Workflows has no primary action, so step 3 only turns its dividers into gaps. */
export const TOOLBAR_COLLAPSE: ToolbarCollapseClasses = {
  filterControl: {
    button: 'shrink-0 justify-center px-3 group-data-[collapse-filters]/toolbar:w-9 group-data-[collapse-filters]/toolbar:h-[34px] group-data-[collapse-filters]/toolbar:px-0',
    label: 'group-data-[collapse-filters]/toolbar:hidden',
    buttonWithCount: 'shrink-0 justify-center px-3 group-data-[collapse-filters]/toolbar:h-[34px] group-data-[collapse-filters]/toolbar:px-2',
  },
  viewSwitcherLabel: 'group-data-[collapse-switcher]/toolbar:hidden',
  viewSwitcherIcon: 'hidden items-center h-5 group-data-[collapse-switcher]/toolbar:flex',
  viewSwitcherSpacing: 'px-3 gap-1.5 group-data-[collapse-switcher]/toolbar:px-1 group-data-[collapse-switcher]/toolbar:gap-0.5',
  primaryAction: {
    button: 'shrink-0 justify-center px-3 group-data-[collapse-primary]/toolbar:w-9 group-data-[collapse-primary]/toolbar:h-[34px] group-data-[collapse-primary]/toolbar:px-0',
    label: 'group-data-[collapse-primary]/toolbar:hidden',
  },
  divider: 'h-5 shrink-0 w-px mx-2.5 bg-edge/50 group-data-[collapse-primary]/toolbar:w-0 group-data-[collapse-primary]/toolbar:mx-1 group-data-[collapse-primary]/toolbar:bg-transparent',
};

/** The backlog branch: the same ladder, with New Task keeping its own wider padding before it collapses. */
export const BACKLOG_TOOLBAR_COLLAPSE: ToolbarCollapseClasses = {
  ...TOOLBAR_COLLAPSE,
  primaryAction: {
    button: 'shrink-0 justify-center px-4 group-data-[collapse-primary]/toolbar:w-9 group-data-[collapse-primary]/toolbar:h-[34px] group-data-[collapse-primary]/toolbar:px-0',
    label: 'group-data-[collapse-primary]/toolbar:hidden',
  },
};
