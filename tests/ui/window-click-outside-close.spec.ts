/**
 * UI tests for the click-outside (light-dismiss) feature for modeless
 * task-detail windows.
 *
 * The feature (`useClickOutsideToClose`, mounted once per LAYER) listens for a
 * "clean click" on dead (non-action) space anywhere in the app shell - a
 * pointerdown + pointerup pair, < 4px travel, with no dismissable-layer open at
 * pointerdown - and then closes windows per the `windowLightDismiss` policy.
 * Closing routes through each window's unsaved-edits guard (`closeWithGuard`)
 * without touching the underlying PTY/session.
 *
 * Detection is a DENYLIST: the whole marked shell subtree dismisses, and the
 * target must not be a task card, a window/popover, a real control, a live
 * terminal (`.xterm`), a `[data-no-dismiss]` element (a column header, a drag
 * handle), or anything showing a pointer cursor. `data-dismiss-layer` marks which
 * LAYER owns a subtree, so a click resolves to the right window store; it does not
 * decide whether a click dismisses. Anything with no scope root above it is inert,
 * which is what keeps overlays (the settings panel, palettes, dialogs) and
 * `document.body` portals from closing a window beneath them.
 *
 * Policy values:
 *  - `off`      never dismisses
 *  - `single`   dismisses the sole window in any state, and nothing at all once a
 *               second window is open
 *  - `focused`  dismisses the focused window regardless of how many are open (default)
 *  - `all`      dismisses every open window
 *
 * Because the default is `focused`, a test that depends on `single`'s
 * count-dependence must set the policy explicitly rather than inherit it.
 *
 * These tests prove the count-based and detection-based behaviour of the hook.
 * The pure policy resolver (`resolveLightDismissTargets`) is already exhaustively
 * unit-tested in `tests/unit/light-dismiss-resolve-targets.test.ts`; we do not
 * re-test state permutations here.
 *
 * Setup mirrors `tests/ui/window-auto-close-on-done.spec.ts`: each describe
 * block owns its browser/page (no shared state across blocks), and each test
 * opens windows from a known initial state.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// ---------------------------------------------------------------------------
// Shared project / task / session ids (unique per spec run to prevent
// collisions when multiple UI workers share the Vite server).
// ---------------------------------------------------------------------------
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);

const PROJECT_ID = `proj-light-dismiss-${RUN_SUFFIX}`;

// Task A: has a running session -> opens in VIEW mode (non-edit).
const TASK_A_ID = `task-ld-a-${RUN_SUFFIX}`;
const SESSION_A_ID = `sess-ld-a-${RUN_SUFFIX}`;

// Task B: second running task -> second window.
const TASK_B_ID = `task-ld-b-${RUN_SUFFIX}`;
const SESSION_B_ID = `sess-ld-b-${RUN_SUFFIX}`;

// Task C: To Do with NO session -> opens in EDIT mode (title input visible).
const TASK_C_ID = `task-ld-c-${RUN_SUFFIX}`;

/** Build the addInitScript that seeds the mock with project + lanes + tasks. */
function buildPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Light Dismiss Test',
        path: '/mock/light-dismiss-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-ld-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id, position: i, created_at: ts,
        }));
      });

      // Expose lane ids so tests can look up 'To Do', 'Executing', etc.
      window.__ldLaneIds = laneIds;

      // Task A - in Executing, has a running session -> VIEW mode window.
      state.sessions.push({
        id: '${SESSION_A_ID}',
        taskId: '${TASK_A_ID}',
        projectId: '${PROJECT_ID}',
        pid: 1001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/light-dismiss-test',
        startedAt: ts,
        exitCode: null,
      });
      state.tasks.push({
        id: '${TASK_A_ID}',
        display_id: 1,
        title: 'Task Alpha',
        description: 'First task for light-dismiss tests',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_A_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Task B - in Code Review, has a running session -> VIEW mode window.
      state.sessions.push({
        id: '${SESSION_B_ID}',
        taskId: '${TASK_B_ID}',
        projectId: '${PROJECT_ID}',
        pid: 1002,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/light-dismiss-test',
        startedAt: ts,
        exitCode: null,
      });
      state.tasks.push({
        id: '${TASK_B_ID}',
        display_id: 2,
        title: 'Task Beta',
        description: 'Second task for light-dismiss tests',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_B_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Task C - in To Do, NO session -> clicking card opens in EDIT mode.
      state.tasks.push({
        id: '${TASK_C_ID}',
        display_id: 3,
        title: 'Task Gamma',
        description: 'Third task - To Do, no session, opens in edit mode',
        swimlane_id: laneIds['To Do'],
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/** Launch a fresh headless page with the mock and pre-config seeded. */
async function launchWithState(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(buildPreConfig());
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Open the task-detail window for a task by clicking its card.
 *  Waits for the dialog to mount before returning. */
async function openWindow(page: Page, taskTitle: string): Promise<void> {
  // Use a broad text locator so we don't depend on a specific swimlane ordering.
  const card = page.locator(`text=${taskTitle}`).first();
  await card.click();
  // Wait for the window to mount so the window-store is populated.
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.first().waitFor({ state: 'visible', timeout: 5000 });
}

/** Close ALL open task-detail windows via Ctrl+Shift+W hotkey so subsequent
 *  tests start from a clean zero-window state. */
async function closeAllWindows(page: Page): Promise<void> {
  // Keep pressing the close-window hotkey until no dialogs are visible.
  for (let iteration = 0; iteration < 10; iteration++) {
    const count = await page.locator('[data-testid="task-detail-dialog"]').count();
    if (count === 0) break;
    await page.keyboard.press('Control+Shift+W');
    // Wait a tick for the close animation to settle before checking again.
    await page.locator('[data-testid="task-detail-dialog"]').first().waitFor({
      state: 'hidden',
      timeout: 2000,
    }).catch(() => { /* count may have already hit 0 */ });
  }
}

/** Set the `windowLightDismiss` policy via the config store. */
async function setPolicy(
  page: Page,
  policy: 'off' | 'single' | 'focused' | 'all',
): Promise<void> {
  await page.evaluate((pol) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { updateConfig: (patch: Record<string, unknown>) => void } } };
    }).__zustandStores;
    stores?.config.getState().updateConfig({ windowLightDismiss: pol });
  }, policy);
}

/**
 * Dispatch a "clean click" onto a swimlane COLUMN body via `dispatchEvent`. This is
 * the realistic empty-board target: the columns fill the board, so a real user
 * clicking "empty board" almost always lands on a column body, NOT the thin padding.
 *
 * The column wrapper carries dnd-kit's injected `role="button"` (useSortable
 * `{...attributes}`). `isDismissibleDeadArea` must still treat a column body as
 * dead space: it is not a card (`[data-task-id]`) or window (`#window-layer-root`),
 * is NOT a real `<button>`, and shows no pointer cursor. The hook deliberately omits
 * `role="button"` precisely so this common click dismisses - targeting the column
 * here locks that in (re-adding `role="button"` to the selector turns every
 * occurrence test red).
 *
 * Dispatching on the element (rather than `page.mouse` at viewport coordinates)
 * makes `event.target` deterministic - no dependence on viewport width, column
 * count, or window position. The hook listens at `document` level, so a dispatched
 * event that bubbles reaches it. pointerdown + pointerup share a pointerId and
 * identical clientX/Y (0px travel < the 4px clean-click radius).
 */
async function clickEmptyBoard(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name]').first().waitFor({ state: 'visible', timeout: 3000 });
  await page.evaluate(() => {
    // First column body: dead space (no pointer cursor) with a dnd-kit `role="button"`
    // sortable-wrapper ancestor, which is exactly the real-world empty-board click.
    const column = document.querySelector('[data-swimlane-name]');
    if (!column) throw new Error('no [data-swimlane-name] column found');
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      pointerId: 1,
      clientX: 200,
      clientY: 700,
    };
    column.dispatchEvent(new PointerEvent('pointerdown', init));
    column.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  });
}

