/**
 * UI tests for the persistent chrome rows at the app's own minimum window size.
 *
 * `src/main/index.ts` sets `minWidth: 900`, and nothing clamps the sidebar to the
 * window (`useSidebarResize.ts` clamps only to [200, 400]), so at the floor with a
 * saved 400px sidebar the board toolbar gets
 * `900 - 400 - 1 (border) - 4 (resize handle) = 495px` against an intrinsic row of
 * 975. Collapsed to the 36px strip it gets 859. Both are in scope here.
 *
 * Assertions are read inside `page.evaluate`, never through `boundingBox()` or
 * `toBeVisible()`: both ignore overflow clipping, so a geometry-only check passes
 * against a fully clipped row (see .claude/rules/popover-escapes-clipping.md).
 * They are also relative rather than absolute, per
 * .claude/rules/cross-platform-parity.md:
 *
 *   1. Row-height invariance. The same row, on the same machine, measured wide and
 *      then narrow. Any label that wraps to a second line grows the row, so this
 *      catches the reported defect with no font-metric dependence at all.
 *   2. Right-edge containment. Each control's right edge against the row's own
 *      content edge, rounded, with 1px of slack (the tolerance
 *      combobox-portal-clipping.spec.ts uses).
 *
 * Three shapes that look right and are not, so none of them is used here:
 *   - `offsetLeft + offsetWidth` mixes coordinate spaces. `offsetLeft` is relative
 *     to `offsetParent`, and the toolbar row is not positioned, so controls inside
 *     ToolbarSearchFilter's `relative` wrapper measure against that wrapper while
 *     the rest measure against <body>.
 *   - `getClientRects().length` cannot see wrapping. A label span inside a
 *     `display: flex` button is blockified and returns one rect however many lines
 *     its text takes, and three of these controls have a bare text node with no
 *     span to query.
 *   - `scrollWidth > clientWidth` is not a dependable overflow signal on a row with
 *     no `overflow` property.
 *
 * Sidebar WIDTH is seedable through the mock config; COLLAPSE is not (the hook's
 * `open` is a useState frozen at mount, see collapsed-rail.spec.ts), so the
 * collapsed cases click the sidebar's own hide button. Each test puts the sidebar
 * in its target state BEFORE the wide baseline measurement, so the only variable
 * between the two measurements is the viewport.
 *
 * The row picks its collapse step by measuring its own labels
 * (toolbar-collapse.ts), so the cases run in English and again in Russian, whose
 * labels ran longest when the layout pass measured de, ru and hu. The Russian
 * cases find everything by test id and never by its English name, and prove the
 * catalog loaded without naming a Russian string, so a reviewer's later
 * correction of a translation cannot break them.
 *
 * Each test launches and tears down its own browser, so the file fans out across
 * the UI workers safely.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'narrow-proj';
/** The shipped language whose toolbar labels ran longest. */
const LONG_LOCALE = 'ru';

/** The app's own floor, from `minWidth` / `minHeight` in src/main/index.ts. */
const FLOOR = { width: 900, height: 600 };
/** Wide enough that every control is at its natural size, for the baseline read. */
const WIDE = { width: 1600, height: 900 };

/**
 * A project long enough in the name to exercise the title bar, a full set of
 * swimlanes, labelled tasks so the Labels filter has content, backlog items so
 * the Backlog segment carries its count pill, and a workflow at rest so the
 * Workflows segment carries its count pill too. A running workflow would show
 * the 16px working mark in that pill's place instead, which is the narrower of
 * the two, so the row is measured at its widest.
 */
