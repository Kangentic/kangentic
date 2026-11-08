/**
 * Terminal links in a task window and in the bottom panel. The Command Terminal's
 * cases live in terminal-link-click.spec.ts; these pin the two other hosts. A task
 * window offers its Kangentic browser, so a link's tip lists both clicks and a
 * Ctrl+Shift+click shows the window's pane on the link. The bottom panel has no pane
 * beside it, so its tip has one row and either click opens the default browser.
 *
 * Fixture: a task in Code Review with a running session, as browser-pane-hold-on-hide
 * builds it. The pane's <webview> is an unknown element here, so the test reads the
 * address bar and the element's src rather than a page.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { chromium, type Browser } from '@playwright/test';
import path from 'node:path';
import { fireSessionData, gotoVite, markSessionFirstOutput, waitForViteReady, writtenToSession } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-link-task-window';
const TASK_ID = 'task-link-window';
const SESSION_ID = 'sess-link-window';
const PROJECT_PATH = '/mock/link-task-window';
const URL_TEXT = 'http://localhost:5173/signup';
const DEVICE_ATTRIBUTES_QUERY = '\x1b[c';
const DEVICE_ATTRIBUTES_REPLY = /\x1b\[\?[\d;]+c/gu;

const PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Link Task Window', path: '${PROJECT_PATH}',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-ltw-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9996,
      status: 'running', shell: 'bash', cwd: '${PROJECT_PATH}', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Link Window Task', description: 'Terminal links',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: null, branch_name: null, pr_number: null, pr_url: null, base_branch: 'main',
      archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let sharedBrowser: Browser;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

async function openBoard(): Promise<Page> {
  const context = await sharedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRECONFIG);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
  // The mock writes nothing to a terminal, so lift the launch overlay that holds its output back.
  await markSessionFirstOutput(page, SESSION_ID);
  return page;
}

function countFences(written: string): number {
  return [...written.matchAll(DEVICE_ATTRIBUTES_REPLY)].length;
}

/** Draw the link on the first row once the terminal parses, fenced by a device-attributes reply. */
async function drawFirstRow(page: Page, text: string): Promise<void> {
  await expect.poll(async () => {
    await fireSessionData(page, SESSION_ID, DEVICE_ATTRIBUTES_QUERY);
    return countFences(await writtenToSession(page, SESSION_ID));
  }, { timeout: 10000, intervals: [250] }).toBeGreaterThan(0);
  const fencesBefore = countFences(await writtenToSession(page, SESSION_ID));
  await fireSessionData(page, SESSION_ID, `\x1b[2J\x1b[1;1H${text}${DEVICE_ATTRIBUTES_QUERY}`);
  await expect.poll(async () => countFences(await writtenToSession(page, SESSION_ID)), { timeout: 5000 })
    .toBeGreaterThan(fencesBefore);
}

async function hoverFirstRow(page: Page, screen: Locator): Promise<void> {
  const box = (await screen.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 6);
  await page.mouse.move(box.x + 42, box.y + 6);
  await expect(screen).toHaveClass(/xterm-cursor-pointer/u, { timeout: 5000 });
}

async function ctrlShiftClick(page: Page): Promise<void> {
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
}

function openedExternally(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __openedExternalUrls?: string[] }).__openedExternalUrls ?? []);
}

test('a task window\'s terminal lists both clicks, and Ctrl+Shift+click shows its Kangentic browser on the link', async () => {
  const page = await openBoard();
  try {
    await page.locator('[data-swimlane-name="Code Review"]').locator('text=Link Window Task').first().click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.locator('[data-testid="browser-pane"]')).toHaveCount(0);

    await drawFirstRow(page, URL_TEXT);
    const screen = dialog.locator('.xterm-screen').first();
    await hoverFirstRow(page, screen);
    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in default browser', 'Open in Kangentic browser']);

    await ctrlShiftClick(page);

    await expect(page.getByTestId('browser-url-input')).toHaveValue(URL_TEXT, { timeout: 10000 });
    await expect(page.getByTestId('browser-webview')).toHaveAttribute('src', URL_TEXT);
    expect(await openedExternally(page)).toEqual([]);
  } finally {
    await page.context().close();
  }
});

const OTHER_URL_TEXT = 'http://localhost:5173/login';
const BROWSER_POP_OUT_KEY = `browser:${PROJECT_ID}:${TASK_ID}`;

type SessionStoreProbe = {
  __zustandStores: {
    session: {
      getState: () => {
        browserOpenTasks: Set<string>;
        browserHeldTasks: Set<string>;
        browserNavigateRequests?: Record<string, { id: number; url: string }>;
      };
    };
  };
};

