/**
 * UI coverage for Sentry DESKTOP-22 ("Illegal value for lineNumber" as an
 * unhandled rejection). monaco-error-funnel.spec.ts covers DESKTOP-19 on the
 * same content swap.
 *
 * monaco 0.57's diff view model computes its diff in an async autorun. It
 * awaits the worker, checks its own cancellation token, and then normalizes
 * the reply against the models' CURRENT text (diffEditorViewModel.js 209-221).
 * A reply for longer text that lands after DiffViewer's swap has put shorter
 * text into the shared models asks getLineMaxColumn for a line that no longer
 * exists. Only a cancelled token stops it, and monaco never cancels the token
 * of a view model that `setModel({ original, modified })` built. The widget
 * keeps one reference to it that it never releases (RefCounted in
 * diffEditor/utils.js), so every such view model stays alive on the shared
 * models and recomputes after every later swap. DiffViewer owns the view model
 * instead, and disposes the outgoing one before it flushes the new text.
 *
 * The race needs a worker reply to land after a swap, which no real timing
 * pins down, so an init script gates the editor worker. While it holds, a
 * reply to a `$computeDiff` request is queued until release. It holds only
 * those replies. The worker client awaits a `$ping` round trip before it posts
 * each request (editorWorkerService.js `_getProxy`), so holding the ping would
 * hold the request too. The worker would then compute it on the new text, and
 * the broken build would pass.
 *
 * The view models are recorded by wrapping the new diff editor's
 * createViewModel the moment monaco creates it, before @monaco-editor/react
 * attaches its own, so the library's view model is recorded as well. Reading
 * whether one is cancelled, and which one is attached, needs monaco
 * internals, which only this test reads.
 *
 * Closing the task window is the other end of that ownership. monaco does not
 * dispose the view model it still holds when the editor goes either, so
 * DiffViewer disposes the one it owns when the modified editor disposes
 * (handleEditorMount). The close cases read a view model's token after the
 * editor is gone, once with a swap behind it and once without.
 *
 * All four cases read red with DiffViewer's view model ownership removed. The
 * two close cases also read red with only that onDidDispose listener removed.
 */
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import {
  waitForViteReady,
  collectPageErrors,
  gotoVite,
  readModifiedFirstChangeLine,
  waitForDiffToSettle,
} from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-diff-swap-view-model';
const TASK_ID = 'task-diff-swap-view-model';
const SESSION_ID = 'sess-diff-swap-view-model';
const TASK_TITLE = 'Diff Swap View Model Task';

// Each file's first change sits on a line no other file uses, so
// readModifiedFirstChangeLine names whose diff has landed.
const START_FILE = 'start.txt';
const START_LINES = 30;
const START_CHANGE_LINE = 5;
const LONG_FILE = 'long.txt';
const LONG_LINES = 400;
const LONG_CHANGE_LINE = 300;
const SHORT_FILE = 'short.txt';
const SHORT_LINES = 10;
const SHORT_CHANGE_LINE = 3;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Diff Swap Test', path: '/mock/diff-swap',
      github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999,
      status: 'running', shell: 'bash', cwd: '/mock/diff-swap', startedAt: timestamp, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: '${TASK_TITLE}', description: 'Task for the diff swap view model test',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/diff-swap', branch_name: 'feature/diff-swap',
      pr_number: null, pr_url: null, base_branch: 'main', archived_at: null, created_at: timestamp, updated_at: timestamp,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

