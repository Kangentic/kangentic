/**
 * UI test for the board toolbar's second measurement trigger: its CONTENT changing
 * while its width does not.
 *
 * `useToolbarCollapseStep` (board/toolbar-collapse.ts) measures what every collapse
 * step costs, once on mount and again from a MutationObserver whenever the row's
 * content changes. A ResizeObserver then picks the step from those costs whenever
 * the row's width changes. `toolbar-narrow-window.spec.ts` sweeps WIDTHS: it never
 * makes a content change at a held width as a step of its own, which is the
 * situation only the MutationObserver can answer.
 *
 * Here the viewport is held still. The backlog branch's fixed controls (New Task
 * plus Import Tasks) cost more than the board's (Add column), so there is a width
 * where the board is still at step 0 and the backlog cannot be. Switching the view
 * at that width changes the row's content and nothing else, so no resize can be
 * what moves the step. With the MutationObserver gone the row keeps the board's
 * costs, keeps step 0, and squeezes the backlog's search field to a slot.
 *
 * The width is found by reading `data-collapse-step` while the viewport steps down,
 * not by writing a pixel value, because where the board runs out of room depends
 * on the machine's fonts. It is searched in the BOARD view only, after the count
 * pills have arrived, so the view switch is the one content change made at a held
 * width. The app mounts on the board, which is why no backlog reading is taken
 * before the switch.
 *
 * Assertions are relative or coarse, per .claude/rules/cross-platform-parity.md:
 * "the step rose", "the row's width did not change", "the search keeps a floor".
 *
 * The file's one test launches and tears down its own browser.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, settleFrames } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'remeasure-proj';

/** The app's own floor, from `minWidth` / `minHeight` in src/main/index.ts. */
const FLOOR = { width: 900, height: 600 };
/** Wide enough that the board toolbar is at step 0 with room to spare. */
const WIDE = { width: 1600, height: 900 };

/**
 * The coarse lower bound on the search field the width sweep in
 * toolbar-narrow-window.spec.ts holds every row to. A backlog row left at the
 * board's step 0 gives up the width of its extra action to the search, which is
 * the only child that flexes.
 */
const SEARCH_FLOOR_PX = 110;

/** How close the search for the board's step-0 width has to get, in pixels. */
const WIDTH_RESOLUTION_PX = 4;

const ROW = '[data-testid="view-toggle"]';

/**
 * A project with the default columns, three backlog items so the backlog branch
 * has content and its count pill, and a workflow at rest so the Workflows segment
 * carries its count pill too. The sidebar is at its 400px maximum, the width the
 * rest of the toolbar specs design against.
 */
