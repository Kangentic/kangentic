/**
 * A Browser pane page whose renderer process is gone (task #1226, DESKTOP-5Z).
 *
 * Before this, nothing in the renderer listened for the `<webview>`'s
 * `render-process-gone`: the page stopped and the pane said nothing. Now the
 * pane covers the page with "This page stopped" and why, and a Reload. The
 * header's Browser button and the board card's globe turn red from main's
 * stopped-page push, which the mock fires here, since main is its one writer.
 * The next `dom-ready` lifts the cover, and main's next push lifts the marks.
 *
 * The UI tier's `<webview>` is a plain element, so the test gives it the methods
 * the pane calls and dispatches the guest's events itself, the way
 * `browser-pane-registration.spec.ts` does. The guest's identity is asserted
 * from the register/unregister log, since the cover must never remount it.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-crash';
const TASK_ID = 'task-browser-crash';
const SESSION_ID = 'sess-browser-crash';
const PROJECT_PATH = '/mock/browser-crash-test';
const TASK_TITLE = 'Browser Crash Task';
const GUEST_ID = 4343;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({ id: '${PROJECT_ID}', name: 'Browser Crash Test', path: '${PROJECT_PATH}', github_url: null,
      default_agent: 'claude', last_opened: timestamp, created_at: timestamp });
    state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-bc-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
    });
    state.sessions.push({ id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9996,
      status: 'running', shell: 'bash', cwd: '${PROJECT_PATH}', startedAt: timestamp, exitCode: null });
    state.tasks.push({ id: '${TASK_ID}', title: '${TASK_TITLE}', description: '',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: null, branch_name: null, pr_number: null, pr_url: null, base_branch: 'main',
      archived_at: null, created_at: timestamp, updated_at: timestamp });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
});

test.afterAll(async () => {
  await browser?.close();
});

/**
 * Dispatch one of the guest's own events on the webview stub. A crash carries
 * Electron's details object, the shape a real `<webview>` fires (measured in
 * /preview: `event.details` is `{ reason, exitCode }`, with no `event.reason`).
 */
async function guestEvent(name: 'render-process-gone' | 'dom-ready', reason?: string): Promise<void> {
  await page.evaluate(({ eventName, crashReason }) => {
    const element = document.querySelector('[data-testid="browser-webview"]');
    if (!element) throw new Error('browser-webview element not found');
    const details = crashReason ? { details: { reason: crashReason, exitCode: -36861 } } : {};
    element.dispatchEvent(Object.assign(new Event(eventName), details));
  }, { eventName: name, crashReason: reason });
}

/** Fire main's stopped-page push: the whole map, as main sends it. */
async function crashedSurfaces(surfaces: Record<string, 'out-of-memory' | 'crashed'>): Promise<void> {
  await page.evaluate((map) => window.__mockBrowser?.emitCrashedSurfaces(map), surfaces);
}

