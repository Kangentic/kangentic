/**
 * Park-on-close: closing a task-detail window whose Browser pane an agent is
 * driving keeps the pane's guest alive, and reopening the task re-attaches it.
 *
 * An Electron <webview> guest dies the instant its DOM node unmounts. Before
 * parking, closing the window destroyed the guest (main handed the page off to
 * a fresh offscreen lane) and reopening built another fresh pane, so per-tab
 * state (`sessionStorage`, in-memory app state) was lost twice per close. An
 * agent verifying an app whose auth lives in `sessionStorage` experienced that
 * as being logged out at random.
 *
 * What proves a park is the same thing that proves retention (see
 * browser-pane-registration.spec.ts): the registered webContentsId. A
 * DOM-presence check cannot tell "survived" from "silently replaced", so every
 * assertion here reads the pane-call log and the window store rather than
 * Playwright visibility - an `opacity: 0` frame is VISIBLE to `toBeVisible`.
 *
 * Fixture: a task with a RUNNING session and a seeded task URL, opened on the
 * board; the <webview> stub gets `getWebContentsId` injected and `dom-ready`
 * dispatched, exactly as the registration spec does.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-park';
const TASK_ID = 'task-browser-park';
const SESSION_ID = 'sess-browser-park';
const PROJECT_PATH = '/mock/browser-park-test';
const MOCK_WEB_CONTENTS_ID = 5151;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Browser Park Test',
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
      var id = 'lane-bp-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9996,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Browser Park Task',
      description: 'Used to drive park-on-close',
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

type ParkedWindowView = { id: string; parked: boolean; openedByAgent: boolean } | null;

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
  await sharedPage.goto(VITE_URL);
  await sharedPage.waitForLoadState('load');
  await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
  await sharedPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

/** The board's task-detail window for the fixture task, as the store sees it. */
async function taskWindow(page: Page): Promise<ParkedWindowView> {
  return page.evaluate((taskId: string) => {
    type StoreWindow = { id: string; kind: string; anchor: string; parked?: true; openedByAgent?: true };
    const stores = (window as unknown as {
      __zustandStores: { window: { getState: () => { windows: Record<string, StoreWindow> } } };
    }).__zustandStores;
    const match = Object.values(stores.window.getState().windows).find(
      (candidate) => candidate.kind === 'task-detail' && candidate.anchor === taskId,
    );
    return match ? { id: match.id, parked: match.parked === true, openedByAgent: match.openedByAgent === true } : null;
  }, TASK_ID);
}

async function sessionView(page: Page): Promise<{ detailTaskId: string | null; dialogSessionIds: string[] }> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { session: { getState: () => { detailTaskId: string | null; dialogSessionIds: string[] } } };
    }).__zustandStores;
    const state = stores.session.getState();
    return { detailTaskId: state.detailTaskId, dialogSessionIds: state.dialogSessionIds };
  });
}

function unregistersFor(page: Page, webContentsId: number): Promise<number> {
  return page.evaluate((id: number) => {
    const calls = window.__mockBrowser?.getPaneCalls() ?? [];
    return calls.filter((call) => call.type === 'unregister' && call.webContentsId === id).length;
  }, webContentsId);
}

function registersFor(page: Page, webContentsId: number): Promise<number> {
  return page.evaluate((id: number) => {
    const calls = window.__mockBrowser?.getPaneCalls() ?? [];
    return calls.filter((call) => call.type === 'register' && call.input.webContentsId === id).length;
  }, webContentsId);
}

