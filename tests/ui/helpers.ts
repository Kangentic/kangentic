import { chromium, expect, type Browser, type Locator, type Page } from '@playwright/test';
import path from 'node:path';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Single source of truth for known-benign renderer errors, shared with the
// renderer's runtime suppressor (the monaco error-funnel wrapper in
// src/renderer/monacoConfig.ts, which reassigns errorHandler.unexpectedErrorHandler).
// monacoConfig.ts swallows these before they reach the page, so collectPageErrors
// rarely sees them, but the filter stays as a belt-and-suspenders for any path
// that reaches window despite the funnel wrapper.
import { BENIGN_RENDERER_ERRORS, isBenignRendererError } from '../../src/shared/benign-renderer-errors';
export { BENIGN_RENDERER_ERRORS, isBenignRendererError };

/**
 * Attach a `pageerror` collector that drops messages matching
 * BENIGN_RENDERER_ERRORS. Returns a getter yielding the remaining, unexpected
 * error messages so a spec can assert a clean console without tripping on
 * quirks the app cannot control. Attach before the interaction under test so
 * the error window is fully covered.
 */
export function collectPageErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    if (isBenignRendererError(error)) return;
    errors.push(error.message);
  });
  return () => errors.slice();
}

/**
 * Poll the Vite dev server until it responds with HTTP 200.
 * Prevents thundering-herd timeouts when multiple workers launch simultaneously
 * before Vite finishes its initial compilation.
 */