// long.txt's change is the shape the throw needs. normalizeRangeMapping reads
// the model only for an inner change that starts at column 1 on both sides
// (diffEditorViewModel.js 301-304). Rewriting a whole line with characters the
// old line does not have makes the inner change run from column 1 to the
// line's end. The panel selects the first listed file, so the order of each
// list picks the file the viewer mounts on.
const fixture = `
  (function () {
    function numberedLines(label, count) {
      var result = [];
      for (var lineNumber = 1; lineNumber <= count; lineNumber++) result.push('shared ' + label + ' line ' + lineNumber);
      return result;
    }
    var startOriginal = numberedLines('start', ${START_LINES});
    var startModified = startOriginal.slice();
    startModified[${START_CHANGE_LINE} - 1] = 'start line changed';
    var longOriginal = numberedLines('long', ${LONG_LINES});
    longOriginal[${LONG_CHANGE_LINE} - 1] = 'xxxxxxxxxxxxxxxxxxxxxxxx';
    var longModified = longOriginal.slice();
    longModified[${LONG_CHANGE_LINE} - 1] = 'yyyyyyyyyyyyyyyyyyyyyyyy';
    var shortOriginal = numberedLines('short', ${SHORT_LINES});
    var shortModified = shortOriginal.slice();
    shortModified[${SHORT_CHANGE_LINE} - 1] = 'short line changed';
    var startEntry = {
      path: '${START_FILE}', status: 'M', insertions: 1, deletions: 1,
      original: startOriginal.join('\\n'), modified: startModified.join('\\n'), language: 'plaintext',
    };
    var longEntry = {
      path: '${LONG_FILE}', status: 'M', insertions: 1, deletions: 1,
      original: longOriginal.join('\\n'), modified: longModified.join('\\n'), language: 'plaintext',
    };
    var shortEntry = {
      path: '${SHORT_FILE}', status: 'M', insertions: 1, deletions: 1,
      original: shortOriginal.join('\\n'), modified: shortModified.join('\\n'), language: 'plaintext',
    };
    window.__mountOnStartFixture = { files: [startEntry, longEntry, shortEntry] };
    window.__mountOnLongFixture = { files: [longEntry, shortEntry] };
    window.__mockGitDiff = window.__mountOnStartFixture;
  })();
`;

// Wraps every Worker the page creates. monaco listens through `onmessage`
// (webWorkerServiceImpl.js) and speaks a request/reply protocol: a request is
// { type: 0, req, method }, its reply { type: 1, seq } (base/common/worker/webWorker.js).
// Also records every unhandled rejection's message, which is how DESKTOP-22
// arrived (mechanism onunhandledrejection).
const workerGate = `
  (function () {
    var NativeWorker = window.Worker;
    var computeDiffRequestIds = new Set();
    var heldDeliveries = [];
    var gate = {
      holding: false,
      computeDiffPosts: 0,
      postsWhenHoldStarted: 0,
      heldReplyCount: function () { return heldDeliveries.length; },
      hold: function () {
        gate.holding = true;
        gate.postsWhenHoldStarted = gate.computeDiffPosts;
      },
      release: function () {
        gate.holding = false;
        heldDeliveries.splice(0).forEach(function (deliver) { deliver(); });
      },
    };
    window.__diffWorkerGate = gate;
    class GatedWorker extends NativeWorker {
      postMessage(message, transfer) {
        if (message && message.type === 0 && message.method === '$computeDiff') {
          computeDiffRequestIds.add(String(message.req));
          gate.computeDiffPosts += 1;
        }
        if (transfer === undefined) return super.postMessage(message);
        return super.postMessage(message, transfer);
      }
      get onmessage() {
        return super.onmessage;
      }
      set onmessage(handler) {
        if (typeof handler !== 'function') {
          super.onmessage = handler;
          return;
        }
        var worker = this;
        super.onmessage = function (event) {
          var data = event.data;
          var isComputeDiffReply = !!data && data.type === 1 && computeDiffRequestIds.has(String(data.seq));
          if (gate.holding && isComputeDiffReply) {
            heldDeliveries.push(function () { handler.call(worker, event); });
            return;
          }
          handler.call(worker, event);
        };
      }
    }
    window.Worker = GatedWorker;

    window.__unhandledRejectionMessages = [];
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      window.__unhandledRejectionMessages.push(reason && reason.message ? String(reason.message) : String(reason));
    });
  })();
`;

