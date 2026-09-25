/**
 * UI test: a persisted `changesSelectedFile` that is NOT in the current diff.
 *
 * Reproduces a shipped bug. A task whose worktree has since gone clean (or
 * whose selected file was reverted) still carried the persisted selection, and
 * ChangesPanel's restore effect handled only two cases - "the file is still
 * listed" and "pick the first of a non-empty list". With an EMPTY list neither
 * fired, so the stale path stayed selected: the diff toolbar showed a filename
 * that no longer existed and the editor sat on its boot spinner forever,
 * because content is only ever fetched for a listed file.
 *
 * Red condition: delete the `if (selectedFile) setSelectedFile(null);` fall-
 * through at the end of ChangesPanel's restore effect and this test fails on
 * the phantom-filename assertion (and then on the never-resolving spinner).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-stale-selection';
const CLEAN_TASK_ID = 'task-stale-clean';
const CLEAN_SESSION_ID = 'sess-stale-clean';
const LOADING_TASK_ID = 'task-stale-loading';
const LOADING_SESSION_ID = 'sess-stale-loading';

const preConfig = `
  // A clean worktree: the diff has no files at all.
  window.__mockGitDiff = { files: [], totalInsertions: 0, totalDeletions: 0 };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Stale Selection Test',
      path: '/mock/stale-selection-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-ss-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${CLEAN_SESSION_ID}',
      taskId: '${CLEAN_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9970,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/stale-selection-test',
      startedAt: ts,
      exitCode: null,
    });
    state.sessions.push({
      id: '${LOADING_SESSION_ID}',
      taskId: '${LOADING_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9971,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/stale-selection-test',
      startedAt: ts,
      exitCode: null,
    });

    // The blob opens the Changes panel AND names a file that the (empty) diff
    // does not contain - exactly the state a task lands in once its changes
    // are committed or reverted after a previous review session.
    state.tasks.push({
      id: '${CLEAN_TASK_ID}',
      title: 'Stale Selection Task',
      description: '',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${CLEAN_SESSION_ID}',
      worktree_path: '/mock/worktrees/stale-selection',
      branch_name: 'feature/stale-selection',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
      detail_view_state: JSON.stringify({ changesOpen: true, changesSelectedFile: 'seed-1/gone.ts' }),
    });

    // No blob at all: the load-frame test needs the panel CLOSED on open, so
    // it can arm the fetch deferral and then mount the panel deterministically
    // instead of racing a lazy-loaded restore.
    state.tasks.push({
      id: '${LOADING_TASK_ID}',
      title: 'Stale Loading Task',
      description: '',
      swimlane_id: laneIds['Code Review'],
      position: 1,
      agent: 'claude',
      session_id: '${LOADING_SESSION_ID}',
      worktree_path: '/mock/worktrees/stale-loading',
      branch_name: 'feature/stale-loading',
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
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Changes panel: a persisted selection missing from the diff', () => {
  test('an empty diff clears the stale selection instead of stranding a phantom file on a spinner', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Stale Selection Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    // changesOpen: true in the blob means the panel is already showing.
    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    await fileTree.waitFor({ state: 'visible', timeout: 10000 });
    await expect(page.locator('[data-testid="changes-list-header"]')).toContainText('0 files');

    // The empty-diff state is reached: the empty-diff pane, NOT a DiffViewer.
    // `diff-editor-area` existing at all is the red signal - the stale
    // selection mounted the viewer, which then has no content to load and
    // renders its boot spinner indefinitely.
    const noChanges = page.locator('[data-testid="diff-no-changes"]');
    await expect(noChanges).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="diff-editor-area"]')).toHaveCount(0);
    await expect(page.getByText('gone.ts')).toHaveCount(0);

    // The one surviving message names its SCOPE, so it explains itself instead
    // of reading as a broken panel next to a History section full of commits.
    await expect(noChanges).toContainText('No uncommitted changes');
    await page.locator('[data-testid="changes-scope-staged"]').click();
    await expect(noChanges).toContainText('No staged changes', { timeout: 10000 });
    await page.locator('[data-testid="changes-scope-branch"]').click();
    await expect(noChanges).toContainText('No changes vs main', { timeout: 10000 });
    await page.locator('[data-testid="changes-scope-working"]').click();
    await expect(noChanges).toContainText('No uncommitted changes', { timeout: 10000 });

    // An empty diff is stated ONCE, not once per pane. The rail's header
    // carries the "0 files" count and the diff pane carries the sentence; a
    // second icon-plus-sentence empty state in the rail is the duplication
    // this guards against.
    await expect(fileTree.getByText('No changes', { exact: false })).toHaveCount(0);

    // The view options stay REACHABLE with nothing to diff. DiffViewer (which
    // owns the toolbar) never mounts here, so without the file-less toolbar row
    // a clean worktree had no route to the diff preferences at all - you needed
    // a change in hand before you could set how changes render.
    await expect(page.locator('[data-testid="diff-toolbar-no-file"]')).toBeVisible();
    await page.locator('[data-testid="diff-view-options"]').click();
    const optionsMenu = page.locator('[data-testid="diff-view-options-menu"]');
    await expect(optionsMenu).toBeVisible({ timeout: 5000 });
    await expect(optionsMenu.locator('[data-testid="diff-wrap-lines"]')).toBeVisible();
    await expect(optionsMenu.locator('[data-testid="diff-open-settings"]')).toBeVisible();
    // Blame is per-FILE, so with no file it is left out rather than disabled -
    // a greyed row would imply a file exists that cannot be blamed.
    await expect(optionsMenu.locator('[data-testid="diff-blame-toggle"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(optionsMenu).not.toBeVisible({ timeout: 5000 });

    // The clear is written back, not just rendered around: reopening the task
    // does not resurrect the phantom from the blob.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
    await card.click();
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    await expect(page.locator('[data-testid="diff-no-changes"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="diff-editor-area"]')).toHaveCount(0);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('the initial fetch paints no empty-diff message beside the rail skeleton', async () => {
    // The rail gates its own empty shape on `loaded`; now that the diff pane is
    // the ONLY voice for emptiness, it needs the same gate. Ungated, the first
    // frame states "no changes" next to skeleton rows still loading - a false
    // negative with nothing left on screen to contradict it.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitDiffFilesDeferred = true;
      (window as unknown as Record<string, unknown>).__mockGitDiffFilesResolvers = [];
    });

    // A task with no persisted panel state, so the panel is reliably closed on
    // open and this click is what mounts it - after the deferral is armed.
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Stale Loading Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="changes-toggle"]').click();

    // Held mid-fetch: skeleton rows in the rail, and silence in the diff pane.
    await expect(page.locator('[data-testid="changes-file-tree-skeleton"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="diff-no-changes"]')).toHaveCount(0);

    // Release the fetch: the (still empty) result now settles into the one
    // scoped message.
    await page.evaluate(() => {
      const resolvers = (window as unknown as { __mockGitDiffFilesResolvers?: Array<() => void> }).__mockGitDiffFilesResolvers ?? [];
      (window as unknown as Record<string, unknown>).__mockGitDiffFilesDeferred = false;
      resolvers.forEach((resolve) => resolve());
    });
    await expect(page.locator('[data-testid="diff-no-changes"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="changes-file-tree-skeleton"]')).toHaveCount(0);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
