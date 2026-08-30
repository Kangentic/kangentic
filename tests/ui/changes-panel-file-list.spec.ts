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

const EXT_PROJECT_ID = 'proj-filelist-ext';
const EXT_TASK_ID = 'task-filelist-ext';
const EXT_SESSION_ID = 'sess-filelist-ext';

// File set chosen so extension-sort order differs from name order and from
// the status/size orders the primary test already covers, and so it pins the
// three semantics fileExtension() encodes:
//  - '' (extensionless 'Makefile' AND dotfile '.gitignore', whose only dot is
//    at index 0) sorts FIRST, ahead of every real extension;
//  - extension comparison is case-insensitive ('apple.ts' groups with
//    'Banana.TS');
//  - a multi-dot name takes only the LAST segment: 'widget.test.js' is 'js',
//    not 'test.js' or 'test'. 'zzz.test' (a genuine single-dot 'test'
//    extension) is the control that makes this fall out as an observable
//    order: with the correct last-segment extraction, 'js' < 'test'
//    alphabetically so widget.test.js sorts BEFORE zzz.test; the plausible
//    bug of taking everything after the FIRST dot would give widget.test.js
//    the extension 'test.js', which sorts AFTER 'test' (a prefix sorts
//    first), reversing that pair.
const extPreConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'Makefile', status: 'M', insertions: 1, deletions: 0, original: 'a', modified: 'b', language: 'plaintext' },
      { path: '.gitignore', status: 'M', insertions: 1, deletions: 0, original: 'a', modified: 'b', language: 'plaintext' },
      { path: 'widget.test.js', status: 'M', insertions: 1, deletions: 0, original: 'a', modified: 'b', language: 'javascript' },
      { path: 'zzz.test', status: 'M', insertions: 1, deletions: 0, original: 'a', modified: 'b', language: 'plaintext' },
      { path: 'apple.ts', status: 'M', insertions: 1, deletions: 0, original: 'a', modified: 'b', language: 'typescript' },
      { path: 'Banana.TS', status: 'M', insertions: 1, deletions: 0, original: 'a', modified: 'b', language: 'typescript' },
    ],
    totalInsertions: 6,
    totalDeletions: 0,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${EXT_PROJECT_ID}',
      name: 'FileList Ext Test',
      path: '/mock/filelist-ext-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-fle-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${EXT_SESSION_ID}',
      taskId: '${EXT_TASK_ID}',
      projectId: '${EXT_PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/filelist-ext-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${EXT_TASK_ID}',
      title: 'FileList Ext Task',
      description: 'Task used for Changes panel extension-sort test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${EXT_SESSION_ID}',
      worktree_path: '/mock/worktrees/filelist-ext',
      branch_name: 'feature/filelist-ext',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${EXT_PROJECT_ID}' };
  });
