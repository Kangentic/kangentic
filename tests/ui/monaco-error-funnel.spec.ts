/**
 * UI coverage for the monaco error funnel (src/renderer/monaco-error-funnel.ts)
 * in the real renderer, for Sentry DESKTOP-19 ("Illegal value for lineNumber").
 *
 * The unit tests drive the funnel and a real monaco Emitter in Node. What only
 * this tier can see is the wiring around them: that monacoConfig.ts installed
 * the funnel on the renderer's monaco, that a mounted DiffViewer registered its
 * snapshot reader (and unregistered it on unmount), that the reader's refs track
 * the viewer's props, and that the UI-test collector (collectPageErrors in
 * helpers.ts) still sees the error now that it no longer reaches `pageerror`.
 *
 * DESKTOP-19 itself has never reproduced (see changes-diff-scroll-memory.spec.ts),
 * so the tests raise the same error from a listener that monaco's Emitter
 * delivers to, which is the catch that hands the real throw to the funnel.
 * Sentry is not initialized here, so the console line is the observable: it
 * carries the contexts the handled report sends. The report's tags are not on
 * that line, so `diff_viewers_live` is read as the number of `diff_viewer_N`
 * contexts, which the funnel builds from the same snapshot list.
 *
 * The funnel reports at most once per 30s per handler instance, so each test
 * gets its own page (and with it a fresh handler) and fires exactly once.
 */
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-monaco-funnel';
const TASK_ID = 'task-monaco-funnel';
const SESSION_ID = 'sess-monaco-funnel';
const FILE_LINES = 400;
const CHANGE_LINE = 200;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Monaco Funnel Test', path: '/mock/monaco-funnel',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999,
      status: 'running', shell: 'bash', cwd: '/mock/monaco-funnel', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Monaco Funnel Task', description: 'Task for the monaco funnel test',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/monaco-funnel', branch_name: 'feature/monaco-funnel',
      pr_number: null, pr_url: null, base_branch: 'main', archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

// funnel.ts is one long file with a single change, so the editor has a real
// scroll range and a foldable unchanged bulk. It is listed first so the viewer
// mounts on it (typescript, split view). notes.md is a second language, which
// is what the prop-tracking test switches to.
const fixture = `
  (function () {
    var lines = [];
    for (var i = 1; i <= ${FILE_LINES}; i++) lines.push('// funnel line ' + i);
    var modified = lines.slice();
    modified[${CHANGE_LINE} - 1] = 'const funnelChanged = true;';
    window.__mockGitDiff = {
      files: [
        {
          path: 'funnel.ts', status: 'M', insertions: 1, deletions: 1,
          original: lines.join('\\n'), modified: modified.join('\\n'), language: 'typescript',
        },
        {
          path: 'notes.md', status: 'M', insertions: 1, deletions: 1,
          original: '# Notes\\n\\nold line\\n', modified: '# Notes\\n\\nnew line\\n', language: 'markdown',
        },
      ],
    };
  })();
`;

interface ScrollEventHandle {
  scrollHeightChanged: boolean;
  scrollHeight: number;
}

interface SubEditorHandle {
  onDidScrollChange: (listener: (event: ScrollEventHandle) => void) => { dispose: () => void };
  setScrollTop: (scrollTop: number) => void;
  getScrollHeight: () => number;
  getModel: () => { getLanguageId: () => string } | null;
}

interface ThrowawayModelHandle {
  onDidChangeContent: (listener: () => void) => { dispose: () => void };
  setValue: (value: string) => void;
  dispose: () => void;
}

interface MonacoTestHandle {
  editor: {
    getDiffEditors: () => Array<{
      getOriginalEditor: () => SubEditorHandle;
      getModifiedEditor: () => SubEditorHandle;
      getLineChanges: () => unknown[] | null;
    }>;
    createModel: (value: string) => ThrowawayModelHandle;
  };
}

interface FunnelContexts {
  call_site: { frames: string[] };
  [contextName: string]: unknown;
}

