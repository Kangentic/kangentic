/**
 * UI tests for the task-detail header pill overflow (useHeaderPillOverflow).
 *
 * Two behaviors:
 * - Title wins. The header reserves the title's full width first, so a long title
 *   keeps the row and the quick-access pills fold into the `...` kebab (even the
 *   highest-priority default). The title ellipsizes only once the pills have gone.
 * - Custom shortcuts fold before the built-in defaults. When a short title leaves
 *   room for some pills, the built-in defaults (Commands, Worktree, Changes,
 *   Browser) outrank custom header shortcuts (priority 10), so an unbounded number
 *   of custom shortcuts can never bury a default.
 *
 * Assertions use visibility and a truncation check (auto-retried), not pixel-exact
 * widths, so they are robust on headless-Linux CI.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-header-overflow';
const LONG_TASK_ID = 'task-header-overflow-long';
const LONG_SESSION_ID = 'sess-header-overflow-long';
const SHORT_TASK_ID = 'task-header-overflow-short';
const SHORT_SESSION_ID = 'sess-header-overflow-short';

// Long enough that its natural width exceeds the floating window, so the title
// wins the whole row and every quick-access pill folds.
const LONG_TITLE =
  'Bug: agent/MCP-created task is in the board store but absent from the rendered board until a full reload (HMR board-store subscription split-brain)';
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

async function openTaskDialog(page: Page, titleText: string) {
  const card = page.locator('[data-swimlane-name="Code Review"]').locator(`text=${titleText}`).first();
  await card.click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('Task detail header pill overflow (title wins)', () => {
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

  test('a long title wins the row and folds the quick actions into the kebab', async () => {
    await openTaskDialog(page, LONG_TITLE);

    // The title takes the whole row, so even the highest-priority default pill
    // (Commands) folds into the kebab - which proves every pill folded.
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
