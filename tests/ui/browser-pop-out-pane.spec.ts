/**
 * A detached Browser window mounts its pane, and a detached Changes window
 * mounts its panel, on the window's first boot.
 *
 * Both broke on 2026-10-20, silently. `loadBoard` gained a guard that drops a
 * load when the open project changed while it was in flight. A pop-out is a
 * fresh renderer whose `currentProject` starts null, and its bootstrap fired
 * `loadCurrent()` and `loadBoard()` in the same tick. So the board load began
 * under null, `project:getCurrent` landed first, the guard read that as a
 * project switch and threw the task list away. The Browser root then rendered
 * "No active session for this task" with no `<webview>`, so no pane ever
 * registered and `kangentic_browser_pop_out` timed out. The Changes root fell
 * through to "No changes on this branch" for a live task.
 *
 * The mock resolves the same IPC in the same order main does here, so the race
 * reproduces in this tier deterministically. Each empty text is watched with a
 * MutationObserver from before boot: a root that shows it for one commit and
 * then recovers still fails.
 *
 * Neither root takes its task from the board store, which holds the OPEN
 * project's tasks only. The seeded task carries its `projectId`, so the mock's
 * `tasks.list` drops it whenever another project is open, as main's per-project
 * database does, while `monitor.getTaskDetail` (the read by params) still
 * answers. A backgrounded case therefore fails against a root that reads the
 * board. The empty texts also wait for their reads: a held `sessions.list` or
 * a held board load (the mock's `__mockHoldNextTaskList`) keeps a spinner up,
 * and the empty text may not show until the held read has answered.
 *
 * Each test launches its own browser, because a pop-out is booted by a
 * descriptor set before the renderer mounts.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const TASK_PROJECT_ID = 'proj-popout-pane';
const TASK_PROJECT_PATH = '/mock/popout-pane';
const OTHER_PROJECT_ID = 'proj-popout-other';
const OTHER_PROJECT_PATH = '/mock/popout-other';
const TASK_ID = 'task-popout-pane';
const SESSION_ID = 'sess-popout-pane';
const TASK_URL = 'http://localhost:5173/';
const MOCK_WEB_CONTENTS_ID = 5151;

const EMPTY_TEXTS = ['No active session for this task', 'No changes on this branch'];

/**
 * One task in `TASK_PROJECT_ID`, with a running agent unless `withSession` is
 * false. `currentProjectId` is the project main has open, which a backgrounded
 * case points elsewhere. The task row is tagged with its project, so the mock's
 * board list (`tasks.list`) drops it while another project is open.
 */
