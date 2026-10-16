/**
 * UI test for the DiffViewer blame gutter (PR 6).
 *
 * Blame is off by default and toggled per file from the diff toolbar's
 * "View options" menu (`diff-view-options` -> `diff-blame-toggle`, a
 * `menuitemcheckbox`). When on, it fetches window.electronAPI.git.blame
 * (seeded via window.__mockBlame) and renders a left-gutter `before`-content
 * decoration (.blame-gutter-annotation) on each blamed line of the modified
 * editor. Blame is unavailable (the menu item disabled) for a binary or
 * deleted file, and while browsing a historical commit (DiffViewer's
 * blameEligible prop). The gutter also survives a same-file refresh, which swaps
 * new text into the mounted editor and so drops the decorations it had.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, waitForDiffToSettle } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-blame-gutter';
const TASK_ID = 'task-blame-gutter';
const SESSION_ID = 'sess-blame-gutter';

// The file the same-file refresh test owns. Its modified side grows from three
// lines to six, with no trailing newline so the line counts are exact, and the
// test blames its first five lines, so the gutter shows three annotations
// before the refresh (only three lines exist) and five after it.
const REFRESH_FILE_PATH = 'src/refreshed.ts';
const REFRESH_ORIGINAL = 'alpha\nbeta';
const REFRESH_INITIAL_MODIFIED = 'alpha\nbeta changed\ngamma';
const REFRESH_INITIAL_LINES = 3;
const REFRESH_NEW_MODIFIED = 'alpha\nbeta changed\ngamma\ndelta\nepsilon\nzeta';
const REFRESH_NEW_LINES = 6;
const REFRESH_BLAMED_LINES = 5;

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/blamed.ts', status: 'M', insertions: 2, deletions: 1, original: 'line one\\nline two\\n', modified: 'line one\\nline two changed\\nline three\\n', language: 'typescript' },
      { path: 'assets/deleted.ts', status: 'D', insertions: 0, deletions: 3, original: 'gone\\n', modified: '', language: 'typescript' },
      // A non-image binary: an image would open in the image view, which has no View options menu at all.
      { path: 'assets/font.woff2', status: 'M', insertions: 0, deletions: 0, binary: true, original: '', modified: '', language: 'plaintext' },
      // Owned by the same-file refresh test, which rewrites its text. No other test opens it.
      { path: ${JSON.stringify(REFRESH_FILE_PATH)}, status: 'M', insertions: 2, deletions: 1, original: ${JSON.stringify(REFRESH_ORIGINAL)}, modified: ${JSON.stringify(REFRESH_INITIAL_MODIFIED)}, language: 'typescript' },
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

  // A single historical commit, whose diff repeats blamed.ts, so a test can
  // select it and confirm blame becomes unavailable while browsing (DiffViewer's
  // blameEligible prop - blame always reflects the file's CURRENT working-tree
  // content/line numbers, which do not necessarily match a historical commit).
  window.__mockGitDiffByCommit = {
    'commit-blame-eligible': {
      files: [
        { path: 'src/blamed.ts', status: 'M', insertions: 1, deletions: 0, original: 'line one\\n', modified: 'line one\\nline two\\n', language: 'typescript' },
      ],
      totalInsertions: 1,
      totalDeletions: 0,
    },
  };

  window.__mockCommitGraph = {
    commits: [
      { hash: 'commit-blame-eligible', shortHash: 'blame01', parents: [], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'touch blamed.ts' },
    ],
    tipHash: 'commit-blame-eligible',
    baseHash: 'commit-blame-eligible',
    mergeBaseHash: 'commit-blame-eligible',
    currentBranch: 'feature/blame-gutter',
    truncated: false,
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

/** Line count of the live diff editor's modified model (-1 with no editor or model). */
function readModifiedLineCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const monaco = (window as unknown as {
      __monaco?: { editor: { getDiffEditors: () => Array<{ getModifiedEditor: () => { getModel: () => { getLineCount: () => number } | null } }> } };
    }).__monaco;
    const diffEditors = monaco?.editor.getDiffEditors() ?? [];
    if (diffEditors.length === 0) return -1;
    return diffEditors[0].getModifiedEditor().getModel()?.getLineCount() ?? -1;
  });
}

/** Open the diff toolbar's "View options" menu and return the blame item. */
async function openBlameOption(page: Page) {
  await page.locator('[data-testid="diff-view-options"]').click();
  const menu = page.locator('[data-testid="diff-view-options-menu"]');
  await expect(menu).toBeVisible({ timeout: 8000 });
  return menu.locator('[data-testid="diff-blame-toggle"]');
}

