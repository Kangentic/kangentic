/**
 * DiffViewer reads the SHOWN theme (config-store's `shownTheme` selector), not
 * the committed one, so a Theme tab hover preview re-skins the diff pane along
 * with the rest of the app - see the doc comment on `ThemeSwatchGrid` in
 * ThemeTab.tsx: "It is store state (themePreview) ... so the diff pane
 * follows it too". Nothing exercised that subscription before this file:
 * `tests/unit/diff-render-options.test.ts` only pins `monacoThemeForTheme` as
 * a pure function, so a regression that reverts DiffViewer.tsx's
 * `useConfigStore(shownTheme)` back to `useConfigStore((state) =>
 * state.config.theme)` would leave every existing test green.
 *
 * Monaco writes its resolved theme id directly as a class on the
 * `.monaco-editor` root (`vs-dark` / `vs`), so every assertion here reads a
 * CLASS - never a color - matching the no-hex convention the rest of the
 * theme suite follows.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-diffviewer-theme-${RUN_ID}`;
const TASK_ID = `task-diffviewer-theme-${RUN_ID}`;
const SESSION_ID = `sess-diffviewer-theme-${RUN_ID}`;
const TASK_TITLE = `DiffViewer Theme Preview Test ${RUN_ID}`;

const DIFF_FIXTURE = {
  files: [
    {
      path: 'src/theme-preview-file.ts',
      status: 'M',
      insertions: 1,
      deletions: 1,
      binary: false,
      original: 'first line\noriginal second line\nthird line\n',
      modified: 'first line\nmodified second line\nthird line\n',
      language: 'typescript',
    },
  ],
};

type MonacoTestWindow = Window & {
  __monaco?: { editor: { getDiffEditors(): unknown[] } };
};

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockGitDiff = ${JSON.stringify(DIFF_FIXTURE)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'DiffViewer Theme Preview Test ${RUN_ID}',
        path: '/mock/diffviewer-theme-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-theme-' + s.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      // Running session so TaskDetailBody (not the edit form) renders and the
      // Changes pill appears in TaskDetailHeader.
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 8888,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/diffviewer-theme-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
      });

      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: '${TASK_TITLE}',
        description: 'Task used to exercise the DiffViewer theme preview subscription',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: '/mock/worktrees/diffviewer-theme',
        branch_name: 'feature/diffviewer-theme',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // The mock's default theme is 'dark' (a dark base), so the pre-hover
      // vs-dark assertion below is non-vacuous.
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  const card = page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first();
  await card.click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });

  const changesPill = page.locator('[data-testid="changes-toggle"]');
  await expect(changesPill).toBeVisible();
  await changesPill.click();

  await page.locator('[data-testid="diff-editor-area"]').waitFor({ state: 'visible', timeout: 8000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
          return monacoHandle ? monacoHandle.editor.getDiffEditors().length : 0;
        }),
      { timeout: 8000 },
    )
    .toBe(1);
});

test.afterAll(async () => {
  await browser?.close();
});

function monacoDiffEditorCount(): Promise<number> {
  return page.evaluate(() => {
    const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
    return monacoHandle ? monacoHandle.editor.getDiffEditors().length : 0;
  });
}

/**
 * True if EITHER Monaco sub-editor (original/modified) of the diff carries
 * the given theme class. `.monaco-editor` alone is not enough: the diff
 * editor's own gutter div also carries a bare `.monaco-editor` class with no
 * theme class at all, and it happens to be first in document order, so a
 * single `querySelector('.monaco-editor')` silently reads the wrong node.
 * Both sub-editors always agree - Monaco's theme is a single global value -
 * so this only ever fans out to be safe against DOM-order assumptions.
 */
function monacoEditorHasClass(className: string): Promise<boolean> {
  return page.evaluate((cls) => {
    const editors = Array.from(document.querySelectorAll('.monaco-editor'));
    return editors.some((editorNode) => editorNode.classList.contains(cls));
  }, className);
}

test.describe('DiffViewer follows the Theme tab hover preview', () => {
  test('paints vs-dark for the committed dark theme before any preview', async () => {
    await expect.poll(() => monacoEditorHasClass('vs-dark')).toBe(true);
    expect(await monacoEditorHasClass('vs')).toBe(false);
  });

  test('hovering a light-base tile flips the diff pane to vs, and leaving the grid reverts it', async () => {
    await page.locator('[data-testid="settings-button"]').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByTestId('theme-grid').waitFor({ state: 'visible', timeout: 3000 });

    // The task-detail window (and its Monaco instance) stays mounted behind
    // the settings panel: the settings overlay is a sibling of the board's
    // dismiss-layer subtree (light-dismiss-denylist.md), not a replacement
    // for it.
    expect(await monacoDiffEditorCount()).toBe(1);

    // 'clay' is one of this diff's renamed product-pair ids and a light
    // base, so this also proves the new id resolves through THEME_BASES to
    // Monaco's 'vs', not just that SOME flip happened.
    await page.getByTestId('theme-tile-clay').hover();
    await expect.poll(() => monacoEditorHasClass('vs')).toBe(true);
    expect(await monacoEditorHasClass('vs-dark')).toBe(false);

    // Leaving the grid (the row's label sits outside it) reverts to the
    // committed theme, mirroring theme-swatch-grid.spec.ts's hover-revert cases.
    await page.getByTestId('setting-row-theme').locator(':scope > div').first().hover();
    await expect.poll(() => monacoEditorHasClass('vs-dark')).toBe(true);
    expect(await monacoEditorHasClass('vs')).toBe(false);
  });
});
