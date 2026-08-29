/**
 * Close browser: the user's discard, distinct from the pill's hide.
 *
 * Hold-on-hide and park-on-close keep a task's Browser pane guest mounted for
 * as long as its agent session runs (~one renderer process per pane). Close is
 * the one user path that ends the guest while the session is live. Two things
 * must both happen, in order: main is told BEFORE the unmount that the close is
 * the user's (`closePaneByUser`, so the handle retires as `user-closed` and no
 * hand-off lane re-spends the memory), and the open flag clears WITHOUT a hold
 * (so the pane unmounts and the guest dies with it).
 *
 * The surfaces around it: the pane's bottom-bar control, the task kebab's
 * "Close browser" (the only reach while the pane is hidden), the pill's alive
 * dot (a guest is kept while hidden), the task card's globe (a guest is alive
 * in any state), and the visibility report the agent's list_panes reads.
 *
 * Every assertion reads the mock's pane-call log and the stores rather than
 * Playwright visibility: an `opacity: 0` slot is VISIBLE to `toBeVisible`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-close';
const TASK_ID = 'task-browser-close';
const SESSION_ID = 'sess-browser-close';
const PROJECT_PATH = '/mock/browser-close-test';
const MOCK_WEB_CONTENTS_ID = 7171;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Browser Close Test',
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
      var id = 'lane-bc-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9994,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Browser Close Task',
      description: 'Used to drive the Close browser control',
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

type PaneCall = NonNullable<Window['__mockBrowser']> extends { getPaneCalls: () => Array<infer Call> } ? Call : never;

function paneCalls(page: Page): Promise<PaneCall[]> {
  return page.evaluate(() => (window.__mockBrowser?.getPaneCalls() ?? []) as PaneCall[]);
}

async function callsOfType(page: Page, type: PaneCall['type'], webContentsId: number): Promise<PaneCall[]> {
  const calls = await paneCalls(page);
  return calls.filter((call) => {
    if (call.type !== type) return false;
    return call.type === 'register' ? call.input.webContentsId === webContentsId : call.webContentsId === webContentsId;
  });
}

/** The visibility values reported for the guest, in order. */
async function visibilityReports(page: Page, webContentsId: number): Promise<string[]> {
  const calls = await paneCalls(page);
  const reported: string[] = [];
  for (const call of calls) {
    if (call.type === 'register' && call.input.webContentsId === webContentsId && call.input.visibility) reported.push(call.input.visibility);
    if (call.type === 'visibility' && call.webContentsId === webContentsId) reported.push(call.visibility);
  }
  return reported;
}

async function paneFlags(page: Page): Promise<{ open: boolean; held: boolean; guest: number | null }> {
  return page.evaluate((taskId: string) => {
    const stores = (window as unknown as {
      __zustandStores: { session: { getState: () => { browserOpenTasks: Set<string>; browserHeldTasks: Set<string>; browserGuestTasks: Map<string, number> } } };
    }).__zustandStores;
    const state = stores.session.getState();
    return {
      open: state.browserOpenTasks.has(taskId),
      held: state.browserHeldTasks.has(taskId),
      guest: state.browserGuestTasks.get(taskId) ?? null,
    };
  }, TASK_ID);
}

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

/** Open the task, open its pane, attach the guest stub, and wait for the registration. */
async function openRegisteredPane(page: Page): Promise<void> {
  await page.evaluate((taskId: string) => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl(taskId, 'http://localhost:5173/');
  }, TASK_ID);

  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Browser Close Task').first().click();
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

  await expect.poll(async () => (await callsOfType(page, 'register', MOCK_WEB_CONTENTS_ID)).length, { timeout: 5000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await paneFlags(page)).guest, { timeout: 5000 }).toBe(MOCK_WEB_CONTENTS_ID);
}