function seedScript(backlogCount: number, locale: string): string {
  return `
    window.__mockWorkflows = [{ workflow: { id: 'narrow-workflow', title: 'Narrow', state: 'draft', draft: null } }];
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      // The session's language, which the mock boots in.
      state.config.displayLanguage = ${JSON.stringify(locale)};
      state.config.hasAnsweredLanguageSuggestion = true;

      // The sidebar hook re-syncs this on load, but only inside its [200, 400]
      // clamp. 400 is its own DEFAULT_WIDTH and the worst case for the toolbar.
      state.config.sidebar = { width: 400 };
      state.config.sidebarVisible = true;

      state.projects.push({
        id: '${PROJECT_ID}',
        // Long on purpose. The title bar's centered name truncates against a
        // max-width of half the WINDOW, not against the space left between the two
        // icon clusters, so the overlap needs a name that actually reaches that
        // cap. That is the documented trigger: a long name, the (worktree) badge,
        // or the extra "New terminal" button.
        name: 'kangentic-platform-services-integration-workspace',
        path: '/mock/kangentic-platform-services-integration-workspace',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = 'narrow-lane-' + index;
        laneIds[swimlane.name] = id;
        state.swimlanes.push(Object.assign({}, swimlane, {
          id: id,
          position: index,
          created_at: ts,
        }));
      });

      ['authentication', 'telemetry', 'regression'].forEach(function (label, index) {
        state.tasks.push({
          id: 'narrow-task-' + index,
          title: 'Task ' + index,
          description: '',
          swimlane_id: laneIds['To Do'],
          position: index,
          agent: 'claude',
          session_id: null,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          pr_state: null,
          base_branch: null,
          use_worktree: 0,
          labels: [label],
          priority: index,
          attachment_count: 0,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });
      });

      for (var index = 0; index < ${backlogCount}; index += 1) {
        state.backlogTasks.push({
          id: 'narrow-backlog-' + index,
          title: 'Backlog item ' + index,
          description: '',
          priority: index,
          labels: ['telemetry'],
          position: index,
          assignee: null,
          due_date: null,
          item_type: null,
          external_id: null,
          external_source: null,
          external_url: null,
          sync_status: null,
          external_metadata: null,
          attachment_count: 0,
          created_at: ts,
          updated_at: ts,
        });
      }

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(backlogCount = 3, locale = 'en'): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: WIDE });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(backlogCount, locale));

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(locale);

  return { browser, page };
}

/** Collapse the sidebar to its 36px strip through the control that owns the state. */
async function collapseSidebar(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-collapse-button"]').click();
  await page.locator('[data-testid="sidebar-expand-button"]').waitFor({ state: 'attached', timeout: 5000 });
}

async function switchToBacklog(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * The seeded workflow has no tasks yet, so the view opens on an empty canvas.
 * Workflows folds the sidebar on the way in, which would leave this toolbar
 * 860px at the floor. Opening it there, as a user can, keeps these cases on the
 * 400px sidebar their names promise.
 */
async function switchToWorkflows(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-workflows"]').click();
  await page.locator('[data-testid="workflows-view"]').waitFor({ state: 'visible', timeout: 10000 });
  const sidebar = page.locator('[data-testid="sidebar-area"]');
  await expect(sidebar).toHaveAttribute('data-open', 'false');
  await page.locator('[data-testid="sidebar-expand-button"]').click();
  await expect(sidebar).toHaveAttribute('data-open', 'true');
  // Its width transition has run, so the row is measured beside the full 400px.
  await expect.poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBeGreaterThanOrEqual(400);
}

interface RowReading {
  height: number;
  /** Right edge of each control, and of the row's own content box, rounded. */
  rowContentRight: number;
  controls: Array<{ testId: string; right: number }>;
}

/**
 * One layout read of the toolbar row. Everything comes back as integers from a
 * single `page.evaluate`, so the comparison never crosses a coordinate space and
 * never depends on Playwright's clipping-blind geometry helpers.
 */
async function readRow(page: Page, controlTestIds: string[]): Promise<RowReading> {
  return page.evaluate((testIds) => {
    const row = document.querySelector('[data-testid="view-toggle"]');
    if (!row) throw new Error('board toolbar row not found');
    const rowRect = row.getBoundingClientRect();
    // The row's content edge: its border box minus its own `px-4`.
    const paddingRight = parseFloat(getComputedStyle(row).paddingRight) || 0;

    const controls = testIds.map((testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!element) throw new Error(`control not found: ${testId}`);
      return { testId, right: Math.round(element.getBoundingClientRect().right) };
    });

    return {
      height: rowRect.height,
      rowContentRight: Math.round(rowRect.right - paddingRight),
      controls,
    };
  }, controlTestIds);
}

/**
 * A coarse lower bound on the search field, not a pixel-exact one. The narrowest
 * the ladder produces is at the absolute floor on the backlog branch, where there
 * is nothing left to give; `toolbar-collapse.ts` derives that width and is the one
 * place it is written down. 110 leaves room for headless Linux's font metrics
 * while still failing the 92px squeeze this guards against.
 */
const SEARCH_FLOOR_PX = 110;

/**
 * The same bound for the one accepted exception, a four-digit backlog count at the
 * absolute floor, where the search measured 105px on Windows' fonts.
 */
const FOUR_DIGIT_SEARCH_FLOOR_PX = 100;

/**
 * The same bound for the second exception, an active filter at the absolute
 * floor. The Filter button sheds its label there, and the count pill after the
 * icon widens it about 18px, which the search gives up: 99.5px on Windows'
 * fonts. Held to its own floor, with the same room for headless Linux's metrics.
 */
const FILTERED_SEARCH_FLOOR_PX = 94;

/** The toolbar's OWN search field. The sidebar has one too, earlier in the document. */
async function readSearchWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const input = document.querySelector('[data-testid="view-toggle"] input[type="text"]');
    return input ? Math.round(input.getBoundingClientRect().width) : 0;
  });
}

/** Re-read until the row height stops moving, so no fixed wait is needed. */
async function settledHeight(page: Page): Promise<number> {
  let previous = -1;
  await expect.poll(async () => {
    const current = await page.evaluate(
      () => document.querySelector('[data-testid="view-toggle"]')!.getBoundingClientRect().height,
    );
    const stable = current === previous;
    previous = current;
    return stable;
  }, { timeout: 10000 }).toBe(true);
  return previous;
}

const BOARD_CONTROLS = [
  'view-toggle-group',
  'manage-labels-btn',
  'manage-priorities-btn',
  'board-search',
  'board-filter-btn',
  'add-column-button',
];

const BACKLOG_CONTROLS = [
  'view-toggle-group',
  'manage-labels-btn',
  'manage-priorities-btn',
  'backlog-search',
  'backlog-filter-btn',
  'new-backlog-task-btn',
  'import-sources-btn',
];

/** The Workflows view shares the board's search and filter and has no toolbar action. */
const WORKFLOWS_CONTROLS = [
  'view-toggle-group',
  'manage-labels-btn',
  'manage-priorities-btn',
  'board-search',
  'board-filter-btn',
];

/** Every label that must still be text at the wide baseline. */
const BOARD_LABELS = ['Board', 'Backlog', 'Workflows', 'Labels', 'Priorities', 'Filter', 'Add column'];
const BACKLOG_LABELS = ['Board', 'Backlog', 'Workflows', 'Labels', 'Priorities', 'Filter', 'New Task', 'Import Tasks'];
const WORKFLOWS_LABELS = ['Board', 'Backlog', 'Workflows', 'Labels', 'Priorities', 'Filter'];

/**
 * Every control in `controlTestIds` that carries a label (the inputs do not),
 * paired with its visible text, digits removed so a count pill alone does not
 * read as a label. The switcher stands for its three options.
 */
async function readControlLabels(page: Page, controlTestIds: string[]): Promise<Array<{ testId: string; text: string }>> {
  return page.evaluate((testIds) => {
    const expanded = testIds.flatMap((testId) => (
      testId === 'view-toggle-group' ? ['view-toggle-board', 'view-toggle-backlog', 'view-toggle-workflows'] : [testId]
    ));
    return expanded
      .map((testId) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`))
      .filter((element): element is HTMLElement => element !== null && element.tagName !== 'INPUT')
      .map((element) => ({ testId: element.getAttribute('data-testid') ?? '', text: element.innerText.replace(/\d+/g, '').trim() }));
  }, controlTestIds);
}