interface WorkerGateHandle {
  holding: boolean;
  computeDiffPosts: number;
  postsWhenHoldStarted: number;
  heldReplyCount: () => number;
  hold: () => void;
  release: () => void;
}

/** What the test reads of a monaco DiffEditorViewModel. The token source is private. */
interface ViewModelHandle {
  _cancellationTokenSource: { token: { isCancellationRequested: boolean } };
}

interface DiffEditorHandle {
  getModifiedEditor: () => { getModel: () => { getLineCount: () => number } | null };
  createViewModel: (model: unknown) => ViewModelHandle;
  /** The widget's private observable of the attached view model. */
  _diffModel: { get: () => ViewModelHandle | undefined };
}

interface MonacoTestHandle {
  editor: {
    getDiffEditors: () => DiffEditorHandle[];
    onDidCreateDiffEditor: (listener: (diffEditor: DiffEditorHandle) => void) => { dispose: () => void };
  };
}

interface ViewModelRecord {
  editor: DiffEditorHandle;
  viewModels: ViewModelHandle[];
}

interface TestWindow {
  __monaco: MonacoTestHandle;
  __diffWorkerGate: WorkerGateHandle;
  __unhandledRejectionMessages: string[];
  __viewModelRecord?: ViewModelRecord;
  __mockGitDiff: unknown;
  __mountOnLongFixture: unknown;
}

let browser: Browser;
let context: BrowserContext;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  await browser?.close();
});

test.beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.addInitScript(fixture);
  await page.addInitScript(workerGate);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
});

test.afterEach(async () => {
  await context?.close();
});

test.describe.configure({ timeout: 45_000 });

/** Open the task window and make sure the Changes panel is showing. */
async function openChangesPanel(): Promise<void> {
  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  const diffArea = page.locator('[data-testid="diff-editor-area"]');
  try {
    await diffArea.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    await page.locator('[data-testid="changes-toggle"]').click();
    await diffArea.waitFor({ state: 'visible', timeout: 10000 });
  }
}

async function liveDiffEditorCount(): Promise<number> {
  return page.evaluate(() => {
    const monaco = (window as unknown as Partial<TestWindow>).__monaco;
    return monaco?.editor.getDiffEditors().length ?? 0;
  });
}

async function readModifiedLineCount(): Promise<number> {
  return page.evaluate(() => {
    const diffEditor = (window as unknown as TestWindow).__monaco.editor.getDiffEditors()[0];
    return diffEditor?.getModifiedEditor().getModel()?.getLineCount() ?? -1;
  });
}

/** Close the task window and wait until its diff editor is disposed. */
async function closeTaskWindow(): Promise<void> {
  // Control+Shift+W rather than Escape, because Monaco may hold focus.
  await page.keyboard.press('Control+Shift+W');
  await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
  await expect.poll(liveDiffEditorCount, { timeout: 8000 }).toBe(0);
}

/**
 * Open the panel once so monaco loads and the editor worker starts, then close
 * the task window and reopen it with every view model of the next diff editor
 * recorded. window.__monaco only exists once the Changes panel's chunk has
 * loaded, which is why the first open is needed. With `holdFromCreation`, the
 * gate starts holding the moment monaco creates that editor, before the
 * library's view model asks for its first diff.
 */
async function reopenRecordingViewModels(holdFromCreation: boolean): Promise<void> {
  await openChangesPanel();
  await page.locator('.view-line').first().waitFor({ state: 'visible', timeout: 10000 });
  await waitForDiffToSettle(page);
  await closeTaskWindow();

  await page.evaluate((hold) => {
    const pageWindow = window as unknown as TestWindow;
    const subscription = pageWindow.__monaco.editor.onDidCreateDiffEditor((diffEditor) => {
      subscription.dispose();
      const record: ViewModelRecord = { editor: diffEditor, viewModels: [] };
      pageWindow.__viewModelRecord = record;
      const createViewModel = diffEditor.createViewModel.bind(diffEditor);
      diffEditor.createViewModel = (model: unknown) => {
        const viewModel = createViewModel(model);
        record.viewModels.push(viewModel);
        return viewModel;
      };
      if (hold) pageWindow.__diffWorkerGate.hold();
    });
  }, holdFromCreation);
  await openChangesPanel();
}

