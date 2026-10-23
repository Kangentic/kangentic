/**
 * UI tests for the Changes rail's commit selection bar (CommitSelectionBar.tsx).
 *
 * Selecting a History row swaps the scope control (Working / Staged / Branch)
 * for a bar of the same height in the same slot: the commit's hash and subject,
 * and an x that goes back to the scope the user was on. The tests pin that the
 * swap moves nothing below it, what each tooltip says, and the Escape layering:
 * Escape lets go of the commit before the window's own Escape would close the
 * window, and yields to an open menu and to a focused text field.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

// Each test launches its own browser, so the file fans out across UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-selection-bar';
const TASK_ID = 'task-selection-bar';
const SESSION_ID = 'sess-selection-bar';
const TIP_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PARENT_COMMIT = 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1';

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/working-one.ts', status: 'M', insertions: 2, deletions: 1, original: 'a', modified: 'b', language: 'typescript' },
      { path: 'src/working-two.ts', status: 'A', insertions: 5, deletions: 0, original: '', modified: 'c', language: 'typescript' },
    ],
    totalInsertions: 7,
    totalDeletions: 1,
  };
  window.__mockGitDiffByCommit = {
    '${TIP_COMMIT}': {
      files: [
        { path: 'src/committed.ts', status: 'M', insertions: 3, deletions: 1, original: 'old', modified: 'new', language: 'typescript' },
      ],
      totalInsertions: 3,
      totalDeletions: 1,
    },
  };
  window.__mockCommitGraph = {
    commits: [
      { hash: '${TIP_COMMIT}', shortHash: 'a1b2c3d', parents: ['${PARENT_COMMIT}'], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'wire the selection bar' },
      { hash: '${PARENT_COMMIT}', shortHash: 'b2c3d4e', parents: [], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'start the branch' },
    ],
    tipHash: '${TIP_COMMIT}',
    baseHash: '${PARENT_COMMIT}',
    mergeBaseHash: '${PARENT_COMMIT}',
    currentBranch: 'feature/selection-bar',
    truncated: false,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Selection Bar Test', path: '/mock/selection-bar-test', github_url: null,
      default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-sb-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9980, status: 'running',
      shell: 'bash', cwd: '/mock/selection-bar-test', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Selection Bar Task', description: '', swimlane_id: laneIds['Code Review'],
      position: 0, agent: 'claude', session_id: '${SESSION_ID}', worktree_path: '/mock/worktrees/selection-bar',
      branch_name: 'feature/selection-bar', pr_number: null, pr_url: null, base_branch: 'main',
      archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchWithChangesOpen(): Promise<{ browser: Browser; page: Page; dialog: Locator }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Selection Bar Task').first().click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('[data-testid="changes-toggle"]').click();
  await page.locator('[data-testid="changes-file-row"][data-path="src/working-one.ts"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('[data-testid="commit-graph-row"]').first().waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page, dialog };
}

function commitRowSelect(page: Page, subject: string): Locator {
  return page.locator('[data-testid="commit-graph-row"]').filter({ hasText: subject }).locator('[data-testid="commit-graph-row-select"]');
}

/** The top of the file list's first row: what would move if the slot above it changed height. */
async function firstFileRowTop(page: Page): Promise<number> {
  const box = await page.locator('[data-testid="changes-file-row"]').first().boundingBox();
  if (!box) throw new Error('no file row rendered');
  return box.y;
}