function pendingNavigateRequest(page: Page): Promise<{ id: number; url: string } | null> {
  return page.evaluate((taskId) => (window as unknown as SessionStoreProbe).__zustandStores.session.getState().browserNavigateRequests?.[taskId] ?? null, TASK_ID);
}

function paneFlags(page: Page): Promise<{ open: boolean; held: boolean }> {
  return page.evaluate((taskId) => {
    const state = (window as unknown as SessionStoreProbe).__zustandStores.session.getState();
    return { open: state.browserOpenTasks.has(taskId), held: state.browserHeldTasks.has(taskId) };
  }, TASK_ID);
}

async function openTaskDialog(page: Page): Promise<Locator> {
  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Link Window Task').first().click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  return dialog;
}

/** Off the link and back: xterm looks for a link only when the pointer enters a new cell. */
async function hoverFirstRowAgain(page: Page, screen: Locator): Promise<void> {
  const box = (await screen.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height - 10);
  await hoverFirstRow(page, screen);
}

/** The guest attaches: a <webview> is an unknown element here, so stub what the pane calls. */
async function stubWebview(page: Page): Promise<void> {
  await page.evaluate(() => {
    const element = document.querySelector('[data-testid="browser-webview"]') as HTMLElement & Record<string, unknown>;
    (window as unknown as { __webviewLoads: string[] }).__webviewLoads = [];
    element.getWebContentsId = () => 6161;
    element.getURL = () => 'http://localhost:5173/';
    element.loadURL = (url: string) => { (window as unknown as { __webviewLoads: string[] }).__webviewLoads.push(url); return Promise.resolve(); };
  });
}

function webviewLoads(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __webviewLoads?: string[] }).__webviewLoads ?? []);
}

