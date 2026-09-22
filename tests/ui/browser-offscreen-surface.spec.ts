/**
 * An OFFSCREEN browser surface is visible in the UI, and closable from it.
 *
 * A task has one browser surface. When no pane can mount (the task's project is
 * not the one currently open), main brings that surface up offscreen instead.
 * Nothing in the renderer can see one for itself: the card globe and the
 * task-detail Browser pill both read `browserGuestTasks`, which is written in
 * exactly one place (`BrowserPane.tsx`, on the `<webview>`'s `dom-ready`), and
 * an offscreen `BrowserWindow` has no renderer to write it.
 *
 * That gap is what ended agent-requested lanes: an agent completed a whole
 * verification run in one with no browser anywhere on screen, and the user had
 * no control that could close it. Main now pushes the set of tasks holding one
 * (`BROWSER_OFFSCREEN_SURFACES`), and these tests pin the three things that
 * make the surface honest - the globe, the pill's alive dot, and a Close that
 * actually reaches it.
 *
 * Every case has its converse, because each indicator renders on a boolean OR
 * and a test that only ever asserts the true side passes against a component
 * that ignores the new half entirely.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-offscreen';
const TASK_ID = 'task-offscreen';
const OTHER_TASK_ID = 'task-offscreen-other';
const SESSION_ID = 'sess-offscreen';
const PROJECT_PATH = '/mock/offscreen-test';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Offscreen Surface Test',
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
      var id = 'lane-off-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9981,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    function task(id, title, position) {
      return {
        id: id,
        title: title,
        description: 'Drives the offscreen-surface indicators',
        swimlane_id: laneIds['Code Review'],
        position: position,
        agent: 'claude',
        session_id: id === '${TASK_ID}' ? '${SESSION_ID}' : null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      };
    }

    state.tasks.push(task('${TASK_ID}', 'Offscreen Surface Task', 0));
    state.tasks.push(task('${OTHER_TASK_ID}', 'Unrelated Task', 1));

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

/** Fire main's push, which carries the WHOLE set rather than a delta. */
async function pushOffscreenSurfaces(page: Page, taskIds: string[]): Promise<void> {
  await page.evaluate((ids) => { window.__mockBrowser?.emitOffscreenSurfaces(ids); }, taskIds);
}

function card(page: Page, title: string) {
  return page.locator('[data-swimlane-name="Code Review"]').locator(`text=${title}`).first();
}

test.describe('the task card globe', () => {
  test('lights for an offscreen surface and goes dark when it is closed', async () => {
    const globe = sharedPage.locator(`[data-testid="task-card-browser-alive"]`).first();

    // The converse first, and it is the assertion that stops the rest passing
    // vacuously: with no surface anywhere, nothing is lit.
    await expect(globe).toHaveCount(0);

    await pushOffscreenSurfaces(sharedPage, [TASK_ID]);
    await expect(globe).toHaveCount(1);

    // Main pushes the whole set, so an empty one is how a close arrives.
    await pushOffscreenSurfaces(sharedPage, []);
    await expect(globe).toHaveCount(0);
  });

  test('lights only the task that holds the surface', async () => {
    // The globe is per card, and a set-shaped push makes "everything lights up"
    // an easy mistake: a component reading `browserOffscreenTasks.size > 0`
    // instead of `.has(task.id)` passes every other test in this file.
    await pushOffscreenSurfaces(sharedPage, [OTHER_TASK_ID]);

    const lit = sharedPage.locator('[data-testid="task-card-browser-alive"]');
    await expect(lit).toHaveCount(1);
    // The lit card is the OTHER task's, so this task's card carries no globe.
    const thisCard = card(sharedPage, 'Offscreen Surface Task');
    await expect(thisCard.locator('xpath=ancestor::*[@data-task-id][1]')
      .locator('[data-testid="task-card-browser-alive"]')).toHaveCount(0);
  });

  test('reads the set on mount, for a surface that predates this renderer', async () => {
    // The push alone is not enough. An offscreen surface can sit unchanged for
    // a whole session, so a reload (or an HMR update) would leave the board
    // showing no browser for a task that genuinely has one.
    //
    // This test owns its page. The seed has to be in place BEFORE the app
    // mounts, or the mount-time read is not what lights the globe, and the
    // shared page cannot do that: `addInitScript` re-runs on every navigation
    // and rebuilds the mock's state, so anything seeded through `evaluate` is
    // gone by the time the reloaded renderer asks.
    const context = await sharedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(preConfig);
    await page.addInitScript((taskId: string) => {
      window.__mockBrowser?.seedOffscreenSurfaces([taskId]);
    }, TASK_ID);

    await page.goto(VITE_URL);
    await page.waitForLoadState('load');
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

    // No push at any point in this test: only `getOffscreenSurfaces` can have
    // produced this.
    await expect(page.locator('[data-testid="task-card-browser-alive"]')).toHaveCount(1);
    await context.close();
  });
});

