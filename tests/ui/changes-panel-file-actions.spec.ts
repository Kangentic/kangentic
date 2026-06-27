/**
 * UI test for the Changes panel file context menu (PR 4).
 *
 * Right-clicking a changed file opens a menu with Open in editor / Reveal in
 * file manager / Copy path. Verifies the menu renders and that Reveal calls
 * shell.showItemInFolder with the file's absolute path (recorded by the mock).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-file-actions';
const TASK_ID = 'task-file-actions';
const SESSION_ID = 'sess-file-actions';

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/index.ts', status: 'M', insertions: 4, deletions: 2, original: 'old', modified: 'new', language: 'typescript' },
    ],
    totalInsertions: 4,
    totalDeletions: 2,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'File Actions Test',
      path: '/mock/file-actions-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-fa-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/file-actions-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'File Actions Task',
      description: 'Task used for Changes panel file context menu test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/file-actions',
      branch_name: 'feature/file-actions',
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

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Changes panel: file context menu', () => {
  test('right-click offers open / reveal / copy, and reveal calls showItemInFolder with the absolute path', async () => {
    // Clear the call log so a retry does not read a path recorded in a
    // previous attempt.
    await page.evaluate(() => {
      (window as unknown as { __mockShowItemInFolderCalls: string[] }).__mockShowItemInFolderCalls = [];
    });

    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=File Actions Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    // Open the changes panel only if it is not already open. A previous failed
    // attempt may have left it open; clicking the toggle then would close it,
    // causing the fileRow wait below to time out on retry.
    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    const fileRow = fileTree.getByRole('button', { name: /index\.ts/ });
    await fileRow.waitFor({ state: 'visible', timeout: 8000 });

    // Right-click the file row to open the context menu.
    await fileRow.click({ button: 'right' });
    const menu = page.locator('[data-testid="changes-file-context-menu"]');
    // Explicit 8s timeout: under CI event-loop contention the React scheduling
    // of setContextMenu can be delayed past the default 5s polling budget.
    await expect(menu).toBeVisible({ timeout: 8000 });
    await expect(menu.locator('[data-testid="context-open-file"]')).toBeVisible({ timeout: 3000 });
    await expect(menu.locator('[data-testid="context-reveal-file"]')).toBeVisible({ timeout: 3000 });
    await expect(menu.locator('[data-testid="context-copy-path"]')).toBeVisible({ timeout: 3000 });

    // Wait for the reveal item to be fully ready before clicking it, then
    // confirm the menu closes before reading the call log.
    const revealItem = menu.locator('[data-testid="context-reveal-file"]');
    await revealItem.waitFor({ state: 'visible', timeout: 3000 });
    await revealItem.click();
    await expect(menu).toBeHidden({ timeout: 5000 });

    // Poll for the recorded call: showItemInFolder is invoked synchronously
    // before onClose(), but polling guards against any future scheduling
    // change between the click dispatch and page.evaluate().
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const calls = (window as unknown as { __mockShowItemInFolderCalls?: string[] })
              .__mockShowItemInFolderCalls;
            return calls && calls.length ? calls[calls.length - 1] : null;
          }),
        { timeout: 5000 },
      )
      .toBe('/mock/worktrees/file-actions/src/index.ts');

    // Close panel + dialog.
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