/** Open the task, open its pane, attach the guest stub, and wait for the registration. */
async function openRegisteredPane(page: Page): Promise<void> {
  await page.evaluate((taskId: string) => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl(taskId, 'http://localhost:5173/');
  }, TASK_ID);

  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Browser Park Task').first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  const browserPane = page.locator('[data-testid="browser-pane"]');
  if (!(await browserPane.isVisible().catch(() => false))) {
    await page.locator('[data-testid="browser-toggle"]').click();
  }
  await browserPane.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 5000 });

  await page.evaluate((webContentsId: number) => {
    const element = document.querySelector('[data-testid="browser-webview"]');
    if (!element) throw new Error('browser-webview element not found in DOM');
    const stub = element as HTMLElement & { getWebContentsId: () => number; getURL: () => string };
    stub.getWebContentsId = () => webContentsId;
    stub.getURL = () => 'http://localhost:5173/';
    element.dispatchEvent(new Event('dom-ready'));
  }, MOCK_WEB_CONTENTS_ID);

  await expect.poll(() => registersFor(page, MOCK_WEB_CONTENTS_ID), { timeout: 5000 }).toBeGreaterThan(0);
}

/** Close the window the way a user does (Escape at document level), and wait for the park. */
async function closeWindowAndWaitForPark(page: Page): Promise<string> {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await taskWindow(page))?.parked ?? false, { timeout: 5000 }).toBe(true);
  const parked = await taskWindow(page);
  if (!parked) throw new Error('window vanished instead of parking');
  return parked.id;
}

