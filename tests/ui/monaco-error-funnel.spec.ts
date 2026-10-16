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
 * The funnel-wiring tests raise the same error from a listener that monaco's
 * Emitter delivers to, which is the catch that hands the real throw to the
 * funnel, so they do not depend on the crash's own preconditions. Sentry is not
 * initialized here, so the console line is the observable, and it carries the
 * contexts the handled report sends. The report's tags are not on that line,
 * so `diff_viewers_live` is read as the number of `diff_viewer_N` contexts,
 * which the funnel builds from the same snapshot list.
 *
 * DESKTOP-19 itself is reproduced by the describe block at the bottom: a
 * shorter text swapped into a mounted, scrolled-down diff. Those cases read
 * red against the old in-place content flush and green against DiffViewer's
 * detached swap.
 *
 * The last describe block covers the swap's other entry point. Text that
 * reaches the viewer between the DiffEditor mounting and the library calling
 * onMount can only be applied by handleEditorMount's own swap.
 *
 * The funnel reports at most once per 30s per handler instance, so each test
 * gets its own page (and with it a fresh handler) and fires at most once.
 */
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import {
  waitForViteReady,
  collectPageErrors,
  gotoVite,
  readModifiedFirstChangeLine,
  scrollModifiedToBottom,
  waitForDiffToSettle,
} from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-monaco-funnel';
const TASK_ID = 'task-monaco-funnel';
const SESSION_ID = 'sess-monaco-funnel';
const FILE_LINES = 400;
const CHANGE_LINE = 200;

// The content-swap files (the DESKTOP-19 describe block at the bottom). Each
// first change sits on a line no other file uses, so readModifiedFirstChangeLine
// names whose diff has landed. They use a language the test registers itself,
// with no tokenizer until the test supplies one (see that block for why).
const SWAP_LANGUAGE = 'swap-fixture';
const LONG_FILE = 'long.cs';
const LONG_LINES = 1200;
const LONG_CHANGE_LINE = 1101;
const SHORT_FILE = 'short.cs';
const SHORT_LINES = 500;
const SHORT_CHANGE_LINE = 41;
const TINY_FILE = 'tiny.cs';
const TINY_CHANGE_LINE = 3;
// The shorter long.cs a same-file refresh swaps in.
const SHRUNK_LONG_LINES = 500;
const SHRUNK_LONG_CHANGE_LINE = 71;
// Rows the inserted blocks add to the modified side. Both 0.45.0 events had the
// modified side reaching well past the original's last line, which is what puts
// the mirrored original scroll past the new original's end.
const INSERTED_LINES = 60;

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
//
// long.cs, short.cs and tiny.cs are the content-swap files. They sit in a
// separate list, window.__contentSwapFixture, which the DESKTOP-19 describe
// block at the bottom installs before it reopens the panel, so the viewer
// mounts directly on long.cs (that block says why it must).
const fixture = `
  (function () {
    var lines = [];
    for (var i = 1; i <= ${FILE_LINES}; i++) lines.push('// funnel line ' + i);
    var modified = lines.slice();
    modified[${CHANGE_LINE} - 1] = 'const funnelChanged = true;';

    function csharpLines(label, count) {
      var result = [];
      for (var lineNumber = 1; lineNumber <= count; lineNumber++) {
        result.push('int ' + label + lineNumber + ' = ' + lineNumber + '; string name' + lineNumber + ' = "value";');
      }
      return result;
    }
    function addedLines(label, count) {
      var result = [];
      for (var index = 1; index <= count; index++) result.push('bool ' + label + index + ' = true;');
      return result;
    }
    function insertAfter(base, afterLine, inserted) {
      return base.slice(0, afterLine).concat(inserted).concat(base.slice(afterLine));
    }

    // Ten lines rewritten near the end, so the inline view shows a deleted
    // block past every shorter file's last line.
    var longOriginal = csharpLines('longValue', ${LONG_LINES});
    var longModified = longOriginal.slice();
    for (var changed = ${LONG_CHANGE_LINE}; changed < ${LONG_CHANGE_LINE} + 10; changed++) {
      longModified[changed - 1] = 'string longChanged' + changed + ' = "changed";';
    }
    var shortOriginal = csharpLines('shortValue', ${SHORT_LINES});
    var shortEdited = shortOriginal.slice();
    shortEdited[300 - 1] = 'string shortChanged = "changed";';
    var shortModified = insertAfter(shortEdited, ${SHORT_CHANGE_LINE - 1}, addedLines('shortAdded', ${INSERTED_LINES}));
    var tinyOriginal = csharpLines('tinyValue', 10);
    var tinyModified = tinyOriginal.slice();
    tinyModified[${TINY_CHANGE_LINE} - 1] = 'string tinyChanged = "changed";';
    var shrunkOriginal = longOriginal.slice(0, ${SHRUNK_LONG_LINES});
    window.__shrunkLongFile = {
      original: shrunkOriginal.join('\\n'),
      modified: insertAfter(shrunkOriginal, ${SHRUNK_LONG_CHANGE_LINE - 1}, addedLines('longAdded', ${INSERTED_LINES})).join('\\n'),
    };

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
    window.__contentSwapFixture = {
      files: [
        {
          path: '${LONG_FILE}', status: 'M', insertions: 10, deletions: 10,
          original: longOriginal.join('\\n'), modified: longModified.join('\\n'), language: '${SWAP_LANGUAGE}',
        },
        {
          path: '${SHORT_FILE}', status: 'M', insertions: ${INSERTED_LINES + 1}, deletions: 1,
          original: shortOriginal.join('\\n'), modified: shortModified.join('\\n'), language: '${SWAP_LANGUAGE}',
        },
        {
          path: '${TINY_FILE}', status: 'M', insertions: 1, deletions: 1,
          original: tinyOriginal.join('\\n'), modified: tinyModified.join('\\n'), language: '${SWAP_LANGUAGE}',
        },
      ],
    };
  })();
`;