/** Wait until a `$computeDiff` was posted since the hold started and its reply is held. */
async function waitForHeldComputeDiff(): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const gate = (window as unknown as TestWindow).__diffWorkerGate;
          return gate.computeDiffPosts > gate.postsWhenHoldStarted && gate.heldReplyCount() > 0;
        }),
      { message: 'a diff request must be posted and its reply held before the next swap', timeout: 10000 },
    )
    .toBe(true);
}

async function releaseHeldReplies(): Promise<void> {
  await page.evaluate(() => (window as unknown as TestWindow).__diffWorkerGate.release());
}

interface RecordedViewModels {
  recorded: number;
  attachedIsLastRecorded: boolean;
  /** Indexes of view models that are no longer attached but whose token is still live. */
  liveDetachedIndexes: number[];
}

async function readRecordedViewModels(): Promise<RecordedViewModels> {
  return page.evaluate(() => {
    const record = (window as unknown as TestWindow).__viewModelRecord;
    if (!record) throw new Error('no diff editor was created after the recorder was installed');
    const attached = record.editor._diffModel.get();
    const liveDetachedIndexes: number[] = [];
    record.viewModels.forEach((viewModel, index) => {
      if (viewModel === attached) return;
      if (!viewModel._cancellationTokenSource.token.isCancellationRequested) liveDetachedIndexes.push(index);
    });
    return {
      recorded: record.viewModels.length,
      attachedIsLastRecorded: attached === record.viewModels[record.viewModels.length - 1],
      liveDetachedIndexes,
    };
  });
}

interface RecordedViewModelsAfterClose {
  recorded: number;
  /** Indexes of view models whose token is still live. */
  liveIndexes: number[];
}

/**
 * The reader to use once the editor is disposed. It reads no widget state,
 * because `_diffModel` means nothing after dispose, and it counts the attached
 * view model too: every recorded one must be cancelled by then.
 */
async function readRecordedViewModelsAfterClose(): Promise<RecordedViewModelsAfterClose> {
  return page.evaluate(() => {
    const record = (window as unknown as TestWindow).__viewModelRecord;
    if (!record) throw new Error('no diff editor was created after the recorder was installed');
    const liveIndexes: number[] = [];
    record.viewModels.forEach((viewModel, index) => {
      if (!viewModel._cancellationTokenSource.token.isCancellationRequested) liveIndexes.push(index);
    });
    return { recorded: record.viewModels.length, liveIndexes };
  });
}

async function readUnhandledRejectionMessages(): Promise<string[]> {
  return page.evaluate(() => (window as unknown as TestWindow).__unhandledRejectionMessages.slice());
}