test.describe('park on close', () => {
  test('closing the window parks it: the guest survives, hidden, with no unregister', async () => {
    await openRegisteredPane(sharedPage);
    const windowId = await closeWindowAndWaitForPark(sharedPage);

    // The webview element was never unmounted, and its guest was never
    // unregistered: this is the assertion that separates "parked" from
    // "closed and rebuilt".
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);

    // Hidden the retained way: inert and opacity 0, never visibility:hidden
    // (which would stop the guest compositing).
    const frame = sharedPage.locator(`[data-testid="window-frame-${windowId}"]`);
    await expect.poll(() => frame.getAttribute('inert'), { timeout: 5000 }).not.toBeNull();
    expect(await frame.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
    expect(await frame.evaluate((element) => getComputedStyle(element).visibility)).toBe('visible');

    // As far as the rest of the app is concerned, the window is closed: the
    // detail signal is clear (so the next card click re-fires), and the
    // session's terminal claim is released (so the bottom panel may show it).
    await expect.poll(async () => (await sessionView(sharedPage)).detailTaskId, { timeout: 5000 }).toBeNull();
    await expect.poll(async () => (await sessionView(sharedPage)).dialogSessionIds.includes(SESSION_ID), { timeout: 5000 }).toBe(false);
  });

  test('reopening the task un-parks the same window: same guest, terminal claim back', async () => {
    await openRegisteredPane(sharedPage);
    const windowId = await closeWindowAndWaitForPark(sharedPage);

    await sharedPage.locator('[data-swimlane-name="Code Review"]').locator('text=Browser Park Task').first().click();

    await expect.poll(async () => (await taskWindow(sharedPage))?.parked ?? true, { timeout: 5000 }).toBe(false);
    // The SAME window id, so the same DOM node, so the same guest.
    expect((await taskWindow(sharedPage))?.id).toBe(windowId);
    const frame = sharedPage.locator(`[data-testid="window-frame-${windowId}"]`);
    await expect.poll(() => frame.getAttribute('inert'), { timeout: 5000 }).toBeNull();
    expect(await frame.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    await expect.poll(async () => (await sessionView(sharedPage)).detailTaskId, { timeout: 5000 }).toBe(TASK_ID);
    await expect.poll(async () => (await sessionView(sharedPage)).dialogSessionIds.includes(SESSION_ID), { timeout: 5000 }).toBe(true);

    // Across the whole park / un-park: exactly one guest registered, never
    // unregistered, and one webview element throughout.
    expect(await registersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(1);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
    // A user's click un-parks with no agent stamp.
    expect((await taskWindow(sharedPage))?.openedByAgent).toBe(false);
  });

  test('a parked window is dropped for real once its session stops running', async () => {
    await openRegisteredPane(sharedPage);
    await closeWindowAndWaitForPark(sharedPage);

    await sharedPage.evaluate((taskId: string) => {
      // The window's reconcile-on-mount probe would otherwise heal the state
      // straight back to running, since the mock's PTY registry still has it.
      window.electronAPI.sessions.reconcile = async () => null;
      type MockSession = { taskId: string; status: string };
      const stores = (window as unknown as {
        __zustandStores: {
          session: {
            getState: () => { sessions: MockSession[] };
            setState: (partial: { sessions: MockSession[]; _sessionByTaskId: Map<string, MockSession> }) => void;
          };
        };
      }).__zustandStores;
      const sessions = stores.session.getState().sessions.map((candidate) =>
        candidate.taskId === taskId ? { ...candidate, status: 'exited' } : candidate,
      );
      stores.session.setState({
        sessions,
        _sessionByTaskId: new Map(sessions.map((candidate) => [candidate.taskId, candidate])),
      });
    }, TASK_ID);

    // Nothing left to keep the guest alive for: the reaper drops the window,
    // the pane unmounts, and the guest is unregistered.
    await expect.poll(() => unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID), { timeout: 5000 }).toBe(1);
    await expect.poll(() => taskWindow(sharedPage), { timeout: 5000 }).toBeNull();
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(0);
  });

  test('a parked window is dropped for real once its pane is put away', async () => {
    await openRegisteredPane(sharedPage);
    await closeWindowAndWaitForPark(sharedPage);

    // An agent's close_pane lands here (main's push clears the open flag), and
    // so does a hydration that reads the pane as closed.
    await sharedPage.evaluate((taskId: string) => {
      const stores = (window as unknown as {
        __zustandStores: { session: { getState: () => { setBrowserOpen: (id: string, open: boolean) => void } } };
      }).__zustandStores;
      stores.session.getState().setBrowserOpen(taskId, false);
    }, TASK_ID);

    await expect.poll(() => unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID), { timeout: 5000 }).toBe(1);
    await expect.poll(() => taskWindow(sharedPage), { timeout: 5000 }).toBeNull();
  });

  test("an agent's open_pane un-parks the window and keeps its agent stamp", async () => {
    await openRegisteredPane(sharedPage);
    const windowId = await closeWindowAndWaitForPark(sharedPage);

    // Main's push for kangentic_browser_open_pane. The bridge must not treat the
    // parked window as "already open" (it would set the pane flag and leave the
    // window hidden); it routes through the detail signal, and the existing-
    // window branch un-parks and RE-STAMPS after the raise, so the remounting
    // terminal cannot take the user's keyboard.
    await sharedPage.evaluate(({ projectId, taskId }) => {
      window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId);
    }, { projectId: PROJECT_ID, taskId: TASK_ID });

    await expect.poll(async () => (await taskWindow(sharedPage))?.parked ?? true, { timeout: 5000 }).toBe(false);
    expect((await taskWindow(sharedPage))?.id).toBe(windowId);
    expect((await taskWindow(sharedPage))?.openedByAgent).toBe(true);
    expect(await registersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(1);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
  });

  test('a window closed with the pane already discarded is removed, not parked', async () => {
    await openRegisteredPane(sharedPage);
    // An agent's close_pane discards the pane (the pill would only HOLD it, and
    // a held pane parks like a showing one: browser-pane-hold-on-hide.spec.ts).
    await sharedPage.evaluate(({ projectId, taskId }) => {
      window.__mockBrowser?.emitPaneCloseRequest(projectId, [taskId]);
    }, { projectId: PROJECT_ID, taskId: TASK_ID });
    await sharedPage.locator('[data-testid="browser-webview"]').waitFor({ state: 'detached', timeout: 5000 });

    await sharedPage.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    // Nothing to keep: an ordinary close.
    await expect.poll(() => taskWindow(sharedPage), { timeout: 5000 }).toBeNull();
  });
});