/** Assert that the count of open task-detail windows eventually reaches `expected`.
 *  Uses expect.poll so it handles async React state updates without fixed waits. */
async function pollWindowCount(page: Page, expected: number, timeoutMs = 3000): Promise<void> {
  await expect
    .poll(
      () => page.locator('[data-testid="task-detail-dialog"]').count(),
      { timeout: timeoutMs, intervals: [100, 150, 200, 300] },
    )
    .toBe(expected);
}

/** Dispatch a clean (0px-travel) pointerdown + pointerup pair on the first element
 *  matching `selector`, to exercise a click on a specific board element (a column
 *  header, the toolbar) rather than the empty columns. Same dispatch-on-element
 *  rationale as `clickEmptyBoard`. */
async function dispatchCleanClickOn(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 3000 });
  await page.evaluate((selectorArg) => {
    const element = document.querySelector(selectorArg);
    if (!element) throw new Error(`no element for selector: ${selectorArg}`);
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      pointerId: 1,
      clientX: 200,
      clientY: 120,
    };
    element.dispatchEvent(new PointerEvent('pointerdown', init));
    element.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  }, selector);
}

// ---------------------------------------------------------------------------
// Test suite: policies and core detection behaviour
// ---------------------------------------------------------------------------
test.describe('window light-dismiss (click-outside-to-close)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithState();
    browser = result.browser;
    page = result.page;
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  // -------------------------------------------------------------------------
  // Policy: `single` (no longer the default - `focused` is, so these set it)
  // -------------------------------------------------------------------------

  test('single: one floating window is closed by a clean empty-board click', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');

    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    await clickEmptyBoard(page);
    await pollWindowCount(page, 0);
  });

  test('single: two windows open - empty-board click closes NOTHING', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');

    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);
    await openWindow(page, 'Task Beta');
    await pollWindowCount(page, 2);

    await clickEmptyBoard(page);

    // With two windows open, `single` policy returns an empty target list.
    // Give any latent close a budget, then assert the count is unchanged.
    // Intentional fixed wait - we cannot poll for non-occurrence.
    await page.waitForTimeout(600);
    await pollWindowCount(page, 2);
  });

  // -------------------------------------------------------------------------
  // Policy: `off`
  // -------------------------------------------------------------------------

  test('off: one window open - empty-board click does nothing', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'off');

    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    await clickEmptyBoard(page);

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(600);
    await pollWindowCount(page, 1);

    // Restore to default so later tests are unaffected.
    await setPolicy(page, 'single');
  });

  // -------------------------------------------------------------------------
  // Policy: `focused`
  // -------------------------------------------------------------------------

  test('focused: two windows open - empty-board click closes the focused one (count 2 -> 1)', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'focused');

    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);
    await openWindow(page, 'Task Beta');
    await pollWindowCount(page, 2);

    // Task Beta's window was opened last, so it is focused.
    await clickEmptyBoard(page);
    // One window should close; the other stays.
    await pollWindowCount(page, 1);

    // Clicking again closes the NEXT one, so repeated background clicks drain the stack
    // in focus order. This is the property that makes `focused` a usable default: the
    // survivor has to inherit focus when its predecessor closes, or the second click
    // resolves to no target and the remaining windows become unclosable this way.
    await clickEmptyBoard(page);
    await pollWindowCount(page, 0);

    await setPolicy(page, 'single');
  });

  // -------------------------------------------------------------------------
  // Policy: `all`
  // -------------------------------------------------------------------------

  test('all: two windows open - empty-board click closes all (count -> 0)', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'all');

    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);
    await openWindow(page, 'Task Beta');
    await pollWindowCount(page, 2);

    await clickEmptyBoard(page);
    await pollWindowCount(page, 0);

    await setPolicy(page, 'single');
  });

  // -------------------------------------------------------------------------
  // Detection: clicking a card never dismisses
  // -------------------------------------------------------------------------

  test('clicking a CARD opens a second window and does NOT dismiss the first', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');

    // Open window A.
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // Now click Task Beta's card. The click target is [data-task-id], which the
    // hook's `isDismissibleDeadArea` guard rejects - so it is never a dismiss.
    const betaCard = page.locator('[data-swimlane-name="Code Review"]').locator('text=Task Beta').first();
    await betaCard.click();

    // A second window opens; the first stays open.
    await pollWindowCount(page, 2);
  });

  // -------------------------------------------------------------------------
  // Detection: dismissable-layer guard (right-click context menu)
  // -------------------------------------------------------------------------

  test('layer guard: right-click opens TaskContextMenu; empty-board click dismisses menu but NOT the window', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');

    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // Right-click Task Beta's card to open the TaskContextMenu.
    // TaskContextMenu has `data-dismissable-layer` on its root div.
    const betaCard = page.locator('[data-swimlane-name="Code Review"]').locator('text=Task Beta').first();
    await betaCard.click({ button: 'right' });

    // The context menu should be visible (carries data-dismissable-layer).
    const contextMenu = page.locator('[data-testid="context-edit-task"]');
    await contextMenu.waitFor({ state: 'visible', timeout: 3000 });

    // At pointerdown on empty board the hook records layerOpenAtDown = true
    // (the context menu is visible), so the hook skips the dismiss.
    // The context menu self-closes via its own capture-phase `mousedown` listener
    // (see TaskContextMenu.tsx - it listens for `mousedown`, not `pointerdown`).
    // We dispatch pointerdown (caught by the light-dismiss hook) AND mousedown
    // (caught by the context-menu close handler) on a dead board area (a column body).
    await page.evaluate(() => {
      const deadArea = document.querySelector('[data-swimlane-name]');
      if (!deadArea) throw new Error('[data-swimlane-name] not found');
      const pointerInit: PointerEventInit = {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        pointerId: 1, clientX: 200, clientY: 700,
      };
      const mouseInit: MouseEventInit = {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        clientX: 200, clientY: 700,
      };
      // pointerdown is captured by the light-dismiss hook.
      deadArea.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
      // mousedown is captured by TaskContextMenu's outside-click handler (capture=true).
      deadArea.dispatchEvent(new MouseEvent('mousedown', mouseInit));
      // pointerup completes the pointer pair for the hook.
      deadArea.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 }));
    });

    // The context menu should be gone (self-closed by mousedown outside it).
    await contextMenu.waitFor({ state: 'hidden', timeout: 3000 });

    // The task-detail window must still be open (the layer guard skipped it).
    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  });

  // -------------------------------------------------------------------------
  // Detection: drag-release is NOT treated as a clean click
  // -------------------------------------------------------------------------

  test('drag-release on empty board (> 4px) does NOT dismiss the window', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');

    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // Simulate a drag that starts and ends on a dead board area (a column body).
    // Pointerdown at (200, 700), pointerup at (210, 700) = 10px travel, which exceeds
    // CLEAN_CLICK_MAX_PX (4) and must be ignored.
    await page.evaluate(() => {
      const deadArea = document.querySelector('[data-swimlane-name]');
      if (!deadArea) throw new Error('[data-swimlane-name] not found');
      const downInit: PointerEventInit = {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        pointerId: 1, clientX: 200, clientY: 700,
      };
      const upInit: PointerEventInit = {
        bubbles: true, cancelable: true, button: 0, buttons: 0,
        pointerId: 1, clientX: 210, clientY: 700,
      };
      deadArea.dispatchEvent(new PointerEvent('pointerdown', downInit));
      deadArea.dispatchEvent(new PointerEvent('pointerup', upInit));
    });

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  });

  // -------------------------------------------------------------------------
  // Unsaved-edits guard (closes via closeWithGuard -> ConfirmDialog instead of
  // silently, when the edit form is dirty)
  // -------------------------------------------------------------------------

  test('unsaved-edits guard: dirty edit form triggers ConfirmDialog instead of silently closing', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');

    // Task Gamma is in To Do with no session -> opens in EDIT mode.
    await openWindow(page, 'Task Gamma');
    await pollWindowCount(page, 1);

    // A To Do task in edit mode shows a title input.
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.waitFor({ state: 'visible', timeout: 3000 });

    // Make the form dirty by typing into the title field.
    await titleInput.fill('Task Gamma (modified)');

    // Click the empty board. The policy (`single`) selects this window.
    // `closeWithGuard` sees the dirty form and shows ConfirmDialog instead of closing.
    await clickEmptyBoard(page);

    // The "Discard unsaved changes?" confirm dialog must appear.
    const confirmHeading = page.locator('h3:has-text("Discard unsaved changes?")');
    await confirmHeading.waitFor({ state: 'visible', timeout: 5000 });

    // The task-detail window is still mounted behind the confirm dialog.
    await pollWindowCount(page, 1);

    // Dismiss the confirm so we leave a clean state.
    await page.locator('button:has-text("Keep editing")').click();
    // Use a generous timeout here: on CI Linux the confirm dialog animates out
    // under load, and 2000ms was too tight and caused the next assertion to race.
    await confirmHeading.waitFor({ state: 'hidden', timeout: 5000 });

    // Close via Escape (routes through closeWithGuard again). Give the confirm
    // dialog time to appear - the keystroke must be processed and React must
    // re-render before the dialog is visible. 2000ms was too tight for CI Linux.
    await page.keyboard.press('Escape');
    await confirmHeading.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('button:has-text("Discard")').click();
    await pollWindowCount(page, 0);
  });

  // -------------------------------------------------------------------------
  // Detection: action controls never dismiss; the board toolbar dead space does
  // -------------------------------------------------------------------------

  test('clicking a column header (an action) does NOT dismiss the window', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // A swimlane column header is a <div onClick> that opens the board manager. It
    // carries `data-no-dismiss`, so a clean click on it must NOT close the window.
    await dispatchCleanClickOn(page, '[data-swimlane-name] [data-no-dismiss]');

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  });

  test('clicking the board toolbar dead space DOES dismiss the lone window', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // The board toolbar (view-toggle) is dead space (no pointer cursor, not a
    // control), so a clean click on the strip itself (between the action buttons)
    // dismisses the lone window just like a click on the empty columns.
    await dispatchCleanClickOn(page, '[data-testid="view-toggle"]');

    await pollWindowCount(page, 0);
  });

  test('clicking a project sidebar row (cursor-pointer, no marker) does NOT dismiss', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // A sidebar project row is a <div role="button"> with `cursor: pointer` and NO
    // [data-no-dismiss] marker, so it must be excluded purely by the pointer-cursor
    // heuristic (proving clickable <div>s across the app shell never dismiss).
    await dispatchCleanClickOn(page, '[data-testid^="project-row-"]');

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  });

  test('clicking outside every layer scope (an overlay/backdrop region) does NOT dismiss', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // `document.body` has no `[data-dismiss-layer]` ancestor, so it stands in for anything
    // OUTSIDE the marked shell subtree: the settings panel, stats page, search palette,
    // command-terminal layer, walkthrough, toasts, and every dialog, all of which mount as
    // AppLayout-root siblings, plus every `document.body` portal. A click there must never
    // dismiss the window beneath. Under a denylist this is the load-bearing fail-safe: it is
    // what makes a NEW overlay inert on arrival instead of a hole that must be found and
    // marked, so it survived the polarity inversion with its assertion unchanged.
    await page.evaluate(() => {
      const init: PointerEventInit = {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        pointerId: 1, clientX: 200, clientY: 400,
      };
      document.body.dispatchEvent(new PointerEvent('pointerdown', init));
      document.body.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    });

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  });

  // -------------------------------------------------------------------------
  // Denylist inversion: shell regions that dismiss, and the exclusions that hold
  // -------------------------------------------------------------------------

  test('sidebar dead space DOES dismiss the lone window', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // The project-list scroller's own body (below the rows) is dead space. It dismisses
    // because it sits inside AppLayout's `data-dismiss-layer="board"` subtree, with no
    // per-region marking of its own. Its project ROWS stay excluded by their pointer
    // cursor - covered by the sidebar-row test above.
    await dispatchCleanClickOn(page, '[data-testid="sidebar-project-list"]');

    await pollWindowCount(page, 0);
  });

  test('status bar dead space DOES dismiss the lone window', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // The status bar carries its OWN scope marker, because it sits outside AppLayout's
    // marked content row rather than inside it. If that marker is ever dropped, this goes
    // red while every other shell region keeps working.
    await dispatchCleanClickOn(page, '[data-testid="status-bar"]');

    await pollWindowCount(page, 0);
  });

  test('the sidebar resize handle (a drag target) does NOT dismiss', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // `cursor-col-resize` is not `pointer`, so the cursor heuristic cannot exclude this
    // handle - it needs `data-no-dismiss`. It also lights up on hover, so dismissing here
    // would make that hover state promise an action the click does not deliver.
    await dispatchCleanClickOn(page, '[data-testid="sidebar-resize-handle"]');

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  });

  test('the terminal resize handle (a drag target) does NOT dismiss', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    // Task Gamma deliberately, not Alpha: Alpha owns a running session, so its window claims
    // it and `shouldForceCollapseTerminal` collapses the panel, unmounting this handle. Gamma
    // claims nothing, so the panel stays expanded with the other sessions' tabs.
    await openWindow(page, 'Task Gamma');
    await pollWindowCount(page, 1);

    // Same shape as the sidebar handle, with a second hover source: `.resize-handle:hover`
    // in index.css on top of the Tailwind `hover:bg-fg-faint`.
    await dispatchCleanClickOn(page, '[data-testid="terminal-resize-handle"]');

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  });

  test('an open overlay layer does NOT dismiss the window beneath it', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // The real fail-safe test, stronger than the `document.body` case above: open an actual
    // overlay and click ITS dead space. The settings panel mounts as a SIBLING of the marked
    // shell subtree, so it resolves to no scope and cannot dismiss. Under the old allowlist a
    // missed overlay was merely inert; under a denylist it would close the window behind it,
    // so this is the guard on the whole placement decision.
    await page.locator('[data-testid="settings-button"]').click();
    await page.locator('[data-testid="settings-panel"]').waitFor({ state: 'visible', timeout: 3000 });

    // The tab-nav column's own body (below the tab buttons) is dead space INSIDE the panel:
    // not a control, no pointer cursor. Exactly the shape that dismisses out on the board.
    await dispatchCleanClickOn(page, '[data-testid="settings-tab-list"]');

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);

    await page.keyboard.press('Escape');
    await page.locator('[data-testid="settings-panel"]').waitFor({ state: 'hidden', timeout: 3000 });
  });

  // -------------------------------------------------------------------------
  // Middle-click on the window header closes it (independent of the policy)
  // -------------------------------------------------------------------------

  test('middle-click on the window header closes it, even with the policy off', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'off');
    await openWindow(page, 'Task Alpha');
    await pollWindowCount(page, 1);

    // The middle mouse button on the title bar closes the window like the X button,
    // independent of windowLightDismiss (here 'off', which disables click-outside).
    await page.locator('[data-testid="task-detail-titlebar"]').first().click({ button: 'middle' });

    await pollWindowCount(page, 0);
    await setPolicy(page, 'single');
  });

  test('middle-click on the header of a dirty edit form shows the discard confirm', async () => {
    await closeAllWindows(page);
    await setPolicy(page, 'single');
    await openWindow(page, 'Task Gamma');
    await pollWindowCount(page, 1);

    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.waitFor({ state: 'visible', timeout: 3000 });
    await titleInput.fill('Task Gamma (middle-click edit)');

    // Middle-click routes through closeWithGuard, so a dirty edit form prompts to
    // discard instead of silently closing - same guard as the X and Escape.
    await page.locator('[data-testid="task-detail-titlebar"]').first().click({ button: 'middle' });

    const confirmHeading = page.locator('h3:has-text("Discard unsaved changes?")');
    await confirmHeading.waitFor({ state: 'visible', timeout: 3000 });
    await pollWindowCount(page, 1);

    await page.locator('button:has-text("Discard")').click();
    await pollWindowCount(page, 0);
  });
});