export async function waitForViteReady(url: string = VITE_URL, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server not ready */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Vite dev server at ${url} not ready after ${timeoutMs}ms`);
}

/**
 * Chromium flags for a spec that asserts on terminal CONTENT as text. Under
 * WebGL, xterm draws rows to a canvas and `.xterm` innerText is empty; with
 * WebGL disabled xterm falls back to its DOM renderer and the rows are real
 * text nodes. Pass as `chromium.launch({ args: TERMINAL_TEXT_LAUNCH_ARGS })`.
 * Costs a "WebGL unavailable" console warning per terminal, nothing else.
 */
export const TERMINAL_TEXT_LAUNCH_ARGS = ['--disable-webgl', '--disable-webgl2'];

/**
 * Put a mounted xterm into bracketed-paste mode the way an agent TUI does, and
 * return once it is provably there. The mock never sends `\x1b[?2004h` and its
 * scrollback is empty, so every UI-tier terminal starts with the mode OFF; a
 * spec asserting a `\x1b[200~ ... \x1b[201~` packet must enable it first.
 *
 * Fires the DECSET as live PTY bytes with a sentinel in the same chunk and
 * waits for the sentinel to render (xterm parses in order, so a visible
 * sentinel means the mode landed, with no fixed wait). Fired INSIDE the poll: a
 * chunk that lands while the mount replay is still in flight is held and then
 * superseded by the replay's frame, so it is simply re-fired until one lands
 * live; the DECSET is idempotent. Needs `TERMINAL_TEXT_LAUNCH_ARGS`, since the
 * sentinel is read from `.xterm` innerText. `scope` is the container the
 * terminal lives in (a task-detail dialog, the command-terminal window).
 */
export async function enableBracketedPaste(page: Page, scope: Locator, sessionId: string): Promise<void> {
  const sentinel = 'MODE2004READY';
  await expect
    .poll(async () => {
      await page.evaluate(
        ({ targetSessionId, text }) => {
          (window as unknown as { __mockFireSessionData: (id: string, data: string) => void })
            .__mockFireSessionData(targetSessionId, `\x1b[?2004h${text}\r\n`);
        },
        { targetSessionId: sessionId, text: sentinel },
      );
      return scope.locator('.xterm').first().innerText();
    }, { timeout: 10000, intervals: [250] })
    .toContain(sentinel);
}

/**
 * Press one of the Changes panel's resize handles (`data-testid` selector) and
 * return its box once the drag is genuinely in flight, meaning the handle
 * publishes `data-resizing="true"`. Dispatch the moves only after this
 * resolves, so they cannot land before the handler installs its document
 * listeners.
 *
 * `hover()` waits for the handle's box to stop moving (expanding History runs a
 * height transition, which was the first CI flake on this shape). The press
 * itself then still lost once on UI shard 4: the hover had verifiably hit the
 * handle, the box never moved again, and `data-resizing` stayed `false` for
 * the full 5 s, which is the shape of an input event starved under
 * parallel-worker load rather than a moving target. A press that has not armed
 * within a short window is therefore released and re-issued from a freshly
 * read box, bounded, the same treatment `dragTaskToColumn` gives a missed
 * dnd-kit activation. The hard cap keeps a handle that never arms a failure
 * rather than a hang.
 */
export async function pressResizeHandle(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const handle = page.locator(selector);
  const armed = page.locator(`${selector}[data-resizing="true"]`);
  const PRESS_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= PRESS_ATTEMPTS; attempt += 1) {
    await handle.hover();
    const box = await handle.boundingBox();
    if (!box) throw new Error(`${selector} has no bounding box`);
    await page.mouse.down();
    const inFlight = await armed.waitFor({ state: 'attached', timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    if (inFlight) return box;
    await page.mouse.up();
  }
  throw new Error(`${selector} did not enter its drag after ${PRESS_ATTEMPTS} presses`);
}

/**
 * Expand the task-detail Changes panel's History section and return only once
 * it is provably open: the section's resize handle
 * (`changes-history-resize`) renders ONLY while the section is open, so its
 * presence is the signal, and a click that has not produced it within a short
 * window is re-issued from a fresh `aria-expanded` read, bounded.
 *
 * Do not read the open state off `commit-graph-panel` being visible. The graph
 * stays mounted while collapsed, clipped inside a `height: 0; overflow: hidden`
 * body, and Playwright's visibility check reads the element's OWN box (which is
 * not empty) rather than its ancestors' clipping, so that wait passes on a
 * collapsed section too. That is how the History resize test in
 * commit-graph-panel.spec.ts lost its expand click on UI shard 4 (the same
 * starved-input shape `pressResizeHandle` re-presses for), sailed past the
 * panel wait, and then spent the rest of its budget hovering a handle that was
 * never going to render. The hard cap keeps a section that never opens a
 * failure rather than a hang.
 */
export async function expandHistorySection(page: Page): Promise<void> {
  const historyToggle = page.locator('[data-testid="changes-history-toggle"]');
  const resizeHandle = page.locator('[data-testid="changes-history-resize"]');
  await historyToggle.waitFor({ state: 'visible', timeout: 10000 });
  const EXPAND_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= EXPAND_ATTEMPTS; attempt += 1) {
    if ((await historyToggle.getAttribute('aria-expanded')) !== 'true') {
      await historyToggle.click();
    }
    const opened = await resizeHandle.waitFor({ state: 'attached', timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }
  throw new Error(`changes-history-toggle did not expand the History section after ${EXPAND_ATTEMPTS} clicks`);
}

/**
 * Click a control right after a dnd-kit drop, retrying past a swallowed click.
 *
 * `@dnd-kit/core`'s `AbstractPointerSensor` arms a document-level, capture-phase
 * `click` -> `stopPropagation` listener on drag start and removes it in
 * `detach()` with `setTimeout(this.documentListeners.removeAll, 50)`. That timer
 * is a browser main-thread task, so under parallel workers it lands late and the
 * first click ANYWHERE on the page after a drop goes nowhere.
 *
 * The symptom is maximally misleading. The button is enabled, `pointer-events`
 * is `auto`, `elementFromPoint` returns the button itself, and there is no
 * toast, console error, or React error. It stays that way for as long as you
 * wait, so raising a timeout cannot help: the listener is removed on a timer the
 * test cannot observe or wait for. Only a second click does.
 *
 * `settles` is the caller's proof the click took effect, usually the dialog
 * going `hidden` or `detached`. The helper returns on the first settle, so a
 * click that lands the first time costs nothing beyond the wait the caller
 * needed anyway.
 *
 * The budget is sized against the `ui` project's 15s per-test timeout, not
 * against the race. Three attempts is already far past what the mechanism
 * needs. The first retry waits a full settle, 30 times the 50 ms removal timer;
 * if that timer has not fired by then, the main thread was blocked for the
 * whole window, and a fourth click does not fix that either. What the budget
 * has to leave room for is the caller, which runs a drag before this and an
 * assertion after. An exhausted budget CONSUMES the enclosing test's timeout,
 * so a caller that adds waits of its own must size them against what is left.
 *
 * Exhausting the attempts on a click that kept landing returns normally rather
 * than throwing. The caller keeps its own assertion, and a genuinely broken
 * handler should fail on that named assertion rather than on a retry. A click
 * that never landed is a different case. A strict-mode violation, a selector
 * that never resolves, and a click an overlay is blocking are all test bugs, so
 * the last attempt rethrows that error to name itself here. The settle check
 * runs before that rethrow, so a target that detached because an EARLIER click
 * did take effect still returns cleanly instead of failing on the teardown it
 * caused.
 *
 * Verified in `node_modules/@dnd-kit/core/dist/core.cjs.development.js`
 * (`handleStart` adds the listener, `detach` removes it on the 50 ms timer).
 */
const DRAG_SWALLOW_ATTEMPTS = 3;
const DRAG_SWALLOW_CLICK_TIMEOUT_MS = 1500;
const DRAG_SWALLOW_SETTLE_TIMEOUT_MS = 1500;

export async function clickPastDragSwallow(
  target: Locator,
  settles: Locator,
  state: 'hidden' | 'detached' | 'visible' | 'attached' = 'hidden',
): Promise<void> {
  for (let attempt = 0; attempt < DRAG_SWALLOW_ATTEMPTS; attempt += 1) {
    const isLastAttempt = attempt === DRAG_SWALLOW_ATTEMPTS - 1;
    let clickError: unknown;
    try {
      await target.click({ timeout: DRAG_SWALLOW_CLICK_TIMEOUT_MS });
    } catch (error) {
      clickError = error;
    }
    const settled = await settles
      .waitFor({ state, timeout: DRAG_SWALLOW_SETTLE_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (settled) return;
    if (isLastAttempt && clickError) throw clickError;
  }
}

/**
 * Wait until a dnd-kit keyboard drag that has just started can take its next key.
 *
 * dnd-kit registers the keyboard sensor's own `keydown` listener on a 0ms timer
 * after pickup (`KeyboardSensor.attach`), so the activating key cannot end the
 * drag it started. Blink runs an input task ahead of a due timer task, so a key
 * pressed within a frame of the lifted item appearing can arrive before that
 * listener exists and do nothing (seen as "the second Space did not drop, the
 * third did"). A person cannot press two keys inside one frame; an automation
 * can. A timer queued here lands BEHIND dnd-kit's in the same queue, so once it
 * fires the listener is attached. This is a deterministic wait, not a fixed one.
 *
 * Call it after asserting the pickup happened (the overlay is visible, or the
 * handle reads `aria-pressed="true"`) and before the next `keyboard.press`.
 */
export async function settleDndKitKeyboardSensor(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/**
 * Launch a headless Chromium page with the electronAPI mock injected.
 * The Vite dev server must be running (started by playwright webServer config).
 */
export async function launchPage(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  // Inject the mock before any page scripts run
  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  // Wait for React to render the app shell
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

// Wait for the board to load (swimlanes visible)
export async function waitForBoard(page: Page): Promise<void> {
  await page
    .locator('[data-swimlane-name="To Do"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  await page
    .locator('[data-swimlane-name="Planning"]')
    .waitFor({ state: 'visible', timeout: 5000 });
}

// Create a project via the UI (folder picker flow).
// The project name is derived from the folder path's basename,
// so we construct a mock path whose last segment matches the desired name.
export async function createProject(
  page: Page,
  name: string,
  _projectPath?: string,
): Promise<void> {
  // Set the mock folder selection so basename = project name
  await page.evaluate((n: string) => {
    (window as any).__mockFolderPath = '/mock/projects/' + n;
  }, name);

  // When no projects exist the sidebar is hidden and the welcome screen
  // provides the "Open a Project" button. Otherwise use the sidebar button.
  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');

  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }

  // There is no confirmation dialog: picking a folder creates the project and lands on
  // the board directly (git is set up silently, the name is the folder basename, and the
  // default agent is the walkthrough's first step). The onboarding checklist is the only
  // thing between here and the board.
  await dismissOnboardingChecklist(page);
  await waitForBoard(page);
}

/**
 * Dismiss the onboarding checklist if it is open.
 *
 * The FIRST project on a fresh install auto-opens it, and it is a focus-trapping modal over
 * the board whose backdrop intercepts pointer events - so any spec that creates that project
 * and then touches the board must get past it first. "Skip for now" persists the dismissal,
 * so it cannot reappear later in the same test.
 *
 * Onboarding is install-scoped: the checklist auto-opens only while `onboardedProjectIds` is
 * empty, so second-and-later projects never raise it.
 *
 * That "not coming" path is NEW, created by the same change that made the gate install-scoped.
 * Before it, a second project had an id nobody had dismissed, so the checklist did open and
 * this wait resolved fast. So the store check below is not recovered pre-existing waste - it
 * keeps that gate change from regressing UI-suite time, by stopping every extra project in a
 * multi-project spec (`project-groups`, `project-sidebar-search`, whose `beforeEach` creates
 * two or three projects per test) from newly burning the full timeout.
 *
 * Asking the store beats shortening a timeout that has to stay generous on CI.
 *
 * Call this after ANY project-creation flow, not just `createProject`: several specs drive
 * the folder picker and Add project dialog inline.
 */
export async function dismissOnboardingChecklist(page: Page): Promise<void> {
  const checklist = page.locator('[data-testid="onboarding-checklist"]');
  if (!(await checklist.isVisible().catch(() => false))) {
    // `undefined` means App.tsx's backfill has not landed yet, so the checklist may still be
    // on its way - wait in that case too. Any read failure falls back to waiting.
    const mayStillOpen = await page
      .evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            config: { getState: () => { config: { onboardedProjectIds?: string[] } } };
          };
        }).__zustandStores;
        const onboardedProjectIds = stores?.config.getState().config.onboardedProjectIds;
        return !Array.isArray(onboardedProjectIds) || onboardedProjectIds.length === 0;
      })
      .catch(() => true);
    if (!mayStillOpen) return;
    await checklist.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
  }
  if (await checklist.isVisible().catch(() => false)) {
    await page.locator('[data-testid="onboarding-skip"]').click();
    await checklist.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}

// Create a task via the UI in the To Do column (the only column with an "Add task" button).
// To place a task in a different column, create it in To Do first, then drag it.
export async function createTask(
  page: Page,
  title: string,
  description: string = '',
): Promise<void> {
  const backlog = page.locator('[data-swimlane-name="To Do"]');
  const addButton = backlog.locator('text=Add task');
  await addButton.click();

  // Scope to the New Task BaseDialog (fixed inset-0 backdrop) to avoid ambiguity
  // with the task-detail window, which renders its own Task title input inside the
  // WindowLayer overlay (fixed top-10 bottom-9 - does NOT have class inset-0).
  const newTaskDialog = page.locator('.fixed.inset-0');
  const titleInput = newTaskDialog.locator('input[placeholder="Task title"]');
  await titleInput.fill(title);

  if (description) {
    const descInput = newTaskDialog.locator('textarea').first();
    await descInput.fill(description);
  }

  // Use type="submit" to distinguish the New Task dialog's Create button from the
  // dev-only TestHarness buttons ("Create Task" / "Create Project", type="button").
  const createButton = newTaskDialog.locator('button[type="submit"]:has-text("Create")');
  await createButton.click();
  // Wait for the new task dialog to unmount (the modal backdrop disappears).
  await newTaskDialog.waitFor({ state: 'hidden', timeout: 3000 });
}
