/**
 * UI tests for the completed task view's tab row in a language whose tab names
 * reach the edge of a narrow task window.
 *
 * `CompletedTaskView` passes `fit="icons-then-scroll"` to `Tabs`. Its tabs carry no
 * icons, so a row whose names do not fit cannot shrink to icons: it scrolls
 * sideways and keeps the selected tab in view. Without the prop the row has no
 * overflow rule at all, so the last tab runs past the row and is clipped by the
 * window around it. English fits at the app's 900px floor (completed-task-view.spec.ts
 * holds it to that), German does not: "Beschreibung" and its neighbours need more
 * than the roughly 520px window the floor leaves.
 *
 * What is asserted is the effect, never a German string or a pixel value:
 *   - the tab row is a scroller (`overflow-x`, and a scroll width past its width)
 *     that sits inside the row's own padding instead of spilling past it;
 *   - the last tab, clipped while the first is selected, is scrolled fully into the
 *     tab list once it is chosen, and the first tab comes back the same way.
 *
 * Every figure is read inside `page.evaluate` and compared relatively with a pixel
 * of tolerance for sub-pixel rounding (.claude/rules/cross-platform-parity.md).
 * Controls are found by test id. The overflow itself proves the German catalog
 * loaded: the same row fits in English at this width.
 *
 * The window width is not hardcoded to a machine's fonts. It starts at the app's
 * floor and narrows in small steps only if this platform's fonts leave the German
 * names room there, so the overflow the cases need is the same everywhere.
 *
 * Each test launches and tears down its own browser, so the file fans out across
 * the UI workers safely.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, settleFrames } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-tabs-scroll';
const TASK_ID = 'task-tabs-scroll-1';
const SESSION_ID = 'abc12345-6789-4def-abcd-000000000002';

/** The app window's minimum width (`minWidth` in src/main/index.ts), where the task window is narrowest. */
const FLOOR_WIDTH = 900;
const NARROW_HEIGHT = 700;
/**
 * Where the narrowing search gives up. Anything below `FLOOR_WIDTH` is only a
 * fallback for a platform whose fonts leave the German names room at the floor,
 * and 700 is just a stop.
 */
const NARROWEST_TRIED_WIDTH = 700;
const NARROWING_STEP_PX = 20;
/**
 * How far the names must overflow the tab list before a case runs. `Tabs` switches
 * to its scrolling mode once the names pass the list by more than a pixel, so this
 * is comfortably past that and still small enough for the floor to qualify.
 */
const MIN_OVERFLOW_PX = 4;
/** Sub-pixel rounding between platforms. */
const TOLERANCE_PX = 1;

const TAB_ROW = '[data-testid="completed-task-tabs"]';
const TAB_LIST = `${TAB_ROW} [role="tablist"]`;
const FIRST_TAB = '[data-testid="completed-task-tabs-summary"]';
const LAST_TAB = '[data-testid="completed-task-tabs-description"]';

/** A project with the default columns, and one completed task whose view has a report to show. */
function seedScript(locale: string): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      // The session's language, which the mock boots in.
      state.config.displayLanguage = ${JSON.stringify(locale)};
      state.config.hasAnsweredLanguageSuggestion = true;

      state.projects.push({
        id: '${PROJECT_ID}', name: 'Tabs Scroll', path: '/mock/tabs-scroll', github_url: null,
        default_agent: 'claude', position: 0, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        state.swimlanes.push({
          id: state.uuid(), name: template.name, role: template.role, color: template.color, icon: template.icon,
          is_archived: template.is_archived, is_ghost: template.is_ghost,
          permission_strategy: template.permission_strategy ?? null, auto_spawn: template.auto_spawn ?? false,
          auto_command: template.auto_command ?? null, plan_exit_target_id: null, position: index, created_at: ts,
        });
      });
      var doneLane = state.swimlanes.find(function (lane) { return lane.role === 'done'; });
      state.archivedTasks.push({
        id: '${TASK_ID}', title: 'Tabs Scroll Task', description: 'A task that has been completed',
        swimlane_id: doneLane.id, position: 0, agent: null, session_id: null, worktree_path: null,
        branch_name: null, pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: null,
        attachment_count: 0, archived_at: ts, created_at: ts, updated_at: ts,
      });
      state.summaryCache['${TASK_ID}'] = {
        sessionId: '${SESSION_ID}', totalCostUsd: 0.08, totalInputTokens: 12500, totalOutputTokens: 545,
        modelDisplayName: 'Opus 4.6', durationMs: 17000, toolCallCount: 5, compactionCount: 0,
        linesAdded: 469, linesRemoved: 181, filesChanged: 18,
        taskCreatedAt: '2026-03-13T15:40:00.000Z', startedAt: '2026-03-13T15:44:00.000Z',
        exitedAt: '2026-03-13T15:45:00.000Z', exitCode: 0, toolBreakdown: [],
      };

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/** Launch in German at a wide viewport (a narrow board folds the Done column's list away) and open the completed task. */
async function launchCompletedTaskInGerman(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript('de'));

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('de');

  await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator(`[data-task-id="${TASK_ID}"]`).click();
  await expect(page.locator('[data-testid="completed-task-view"]')).toBeVisible({ timeout: 5000 });
  return { browser, page };
}

