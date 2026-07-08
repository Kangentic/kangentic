/**
 * UI test for the DiffViewer blame gutter (PR 6).
 *
 * Blame is off by default, toggled per file (diff-blame-toggle). When on, it
 * fetches window.electronAPI.git.blame (seeded via window.__mockBlame) and
 * renders a left-gutter `before`-content decoration
 * (.blame-gutter-annotation) on each blamed line of the modified editor.
 * Blame is unavailable (button disabled) for a binary or deleted file, and
 * while browsing a historical commit (DiffViewer's blameEligible prop).
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

const PROJECT_ID = 'proj-blame-gutter';
const TASK_ID = 'task-blame-gutter';
const SESSION_ID = 'sess-blame-gutter';

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/blamed.ts', status: 'M', insertions: 2, deletions: 1, original: 'line one\\nline two\\n', modified: 'line one\\nline two changed\\nline three\\n', language: 'typescript' },
      { path: 'assets/deleted.ts', status: 'D', insertions: 0, deletions: 3, original: 'gone\\n', modified: '', language: 'typescript' },
    ],
    totalInsertions: 2,
    totalDeletions: 4,
  };

  window.__mockBlame = {
    lines: [
      { line: 1, hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', shortHash: 'aaaaaaa', author: 'Ada', date: new Date().toISOString() },
      { line: 2, hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', shortHash: 'bbbbbbb', author: 'Bea', date: new Date().toISOString() },
      { line: 3, hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', shortHash: 'aaaaaaa', author: 'Ada', date: new Date().toISOString() },
    ],
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Blame Gutter Test',
      path: '/mock/blame-gutter-test',
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
      cwd: '/mock/blame-gutter-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Blame Gutter Task',
      description: 'Task used for the DiffViewer blame gutter test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/blame-gutter',
      branch_name: 'feature/blame-gutter',
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

/** Number of computed line changes in the live Monaco diff editor (-1 before ready). */
function readLineChangeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: { editor: { getDiffEditors: () => Array<{ getLineChanges?: () => unknown[] | null }> } } }).__monaco;
    if (!monaco) return -1;
    const diffEditors = monaco.editor.getDiffEditors();
    if (!diffEditors.length) return -1;
    const lineChanges = diffEditors[0].getLineChanges?.();
    return Array.isArray(lineChanges) ? lineChanges.length : -1;
  });
}

test.describe('DiffViewer: blame gutter', () => {
  test('toggling blame renders per-line gutter annotations; toggling off clears them', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Blame Gutter Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    await fileTree.locator('text=blamed.ts').click();
    await expect.poll(() => readLineChangeCount(page), { timeout: 15000 }).toBeGreaterThanOrEqual(0);

    const blameToggle = page.locator('[data-testid="diff-blame-toggle"]');
    await expect(blameToggle).toBeEnabled();
    await expect(blameToggle).toHaveAttribute('aria-pressed', 'false');

    await blameToggle.click();
    await expect(blameToggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(
      async () => page.locator('.blame-gutter-annotation').count(),
      { timeout: 10000 },
    ).toBeGreaterThan(0);

    await blameToggle.click();
    await expect(blameToggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(
      async () => page.locator('.blame-gutter-annotation').count(),
      { timeout: 10000 },
    ).toBe(0);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('blame is unavailable for a deleted file', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Blame Gutter Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    await fileTree.locator('text=deleted.ts').click();
    await expect(page.locator('[data-testid="diff-blame-toggle"]')).toBeDisabled();

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