function seedScript(): string {
  return `
    window.__mockWorkflows = [{ workflow: { id: 'remeasure-workflow', title: 'Remeasure', state: 'draft', draft: null } }];
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.config.displayLanguage = 'en';
      state.config.hasAnsweredLanguageSuggestion = true;
      state.config.sidebar = { width: 400 };
      state.config.sidebarVisible = true;

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'remeasure-project',
        path: '/mock/remeasure-project',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, {
          id: 'remeasure-lane-' + index,
          position: index,
          created_at: ts,
        }));
      });

      for (var index = 0; index < 3; index += 1) {
        state.backlogTasks.push({
          id: 'remeasure-backlog-' + index,
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

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: WIDE });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript());

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en');
  // Both count pills widen the row, and they arrive after it mounts. Every reading
  // below is taken with them in place, so the board's step is the settled one.
  await expect(page.locator('[data-testid="view-toggle-workflows-count"]')).toHaveText('1');
  await expect(page.locator('[data-testid="view-toggle-backlog-count"]')).toHaveText('3');

  return { browser, page };
}

/** The ladder step React rendered on the toolbar row, or NaN while the row is missing. */
async function readStep(page: Page): Promise<number> {
  return page.evaluate(
    (selector) => Number(document.querySelector(selector)?.getAttribute('data-collapse-step') ?? Number.NaN),
    ROW,
  );
}

/**
 * Re-read the step, a couple of frames apart, until two reads agree. A resize is
 * answered by a ResizeObserver callback and a re-render, so one read straight
 * after `setViewportSize` can still be the previous width's step. No fixed wait.
 */
async function settledStep(page: Page): Promise<number> {
  let previous = Number.NaN;
  await expect.poll(async () => {
    await settleFrames(page, 2);
    const current = await readStep(page);
    const stable = current === previous;
    previous = current;
    return stable;
  }, { timeout: 10000 }).toBe(true);
  return previous;
}

async function stepAtWidth(page: Page, width: number): Promise<number> {
  await page.setViewportSize({ width, height: FLOOR.height });
  return settledStep(page);
}

/** The row's own content-box width, which only a resize can change. */
async function readRowWidth(page: Page): Promise<number> {
  return page.evaluate(
    (selector) => document.querySelector(selector)!.getBoundingClientRect().width,
    ROW,
  );
}

/** The toolbar's OWN search field. The sidebar has one too, earlier in the document. */
async function readSearchWidth(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const input = document.querySelector(`${selector} input[type="text"]`);
    return input ? Math.round(input.getBoundingClientRect().width) : 0;
  }, ROW);
}

async function switchToBacklog(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 10000 });
}

async function switchToBoard(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-board"]').click();
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 10000 });
}

test.describe('Board toolbar re-measure', () => {
  test('switching the view at a fixed width re-measures the row and picks the backlog\'s step', async () => {
    // A browser launch plus about a dozen viewport settles. About 5s unloaded; the
    // default 15s leaves little room on a busy runner.
    test.slow();
    const { browser, page } = await launch();
    try {
      // The two ends of the search have to differ, or "the narrowest width at
      // step 0" means nothing: the board is at step 0 when wide and collapsed at
      // the app's floor.
      expect(await stepAtWidth(page, WIDE.width), 'the board toolbar is not at step 0 when wide').toBe(0);
      expect(await stepAtWidth(page, FLOOR.width), 'the board toolbar is still at step 0 at the floor').toBeGreaterThan(0);

      // The narrowest width, to within a few pixels, where the board toolbar is
      // still at step 0. `chooseCollapseStep` is monotonic in the row's width, so
      // a bisection finds it.
      let collapsedAt = FLOOR.width;
      let fullAt = WIDE.width;
      while (fullAt - collapsedAt > WIDTH_RESOLUTION_PX) {
        const middle = Math.floor((collapsedAt + fullAt) / 2);
        if ((await stepAtWidth(page, middle)) === 0) fullAt = middle;
        else collapsedAt = middle;
      }
      const holdWidth = fullAt;

      // Hold the viewport here for the rest of the test.
      const boardStep = await stepAtWidth(page, holdWidth);
      expect(boardStep, `the board toolbar is not at step 0 at ${holdWidth}px`).toBe(0);
      const boardRowWidth = await readRowWidth(page);

      // The switch. Nothing resizes: the viewport is still, the sidebar is still,
      // and only the row's children change.
      await switchToBacklog(page);
      expect(
        Math.abs((await readRowWidth(page)) - boardRowWidth),
        'the toolbar row changed width on the view switch, so a resize could be what moved the step',
      ).toBeLessThanOrEqual(1);

      // The backlog's fixed controls cost more than the board's, so at a width
      // the board only just fits, the backlog needs a more collapsed step. Only
      // a re-measure of the row's content knows that.
      await expect
        .poll(() => readStep(page), {
          message: `the toolbar stayed at the board's step ${boardStep} after the switch to the backlog at ${holdWidth}px`,
          timeout: 5000,
        })
        .toBeGreaterThan(boardStep);

      // The step is chosen to leave the search its room. Left at the board's step,
      // the backlog row would squeeze it.
      await expect
        .poll(() => readSearchWidth(page), {
          message: `the backlog search is squeezed after the switch at ${holdWidth}px`,
          timeout: 5000,
        })
        .toBeGreaterThanOrEqual(SEARCH_FLOOR_PX);

      // Still the same viewport and the same row width, so the step above came
      // from the content alone.
      expect(Math.abs((await readRowWidth(page)) - boardRowWidth)).toBeLessThanOrEqual(1);

      // And back: the board's costs again, with no resize in between.
      await switchToBoard(page);
      await expect
        .poll(() => readStep(page), {
          message: `the toolbar kept the backlog's step after the switch back to the board at ${holdWidth}px`,
          timeout: 5000,
        })
        .toBe(boardStep);
      expect(Math.abs((await readRowWidth(page)) - boardRowWidth)).toBeLessThanOrEqual(1);
    } finally {
      await browser.close();
    }
  });
});