`;

test.describe('Changes panel: extension sort', () => {
  let extBrowser: Browser;
  let extPage: Page;

  test.beforeAll(async () => {
    const result = await launchWithState(extPreConfig);
    extBrowser = result.browser;
    extPage = result.page;
    await extPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await extBrowser?.close();
  });

  test('sorting by extension is case-insensitive, groups extensionless/dotfiles first, and uses only the last dot segment', async () => {
    const card = extPage
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=FileList Ext Task')
      .first();
    await card.click();

    const dialog = extPage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = extPage.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await extPage.locator('[data-testid="changes-toggle"]').click();
    }
    await fileTree.waitFor({ state: 'visible', timeout: 8000 });

    // None of these paths contain '/', so tree mode already renders them as
    // flat root-level rows - no need to toggle to the flat list.
    const sortButton = fileTree.locator('[data-testid="changes-sort"]');
    const sortMenu = extPage.locator('[data-testid="changes-sort-menu"]');
    await sortButton.click();
    await expect(sortMenu).toBeVisible({ timeout: 5000 });
    await sortMenu.locator('[data-testid="changes-sort-option-ext"]').click();
    await expect(sortMenu).not.toBeVisible({ timeout: 5000 });

    await expect.poll(async () => (await rowOrder(extPage)).length).toBe(6);
    const order = await rowOrder(extPage);

    // Extensionless ('Makefile') and dotfile ('.gitignore', dotIndex === 0)
    // both compute extension '' and sort first, ahead of every real extension.
    expect(new Set(order.slice(0, 2))).toEqual(new Set(['Makefile', '.gitignore']));

    // Last-segment-only: 'widget.test.js' is extension 'js' ('js' < 'test'),
    // sorting BEFORE the single-dot control 'zzz.test' (extension 'test').
    expect(order[2]).toBe('widget.test.js');
    expect(order[3]).toBe('zzz.test');

    // Case-insensitive grouping: 'apple.ts' and 'Banana.TS' both compute
    // extension 'ts' and land in the trailing pair, together.
    expect(new Set(order.slice(4, 6))).toEqual(new Set(['apple.ts', 'Banana.TS']));

    // Reopening the sort menu shows 'ext' checked.
    await sortButton.click();
    await expect(sortMenu).toBeVisible({ timeout: 5000 });
    await expect(sortMenu.locator('[data-testid="changes-sort-option-ext"]')).toHaveAttribute('aria-checked', 'true');
  });
});

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

    // The sort button opens a menu of modes with the current one checked.
    const sortButton = fileTree.locator('[data-testid="changes-sort"]');
    const sortMenu = page.locator('[data-testid="changes-sort-menu"]');
    await sortButton.click();
    await expect(sortMenu).toBeVisible({ timeout: 5000 });
    await expect(sortMenu.locator('[data-testid="changes-sort-option-name"]')).toHaveAttribute('aria-checked', 'true');

    // Status: additions, modifications, then deletions last - and in the flat
    // list, group headers appear at each status boundary.
    await sortMenu.locator('[data-testid="changes-sort-option-status"]').click();
    await expect(sortMenu).not.toBeVisible({ timeout: 5000 });
    await expect.poll(() => rowOrder(page)).toEqual(['src/added.ts', 'src/modified.ts', 'src/deleted.ts']);
    const groupRows = fileTree.locator('[data-testid="changes-group-row"]');
    await expect(groupRows).toHaveCount(3);
    // GitHub-style section headers: uppercase-styled label + count badge, in
    // status-rank order (the label casing is CSS, so text stays title-case).
    await expect(groupRows.nth(0)).toHaveAttribute('data-status', 'A');
    await expect(groupRows.nth(0)).toContainText('Added');
    await expect(groupRows.nth(1)).toHaveAttribute('data-status', 'M');
    await expect(groupRows.nth(1)).toContainText('Modified');
    await expect(groupRows.nth(2)).toHaveAttribute('data-status', 'D');
    await expect(groupRows.nth(2)).toContainText('Deleted');
    await expect(groupRows.nth(0)).toContainText('1');

    // Size: most changes first (modified 10, deleted 5, added 1), no group rows.
    await sortButton.click();
    await sortMenu.locator('[data-testid="changes-sort-option-size"]').click();
    await expect.poll(() => rowOrder(page)).toEqual(['src/modified.ts', 'src/deleted.ts', 'src/added.ts']);
    await expect(fileTree.locator('[data-testid="changes-group-row"]')).toHaveCount(0);

    // Restore defaults (name sort, tree view) so config does not leak to other tests.
    await sortButton.click();
    await sortMenu.locator('[data-testid="changes-sort-option-name"]').click();
    await fileTree.locator('[data-testid="changes-tree-flat"]').click(); // flat -> tree

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('Escape over the open sort menu closes only the menu, not the task window', async () => {
    // FileTreePanel's sort-menu Escape handler carries the same capture-phase
    // preventDefault + stopImmediatePropagation guard as KebabMenu, so the
    // task-detail window's own bubble-phase Escape-to-close listener never
    // sees the keystroke while the menu is open. A "menu not visible" check
    // alone cannot prove the guard fired (a leaked Escape closes the whole
    // dialog, which also hides the menu) - assert both: the menu closes AND
    // the dialog survives.
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=FileList Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }
    await fileTree.waitFor({ state: 'visible', timeout: 8000 });

    const sortButton = fileTree.locator('[data-testid="changes-sort"]');
    const sortMenu = page.locator('[data-testid="changes-sort-menu"]');
    await sortButton.click();
    await expect(sortMenu).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(sortMenu).not.toBeVisible({ timeout: 5000 });
    // Fixed budget, not a poll (anti-pattern 6: a negative assertion cannot be
    // polled for). A leaked Escape closes the dialog through its own ~150ms
    // CSS exit animation (--overlay-exit-duration), so checking visibility
    // immediately would pass even with the guard broken - the dialog is still
    // mid-animation and technically "visible" at that instant. Give the
    // animation a generous window to finish, then assert it is still there.
    await page.waitForTimeout(400);
    await expect(dialog).toBeVisible();

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