test.describe('Diff view model across a content swap (Sentry DESKTOP-22)', () => {
  // A file switch while the incoming file's own diff is still in the worker,
  // to a file shorter than the line that diff changes. The outgoing view model
  // must be cancelled at the swap, so its reply is dropped when it lands.
  test('a diff still computing when a shorter file swaps in throws nothing, and the outgoing view model is cancelled', async () => {
    const getPageErrors = collectPageErrors(page);
    await reopenRecordingViewModels(false);
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(START_CHANGE_LINE);
    await waitForDiffToSettle(page);

    await page.evaluate(() => (window as unknown as TestWindow).__diffWorkerGate.hold());
    await page.locator('button', { hasText: LONG_FILE }).first().click();
    await expect.poll(readModifiedLineCount, { timeout: 10000 }).toBe(LONG_LINES);
    await waitForHeldComputeDiff();

    await page.locator('button', { hasText: SHORT_FILE }).first().click();
    await expect.poll(readModifiedLineCount, { timeout: 10000 }).toBe(SHORT_LINES);
    await releaseHeldReplies();
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(SHORT_CHANGE_LINE);
    await waitForDiffToSettle(page);

    expect.soft(await readUnhandledRejectionMessages()).toEqual([]);
    expect.soft(getPageErrors()).toEqual([]);
    const viewModels = await readRecordedViewModels();
    // The library's at mount, then one per swap.
    expect(viewModels.recorded).toBeGreaterThanOrEqual(3);
    expect(viewModels.attachedIsLastRecorded).toBe(true);
    expect(viewModels.liveDetachedIndexes, 'every detached view model must be cancelled').toEqual([]);
  });

  // The view model @monaco-editor/react attaches before onMount is not one
  // DiffViewer created, and monaco offers no public way to reach it. It must
  // still be cancelled at the first swap, or it races that swap and every
  // later one. Index 0 of the record is that view model.
  test("the library's mount-time view model is cancelled at the first swap, so its late diff throws nothing", async () => {
    const getPageErrors = collectPageErrors(page);
    await page.evaluate(() => {
      const pageWindow = window as unknown as TestWindow;
      pageWindow.__mockGitDiff = pageWindow.__mountOnLongFixture;
    });
    await reopenRecordingViewModels(true);
    await expect.poll(readModifiedLineCount, { timeout: 10000 }).toBe(LONG_LINES);
    await waitForHeldComputeDiff();

    await page.locator('button', { hasText: SHORT_FILE }).first().click();
    await expect.poll(readModifiedLineCount, { timeout: 10000 }).toBe(SHORT_LINES);
    await releaseHeldReplies();
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(SHORT_CHANGE_LINE);
    await waitForDiffToSettle(page);

    expect.soft(await readUnhandledRejectionMessages()).toEqual([]);
    expect.soft(getPageErrors()).toEqual([]);
    const viewModels = await readRecordedViewModels();
    expect(viewModels.recorded).toBeGreaterThanOrEqual(2);
    expect(viewModels.attachedIsLastRecorded).toBe(true);
    expect(viewModels.liveDetachedIndexes, 'index 0 is the view model the library attached at mount').toEqual([]);
  });
});

test.describe('Diff view model when the task window closes', () => {
  // After a swap, the view model attached at close is one DiffViewer created
  // with createViewModel. monaco holds a reference to it that never reaches
  // zero, so only DiffViewer's disposal on editor teardown cancels it.
  test('a close after a file swap cancels every view model, including the one the swap attached', async () => {
    await reopenRecordingViewModels(false);
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(START_CHANGE_LINE);
    await waitForDiffToSettle(page);

    await page.locator('button', { hasText: SHORT_FILE }).first().click();
    await expect.poll(readModifiedLineCount, { timeout: 10000 }).toBe(SHORT_LINES);
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(SHORT_CHANGE_LINE);
    await waitForDiffToSettle(page);

    // The view model attached now is the last one recorded, so the close
    // below has to cancel one DiffViewer created.
    const beforeClose = await readRecordedViewModels();
    expect(beforeClose.recorded).toBeGreaterThanOrEqual(2);
    expect(beforeClose.attachedIsLastRecorded).toBe(true);

    await closeTaskWindow();
    const afterClose = await readRecordedViewModelsAfterClose();
    expect(afterClose.liveIndexes, 'every view model must be cancelled once the editor is gone').toEqual([]);
  });

  // With no swap, the view model attached at close is the one
  // @monaco-editor/react built at mount, which DiffViewer adopted. Index 0 of
  // the record is that view model.
  test("a close with no file swap cancels the library's mount-time view model", async () => {
    await reopenRecordingViewModels(false);
    await expect.poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 }).toBe(START_CHANGE_LINE);
    await waitForDiffToSettle(page);

    await closeTaskWindow();
    const afterClose = await readRecordedViewModelsAfterClose();
    expect(afterClose.recorded, 'no swap ran, so the library view model is the only one recorded').toBe(1);
    expect(afterClose.liveIndexes, 'index 0 is the view model the library attached at mount').toEqual([]);
  });
});
