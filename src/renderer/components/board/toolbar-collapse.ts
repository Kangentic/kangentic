/**
 * Where the board toolbar's controls drop their text labels as the row narrows.
 *
 * The app's floor is `minWidth: 900` (src/main/index.ts) and nothing clamps the
 * sidebar to the window (`useSidebarResize.ts` clamps only to [200, 400]), so at
 * the floor with a saved 400px sidebar the toolbar row gets
 * `900 - 400 - 1 (border) - 4 (resize handle) = 495px`. Its intrinsic width with
 * every label showing is 975px on the board branch and about 1100 on the backlog
 * branch, so the row has to give up roughly half its width and still leave a
 * usable search field.
 *
 * Driven by a CONTAINER query on the toolbar row rather than a viewport
 * breakpoint. The row's own box already has the sidebar subtracted, so the ladder
 * reads the space the row actually has and responds to a sidebar drag as well as
 * to a window resize. That is also the house pattern here (BoardManagerDialog,
 * MonitorBody, board-manager's form-layout); viewport breakpoints appear in three
 * stats files and nowhere else.
 *
 * The ladder, widest to floor:
 *
 *   full         everything at full, search at its 21rem cap
 *   step 1       Labels, Priorities, Filter and Import Tasks go icon-only
 *   step 2       Board / Backlog goes icon-only, keeping its count badge
 *   step 3       Add column / New Task go icon-only, and the two dividers
 *                become gaps
 *
 * Nothing is hidden and nothing moves: an icon-only control is the same button in
 * the same place opening the same popover, with its text turned into a tooltip.
 * That is why there is no overflow menu here and why `useHeaderPillOverflow` (the
 * task-detail and Command Terminal header's priority-plus measurement hook) is not
 * reused: it hard-codes that header's gaps, its four outer sections and a title
 * floor this row has no title for, and three discrete on/off steps need no
 * measurement pass.
 *
 * ## Why the two branches have different thresholds
 *
 * The search is the only child that flexes, and it has a max but no min, so it
 * absorbs every pixel the row is short until it is a slot rather than a field.
 * Nothing about that is visible in a "does the row clip" check: the row fits
 * perfectly the whole way down. Measured at the floor before these numbers were
 * set, the backlog search was 92px across at a collapsed sidebar with every label
 * still showing.
 *
 * So each step fires where the CURRENT state would push the search below about
 * 140px (roughly eleven characters, which a one-to-three word board query lives
 * in), and the two branches reach that at genuinely different widths: backlog
 * carries two actions where board carries one, and New Task is wider than Add
 * column. Measured fixed cost of everything that is not the search:
 *
 *   state              board   backlog
 *   full                 647       770
 *   after step 1         485       526
 *   after step 2         427       468
 *   after step 3         325       368
 *
 * Add 140 to each and round, and you get the thresholds below. Sharing one set
 * would mean using the backlog's, which collapses the board's filter labels about
 * 130px of window earlier than it needs to.
 *
 * At the absolute floor (495px, a 400px sidebar at a 900px window) the backlog
 * search lands at 127px, under the target. There is nothing left to give there;
 * that is the width the dividers turn into gaps to claw 26px back for.
 *
 * Every class string below is a COMPLETE literal. Tailwind scans source text for
 * class candidates, so a breakpoint composed from a variable at a call site would
 * never be generated.
 *
 * A collapsed control has no accessible name left, because `hidden` takes the
 * label out of the accessibility tree. Every call site therefore also carries
 * `aria-label` and `title`.
 */

/**
 * Marks the toolbar row as the container the classes below resolve against.
 *
 * Deliberately UNNAMED. There is no other `@container` between this row and any
 * of its controls, so the nearest container ancestor already is the row, and the
 * unnamed form is the one the rest of the codebase already compiles. If a nested
 * `@container` is ever introduced inside this row, these variants start resolving
 * against it instead, so that is a conscious break to make rather than a silent
 * one.
 */
export const TOOLBAR_ROW_CONTAINER_CLASS = '@container';

/**
 * The pair of classes a collapsible toolbar control needs: one for the button
 * (square below the threshold, its own padding above it) and one for the label
 * span. A control that receives no pair renders at full width always, which is
 * what `ImportPopover`'s second mount site in `BacklogView`'s empty state wants.
 */
export interface ToolbarControlCollapse {
  button: string;
  label: string;
}

/** Everything one branch of the toolbar needs to run the ladder. */
export interface ToolbarCollapseClasses {
  /** Labels, Priorities, Filter, and Import Tasks. */
  filterControl: ToolbarControlCollapse;
  /** Board / Backlog. */
  viewSwitcherLabel: string;
  /**
   * The switcher's icon, which REPLACES the label rather than joining it, so it
   * carries the inverse query. Its `h-5` restores the 20px content height the
   * label's line box had, so the option keeps the padding-derived 34px the rest
   * of the row is built on once the text goes. Without it the content is the
   * 16px glyph, the option derives 30px instead, and the row reads ragged.
   */
  viewSwitcherIcon: string;
  /** Add column, or New Task. Last to give: a primary action's word is worth most. */
  primaryAction: ToolbarControlCollapse;
  /**
   * The two group dividers. At the last step they become 8px of gap instead of a
   * rule: with every control already an icon they are the only pixels left on the
   * row carrying no function, and the 26px they give back is the difference
   * between a backlog search field you can read and a slot you cannot.
   */
  divider: string;
}

export const BOARD_TOOLBAR_COLLAPSE: ToolbarCollapseClasses = {
  filterControl: {
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[790px]:w-auto @[790px]:h-auto @[790px]:px-3',
    label: 'hidden @[790px]:inline',
  },
  viewSwitcherLabel: 'hidden @[630px]:inline',
  viewSwitcherIcon: 'flex items-center h-5 @[630px]:hidden',
  primaryAction: {
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[570px]:w-auto @[570px]:h-auto @[570px]:px-3',
    label: 'hidden @[570px]:inline',
  },
  divider: 'h-5 shrink-0 w-0 mx-1 bg-transparent @[570px]:w-px @[570px]:mx-2.5 @[570px]:bg-edge/50',
};

export const BACKLOG_TOOLBAR_COLLAPSE: ToolbarCollapseClasses = {
  filterControl: {
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[920px]:w-auto @[920px]:h-auto @[920px]:px-3',
    label: 'hidden @[920px]:inline',
  },
  viewSwitcherLabel: 'hidden @[670px]:inline',
  viewSwitcherIcon: 'flex items-center h-5 @[670px]:hidden',
  primaryAction: {
    // `px-4`, not the board action's `px-3`: New Task keeps its own wider padding
    // above the threshold.
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[610px]:w-auto @[610px]:h-auto @[610px]:px-4',
    label: 'hidden @[610px]:inline',
  },
  divider: 'h-5 shrink-0 w-0 mx-1 bg-transparent @[610px]:w-px @[610px]:mx-2.5 @[610px]:bg-edge/50',
};
