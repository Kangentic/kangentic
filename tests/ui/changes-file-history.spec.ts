/**
 * UI test for the Changes panel's per-file history popover (PR 6).
 *
 * Right-clicking a file offers "View history" (context-file-history) in the
 * context menu; selecting it opens a popover (changes-file-history) listing
 * the commits that touched the file (seeded via window.__mockFileHistory,
 * newest first). Selecting a history row scopes the Changes panel's detail
 * pane to that commit (reusing the same changesSelectedCommit selection the
 * history-browser graph drives), seeded via window.__mockGitDiffByCommit.
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

const PROJECT_ID = 'proj-file-history';
const TASK_ID = 'task-file-history';
const SESSION_ID = 'sess-file-history';

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/index.ts', status: 'M', insertions: 4, deletions: 2, original: 'old', modified: 'new', language: 'typescript' },
    ],
    totalInsertions: 4,
    totalDeletions: 2,
  };

  window.__mockFileHistory = {
    commits: [
      { hash: 'newer-commit', shortHash: 'newerco', authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'refine index' },
      { hash: 'older-commit', shortHash: 'olderco', authorName: 'Bea', authorTimestamp: new Date().toISOString(), subject: 'introduce index' },
    ],
  };

  window.__mockGitDiffByCommit = {
    'older-commit': {
      files: [
        { path: 'src/index.ts', status: 'A', insertions: 10, deletions: 0, original: '', modified: 'introduced', language: 'typescript' },
      ],
      totalInsertions: 10,
      totalDeletions: 0,
    },
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'File History Test',
      path: '/mock/file-history-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
      cwd: '/mock/file-history-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'File History Task',
      description: 'Task used for the per-file history popover test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/file-history',
      branch_name: 'feature/file-history',
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

test.describe('Changes panel: per-file history popover', () => {
  test('View history lists the commits that touched the file; selecting one scopes the detail to that commit', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=File History Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    const fileRow = fileTree.getByRole('button', { name: /index\.ts/ });
    await fileRow.waitFor({ state: 'visible', timeout: 8000 });

    await fileRow.click({ button: 'right' });
    const menu = page.locator('[data-testid="changes-file-context-menu"]');
    await expect(menu).toBeVisible({ timeout: 8000 });

    const historyItem = menu.locator('[data-testid="context-file-history"]');
    await expect(historyItem).toBeVisible({ timeout: 3000 });
    await historyItem.click();
    await expect(menu).toBeHidden({ timeout: 5000 });

    const popover = page.locator('[data-testid="changes-file-history"]');
    await expect(popover).toBeVisible({ timeout: 8000 });
    const rows = popover.locator('[data-testid="changes-file-history-row"]');
    await expect(rows).toHaveCount(2, { timeout: 8000 });
    await expect(rows.nth(0)).toContainText('refine index');
    await expect(rows.nth(1)).toContainText('introduce index');

    // Selecting the older commit scopes the detail pane to that commit's diff.
    await rows.filter({ hasText: 'introduce index' }).click();
    await expect(popover).toBeHidden({ timeout: 5000 });
    await expect(page.locator('[data-testid="commit-detail-header"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="commit-detail-header"]')).toContainText('+10/-0');

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