interface ScrollEventHandle {
  scrollHeightChanged: boolean;
  scrollHeight: number;
}

interface ModelHandle {
  getLanguageId: () => string;
  getLineCount: () => number;
  onDidChangeTokens: (listener: () => void) => { dispose: () => void };
  /** monaco's TokenizationTextModelPart; `backgroundTokenizationState` is a BackgroundTokenizationState. */
  tokenization: { backgroundTokenizationState: number };
}

interface SubEditorHandle {
  onDidScrollChange: (listener: (event: ScrollEventHandle) => void) => { dispose: () => void };
  setScrollTop: (scrollTop: number) => void;
  getScrollTop: () => number;
  getScrollHeight: () => number;
  getLayoutInfo: () => { height: number };
  getModel: () => ModelHandle | null;
}

interface ThrowawayModelHandle {
  onDidChangeContent: (listener: () => void) => { dispose: () => void };
  setValue: (value: string) => void;
  dispose: () => void;
}

interface DiffEditorHandle {
  getOriginalEditor: () => SubEditorHandle;
  getModifiedEditor: () => SubEditorHandle;
  getLineChanges: () => unknown[] | null;
  onDidUpdateDiff: (listener: () => void) => { dispose: () => void };
}

interface MonacoTestHandle {
  editor: {
    getDiffEditors: () => DiffEditorHandle[];
    onDidCreateDiffEditor: (listener: (diffEditor: DiffEditorHandle) => void) => { dispose: () => void };
    createModel: (value: string) => ThrowawayModelHandle;
  };
  languages: {
    register: (language: { id: string }) => void;
    setMonarchTokensProvider: (languageId: string, language: unknown) => { dispose: () => void };
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
  await gotoVite(page, VITE_URL);
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

// monaco's BackgroundTokenizationState values (editor/common/model.js).
const TOKENIZATION_IN_PROGRESS = 1;
const TOKENIZATION_COMPLETED = 2;
// Halfway down long.cs at 18px a line. The original editor is past it only
// once the scroll to the bottom has been mirrored onto it.
const DEEP_SCROLL_TOP_PX = (LONG_LINES / 2) * 18;
// The width at or below which Monaco renders a Side by side selection inline
// (renderSideBySideInlineBreakpoint, which DiffViewer pins at 900).
const MONACO_SIDE_BY_SIDE_BREAKPOINT_PX = 900;

/** What the recorder in openLongFile saw of the original model's first background tokenization pass. */
interface SwapTokenRecord {
  /** backgroundTokenizationState at each token event. */
  eventStates: number[];
  /** backgroundTokenizationState when the first diff with line changes landed. */
  stateAtFirstDiff: number | null;
}

interface SwapScrollState {
  originalScrollTop: number;
  modifiedScrollTop: number;
  modifiedMaxScrollTop: number;
  originalLineCount: number;
}

async function readSwapScrollState(): Promise<SwapScrollState> {
  return page.evaluate(() => {
    const diffEditor = (window as unknown as { __monaco: MonacoTestHandle }).__monaco.editor.getDiffEditors()[0];
    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    return {
      originalScrollTop: originalEditor.getScrollTop(),
      modifiedScrollTop: modifiedEditor.getScrollTop(),
      modifiedMaxScrollTop: Math.max(0, modifiedEditor.getScrollHeight() - modifiedEditor.getLayoutInfo().height),
      originalLineCount: originalEditor.getModel()?.getLineCount() ?? -1,
    };
  });
}

async function readOriginalTokenizationState(): Promise<number> {
  return page.evaluate(() => {
    const diffEditor = (window as unknown as { __monaco: MonacoTestHandle }).__monaco.editor.getDiffEditors()[0];
    return diffEditor.getOriginalEditor().getModel()?.tokenization.backgroundTokenizationState ?? -1;
  });
}

/**
 * Sentry DESKTOP-19 reproduced: new text that is shorter than the old reaching
 * a MOUNTED diff while it is scrolled down. Read from monaco 0.57.0:
 *
 * 1. A content flush runs the model's tokenization handling before any view
 *    model hears of it (textModel.js `_emitContentChangedEvent`). On a flush
 *    the tokenizer refreshes the attached views' visible lines and fires
 *    `onDidChangeTokens` (tokenizerSyntaxTokenBackend.js
 *    `refreshAllVisibleLineTokens`), while the original editor is still laid
 *    out for the old text.
 * 2. The inline branch of the diff editor's view-zone derivation reads the
 *    original's tokenization state (diffEditorViewZones.js), so it re-runs
 *    against the stale diff, truncates its zones, and shrinks the modified
 *    editor. Scrolled to the bottom, the modified scrollTop clamps, "update
 *    scroll original" mirrors it, and the original's stale view walks lines
 *    past the new text's end: "Illegal value for lineNumber".
 *
 * The preconditions, each asserted before the swap:
 *
 * - The diff renders INLINE. True side by side never reads tokens there. A
 *   Side by side selection renders inline anyway below Monaco's 900px
 *   breakpoint, which the unmaximized task window is, so the split case runs
 *   on that.
 * - The language has a tokenizer, or no token event fires at all.
 * - The derivation reads the tokenization state through an observable of
 *   `backgroundTokenizationState === Completed` that notifies only when the
 *   value CHANGES. A model's tokenizer backend reports Completed once and
 *   never reports in progress again (a flush or a language change
 *   re-tokenizes silently), so the observable can only hold false if it was
 *   first read during the model's FIRST background pass. Measured: the
 *   backend outlives a typescript to csharp switch, every event after it
 *   read Completed, and nothing threw. So the viewer has to mount on the
 *   long file, its first diff has to land before that first pass finishes
 *   (openLongFile holds the tokenizer back until it has), and no token event
 *   may fire between the pass finishing and the swap.
 *
 * In the app that is the first shortening swap after a diff editor mounts on
 * a file long enough to still be tokenizing when its diff lands, which fits
 * both 0.45.0 events (a 6000-line csharp file, a 1150-line yaml file).
 *
 * Each case runs on its own page (see beforeEach). The funnel logs only the
 * first throw per 30s, so a shared page would let a later case pass for
 * nothing.
 */
test.describe('Content swap on a mounted diff (Sentry DESKTOP-19)', () => {
  /**
   * Mount the viewer ON long.cs with the chosen view mode, wait for long.cs's
   * own diff, and only then give its language a tokenizer, so the first diff
   * lands while the original model's first background pass has not even
   * started. A recorder hooks the diff editor the moment it is created and
   * sees every token event and the tokenization state at the first diff.
   *
   * Pinning that order is the point. With a real lazily loaded tokenizer
   * (csharp) it is a race between the diff worker and idle-time tokenizing:
   * it reproduced on a quiet machine and lost about one run in four with
   * three Playwright workers sharing the CPU.
   *
   * window.__monaco only exists once the Changes panel's chunk has loaded,
   * which is a few promise hops before it creates its editor, too close to
   * hook reliably. So the panel opens once on the default files to load
   * monaco, the task window closes (unmounting that editor), and the swap
   * files go in before the window reopens. The panel comes back open, and
   * with funnel.ts gone from the list it selects long.cs.
   */
  async function openLongFile(viewMode: 'split' | 'inline'): Promise<void> {
    await openChangesPanel();
    await page.locator('.view-line').first().waitFor({ state: 'visible', timeout: 10000 });
    // Control+Shift+W rather than Escape: Monaco may hold focus.
    await page.keyboard.press('Control+Shift+W');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
    await expect.poll(liveDiffEditorCount, { timeout: 8000 }).toBe(0);

    await page.evaluate(({ mode, languageId }) => {
      const pageWindow = window as unknown as {
        __monaco: MonacoTestHandle;
        __mockGitDiff: unknown;
        __contentSwapFixture: unknown;
        __zustandStores: {
          config: { getState: () => { updateConfig: (partial: { diffViewMode: 'split' | 'inline' }) => Promise<void> } };
        };
        __swapTokenRecord: SwapTokenRecord;
      };
      // Registered with no tokenizer yet, so the models' background pass cannot start.
      pageWindow.__monaco.languages.register({ id: languageId });
      pageWindow.__mockGitDiff = pageWindow.__contentSwapFixture;
      void pageWindow.__zustandStores.config.getState().updateConfig({ diffViewMode: mode });
      const record: SwapTokenRecord = { eventStates: [], stateAtFirstDiff: null };
      pageWindow.__swapTokenRecord = record;
      const subscription = pageWindow.__monaco.editor.onDidCreateDiffEditor((diffEditor) => {
        subscription.dispose();
        // @monaco-editor/react attaches the models right after it creates the editor.
        queueMicrotask(() => {
          const originalModel = diffEditor.getOriginalEditor().getModel();
          if (originalModel === null) return;
          originalModel.onDidChangeTokens(() => {
            record.eventStates.push(originalModel.tokenization.backgroundTokenizationState);
          });
          diffEditor.onDidUpdateDiff(() => {
            if (record.stateAtFirstDiff !== null || diffEditor.getLineChanges() === null) return;
            record.stateAtFirstDiff = originalModel.tokenization.backgroundTokenizationState;
          });
        });
      });
    }, { mode: viewMode, languageId: SWAP_LANGUAGE });
    await openChangesPanel();
    await expect(page.locator('button', { hasText: LONG_FILE }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`[data-testid="diff-view-${viewMode}"]`)).toHaveClass(/bg-surface-raised/, { timeout: 5000 });
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(LONG_CHANGE_LINE);
    await waitForDiffToSettle(page);
    // Inline in both modes, or the chain cannot run (see the block comment).
    await expect(page.locator('.monaco-diff-editor.side-by-side')).not.toBeVisible();

    const stateAtFirstDiff = await page.evaluate(
      () => (window as unknown as { __swapTokenRecord: SwapTokenRecord }).__swapTokenRecord.stateAtFirstDiff,
    );
    expect(stateAtFirstDiff, 'the first diff must land before the first background pass finishes').toBe(
      TOKENIZATION_IN_PROGRESS,
    );
    // Now the pass can run. A Monarch tokenizer for the fixture's C#-like
    // lines, with enough token kinds to paint more than one token class.
    await page.evaluate((languageId) => {
      const monaco = (window as unknown as { __monaco: MonacoTestHandle }).__monaco;
      monaco.languages.setMonarchTokensProvider(languageId, {
        keywords: ['int', 'string', 'bool', 'true'],
        tokenizer: {
          root: [
            [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
            [/\d+/, 'number'],
            [/"[^"]*"/, 'string'],
            [/[=;]/, 'delimiter'],
          ],
        },
      });
    }, SWAP_LANGUAGE);
  }

  /**
   * The tokenizer preconditions, asserted right before the swap, and a stash
   * of the editor that receives it. If a case goes green against a broken
   * build, this is where it says which precondition was missing.
   */
  async function assertSwapPreconditions(): Promise<void> {
    await expect.poll(readOriginalTokenizationState, { timeout: 15000 }).toBe(TOKENIZATION_COMPLETED);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const tokenClasses = new Set<string>();
            document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line span').forEach((span) => {
              span.classList.forEach((className) => {
                if (className.startsWith('mtk')) tokenClasses.add(className);
              });
            });
            return tokenClasses.size;
          }),
        { message: 'the fixture language should tokenize into more than one token class', timeout: 5000 },
      )
      .toBeGreaterThan(1);
    const record = await page.evaluate(() => (window as unknown as { __swapTokenRecord: SwapTokenRecord }).__swapTokenRecord);
    expect(
      record.eventStates.filter((state) => state !== TOKENIZATION_IN_PROGRESS),
      'no token event may fire once the background pass is done, or it spends the flip before the swap',
    ).toEqual([]);
    await page.evaluate(() => {
      const pageWindow = window as unknown as { __monaco: MonacoTestHandle; __diffEditorBeforeSwap: unknown };
      pageWindow.__diffEditorBeforeSwap = pageWindow.__monaco.editor.getDiffEditors()[0];
    });
  }

  /** The swap landed on the same mounted editor (not a remount), and nothing threw. */
  async function assertSameEditorAndNoErrors(getPageErrors: () => string[]): Promise<void> {
    const sameEditor = await page.evaluate(() => {
      const pageWindow = window as unknown as { __monaco: MonacoTestHandle; __diffEditorBeforeSwap: unknown };
      const diffEditors = pageWindow.__monaco.editor.getDiffEditors();
      return diffEditors.length === 1 && diffEditors[0] === pageWindow.__diffEditorBeforeSwap;
    });
    expect(sameEditor).toBe(true);
    // collectPageErrors also collects the funnel's [MONACO] console line.
    expect(getPageErrors()).toEqual([]);
  }

  async function scrollLongFileToBottom(): Promise<void> {
    await scrollModifiedToBottom(page);
    await expect
      .poll(async () => (await readSwapScrollState()).originalScrollTop, { timeout: 10000 })
      .toBeGreaterThan(DEEP_SCROLL_TOP_PX);
  }

  for (const viewMode of ['inline', 'split'] as const) {
    test(`switching from a long file at its bottom to a shorter one throws nothing (${viewMode})`, async () => {
      const getPageErrors = collectPageErrors(page);
      await openLongFile(viewMode);
      if (viewMode === 'split') {
        await expect
          .poll(
            () => page.evaluate(() => document.querySelector('.monaco-diff-editor')?.getBoundingClientRect().width ?? 0),
            { timeout: 5000 },
          )
          .toBeLessThanOrEqual(MONACO_SIDE_BY_SIDE_BREAKPOINT_PX);
      }
      await scrollLongFileToBottom();
      await assertSwapPreconditions();

      await page.locator('button', { hasText: SHORT_FILE }).first().click();
      await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(SHORT_CHANGE_LINE);
      await waitForDiffToSettle(page);

      await assertSameEditorAndNoErrors(getPageErrors);
    });
  }

  // The panel refetches the open file on every fs.watch push and hands the
  // mounted viewer the new text, so an agent shortening the file you are
  // reading takes the same path as a file switch. The scroll assertion is
  // what rules out a fix that resets the scroll before swapping, which would
  // also stop the throw by sending the reader to the top.
  test('a same-file refresh that shortens the open file at its bottom throws nothing and keeps the reader at the bottom', async () => {
    const getPageErrors = collectPageErrors(page);
    await openLongFile('inline');
    await scrollLongFileToBottom();
    await assertSwapPreconditions();

    await page.evaluate((filePath) => {
      const pageWindow = window as unknown as {
        __mockGitDiff: { files: Array<{ path: string; original: string; modified: string }> };
        __shrunkLongFile: { original: string; modified: string };
        __mockFireDiffChanged: () => void;
      };
      const entry = pageWindow.__mockGitDiff.files.find((file) => file.path === filePath);
      if (!entry) throw new Error(`no fixture entry for ${filePath}`);
      entry.original = pageWindow.__shrunkLongFile.original;
      entry.modified = pageWindow.__shrunkLongFile.modified;
      pageWindow.__mockFireDiffChanged();
    }, LONG_FILE);
    await expect
      .poll(async () => (await readSwapScrollState()).originalLineCount, { timeout: 10000 })
      .toBe(SHRUNK_LONG_LINES);
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(SHRUNK_LONG_CHANGE_LINE);
    await waitForDiffToSettle(page);

    await assertSameEditorAndNoErrors(getPageErrors);
    const scrollState = await readSwapScrollState();
    expect(scrollState.modifiedMaxScrollTop).toBeGreaterThan(0);
    // One line of slack, because the assertion is "still at the bottom", not
    // a pixel offset (cross-platform-parity.md).
    expect(scrollState.modifiedScrollTop).toBeGreaterThanOrEqual(scrollState.modifiedMaxScrollTop - 20);
  });

  // A guard, not a reproduction. This passes against the in-place flush too,
  // with every precondition above met. The new original is shorter than one
  // viewport, so at scrollTop 0 the original's stale view does span lines the
  // new text lacks, but nothing walks it. No scroll position moves at 0, so
  // neither editor clamps and "update scroll original" never fires. It stays
  // to cover a swap to a target shorter than one viewport.
  test('switching from a long file at its top to a ten-line file throws nothing', async () => {
    const getPageErrors = collectPageErrors(page);
    await openLongFile('inline');
    // The first visit revealed long.cs's change deep in the file.
    await page.evaluate(() => {
      (window as unknown as { __monaco: MonacoTestHandle }).__monaco.editor.getDiffEditors()[0].getModifiedEditor().setScrollTop(0);
    });
    await expect
      .poll(async () => {
        const scrollState = await readSwapScrollState();
        return scrollState.originalScrollTop + scrollState.modifiedScrollTop;
      }, { timeout: 5000 })
      .toBe(0);
    await assertSwapPreconditions();

    await page.locator('button', { hasText: TINY_FILE }).first().click();
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(TINY_CHANGE_LINE);
    await waitForDiffToSettle(page);

    await assertSameEditorAndNoErrors(getPageErrors);
  });
});