test('with the task\'s Browser popped out, the tip has one row and Ctrl+Shift+click opens the default browser, with no request for the pane', async () => {
  const page = await openBoard();
  try {
    // The pop-out's renderer keeps its own store, so this window must not drive a pane it cannot reach.
    await page.evaluate((key) => (window as unknown as { __mockFirePopOutChanged: (keys: string[]) => void }).__mockFirePopOutChanged([key]), BROWSER_POP_OUT_KEY);
    const dialog = await openTaskDialog(page);

    await drawFirstRow(page, URL_TEXT);
    const screen = dialog.locator('.xterm-screen').first();
    await hoverFirstRow(page, screen);
    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in default browser']);

    await ctrlShiftClick(page);

    await expect.poll(() => openedExternally(page)).toEqual([URL_TEXT]);
    expect(await pendingNavigateRequest(page)).toBeNull();
    await expect(page.getByTestId('browser-webview')).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test('a second Ctrl+Shift+click with the pane already showing keeps it open and loads the link through its page', async () => {
  const page = await openBoard();
  try {
    const dialog = await openTaskDialog(page);
    await drawFirstRow(page, URL_TEXT);
    const screen = dialog.locator('.xterm-screen').first();
    await hoverFirstRow(page, screen);
    await ctrlShiftClick(page);
    const webview = page.getByTestId('browser-webview');
    await expect(webview).toHaveAttribute('src', URL_TEXT, { timeout: 10000 });
    await stubWebview(page);
    await page.evaluate(() => document.querySelector('[data-testid="browser-webview"]')!.dispatchEvent(new Event('dom-ready')));
    await expect.poll(() => paneFlags(page)).toEqual({ open: true, held: false });

    await drawFirstRow(page, OTHER_URL_TEXT);
    await hoverFirstRowAgain(page, screen);
    await ctrlShiftClick(page);

    await expect.poll(() => webviewLoads(page)).toEqual([OTHER_URL_TEXT]);
    // The pill's toggle would have held the showing pane away.
    expect(await paneFlags(page)).toEqual({ open: true, held: false });
    await expect(webview).toHaveCount(1);
  } finally {
    await page.context().close();
  }
});

test('a link click with Changes open puts Changes away and shows the Browser pane', async () => {
  const page = await openBoard();
  try {
    const dialog = await openTaskDialog(page);
    await page.locator('[data-testid="changes-toggle"]').click();
    await expect.poll(() => page.evaluate((taskId) => (window as unknown as { __zustandStores: { session: { getState: () => { changesOpenTasks: Set<string> } } } }).__zustandStores.session.getState().changesOpenTasks.has(taskId), TASK_ID)).toBe(true);

    await drawFirstRow(page, URL_TEXT);
    const screen = dialog.locator('.xterm-screen').first();
    await hoverFirstRow(page, screen);
    await ctrlShiftClick(page);

    await expect(page.getByTestId('browser-webview')).toHaveAttribute('src', URL_TEXT, { timeout: 10000 });
    await expect.poll(() => page.evaluate((taskId) => (window as unknown as { __zustandStores: { session: { getState: () => { changesOpenTasks: Set<string> } } } }).__zustandStores.session.getState().changesOpenTasks.has(taskId), TASK_ID)).toBe(false);
  } finally {
    await page.context().close();
  }
});

test('a request made before the pane\'s first dom-ready waits, and loads once the page is ready', async () => {
  const page = await openBoard();
  try {
    await page.evaluate((taskId) => (window as unknown as { __mockBrowser: { seedTaskUrl: (id: string, url: string) => void } }).__mockBrowser.seedTaskUrl(taskId, 'http://localhost:5173/'), TASK_ID);
    await openTaskDialog(page);
    await page.locator('[data-testid="browser-toggle"]').click();
    await expect(page.getByTestId('browser-webview')).toHaveCount(1, { timeout: 10000 });
    await stubWebview(page);

    // One evaluate: the request and two frames for the pane's effect to run, well inside the
    // pane's own 2.5s cover fallback, which would also count as ready.
    await page.evaluate(async ({ taskId, url }) => {
      (window as unknown as { __zustandStores: { session: { getState: () => { requestBrowserNavigate: (id: string, target: string) => void } } } }).__zustandStores.session.getState().requestBrowserNavigate(taskId, url);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, { taskId: TASK_ID, url: OTHER_URL_TEXT });
    expect(await webviewLoads(page)).toEqual([]);
    expect((await pendingNavigateRequest(page))?.url).toBe(OTHER_URL_TEXT);

    await page.evaluate(() => document.querySelector('[data-testid="browser-webview"]')!.dispatchEvent(new Event('dom-ready')));

    await expect.poll(() => webviewLoads(page)).toEqual([OTHER_URL_TEXT]);
    await expect.poll(() => pendingNavigateRequest(page)).toBeNull();
  } finally {
    await page.context().close();
  }
});

test('a clicked link is the first page of a task whose pane was closed and has a saved URL', async () => {
  const page = await openBoard();
  try {
    await page.evaluate((taskId) => (window as unknown as { __mockBrowser: { seedTaskUrl: (id: string, url: string) => void } }).__mockBrowser.seedTaskUrl(taskId, 'http://localhost:5173/saved'), TASK_ID);
    const dialog = await openTaskDialog(page);
    await expect(page.getByTestId('browser-pane')).toHaveCount(0);

    await drawFirstRow(page, URL_TEXT);
    await hoverFirstRow(page, dialog.locator('.xterm-screen').first());
    await ctrlShiftClick(page);

    await expect(page.getByTestId('browser-url-input')).toHaveValue(URL_TEXT, { timeout: 10000 });
    await expect(page.getByTestId('browser-webview')).toHaveAttribute('src', URL_TEXT);
  } finally {
    await page.context().close();
  }
});

test('with no Kangentic browser beside the terminal, an OSC 8 link whose text is not its URL stacks its destination over one row', async () => {
  const page = await openBoard();
  try {
    const pane = page.getByTestId('terminal-session-pane').first();
    await pane.waitFor({ state: 'visible', timeout: 10000 });
    await drawFirstRow(page, `\x1b]8;;${URL_TEXT}\x1b\\canvas\x1b]8;;\x1b\\`);
    await hoverFirstRow(page, pane.locator('.xterm-screen').first());

    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip).toHaveAttribute('data-shape', 'stack');
    await expect(tip.locator('[data-tooltip-part="destination"]')).toHaveText(URL_TEXT);
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in default browser']);
  } finally {
    await page.context().close();
  }
});

test('the bottom panel has no Kangentic browser, so its tip has one row and Ctrl+Shift+click opens the default browser', async () => {
  const page = await openBoard();
  try {
    const pane = page.getByTestId('terminal-session-pane').first();
    await pane.waitFor({ state: 'visible', timeout: 10000 });
    await drawFirstRow(page, URL_TEXT);
    const screen = pane.locator('.xterm-screen').first();
    await hoverFirstRow(page, screen);
    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in default browser']);

    await ctrlShiftClick(page);

    await expect.poll(() => openedExternally(page)).toEqual([URL_TEXT]);
    await expect(page.getByTestId('browser-webview')).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
