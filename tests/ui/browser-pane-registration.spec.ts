/**
 * UI test for BrowserPaneActive webContents registration/unregistration wiring.
 *
 * The BrowserPaneActive component (in src/renderer/components/browser/BrowserPane.tsx)
 * registers the guest webview's webContentsId with the main process via
 * window.electronAPI.browser.registerPane() when the 'dom-ready' event fires
 * on the <webview> element, and calls unregisterPane() on component unmount.
 *
 * This wiring lets the main process associate a specific webContents (the browser
 * pane's guest) with a task/session so that kangentic_browser_* MCP tools can
 * drive the correct browser window.
 *
 * Headless behaviour affecting test design:
 *   - <webview> IS inserted into the DOM as an unknown HTMLElement, so
 *     webviewRef.current is non-null. However, Electron-specific methods are
 *     absent (getWebContentsId, getURL, etc.).
 *   - The registration effect's guard `typeof webview.getWebContentsId !== 'function'`
 *     causes the immediate register() call on mount to no-op.
 *   - To trigger registration, we inject getWebContentsId and getURL onto the
 *     DOM stub and dispatch a synthetic 'dom-ready' event. The effect attaches
 *     its dom-ready listener synchronously on mount, so the dispatch is
 *     reliably caught.
 *   - Unregistration is triggered by an agent's close_pane push (the mock's
 *     `emitPaneCloseRequest`), which is the one path that unmounts
 *     BrowserPaneActive while the fixture's session is running: closing the
 *     window PARKS it and hiding the pane HOLDS it, both keeping the guest.
 *
 * Test isolation: __mockBrowser.reset() clears the pane-call log in openBrowserPane.
 * Full page.goto() in beforeEach reloads mock and React state between tests.
 *
 * Performance: all tests in this file share one headless Chromium browser via
 * beforeAll/afterAll. Each test gets fresh React and mock state via page.goto()
 * in beforeEach, which re-runs all addInitScript callbacks.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-reg';
const TASK_ID = 'task-browser-reg';
const SESSION_ID = 'sess-browser-reg';
const PROJECT_PATH = '/mock/browser-reg-test';
// Synthetic webContentsId injected onto the <webview> stub to simulate a
// real Electron guest attaching. Must be a positive integer (the real guard
// checks `Number.isInteger(webContentsId) && webContentsId > 0`).
const MOCK_WEB_CONTENTS_ID = 4242;

// Inline template literal avoids a runtime string interpolation problem with
// the `\\s+` regex inside a nested function body. Backslash escaping is
// consistent with the pattern used in browser-pane-active.spec.ts.
const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Browser Registration Test',
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
      var id = 'lane-br-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9997,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Browser Registration Task',
      description: 'Used to drive BrowserPaneActive webContents registration tests',
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
  // React component state (app re-mounts, error boundaries cleared). This is
  // faster than a new browser launch while providing the same isolation guarantee.
  await sharedPage.goto(VITE_URL);
  await sharedPage.waitForLoadState('load');
  await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
  await sharedPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

/**
 * Seed the task URL, reset the pane-call log, and open the browser pane
 * inside the task detail dialog.
 */
