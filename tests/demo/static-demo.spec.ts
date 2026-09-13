/**
 * Smoke tier for the static web build of the desktop renderer.
 *
 * `npm run build:demo` writes dist/demo/; demo/boot.js documents the URL contract this spec
 * drives (view, state, theme, embed, still) and the two outcomes it stamps on <html>:
 * `data-demo-ready="1"` plus `data-demo-scene` on success, or a `[data-testid="demo-error"]`
 * card with nothing stamped when the scene cannot boot.
 *
 * The build is served by demo/static-server.mjs on an ephemeral port, started once per worker
 * in beforeAll. It is deliberately NOT a playwright.config.ts `webServer` entry: that block starts
 * for every project filter, and a dist/demo entry there would break the ui tier whenever the demo
 * build is absent. Absent here, startDemoServer throws an error naming `npm run build:demo` and
 * every test in the file fails with that message.
 *
 * Every test owns its own page (the built-in fixture), so nothing leaks between cases.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { startDemoServer } from '../../demo/static-server.mjs';
import { isBenignRendererError } from '../ui/helpers';
import { SCENES } from '../captures/scenes';
import { DEMO_LANES_BY_PROJECT, DEMO_SESSIONS, PROJECT_CONTOSO } from '../captures/helpers/demo-dataset';

const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist', 'demo');

/** demo/boot.js gives itself 10s to reach the reveal; the cold module load rides on top of that. */
const READY_TIMEOUT_MS = 20_000;

/** The opening project's columns, in board order, straight from the sample install. */
const SWIMLANE_NAMES = DEMO_LANES_BY_PROJECT[PROJECT_CONTOSO].map((lane) => lane.name);

/** Every session in the sample install is a Monitor row, whichever project it belongs to. */
const MONITOR_ROW_COUNT = DEMO_SESSIONS.length;

type DemoServer = Awaited<ReturnType<typeof startDemoServer>>;

interface DemoBootGlobal {
  __demoBoot?: { sceneName: string | null };
}

let server: DemoServer;

// The site frame's size, which every terminal recording was made for (demo/README.md,
// geometry): the task-detail window geometry in the scenes is fractional, so this is what
// gives the window its recorded 154 by 37 grid, and it is wide enough for the Changes panel's
// file tree and split diff to lay out side by side.
test.use({ viewport: { width: 1600, height: 1000 } });

test.beforeAll(async () => {
  server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
});

test.afterAll(async () => {
  if (server) await server.close();
});

function demoUrl(params: Record<string, string>): string {
  const url = new URL(server.url);
  // Opened directly the page hands over to the stage host (its own case below); this tier drives
  // the frame itself, at the frame size the project's viewport pins.
  url.searchParams.set('stage', '0');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Attach console-error and pageerror collectors that drop the known-benign renderer errors.
 * Returns a getter for what remains. Attach BEFORE navigating so the whole boot is covered.
 */
function collectUnexpectedErrors(page: Page): () => string[] {
  const unexpected: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error' || isBenignRendererError(message.text())) return;
    unexpected.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    if (isBenignRendererError(error)) return;
    unexpected.push(`pageerror: ${error.message}`);
  });
  return () => unexpected.slice();
}

async function waitForDemoReady(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });
}

async function gotoScene(page: Page, params: Record<string, string>): Promise<void> {
  await page.goto(demoUrl(params));
  await waitForDemoReady(page);
}

/** One marker per bootable scene: the element a visitor would recognize the scene by. */
const SCENE_MARKERS: Record<string, (page: Page) => Promise<void>> = {
  board: async (page) => {
    const swimlanes = page.locator('[data-swimlane-name]');
    await expect(swimlanes).toHaveCount(SWIMLANE_NAMES.length);
    const names = await swimlanes.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-swimlane-name')),
    );
    expect(names).toEqual(SWIMLANE_NAMES);
  },
  task: async (page) => {
    await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Extract auth middleware');
  },
  changes: async (page) => {
    const branchScope = page.locator('[data-testid="changes-scope-branch"]');
    await expect(branchScope).toBeVisible();
    await expect(branchScope).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-testid="changes-file-tree"]')).toContainText('routes.ts');
  },
  monitor: async (page) => {
    await expect(page.locator('[data-testid="monitor-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="monitor-card"]')).toHaveCount(MONITOR_ROW_COUNT);
  },
};