function preConfig(currentProjectId: string, withSession: boolean): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${TASK_PROJECT_ID}', name: 'Pop-out Pane Test', path: '${TASK_PROJECT_PATH}',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.projects.push({
        id: '${OTHER_PROJECT_ID}', name: 'Pop-out Other Project', path: '${OTHER_PROJECT_PATH}',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.projectConfigs['${TASK_PROJECT_PATH}'] = { browser: { enabled: true } };

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        var id = 'lane-popout-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[lane.name] = id;
        state.swimlanes.push(Object.assign({}, lane, { id: id, position: index, created_at: ts }));
      });

      if (${withSession}) {
        state.sessions.push({
          id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${TASK_PROJECT_ID}', pid: 9996,
          status: 'running', shell: 'bash', cwd: '${TASK_PROJECT_PATH}', startedAt: ts, exitCode: null,
        });
      }

      state.tasks.push({
        id: '${TASK_ID}', projectId: '${TASK_PROJECT_ID}', title: 'Pop-out Pane Task', description: '',
        swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude',
        session_id: ${withSession ? `'${SESSION_ID}'` : 'null'},
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null, base_branch: 'main',
        archived_at: null, created_at: ts, updated_at: ts,
      });

      return { currentProjectId: '${currentProjectId}' };
    });
  `;
}

/** Records every empty text the page ever showed, from before the first render. */
const EMPTY_TEXT_WATCH = `
  window.__sawEmptyText = [];
  (function () {
    var phrases = ${JSON.stringify(EMPTY_TEXTS)};
    var check = function () {
      var text = document.body ? document.body.textContent || '' : '';
      phrases.forEach(function (phrase) {
        if (text.indexOf(phrase) !== -1 && window.__sawEmptyText.indexOf(phrase) === -1) {
          window.__sawEmptyText.push(phrase);
        }
      });
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  })();
`;

/**
 * Records which state the Browser root is in, in order, from before the first
 * render: `loading` (its spinner), `empty` (the no-session text) or `pane` (the
 * guest element). A state is logged when it changes, so a root that flashes the
 * empty text for one commit and then recovers still reads `loading, empty, pane`.
 */
const BROWSER_STATE_TRACE = `
  window.__browserStateTrace = [];
  (function () {
    var last = null;
    var check = function () {
      var body = document.body;
      if (!body) return;
      var state = null;
      if (body.querySelector('[data-testid="popout-browser-loading"]')) state = 'loading';
      else if ((body.textContent || '').indexOf('No active session for this task') !== -1) state = 'empty';
      else if (body.querySelector('[data-testid="browser-webview"]')) state = 'pane';
      if (state && state !== last) {
        window.__browserStateTrace.push(state);
        last = state;
      }
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  })();
`;

/**
 * Parks every `sessions.list` call until `__releaseSessionsList()`, which also
 * puts the original back. `syncSessions` reads `window.electronAPI.sessions` at
 * call time, so the override is what the Browser root's boot sync gets. The
 * answer is computed when the call is made, so a release delivers the board as
 * it stood then.
 */
const HOLD_SESSIONS_LIST = `
  (function () {
    var originalList = window.electronAPI.sessions.list;
    var parked = [];
    window.__sessionsListCalls = 0;
    window.electronAPI.sessions.list = function () {
      window.__sessionsListCalls += 1;
      var answer = originalList.apply(this, arguments);
      return new Promise(function (resolve) { parked.push(function () { resolve(answer); }); });
    };
    window.__releaseSessionsList = function () {
      window.electronAPI.sessions.list = originalList;
      parked.splice(0).forEach(function (release) { release(); });
    };
  })();
`;

/**
 * Counts task reads by params (`monitor.getTaskDetail`) the moment they settle,
 * a step before the hook's own handler sets state. A spec that holds another
 * read waits on this first: without it, "the empty text has not shown" could
 * only mean the task read has not landed yet.
 */
const COUNT_SETTLED_TASK_READS = `
  (function () {
    var originalRead = window.electronAPI.monitor.getTaskDetail;
    window.__taskReadsSettled = 0;
    window.electronAPI.monitor.getTaskDetail = function () {
      return originalRead.apply(this, arguments).then(function (bundle) {
        window.__taskReadsSettled += 1;
        return bundle;
      });
    };
  })();
`;

/** The mock holds the next `tasks.list` (the board's load) until `__mockReleaseTaskList()`. */
const HOLD_NEXT_BOARD_LOAD = 'window.__mockHoldNextTaskList = true;';

interface LaunchOptions {
  /** Whether the task has a running agent. Defaults to true. */
  withSession?: boolean;
  /** Page-side scripts that run after the mock and the seed, before the app boots. */
  initScripts?: string[];
}

async function launchPopOut(
  descriptor: { kind: string; params: Record<string, unknown> },
  currentProjectId: string,
  options: LaunchOptions = {},
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(currentProjectId, options.withSession ?? true));
  await page.addInitScript(`
    window.__mockBrowser.seedTaskUrl('${TASK_ID}', '${TASK_URL}');
    window.electronAPI.popOut.descriptor = ${JSON.stringify(descriptor)};
  `);
  await page.addInitScript(EMPTY_TEXT_WATCH);
  await page.addInitScript(BROWSER_STATE_TRACE);
  for (const script of options.initScripts ?? []) await page.addInitScript(script);
  await gotoVite(page, VITE_URL);
  return { browser, page };
}

async function sawEmptyText(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __sawEmptyText: string[] }).__sawEmptyText.slice());
}

async function browserStateTrace(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __browserStateTrace: string[] }).__browserStateTrace.slice());
}

/** Page-side counters and release hooks the init scripts above publish. */
interface PopOutProbe {
  __sessionsListCalls?: number;
  __taskReadsSettled?: number;
  __mockReleaseTaskList?: () => void;
  __releaseSessionsList?: () => void;
}

/** Two animation frames: whatever a settled promise scheduled has been committed. */
async function afterNextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/** Wait until the window's task read by params has answered. */
async function waitForTaskReadSettled(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => (window as unknown as PopOutProbe).__taskReadsSettled ?? 0),
    { timeout: 10000 },
  ).toBeGreaterThanOrEqual(1);
}

/** The ids the mock's board list (`tasks.list`) holds for the open project. */
async function boardTaskIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const tasks = await window.electronAPI.tasks.list();
    return tasks.map((task) => task.id);
  });
}

/**
 * Attach a guest to the `<webview>` stub and fire `dom-ready`, as Electron
 * does once the guest loads, then return the pane's register payload.
 */
async function registerGuest(page: Page) {
  await page.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 10000 });
  await page.evaluate((webContentsId: number) => {
    const element = document.querySelector('[data-testid="browser-webview"]');
    if (!element) throw new Error('browser-webview element not found in DOM');
    const stub = element as HTMLElement & { getWebContentsId: () => number; getURL: () => string };
    stub.getWebContentsId = () => webContentsId;
    stub.getURL = () => 'http://localhost:5173/';
    element.dispatchEvent(new Event('dom-ready'));
  }, MOCK_WEB_CONTENTS_ID);

  await expect.poll(
    () => page.evaluate((expectedId: number) => {
      const calls = window.__mockBrowser?.getPaneCalls() ?? [];
      return calls.some((call) => call.type === 'register' && call.input.webContentsId === expectedId);
    }, MOCK_WEB_CONTENTS_ID),
    { timeout: 5000 },
  ).toBe(true);

  return page.evaluate(() => {
    const calls = window.__mockBrowser?.getPaneCalls() ?? [];
    const entry = calls.find((call) => call.type === 'register');
    if (!entry || entry.type !== 'register') return null;
    return { sessionId: entry.input.sessionId, taskId: entry.input.taskId, projectId: entry.input.projectId };
  });
}

test.describe('Detached Browser window', () => {
  test('mounts the task\'s pane and registers its guest when the task\'s project is open', async () => {
    const { browser, page } = await launchPopOut(
      { kind: 'browser', params: { taskId: TASK_ID, projectId: TASK_PROJECT_ID } },
      TASK_PROJECT_ID,
    );
    try {
      // Counterpart to the backgrounded case below: here the board holds the task.
      expect(await boardTaskIds(page)).toContain(TASK_ID);
      const registered = await registerGuest(page);
      expect(registered).toEqual({ sessionId: SESSION_ID, taskId: TASK_ID, projectId: TASK_PROJECT_ID });
      expect(await sawEmptyText(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('mounts the pane from the task\'s own row when the open board does not hold it', async () => {
    // The task's project is backgrounded: main has another project open, so the
    // board holds THAT project's tasks and this one is missing, as in main. A
    // root that read its task from the board store would have no task here and
    // show the empty state with no guest. This one reads the row by params.
    const { browser, page } = await launchPopOut(
      { kind: 'browser', params: { taskId: TASK_ID, projectId: TASK_PROJECT_ID } },
      OTHER_PROJECT_ID,
    );
    try {
      // The premise, so a mock that stops scoping the board list cannot turn
      // this into a test the board-reading root also passes.
      expect(await boardTaskIds(page)).not.toContain(TASK_ID);

      const registered = await registerGuest(page);
      expect(registered).toEqual({ sessionId: SESSION_ID, taskId: TASK_ID, projectId: TASK_PROJECT_ID });
      expect(await sawEmptyText(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('shows a spinner, then the no-session text, for a task with no agent', async () => {
    const { browser, page } = await launchPopOut(
      { kind: 'browser', params: { taskId: TASK_ID, projectId: TASK_PROJECT_ID } },
      TASK_PROJECT_ID,
      { withSession: false },
    );
    try {
      await expect(page.getByText('No active session for this task')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="popout-browser-loading"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="browser-webview"]')).toHaveCount(0);

      // The spinner is the first state the window was ever in, and the empty text
      // follows it. The trace reads `empty` alone from a root that has no spinner.
      expect(await browserStateTrace(page)).toEqual(['loading', 'empty']);
      const registers = await page.evaluate(
        () => (window.__mockBrowser?.getPaneCalls() ?? []).filter((call) => call.type === 'register').length,
      );
      expect(registers).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('holds the spinner for a task with no agent until the session sync answers', async () => {
    const { browser, page } = await launchPopOut(
      { kind: 'browser', params: { taskId: TASK_ID, projectId: TASK_PROJECT_ID } },
      TASK_PROJECT_ID,
      { withSession: false, initScripts: [HOLD_SESSIONS_LIST, COUNT_SETTLED_TASK_READS] },
    );
    try {
      // The sync is in flight and the task read has landed, so the only thing
      // left to decide "no session" on is the session list that has not answered.
      await expect.poll(
        () => page.evaluate(() => (window as unknown as PopOutProbe).__sessionsListCalls ?? 0),
        { timeout: 10000 },
      ).toBeGreaterThanOrEqual(1);
      await waitForTaskReadSettled(page);
      await afterNextFrames(page);

      await expect(page.locator('[data-testid="popout-browser-loading"]')).toBeVisible();
      expect(await sawEmptyText(page)).toEqual([]);
      expect(await browserStateTrace(page)).toEqual(['loading']);

      await page.evaluate(() => (window as unknown as PopOutProbe).__releaseSessionsList?.());

      await expect(page.getByText('No active session for this task')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="popout-browser-loading"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="browser-webview"]')).toHaveCount(0);
      expect(await browserStateTrace(page)).toEqual(['loading', 'empty']);
    } finally {
      await browser.close();
    }
  });

  test('never flashes the no-session text while the session sync is in flight for a task that has an agent', async () => {
    const { browser, page } = await launchPopOut(
      { kind: 'browser', params: { taskId: TASK_ID, projectId: TASK_PROJECT_ID } },
      TASK_PROJECT_ID,
      { initScripts: [HOLD_SESSIONS_LIST, COUNT_SETTLED_TASK_READS] },
    );
    try {
      await expect.poll(
        () => page.evaluate(() => (window as unknown as PopOutProbe).__sessionsListCalls ?? 0),
        { timeout: 10000 },
      ).toBeGreaterThanOrEqual(1);
      await waitForTaskReadSettled(page);
      await afterNextFrames(page);

      // The row is known and the agent is not yet: still the spinner, and no pane.
      await expect(page.locator('[data-testid="popout-browser-loading"]')).toBeVisible();
      await expect(page.locator('[data-testid="browser-webview"]')).toHaveCount(0);
      expect(await sawEmptyText(page)).toEqual([]);

      await page.evaluate(() => (window as unknown as PopOutProbe).__releaseSessionsList?.());

      const registered = await registerGuest(page);
      expect(registered).toEqual({ sessionId: SESSION_ID, taskId: TASK_ID, projectId: TASK_PROJECT_ID });
      expect(await sawEmptyText(page)).toEqual([]);
      expect(await browserStateTrace(page)).toEqual(['loading', 'pane']);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Detached Changes window', () => {
  test('mounts the live task\'s panel rather than the empty state', async () => {
    const { browser, page } = await launchPopOut(
      { kind: 'changes', params: { taskId: TASK_ID, projectId: TASK_PROJECT_ID } },
      TASK_PROJECT_ID,
    );
    try {
      // The premise: the open project's board holds the task, so the panel is
      // mounted from it and not from the row read.
      expect(await boardTaskIds(page)).toContain(TASK_ID);
      // The Working / Staged / Branch select exists only on a live task's panel.
      await expect(page.locator('[data-testid="changes-scope-select"]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="popout-changes-none"]')).toHaveCount(0);
      expect(await sawEmptyText(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('waits for the board before saying a live task it does not hold has no changes', async () => {
    // The task's project is backgrounded, so the board (the open project's) never
    // holds it, and its row is live, not archived. The window must not call that
    // "no changes" until the board has answered: it says so for a frame and then
    // has nothing to show otherwise. The board's load is held, so the order is
    // decided here and not by how fast the mock answers.
    const { browser, page } = await launchPopOut(
      { kind: 'changes', params: { taskId: TASK_ID, projectId: TASK_PROJECT_ID } },
      OTHER_PROJECT_ID,
      { initScripts: [COUNT_SETTLED_TASK_READS, HOLD_NEXT_BOARD_LOAD] },
    );
    try {
      // The board's load is the held call, and the row read has landed, so the
      // board's answer is the only thing the window is still waiting on.
      await expect.poll(
        () => page.evaluate(() => typeof (window as unknown as PopOutProbe).__mockReleaseTaskList === 'function'),
        { timeout: 10000 },
      ).toBe(true);
      await waitForTaskReadSettled(page);
      await afterNextFrames(page);

      // The premise, read AFTER the hold is taken so this call is not the held one.
      expect(await boardTaskIds(page)).not.toContain(TASK_ID);

      await expect(page.locator('svg.animate-spin')).toHaveCount(1);
      await expect(page.locator('[data-testid="popout-changes-none"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="changes-scope-select"]')).toHaveCount(0);
      expect(await sawEmptyText(page)).toEqual([]);

      await page.evaluate(() => (window as unknown as PopOutProbe).__mockReleaseTaskList?.());

      await expect(page.locator('[data-testid="popout-changes-none"]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('svg.animate-spin')).toHaveCount(0);
      await expect(page.locator('[data-testid="changes-scope-select"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
