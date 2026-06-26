/**
 * UI tests for Monaco DiffEditor teardown when the Changes panel is toggled.
 *
 * Background:
 * The task-detail Changes panel mounts a @monaco-editor/react DiffEditor and
 * unmounts it instantly when toggled closed. On unmount the library disposes
 * the DiffEditor's two TextModels before the widget, so monaco throws a
 * self-healing BugIndicatingError ("TextModel got disposed before
 * DiffEditorWidget model got reset"). It is benign and does not leak: both
 * models are disposed regardless of order, so `editor.getModels()` returns to
 * baseline. See src/renderer/components/dialogs/task-detail/changes/DiffViewer.tsx
 * and https://github.com/suren-atoyan/monaco-react/issues/647
 *
 * This spec locks three properties under rapid open/close:
 *   1. No NON-benign renderer errors (the known monaco message is filtered by
 *      the shared collector; anything else fails).
 *   2. No model leak - rapid open/close does not accumulate TextModels; the
 *      registry returns to its baseline count once the panel is closed.
 *   3. The benign monaco message no longer surfaces as an uncaught pageerror at
 *      all: monacoConfig.ts wraps monaco's error funnel
 *      (errorHandler.unexpectedErrorHandler) to swallow it at the source before
 *      monaco re-throws it to the window, so it stops rendering red in the
 *      console. A regression that dropped that wrapper would let it fire again.
 *
 * Tier: UI (headless Chromium). A diff fixture is seeded via the mock's
 * __mockGitDiff hook so a real DiffEditor mounts; no PTY or real git needed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors, isBenignRendererError } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-diff-${RUN_ID}`;
const TASK_ID = `task-diff-${RUN_ID}`;
const SESSION_ID = `sess-diff-${RUN_ID}`;

// Two changed files with real (differing) content so the DiffEditor mounts with
// non-empty original/modified models.
const DIFF_FIXTURE = {
  files: [
    {
      path: 'src/alpha.ts',
      status: 'M',
      insertions: 1,
      deletions: 1,
      original: 'export const value = 1;\n',
      modified: 'export const value = 2;\n',
      language: 'typescript',
    },
    {
      path: 'src/beta.ts',
      status: 'M',
      insertions: 2,
      deletions: 0,
      original: 'function noop() {}\n',
      modified: 'function noop() {}\nfunction extra() {}\nfunction more() {}\n',
      language: 'typescript',
    },
  ],
};

/**
 * Read the number of live monaco TextModels via the dev-only window.__monaco
 * handle (installed in monacoConfig.ts under import.meta.env.DEV). Returns 0
 * before monaco is loaded (the handle is set when ChangesPanel first imports
 * monacoConfig).
 */
async function getModelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const handle = (window as unknown as {
      __monaco?: { editor: { getModels: () => unknown[] } };
    }).__monaco;
    return handle ? handle.editor.getModels().length : 0;
  });
}

/**
 * Launch a headless page with a project, an Executing lane (so canShowChanges
 * is true), a task with a suspended session, and the diff fixture seeded.
 *
 * The suspended session matters for two reasons: a session-less, non-archived
 * task auto-opens the dialog in edit mode (TaskCard initialEdit), which has no
 * header pills; and the suspended body branch renders the Changes panel next to
 * the Resume button without mounting a live TerminalTab, so no PTY is needed.
 */
async function launchWithDiffTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.addInitScript(`
    window.__mockGitDiff = ${JSON.stringify(DIFF_FIXTURE)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Diff Disposal Test ${RUN_ID}',
        path: '/mock/diff-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-diff-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId,
          position: index,
          created_at: ts,
        }));
      });

      // Suspended session so the dialog opens in view mode (not edit) and the
      // suspended body branch renders the Changes panel.
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: null,
        status: 'suspended',
        shell: 'bash',
        cwd: '/mock/diff-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Diff Disposal Task ${RUN_ID}',
        description: 'Toggling Changes mounts and unmounts the Monaco DiffEditor',
        swimlane_id: executingLaneId,
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        labels: [],
        priority: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });

  // Keep the session suspended: the dialog's reconcile-on-mount probe must not
  // heal it into a live (terminal) session, which would change the body branch.
  await page.evaluate(() => {
    window.electronAPI.sessions.reconcile = async function () {
      return null;
    };
  });

  return { browser, page };
}

test.describe('Changes panel - Monaco DiffEditor disposal', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithDiffTask());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('rapid open/close leaves no leaked TextModels and no unexpected errors', async () => {
    // Attach the error collector before any interaction so the full
    // mount/unmount window is covered. The known monaco disposal message is
    // filtered; anything else fails the assertion below.
    const getPageErrors = collectPageErrors(page);

    // A second, RAW collector that keeps every pageerror unfiltered. Used to
    // assert the benign monaco message no longer reaches the page at all
    // (monacoConfig.ts suppresses it at monaco's error funnel before it is
    // re-thrown to the window).
    const rawPageErrors: string[] = [];
    page.on('pageerror', (error) => rawPageErrors.push(error.message));

    // Open the task dialog (view mode, since the session is suspended). The
    // suspended body branch renders the Changes panel once Changes is toggled on.
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    await card.waitFor({ state: 'visible', timeout: 5000 });
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Baseline: monaco is not loaded until ChangesPanel first mounts, so the
    // registry is empty.
    expect(await getModelCount(page)).toBe(0);

    const changesToggle = page.locator('[data-testid="changes-toggle"]');
    const diffArea = page.locator('[data-testid="diff-editor-area"]');
    await changesToggle.waitFor({ state: 'visible', timeout: 5000 });

    // Five open/close cycles. A correct (leak-free) teardown holds the model
    // count at exactly 2 while open (original + modified) and returns it to 0
    // while closed, regardless of how many cycles run. A leak would show the
    // closed-state count climbing by 2 each cycle.
    const CYCLES = 5;
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      await changesToggle.click();
      // Wait for the DiffEditor to actually mount (onMount creates the models).
      await diffArea.waitFor({ state: 'visible', timeout: 5000 });
      await expect.poll(() => getModelCount(page), { timeout: 5000 }).toBe(2);

      await changesToggle.click();
      await diffArea.waitFor({ state: 'hidden', timeout: 5000 });
      // The leak assertion: closed state always returns to baseline.
      await expect.poll(() => getModelCount(page), { timeout: 5000 }).toBe(0);
    }

    // No non-benign renderer errors across all the teardowns. The monaco
    // disposal-order message is expected and filtered by collectPageErrors.
    expect(getPageErrors()).toHaveLength(0);

    // The benign monaco message must not have surfaced as an uncaught pageerror
    // at all: monacoConfig.ts swallows it at monaco's error funnel before it is
    // re-thrown to the window, so it stops rendering red in the console. Before
    // that wrapper this raw collector would have caught it on every teardown.
    const benignThatLeaked = rawPageErrors.filter((message) => isBenignRendererError(message));
    expect(benignThatLeaked).toHaveLength(0);
  });
});
