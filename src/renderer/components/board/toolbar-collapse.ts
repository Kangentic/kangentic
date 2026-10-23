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
 * in), and the branches reach that at genuinely different widths: backlog
 * carries two actions where board carries one, New Task is wider than Add
 * column, and Workflows has none. Measured fixed cost of everything that is not
 * the search, in the row's content box (what the container query reads), with
 * the three-view switcher and the Backlog count badge showing:
 *
 *   state              board   backlog   workflows
 *   full                 708       827         576
 *   after step 1         555       587         423
 *   after step 2         411       444         280
 *   after step 3         298       342           -
 *
 * Add 140, plus 26 for the count badge the Workflows segment carried when these
 * were measured, and round up, and you get the thresholds below. The Workflows
 * segment now carries one 18px slot: its count pill at rest, or the 16px working
 * mark in the pill's place while a workflow runs, never both. With its gap that
 * is 20px to 24px, so the thresholds keep their slack. The Backlog pill grew
 * about 2px over the 20px circle it replaced at two digits. Workflows has no
 * step 3: its dividers are the last thing to give, and they hold down to the
 * floor. Sharing one set would mean using the backlog's, which collapses the
 * board's filter labels about 120px of window earlier than it needs to.
 *
 * At the absolute floor (495px, a 400px sidebar at a 900px window, 463px of
 * content) the backlog search is at its narrowest with both counts showing:
 * 117.5px with a 21-item backlog, 119.5px with the mark in the count's place.
 * `toolbar-narrow-window.spec.ts` seeds both counts and holds it to its floor.
 * A 1000+ item backlog keeps all four digits there and leaves the search 105px.
 * That is a decision, not an oversight. Shortening the count to "1.2k" at that
 * one step would hide the number the pill exists to show. The spec holds that
 * case to its own, lower bound.
 * There is nothing left to give there; that is the width the dividers turn into
 * gaps, and the switcher's options tighten, to claw back for.
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
  /**
   * The button's classes while it carries a count pill after its label, in
   * place of `button`. Only the Filter button has one (its active-filter
   * count). The icon-only square is a fixed 36px, and the icon, its gap and an
   * 18px pill do not fit in it, so the button sizes to its content instead,
   * keeping the 34px height the row is built on. At the floor that costs the
   * search about 18px while a filter is active, which the old overlay on the
   * button's corner did not.
   */
  buttonWithCount?: string;
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
  /**
   * The switcher's option padding and gap, on the same query as its label:
   * 12px a side around a word, 4px around an icon alone (the control's own
   * `tight` value), with 2px before a count pill or mark instead of 6. The
   * three icon-only options and the two counts gave back 44px when measured,
   * which at the floor is the difference between a backlog search field and a
   * slot.
   */
  viewSwitcherSpacing: string;
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
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[880px]:w-auto @[880px]:h-auto @[880px]:px-3',
    label: 'hidden @[880px]:inline',
    buttonWithCount: 'h-[34px] shrink-0 justify-center px-2 @[880px]:h-auto @[880px]:px-3',
  },
  viewSwitcherLabel: 'hidden @[730px]:inline',
  viewSwitcherIcon: 'flex items-center h-5 @[730px]:hidden',
  viewSwitcherSpacing: 'px-1 gap-0.5 @[730px]:px-3 @[730px]:gap-1.5',
  primaryAction: {
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[580px]:w-auto @[580px]:h-auto @[580px]:px-3',
    label: 'hidden @[580px]:inline',
  },
  divider: 'h-5 shrink-0 w-0 mx-1 bg-transparent @[580px]:w-px @[580px]:mx-2.5 @[580px]:bg-edge/50',
};

export const BACKLOG_TOOLBAR_COLLAPSE: ToolbarCollapseClasses = {
  filterControl: {
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[1000px]:w-auto @[1000px]:h-auto @[1000px]:px-3',
    label: 'hidden @[1000px]:inline',
    buttonWithCount: 'h-[34px] shrink-0 justify-center px-2 @[1000px]:h-auto @[1000px]:px-3',
  },
  viewSwitcherLabel: 'hidden @[760px]:inline',
  viewSwitcherIcon: 'flex items-center h-5 @[760px]:hidden',
  viewSwitcherSpacing: 'px-1 gap-0.5 @[760px]:px-3 @[760px]:gap-1.5',
  primaryAction: {
    // `px-4`, not the board action's `px-3`: New Task keeps its own wider padding
    // above the threshold.
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[610px]:w-auto @[610px]:h-auto @[610px]:px-4',
    label: 'hidden @[610px]:inline',
  },
  divider: 'h-5 shrink-0 w-0 mx-1 bg-transparent @[610px]:w-px @[610px]:mx-2.5 @[610px]:bg-edge/50',
};

/**
 * The Workflows branch: the board's own search and filter (the view shares
 * them) and no primary action, since the view's actions live in its own
 * header. So the dividers are the last thing to give.
 */
export const WORKFLOWS_TOOLBAR_COLLAPSE: ToolbarCollapseClasses = {
  filterControl: {
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[750px]:w-auto @[750px]:h-auto @[750px]:px-3',
    label: 'hidden @[750px]:inline',
    buttonWithCount: 'h-[34px] shrink-0 justify-center px-2 @[750px]:h-auto @[750px]:px-3',
  },
  viewSwitcherLabel: 'hidden @[590px]:inline',
  viewSwitcherIcon: 'flex items-center h-5 @[590px]:hidden',
  viewSwitcherSpacing: 'px-1 gap-0.5 @[590px]:px-3 @[590px]:gap-1.5',
  // Unused: the view has no toolbar action. Kept so the branch has the same shape.
  primaryAction: {
    button: 'w-9 h-[34px] shrink-0 justify-center px-0 @[450px]:w-auto @[450px]:h-auto @[450px]:px-3',
    label: 'hidden @[450px]:inline',
  },
  divider: 'h-5 shrink-0 w-0 mx-1 bg-transparent @[450px]:w-px @[450px]:mx-2.5 @[450px]:bg-edge/50',
};