test('a crashed page is covered, says why, reloads, and turns the marks outside the pane red', async () => {
  await test.step('open the pane on a live guest', async () => {
    await page.evaluate((taskId) => {
      window.__mockBrowser?.reset();
      window.__mockBrowser?.seedTaskUrl(taskId, 'http://localhost:5173/');
    }, TASK_ID);
    await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
    const pane = page.locator('[data-testid="browser-pane"]');
    if (!(await pane.isVisible().catch(() => false))) await page.locator('[data-testid="browser-toggle"]').click();
    await pane.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 5000 });
    await page.evaluate((webContentsId) => {
      const element = document.querySelector('[data-testid="browser-webview"]') as HTMLElement & {
        getWebContentsId: () => number; getURL: () => string; reload: () => void;
      };
      const tracker = window as unknown as { __guestReloads: number };
      tracker.__guestReloads = 0;
      element.getWebContentsId = () => webContentsId;
      element.getURL = () => 'http://localhost:5173/';
      element.reload = () => { tracker.__guestReloads += 1; };
      element.dispatchEvent(new Event('dom-ready'));
    }, GUEST_ID);
    await expect(page.locator('[data-testid="browser-toggle-alive"]')).toHaveAttribute('data-badge', 'running');
    await expect(page.locator('[data-testid="browser-pane-crashed"]')).toHaveCount(0);
  });

  await test.step('an out-of-memory crash covers the page and says so', async () => {
    await guestEvent('render-process-gone', 'oom');
    const cover = page.locator('[data-testid="browser-pane-crashed"]');
    await expect(cover).toBeVisible();
    await expect(cover).toContainText('This page stopped');
    await expect(cover).toContainText('It ran out of memory.');
    // The cover sits over the annotation bar: a point on the bar hits the cover.
    const barCoveredByCrash = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="annotation-bar"]');
      if (!bar) throw new Error('annotation bar not found');
      const box = bar.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(hit?.closest('[data-testid="browser-pane-crashed"]'));
    });
    expect(barCoveredByCrash).toBe(true);
    // A guest captures its own events past a cover, so the page itself goes inert.
    await expect(page.locator('[data-testid="browser-webview"]')).toHaveCSS('pointer-events', 'none');
    // The pane writes no mark outside itself: main's push is the one writer.
    await expect(page.locator('[data-testid="browser-toggle-alive"]')).toHaveAttribute('data-badge', 'running');
    await crashedSurfaces({ [TASK_ID]: 'out-of-memory' });
    await expect(page.locator('[data-testid="browser-toggle-alive"]')).toHaveAttribute('data-badge', 'problems');
  });

  await test.step('Reload reloads the guest, and its next dom-ready lifts the cover', async () => {
    await page.locator('[data-testid="browser-pane-crashed-reload"]').click();
    expect(await page.evaluate(() => (window as unknown as { __guestReloads: number }).__guestReloads)).toBe(1);
    await guestEvent('dom-ready');
    await crashedSurfaces({});
    await expect(page.locator('[data-testid="browser-pane-crashed"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="browser-toggle-alive"]')).toHaveAttribute('data-badge', 'running');
    // The next load hands the page its pointer back.
    await expect(page.locator('[data-testid="browser-webview"]')).toHaveCSS('pointer-events', 'auto');
  });

  await test.step('any other reason reads "It crashed."', async () => {
    await guestEvent('render-process-gone', 'killed');
    await crashedSurfaces({ [TASK_ID]: 'crashed' });
    await expect(page.locator('[data-testid="browser-pane-crashed"]')).toContainText('It crashed.');
  });

  await test.step('with the pane hidden, the Browser button is red and its tip says why', async () => {
    await page.locator('[data-testid="browser-toggle"]').click();
    const badge = page.locator('[data-testid="browser-toggle-alive"]');
    await expect(badge).toHaveAttribute('data-badge', 'problems');
    await expect(page.locator('[data-testid="browser-toggle"]')).toHaveAccessibleDescription(/Page crashed/);
    // An out-of-memory stop words the pill's detail its own way.
    await crashedSurfaces({ [TASK_ID]: 'out-of-memory' });
    await expect(page.locator('[data-testid="browser-toggle"]')).toHaveAccessibleDescription(/Page ran out of memory/);
  });

  await test.step('with the window closed, the card globe is red with its tip, for either kind', async () => {
    await page.locator('[data-testid="task-detail-dialog"]').getByRole('button', { name: 'Close', exact: true }).first().click();
    const globe = page.locator('[data-testid="task-card-browser-alive"]');
    // Main's map still says out-of-memory from the step above.
    await expect(globe).toHaveAttribute('data-crash-kind', 'out-of-memory');
    await expect(globe).toHaveAccessibleDescription(/ran out of memory\. Open the task to reload it\./);
    await expect(globe.locator('svg')).toHaveAttribute('aria-label', 'Browser page stopped');
    await crashedSurfaces({ [TASK_ID]: 'crashed' });
    await expect(globe).toHaveAttribute('data-crash-kind', 'crashed');
    await expect(globe).toHaveAccessibleDescription(/crashed\. Open the task to reload it\./);
  });

  await test.step('the next load clears the card too', async () => {
    await guestEvent('dom-ready');
    await crashedSurfaces({});
    const globe = page.locator('[data-testid="task-card-browser-alive"]');
    await expect(globe).not.toHaveAttribute('data-crash-kind', /.+/);
  });

  await test.step('the guest was never remounted', async () => {
    const log = await page.evaluate(() => window.__mockBrowser?.getPaneCalls() ?? []);
    const registeredIds = new Set(log.filter((call) => call.type === 'register').map((call) => (call.type === 'register' ? call.input.webContentsId : -1)));
    expect([...registeredIds]).toEqual([GUEST_ID]);
    expect(log.filter((call) => call.type === 'unregister' && call.webContentsId === GUEST_ID)).toHaveLength(0);
  });
});
