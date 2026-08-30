/**
 * UI tests for the DiffViewer toolbar inside ChangesPanel (split/inline toggle,
 * whitespace, collapse-unchanged, markdown preview) plus the panel-level
 * expand/collapse control's location.
 *
 * DiffViewer no longer accepts a `trailingControls` prop: the panel-level
 * expand/collapse control (`panelControls` in ChangesPanel, exposed as
 * `expandCollapseControl`) now renders in the shared detachable-surface header
 * (`surface-header-changes`, via `DetachableSurfaceHeader`'s `actions` slot),
 * NOT inside the DiffViewer toolbar, and NOT conditioned on a file being
 * selected - the surface header is the panel's unconditional top row. The
 * first test below locks that location explicitly so a regression that moves
 * it back into (or duplicates it in) the diff toolbar is caught.
 *
 * To exercise the diff toolbar we seed `window.__mockGitDiff` (the test hook
 * in mock-electron-api.js) with a single modified file entry carrying its diff
 * content. ChangesPanel auto-selects the first file, fetches its content, and
 * mounts DiffViewer.
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

test.describe('DiffViewer toolbar: rendering toggles, and the surface header expand/collapse control', () => {
  test('expand control lives in the shared surface header (not the DiffViewer toolbar), independent of file selection', async () => {
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

    // The shared surface header is the panel's unconditional top row: it
    // mounts as soon as ChangesPanel opens, before any file is fetched or
    // selected, so changes-expand is already visible here.
    const surfaceHeader = page.locator('[data-testid="surface-header-changes"]');
    await surfaceHeader.waitFor({ state: 'visible', timeout: 5000 });
    await expect(surfaceHeader.locator('[data-testid="changes-expand"]')).toBeVisible();
    await expect(surfaceHeader.locator('[data-testid="changes-collapse"]')).not.toBeVisible();

    // ChangesPanel auto-selects the first file (src/renderer/components/Foo.tsx).
    // Once selected, DiffViewer mounts its own toolbar (split/inline toggles) -
    // independently of the surface header above. We wait for the toolbar split
    // button as a proxy for "toolbar is mounted" - it renders synchronously
    // before Monaco initializes.
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-view-inline"]')).toBeVisible();

    // The expand control is NOT among the diff toolbar's own buttons: exactly
    // one changes-expand exists on the page (in the surface header), proving
    // DiffViewer does not also render it (it no longer accepts a
    // trailingControls prop).
    await expect(page.locator('[data-testid="changes-expand"]')).toHaveCount(1);

    // Clicking expand (from the surface header) still expands the panel.
    await surfaceHeader.locator('[data-testid="changes-expand"]').click();
    await expect(surfaceHeader.locator('[data-testid="changes-collapse"]')).toBeVisible();
    await expect(surfaceHeader.locator('[data-testid="changes-expand"]')).not.toBeVisible();

    // The diff toolbar's own controls are unaffected by the expand/collapse
    // toggle (they are independent surfaces).
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-view-inline"]')).toBeVisible();

    // Collapse back to split view via the surface-header collapse button.
    await surfaceHeader.locator('[data-testid="changes-collapse"]').click();
    await expect(surfaceHeader.locator('[data-testid="changes-expand"]')).toBeVisible();

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

    // The rendering preferences live behind the labelled "View options" menu
    // (they were icon-only toggles nobody could read without hovering), so
    // each assertion opens the menu, reads aria-checked, and clicks the item.
    const viewOptions = page.locator('[data-testid="diff-view-options"]');
    const optionsMenu = page.locator('[data-testid="diff-view-options-menu"]');
    const openViewOptions = async () => {
      await viewOptions.click();
      await expect(optionsMenu).toBeVisible({ timeout: 5000 });
    };

    // Whitespace toggle starts off (config default false) and flips on click.
    await openViewOptions();
    const whitespace = optionsMenu.locator('[data-testid="diff-ignore-whitespace"]');
    await expect(whitespace).toHaveAttribute('aria-checked', 'false');
    await whitespace.click();
    await expect(whitespace).toHaveAttribute('aria-checked', 'true');
    // Restore so the global config does not bleed into other specs.
    await whitespace.click();
    await expect(whitespace).toHaveAttribute('aria-checked', 'false');

    // Collapse-unchanged starts off and flips on (menu stays open between
    // toggles - these are view options, not one-shot actions).
    const collapse = optionsMenu.locator('[data-testid="diff-collapse-unchanged"]');
    await expect(collapse).toHaveAttribute('aria-checked', 'false');
    await collapse.click();
    await expect(collapse).toHaveAttribute('aria-checked', 'true');
    await collapse.click();
    await expect(collapse).toHaveAttribute('aria-checked', 'false');

    // Wrap-long-lines starts off and flips on.
    const wrapLines = optionsMenu.locator('[data-testid="diff-wrap-lines"]');
    await expect(wrapLines).toHaveAttribute('aria-checked', 'false');
    await wrapLines.click();
    await expect(wrapLines).toHaveAttribute('aria-checked', 'true');
    await wrapLines.click();
    await expect(wrapLines).toHaveAttribute('aria-checked', 'false');

    // Inline-when-narrow is the fourth option, defaulting ON.
    await expect(optionsMenu.locator('[data-testid="diff-inline-when-narrow"]')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitDiff = null;
    });

    await changesPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('wrap toggle actually reflows long lines in BOTH diff panes', async () => {
    // aria-pressed only proves the button flipped. This asserts Monaco really wrapped,
    // and covers both panes: Monaco force-sets wordWrapOverride1 AND override2 to 'off'
    // on the ORIGINAL editor whenever the diff renders inline, but restores only
    // override1 when it goes back side-by-side, and override2 outranks override1. That
    // left the LEFT pane permanently unwrapped until DiffViewer started clearing the
    // stale override. Counting rendered .view-line elements (not pixels) keeps this
    // independent of font metrics, which differ between local Windows and CI's Linux.
    const longLine = `const veryLongIdentifier = '${'wrap-me-'.repeat(250)}';`;
    await page.evaluate((line) => {
      (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = {
        files: [
          {
            path: 'src/renderer/components/LongLines.tsx',
            status: 'M',
            insertions: 1,
            deletions: 1,
            binary: false,
            // Both sides carry a long line so each pane is independently testable.
            original: `${line}\nconst shared = 1;\n`,
            modified: `${line}\nconst shared = 2;\n`,
            language: 'typescript',
          },
        ],
      };
    }, longLine);

    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=DiffViewer Toolbar Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const changesPill = page.locator('[data-testid="changes-toggle"]');
    await changesPill.click();
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible({ timeout: 8000 });

    // Maximize AND expand the Changes surface so the diff editor clears Monaco's
    // ~900px side-by-side breakpoint; below it Monaco renders inline on its own and
    // there is no left pane to check. Maximizing alone is not enough.
    await page.locator('[data-testid="task-detail-maximize"]').click();
    await page.locator('[data-testid="changes-expand"]').click();
    const sideBySide = page.locator('.monaco-diff-editor.side-by-side');
    await expect(sideBySide).toBeVisible({ timeout: 8000 });

    // Count the rendered rows Monaco produced for each pane's content.
    const renderedRows = () =>
      page.evaluate(() => {
        const rows = (selector: string) =>
          document.querySelectorAll(`.monaco-diff-editor ${selector} .view-line`).length;
        return { original: rows('.editor.original'), modified: rows('.editor.modified') };
      });

    // Wrap lives in the "View options" menu; open it, flip the option, and
    // close so the menu never overlaps the panes being measured.
    const wrapMenu = page.locator('[data-testid="diff-view-options-menu"]');
    const toggleWrap = async (expectedAfter: 'true' | 'false') => {
      await page.locator('[data-testid="diff-view-options"]').click();
      await expect(wrapMenu).toBeVisible({ timeout: 5000 });
      const item = wrapMenu.locator('[data-testid="diff-wrap-lines"]');
      await item.click();
      await expect(item).toHaveAttribute('aria-checked', expectedAfter);
      await page.keyboard.press('Escape');
      await expect(wrapMenu).not.toBeVisible({ timeout: 5000 });
    };

    // Unwrapped: the long line is one row, so each pane renders only a handful.
    await expect.poll(async () => (await renderedRows()).modified).toBeLessThan(10);
    expect((await renderedRows()).original).toBeLessThan(10);

    await toggleWrap('true');

    // Wrapped: a 2000-character line reflows into many rows at any plausible width.
    await expect.poll(async () => (await renderedRows()).modified).toBeGreaterThan(15);
    await expect.poll(async () => (await renderedRows()).original).toBeGreaterThan(15);

    // Survives a side-by-side -> inline -> side-by-side round trip, which is the exact
    // sequence that strands override2 on the original editor.
    await page.locator('[data-testid="diff-view-inline"]').click();
    await page.locator('[data-testid="diff-view-split"]').click();
    await expect(sideBySide).toBeVisible();
    await expect.poll(async () => (await renderedRows()).original).toBeGreaterThan(15);

    // Turning wrap back off restores single-row rendering.
    await toggleWrap('false');
    await expect.poll(async () => (await renderedRows()).original).toBeLessThan(10);

    // Restore shared state: collapse, un-maximize, clear the diff, close the dialog.
    await page.locator('[data-testid="changes-collapse"]').click();
    await page.locator('[data-testid="task-detail-maximize"]').click();
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
    // The whole view-options menu is diff-only, so its trigger goes with the
    // rest of the diff controls while the rendered preview is showing.
    await expect(page.locator('[data-testid="diff-view-options"]')).not.toBeVisible();

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
    // guard on DiffViewer's changes.nextChange/changes.prevChange bindings were
    // broken. Entering preview mode nulls diffEditorRef (the
    // `binary || previewActive` effect in DiffViewer.tsx), so
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

  test('a deleted markdown file previews its old content, not the empty new content', async () => {
    // diff-service reports a deleted file with modified: '' and original holding
    // the last committed text. DiffViewer's preview branch is
    // `content={status === 'D' ? original : modified}` - if that fallback were
    // reverted to always render `modified`, this file would preview blank
    // instead of the old heading.
    await page.evaluate(() => {
      (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = {
        files: [
          {
            path: 'docs/deleted.md',
            status: 'D',
            insertions: 0,
            deletions: 2,
            binary: false,
            original: '# Deleted Doc\n\nOld body.\n',
            modified: '',
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

    // ChangesPanel auto-selects the single deleted markdown file; the preview
    // toggle mounts once the toolbar renders (markdown-only, same as the other
    // markdown tests above).
    const previewToggle = page.locator('[data-testid="diff-markdown-preview"]');
    await expect(previewToggle).toBeVisible({ timeout: 8000 });
    await expect(previewToggle).toHaveAttribute('aria-pressed', 'false');

    // Flip to the rendered preview. The old heading must render - this fails if
    // the fallback branch is reverted to always use `modified` (blank preview).
    await previewToggle.click();
    await expect(previewToggle).toHaveAttribute('aria-pressed', 'true');
    const preview = page.locator('[data-testid="diff-markdown-preview-content"]');
    await expect(preview).toBeVisible();
    await expect(preview.locator('h1')).toHaveText('Deleted Doc');

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitDiff = null;
    });

    await changesPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('markdown preview toggle resets to the diff when switching to a different file', async () => {
    // Two markdown files so previewing the first, then selecting the second,
    // exercises DiffViewer's per-file reset (previousFilePathRef nulling
    // showMarkdownPreview when filePath changes). Without that reset the second
    // file would open already in preview mode.
    await page.evaluate(() => {
      (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = {
        files: [
          {
            path: 'docs/first.md',
            status: 'M',
            insertions: 2,
            deletions: 1,
            binary: false,
            original: '# First Old\n',
            modified: '# First Heading\n\nBody.\n',
            language: 'markdown',
          },
          {
            path: 'docs/second.md',
            status: 'M',
            insertions: 2,
            deletions: 1,
            binary: false,
            original: '# Second Old\n',
            modified: '# Second Heading\n\nBody.\n',
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

    // Select docs/first.md explicitly (ChangesPanel auto-selects the first
    // file anyway, but select it by row so the assumption is unambiguous).
    const firstFileRow = page.locator('[data-testid="changes-file-row"][data-path="docs/first.md"]');
    await firstFileRow.locator('button').first().click();

    const previewToggle = page.locator('[data-testid="diff-markdown-preview"]');
    await expect(previewToggle).toBeVisible({ timeout: 8000 });
    await previewToggle.click();
    await expect(previewToggle).toHaveAttribute('aria-pressed', 'true');
    const preview = page.locator('[data-testid="diff-markdown-preview-content"]');
    await expect(preview).toBeVisible();
    await expect(preview.locator('h1')).toHaveText('First Heading');

    // Select docs/second.md. Correct behavior resets the toggle so the second
    // file opens on its diff.
    const secondFileRow = page.locator('[data-testid="changes-file-row"][data-path="docs/second.md"]');
    await secondFileRow.locator('button').first().click();
    await expect(secondFileRow).toHaveAttribute('data-selected', 'true');

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
});