/**
 * The shared body of the toolbar cases: measure the row wide, narrow the
 * viewport to the app's floor with the sidebar untouched, and assert the row
 * neither grew nor pushed a control past its own content edge. `wideLabels` is
 * the English each control shows at full width, or `'translated'` for a session
 * in another language, where every control must show some label and none of
 * them the English.
 */
async function expectRowSurvivesTheFloor(
  page: Page,
  controlTestIds: string[],
  wideLabels: string[] | 'translated',
): Promise<void> {
  // Anti-vacuity, and the reason this is not optional. An icon-only row trivially
  // passes both assertions below, so a collapse step that never lets go (a
  // measurement that overshoots, a variant Tailwind never generated) would turn
  // this whole spec green against a toolbar that has permanently lost its text.
  // Assert the labels are actually there when the row is wide.
  const wideText = await page.locator('[data-testid="view-toggle"]').innerText();
  if (wideLabels === 'translated') {
    // The catalog loaded: a missing one falls back to English silently.
    expect(wideText, 'the toolbar still reads its English action, so the catalog did not load').not.toContain('Add column');
    for (const control of await readControlLabels(page, controlTestIds)) {
      expect(control.text, `${control.testId} shows no label at ${WIDE.width}px wide`).not.toBe('');
    }
  } else {
    for (const label of wideLabels) {
      expect(wideText, `"${label}" is missing from the toolbar at ${WIDE.width}px wide`).toContain(label);
    }
  }
  // The two count pills are what make this the widest switcher; without them the
  // floor case below is not the one the ladder was sized for.
  await expect(page.locator('[data-testid="view-toggle-workflows-count"]')).toHaveText('1');
  await expect(page.locator('[data-testid="view-toggle-backlog-count"]')).toHaveText('3');
  if (wideLabels !== 'translated') {
    await expect(page.locator('[data-testid="view-toggle-workflows"]')).toHaveAttribute('aria-label', 'Workflows, 1 workflow');
    await expect(page.locator('[data-testid="view-toggle-backlog"]')).toHaveAttribute('aria-label', 'Backlog, 3 items');
  }

  const wideHeight = await settledHeight(page);
  expect(wideHeight).toBeGreaterThan(0);

  await page.setViewportSize(FLOOR);
  const narrowHeight = await settledHeight(page);

  // 1. Row-height invariance. A wrapped label is the only thing that can grow
  //    this row, so this is the reported defect stated directly.
  expect(
    Math.abs(narrowHeight - wideHeight),
    `toolbar row grew from ${wideHeight}px to ${narrowHeight}px at ${FLOOR.width}x${FLOOR.height}, which means a label wrapped`,
  ).toBeLessThanOrEqual(1);

  // 2. The search still has to be a search box. It is the only child that flexes
  //    and it has a max but no min, so it silently absorbs everything the row is
  //    short: before the ladder's thresholds were tuned, the backlog search was
  //    92px across at a collapsed sidebar with every label still showing, and the
  //    row "fit" perfectly the whole way down. A clipping check cannot see that.
  const searchWidth = await readSearchWidth(page);
  expect(
    searchWidth,
    `the search field is ${searchWidth}px at ${FLOOR.width}x${FLOOR.height}; the row is squeezing it instead of shedding a label`,
  ).toBeGreaterThanOrEqual(SEARCH_FLOOR_PX);

  // 3. Right-edge containment, with the 1px slack the portal-clipping spec uses.
  const reading = await readRow(page, controlTestIds);
  for (const control of reading.controls) {
    expect(
      control.right,
      `${control.testId} ends at ${control.right}, past the row's content edge at ${reading.rowContentRight}`,
    ).toBeLessThanOrEqual(reading.rowContentRight + 1);
  }
}