let browser: Browser;
let context: BrowserContext;
let page: Page;
let funnelLogArguments: unknown[][];

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  await browser?.close();
});

// A fresh context and page per test: a fresh funnel handler (its 30s report
// window starts empty), fresh mock config (the view mode and collapse
// preferences are global and would otherwise leak between tests), and no
// dialog left open by a sibling.
test.beforeEach(async () => {
  funnelLogArguments = [];
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  page.on('console', async (message) => {
    if (message.type() !== 'error' || !message.text().startsWith('[MONACO]')) return;
    funnelLogArguments.push(
      await Promise.all(message.args().map((argument) => argument.jsonValue().catch(() => null))),
    );
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.addInitScript(fixture);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
});

test.afterEach(async () => {
  await context?.close();
});

/** Open the task window, make sure the Changes panel is showing, and return its diff area. */
async function openChangesPanel(): Promise<void> {
  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Monaco Funnel Task').first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  const diffArea = page.locator('[data-testid="diff-editor-area"]');
  try {
    await diffArea.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    await page.locator('[data-testid="changes-toggle"]').click();
    await diffArea.waitFor({ state: 'visible', timeout: 10000 });
  }
}

/** Open the Changes panel on funnel.ts and wait until its diff is computed and the editor is live. */
async function openFunnelFile(): Promise<void> {
  await openChangesPanel();
  await page.locator('button', { hasText: 'funnel.ts' }).first().click();
  await page.locator('.view-line').first().waitFor({ state: 'visible', timeout: 10000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const monaco = (window as unknown as { __monaco?: MonacoTestHandle }).__monaco;
          return monaco?.editor.getDiffEditors()[0]?.getLineChanges()?.length ?? 0;
        }),
      { timeout: 10000 },
    )
    .toBeGreaterThan(0);
}

/**
 * Raise the funnel's error from a listener on a throwaway monaco model. The
 * model has no layout and no connection to any DiffViewer, so this works with
 * no diff editor mounted and says nothing about what a viewer would hold.
 * It reaches the funnel through the same Emitter._deliver catch as the
 * editor-listener throw in the first test.
 */
async function fireFunnelFromThrowawayModel(): Promise<void> {
  await page.evaluate(() => {
    const monaco = (window as unknown as { __monaco: MonacoTestHandle }).__monaco;
    const model = monaco.editor.createModel('before');
    const subscription = model.onDidChangeContent(() => {
      subscription.dispose();
      throw new Error('Illegal value for lineNumber');
    });
    model.setValue('after');
    model.dispose();
  });
}

/** Wait for the single [MONACO] report and return its contexts (the console line's 4th argument). */
async function readReportedContexts(): Promise<FunnelContexts> {
  await expect.poll(() => funnelLogArguments.length, { timeout: 5000 }).toBe(1);
  return funnelLogArguments[0][3] as FunnelContexts;
}

function liveDiffViewerContextNames(contexts: FunnelContexts): string[] {
  return Object.keys(contexts).filter((name) => name.startsWith('diff_viewer_'));
}

async function liveDiffEditorCount(): Promise<number> {
  return page.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: MonacoTestHandle }).__monaco;
    return monaco?.editor.getDiffEditors().length ?? 0;
  });
}

test.describe.configure({ timeout: 45_000 });