// funnel.ts as a same-file refresh leaves it: one early line rewritten instead
// of line 200, and a block appended. The line count and the first change line
// both differ from the file the viewer mounted with (400 lines, change at 200),
// so either one says which text the editor holds.
const MOUNT_REFRESH_CHANGE_LINE = 120;
const MOUNT_REFRESH_APPENDED_LINES = 25;
const MOUNT_REFRESH_MODIFIED_LINES = FILE_LINES + MOUNT_REFRESH_APPENDED_LINES;
const MOUNT_REFRESH_TOKEN = 'refreshedBeforeMount';

/**
 * DiffViewer hands @monaco-editor/react only the text its models are built from
 * at creation (MountContentDiffEditor), so the library never applies a later
 * change itself. Text that reaches the viewer after the DiffEditor has mounted
 * with the old text and before the library calls onMount cannot go in through
 * the layout-effect swap, which has no editor to act on yet. It goes in through
 * the one swap handleEditorMount makes after it attaches its listeners. Without
 * that call the editor keeps the text it was built with while the viewer
 * believes it shows the new text, and nothing ever corrects it.
 *
 * How the test lands text in that window. Hooking monaco's
 * onDidCreateDiffEditor is too late. Measured with logging in DiffViewer,
 * onMount ran before the first promise callback of a refresh fired from that
 * hook, and the refetch path has no timer, so the refreshed text reached the
 * viewer after onMount and the layout-effect swap applied it. The test passed
 * with handleEditorMount's swap removed. A MutationObserver starts the refresh
 * earlier, at the microtask checkpoint after the commit that mounts the
 * DiffEditor's wrapper, before monaco has created an editor. Measured the same
 * way, at onMount the viewer already displayed the refreshed text while the
 * editor was built from the old text.
 *
 * Reads red with handleEditorMount's swapDiffContent call removed. The editor
 * keeps funnel.ts's 400 lines.
 */