for (const sceneName of Object.keys(SCENE_MARKERS)) {
  test(`view=${sceneName} boots to its marker with a clean console`, async ({ page }) => {
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    await gotoScene(page, { view: sceneName, embed: '1', still: '1' });
    await expect(page.locator('html')).toHaveAttribute('data-demo-scene', sceneName);
    await SCENE_MARKERS[sceneName](page);
    expect(getUnexpectedErrors()).toEqual([]);
  });
}

test('embed=1 hides the OS window controls; without it they render', async ({ page }) => {
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await expect(page.locator('[data-testid="window-controls"]')).toBeHidden();

  await gotoScene(page, { view: 'board', still: '1' });
  await expect(page.locator('[data-testid="window-controls"]')).toBeVisible();
});

test('theme=sand adds theme-sand to <html>; theme=night leaves no theme- class', async ({ page }) => {
  await gotoScene(page, { view: 'board', theme: 'sand', embed: '1', still: '1' });
  await expect(page.locator('html')).toHaveClass(/(^|\s)theme-sand(\s|$)/);

  await gotoScene(page, { view: 'board', theme: 'night', embed: '1', still: '1' });
  const themeClasses = await page.evaluate(() =>
    Array.from(document.documentElement.classList).filter((className) => className.startsWith('theme-')),
  );
  expect(themeClasses).toEqual([]);
});

test('view=nope renders the error card, logs the unknown scene, and never marks ready', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(demoUrl({ view: 'nope', embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText('Unknown scene "nope"');
  await expect.poll(() => consoleErrors.some((text) => text.includes('Unknown scene'))).toBe(true);

  // The app behind the card still boots (empty, by design). Once it has painted, the ready
  // flag must still be absent: nothing seeded means nothing to caption.
  await expect(page.locator('#root > *').first()).toBeAttached();
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-scene');
});

test('state= alone opens the task window with no registry scene involved', async ({ page }) => {
  const stateBlob = Buffer.from(JSON.stringify({ config: SCENES.task.config })).toString('base64url');
  const getUnexpectedErrors = collectUnexpectedErrors(page);

  await gotoScene(page, { state: stateBlob, embed: '1', still: '1' });
  await expect(page.locator('html')).toHaveAttribute('data-demo-scene', 'state');
  // boot.js leaves sceneName null when only state= is given: no registry lookup happened.
  const resolvedSceneName = await page.evaluate(() => {
    const boot = (window as DemoBootGlobal).__demoBoot;
    return boot === undefined ? 'boot-missing' : boot.sceneName;
  });
  expect(resolvedSceneName).toBeNull();
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Extract auth middleware');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('the build carries production semantics: no dev badge, no dev-only store exposure', async ({ page }) => {
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  // The "(dev)" wordmark suffix is built out by __KANGENTIC_DEV__; the store exposure is behind
  // import.meta.env.DEV. An ambient NODE_ENV=development at build time would bring both back.
  await expect(page.locator('[data-testid="titlebar-dev-badge"]')).toHaveCount(0);
  const hasDevStores = await page.evaluate(() => '__zustandStores' in window);
  expect(hasDevStores).toBe(false);
});

test('the board scene makes no request off the serving origin', async ({ page }) => {
  const requestUrls: string[] = [];
  page.on('request', (request) => {
    requestUrls.push(request.url());
  });

  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);

  expect(requestUrls.length).toBeGreaterThan(0);
  const offOrigin = requestUrls.filter((url) => !url.startsWith(`${server.origin}/`));
  expect(offOrigin).toEqual([]);
});

// ---- live replay and what a visitor can start ----------------------------------------------
// A still frame paints each terminal's final state from the inline seed and never fetches a
// recording; the live frame replays each recording's timed stream, fetched from the same origin
// when a terminal mounts, and a drag into an auto-spawn column or a new Command Terminal starts
// the boot recorded for it, the way the desktop starts the agent.

interface DemoSessionRow { id: string; taskId: string | null; status: string; transient?: boolean }
interface DemoTaskRow { id: string; title: string; session_id: string | null }
interface DemoElectronWindow {
  electronAPI: {
    sessions: {
      list: () => Promise<DemoSessionRow[]>;
      onData: (callback: (sessionId: string, data: string) => void) => () => void;
      __resizeCalls?: Array<{ sessionId: string; cols: number; rows: number }>;
    };
    tasks: { list: () => Promise<DemoTaskRow[]> };
  };
}

function recordingRequests(page: Page): () => string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/recordings/')) urls.push(request.url());
  });
  return () => urls.slice();
}