interface TabRowReading {
  /** `Tabs`' own switch: 'true' once the names stopped fitting, 'false' while they do, null without `fit`. */
  fitIconsOnly: string | null;
  overflowX: string;
  listClientWidth: number;
  listScrollWidth: number;
  listScrollLeft: number;
  listRight: number;
  /** The tab row's content box: its border box minus its own horizontal padding. */
  rowContentLeft: number;
  rowContentRight: number;
  firstTabLeft: number;
  firstTabRight: number;
  lastTabLeft: number;
  lastTabRight: number;
}

/** One layout read of the tab row, as numbers from a single `page.evaluate`. */
async function readTabRow(page: Page): Promise<TabRowReading> {
  return page.evaluate(({ rowSelector, listSelector, firstSelector, lastSelector }) => {
    const row = document.querySelector(rowSelector);
    const list = document.querySelector(listSelector);
    const firstTab = document.querySelector(firstSelector);
    const lastTab = document.querySelector(lastSelector);
    if (!row || !list || !firstTab || !lastTab) throw new Error('the completed task tab row is not rendered');
    const listBox = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const rowStyle = getComputedStyle(row);
    const firstBox = firstTab.getBoundingClientRect();
    const lastBox = lastTab.getBoundingClientRect();
    return {
      fitIconsOnly: list.getAttribute('data-fit-icons-only'),
      overflowX: getComputedStyle(list).overflowX,
      listClientWidth: list.clientWidth,
      listScrollWidth: list.scrollWidth,
      listScrollLeft: list.scrollLeft,
      listRight: listBox.right,
      rowContentLeft: rowBox.left + (parseFloat(rowStyle.paddingLeft) || 0),
      rowContentRight: rowBox.right - (parseFloat(rowStyle.paddingRight) || 0),
      firstTabLeft: firstBox.left,
      firstTabRight: firstBox.right,
      lastTabLeft: lastBox.left,
      lastTabRight: lastBox.right,
    };
  }, { rowSelector: TAB_ROW, listSelector: TAB_LIST, firstSelector: FIRST_TAB, lastSelector: LAST_TAB });
}

/**
 * How far the five tab names, end to end, run past the room the row's content box
 * gives them. Read off the tabs themselves, so it holds whether or not the list
 * has an overflow rule of its own, and scrolling moves both ends together.
 */
function namesOverflow(reading: TabRowReading): number {
  return (reading.lastTabRight - reading.firstTabLeft) - (reading.rowContentRight - reading.rowContentLeft);
}

/** The tab row's outer width, which only a resize of the task window can change. */
async function readRowWidth(page: Page): Promise<number> {
  return page.evaluate((selector) => document.querySelector(selector)!.getBoundingClientRect().width, TAB_ROW);
}

/** Re-read the row's width, a couple of frames apart, until two reads agree. No fixed wait. */
async function settledRowWidth(page: Page): Promise<number> {
  let previous = Number.NaN;
  await expect.poll(async () => {
    await settleFrames(page, 2);
    const current = await readRowWidth(page);
    const stable = current === previous;
    previous = current;
    return stable;
  }, { timeout: 10000 }).toBe(true);
  return previous;
}

/**
 * Narrow the window from the app's floor until the German tab names overflow the
 * tab list by `MIN_OVERFLOW_PX`, and return the viewport width that did it. The
 * floor is the first width tried, so a platform whose fonts overflow there runs
 * at the floor itself.
 */
async function narrowUntilTabsOverflow(page: Page): Promise<number> {
  for (let width = FLOOR_WIDTH; width >= NARROWEST_TRIED_WIDTH; width -= NARROWING_STEP_PX) {
    await page.setViewportSize({ width, height: NARROW_HEIGHT });
    await settledRowWidth(page);
    if (namesOverflow(await readTabRow(page)) >= MIN_OVERFLOW_PX) return width;
  }
  throw new Error(`the German tab names fit their row at every window from ${FLOOR_WIDTH}px down to ${NARROWEST_TRIED_WIDTH}px`);
}

