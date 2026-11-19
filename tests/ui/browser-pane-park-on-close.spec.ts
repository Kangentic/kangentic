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
import { waitForViteReady, gotoVite, openContextMenuOn } from './helpers';

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

type ParkedWindowView = { id: string; parked: boolean } | null;

let sharedBrowser: Browser;
let sharedPage: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({ headless: true });
  const context = await sharedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  sharedPage = await context.newPage();
  await sharedPage.addInitScript({ path: MOCK_SCRIPT });
  await sharedPage.addInitScript(preConfig);
  await gotoVite(sharedPage, VITE_URL);
  await sharedPage.waitForLoadState('load');
  await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
  await sharedPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

test.beforeEach(async () => {
  await gotoVite(sharedPage, VITE_URL);
  await sharedPage.waitForLoadState('load');
  await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
  await sharedPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

/** The board's task-detail window for the fixture task, as the store sees it. */
async function taskWindow(page: Page): Promise<ParkedWindowView> {
  return page.evaluate((taskId: string) => {
    type StoreWindow = { id: string; kind: string; anchor: string; parked?: true };
    const stores = (window as unknown as {
      __zustandStores: { window: { getState: () => { windows: Record<string, StoreWindow> } } };
    }).__zustandStores;
    const match = Object.values(stores.window.getState().windows).find(
      (candidate) => candidate.kind === 'task-detail' && candidate.anchor === taskId,
    );
    return match ? { id: match.id, parked: match.parked === true } : null;
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

/**
 * Open the fixture card's menu and choose Edit. The menu is opened on the card
 * itself, because the task's own window can sit over the card.
 */
async function editFromCardMenu(page: Page): Promise<void> {
  await openContextMenuOn(page.locator('[data-swimlane-name="Code Review"]').locator('text=Browser Park Task').first());
  await page.locator('[data-testid="context-edit-task"]').click();
}

async function showBacklog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { board: { getState: () => { setActiveView: (view: string) => void } } };
    }).__zustandStores;
    stores.board.getState().setActiveView('backlog');
  });
  await expect(page.locator('[data-testid="window-overlay"]')).toHaveAttribute('inert', '');
}

