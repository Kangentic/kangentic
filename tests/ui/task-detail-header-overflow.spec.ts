/**
 * UI tests for the task-detail header pill overflow (useHeaderPillOverflow).
 *
 * The header reserves only a ~50ch FLOOR of the title, not its full width, so the
 * quick-access pills reclaim the space above the floor and appear in priority order
 * (title up to 50ch > pills > title beyond 50ch). The title element is flex-1, so it
 * shows in FULL on a wide window and only truncates toward the floor when the pills
 * genuinely need the room. A title long enough that even a maximized window cannot
 * show it (lorem ipsum below) therefore truncates at every width, while the pills
 * appear or fold purely as a function of the window's width:
 *
 * - Narrow window (near the min): the floor reserve leaves no room, every pill folds
 *   into the `...` kebab and the title takes the whole row.
 * - Wide / maximized window: the pills are visible AND the title still truncates, but
 *   the rendered title keeps at least the floor's worth of characters.
 * - Short title: floor === natural width, so behavior is unchanged - all pills show
 *   and the lowest-priority custom shortcuts fold before any built-in default.
 *
 * The window width is driven through the window-manager store (exposed at
 * window.__zustandStores in dev mode), not the browser viewport, so each case is
 * deterministic. Assertions use visibility and a font-relative truncation check
 * (auto-retried), not pixel-exact widths, so they are robust on headless-Linux CI.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });
import path from 'node:path';
import { waitForViteReady } from './helpers';
import type { FractionalRect } from '../../src/renderer/window-manager/store/types';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-header-overflow';
const LONG_TASK_ID = 'task-header-overflow-long';
const LONG_SESSION_ID = 'sess-header-overflow-long';
const SHORT_TASK_ID = 'task-header-overflow-short';
const SHORT_SESSION_ID = 'sess-header-overflow-short';

// Long enough that its natural width exceeds even a maximized window, so the title
// truncates at every width from the min up to maximized. A unique opening substring
// (used to click the card) keeps the locator off the full 250+ char string.
const LONG_TITLE_PREFIX = 'Lorem ipsum dolor sit amet';
const LONG_TITLE =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit';
// Short enough to leave room for some pills, so the default-vs-shortcut fold order
// is observable.
const SHORT_TITLE = 'Quick task';

// More header shortcuts than can sit beside the four defaults next to the short
// title, so the lowest-priority (shortcut) pills must fold while the defaults stay.
const SHORTCUT_LABELS = [
  'Shortcut One',
  'Shortcut Two',
  'Shortcut Three',
  'Shortcut Four',
  'Shortcut Five',
  'Shortcut Six',
];

const preConfigScript = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Header Overflow Test',
      path: '/mock/header-overflow',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.projectConfigs['/mock/header-overflow'] = {
      browser: { enabled: true },
    };

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
    });

    function pushSession(id, taskId) {
      state.sessions.push({
        id: id,
        taskId: taskId,
        projectId: '${PROJECT_ID}',
        pid: 9999,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/header-overflow',
        startedAt: ts,
        exitCode: null,
      });
    }

    function pushTask(id, title, sessionId, position) {
      state.tasks.push({
        id: id,
        title: title,
        description: 'Drives the header pill overflow behavior',
        swimlane_id: laneIds['Code Review'],
        position: position,
        agent: 'claude',
        session_id: sessionId,
        worktree_path: '/mock/worktrees/header-overflow-' + position,
        branch_name: 'feature/header-overflow-' + position,
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
    }

    pushSession('${LONG_SESSION_ID}', '${LONG_TASK_ID}');
    pushSession('${SHORT_SESSION_ID}', '${SHORT_TASK_ID}');
    pushTask('${LONG_TASK_ID}', ${JSON.stringify(LONG_TITLE)}, '${LONG_SESSION_ID}', 0);
    pushTask('${SHORT_TASK_ID}', ${JSON.stringify(SHORT_TITLE)}, '${SHORT_SESSION_ID}', 1);

    // Seed custom header shortcuts (project-wide). loadShortcuts() (called during
    // board hydration) reads this override, so the header renders the shortcut pills.
    var shortcutLabels = ${JSON.stringify(SHORTCUT_LABELS)};
    window.electronAPI.boardConfig.getShortcuts = async function () {
      return shortcutLabels.map(function (label, index) {
        return {
          id: 'shortcut-' + index,
          label: label,
          icon: 'zap',
          command: 'echo ' + index,
          display: 'header',
        };
      });
    };

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

/** The slice of the dev-only window.__zustandStores surface these tests drive. */
type WindowStores = {
  window: {
    getState: () => {
      windows: Record<string, { id: string; anchor: string }>;
      setGeometry: (id: string, geometry: FractionalRect) => void;
      maximizeWindow: (id: string) => void;
    };
  };
};