/** Dismiss the menu so it never overlays the editor being asserted on. */
async function closeViewOptions(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="diff-view-options-menu"]')).not.toBeVisible({ timeout: 8000 });
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

    const blameToggle = await openBlameOption(page);
    await expect(blameToggle).toBeEnabled();
    await expect(blameToggle).toHaveAttribute('aria-checked', 'false');

    await blameToggle.click();
    await expect(blameToggle).toHaveAttribute('aria-checked', 'true');
    await closeViewOptions(page);
    await expect.poll(
      async () => page.locator('.blame-gutter-annotation').count(),
      { timeout: 10000 },
    ).toBeGreaterThan(0);

    const blameToggleAgain = await openBlameOption(page);
    await blameToggleAgain.click();
    await expect(blameToggleAgain).toHaveAttribute('aria-checked', 'false');
    await closeViewOptions(page);
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
    await expect(await openBlameOption(page)).toBeDisabled();
    await closeViewOptions(page);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('blame is unavailable for a binary file', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Blame Gutter Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    await fileTree.locator('text=font.woff2').click();
    await expect(await openBlameOption(page)).toBeDisabled();
    await closeViewOptions(page);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('blame is unavailable while browsing a historical commit, and re-enables when returning to Uncommitted', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Blame Gutter Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    // Sanity: on Uncommitted, blamed.ts's option starts enabled.
    await fileTree.locator('text=blamed.ts').click();
    await expect(await openBlameOption(page)).toBeEnabled();
    await closeViewOptions(page);

    // Expand the (default-collapsed) History section to reveal the commit rows.
    const historyToggle = page.locator('[data-testid="changes-history-toggle"]');
    await historyToggle.waitFor({ state: 'visible', timeout: 10000 });
    if ((await historyToggle.getAttribute('aria-expanded')) !== 'true') {
      await historyToggle.click();
    }

    // Select the historical commit that also touches blamed.ts - the same
    // file path, but blame is not eligible while browsing a commit (content
    // and line numbers may not match the file's current working-tree state).
    await page.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'touch blamed.ts' }).click();
    await expect(page.locator('[data-testid="commit-detail-header"]')).toBeVisible({ timeout: 10000 });
    await fileTree.locator('text=blamed.ts').click();
    await expect(await openBlameOption(page)).toBeDisabled();
    await closeViewOptions(page);

    // Returning to Uncommitted re-enables blame for the same file.
    await page.locator('[data-testid="commit-detail-back"]').click();
    await expect(page.locator('[data-testid="commit-detail-header"]')).not.toBeVisible({ timeout: 10000 });
    await fileTree.locator('text=blamed.ts').click();
    await expect(await openBlameOption(page)).toBeEnabled();
    await closeViewOptions(page);

    // Re-collapse History: it is persisted per task (changesHistoryOpen), so
    // leaving it expanded hands the next reopen a state the documented default
    // says is collapsed. Guarded and asserted, matching commit-graph-panel's
    // closeChangesPanelAndDialog.
    if ((await historyToggle.getAttribute('aria-expanded')) === 'true') {
      await historyToggle.click();
    }
    await expect(historyToggle).toHaveAttribute('aria-expanded', 'false');

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  // The panel refetches the open file on every fs.watch push and DiffViewer swaps
  // the new text into the mounted editor. The swap rewrites the modified model,
  // which drops its decorations, so the blame gutter comes back only because the
  // onDidUpdateDiff listener re-applies it once the new diff lands. Blame data
  // itself is fetched when the toggle turns on, not on a refresh, so the gutter
  // is rebuilt from the same blame lines against the new text: three annotations
  // on a three-line file, five on the six-line file that replaces it.
  test('blame survives a same-file refresh of the open file', async () => {
    test.slow();
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Blame Gutter Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    // __mockBlame is global and the other tests rely on its three lines, so the
    // wider blame this test needs is put back in the finally below.
    await page.evaluate((blamedLines) => {
      const pageWindow = window as unknown as { __mockBlame: unknown; __mockBlameBeforeRefreshTest?: unknown };
      pageWindow.__mockBlameBeforeRefreshTest = pageWindow.__mockBlame;
      pageWindow.__mockBlame = {
        lines: Array.from({ length: blamedLines }, (_unused, index) => ({
          line: index + 1,
          hash: 'c'.repeat(40),
          shortHash: 'ccccccc',
          author: 'Cy',
          date: new Date().toISOString(),
        })),
      };
    }, REFRESH_BLAMED_LINES);

    try {
      await fileTree.locator(`text=${path.posix.basename(REFRESH_FILE_PATH)}`).click();
      await expect.poll(() => readModifiedLineCount(page), { timeout: 15000 }).toBe(REFRESH_INITIAL_LINES);
      await waitForDiffToSettle(page);

      const blameToggle = await openBlameOption(page);
      await expect(blameToggle).toBeEnabled();
      await blameToggle.click();
      await expect(blameToggle).toHaveAttribute('aria-checked', 'true');
      await closeViewOptions(page);
      await expect.poll(
        async () => page.locator('.blame-gutter-annotation').count(),
        { timeout: 10000 },
      ).toBe(REFRESH_INITIAL_LINES);

      await page.evaluate(({ filePath, refreshedModified }) => {
        const pageWindow = window as unknown as {
          __mockGitDiff: { files: Array<{ path: string; modified: string }> };
          __mockFireDiffChanged: () => void;
        };
        const entry = pageWindow.__mockGitDiff.files.find((file) => file.path === filePath);
        if (!entry) throw new Error(`no fixture entry for ${filePath}`);
        entry.modified = refreshedModified;
        pageWindow.__mockFireDiffChanged();
      }, { filePath: REFRESH_FILE_PATH, refreshedModified: REFRESH_NEW_MODIFIED });

      // The new text is in the models, and its diff has landed and gone quiet.
      // The wait is on the line count, not on the first change line, which is
      // line 2 in both texts.
      await expect.poll(() => readModifiedLineCount(page), { timeout: 10000 }).toBe(REFRESH_NEW_LINES);
      await waitForDiffToSettle(page);

      // The gutter is on the new content. Five blamed lines now exist, where
      // the swap's setValue had left none.
      await expect.poll(
        async () => page.locator('.blame-gutter-annotation').count(),
        { timeout: 10000 },
      ).toBe(REFRESH_BLAMED_LINES);
    } finally {
      await page.evaluate(() => {
        const pageWindow = window as unknown as { __mockBlame: unknown; __mockBlameBeforeRefreshTest?: unknown };
        pageWindow.__mockBlame = pageWindow.__mockBlameBeforeRefreshTest;
        delete pageWindow.__mockBlameBeforeRefreshTest;
      });
    }

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
