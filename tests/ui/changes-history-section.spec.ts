/**
 * UI tests for the Changes rail's collapsible History section
 * (`changes-history-section`, ChangesHistorySection.tsx).
 *
 * History lives at the BOTTOM of the rail, CLOSED by default, and lists only
 * commits (no Uncommitted row: the scope control above the files is how the
 * working tree is reached). Collapsed, only the header row
 * (`changes-history-toggle`) shows, still carrying a live commit count - which
 * works because the CommitGraphPanel body stays MOUNTED (height 0) while
 * collapsed and reports its count up via onLoaded. Whether it is open is ONE
 * remembered choice for every task (AppConfig `changesHistoryOpen`), because
 * the reason to fold is rail height, which every task shares; a blob's retired
 * per-task `changesHistoryCollapsed` is ignored. The command-terminal Changes
 * embed has no task, so it renders no section at all.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-history-section';
const TASK_ID = 'task-history-section';
const SESSION_ID = 'sess-history-section';
const RESTORED_TASK_ID = 'task-history-restored';
const RESTORED_SESSION_ID = 'sess-history-restored';

const preConfig = `
  window.__mockCommitGraph = {
    commits: [
      { hash: 'hs-aaa', shortHash: 'hsaaaaa', parents: ['hs-bbb'], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'third commit' },
      { hash: 'hs-bbb', shortHash: 'hsbbbbb', parents: ['hs-ccc'], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'second commit' },
      { hash: 'hs-ccc', shortHash: 'hsccccc', parents: [], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'first commit' },
    ],
    tipHash: 'hs-aaa',
    baseHash: 'hs-ccc',
    mergeBaseHash: 'hs-ccc',
    currentBranch: 'feature/history-section',
    truncated: false,
  };

  window.__mockGitDiff = {
    files: [
      { path: 'docs/database.md', status: 'M', insertions: 2, deletions: 1, original: 'a', modified: 'b', language: 'markdown' },
    ],
    totalInsertions: 2,
    totalDeletions: 1,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'History Section Test',
      path: '/mock/history-section-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-hs-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9990,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/history-section-test',
      startedAt: ts,
      exitCode: null,
    });
    state.sessions.push({
      id: '${RESTORED_SESSION_ID}',
      taskId: '${RESTORED_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9991,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/history-section-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'History Section Task',
      description: '',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/history-section',
      branch_name: 'feature/history-section',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // A blob from before the fold became global: an open panel, and the retired
    // per-task collapse, which must now be ignored.
    state.tasks.push({
      id: '${RESTORED_TASK_ID}',
      title: 'History Restored Task',
      description: '',
      swimlane_id: laneIds['Code Review'],
      position: 1,
      agent: 'claude',
      session_id: '${RESTORED_SESSION_ID}',
      worktree_path: '/mock/worktrees/history-restored',
      branch_name: 'feature/history-restored',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
      detail_view_state: JSON.stringify({ changesOpen: true, changesHistoryCollapsed: true }),
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Changes rail: History section', () => {
  test('closed by default with a live count; opening it is remembered across tasks and dialog reopens', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=History Section Task').first();
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="changes-toggle"]').click();

    // Closed default: the graph is hidden, and the count stays live - the
    // mounted-hidden graph fetched and reported it up. This is the assertion
    // that fails if a collapsed section ever unmounts its body.
    const section = page.locator('[data-testid="changes-history-section"]');
    await section.waitFor({ state: 'visible', timeout: 10000 });
    const historyToggle = page.locator('[data-testid="changes-history-toggle"]');
    await expect(historyToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(historyToggle.locator('[data-testid="changes-history-count"]')).toHaveText('3', { timeout: 10000 });
    await expect(page.locator('[data-testid="commit-graph-panel"]')).not.toBeVisible();

    // Open it: commit rows and no Uncommitted row.
    await historyToggle.click();
    await expect(historyToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-testid="commit-graph-row"]')).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator('[data-testid="commit-history-uncommitted"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.electronAPI.config.get().then((config) => config.changesHistoryOpen))).toBe(true);

    // Another task opens with History open too: the choice is not per task.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
    await page.locator('[data-swimlane-name="Code Review"]').locator('text=History Restored Task').first().click();
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    await expect(historyToggle).toHaveAttribute('aria-expanded', 'true', { timeout: 10000 });

    // Fold it back (the default, for later tests) and close.
    await historyToggle.click();
    await expect(historyToggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => page.evaluate(() => window.electronAPI.config.get().then((config) => config.changesHistoryOpen))).toBe(false);
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('a blob carrying the retired per-task collapse follows the remembered choice instead', async () => {
    await page.evaluate(() => (window as unknown as {
      __zustandStores: { config: { getState: () => { updateConfig: (partial: { changesHistoryOpen: boolean }) => Promise<void> } } };
    }).__zustandStores.config.getState().updateConfig({ changesHistoryOpen: true }));
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=History Restored Task').first();
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    // changesOpen: true in the blob still opens the panel without a pill click,
    // and the blob's changesHistoryCollapsed: true no longer folds History.
    // (The first test closed this task's panel, so open it if the blob's
    // changesOpen no longer does.)
    const historyToggle = page.locator('[data-testid="changes-history-toggle"]');
    if (!(await historyToggle.isVisible())) await page.locator('[data-testid="changes-toggle"]').click();
    await expect(historyToggle).toHaveAttribute('aria-expanded', 'true', { timeout: 10000 });

    await historyToggle.click();
    await expect(historyToggle).toHaveAttribute('aria-expanded', 'false');
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('the command-terminal Changes embed (no task) renders no History section', async () => {
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    if (await dialog.isVisible()) {
      await page.keyboard.press('Control+Shift+W');
      await expect(dialog).not.toBeVisible({ timeout: 8000 });
    }

    await page.keyboard.press('Control+Shift+P');
    const changesToggle = page.locator('[data-testid="command-bar-changes-toggle"]');
    await changesToggle.waitFor({ state: 'visible', timeout: 8000 });
    await changesToggle.click();

    await page.locator('[data-testid="changes-file-tree"]').waitFor({ state: 'visible', timeout: 8000 });
    await expect(page.locator('[data-testid="changes-history-section"]')).toHaveCount(0);

    // Close the command terminal layer.
    await page.keyboard.press('Control+Shift+P');
  });
});