test.describe('Content that arrives before the editor finishes mounting', () => {
  test('is swapped into the editor at mount', async () => {
    const getPageErrors = collectPageErrors(page);

    // The first open only has to finish. It leaves funnel.ts selected and its
    // Changes panel open, so the reopen below builds a new editor on funnel.ts.
    await openFunnelFile();
    await page.keyboard.press('Control+Shift+W');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
    await expect.poll(liveDiffEditorCount, { timeout: 8000 }).toBe(0);

    await page.evaluate(
      ({ filePath, changeLine, appendedLines, token }) => {
        const pageWindow = window as unknown as {
          __mockGitDiff: { files: Array<{ path: string; original: string; modified: string }> };
          __mockFireDiffChanged: () => void;
          __refreshFiredAtEditorMount?: boolean;
        };
        const entry = pageWindow.__mockGitDiff.files.find((file) => file.path === filePath);
        if (!entry) throw new Error(`no fixture entry for ${filePath}`);
        const refreshedLines = entry.original.split('\n');
        refreshedLines[changeLine - 1] = `const ${token} = true;`;
        for (let appendedIndex = 1; appendedIndex <= appendedLines; appendedIndex++) {
          refreshedLines.push(`// appended after mount ${appendedIndex}`);
        }
        const refreshedModified = refreshedLines.join('\n');
        const observer = new MutationObserver(() => {
          // The wrapper section is the DiffEditor's own root. It is in the DOM
          // from the commit that mounts it, long before monaco builds an editor.
          if (document.querySelector('[data-testid="diff-editor-area"] section') === null) return;
          observer.disconnect();
          entry.modified = refreshedModified;
          pageWindow.__refreshFiredAtEditorMount = true;
          pageWindow.__mockFireDiffChanged();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      },
      {
        filePath: 'funnel.ts',
        changeLine: MOUNT_REFRESH_CHANGE_LINE,
        appendedLines: MOUNT_REFRESH_APPENDED_LINES,
        token: MOUNT_REFRESH_TOKEN,
      },
    );
    await openChangesPanel();
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __refreshFiredAtEditorMount?: boolean }).__refreshFiredAtEditorMount === true),
        { message: 'the refresh must have fired when the DiffEditor mounted', timeout: 10000 },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          page.evaluate((token) => {
            const diffEditors = (window as unknown as { __monaco: MonacoTestHandle }).__monaco.editor.getDiffEditors();
            const modifiedModel = diffEditors[0]?.getModifiedEditor().getModel();
            if (!modifiedModel) return { lineCount: -1, hasToken: false };
            return { lineCount: modifiedModel.getLineCount(), hasToken: modifiedModel.getValue().includes(token) };
          }, MOUNT_REFRESH_TOKEN),
        { message: 'the editor must hold the text that arrived before onMount', timeout: 10000 },
      )
      .toEqual({ lineCount: MOUNT_REFRESH_MODIFIED_LINES, hasToken: true });
    // Its own diff lands too. The first change is the refreshed text's, not funnel.ts's.
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(MOUNT_REFRESH_CHANGE_LINE);
    await waitForDiffToSettle(page);

    expect(await liveDiffEditorCount()).toBe(1);
    expect(getPageErrors()).toEqual([]);
  });
});