async function expectGuestComposites(page: Page): Promise<void> {
  const guest = page.locator('[data-testid="browser-webview"]');
  await expect(guest).toHaveCount(1);
  expect(await guest.evaluate((element) => getComputedStyle(element).visibility)).toBe('visible');
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
  });

  // The card menu's Edit asks to open the task on its edit form. A window that
  // request creates starts there, but a task that already has a window gets it
  // focused or un-parked instead, and the Edit used to be dropped on the way:
  // nothing happened with the window open, and a parked one came back showing
  // its terminal. A window closed with its pane live is always parked, so with
  // a Browser pane open Edit never worked. Both cases read red with
  // TaskDetailWindow's `taskEditRequest` subscription doing nothing.
  test('Edit from the card menu shows the edit form in a window that is already open', async () => {
    await openRegisteredPane(sharedPage);
    const editForm = sharedPage.locator('[data-testid="task-detail-edit-scroll"]');
    await expect(editForm).toHaveCount(0);

    await editFromCardMenu(sharedPage);
    await expect(editForm).toBeVisible({ timeout: 5000 });

    // A second Edit is a new request, not the same state set twice.
    await sharedPage.locator('[data-testid="task-detail-dialog"]').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editForm).toHaveCount(0);
    await editFromCardMenu(sharedPage);
    await expect(editForm).toBeVisible({ timeout: 5000 });
  });

  test('Edit from the card menu brings a parked window back on its edit form', async () => {
    await openRegisteredPane(sharedPage);
    await closeWindowAndWaitForPark(sharedPage);

    await editFromCardMenu(sharedPage);

    // Read from the store: a parked frame is still "visible" to Playwright.
    await expect.poll(async () => (await taskWindow(sharedPage))?.parked ?? true, { timeout: 5000 }).toBe(false);
    await expect(sharedPage.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible({ timeout: 5000 });
  });

  // The edit form used to replace the window's body, so opening it unmounted a
  // live pane and destroyed its guest, and closing it built a fresh one: the
  // loss parking exists to prevent, by another door. The body now stays mounted
  // under the form while a guest is registered. Both cases read red with
  // TaskDetailWindow's `bodyConcealed` forced false: the guest is unregistered
  // the moment the form opens.
  test('the edit form keeps a live pane mounted: the same guest going in and coming back', async () => {
    await openRegisteredPane(sharedPage);
    const editForm = sharedPage.locator('[data-testid="task-detail-edit-scroll"]');
    const bodySlot = sharedPage.locator('[data-testid="task-detail-body-slot"]');
    const bodyTerminal = bodySlot.locator('[data-testid="terminal-tab-container"]');
    const lastReportedVisibility = (): Promise<string | null> => sharedPage.evaluate((webContentsId: number) => {
      const calls = window.__mockBrowser?.getPaneCalls() ?? [];
      // The registration carries the visibility current at that moment, and a
      // `visibility` call reports every change after it.
      let latest: string | null = null;
      for (const call of calls) {
        if (call.type === 'register' && call.input.webContentsId === webContentsId) latest = String(call.input.visibility);
        if (call.type === 'visibility' && call.webContentsId === webContentsId) latest = String(call.visibility);
      }
      return latest;
    }, MOCK_WEB_CONTENTS_ID);

    // Before the form: the body's terminal is up and the pane reports showing.
    await expect(bodyTerminal).toHaveCount(1);
    await expect.poll(lastReportedVisibility, { timeout: 5000 }).toBe('showing');

    await editFromCardMenu(sharedPage);
    await expect(editForm).toBeVisible({ timeout: 5000 });
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
    // Under the form the pane tells main it is hidden, and the body's terminal is down.
    await expect.poll(lastReportedVisibility, { timeout: 5000 }).toBe('hidden');
    await expect(bodyTerminal).toHaveCount(0);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
    // Hidden the retained way, at its full size, so the guest keeps compositing.
    await expect(bodySlot).toHaveAttribute('inert', '');
    expect(await bodySlot.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
    await expectGuestComposites(sharedPage);
    const hiddenBox = await sharedPage.locator('[data-testid="browser-webview"]').boundingBox();
    expect(hiddenBox?.width ?? 0).toBeGreaterThan(0);
    expect(hiddenBox?.height ?? 0).toBeGreaterThan(0);

    await sharedPage.locator('[data-testid="task-detail-dialog"]').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editForm).toHaveCount(0);
    await expect(bodySlot).not.toHaveAttribute('inert', '');
    await expect.poll(lastReportedVisibility, { timeout: 5000 }).toBe('showing');
    await expect(bodyTerminal).toHaveCount(1);
    expect(await registersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(1);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
  });

  // With the pane kept under the form, closing from the form parks the window,
  // and its edit state would ride along. The next plain open has to show the
  // terminal view, not the form the user closed. Red with the window's
  // leave-the-form-on-park step removed: the reopened window is still editing.
  test('a window closed from its edit form reopens on its view, with the same guest', async () => {
    await openRegisteredPane(sharedPage);
    await editFromCardMenu(sharedPage);
    const editForm = sharedPage.locator('[data-testid="task-detail-edit-scroll"]');
    await expect(editForm).toBeVisible({ timeout: 5000 });

    await sharedPage.locator('[data-testid="task-detail-close"]').click();
    await expect.poll(async () => (await taskWindow(sharedPage))?.parked ?? false, { timeout: 5000 }).toBe(true);

    await sharedPage.locator('[data-swimlane-name="Code Review"]').locator('text=Browser Park Task').first().click();
    await expect.poll(async () => (await taskWindow(sharedPage))?.parked ?? true, { timeout: 5000 }).toBe(false);
    await expect(editForm).toHaveCount(0);
    await expect(sharedPage.locator('[data-testid="task-detail-body-slot"]')).not.toHaveAttribute('inert', '');
    expect(await registersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(1);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
  });

  // The Backlog view hides the board's overlay. `visibility: hidden` stops a guest
  // compositing, and a live agent's screenshot failed there until its bound, so
  // the guest has to compute `visible` whichever way the window is hidden.
  test('a parked pane keeps compositing under the Backlog view', async () => {
    await openRegisteredPane(sharedPage);
    await closeWindowAndWaitForPark(sharedPage);
    await showBacklog(sharedPage);
    await expectGuestComposites(sharedPage);
  });

  test('a pane in a window left open keeps compositing under the Backlog view', async () => {
    await openRegisteredPane(sharedPage);
    await showBacklog(sharedPage);
    await expectGuestComposites(sharedPage);
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

  test("an agent's open_pane leaves a window the user closed parked", async () => {
    await openRegisteredPane(sharedPage);
    const windowId = await closeWindowAndWaitForPark(sharedPage);

    // Main's push for kangentic_browser_open_pane, sent on every warm call. The
    // user closed this window on purpose, so it stays closed however many times
    // the agent calls, and the same guest goes on running in it.
    for (let call = 0; call < 2; call++) {
      await sharedPage.evaluate(({ projectId, taskId }) => {
        window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId);
      }, { projectId: PROJECT_ID, taskId: TASK_ID });
    }

    expect(await taskWindow(sharedPage)).toEqual({ id: windowId, parked: true });
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