/**
 * Choose a tab the way a click handler would be reached, not by pointer position:
 * a pointer click scrolls its target into view first, and a keyboard move focuses
 * the tab, which scrolls even a clipped container. Either would bring the tab into
 * view without the row doing it, which is the thing under test.
 */
async function chooseTab(page: Page, tabSelector: string): Promise<void> {
  await page.locator(tabSelector).dispatchEvent('click');
  await expect(page.locator(tabSelector)).toHaveAttribute('aria-selected', 'true');
}

/** How far a tab sits outside the room the row's content box gives it, on whichever side is worse. */
function overhang(reading: TabRowReading, tabLeft: number, tabRight: number): number {
  return Math.max(reading.rowContentLeft - tabLeft, tabRight - reading.rowContentRight);
}

test.describe('Completed task tab row in German', () => {
  test('at a narrow window the tab row scrolls inside its padding instead of spilling out', async () => {
    const { browser, page } = await launchCompletedTaskInGerman();
    try {
      // Wide, the names fit and the row has not switched modes: what changes below
      // is the narrowing's doing, not the row's starting state.
      const wide = await readTabRow(page);
      expect(wide.fitIconsOnly, 'the tab row is already in its scrolling mode at a wide window').not.toBe('true');
      expect(namesOverflow(wide), 'the German names overflow even a wide window').toBeLessThanOrEqual(TOLERANCE_PX);

      const narrowedTo = await narrowUntilTabsOverflow(page);

      // The row measures its names and switches before the next paint.
      await expect(page.locator(TAB_LIST), `the row did not switch modes at ${narrowedTo}px`).toHaveAttribute('data-fit-icons-only', 'true');

      const narrow = await readTabRow(page);
      // A scroller: its own overflow rule, and more content than room.
      expect(['auto', 'scroll'], `the tab list's overflow-x is ${narrow.overflowX}, so nothing scrolls`).toContain(narrow.overflowX);
      expect(narrow.listScrollWidth - narrow.listClientWidth, 'the tab list has nothing to scroll').toBeGreaterThan(TOLERANCE_PX);
      // And it stays inside the row's padding. A list with no overflow rule grows
      // to hold every tab and takes the padding with it.
      expect(
        narrow.listRight,
        `the tab list ends at ${narrow.listRight}, past the row's content edge at ${narrow.rowContentRight}`,
      ).toBeLessThanOrEqual(narrow.rowContentRight + TOLERANCE_PX);
    } finally {
      await browser.close();
    }
  });

  test('a tab chosen at either end of the narrow row is scrolled fully into view', async () => {
    const { browser, page } = await launchCompletedTaskInGerman();
    try {
      await narrowUntilTabsOverflow(page);

      // The first tab is selected, so the row sits at its start and the last tab is
      // the one cut off. This is the clipping the scrolling exists to undo. No wait
      // on the row's mode here: the scroll that follows a choice runs whichever of
      // the choice and the mode switch lands first.
      const atStart = await readTabRow(page);
      expect(atStart.listScrollLeft, 'the tab list is scrolled before any tab was chosen').toBeLessThanOrEqual(TOLERANCE_PX);
      expect(
        overhang(atStart, atStart.lastTabLeft, atStart.lastTabRight),
        'the last tab is not cut off, so choosing it proves nothing',
      ).toBeGreaterThan(TOLERANCE_PX);

      await chooseTab(page, LAST_TAB);
      await expect
        .poll(async () => {
          const reading = await readTabRow(page);
          return overhang(reading, reading.lastTabLeft, reading.lastTabRight);
        }, { message: 'the last tab was not scrolled fully into the tab row' })
        .toBeLessThanOrEqual(TOLERANCE_PX);
      expect((await readTabRow(page)).listScrollLeft, 'the tab list did not scroll to reach the last tab').toBeGreaterThan(TOLERANCE_PX);

      // And back: the first tab returns to view, rather than the row staying put.
      await chooseTab(page, FIRST_TAB);
      await expect
        .poll(async () => {
          const reading = await readTabRow(page);
          return overhang(reading, reading.firstTabLeft, reading.firstTabRight);
        }, { message: 'the first tab was not scrolled back into the tab row' })
        .toBeLessThanOrEqual(TOLERANCE_PX);
    } finally {
      await browser.close();
    }
  });
});

