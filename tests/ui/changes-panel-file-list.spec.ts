/**
 * UI test for the Changes panel file-list controls (PR 4): sort + tree/flat.
 *
 * - The tree/flat toggle switches between a nested directory tree (basenames)
 *   and a flat list of full repo-relative paths.
 * - The sort control cycles name -> status -> size and reorders the files.
 * Uses the headless mock; config-backed, so it reorders deterministically.
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

const PROJECT_ID = 'proj-filelist';
const TASK_ID = 'task-filelist';
const SESSION_ID = 'sess-filelist';

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/added.ts', status: 'A', insertions: 1, deletions: 0, original: '', modified: 'a', language: 'typescript' },
      { path: 'src/deleted.ts', status: 'D', insertions: 0, deletions: 5, original: 'd', modified: '', language: 'typescript' },
      { path: 'src/modified.ts', status: 'M', insertions: 10, deletions: 0, original: 'm', modified: 'mm', language: 'typescript' },
    ],
    totalInsertions: 11,
    totalDeletions: 5,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'FileList Test',
      path: '/mock/filelist-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-fl-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
      cwd: '/mock/filelist-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'FileList Task',
      description: 'Task used for Changes panel file-list controls test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/filelist',
      branch_name: 'feature/filelist',
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

function rowOrder(page: Page): Promise<(string | null)[]> {
  return page
    .locator('[data-testid="changes-file-row"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-path')));
}

test.describe('Changes panel: file-list controls', () => {
  test('tree/flat toggle and sort reorder the files', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=FileList Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    // Open the changes panel only if not already open. A previous failed
    // attempt may have left it open; clicking the toggle then would close it.
    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }
    await fileTree.waitFor({ state: 'visible', timeout: 8000 });

    const addedRow = fileTree.locator('[data-testid="changes-file-row"][data-path="src/added.ts"]');

    // Tree mode (default): the file row shows the basename, not the full path.
    await expect(addedRow).toContainText('added.ts');
    await expect(addedRow).not.toContainText('src/added.ts');

    // Toggle to a flat list: the row now shows the full repo-relative path.
    await fileTree.locator('[data-testid="changes-tree-flat"]').click();
    await expect(addedRow).toContainText('src/added.ts');

    // Sort by name (default): alphabetical by path.
    await expect.poll(() => rowOrder(page)).toEqual(['src/added.ts', 'src/deleted.ts', 'src/modified.ts']);

    // Cycle to status: additions, modifications, then deletions last.
    await fileTree.locator('[data-testid="changes-sort"]').click();
    await expect.poll(() => rowOrder(page)).toEqual(['src/added.ts', 'src/modified.ts', 'src/deleted.ts']);

    // Cycle to size: most changes first (modified 10, deleted 5, added 1).
    await fileTree.locator('[data-testid="changes-sort"]').click();
    await expect.poll(() => rowOrder(page)).toEqual(['src/modified.ts', 'src/deleted.ts', 'src/added.ts']);

    // Restore defaults (name sort, tree view) so config does not leak to other tests.
    await fileTree.locator('[data-testid="changes-sort"]').click(); // size -> name
    await fileTree.locator('[data-testid="changes-tree-flat"]').click(); // flat -> tree

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
