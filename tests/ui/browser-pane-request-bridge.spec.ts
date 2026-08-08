/**
 * UI tests for `useBrowserPaneRequestBridge` - the renderer half of the
 * `kangentic_browser_open_pane` / `kangentic_browser_close_pane` MCP tools.
 *
 * Pane open state is renderer-owned (`browserOpenTasks`) while the MCP server is
 * main-process, so main pushes BROWSER_PANE_OPEN_REQUEST / _CLOSE_REQUEST and
 * this bridge acts on it. Three behaviors are load-bearing and none of them is
 * visible to the main-process unit tests:
 *
 * 1. A push with no task-detail window open must OPEN one, or the agent is left
 *    exactly where the `no-pane-open` dead end left it.
 * 2. A push at a pane already mounted on its EMPTY STATE must make it pick up
 *    the URL main just seeded. The pane's URL fetch keys on taskId + projectId,
 *    neither of which changed, so without the refresh nudge the pane would sit
 *    on the empty state forever, register no guest, and the tool would time out.
 * 3. Closing hides the pane but leaves the task-detail window open - the tool
 *    puts the pane away the way the Browser pill does, it does not close windows.
 *
 * Headless note: <webview> is an unknown HTMLElement here, so no real guest ever
 * attaches. These tests assert the RENDERER's reaction (which subtree renders),
 * which is exactly the half main cannot see; guest registration itself is
 * covered by browser-pane-registration.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-pane-bridge';
const TASK_ID = 'task-pane-bridge';
const SESSION_ID = 'sess-pane-bridge';
const PROJECT_PATH = '/mock/pane-bridge-test';
const SEEDED_URL = 'http://localhost:5173/';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Pane Bridge Test',
      path: '${PROJECT_PATH}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.projectConfigs['${PROJECT_PATH}'] = {
      browser: { enabled: true },
    };

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-pb-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9996,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Pane Bridge Task',
      description: 'Drives the browser-pane open/close request bridge',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let sharedBrowser: Browser;
let sharedPage: Page;

async function loadApp(page: Page): Promise<void> {
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
}

/** Fire main's open push, as `kangentic_browser_open_pane` does. */
async function emitOpenRequest(page: Page): Promise<void> {
  await page.evaluate(
    ([projectId, taskId]) => window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId),
    [PROJECT_ID, TASK_ID],
  );
}

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({ headless: true });
  const context = await sharedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  sharedPage = await context.newPage();
  await sharedPage.addInitScript({ path: MOCK_SCRIPT });
  await sharedPage.addInitScript(preConfig);
  await loadApp(sharedPage);
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

test.beforeEach(async () => {
  // Full navigation resets both the mock state and React state.
  await loadApp(sharedPage);
});

test.describe('browser pane request bridge', () => {
  test('an open push with no window open opens the window with the pane showing', async () => {
    // Main seeds the task URL before pushing, so the pane can resolve one and
    // mount its active subtree instead of the empty state.
    await sharedPage.evaluate((url) => {
      window.__mockBrowser?.reset();
      window.__mockBrowser?.seedTaskUrl('task-pane-bridge', url);
    }, SEEDED_URL);

    // Nothing is open yet: this is the state an agent hits `no-pane-open` in.
    await expect(sharedPage.locator('[data-testid="task-detail-dialog"]')).toHaveCount(0);

    await emitOpenRequest(sharedPage);

    await sharedPage
      .locator('[data-testid="task-detail-dialog"]')
      .waitFor({ state: 'visible', timeout: 10000 });
    await sharedPage.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test('an open push makes a pane sitting on the empty state pick up the seeded URL', async () => {
    // The case the refresh token exists for. Open the pane with NO URL saved so
    // it renders the empty state and registers nothing, then seed a URL the way
    // main does and push. The pane's fetch keys on taskId + projectId, so
    // without the nudge it would never see the new URL.
    await sharedPage.evaluate(() => window.__mockBrowser?.reset());

    const card = sharedPage
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Pane Bridge Task')
      .first();
    await card.click();
    await sharedPage
      .locator('[data-testid="task-detail-dialog"]')
      .waitFor({ state: 'visible', timeout: 10000 });
    await sharedPage.locator('[data-testid="browser-toggle"]').click();
    await sharedPage
      .locator('[data-testid="browser-empty-state"]')
      .waitFor({ state: 'visible', timeout: 10000 });

    await sharedPage.evaluate((url) => {
      window.__mockBrowser?.seedTaskUrl('task-pane-bridge', url);
    }, SEEDED_URL);
    await emitOpenRequest(sharedPage);

    await sharedPage.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 10000 });
    await expect(sharedPage.locator('[data-testid="browser-empty-state"]')).toHaveCount(0);
  });

  test('a close push hides the pane but leaves the task-detail window open', async () => {
    await sharedPage.evaluate((url) => {
      window.__mockBrowser?.reset();
      window.__mockBrowser?.seedTaskUrl('task-pane-bridge', url);
    }, SEEDED_URL);

    await emitOpenRequest(sharedPage);
    const dialog = sharedPage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await sharedPage.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 10000 });

    await sharedPage.evaluate(
      ([projectId, taskId]) => window.__mockBrowser?.emitPaneCloseRequest(projectId, [taskId]),
      [PROJECT_ID, TASK_ID],
    );

    await sharedPage.locator('[data-testid="browser-pane"]').waitFor({ state: 'hidden', timeout: 10000 });
    // Closing puts the PANE away, exactly as the Browser pill does. The window
    // it lives in is the user's, and this tool never closes it.
    await expect(dialog).toBeVisible();
  });
});
