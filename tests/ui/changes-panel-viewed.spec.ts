/**
 * UI test for the Changes panel per-file "viewed" marks (PR 4).
 *
 * Each file row has a viewed checkbox; toggling it dims the row, flips
 * aria-pressed, and updates the "N/M viewed" count in the stats bar. State is
 * per-task panel state (session store). Uses the headless mock.
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

const PROJECT_ID = 'proj-viewed';
const TASK_ID = 'task-viewed';
const SESSION_ID = 'sess-viewed';

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/a.ts', status: 'M', insertions: 3, deletions: 1, original: 'old a', modified: 'new a', language: 'typescript' },
      { path: 'src/b.ts', status: 'M', insertions: 2, deletions: 0, original: 'old b', modified: 'new b', language: 'typescript' },
    ],
    totalInsertions: 5,
    totalDeletions: 1,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Viewed Test',
      path: '/mock/viewed-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-vw-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
      cwd: '/mock/viewed-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Viewed Task',
      description: 'Task used for Changes panel viewed-marks test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/viewed',
      branch_name: 'feature/viewed',
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

test.describe('Changes panel: viewed marks', () => {
  test('toggling a file viewed flips its checkbox and updates the viewed count', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Viewed Task')
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

    const toggleA = fileTree.locator('[data-testid="changes-viewed-toggle"][data-path="src/a.ts"]');
    await toggleA.waitFor({ state: 'visible', timeout: 8000 });

    // Reset viewed state: if src/a.ts was marked viewed by a previous failed
    // attempt, clear it so the initial assertion starts from a clean baseline.
    if ((await toggleA.getAttribute('aria-pressed')) === 'true') {
      await toggleA.click();
      await expect(toggleA).toHaveAttribute('aria-pressed', 'false', { timeout: 3000 });
    }

    // Initially nothing is viewed: no count chip, checkbox unpressed.
    const viewedCount = fileTree.locator('[data-testid="changes-viewed-count"]');
    await expect(viewedCount).toHaveCount(0);
    await expect(toggleA).toHaveAttribute('aria-pressed', 'false');

    // Mark src/a.ts viewed: checkbox flips, count reads 1/2.
    await toggleA.click();
    await expect(toggleA).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });
    await expect(viewedCount).toContainText('1/2 viewed', { timeout: 3000 });

    // Un-view it: checkbox flips back, count chip disappears.
    await toggleA.click();
    await expect(toggleA).toHaveAttribute('aria-pressed', 'false', { timeout: 3000 });
    await expect(viewedCount).toHaveCount(0, { timeout: 3000 });

    // Close panel + dialog so state does not leak to other tests.
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
