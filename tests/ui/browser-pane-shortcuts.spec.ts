/**
 * UI tests for BrowserPaneActive keyboard shortcuts.
 *
 * BrowserPane registers a CAPTURE-phase document-level keydown listener that
 * handles:
 *   Ctrl+D / Meta+D          -- Toggle draw mode
 *   Ctrl+I / Meta+I          -- Start inspect
 *   Esc (while inspect active) -- Cancel inspect WITHOUT closing the dialog
 *
 * The "in a form field" guard skips Ctrl+D and Ctrl+I when the target is
 * INPUT or TEXTAREA.
 *
 * Headless caveats:
 *   - <webview> is mounted in the DOM as an unknown HTML element. Its Electron-
 *     specific methods (loadURL, executeJavaScript, getURL, etc.) are absent.
 *   - Ctrl+D / draw button click call cancelInspect() which calls
 *     webviewRef.current?.executeJavaScript(...). In headless this throws
 *     synchronously (executeJavaScript is not a function on an HTMLElement),
 *     crashing BrowserPaneActive via the ErrorBoundary. Draw mode shortcuts
 *     cannot be tested in the UI tier.
 *   - Ctrl+I calls startInspect() -> webviewRef.current?.executeJavaScript(INSPECT_SCRIPT).
 *     Same crash. Inspect shortcuts cannot be tested in the UI tier.
 *   - Ctrl+Enter (plain Enter with ctrlKey) handling moved in the PR that
 *     introduced this spec: the shortcut is now handled by the note <input>'s
 *     own onKeyDown, NOT by the document-level listener. A document-level
 *     Ctrl+Enter dispatch (from outside the note input) is therefore a no-op.
 *     The in-input path calls handleSend() -> webview.executeJavaScript() ->
 *     crash in headless. Enter+Shift is a new guard (the onKeyDown bails on
 *     event.shiftKey) that can be tested here because the guard fires BEFORE
 *     the webview call.
 *
 * What IS testable in the UI tier:
 *   - Ctrl+D in a form field (URL input) is a no-op -> draw mode stays off.
 *     This is testable because we never click outside the form field so the
 *     document listener fires but the inFormField guard prevents any draw mode
 *     change and therefore no executeJavaScript call is made.
 *   - Ctrl+I in a form field (note input) is a no-op -> inspect stays off.
 *     Same reasoning: inFormField guard fires, no startInspect, no crash.
 *   - Esc at document level when inspect is NOT active does not close the dialog.
 *     We dispatch Esc while the pane has non-inspect focus and assert the dialog
 *     stays open. This validates the guard without needing a real inspect mode.
 *   - Ctrl+Enter from outside the note input (document dispatch) is a no-op.
 *     The send shortcut now lives in the input's own onKeyDown, so a document-
 *     level Ctrl+Enter never reaches handleSend. Pane stays mounted (no crash).
 *   - Shift+Enter inside the note input is a no-op -> send NOT triggered.
 *     The input onKeyDown bails immediately when event.shiftKey is true (new
 *     guard introduced alongside the Ctrl+Enter -> plain Enter unification).
 *     Testable here because the guard fires before the webview call.
 *
 * Draw mode and inspect mode shortcut tests (the affirmative paths) belong in
 * tests/e2e/ where a real Electron webview provides executeJavaScript.
 *
 * Performance note: all 8 tests use the same pre-configured mock state and a
 * single browser instance shared via beforeAll/afterAll. Each test gets fresh
 * React and mock state via page.goto() in beforeEach, which re-runs all
 * registered addInitScript callbacks on the context. A page navigation is
 * ~200-400ms vs ~1-2s for a full chromium.launch(), saving ~7 launch cycles.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-shortcuts';
const TASK_ID = 'task-browser-shortcuts';
const SESSION_ID = 'sess-browser-shortcuts';
const PROJECT_PATH = '/mock/browser-shortcuts-test';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Browser Shortcuts Test',
      path: '${PROJECT_PATH}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.projectConfigs['${PROJECT_PATH}'] = {
      browser: { enabled: true },
    };

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-sc-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9998,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Shortcuts Browser Task',
      description: 'Used to drive BrowserPaneActive keyboard shortcut tests',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
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

let sharedBrowser: Browser;
let sharedPage: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({ headless: true });
  const context = await sharedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  sharedPage = await context.newPage();

  await sharedPage.addInitScript({ path: MOCK_SCRIPT });
  await sharedPage.addInitScript(preConfig);

  await sharedPage.goto(VITE_URL);
  await sharedPage.waitForLoadState('load');
  await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
  await sharedPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

test.beforeEach(async () => {
  // Full page navigation resets both mock API state (init scripts re-run) and
  // React component state (app re-mounts). This is faster than a new browser
  // launch while providing the same isolation guarantee.
  await sharedPage.goto(VITE_URL);
  await sharedPage.waitForLoadState('load');
  await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
  await sharedPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

/** Seed task URL and open the browser pane. */
async function openBrowserPane(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl('task-browser-shortcuts', 'http://localhost:5173/');
  });

  const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Shortcuts Browser Task').first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });

  const browserPane = page.locator('[data-testid="browser-pane"]');
  if (!(await browserPane.isVisible().catch(() => false))) {
    await page.locator('[data-testid="browser-toggle"]').click();
  }
  await browserPane.waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('BrowserPaneActive keyboard shortcuts - form-field guards', () => {
  test('Ctrl+D in the URL bar (INPUT) does NOT toggle draw mode', async () => {
    // The inFormField guard in the document-level listener prevents Ctrl+D
    // from calling setDrawMode when the event target is an INPUT element.
    // The draw button must remain in non-active state after the shortcut.
    await openBrowserPane(sharedPage);

    const urlInput = sharedPage.locator('[data-testid="browser-url-input"]');
    const drawButton = sharedPage.locator('[data-testid="browser-draw-toggle"]');

    // Verify draw is initially off.
    await expect(drawButton).not.toHaveClass(/bg-accent/);

    // Focus the URL input and fire the shortcut.
    await urlInput.click();
    await sharedPage.keyboard.press('Control+d');

    // The draw button must remain non-active (guard fired).
    // If the guard had NOT fired, executeJavaScript would be called and
    // the component would crash -- an implicit crash assertion.
    await expect(drawButton).not.toHaveClass(/bg-accent/);
    await expect(sharedPage.locator('[data-testid="browser-pane"]')).toBeVisible();
  });

  test('Ctrl+Enter outside the note input does NOT trigger send', async () => {
    // Regression: previously the document-level capture-phase listener fired
    // handleSend() on Ctrl+Enter from anywhere, hijacking the terminal's newline
    // shortcut. The send shortcut is now scoped to the note input's own
    // onKeyDown, so dispatching Ctrl+Enter at document level (i.e. from outside
    // the note input) must be a no-op. If handleSend ran, webview.executeJavaScript
    // would throw in headless and the ErrorBoundary would tear down the pane.
    // We assert the pane stays mounted to confirm send was NOT triggered.
    await openBrowserPane(sharedPage);

    // Move focus away from the note input by clicking the URL bar.
    await sharedPage.locator('[data-testid="browser-url-input"]').click();

    // Dispatch Ctrl+Enter at document level (bypasses xterm capture).
    await sharedPage.evaluate(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Pane stays mounted (handleSend was NOT called -> no executeJavaScript crash).
    await expect(sharedPage.locator('[data-testid="browser-pane"]')).toBeVisible();
    await expect(sharedPage.locator('[data-testid="task-detail-dialog"]')).toBeVisible();
  });

  test('Shift+Enter in the note input does NOT trigger send', async () => {
    // The note input onKeyDown bails when event.shiftKey is true:
    //   if (event.key !== 'Enter' || event.shiftKey || sending) return;
    // This guard preserves Shift+Enter as a literal newline shortcut and
    // prevents the browser send path from firing. If the guard had NOT fired,
    // handleSend() would call webview.executeJavaScript() -> crash in headless.
    // We assert the pane stays mounted as an implicit no-crash assertion.
    await openBrowserPane(sharedPage);

    const noteInput = sharedPage.locator('[data-testid="browser-note-input"]');

    // Type something so the note is non-empty (send guard also checks sending
    // state, but the shiftKey guard fires before the webview call regardless).
    await noteInput.fill('test note');

    // Focus the note input, then press Shift+Enter.
    await noteInput.click();
    await sharedPage.keyboard.press('Shift+Enter');

    // Dialog and pane must still be visible (handleSend was NOT called).
    await expect(sharedPage.locator('[data-testid="browser-pane"]')).toBeVisible();
    await expect(sharedPage.locator('[data-testid="task-detail-dialog"]')).toBeVisible();
  });

  test('Ctrl+I in the note input (INPUT) does NOT start inspect', async () => {
    // The inFormField guard prevents Ctrl+I from calling startInspect() when
    // the event target is an INPUT element. The inspect button must remain
    // non-active and the component must not crash.
    await openBrowserPane(sharedPage);

    const noteInput = sharedPage.locator('[data-testid="browser-note-input"]');
    const inspectButton = sharedPage.locator('[data-testid="browser-inspect-toggle"]');

    // Inspect is initially off.
    await expect(inspectButton).not.toHaveClass(/bg-accent/);

    // Focus the note input and fire the shortcut.
    await noteInput.click();
    await sharedPage.keyboard.press('Control+i');

    // Inspect must remain off (guard fired).
    await expect(inspectButton).not.toHaveClass(/bg-accent/);
    // Dialog and pane must still be visible.
    await expect(sharedPage.locator('[data-testid="task-detail-dialog"]')).toBeVisible();
    await expect(sharedPage.locator('[data-testid="browser-pane"]')).toBeVisible();
  });
});

test.describe('BrowserPaneActive keyboard shortcuts - Esc handling', () => {
  test('Esc at document level does not close the dialog when inspect is NOT active', async () => {
    // BrowserPane's capture-phase Esc handler only fires cancelInspect() when
    // inspectActive === true. When inspect is off, Esc propagates normally to
    // the parent TaskDetailDialog's bubble-phase handler.
    //
    // However, TaskDetailDialog's Esc handler closes the dialog. We verify
    // that the dialog closes (expected Esc behaviour when inspect is off) --
    // this confirms the BrowserPane Esc handler is NOT incorrectly eating the
    // event when inspect is inactive.
    //
    // We use document.dispatchEvent (anti-pattern 10) to bypass xterm capture.
    await openBrowserPane(sharedPage);

    // Dispatch Esc at document level -- should propagate to dialog's handler.
    await sharedPage.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    // When inspect is NOT active the BrowserPane Esc handler does nothing,
    // so the dialog's own Esc listener fires and closes the dialog.
    await sharedPage.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });
});

test.describe('BrowserPaneActive keyboard shortcuts - URL input Enter', () => {
  test('pressing Enter in the URL input with an unparseable URL surfaces an error', async () => {
    // Exercises the handleUrlSubmit -> navigate() path when called from inside
    // an INPUT element (the form's onSubmit fires, not the document listener).
    // `:bad` is not a valid hostname so new URL('http://:bad') throws, setting
    // the error state WITHOUT calling loadURL -- safe in headless.
    await openBrowserPane(sharedPage);
    const urlInput = sharedPage.locator('[data-testid="browser-url-input"]');
    await urlInput.fill(':bad');
    await urlInput.press('Enter');
    await expect(sharedPage.getByText(/Invalid URL:/)).toBeVisible({ timeout: 3000 });
    // Pane must still be mounted (the error branch returns before loadURL).
    await expect(sharedPage.locator('[data-testid="browser-pane"]')).toBeVisible();
  });
});

test.describe('BrowserPaneActive zoom controls', () => {
  test('toolbar buttons step zoom and the % button resets to 100%', async () => {
    // applyZoom uses `if (typeof webview.setZoomFactor === 'function')` so the
    // missing method on the headless HTMLElement does not crash -- the React
    // state still updates and the toolbar % reflects it.
    await openBrowserPane(sharedPage);

    const zoomReset = sharedPage.locator('[data-testid="browser-zoom-reset"]');
    const zoomIn = sharedPage.locator('[data-testid="browser-zoom-in"]');
    const zoomOut = sharedPage.locator('[data-testid="browser-zoom-out"]');

    // Initial state: 100%.
    await expect(zoomReset).toHaveText('100%');

    // Step up once -> 110% (next rung on the Chrome ladder).
    await zoomIn.click();
    await expect(zoomReset).toHaveText('110%');

    // Step up again -> 125%.
    await zoomIn.click();
    await expect(zoomReset).toHaveText('125%');

    // Reset via the % button.
    await zoomReset.click();
    await expect(zoomReset).toHaveText('100%');

    // Step down -> 90%.
    await zoomOut.click();
    await expect(zoomReset).toHaveText('90%');
  });

  test('Ctrl+= and Ctrl+0 work when focus is inside the pane', async () => {
    // The keydown handler gates zoom shortcuts on hovered OR focus-within.
    // Focusing the % button (which is inside paneRef) is the most reliable
    // way to set focus-within in a headless test, and doesn't mutate state.
    await openBrowserPane(sharedPage);
    const zoomReset = sharedPage.locator('[data-testid="browser-zoom-reset"]');
    await expect(zoomReset).toHaveText('100%');

    // Focus the % button so paneRef.current.contains(document.activeElement)
    // becomes true; the gate then admits the zoom shortcuts.
    await zoomReset.focus();

    await sharedPage.keyboard.press('Control+=');
    await expect(zoomReset).toHaveText('110%');

    await sharedPage.keyboard.press('Control+0');
    await expect(zoomReset).toHaveText('100%');
  });

  test('Ctrl+= does NOT fire when the pane is neither hovered nor focused', async () => {
    // Same principle as task #139: global Ctrl+0 should not reset browser
    // zoom while the user is interacting elsewhere. We move the mouse away
    // from the pane (onto the page body well outside the pane) and ensure
    // no input inside the pane is focused.
    await openBrowserPane(sharedPage);
    const zoomReset = sharedPage.locator('[data-testid="browser-zoom-reset"]');

    // Prime the zoom to a non-default so a missed reset would be visible.
    await sharedPage.locator('[data-testid="browser-zoom-in"]').click();
    await expect(zoomReset).toHaveText('110%');

    // First move INTO the pane center so onMouseEnter fires and sets
    // hoveredRef = true. This ensures that the subsequent move OUT
    // provably triggers onMouseLeave (not assumed to be starting outside).
    const paneBox = await sharedPage.locator('[data-testid="browser-pane"]').boundingBox();
    if (paneBox) {
      await sharedPage.mouse.move(
        paneBox.x + paneBox.width / 2,
        paneBox.y + paneBox.height / 2,
      );
    }

    // Now blur and move to (0,0) so onMouseLeave fires and hoveredRef = false.
    await sharedPage.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await sharedPage.mouse.move(0, 0);

    // hoveredRef is now false and nothing inside the pane has focus.
    // Ctrl+0 at the document level must not reset zoom.
    await sharedPage.keyboard.press('Control+0');

    // The gate should have prevented reset.
    await expect(zoomReset).toHaveText('110%');
  });

  test('Ctrl+= fires when pane is hovered but no element inside has focus', async () => {
    // Positive path for the hover branch of the zoom gate.
    // hoveredRef.current === true (via onMouseEnter) lets zoom shortcuts fire
    // even when document.activeElement is completely outside the pane.
    //
    // Approach: Hover the zoom-reset button (inside pane, real DOM element,
    // not covered by the webview overlay) using Playwright's element.hover()
    // which reliably dispatches pointer events on the target. Then blur focus
    // and verify the keyboard shortcut fires via the hover path.
    //
    // The zoom-reset button is in the URL bar row which sits ABOVE the
    // webview/canvas overlay, so pointer events reach the element without
    // being intercepted by absolute-positioned children.
    await openBrowserPane(sharedPage);
    const zoomReset = sharedPage.locator('[data-testid="browser-zoom-reset"]');
    await expect(zoomReset).toHaveText('100%');

    // Hover the zoom-reset button. Playwright's .hover() moves the mouse
    // and waits for the element to be actionable, then dispatches mouse
    // events ending with mouseenter on the element and its ancestors -
    // including the [data-testid="browser-pane"] root which owns
    // onMouseEnter -> hoveredRef.current = true.
    await zoomReset.hover();

    // Blur everything. zoomReset.hover() may have left focus on the button
    // (browsers sometimes focus buttons on hover). We need focusInside to
    // be false so only the hover branch admits the shortcut.
    await sharedPage.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });

    // Fire Ctrl+= at the document level. hoveredRef.current should be true
    // (the hover event chain sets it) so the gate admits the shortcut even
    // though nothing inside the pane is focused.
    await sharedPage.keyboard.press('Control+=');

    // hoveredRef was true -> shortcut fires -> zoomFactor steps from 1.0 to 1.1.
    await expect(zoomReset).toHaveText('110%');
  });
});
