/**
 * UI test for the Changes panel keyboard navigation (PR 4).
 *
 * - Alt+Shift+Down / Alt+Shift+Up select the next / previous changed file.
 * - Alt+Down steps through a file's changes and, past the last change, rolls
 *   into the next file, marking the file it left as viewed.
 * Uses the headless mock + the dev-exposed window.__monaco to await diff readiness.
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

const PROJECT_ID = 'proj-kbnav';
const TASK_ID = 'task-kbnav';
const SESSION_ID = 'sess-kbnav';

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/a.ts', status: 'M', insertions: 1, deletions: 1, original: 'old line a', modified: 'new line a', language: 'typescript' },
      { path: 'src/b.ts', status: 'M', insertions: 1, deletions: 1, original: 'old line b', modified: 'new line b', language: 'typescript' },
    ],
    totalInsertions: 2,
    totalDeletions: 2,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'KbNav Test',
      path: '/mock/kbnav-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-kb-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
      cwd: '/mock/kbnav-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'KbNav Task',
      description: 'Task used for Changes panel keyboard navigation test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/kbnav',
      branch_name: 'feature/kbnav',
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

function selectedRow(page: Page, filePath: string) {
  return page.locator(`[data-testid="changes-file-row"][data-path="${filePath}"][data-selected="true"]`);
}

async function lineChangeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: { editor: { getDiffEditors: () => Array<{ getLineChanges?: () => unknown[] | null }> } } }).__monaco;
    const editors = monaco?.editor?.getDiffEditors?.() ?? [];
    const changes = editors[0]?.getLineChanges?.() ?? null;
    return changes ? changes.length : 0;
  });
}

test.describe('Changes panel: keyboard navigation', () => {
  test('Alt+Shift+Arrow selects the next/previous file', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=KbNav Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('[data-testid="changes-toggle"]').click();

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    await expect(fileTree).toBeVisible({ timeout: 5000 });

    // Start on src/a.ts.
    await fileTree.locator('[data-testid="changes-file-row"][data-path="src/a.ts"]').click();
    await expect(selectedRow(page, 'src/a.ts')).toBeVisible({ timeout: 5000 });

    // Next file -> src/b.ts.
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await expect(selectedRow(page, 'src/b.ts')).toBeVisible();

    // Previous file -> back to src/a.ts.
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await expect(selectedRow(page, 'src/a.ts')).toBeVisible();

    // Close panel + dialog so state does not leak to other tests.
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('Alt+Down rolls past a file\'s last change into the next file and marks it viewed', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=KbNav Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('[data-testid="changes-toggle"]').click();

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    await fileTree.locator('[data-testid="changes-file-row"][data-path="src/a.ts"]').click();
    await expect(selectedRow(page, 'src/a.ts')).toBeVisible({ timeout: 5000 });

    // Wait until Monaco has computed src/a.ts's single change so the first press
    // steps to it rather than rolling immediately.
    await expect.poll(() => lineChangeCount(page), { timeout: 10000 }).toBeGreaterThan(0);

    // First press: land on the file's only change. Second: past the last change,
    // roll into src/b.ts and mark src/a.ts viewed.
    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Alt+ArrowDown');

    await expect(selectedRow(page, 'src/b.ts')).toBeVisible({ timeout: 5000 });
    await expect(
      fileTree.locator('[data-testid="changes-viewed-toggle"][data-path="src/a.ts"]'),
    ).toHaveAttribute('aria-pressed', 'true');

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
