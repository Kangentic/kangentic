/**
 * UI tests for the DiffViewer `trailingControls` path inside ChangesPanel.
 *
 * Intent: when a file IS selected (i.e. `selectedFile` is truthy in
 * ChangesPanel), the `panelControls` node is forwarded as `trailingControls`
 * to the DiffViewer toolbar rather than being rendered in the `fallbackControlsRow`.
 * This is distinct from the fallback-row path exercised by the other changes-panel
 * specs, where `git.diffFiles` returns `{ files: [] }` and no file is ever selected.
 *
 * To exercise this path we seed `window.__mockGitDiff` (the test hook in
 * mock-electron-api.js) with a single modified file entry carrying its diff
 * content. ChangesPanel auto-selects the first file, fetches its content, and
 * mounts DiffViewer with the expand/collapse control in the toolbar.
 *
 * Monaco concern: @monaco-editor/react loads inside a real headless Chromium
 * context here, but the toolbar renders synchronously before Monaco initializes,
 * so all assertions are on toolbar buttons only.
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

const PROJECT_ID = 'proj-diffviewer-toolbar';
const TASK_ID = 'task-diffviewer-toolbar';
const SESSION_ID = 'sess-diffviewer-toolbar';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'DiffViewer Toolbar Test',
      path: '/mock/diffviewer-toolbar-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-tv-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so TaskDetailBody (not the edit form) is rendered and
    // the Changes pill appears in TaskDetailHeader.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 8888,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/diffviewer-toolbar-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'DiffViewer Toolbar Task',
      description: 'Task used to exercise the DiffViewer trailingControls path',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/diffviewer-toolbar',
      branch_name: 'feature/diffviewer-toolbar',
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
  // Clear any lingering mock override so it does not bleed into other specs
  // if the browser context is somehow shared.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockGitDiff = null;
  });
  await browser?.close();
});

test.describe('DiffViewer toolbar: trailingControls rendered when a file is selected', () => {
  test('expand control appears in the DiffViewer toolbar (alongside split/inline buttons) when a file is auto-selected', async () => {
    // Seed git.diffFiles to return a real file (with content) so ChangesPanel
    // auto-selects it and DiffViewer mounts. The __mockGitDiff hook stays active
    // until cleared. Setting it here (before the Changes panel is opened) ensures
    // the panel opens with a selected file.
    await page.evaluate(() => {
      (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = {
        files: [
          {
            path: 'src/renderer/components/Foo.tsx',
            status: 'M',
            insertions: 5,
            deletions: 2,
            binary: false,
            original: 'const a = 1;\n',
            modified: 'const a = 2;\n',
            language: 'typescript',
          },
        ],
      };
    });

    // Open the task detail dialog.
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=DiffViewer Toolbar Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Open the Changes panel via the pill.
    const changesPill = page.locator('[data-testid="changes-toggle"]');
    await expect(changesPill).toBeVisible();
    await changesPill.click();

    // ChangesPanel auto-selects the first file (src/renderer/components/Foo.tsx).
    // Once selected, DiffViewer is mounted and its toolbar renders with
    // the split/inline toggles AND the trailingControls (expand button in split
    // mode). We wait for the toolbar split button to appear as a proxy for "toolbar
    // is mounted" - it renders synchronously before Monaco initializes.
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-view-inline"]')).toBeVisible();

    // The expand button must be present IN the DiffViewer toolbar: it is a sibling
    // of diff-view-split / diff-view-inline inside the same toolbar container.
    // This is the trailingControls path; the fallbackControlsRow is NOT rendered
    // when a file is selected.
    await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-collapse"]')).not.toBeVisible();

    // Clicking expand in the DiffViewer toolbar collapses to show the collapse
    // control (same as the fallback-row path - the button renders identically).
    await page.locator('[data-testid="changes-expand"]').click();
    await expect(page.locator('[data-testid="changes-collapse"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-expand"]')).not.toBeVisible();

    // The split/inline toggles are still present (they are siblings in the same
    // toolbar row - trailingControls does not replace them).
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-view-inline"]')).toBeVisible();

    // Collapse back to split view via the toolbar collapse button.
    await page.locator('[data-testid="changes-collapse"]').click();
    await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible();

    // Clear the mock so it does not persist into any follow-up calls.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitDiff = null;
    });

    // Clean up: close changes panel, then dialog.
    // Use Control+Shift+W (capture-phase) rather than Escape: the task-detail
    // window has a running session, so Escape via the bubble-phase listener can
    // be intercepted on CI Linux after toolbar interactions move focus.
    await changesPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('diff-rendering toggles and next/prev-change buttons render and flip state', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = {
        files: [
          {
            path: 'src/renderer/components/Bar.tsx',
            status: 'M',
            insertions: 5,
            deletions: 2,
            binary: false,
            original: 'const a = 1;\n',
            modified: 'const a = 2;\n',
            language: 'typescript',
          },
        ],
      };
    });

    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=DiffViewer Toolbar Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const changesPill = page.locator('[data-testid="changes-toggle"]');
    await changesPill.click();

    // Wait for the toolbar (mounts synchronously once a file is selected).
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible({ timeout: 8000 });

    // The markdown preview toggle is markdown-only: absent for this .tsx file.
    await expect(page.locator('[data-testid="diff-markdown-preview"]')).not.toBeVisible();

    // Navigation buttons are present.
    await expect(page.locator('[data-testid="diff-prev-change"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-next-change"]')).toBeVisible();

    // Whitespace toggle starts off (config default false) and flips on click.
    const whitespace = page.locator('[data-testid="diff-ignore-whitespace"]');
    await expect(whitespace).toHaveAttribute('aria-pressed', 'false');
    await whitespace.click();
    await expect(whitespace).toHaveAttribute('aria-pressed', 'true');
    // Restore so the global config does not bleed into other specs.
    await whitespace.click();
    await expect(whitespace).toHaveAttribute('aria-pressed', 'false');

    // Collapse-unchanged starts off and flips on.
    const collapse = page.locator('[data-testid="diff-collapse-unchanged"]');
    await expect(collapse).toHaveAttribute('aria-pressed', 'false');
    await collapse.click();
    await expect(collapse).toHaveAttribute('aria-pressed', 'true');
    await collapse.click();
    await expect(collapse).toHaveAttribute('aria-pressed', 'false');

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitDiff = null;
    });

    await changesPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('markdown files show a preview toggle that renders the new content and hides diff-only controls', async () => {
    // Seed a markdown file so ChangesPanel auto-selects it and DiffViewer mounts
    // with the preview toggle (only rendered when language === 'markdown').
    await page.evaluate(() => {
      (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = {
        files: [
          {
            path: 'docs/readme.md',
            status: 'M',
            insertions: 3,
            deletions: 1,
            binary: false,
            original: '# Old Title\n',
            modified: '# New Heading\n\nBody paragraph.\n',
            language: 'markdown',
          },
        ],
      };
    });

    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=DiffViewer Toolbar Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const changesPill = page.locator('[data-testid="changes-toggle"]');
    await changesPill.click();

    // The toggle mounts synchronously with the toolbar once the markdown file is
    // auto-selected. It starts off (showing the diff), so the diff-only controls
    // are present.
    const previewToggle = page.locator('[data-testid="diff-markdown-preview"]');
    await expect(previewToggle).toBeVisible({ timeout: 8000 });
    await expect(previewToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible();

    // Flip to the rendered preview: the new content renders (react-markdown runs
    // in headless Chromium), and the diff-only controls hide.
    await previewToggle.click();
    await expect(previewToggle).toHaveAttribute('aria-pressed', 'true');
    const preview = page.locator('[data-testid="diff-markdown-preview-content"]');
    await expect(preview).toBeVisible();
    await expect(preview.locator('h1')).toHaveText('New Heading');
    await expect(page.locator('[data-testid="diff-view-split"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="diff-ignore-whitespace"]')).not.toBeVisible();

    // Toggle back returns to the diff and restores the diff-only controls.
    await previewToggle.click();
    await expect(previewToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(preview).not.toBeVisible();
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitDiff = null;
    });

    await changesPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('next/prev-change keybindings are inert while the markdown preview is active', async () => {
    // Three files so both next-change (F7) and prev-change (Shift+F7) have a
    // real adjacent file to roll into IF the `enabled: isFocused && !previewActive`
    // guard on DiffViewer's changes.nextChange/changes.prevChange bindings
    // (DiffViewer.tsx:405-406) were broken. Entering preview mode nulls
    // diffEditorRef (the `binary || previewActive` effect in DiffViewer.tsx), so
    // if the handler fired while previewing it would hit navigateChange's
    // "no diff mounted" branch and immediately roll to the adjacent file via
    // onCrossFile - a Monaco-independent, unmistakable signal that the binding
    // fired. Correct behavior attaches no listener at all while previewActive
    // (enabled=false), so the shortcut is a true no-op and the panel stays on
    // the markdown file with its preview open.
    await page.evaluate(() => {
      (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = {
        files: [
          {
            path: 'src/nav-guard-before.ts',
            status: 'M',
            insertions: 1,
            deletions: 1,
            binary: false,
            original: 'const a = 1;\n',
            modified: 'const a = 2;\n',
            language: 'typescript',
          },
          {
            path: 'docs/nav-guard.md',
            status: 'M',
            insertions: 3,
            deletions: 1,
            binary: false,
            original: '# Old Title\n',
            modified: '# Nav Guard Heading\n\nBody paragraph.\n',
            language: 'markdown',
          },
          {
            path: 'src/nav-guard-after.ts',
            status: 'M',
            insertions: 1,
            deletions: 1,
            binary: false,
            original: 'const b = 1;\n',
            modified: 'const b = 2;\n',
            language: 'typescript',
          },
        ],
      };
    });

    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=DiffViewer Toolbar Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const changesPill = page.locator('[data-testid="changes-toggle"]');
    await changesPill.click();

    // ChangesPanel auto-selects the first file (src/nav-guard-before.ts);
    // select the markdown file explicitly so the preview toggle is available.
    const markdownRow = page.locator('[data-testid="changes-file-row"][data-path="docs/nav-guard.md"]');
    await markdownRow.locator('button').first().click();

    const previewToggle = page.locator('[data-testid="diff-markdown-preview"]');
    await expect(previewToggle).toBeVisible({ timeout: 8000 });
    await previewToggle.click();
    await expect(previewToggle).toHaveAttribute('aria-pressed', 'true');

    const preview = page.locator('[data-testid="diff-markdown-preview-content"]');
    await expect(preview).toBeVisible();
    await expect(preview.locator('h1')).toHaveText('Nav Guard Heading');

    // Fire next-change (F7, the alt combo for changes.nextChange). A broken
    // guard would roll into src/nav-guard-after.ts.
    await page.keyboard.press('F7');
    // Fixed budget, not a poll: this asserts a NO-OP, which cannot be polled
    // for (see test-builder anti-pattern 6). The mock IPC (mock-electron-api.js
    // git.fileContent) resolves on a bare microtask with no artificial delay,
    // and file selection itself is a synchronous state update, so any real
    // navigation would already be reflected in the DOM well within this window.
    await page.waitForTimeout(500);
    await expect(markdownRow).toHaveAttribute('data-selected', 'true');
    await expect(preview).toBeVisible();
    await expect(preview.locator('h1')).toHaveText('Nav Guard Heading');
    await expect(previewToggle).toHaveAttribute('aria-pressed', 'true');

    // Fire prev-change (Shift+F7, the alt combo for changes.prevChange). A
    // broken guard would roll into src/nav-guard-before.ts.
    await page.keyboard.press('Shift+F7');
    await page.waitForTimeout(500);
    await expect(markdownRow).toHaveAttribute('data-selected', 'true');
    await expect(preview).toBeVisible();
    await expect(preview.locator('h1')).toHaveText('Nav Guard Heading');
    await expect(previewToggle).toHaveAttribute('aria-pressed', 'true');

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitDiff = null;
    });

    await changesPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