async function openBrowserPane(page: Page): Promise<void> {
  // Reset clears browserPaneCalls so each test starts with an empty log.
  await page.evaluate(() => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl('task-browser-reg', 'http://localhost:5173/');
  });

  const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Browser Registration Task').first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });

  // Only click the toggle when the pane is not already showing. The
  // browserOpen flag is sticky per-task across dialog opens, but since
  // beforeEach does a full page.goto() the flag is always reset to false.
  const browserPane = page.locator('[data-testid="browser-pane"]');
  if (!(await browserPane.isVisible().catch(() => false))) {
    await page.locator('[data-testid="browser-toggle"]').click();
  }
  await browserPane.waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('BrowserPaneActive - webContents registration', () => {
  test('calls registerPane on dom-ready with correct payload and unregisterPane on unmount', async () => {
    await openBrowserPane(sharedPage);

    // Confirm the webview stub element is in the DOM before firing dom-ready.
    // The registration effect attaches its listener synchronously on mount,
    // so any dispatch after the element exists is reliably caught.
    await sharedPage.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 5000 });

    // Inject getWebContentsId and getURL onto the plain HTMLElement stub, then
    // dispatch dom-ready. The immediate register() call on mount was a no-op
    // because `typeof webview.getWebContentsId !== 'function'`. The dom-ready
    // listener now calls register(), passes the type-and-value guards, and
    // invokes window.electronAPI.browser.registerPane with the session context.
    await sharedPage.evaluate((webContentsId: number) => {
      const element = document.querySelector('[data-testid="browser-webview"]');
      if (!element) throw new Error('browser-webview element not found in DOM');
      const stub = element as HTMLElement & {
        getWebContentsId: () => number;
        getURL: () => string;
      };
      stub.getWebContentsId = () => webContentsId;
      stub.getURL = () => 'http://localhost:5173/';
      element.dispatchEvent(new Event('dom-ready'));
    }, MOCK_WEB_CONTENTS_ID);

    // Poll for the register call. registerPane is async (void), so the mock
    // push may be microtask-delayed relative to the dom-ready dispatch.
    await expect.poll(
      () => sharedPage.evaluate((expectedId: number) => {
        const calls = window.__mockBrowser?.getPaneCalls() ?? [];
        return calls.some((call) => {
          if (call.type !== 'register') return false;
          return call.input.webContentsId === expectedId;
        });
      }, MOCK_WEB_CONTENTS_ID),
      { timeout: 5000 },
    ).toBe(true);

    // Assert the full register payload matches the open task/session context.
    const registerPayload = await sharedPage.evaluate(() => {
      const calls = window.__mockBrowser?.getPaneCalls() ?? [];
      const entry = calls.find((call) => call.type === 'register');
      if (!entry || entry.type !== 'register') return null;
      return {
        sessionId: entry.input.sessionId,
        taskId: entry.input.taskId,
        projectId: entry.input.projectId,
        webContentsId: entry.input.webContentsId,
      };
    });
    expect(registerPayload).not.toBeNull();
    expect(registerPayload?.sessionId).toBe(SESSION_ID);
    expect(registerPayload?.taskId).toBe(TASK_ID);
    expect(registerPayload?.webContentsId).toBe(MOCK_WEB_CONTENTS_ID);
    // The pane registry scopes MCP access by projectId, so the renderer must
    // send the hosted task's project rather than omitting it. Main backfills
    // from the session registry, but a missing field here would silently rot.
    expect(registerPayload?.projectId).toBe(PROJECT_ID);

    // Discard the pane the way an agent's close_pane does (main's push). Neither
    // user path would unmount the pane here, since the task has a running
    // session: closing the WINDOW parks it, and toggling the pane off HOLDS it
    // (browser-pane-park-on-close.spec.ts and browser-pane-hold-on-hide.spec.ts
    // own those). The agent's discard is what unmounts BrowserPaneActive and
    // runs its cleanup.
    await sharedPage.evaluate(({ projectId, taskId }) => {
      window.__mockBrowser?.emitPaneCloseRequest(projectId, [taskId]);
    }, { projectId: PROJECT_ID, taskId: TASK_ID });
    await sharedPage.locator('[data-testid="browser-webview"]').waitFor({ state: 'detached', timeout: 5000 });

    // Poll for the unregister call. React runs effect cleanup synchronously
    // during unmount (commit phase), so unregisterPane should be recorded
    // as soon as BrowserPaneActive leaves the DOM. The poll gives a budget
    // for any async scheduling between the toggle and React cleanup. The
    // unregister names the GUEST this instance registered, never the session:
    // main keys the surface by its guest, so an out-of-order unmount can only
    // ever remove its own registration.
    await expect.poll(
      () => sharedPage.evaluate((webContentsId: number) => {
        const calls = window.__mockBrowser?.getPaneCalls() ?? [];
        return calls.some((call) => call.type === 'unregister' && call.webContentsId === webContentsId);
      }, MOCK_WEB_CONTENTS_ID),
      { timeout: 5000 },
    ).toBe(true);
  });

  // A retained pane's whole purpose is that the SAME guest keeps running. A
  // DOM-presence check cannot prove that: React would happily render a brand new
  // <webview> at the same spot, and the agent's CDP session would be gone with
  // no visible difference. The only assertion that distinguishes "survived" from
  // "silently replaced" is the registered webContentsId, so this test reads the
  // register/unregister log rather than the DOM.
  test('a mounted pane keeps its webContentsId, and ignores another pane\'s zoom broadcast', async () => {
    await openBrowserPane(sharedPage);
    await sharedPage.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 5000 });

    await sharedPage.evaluate((webContentsId: number) => {
      const element = document.querySelector('[data-testid="browser-webview"]');
      if (!element) throw new Error('browser-webview element not found in DOM');
      const stub = element as HTMLElement & {
        getWebContentsId: () => number;
        getURL: () => string;
        setZoomFactor?: (factor: number) => void;
      };
      stub.getWebContentsId = () => webContentsId;
      stub.getURL = () => 'http://localhost:5173/';
      element.dispatchEvent(new Event('dom-ready'));
    }, MOCK_WEB_CONTENTS_ID);

    await expect.poll(
      () => sharedPage.evaluate(() => (window.__mockBrowser?.getPaneCalls() ?? []).filter((call) => call.type === 'register').length),
      { timeout: 5000 },
    ).toBeGreaterThan(0);

    const zoomLabel = sharedPage.locator('[data-testid="browser-zoom-reset"]');
    const zoomBefore = await zoomLabel.textContent();

    // A zoom applied to a DIFFERENT guest must not move this pane's readout. The
    // foreign factor is deliberately NOT the one broadcast below, so a leak is
    // distinguishable from this pane's own zoom rather than landing on the same
    // readout and reading as success.
    await sharedPage.evaluate((otherId: number) => {
      window.__mockBrowser?.emitZoomChanged(2, otherId);
    }, MOCK_WEB_CONTENTS_ID + 1);
    await expect.poll(() => zoomLabel.textContent(), { timeout: 2000 }).toBe(zoomBefore);

    // This pane's own guest still applies.
    await sharedPage.evaluate((ownId: number) => {
      window.__mockBrowser?.emitZoomChanged(1.5, ownId);
    }, MOCK_WEB_CONTENTS_ID);
    await expect.poll(() => zoomLabel.textContent(), { timeout: 5000 }).not.toBe(zoomBefore);

    // The guest was never torn down and rebuilt: exactly one register, no
    // unregister, and the id is unchanged throughout.
    const log = await sharedPage.evaluate(() => window.__mockBrowser?.getPaneCalls() ?? []);
    const registers = log.filter((call) => call.type === 'register');
    expect(registers).toHaveLength(1);
    expect(registers[0].type === 'register' && registers[0].input.webContentsId).toBe(MOCK_WEB_CONTENTS_ID);
    // Scoped to THIS guest's id on purpose. StrictMode double-invokes mount
    // effects, so the log also carries an unregister from the throwaway first
    // mount, which never registered and so passes `undefined`. What must never
    // appear is an unregister for the id that is actually driving the pane.
    expect(
      log.filter((call) => call.type === 'unregister' && call.webContentsId === MOCK_WEB_CONTENTS_ID),
    ).toHaveLength(0);
  });

  // Main binds a surface handle to the GUEST, and keeps it for as long as that
  // guest lives. A session rotation (`/clear` starts a new agent session for the
  // same task) changes the pane's `sessionId` prop but not its guest, so the
  // pane must re-register the same guest under the new owner and never
  // unregister it: an unregister would retire the handle an agent is holding
  // for a tab that never went anywhere.
  test('a session rotation re-registers the same guest under the new owner without unregistering it', async () => {
    await openBrowserPane(sharedPage);
    await sharedPage.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 5000 });

    await sharedPage.evaluate((webContentsId: number) => {
      const element = document.querySelector('[data-testid="browser-webview"]');
      if (!element) throw new Error('browser-webview element not found in DOM');
      const stub = element as HTMLElement & {
        getWebContentsId: () => number;
        getURL: () => string;
      };
      stub.getWebContentsId = () => webContentsId;
      stub.getURL = () => 'http://localhost:5173/';
      element.dispatchEvent(new Event('dom-ready'));
    }, MOCK_WEB_CONTENTS_ID);

    await expect.poll(
      () => sharedPage.evaluate((expectedId: number) => {
        const calls = window.__mockBrowser?.getPaneCalls() ?? [];
        return calls.some((call) => call.type === 'register' && call.input.webContentsId === expectedId);
      }, MOCK_WEB_CONTENTS_ID),
      { timeout: 5000 },
    ).toBe(true);

    // Rotate the task's session in the store, the way a `/clear` lands in the
    // renderer: the same task now has a different running session.
    const ROTATED_SESSION_ID = `${SESSION_ID}-rotated`;
    await sharedPage.evaluate(({ taskId, rotatedSessionId }) => {
      type MockSession = { id: string; taskId: string; status: string };
      const stores = (window as unknown as {
        __zustandStores: {
          session: {
            getState: () => { sessions: MockSession[] };
            setState: (partial: { sessions: MockSession[]; _sessionByTaskId: Map<string, MockSession> }) => void;
          };
        };
      }).__zustandStores;
      const sessions = stores.session.getState().sessions.map((candidate) =>
        candidate.taskId === taskId ? { ...candidate, id: rotatedSessionId } : candidate,
      );
      stores.session.setState({
        sessions,
        _sessionByTaskId: new Map(sessions.map((candidate) => [candidate.taskId, candidate])),
      });
    }, { taskId: TASK_ID, rotatedSessionId: ROTATED_SESSION_ID });

    // The same guest registers again under the new owner.
    await expect.poll(
      () => sharedPage.evaluate(({ rotatedSessionId, expectedId }) => {
        const calls = window.__mockBrowser?.getPaneCalls() ?? [];
        return calls.some((call) =>
          call.type === 'register' && call.input.sessionId === rotatedSessionId && call.input.webContentsId === expectedId,
        );
      }, { rotatedSessionId: ROTATED_SESSION_ID, expectedId: MOCK_WEB_CONTENTS_ID }),
      { timeout: 5000 },
    ).toBe(true);

    // Exactly one guest ever registered, and it was never unregistered.
    const log = await sharedPage.evaluate(() => window.__mockBrowser?.getPaneCalls() ?? []);
    const registeredGuestIds = new Set(
      log.filter((call) => call.type === 'register').map((call) => (call.type === 'register' ? call.input.webContentsId : -1)),
    );
    expect([...registeredGuestIds]).toEqual([MOCK_WEB_CONTENTS_ID]);
    expect(
      log.filter((call) => call.type === 'unregister' && call.webContentsId === MOCK_WEB_CONTENTS_ID),
    ).toHaveLength(0);
    // The webview element itself was not replaced either.
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
  });
});