test.describe('Monaco error funnel (Sentry DESKTOP-19)', () => {
  test('reports a lineNumber throw from a diff editor listener as handled, with the live DiffViewer snapshot', async () => {
    const getPageErrors = collectPageErrors(page);
    const rawPageErrors: string[] = [];
    page.on('pageerror', (error) => rawPageErrors.push(error.message));

    await openFunnelFile();

    // A listener that throws once, then a scroll the diff editor mirrors onto
    // the original side, which fires it.
    await page.evaluate(() => {
      const monaco = (window as unknown as { __monaco: MonacoTestHandle }).__monaco;
      const diffEditor = monaco.editor.getDiffEditors()[0];
      let fired = false;
      const subscription = diffEditor.getOriginalEditor().onDidScrollChange(() => {
        if (fired) return;
        fired = true;
        subscription.dispose();
        throw new Error('Illegal value for lineNumber');
      });
      diffEditor.getModifiedEditor().setScrollTop(1800);
    });

    // The live DiffViewer's registered reader produced the snapshot.
    const contexts = await readReportedContexts();
    expect(contexts.diff_viewer_1).toMatchObject({
      original_line_count: FILE_LINES,
      modified_line_count: FILE_LINES,
      view_mode: 'split',
      language: 'typescript',
      // No fold timer armed and no re-enable running: the throw is outside the fold path.
      fold_reenable_pending: false,
      fold_reenable_in_progress: false,
    });
    expect(contexts.call_site.frames.length).toBeGreaterThan(0);
    for (const frame of contexts.call_site.frames) {
      expect(frame).not.toMatch(/[\\/]/);
    }

    // Handled, not rethrown. Monaco's default would rethrow from a 0ms timer
    // queued during the throw. A page timer queued now runs after it, and CDP
    // delivers that rethrow's exception before this evaluate's result, so an
    // empty list here means the rethrow never happened.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(rawPageErrors).toEqual([]);
    // The collector still sees it, which keeps every getPageErrors() guard sensitive to it.
    const collected = getPageErrors();
    expect(collected).toHaveLength(1);
    expect(collected[0].startsWith('[MONACO]')).toBe(true);
  });

  // Pins DiffViewer's foldReenableInProgressRef (set true only around the fold
  // timer's updateOptions enable call). Folding 400 lines down to the changed
  // hunk shrinks the original editor's scroll height, which fires its
  // onDidScrollChange from inside that call. The listener ignores every other
  // event (the no-op disable call, a stray scroll) so only the enable can claim
  // the single report.
  test('snapshot reports the fold re-enable as in progress when the throw happens inside it', async () => {
    await openFunnelFile();

    await page.evaluate(() => {
      const monaco = (window as unknown as { __monaco: MonacoTestHandle }).__monaco;
      const originalEditor = monaco.editor.getDiffEditors()[0].getOriginalEditor();
      let previousScrollHeight = originalEditor.getScrollHeight();
      let fired = false;
      const subscription = originalEditor.onDidScrollChange((event) => {
        const shrank = event.scrollHeightChanged && event.scrollHeight < previousScrollHeight;
        previousScrollHeight = event.scrollHeight;
        if (fired || !shrank) return;
        fired = true;
        subscription.dispose();
        throw new Error('Illegal value for lineNumber');
      });
    });

    // Collapse is off by default and the file is unfolded, so turning it on
    // takes applyCollapseFold's disable then timer-driven enable path.
    const optionsTrigger = page.locator('[data-testid="diff-view-options"]');
    const optionsMenu = page.locator('[data-testid="diff-view-options-menu"]');
    await optionsTrigger.click();
    await optionsMenu.waitFor({ state: 'visible', timeout: 5000 });
    const collapseItem = optionsMenu.locator('[data-testid="diff-collapse-unchanged"]');
    await collapseItem.click();
    await expect(collapseItem).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });

    const contexts = await readReportedContexts();
    expect(contexts.diff_viewer_1).toMatchObject({
      hide_unchanged_regions: true,
      // The timer ref is nulled before the enable call, so "pending" is already false.
      fold_reenable_pending: false,
      fold_reenable_in_progress: true,
    });
  });

  // The other half of the pair above, and the guard on the `finally` that
  // resets the flag: once the fold has been applied the flag must read false
  // again, or every later throw would be misread as inside the re-enable.
  test('snapshot reports the fold re-enable as finished for a throw after the fold is applied', async () => {
    await openFunnelFile();

    const optionsTrigger = page.locator('[data-testid="diff-view-options"]');
    const optionsMenu = page.locator('[data-testid="diff-view-options-menu"]');
    await optionsTrigger.click();
    await optionsMenu.waitFor({ state: 'visible', timeout: 5000 });
    const collapseItem = optionsMenu.locator('[data-testid="diff-collapse-unchanged"]');
    await collapseItem.click();
    await expect(collapseItem).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
    // The fold widgets only appear once the timer's enable has run.
    await expect(page.locator('.monaco-diff-editor .diff-hidden-lines').first()).toBeAttached({ timeout: 10000 });

    await fireFunnelFromThrowawayModel();

    const contexts = await readReportedContexts();
    expect(contexts.diff_viewer_1).toMatchObject({
      hide_unchanged_regions: true,
      fold_reenable_pending: false,
      fold_reenable_in_progress: false,
    });
    expect(Number((contexts.diff_viewer_1 as Record<string, unknown>).folded_region_count)).toBeGreaterThan(0);
  });

  // Pins DiffViewer's layout effect that mirrors viewMode and language into
  // viewModeRef / languageRef. The viewer mounts in split view on typescript,
  // and useRef captured exactly those at mount, so a snapshot that still says
  // 'split' / 'typescript' after the props moved means the mirror is gone.
  test('snapshot tracks view mode and language changes made after mount', async () => {
    await openFunnelFile();

    await page.locator('[data-testid="diff-view-inline"]').click();
    await expect(page.locator('[data-testid="diff-view-inline"]')).toHaveClass(/bg-surface-raised/, { timeout: 5000 });

    await page.locator('button', { hasText: 'notes.md' }).first().click();
    // The markdown toggle renders only when the language prop is markdown, so
    // it is on screen in the same commit that updated languageRef.
    await page.locator('[data-testid="diff-markdown-preview"]').waitFor({ state: 'visible', timeout: 10000 });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const monaco = (window as unknown as { __monaco?: MonacoTestHandle }).__monaco;
            return monaco?.editor.getDiffEditors()[0]?.getModifiedEditor().getModel()?.getLanguageId() ?? null;
          }),
        { timeout: 10000 },
      )
      .toBe('markdown');

    await fireFunnelFromThrowawayModel();

    const contexts = await readReportedContexts();
    expect(contexts.diff_viewer_1).toMatchObject({
      view_mode: 'inline',
      language: 'markdown',
    });
  });

  // Pins the unregister that the registration effect returns. A stale reader
  // would still be in the funnel's set after unmount, holding the disposed
  // editor (only the binary and preview branches null diffEditorRef), and
  // would show up as a diff_viewer_1 context.
  test('a closed task window leaves no DiffViewer reader behind', async () => {
    await openFunnelFile();

    // Control+Shift+W rather than Escape: Monaco may hold focus, and the
    // bubble-phase Escape listener is the one it can intercept.
    await page.keyboard.press('Control+Shift+W');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-editor-area"]')).toHaveCount(0, { timeout: 8000 });
    await expect.poll(liveDiffEditorCount, { timeout: 8000 }).toBe(0);

    await fireFunnelFromThrowawayModel();

    const contexts = await readReportedContexts();
    expect(liveDiffViewerContextNames(contexts)).toEqual([]);
  });

  // Pins the reader's null branch (diffEditorRef is null while the markdown
  // preview shows). Without the guard the reader would hand a null editor to
  // the snapshot, whose per-field catches turn that into a diff_viewer_1
  // context full of "threw:" strings instead of no context at all.
  test('a viewer showing the markdown preview reports no snapshot', async () => {
    await openChangesPanel();
    await page.locator('button', { hasText: 'notes.md' }).first().click();
    await page.locator('[data-testid="diff-markdown-preview"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.view-line').first().waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('[data-testid="diff-markdown-preview"]').click();
    await page.locator('[data-testid="diff-markdown-preview-content"]').waitFor({ state: 'visible', timeout: 5000 });
    // The preview unmounts the DiffEditor; the viewer drops its ref in an
    // effect right after, so a settled editor count of zero means it ran.
    await expect.poll(liveDiffEditorCount, { timeout: 8000 }).toBe(0);

    await fireFunnelFromThrowawayModel();

    const contexts = await readReportedContexts();
    expect(liveDiffViewerContextNames(contexts)).toEqual([]);
  });
});
