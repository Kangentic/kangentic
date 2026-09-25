/**
 * Hold-on-hide: putting the Browser pane away from the UI (the pill, or opening
 * Changes over it) while the task's agent is live keeps the pane MOUNTED and
 * hidden, so showing it again re-attaches the same guest.
 *
 * An Electron <webview> guest dies the instant its DOM node unmounts. Before
 * holding, the pill unmounted the pane, main handed the page off to a fresh
 * offscreen lane, and toggling the pill back built another fresh pane: a user
 * who hid the pane to see more terminal reset the agent's tab twice.
 *
 * What proves a hold is the same thing that proves parking and retention: the
 * registered webContentsId. A DOM-presence check cannot tell "survived" from
 * "silently replaced", so every assertion here reads the pane-call log and the
 * stores rather than Playwright visibility - an `opacity: 0` slot is VISIBLE to
 * `toBeVisible`.
 *
 * Fixture: a task with a RUNNING session and a seeded task URL, opened on the
 * board; the <webview> stub gets `getWebContentsId` injected and `dom-ready`
 * dispatched, exactly as browser-pane-registration.spec.ts does.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-hold';
const TASK_ID = 'task-browser-hold';
const SESSION_ID = 'sess-browser-hold';
const PROJECT_PATH = '/mock/browser-hold-test';
const MOCK_WEB_CONTENTS_ID = 6161;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Browser Hold Test',
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
      var id = 'lane-bh-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9995,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Browser Hold Task',
      description: 'Used to drive hold-on-hide',
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
  await sharedPage.goto(VITE_URL);
  await sharedPage.waitForLoadState('load');
  await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
  await sharedPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

/** The pane's open / held flags for the fixture task, as the session store sees them. */
async function paneFlags(page: Page): Promise<{ open: boolean; held: boolean }> {
  return page.evaluate((taskId: string) => {
    const stores = (window as unknown as {
      __zustandStores: { session: { getState: () => { browserOpenTasks: Set<string>; browserHeldTasks: Set<string> } } };
    }).__zustandStores;
    const state = stores.session.getState();
    return { open: state.browserOpenTasks.has(taskId), held: state.browserHeldTasks.has(taskId) };
  }, TASK_ID);
}

