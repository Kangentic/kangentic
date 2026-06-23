/**
 * UI test for the Changes panel branch header (PR 1).
 *
 * Verifies that the header surfaces the live branch context returned by
 * git.branchSummary: the current branch name, ahead/behind counts, and the
 * last-commit line. Uses the headless mock (window.__mockBranchSummary) so no
 * real git repo is needed.
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

const PROJECT_ID = 'proj-branch-header';
const TASK_ID = 'task-branch-header';
const SESSION_ID = 'sess-branch-header';

const preConfig = `
  window.__mockBranchSummary = {
    currentBranch: 'feature/enhance-changes',
    ahead: 3,
    behind: 1,
    lastCommit: { hash: 'abc1234', subject: 'wire branch summary into header', timestamp: new Date().toISOString() },
  };
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
      name: 'Branch Header Test',
      path: '/mock/branch-header-test',
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
      cwd: '/mock/branch-header-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Branch Header Task',
      description: 'Task used for Changes panel branch header test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/branch-header',
      branch_name: 'feature/enhance-changes',
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

test.describe('Changes panel: branch header', () => {
  test('shows branch name, ahead/behind, and last commit', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Branch Header Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Open the Changes panel via the header pill.
    await page.locator('[data-testid="changes-toggle"]').click();

    // Branch name from the mocked branchSummary is visible.
    await expect(dialog.locator('text=feature/enhance-changes').first()).toBeVisible({ timeout: 5000 });

    // Last-commit line: short hash + subject.
    const lastCommit = page.locator('[data-testid="changes-last-commit"]');
    await expect(lastCommit).toBeVisible();
    await expect(lastCommit).toContainText('abc1234');
    await expect(lastCommit).toContainText('wire branch summary into header');

    // Auto-fit: with a branch name + commit and no manual width (config null), the
    // tree sizes itself wider than the 220px floor so the header is readable.
    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    await expect.poll(async () => (await fileTree.boundingBox())!.width, { timeout: 5000 }).toBeGreaterThan(240);

    // Close panel + dialog so state does not leak to other tests.
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