/** Resolves with the first session id the mock's onData listeners deliver bytes for. */
function firstStreamedSession(page: Page, timeoutMs: number): Promise<string | null> {
  return page.evaluate((timeout) => new Promise<string | null>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const timer = setTimeout(() => resolve(null), timeout);
    const unsubscribe = api.sessions.onData((sessionId, data) => {
      if (!data) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(sessionId);
    });
  }), timeoutMs);
}

interface Grid { cols: number; rows: number }

/** The grid the session's terminal mounted with: the last resize the renderer sent the mock for it. */
function mountedGrid(page: Page, sessionId: string): Promise<Grid | null> {
  return page.evaluate((id) => {
    const calls = (window as unknown as DemoElectronWindow).electronAPI.sessions.__resizeCalls ?? [];
    const last = calls.filter((call) => call.sessionId === id).pop();
    return last ? { cols: last.cols, rows: last.rows } : null;
  }, sessionId);
}

/** The grid a served recording was made at, read from the file the frame fetched. */
async function recordingGrid(page: Page, url: string): Promise<Grid> {
  const recording = await (await page.request.get(url)).json() as { cols?: number; rows?: number };
  return { cols: recording.cols ?? 0, rows: recording.rows ?? 0 };
}

/**
 * Bytes replay only into a terminal whose grid equals the recording's (the frame's rule, and
 * main's): a machine whose fonts or display scaling fit another grid gets the recording's frame
 * and nothing streams. Each streaming case asserts whichever branch this machine is on.
 */
async function expectStreamedOrStill(page: Page, sessionId: string, recordingUrl: string, streamed: Promise<string | null>): Promise<void> {
  // A spawned session mounts in the bottom panel first (15 rows, never the recording's grid)
  // and in the task window once that opens, so wait for the mount that fits rather than the
  // first one; a machine where none fits runs out the wait and is on the still branch.
  const recorded = await recordingGrid(page, recordingUrl);
  const fits = await page.waitForFunction(({ id, cols, rows }) => {
    const calls = (window as unknown as DemoElectronWindow).electronAPI.sessions.__resizeCalls ?? [];
    const last = calls.filter((call) => call.sessionId === id).pop();
    return !!last && last.cols === cols && last.rows === rows;
  }, { id: sessionId, cols: recorded.cols, rows: recorded.rows }, { timeout: 10_000 }).then(() => true, () => false);
  if (fits) {
    expect(await streamed).toBe(sessionId);
  } else {
    // The long listener outlives the test on this branch; settle it so its rejection is not the verdict.
    streamed.catch(() => null);
    expect(await firstStreamedSession(page, 3_000)).toBeNull();
  }
}

async function dragCardToColumn(page: Page, title: string, column: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
  const target = page.locator(`[data-swimlane-name="${column}"]`);
  await expect(card).toBeVisible();
  await expect(target).toBeVisible();
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error(`no geometry for "${title}" or "${column}"`);
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 10, cardBox.y + cardBox.height / 2, { steps: 3 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, { steps: 15 });
  await page.mouse.up();
}