test.describe('Close browser', () => {
  test('the pane control closes deliberately: main is told first, then the guest unmounts with no hold', async () => {
    await openRegisteredPane(sharedPage);
    // Both indicators say a browser guest is running for the task, whether
    // the pane is on screen or not.
    await expect(sharedPage.locator('[data-testid="task-card-browser-alive"]')).toHaveCount(1);
    await expect(sharedPage.locator('[data-testid="browser-toggle-alive"]')).toHaveCount(1);

    await sharedPage.locator('[data-testid="browser-close"]').click();

    await expect.poll(async () => (await callsOfType(sharedPage, 'user-close', MOCK_WEB_CONTENTS_ID)).length, { timeout: 5000 }).toBe(1);
    await sharedPage.locator('[data-testid="browser-webview"]').waitFor({ state: 'detached', timeout: 5000 });
    // A discard, not a hide: nothing is kept.
    expect(await paneFlags(sharedPage)).toEqual({ open: false, held: false, guest: null });
    await expect(sharedPage.locator('[data-testid="task-detail-browser-held"]')).toHaveCount(0);
    // The user-close reached main BEFORE the unmount's own unregister.
    const calls = await paneCalls(sharedPage);
    const userCloseIndex = calls.findIndex((call) => call.type === 'user-close' && call.webContentsId === MOCK_WEB_CONTENTS_ID);
    const unregisterIndex = calls.findIndex((call) => call.type === 'unregister' && call.webContentsId === MOCK_WEB_CONTENTS_ID);
    expect(userCloseIndex).toBeGreaterThanOrEqual(0);
    expect(unregisterIndex).toBeGreaterThan(userCloseIndex);
    // Nothing alive to indicate any more, and the window itself stays open.
    await expect(sharedPage.locator('[data-testid="task-card-browser-alive"]')).toHaveCount(0);
    expect(await taskWindow(sharedPage)).toMatchObject({ parked: false });
  });

  test('hiding with the pill shows the alive dot and reports hidden; the kebab closes a pane the user cannot see', async () => {
    await openRegisteredPane(sharedPage);

    await sharedPage.locator('[data-testid="browser-toggle"]').click();
    await sharedPage.locator('[data-testid="task-detail-browser-held"]').waitFor({ state: 'attached', timeout: 5000 });
    // The running dot stays while the guest is kept behind the toggle; no
    // agent is driving it in this fixture.
    const dot = sharedPage.locator('[data-testid="browser-toggle-alive"]');
    await expect(dot).toHaveCount(1);
    expect(await dot.getAttribute('data-driving')).toBeNull();
    await expect.poll(() => visibilityReports(sharedPage, MOCK_WEB_CONTENTS_ID), { timeout: 5000 }).toEqual(['showing', 'hidden']);

    // The pane's own control is unreachable now; the kebab is the reach.
    await sharedPage.locator('[data-testid="task-detail-dialog"] button[title="Actions"]').first().click();
    await sharedPage.locator('[data-testid="kebab-close-browser"]').click();

    await expect.poll(async () => (await callsOfType(sharedPage, 'user-close', MOCK_WEB_CONTENTS_ID)).length, { timeout: 5000 }).toBe(1);
    await sharedPage.locator('[data-testid="browser-webview"]').waitFor({ state: 'detached', timeout: 5000 });
    expect(await paneFlags(sharedPage)).toEqual({ open: false, held: false, guest: null });
    await expect(dot).toHaveCount(0);
    await expect(sharedPage.locator('[data-testid="task-card-browser-alive"]')).toHaveCount(0);
  });

  test('showing a hidden pane again reports showing, on the same guest', async () => {
    await openRegisteredPane(sharedPage);
    await sharedPage.locator('[data-testid="browser-toggle"]').click();
    await sharedPage.locator('[data-testid="task-detail-browser-held"]').waitFor({ state: 'attached', timeout: 5000 });
    await sharedPage.locator('[data-testid="browser-toggle"]').click();
    await sharedPage.locator('[data-testid="task-detail-right-panel"]').waitFor({ state: 'attached', timeout: 5000 });

    await expect.poll(() => visibilityReports(sharedPage, MOCK_WEB_CONTENTS_ID), { timeout: 5000 }).toEqual(['showing', 'hidden', 'showing']);
    expect((await callsOfType(sharedPage, 'register', MOCK_WEB_CONTENTS_ID)).length).toBe(1);
    expect((await callsOfType(sharedPage, 'unregister', MOCK_WEB_CONTENTS_ID)).length).toBe(0);
    // Still the same running guest, so the dot stays.
    await expect(sharedPage.locator('[data-testid="browser-toggle-alive"]')).toHaveCount(1);
  });

  test('closing the window reports parked, and the card still shows the guest is alive', async () => {
    await openRegisteredPane(sharedPage);
    await sharedPage.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await taskWindow(sharedPage))?.parked ?? false, { timeout: 5000 }).toBe(true);

    await expect.poll(() => visibilityReports(sharedPage, MOCK_WEB_CONTENTS_ID), { timeout: 5000 }).toEqual(['showing', 'parked']);
    // Parked is the one state with no pill on screen: the card is the indicator.
    await expect(sharedPage.locator('[data-testid="task-card-browser-alive"]')).toHaveCount(1);
    expect((await callsOfType(sharedPage, 'user-close', MOCK_WEB_CONTENTS_ID)).length).toBe(0);
  });

  test('the card carries a solid green globe; only the always-rendered pill needs a running dot', async () => {
    await openRegisteredPane(sharedPage);
    // The card's globe renders ONLY while a guest is running, so its presence
    // is the signal and it needs no dot (a smudge at 12px). The pill is always
    // rendered, so it carries the green dot to say a guest is behind it.
    const globe = sharedPage.locator('[data-testid="task-card-browser-alive"]');
    const pillDot = sharedPage.locator('[data-testid="browser-toggle-alive"]');
    await expect(globe).toHaveCount(1);
    await expect(globe).toHaveClass(/text-active/);
    await expect(sharedPage.locator('[data-testid="task-card-browser-running-dot"]')).toHaveCount(0);
    await expect(pillDot).toHaveClass(/bg-active/);
    // Solid, never pulsing: a running guest is a steady fact, and a pulse on
    // every such card is motion the board does not need.
    await expect(globe).not.toHaveClass(/animate-pulse/);

    // A drive changes neither mark (the pane shows driving); nor does its end.
    await sharedPage.evaluate((webContentsId: number) => {
      window.__mockBrowser?.emitAgentInput(webContentsId, true);
    }, MOCK_WEB_CONTENTS_ID);
    await expect(globe).toHaveClass(/text-active/);
    await sharedPage.evaluate((webContentsId: number) => {
      window.__mockBrowser?.emitAgentInput(webContentsId, false);
    }, MOCK_WEB_CONTENTS_ID);
    await expect(globe).toHaveCount(1);
  });
});