test.describe('Chrome rows at the 900x600 floor', () => {
  test('board toolbar survives the floor with the sidebar at its 400px default', async () => {
    const { browser, page } = await launch();
    try {
      await expectRowSurvivesTheFloor(page, BOARD_CONTROLS, BOARD_LABELS);
    } finally {
      await browser.close();
    }
  });

  test('board toolbar survives the floor with the sidebar collapsed', async () => {
    const { browser, page } = await launch();
    try {
      await collapseSidebar(page);
      await expectRowSurvivesTheFloor(page, BOARD_CONTROLS, BOARD_LABELS);
    } finally {
      await browser.close();
    }
  });

  test('backlog toolbar survives the floor with the sidebar at its 400px default', async () => {
    const { browser, page } = await launch();
    try {
      await switchToBacklog(page);
      await expectRowSurvivesTheFloor(page, BACKLOG_CONTROLS, BACKLOG_LABELS);
    } finally {
      await browser.close();
    }
  });

  test('backlog toolbar survives the floor with the sidebar collapsed', async () => {
    const { browser, page } = await launch();
    try {
      await collapseSidebar(page);
      await switchToBacklog(page);
      await expectRowSurvivesTheFloor(page, BACKLOG_CONTROLS, BACKLOG_LABELS);
    } finally {
      await browser.close();
    }
  });

  // The same four floor cases in the longest language. A ladder fixed at English
  // widths passed every English case here while Russian squeezed the search to
  // 44px between two steps.
  for (const [view, controls] of [['board', BOARD_CONTROLS], ['backlog', BACKLOG_CONTROLS]] as const) {
    for (const sidebar of ['400px default', 'collapsed'] as const) {
      test(`${view} toolbar survives the floor in ${LONG_LOCALE} with the sidebar ${sidebar === 'collapsed' ? 'collapsed' : 'at its 400px default'}`, async () => {
        const { browser, page } = await launch(3, LONG_LOCALE);
        try {
          if (sidebar === 'collapsed') await collapseSidebar(page);
          if (view === 'backlog') await switchToBacklog(page);
          await expectRowSurvivesTheFloor(page, [...controls], 'translated');
        } finally {
          await browser.close();
        }
      });
    }
  }

  /**
   * A 1000+ item backlog keeps every digit at the floor rather than shortening to
   * "1.2k", which would hide the exact count the pill exists to show. That was a
   * signed-off trade: the four digits leave the backlog search 105px there on
   * Windows' fonts, under the 110 the cases above hold a 3-item backlog to. This
   * holds the trade to its own floor, with room for headless Linux's metrics, so a
   * pill that grows any further still fails.
   */
  test('a 1000+ item backlog keeps every digit of its count at the floor', async () => {
    const { browser, page } = await launch(1204);
    try {
      await switchToBacklog(page);
      const pill = page.locator('[data-testid="view-toggle-backlog-count"]');
      await expect(pill).toHaveText('1204');
      const wideHeight = await settledHeight(page);

      await page.setViewportSize(FLOOR);
      const narrowHeight = await settledHeight(page);
      expect(Math.abs(narrowHeight - wideHeight), 'a label wrapped at the floor').toBeLessThanOrEqual(1);

      const fit = await pill.evaluate((element) => {
        const option = element.closest('[data-testid="view-toggle-backlog"]');
        if (!option) throw new Error('the Backlog option is not around its count');
        return {
          clipped: element.scrollWidth > element.clientWidth,
          pillRight: element.getBoundingClientRect().right,
          optionRight: option.getBoundingClientRect().right,
        };
      });
      expect(fit.clipped, 'the count pill clips its own digits').toBe(false);
      expect(fit.pillRight, 'the count pill runs past its option').toBeLessThanOrEqual(fit.optionRight + 0.5);

      const searchWidth = await readSearchWidth(page);
      expect(searchWidth, `the search field is ${searchWidth}px with a four-digit backlog count`).toBeGreaterThanOrEqual(FOUR_DIGIT_SEARCH_FLOOR_PX);
      const reading = await readRow(page, BACKLOG_CONTROLS);
      for (const control of reading.controls) {
        expect(control.right, `${control.testId} ends past the row's content edge`).toBeLessThanOrEqual(reading.rowContentRight + 1);
      }
    } finally {
      await browser.close();
    }
  });

  test('workflows toolbar survives the floor with the sidebar at its 400px default', async () => {
    const { browser, page } = await launch();
    try {
      await switchToWorkflows(page);
      await expectRowSurvivesTheFloor(page, WORKFLOWS_CONTROLS, WORKFLOWS_LABELS);
    } finally {
      await browser.close();
    }
  });

  /**
   * The two-width checks above would both pass with a step chosen so badly that
   * the row breaks somewhere in between. With a 400px sidebar the toolbar's own
   * width is the viewport minus 405, so the English range walks the container
   * from 495 to 1045 and crosses every step in all three ladders.
   *
   * The ceiling is set by the widest step any branch has. In English that is the
   * backlog's filter controls, which keep their labels from a content box of
   * about 1000 (a 1032px row, a 1437px viewport). Russian labels are wider, so its
   * board sweep runs to 1650 to cross its own widest step. Stopping short leaves
   * the widest and last-crossed step covered only by the two fixed-width tests on
   * either side of it.
   */
  for (const [view, controls, locale, ceiling] of [
    ['board', BOARD_CONTROLS, 'en', 1450],
    ['backlog', BACKLOG_CONTROLS, 'en', 1450],
    ['workflows', WORKFLOWS_CONTROLS, 'en', 1450],
    ['board', BOARD_CONTROLS, LONG_LOCALE, 1650],
  ] as const) {
    test(`the ${view} toolbar holds at every width across the ladder${locale === 'en' ? '' : ` in ${locale}`}`, async () => {
      const { browser, page } = await launch(3, locale);
      try {
        if (view === 'backlog') await switchToBacklog(page);
        if (view === 'workflows') await switchToWorkflows(page);

        const baseline = await settledHeight(page);
        const broken: string[] = [];

        for (let width = 900; width <= ceiling; width += 25) {
          await page.setViewportSize({ width, height: FLOOR.height });
          const height = await settledHeight(page);
          if (Math.abs(height - baseline) > 1) {
            broken.push(`${width}px: row is ${height}px, baseline ${baseline}px`);
            continue;
          }
          const searchWidth = await readSearchWidth(page);
          if (searchWidth < SEARCH_FLOOR_PX) {
            broken.push(`${width}px: search squeezed to ${searchWidth}px instead of shedding a label`);
          }
          const reading = await readRow(page, controls);
          for (const control of reading.controls) {
            if (control.right > reading.rowContentRight + 1) {
              broken.push(`${width}px: ${control.testId} ends at ${control.right}, edge at ${reading.rowContentRight}`);
            }
          }
        }

        expect(broken, `the ${view} toolbar breaks between the ladder's steps`).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  }

  /**
   * The toolbar row is an `@container`, which makes it a containing block for
   * positioned descendants AND gives it its own stacking context. Its three
   * popovers are in-flow `absolute ... z-50` and open downward over the board well
   * below, so that `z-50` is now scoped to the row rather than to the app root.
   * Containment here is layout and size, never paint, so nothing is clipped - but
   * both halves of that are quiet enough to regress unnoticed.
   */
  test('the filter popover still opens over the board at the floor', async () => {
    const { browser, page } = await launch();
    try {
      await page.setViewportSize(FLOOR);
      await page.locator('[data-testid="board-filter-btn"]').click();
      const popover = page.locator('[data-testid="board-filter-btn-popover"]');
      await popover.waitFor({ state: 'visible', timeout: 5000 });

      const reading = await page.evaluate(() => {
        const element = document.querySelector('[data-testid="board-filter-btn-popover"]')!;
        const rect = element.getBoundingClientRect();
        // Probe a point well inside the menu. If anything in the board well below
        // now paints over it, the hit test lands outside the menu's subtree.
        const probe = document.elementFromPoint(
          Math.round(rect.left + rect.width / 2),
          Math.round(rect.top + 20),
        );
        return {
          height: Math.round(rect.height),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          topmostIsInsidePopover: !!probe && element.contains(probe),
        };
      });

      expect(reading.height, 'the filter popover rendered with no height').toBeGreaterThan(40);
      expect(reading.topmostIsInsidePopover, 'something paints over the filter popover').toBe(true);
      expect(reading.left).toBeGreaterThanOrEqual(0);
      expect(reading.right).toBeLessThanOrEqual(FLOOR.width + 1);

      // The load-bearing half: the menu still ACTS. Clicking a priority pill sets
      // a filter, and the count pill after the Filter button's label is what
      // reports it. The label is hidden at this width, so the button's text
      // going from empty to "1" is exactly the pill appearing. A menu that is
      // painted over or pointer-dead fails here; the hit-test probe above is
      // only a tripwire.
      await popover.locator('text=High').first().click();
      await expect
        .poll(async () => page.locator('[data-testid="board-filter-btn"]').innerText(), { timeout: 5000 })
        .toBe('1');

      // The icon-only square is too narrow for the icon and the pill, so the
      // button widens to hold it: the pill stays inside the button's border, and
      // the button keeps the height of its icon-only neighbour.
      const fit = await page.evaluate(() => {
        const button = document.querySelector('[data-testid="board-filter-btn"]')!.getBoundingClientRect();
        const pill = document.querySelector('[data-testid="board-filter-btn-count"]')!.getBoundingClientRect();
        const neighbour = document.querySelector('[data-testid="manage-labels-btn"]')!.getBoundingClientRect();
        return {
          buttonLeft: button.left,
          buttonRight: button.right,
          buttonHeight: button.height,
          pillLeft: pill.left,
          pillRight: pill.right,
          neighbourHeight: neighbour.height,
        };
      });
      expect(fit.pillRight, 'the count pill spills past the Filter button').toBeLessThanOrEqual(fit.buttonRight - 1);
      expect(fit.pillLeft, 'the count pill spills past the Filter button').toBeGreaterThanOrEqual(fit.buttonLeft + 1);
      expect(Math.abs(fit.buttonHeight - fit.neighbourHeight), 'the Filter button changed height').toBeLessThanOrEqual(1);
      // The search pays for the wider button, down to the trade's own floor and no further.
      const filteredSearchWidth = await readSearchWidth(page);
      expect(filteredSearchWidth, `the search field is ${filteredSearchWidth}px with a filter active`).toBeGreaterThanOrEqual(FILTERED_SEARCH_FLOOR_PX);
    } finally {
      await browser.close();
    }
  });

  /**
   * The third persistent chrome row. It has no shrink strategy either, but its
   * content is two short counts and a version pill, so it does not clip today.
   * The rule this spec enforces covers every chrome row, so assert it rather than
   * assuming it stays short.
   */
  test('the status bar holds at the floor', async () => {
    const { browser, page } = await launch();
    try {
      const bar = '[data-testid="app-status-bar"]';
      await page.locator(bar).waitFor({ state: 'visible', timeout: 10000 });
      const wideHeight = await page.evaluate(
        (selector) => document.querySelector(selector)!.getBoundingClientRect().height,
        bar,
      );

      await page.setViewportSize(FLOOR);
      const narrow = await page.evaluate((selector) => {
        const element = document.querySelector(selector)!;
        const rect = element.getBoundingClientRect();
        const paddingRight = parseFloat(getComputedStyle(element).paddingRight) || 0;
        const children = [...element.children] as HTMLElement[];
        const last = children[children.length - 1];
        return {
          height: rect.height,
          contentRight: Math.round(rect.right - paddingRight),
          lastRight: Math.round(last.getBoundingClientRect().right),
        };
      }, bar);

      expect(
        Math.abs(narrow.height - wideHeight),
        `the status bar grew from ${wideHeight}px to ${narrow.height}px, which means something wrapped`,
      ).toBeLessThanOrEqual(1);
      expect(
        narrow.lastRight,
        `the status bar's trailing group ends at ${narrow.lastRight}, past its content edge at ${narrow.contentRight}`,
      ).toBeLessThanOrEqual(narrow.contentRight + 1);
    } finally {
      await browser.close();
    }
  });

  test('the title bar project name never reaches the right-hand icon cluster', async () => {
    const { browser, page } = await launch();
    try {
      await page.setViewportSize(FLOOR);
      await page.locator('[data-testid="titlebar-project-name"]').waitFor({ state: 'visible', timeout: 10000 });

      const overlap = await page.evaluate(() => {
        const name = document.querySelector('[data-testid="titlebar-project-name"]');
        const actions = document.querySelector('[data-testid="titlebar-actions"]');
        if (!name || !actions) throw new Error('title bar landmarks not found');
        return {
          nameRight: Math.round(name.getBoundingClientRect().right),
          actionsLeft: Math.round(actions.getBoundingClientRect().left),
        };
      });

      expect(
        overlap.nameRight,
        `the project name ends at ${overlap.nameRight}, past the icon cluster's left edge at ${overlap.actionsLeft}`,
      ).toBeLessThanOrEqual(overlap.actionsLeft + 1);
    } finally {
      await browser.close();
    }
  });
});
