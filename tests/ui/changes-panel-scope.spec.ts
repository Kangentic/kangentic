/**
 * UI test for the Changes panel diff-scope selector (PR 2).
 *
 * Verifies the scope Select switches the file list between working / staged /
 * branch fixtures, driven by window.__mockGitDiffByScope. The default scope is
 * the global diffDefaultScope ('branch' in the mock config).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { pressResizeHandle, waitForViteReady } from './helpers';

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

const PROJECT_ID = 'proj-scope';
const TASK_ID = 'task-scope';
const SESSION_ID = 'sess-scope';

const preConfig = `
  // Per-scope fixtures: branch shows the whole PR (two files), working shows just
  // the active edit (one file), staged shows a different single file.
  window.__mockGitDiffByScope = {
    branch: { files: [
      { path: 'src/branch-only.ts', status: 'A', insertions: 9, deletions: 0, original: '', modified: 'branch', language: 'typescript' },
      { path: 'src/shared.ts', status: 'M', insertions: 2, deletions: 1, original: 'old', modified: 'new', language: 'typescript' },
    ], totalInsertions: 11, totalDeletions: 1 },
    working: { files: [
      { path: 'src/shared.ts', status: 'M', insertions: 2, deletions: 1, original: 'old', modified: 'new', language: 'typescript' },
    ], totalInsertions: 2, totalDeletions: 1 },
    staged: { files: [
      { path: 'src/staged-only.ts', status: 'M', insertions: 4, deletions: 0, original: 'a', modified: 'b', language: 'typescript' },
    ], totalInsertions: 4, totalDeletions: 0 },
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Scope Test',
      path: '/mock/scope-test',
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
      cwd: '/mock/scope-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Scope Task',
      description: 'Task used for Changes panel scope selector test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/scope',
      branch_name: 'feature/scope',
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

test.describe('Changes panel: diff scope selector', () => {
  test('switches the file list between branch, working, and staged scopes', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Scope Task')
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

    const scopeGroup = page.locator('[data-testid="changes-scope-select"]');
    await scopeGroup.waitFor({ state: 'visible', timeout: 8000 });
    const workingTab = page.locator('[data-testid="changes-scope-working"]');
    const stagedTab = page.locator('[data-testid="changes-scope-staged"]');
    const branchTab = page.locator('[data-testid="changes-scope-branch"]');

    // Reset scope to 'working' if a previous failed attempt left it on 'branch'
    // or 'staged'; the initial assertion below expects 'working' to be active.
    if ((await workingTab.getAttribute('aria-checked')) !== 'true') {
      await workingTab.click();
      await expect(workingTab).toHaveAttribute('aria-checked', 'true', { timeout: 3000 });
    }

    // Scope assertions are confined to the file tree so they do not match the
    // selected file's path echoed in the diff viewer toolbar.

    // Default scope is 'working' (the global default) - only the active edit shows.
    await expect(workingTab).toHaveAttribute('aria-checked', 'true');
    await expect(fileTree.locator('text=shared.ts')).toBeVisible();
    await expect(fileTree.locator('text=branch-only.ts')).toBeHidden();

    // Switch to full branch: both PR files are listed.
    await branchTab.click();
    await expect(branchTab).toHaveAttribute('aria-checked', 'true');
    await expect(fileTree.locator('text=branch-only.ts')).toBeVisible();
    await expect(fileTree.locator('text=shared.ts')).toBeVisible();

    // Switch to staged: a different single file is listed.
    await stagedTab.click();
    await expect(stagedTab).toHaveAttribute('aria-checked', 'true');
    await expect(fileTree.locator('text=staged-only.ts')).toBeVisible();
    await expect(fileTree.locator('text=shared.ts')).toBeHidden();

    // Close panel + dialog so state does not leak to other tests.
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('the file tree panel is drag-resizable', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Scope Task')
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
    const beforeWidth = (await fileTree.boundingBox())!.width;

    // Drag the divider 120px to the right to widen the tree. `pressResizeHandle`
    // hovers, presses, and re-presses when the drag has not armed, so no move
    // is dispatched before the handler installs its document listeners - the
    // same guard as commit-graph-panel.spec.ts, where this shape produced the
    // CI flakes the helper's docblock describes.
    const handle = page.locator('[data-testid="changes-tree-resize"]');
    const handleBox = await pressResizeHandle(page, '[data-testid="changes-tree-resize"]');
    await page.mouse.move(handleBox.x + 120, handleBox.y + handleBox.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(handle).toHaveAttribute('data-resizing', 'false');

    // The tree widened by roughly the drag distance (tolerance for clamping/rounding).
    await expect.poll(async () => (await fileTree.boundingBox())!.width, { timeout: 5000 }).toBeGreaterThan(beforeWidth + 60);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('on a narrow window the rail gives ground first, so the diff pane keeps its minimum', async () => {
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    const handle = page.locator('[data-testid="changes-tree-resize"]');
    await page.locator('[data-swimlane-name="Code Review"]').locator('text=Scope Task').first().click();
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    if (!(await page.locator('[data-testid="changes-file-tree"]').isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }
    await handle.waitFor({ state: 'visible', timeout: 8000 });
    // The drag test above stores a width for this task; the default is under test.
    await handle.dblclick();

    // Pin the panel row (the rail's flex container, which its clamp resolves
    // against) instead of resizing the viewport: the task window keeps the
    // geometry earlier tests gave it, so a viewport change alone moves nothing.
    const setRowWidth = (width: string) => page.evaluate((value) => {
      const row = document.querySelector('[data-testid="changes-tree-resize"]')!.parentElement as HTMLElement;
      row.style.width = value;
    }, width);
    const measure = () => page.evaluate(() => {
      const divider = document.querySelector('[data-testid="changes-tree-resize"]')!;
      const rail = divider.previousElementSibling!.getBoundingClientRect();
      const pane = divider.nextElementSibling!.getBoundingClientRect();
      const scope = document.querySelector('[data-testid="changes-scope-select"]') as HTMLElement;
      return { rail: Math.round(rail.width), pane: Math.round(pane.width), scopeFits: scope.scrollWidth <= scope.clientWidth + 1 };
    });

    try {
      // 417px is the row the default 58%-wide window gives on a 1440px screen.
      // The rail's 220px default used to leave the pane 193px of it.
      await setRowWidth('417px');
      await expect.poll(async () => (await measure()).pane).toBeGreaterThanOrEqual(239);
      const squeezed = await measure();
      expect(squeezed.rail).toBeLessThan(200);
      expect(squeezed.scopeFits).toBe(true);

      // Pressing the divider starts the drag where the rail already is. It used
      // to seed the drag from the 220px constant and jump on the first frame.
      await pressResizeHandle(page, '[data-testid="changes-tree-resize"]');
      expect(Math.abs((await measure()).rail - squeezed.rail)).toBeLessThan(2);
      await page.mouse.up();
      await expect(handle).toHaveAttribute('data-resizing', 'false');
      await handle.dblclick();

      // Narrower still, the rail stops at its 160px floor and the pane pays the
      // rest. All three scope labels have to fit at the floor.
      await setRowWidth('370px');
      await expect.poll(async () => (await measure()).rail).toBe(160);
      expect((await measure()).scopeFits).toBe(true);
    } finally {
      await setRowWidth('');
      await page.locator('[data-testid="changes-toggle"]').click();
      await page.keyboard.press('Control+Shift+W');
      await expect(dialog).not.toBeVisible({ timeout: 8000 });
    }
  });
});