/** The board's task-detail window for the fixture task, as the window store sees it. */
async function taskWindow(page: Page): Promise<{ id: string; parked: boolean } | null> {
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

  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Browser Hold Task').first().click();
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

/** Hide the pane with its pill and wait for the held slot to take over. */
async function hidePaneWithPill(page: Page): Promise<void> {
  await page.locator('[data-testid="browser-toggle"]').click();
  await page.locator('[data-testid="task-detail-browser-held"]').waitFor({ state: 'attached', timeout: 5000 });
}

/** Flip the fixture session to exited in the store, the way the session-changed push lands. */
async function endSession(page: Page): Promise<void> {
  await page.evaluate((taskId: string) => {
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
}

test.describe('hold on hide', () => {
  test('hiding the pane with the pill keeps the guest mounted, hidden, with the terminal full width', async () => {
    await openRegisteredPane(sharedPage);
    await hidePaneWithPill(sharedPage);

    // The webview element was never unmounted, and its guest was never
    // unregistered: this is the assertion that separates "held" from "closed
    // and rebuilt".
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
    expect(await paneFlags(sharedPage)).toEqual({ open: false, held: true });

    // Hidden the retained way: inert and opacity 0, never visibility:hidden
    // (which would stop the guest compositing and hang a screenshot).
    const heldSlot = sharedPage.locator('[data-testid="task-detail-browser-held"]');
    await expect.poll(() => heldSlot.getAttribute('inert'), { timeout: 5000 }).not.toBeNull();
    expect(await heldSlot.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
    expect(await heldSlot.evaluate((element) => getComputedStyle(element).visibility)).toBe('visible');
    // At a real size, not collapsed: a zero-size guest stops compositing too.
    const heldBox = await heldSlot.boundingBox();
    expect(heldBox?.width ?? 0).toBeGreaterThan(50);
    expect(heldBox?.height ?? 0).toBeGreaterThan(50);

    // As far as the layout is concerned the pane is gone: no right panel, no
    // divider, so the terminal takes the whole row.
    await expect(sharedPage.locator('[data-testid="task-detail-right-panel"]')).toHaveCount(0);
    await expect(sharedPage.locator('[data-testid="task-detail-split-divider"]')).toHaveCount(0);
  });

  test('showing the pane again is the same guest', async () => {
    await openRegisteredPane(sharedPage);
    await hidePaneWithPill(sharedPage);

    await sharedPage.locator('[data-testid="browser-toggle"]').click();
    await sharedPage.locator('[data-testid="task-detail-right-panel"]').waitFor({ state: 'attached', timeout: 5000 });
    await expect(sharedPage.locator('[data-testid="task-detail-browser-held"]')).toHaveCount(0);
    expect(await paneFlags(sharedPage)).toEqual({ open: true, held: false });

    // Across the whole hide / show: exactly one guest registered, never
    // unregistered, and one webview element throughout.
    expect(await registersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(1);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
  });

  test('opening Changes over the pane holds it, and the two coexist in their own slots', async () => {
    await openRegisteredPane(sharedPage);

    // The right-panel views are mutually exclusive on screen, so Changes hides
    // the browser - which now means holding it, in a slot Changes never uses.
    await sharedPage.locator('[data-testid="changes-toggle"]').click();
    await sharedPage.locator('[data-testid="task-detail-browser-held"]').waitFor({ state: 'attached', timeout: 5000 });
    await expect(sharedPage.locator('[data-testid="task-detail-right-panel"]')).toHaveCount(1);
    expect(await paneFlags(sharedPage)).toEqual({ open: false, held: true });
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);

    // Bringing the browser back closes Changes and shows the same guest.
    await sharedPage.locator('[data-testid="browser-toggle"]').click();
    await expect(sharedPage.locator('[data-testid="task-detail-browser-held"]')).toHaveCount(0);
    await expect(sharedPage.locator('[data-testid="task-detail-right-panel"]')).toHaveCount(1);
    expect(await paneFlags(sharedPage)).toEqual({ open: true, held: false });
    expect(await registersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(1);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
  });

  test('closing the window with a held pane parks it, like a showing one', async () => {
    await openRegisteredPane(sharedPage);
    await hidePaneWithPill(sharedPage);

    await sharedPage.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    await expect.poll(async () => (await taskWindow(sharedPage))?.parked ?? false, { timeout: 5000 }).toBe(true);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
  });

  test('the hold ends when the session stops: the pane unmounts, the window stays', async () => {
    await openRegisteredPane(sharedPage);
    await hidePaneWithPill(sharedPage);

    await endSession(sharedPage);

    // Nothing left to keep the guest alive for: the reaper releases the hold,
    // the pane unmounts, and the guest is unregistered - but the window was
    // never closed, so it is still there, showing the exited face.
    await expect.poll(() => unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID), { timeout: 5000 }).toBe(1);
    await expect.poll(async () => (await paneFlags(sharedPage)).held, { timeout: 5000 }).toBe(false);
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(0);
    await expect(sharedPage.locator('[data-testid="task-detail-browser-held"]')).toHaveCount(0);
    expect(await taskWindow(sharedPage)).toMatchObject({ parked: false });
  });

  test("an agent's open_pane shows a held pane again: the same guest, now visible", async () => {
    await openRegisteredPane(sharedPage);
    await hidePaneWithPill(sharedPage);

    // Main's push for kangentic_browser_open_pane on a live-but-hidden pane
    // (the warm path pushes too, so the agent's "open" means "show"). The
    // bridge ends the hold; the pane's slot restyles, never remounts.
    await sharedPage.evaluate(({ projectId, taskId }) => {
      window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId);
    }, { projectId: PROJECT_ID, taskId: TASK_ID });

    await sharedPage.locator('[data-testid="task-detail-right-panel"]').waitFor({ state: 'attached', timeout: 5000 });
    await expect(sharedPage.locator('[data-testid="task-detail-browser-held"]')).toHaveCount(0);
    expect(await paneFlags(sharedPage)).toEqual({ open: true, held: false });
    expect(await registersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(1);
    expect(await unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID)).toBe(0);
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
    // The window was open all along, so no agent stamp lands on it.
    expect(await taskWindow(sharedPage)).toMatchObject({ parked: false });
  });

  test("an agent's close_pane discards a held pane", async () => {
    await openRegisteredPane(sharedPage);
    await hidePaneWithPill(sharedPage);

    // Main's push for kangentic_browser_close_pane: the agent asked for its tab
    // to go, so the hold must not keep it.
    await sharedPage.evaluate(({ projectId, taskId }) => {
      window.__mockBrowser?.emitPaneCloseRequest(projectId, [taskId]);
    }, { projectId: PROJECT_ID, taskId: TASK_ID });

    await expect.poll(() => unregistersFor(sharedPage, MOCK_WEB_CONTENTS_ID), { timeout: 5000 }).toBe(1);
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(0);
    expect(await paneFlags(sharedPage)).toEqual({ open: false, held: false });
  });
});
