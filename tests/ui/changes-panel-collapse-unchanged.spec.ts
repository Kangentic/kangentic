/**
 * UI test for the Changes panel "collapse unchanged regions" toggle (PR 3).
 *
 * Reproduces and guards the live-toggle bug: toggling collapse on an
 * already-mounted diff must actually fold the large unchanged region, not just
 * flip the config. Asserts against the real Monaco diff editor (exposed as
 * window.__monaco in dev): the hideUnchangedRegions option AND the rendered
 * fold widget (.diff-hidden-lines).
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

const PROJECT_ID = 'proj-collapse';
const TASK_ID = 'task-collapse';
const SESSION_ID = 'sess-collapse';

// A 60-field object: original, and a modified copy with field10 and field50
// changed, so the diff has two far-apart hunks separated by a large unchanged
// region that collapse should fold.
const preConfig = `
  (function () {
    var orig = ['// big file', 'export const config = {'];
    for (var i = 1; i <= 60; i++) orig.push('  field' + i + ': ' + i + ',');
    orig.push('};', '');
    var mod = orig.slice();
    mod[11] = '  field10: 10000,';
    mod[51] = '  field50: 50000,';
    window.__mockGitDiff = {
      files: [
        { path: 'big.ts', status: 'M', insertions: 2, deletions: 2, original: orig.join('\\n'), modified: mod.join('\\n'), language: 'typescript' },
        { path: 'other.ts', status: 'M', insertions: 1, deletions: 1, original: 'export const x = 1;\\n', modified: 'export const x = 2;\\n', language: 'typescript' },
      ],
      totalInsertions: 3,
      totalDeletions: 3,
    };
  })();

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({ id: '${PROJECT_ID}', name: 'Collapse Test', path: '/mock/collapse-test', github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-co-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });
    state.sessions.push({ id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999, status: 'running', shell: 'bash', cwd: '/mock/collapse-test', startedAt: ts, exitCode: null });
    state.tasks.push({ id: '${TASK_ID}', title: 'Collapse Task', description: 'Collapse-unchanged toggle test', swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}', worktree_path: '/mock/worktrees/collapse', branch_name: 'feature/collapse', pr_number: null, pr_url: null, base_branch: 'main', archived_at: null, created_at: ts, updated_at: ts });
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

function readMonaco(page: Page) {
  return page.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: { editor: { getDiffEditors: () => Array<{ getLineChanges?: () => unknown[] | null; getModifiedEditor?: () => { getPosition?: () => { lineNumber: number } | null } }> } } }).__monaco;
    if (!monaco) return { ready: false, lineChangeCount: -1, hiddenWidgets: 0, modifiedLine: -1 };
    const diffEditors = monaco.editor.getDiffEditors();
    if (!diffEditors.length) return { ready: false, lineChangeCount: -1, hiddenWidgets: 0, modifiedLine: -1 };
    const diffEditor = diffEditors[0];
    const lineChanges = diffEditor.getLineChanges ? diffEditor.getLineChanges() : null;
    const modifiedEditor = diffEditor.getModifiedEditor ? diffEditor.getModifiedEditor() : null;
    const position = modifiedEditor && modifiedEditor.getPosition ? modifiedEditor.getPosition() : null;
    return {
      ready: true,
      lineChangeCount: Array.isArray(lineChanges) ? lineChanges.length : -1,
      // Monaco renders each folded unchanged region as a .diff-hidden-lines widget.
      hiddenWidgets: document.querySelectorAll('.diff-hidden-lines').length,
      modifiedLine: position ? position.lineNumber : -1,
    };
  });
}

function selectFile(page: Page, namePattern: RegExp) {
  return page.locator('[data-testid="changes-file-tree"]').getByRole('button', { name: namePattern }).click();
}

test.describe('Changes panel: collapse unchanged regions', () => {
  test('toggling collapse folds the large unchanged region of an open diff', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Collapse Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    // Open the changes panel only if not already open. A previous failed attempt
    // may have left it open; clicking the toggle then would close it.
    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    // Wait until Monaco has mounted and computed the two-hunk diff.
    await expect.poll(async () => (await readMonaco(page)).lineChangeCount, { timeout: 15000 }).toBe(2);

    // Reproduce the preview sequence: switch scope first (which refetches + remounts
    // the diff), then toggle collapse, to rule out a scope-switch interaction.
    await page.locator('[data-testid="changes-scope-working"]').click();
    await expect.poll(async () => (await readMonaco(page)).lineChangeCount, { timeout: 10000 }).toBe(2);

    // Initially nothing is folded.
    const before = await readMonaco(page);
    expect(before.hiddenWidgets).toBe(0);

    // Toggle collapse on - the open diff's large unchanged region must fold.
    await page.locator('[data-testid="diff-collapse-unchanged"]').click();
    await expect.poll(async () => (await readMonaco(page)).hiddenWidgets, { timeout: 5000 }).toBeGreaterThan(0);

    // Next/prev-change navigation jumps between the two hunks (field10 near line
    // 12, field50 near line 52 in the modified file).
    await page.locator('[data-testid="diff-next-change"]').click();
    await expect.poll(async () => (await readMonaco(page)).modifiedLine, { timeout: 5000 }).toBeLessThan(30);
    const firstHunkLine = (await readMonaco(page)).modifiedLine;
    await page.locator('[data-testid="diff-next-change"]').click();
    await expect.poll(async () => (await readMonaco(page)).modifiedLine, { timeout: 5000 }).toBeGreaterThan(firstHunkLine + 20);

    // Regression: with collapse already on, switching to another file and back must
    // RE-FOLD the reloaded diff. Monaco only folds on an off->on transition, so a
    // diff that loads with the option already enabled was previously left unfolded
    // (the bug the user hit). The fix re-applies the fold after each diff loads.
    await selectFile(page, /other\.ts/);
    await expect.poll(async () => (await readMonaco(page)).lineChangeCount, { timeout: 5000 }).toBe(1);
    await selectFile(page, /big\.ts/);
    await expect.poll(async () => (await readMonaco(page)).lineChangeCount, { timeout: 5000 }).toBe(2);
    await expect.poll(async () => (await readMonaco(page)).hiddenWidgets, { timeout: 5000 }).toBeGreaterThan(0);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
