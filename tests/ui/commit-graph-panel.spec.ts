/**
 * UI tests for the Task Detail commit-graph pane.
 *
 * Opens a dialog on a task with an active session (so TaskDetailBody renders,
 * not the edit form) and exercises the Graph header pill: it toggles the pane,
 * renders the SVG DAG + one row per commit, is mutually exclusive with the
 * Changes pane, and shows the empty / truncated states. The commit graph is
 * seeded through the mock via window.__mockCommitGraph.
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

const PROJECT_ID = 'proj-commit-graph';
const TASK_ID = 'task-commit-graph';
const SESSION_ID = 'sess-commit-graph';

// Three-commit linear fixture; the tip carries the HEAD badge, the root the base badge.
const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    window.__mockCommitGraph = {
      commits: [
        { hash: 'commit-aaa', shortHash: 'aaaaaaa', parents: ['commit-bbb'], authorName: 'Ada', authorTimestamp: ts, subject: 'third commit' },
        { hash: 'commit-bbb', shortHash: 'bbbbbbb', parents: ['commit-ccc'], authorName: 'Ada', authorTimestamp: ts, subject: 'second commit' },
        { hash: 'commit-ccc', shortHash: 'ccccccc', parents: [], authorName: 'Ada', authorTimestamp: ts, subject: 'first commit' },
      ],
      tipHash: 'commit-aaa',
      baseHash: 'commit-ccc',
      mergeBaseHash: 'commit-ccc',
      currentBranch: 'feature/commit-graph',
      truncated: false,
    };

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Commit Graph Test',
      path: '/mock/commit-graph-test',
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
      cwd: '/mock/commit-graph-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Commit Graph Task',
      description: 'Task used for commit-graph pane test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/commit-graph',
      branch_name: 'feature/commit-graph',
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

test.describe('Task Detail commit-graph pane', () => {
  test('toggles the pane, renders the DAG, and is mutually exclusive with Changes', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Commit Graph Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The Graph pill is available (task has a worktree). Pane is closed initially.
    const graphPill = page.locator('[data-testid="graph-toggle"]');
    await expect(graphPill).toBeVisible();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).not.toBeVisible();

    // Open the pane: the SVG plus one row per fixture commit render. React
    // re-render after the pill click can be slow on CI Linux, so give a budget.
    await graphPill.click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="commit-graph-row"]')).toHaveCount(3, { timeout: 10000 });
    // The tip commit is marked HEAD; the branch base is labelled with the base branch.
    await expect(page.getByText('HEAD', { exact: true })).toBeVisible();
    await expect(page.getByText('third commit')).toBeVisible();

    // Mutual exclusivity: opening Changes closes the Graph pane.
    await page.locator('[data-testid="changes-toggle"]').click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).not.toBeVisible({ timeout: 10000 });

    // Re-opening Graph closes Changes again (only one right panel at a time).
    await graphPill.click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="changes-expand"]')).not.toBeVisible();
  });

  test('shows the empty state and the truncated footer from the seeded result', async () => {
    const graphPill = page.locator('[data-testid="graph-toggle"]');

    // Empty result -> empty-state message. Re-seed then remount the pane (close +
    // reopen) so the fresh fetch reads the new fixture.
    await page.evaluate(() => {
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
        commits: [],
        tipHash: null,
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: null,
        truncated: false,
      };
    });
    await graphPill.click(); // close
    await expect(page.locator('[data-testid="commit-graph-svg"]')).not.toBeVisible({ timeout: 10000 });
    await graphPill.click(); // reopen -> refetch empty
    await expect(page.getByText('No git history available.')).toBeVisible({ timeout: 10000 });

    // Truncated result -> footer note.
    await page.evaluate(() => {
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
        commits: [
          { hash: 'c1', shortHash: 'c1', parents: [], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'only commit' },
        ],
        tipHash: 'c1',
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: 'feature/commit-graph',
        truncated: true,
      };
    });
    await graphPill.click(); // close
    await expect(page.locator('[data-testid="commit-graph-svg"]')).not.toBeVisible({ timeout: 10000 });
    await graphPill.click(); // reopen -> refetch truncated
    await expect(page.getByText(/Showing latest \d+ commits/)).toBeVisible({ timeout: 10000 });

    // Close the pane and dialog so state does not leak to other tests.
    await graphPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
  });
});