test.describe('the task-detail Browser pill', () => {
  test('shows its alive dot for an offscreen surface, with no pane mounted', async () => {
    await card(sharedPage, 'Offscreen Surface Task').click();
    const dialog = sharedPage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const aliveDot = dialog.locator('[data-testid="browser-toggle-alive"]');
    await expect(aliveDot).toHaveCount(0);

    await pushOffscreenSurfaces(sharedPage, [TASK_ID]);
    await expect(aliveDot).toHaveCount(1);
    // And the pane itself is NOT mounted: the surface is offscreen, which is
    // the whole state this indicator exists to make visible.
    await expect(dialog.locator('[data-testid="browser-pane"]')).toHaveCount(0);

    await pushOffscreenSurfaces(sharedPage, []);
    await expect(aliveDot).toHaveCount(0);
  });
});

test.describe('closing an offscreen surface', () => {
  test('the kebab reaches it, naming this task and its project', async () => {
    // Without this the control said Close and did nothing: the ordinary close
    // path retires a guest id and clears a pane flag, and an offscreen surface
    // has neither.
    await card(sharedPage, 'Offscreen Surface Task').click();
    const dialog = sharedPage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await pushOffscreenSurfaces(sharedPage, [TASK_ID]);
    await expect(dialog.locator('[data-testid="browser-toggle-alive"]')).toHaveCount(1);

    await dialog.locator('button[title="Actions"]').first().click();
    await sharedPage.locator('[data-testid="kebab-close-browser"]').click();

    await expect.poll(async () => sharedPage.evaluate(() => (
      (window.__mockBrowser?.getPaneCalls() ?? []).filter((call) => call.type === 'offscreen-close')
    )), { timeout: 5000 }).toEqual([{ type: 'offscreen-close', taskId: TASK_ID, projectId: PROJECT_ID }]);

    // The mock destroys it and re-pushes, so the indicator clears without a
    // second nudge - the same round trip the real main process makes.
    await expect(dialog.locator('[data-testid="browser-toggle-alive"]')).toHaveCount(0);
  });

  test('is not attempted for a task whose surface is a real pane', async () => {
    // A pane has a guest id, so Close goes down the `closePaneByUser` path.
    // Calling both would destroy the pane twice and, worse, would mean the
    // renderer cannot tell the two forms apart.
    await card(sharedPage, 'Offscreen Surface Task').click();
    const dialog = sharedPage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await sharedPage.evaluate((taskId) => {
      window.__mockBrowser?.seedTaskUrl(taskId, 'http://localhost:5173/');
    }, TASK_ID);
    await sharedPage.locator('[data-testid="browser-toggle"]').click();
    await dialog.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 5000 });

    await sharedPage.evaluate(() => {
      const element = document.querySelector('[data-testid="browser-webview"]');
      if (!element) throw new Error('browser-webview element not found in DOM');
      const stub = element as HTMLElement & { getWebContentsId: () => number; getURL: () => string };
      stub.getWebContentsId = () => 8181;
      stub.getURL = () => 'http://localhost:5173/';
      element.dispatchEvent(new Event('dom-ready'));
    });
    await expect(dialog.locator('[data-testid="browser-toggle-alive"]')).toHaveCount(1);

    await dialog.locator('button[title="Actions"]').first().click();
    await sharedPage.locator('[data-testid="kebab-close-browser"]').click();

    await expect.poll(async () => sharedPage.evaluate(() => (
      (window.__mockBrowser?.getPaneCalls() ?? []).map((call) => call.type)
    )), { timeout: 5000 }).toContain('user-close');
    const calls = await sharedPage.evaluate(() => (
      (window.__mockBrowser?.getPaneCalls() ?? []).map((call) => call.type)
    ));
    expect(calls).not.toContain('offscreen-close');
  });
});