async function openTaskDialog(page: Page, cardText: string) {
  const card = page.locator('[data-swimlane-name="Code Review"]').locator(`text=${cardText}`).first();
  await card.click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
}

/** Find the managed window hosting `taskId` and run `apply` against the window store. */
async function driveTaskWindow(
  page: Page,
  taskId: string,
  action: 'setGeometry' | 'maximizeWindow',
  rect?: FractionalRect,
) {
  await page.evaluate(
    ({ taskId, action, rect }) => {
      const stores = (window as unknown as { __zustandStores?: WindowStores }).__zustandStores;
      if (!stores) throw new Error('window.__zustandStores not exposed');
      const state = stores.window.getState();
      const managed = Object.values(state.windows).find((candidate) => candidate.anchor === taskId);
      if (!managed) throw new Error(`no managed window for task ${taskId}`);
      if (action === 'maximizeWindow') {
        state.maximizeWindow(managed.id);
      } else if (rect) {
        state.setGeometry(managed.id, rect);
      }
    },
    { taskId, action, rect },
  );
}

/** Set the task-detail window to a fixed-fraction floating size. */
function resizeTaskWindow(page: Page, taskId: string, rect: FractionalRect) {
  return driveTaskWindow(page, taskId, 'setGeometry', rect);
}

/** Maximize the task-detail window (fills the whole overlay). */
function maximizeTaskWindow(page: Page, taskId: string) {
  return driveTaskWindow(page, taskId, 'maximizeWindow');
}

// ~31% of the 1920px overlay (~595px), at the narrow end of the float range. Both
// the ~50ch floor reserve AND a quick-action pill's width scale with the CI font's
// char metrics, but at this width the protected clusters plus the floor consume the
// row across the plausible font range, so every pill folds. Driving it this narrow
// (below the interactive 650px resize floor) is a valid programmatic geometry: the
// store only clamps to MIN_FRACTION (0.12), not to DEFAULT_MIN_WIDTH_PX.
const NARROW_RECT: FractionalRect = { x: 0.3, y: 0.15, w: 0.31, h: 0.6 };

test.describe('Task detail header pill overflow (title floor)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();

    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(preConfigScript);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await page.goto(VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test('a long title at a narrow window folds every quick action into the kebab', async () => {
    await openTaskDialog(page, LONG_TITLE_PREFIX);
    await resizeTaskWindow(page, LONG_TASK_ID, NARROW_RECT);

    // At the min-width end the floor reserve leaves no room, so even the
    // highest-priority default (Commands) folds - which proves every pill folded.
    await expect(page.locator('[data-testid="commands-button"]')).toBeHidden();
    await expect(page.locator('[data-testid="browser-toggle"]')).toBeHidden();

    // The title ellipsizes (rendered width < natural width). Poll so the overflow
    // ResizeObserver pass has settled.
    await expect
      .poll(async () =>
        page
          .locator('[data-testid="task-title-text"]')
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      )
      .toBe(true);
  });

  test('a long title at a wide window shows the quick actions and still truncates to the floor', async () => {
    await openTaskDialog(page, LONG_TITLE_PREFIX);
    await maximizeTaskWindow(page, LONG_TASK_ID);

    // Maximized leaves plenty of room above the floor, so the pills reclaim it: the
    // highest-priority default is visible. This inverts the old behavior where a long
    // title reserved its full width and hid every pill.
    await expect(page.locator('[data-testid="commands-button"]')).toBeVisible();

    // The title still truncates (its natural width exceeds even a maximized window),
    // and the rendered title keeps at least the ~50ch floor's worth of characters.
    // averageCharWidth is read from the live span (scrollWidth / length), so the check
    // is font-relative, not pixel-exact; the 45 vs 50 margin absorbs sub-pixel rounding.
    await expect
      .poll(async () =>
        page.locator('[data-testid="task-title-text"]').evaluate((element) => {
          const textLength = (element.textContent ?? '').length || 1;
          const averageCharWidth = element.scrollWidth / textLength;
          const renderedChars = element.clientWidth / averageCharWidth;
          return element.scrollWidth > element.clientWidth && renderedChars >= 45;
        }),
      )
      .toBe(true);
  });

  test('custom shortcuts fold before the built-in defaults', async () => {
    await openTaskDialog(page, SHORT_TITLE);

    // A short title leaves room for the pills. Every built-in default stays put...
    await expect(page.locator('[data-testid="commands-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="branch-pill"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="browser-toggle"]')).toBeVisible();

    // ...while the lowest-priority custom shortcuts fold into the kebab. A folded
    // pill is not rendered (showPill === false), so the rendered shortcut-pill count
    // stays below the seeded count: the shortcuts give up their space before any
    // default does. Which specific shortcuts survive is left to the greedy fit, so
    // this stays order-agnostic.
    await expect
      .poll(async () => page.locator('[data-testid^="shortcut-pill-"]').count())
      .toBeLessThan(SHORTCUT_LABELS.length);
  });
});