test.describe('Changes rail: commit selection bar', () => {
  test('the bar takes the scope control\'s slot at its height, so the file list does not move', async () => {
    const { browser, page } = await launchWithChangesOpen();
    try {
      const scopeControl = page.locator('[data-testid="changes-scope-select"]');
      const scopeHeight = (await scopeControl.boundingBox())!.height;
      const topBefore = await firstFileRowTop(page);

      await commitRowSelect(page, 'wire the selection bar').click();
      const bar = page.locator('[data-testid="commit-selection-bar"]');
      await expect(bar).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="changes-file-row"][data-path="src/committed.ts"]')).toBeVisible({ timeout: 10000 });
      await expect(scopeControl).toHaveCount(0);
      // One pixel of tolerance absorbs sub-pixel rounding between platforms.
      expect(Math.abs((await bar.boundingBox())!.height - scopeHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs((await firstFileRowTop(page)) - topBefore)).toBeLessThanOrEqual(1);

      // And back: the x restores the control with nothing below it moving.
      await page.locator('[data-testid="commit-selection-close"]').click();
      await expect(scopeControl).toBeVisible();
      await expect(page.locator('[data-testid="changes-file-row"][data-path="src/working-one.ts"]')).toBeVisible();
      expect(Math.abs((await firstFileRowTop(page)) - topBefore)).toBeLessThanOrEqual(1);
    } finally {
      await browser.close();
    }
  });

  test('the bar names the commit, and its x says which scope it goes back to', async () => {
    const { browser, page } = await launchWithChangesOpen();
    try {
      // Pick Staged first, so the x's tip names the scope the user was on, not a default.
      await page.locator('[data-testid="changes-scope-staged"]').click();
      await expect(page.locator('[data-testid="changes-scope-staged"]')).toHaveAttribute('aria-checked', 'true');

      await commitRowSelect(page, 'wire the selection bar').click();
      const bar = page.locator('[data-testid="commit-selection-bar"]');
      await expect(bar.locator('[data-testid="commit-selection-hash"]')).toHaveText('a1b2c3d', { timeout: 10000 });
      await expect(bar.locator('[data-testid="commit-selection-subject"]')).toHaveText('wire the selection bar');

      const close = page.locator('[data-testid="commit-selection-close"]');
      await expect(close).toHaveAccessibleName('Deselect commit');
      await expect(close).toHaveAccessibleDescription('Back to Staged');

      await close.click();
      await expect(page.locator('[data-testid="changes-scope-staged"]')).toHaveAttribute('aria-checked', 'true');
    } finally {
      await browser.close();
    }
  });

  test('Escape lets go of the commit and keeps the window; the next Escape closes the window', async () => {
    const { browser, page, dialog } = await launchWithChangesOpen();
    try {
      await commitRowSelect(page, 'wire the selection bar').click();
      const bar = page.locator('[data-testid="commit-selection-bar"]');
      await expect(bar).toBeVisible({ timeout: 10000 });

      await page.keyboard.press('Escape');
      await expect(bar).toHaveCount(0);
      await expect(page.locator('[data-testid="changes-scope-select"]')).toBeVisible();
      await expect(page.locator('[data-testid="changes-file-row"][data-path="src/working-one.ts"]')).toBeVisible();
      await expect(dialog).toBeVisible();

      // With no commit selected the panel has nothing to let go of, so the
      // window's own Escape runs.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0, { timeout: 8000 });
    } finally {
      await browser.close();
    }
  });

  test('Escape with a file menu open closes only the menu, and the commit stays selected', async () => {
    const { browser, page, dialog } = await launchWithChangesOpen();
    try {
      await commitRowSelect(page, 'wire the selection bar').click();
      const bar = page.locator('[data-testid="commit-selection-bar"]');
      await expect(bar).toBeVisible({ timeout: 10000 });

      const committedRow = page.locator('[data-testid="changes-file-row"][data-path="src/committed.ts"]');
      await committedRow.click({ button: 'right' });
      const menu = page.locator('[data-testid="changes-file-context-menu"]');
      await expect(menu).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(bar).toBeVisible();
      await expect(committedRow).toBeVisible();
      await expect(dialog).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Escape in the file filter leaves the commit selected', async () => {
    const { browser, page } = await launchWithChangesOpen();
    try {
      await commitRowSelect(page, 'wire the selection bar').click();
      const bar = page.locator('[data-testid="commit-selection-bar"]');
      await expect(bar).toBeVisible({ timeout: 10000 });

      const filter = page.getByPlaceholder('Filter files...');
      await filter.click();
      await filter.fill('committed');
      await page.keyboard.press('Escape');
      await expect(bar).toBeVisible();
      await expect(bar.locator('[data-testid="commit-selection-hash"]')).toHaveText('a1b2c3d');
    } finally {
      await browser.close();
    }
  });
});