test('still=1 paints every terminal from the seed and fetches no recording', async ({ page }) => {
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'task', embed: '1', still: '1' });
  await SCENE_MARKERS.task(page);
  expect(getRecordingRequests()).toEqual([]);
});

test('the live task scene fetches its session recording from the serving origin', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'task', embed: '1' });
  await SCENE_MARKERS.task(page);
  await expect.poll(() => getRecordingRequests().length, { timeout: 10_000 }).toBeGreaterThan(0);
  const offOrigin = getRecordingRequests().filter((url) => !url.startsWith(`${server.origin}/`));
  expect(offOrigin).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('dragging a To Do card into Executing starts its agent from the recorded boot', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'board' });
  // The boot recording is fetched at spawn time (its first window's arrival time is what fires
  // the session's first output), so the request listener attaches before the drag.
  const getRecordingRequests = recordingRequests(page);
  const streamed = firstStreamedSession(page, 20_000);
  await dragCardToColumn(page, 'Add user auth flow', 'Executing');

  // The card now carries a running session, as it would after main's transition engine ran.
  await expect.poll(async () => page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const tasks = await api.tasks.list();
    const sessions = await api.sessions.list();
    const task = tasks.find((row) => row.title === 'Add user auth flow');
    const session = task?.session_id ? sessions.find((row) => row.id === task.session_id) : undefined;
    return session?.status ?? null;
  }), { timeout: 10_000 }).toBe('running');

  // Opening the card mounts its terminal once the session's first output is reported; the boot
  // recorded for this task in the lane's permission mode replays into it, and the bytes after
  // the mount arrive through the mock's onData path.
  await page.locator('[data-testid="swimlane"]').locator('text=Add user auth flow').first().click();
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Add user auth flow');
  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/spawn-task-cw-auth-acceptEdits.json')), { timeout: 15_000 }).toBe(true);
  const recordingUrl = getRecordingRequests().find((url) => url.includes('/recordings/spawn-task-cw-auth-acceptEdits.json')) as string;
  const sessionId = await page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    return (await api.tasks.list()).find((row) => row.title === 'Add user auth flow')?.session_id ?? null;
  });
  expect(sessionId).not.toBeNull();
  await expectStreamedOrStill(page, sessionId as string, recordingUrl, streamed);
  // The context bar's spinner gives way to the pills once the session's usage is pushed, a beat
  // after its first output, as main's status-line push does on the desktop.
  await expect(page.getByText('Starting agent...')).toHaveCount(0, { timeout: 15_000 });
  // The recording ships its own last displayed lines beside the stream: the Monitor row's output
  // peek once the boot has played out (too long for this tier to wait on, so the contract is checked).
  const recording = await (await page.request.get(recordingUrl)).json() as { peek?: unknown };
  expect(Array.isArray(recording.peek) && recording.peek.length > 0).toBe(true);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a new Command Terminal boots the project default agent from the recorded boot', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'board' });
  // The toggle reattaches the project's existing Command Terminal (its own recording); "New
  // terminal" is what spawns another, and that one boots the project's default agent.
  await page.locator('[data-testid="quick-session-button"]').click();
  await expect(page.locator('[data-testid="quick-session-new-terminal"]')).toBeVisible();
  const streamed = firstStreamedSession(page, 20_000);
  await page.locator('[data-testid="quick-session-new-terminal"]').click();
  await expect.poll(async () => page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const sessions = await api.sessions.list();
    return sessions.filter((row) => row.transient && row.status === 'running').length;
  }), { timeout: 10_000 }).toBeGreaterThan(1);
  // The project already has a running Command Terminal, so the new window opens tiled beside
  // it and boots the recording made at that size, not the single-window one.
  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/terminal-proj-contoso-web-tiled.json')), { timeout: 15_000 }).toBe(true);
  const recordingUrl = getRecordingRequests().find((url) => url.includes('/recordings/terminal-proj-contoso-web-tiled.json')) as string;
  const sessionId = await page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const sessions = await api.sessions.list();
    return sessions.filter((row) => row.transient && row.status === 'running' && row.id !== 'sess-cw-terminal-1').map((row) => row.id)[0] ?? null;
  });
  expect(sessionId).not.toBeNull();
  await expectStreamedOrStill(page, sessionId as string, recordingUrl, streamed);
  await expect(page.getByText('Starting agent...')).toHaveCount(0, { timeout: 15_000 });
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a Command Terminal that tiles beside a new one repaints from the boot recorded at the tiled width', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'board' });
  // spring-petclinic has no Command Terminal yet, so opening the layer boots one alone, at the
  // single-window width.
  await page.locator('[data-testid="sidebar-project-list"]').getByText('spring-pet', { exact: false }).first().click();
  await page.locator('[data-testid="quick-session-button"]').click();
  await expect(page.locator('[data-testid="quick-session-new-terminal"]')).toBeVisible();
  const transientIds = () => page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const sessions = await api.sessions.list();
    return sessions.filter((row) => row.transient && row.status === 'running' && row.projectId === 'proj-spring-petclinic').map((row) => row.id);
  });
  await expect.poll(transientIds, { timeout: 10_000 }).toHaveLength(1);
  const [firstId] = await transientIds();
  // Let that terminal mount alone first: the repaint under test is what its resize triggers.
  await expect.poll(() => mountedGrid(page, firstId), { timeout: 10_000 }).not.toBeNull();
  // The desktop's PTY resize makes the CLI repaint at the tiled width; the frame does the same
  // from the tiled recording, starting with a cleared screen.
  const repainted = page.evaluate(({ sessionId, timeout }) => new Promise<boolean>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const timer = setTimeout(() => resolve(false), timeout);
    const unsubscribe = api.sessions.onData((id, data) => {
      if (id !== sessionId || !data.startsWith('\x1b[2J\x1b[3J')) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  }), { sessionId: firstId, timeout: 15_000 });
  await page.locator('[data-testid="quick-session-new-terminal"]').click();
  await expect.poll(transientIds, { timeout: 10_000 }).toHaveLength(2);
  expect(await repainted).toBe(true);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('opened directly, the page hosts the frame at the site size and scales it to the window', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${server.url}?view=board`);
  // Without embed=1 or stage=0 the page hands over to the host, which keeps the frame at 1600
  // by 1000 (the size every recording was made for) and scales it down to the window.
  await expect(page).toHaveURL(/stage\.html\?view=board$/);
  const frame = page.locator('iframe#stage');
  await expect(frame).toHaveAttribute('src', /[?&]stage=0/);
  await expect(page.frameLocator('iframe#stage').locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: 20_000 });
  const geometry = await page.evaluate(() => {
    const element = document.getElementById('stage') as HTMLIFrameElement;
    return { width: element.offsetWidth, height: element.offsetHeight, scale: Number(document.documentElement.getAttribute('data-stage-scale')) };
  });
  expect(geometry.width).toBe(1600);
  expect(geometry.height).toBe(1000);
  expect(geometry.scale).toBeCloseTo(Math.min(1280 / 1600, 720 / 1000), 2);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a display that fits another grid gets each recording\'s frame and no stream', async ({ browser }) => {
  // Windows at 125 percent scaling fits 144 by 36 in the task window, not the recorded 154 by 37;
  // a recording's bytes address rows for its own grid, so the frame serves the parsed frame
  // instead and streams nothing, the way main routes a geometry-changed session on the desktop.
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'task' });
  await SCENE_MARKERS.task(page);
  await expect.poll(() => mountedGrid(page, 'sess-cw-middleware'), { timeout: 10_000 }).not.toBeNull();
  const grid = await mountedGrid(page, 'sess-cw-middleware');
  test.skip(grid?.cols === 154 && grid?.rows === 37, 'this machine fits the recorded grid at 1.25 too');
  expect(await firstStreamedSession(page, 4_000)).toBeNull();
  expect(getUnexpectedErrors()).toEqual([]);
  await context.close();
});
