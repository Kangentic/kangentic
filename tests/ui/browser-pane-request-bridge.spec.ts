/**
 * UI tests for `useBrowserPaneRequestBridge` - the renderer half of the
 * `kangentic_browser_open_pane` / `kangentic_browser_close_pane` MCP tools.
 *
 * Pane open state is renderer-owned (`browserOpenTasks`) while the MCP server is
 * main-process, so main pushes BROWSER_PANE_OPEN_REQUEST / _CLOSE_REQUEST and
 * this bridge acts on it. Three behaviors are load-bearing and none of them is
 * visible to the main-process unit tests:
 *
 * 1. A push with no task-detail window open must OPEN one, or the agent is left
 *    exactly where the `no-pane-open` dead end left it.
 * 2. A push at a pane already mounted on its EMPTY STATE must make it pick up
 *    the URL main just seeded. The pane's URL fetch keys on taskId + projectId,
 *    neither of which changed, so without the refresh nudge the pane would sit
 *    on the empty state forever, register no guest, and the tool would time out.
 * 3. Closing hides the pane but leaves the task-detail window open - the tool
 *    puts the pane away the way the Browser pill does, it does not close windows.
 *
 * Headless note: <webview> is an unknown HTMLElement here, so no real guest ever
 * attaches. These tests assert the RENDERER's reaction (which subtree renders),
 * which is exactly the half main cannot see; guest registration itself is
 * covered by browser-pane-registration.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-pane-bridge';
const TASK_ID = 'task-pane-bridge';
const SESSION_ID = 'sess-pane-bridge';
const PROJECT_PATH = '/mock/pane-bridge-test';
const SEEDED_URL = 'http://localhost:5173/';
// Synthetic webContentsId injected onto the <webview> stub to simulate a real
// Electron guest attaching. Must be a positive integer (the real guard checks
// `Number.isInteger(webContentsId) && webContentsId > 0`).
const MOCK_WEB_CONTENTS_ID = 7373;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Pane Bridge Test',
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
      var id = 'lane-pb-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
      title: 'Pane Bridge Task',
      description: 'Drives the browser-pane open/close request bridge',
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

async function loadApp(page: Page): Promise<void> {
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
}

/** Fire main's open push, as `kangentic_browser_open_pane` does. */
async function emitOpenRequest(page: Page): Promise<void> {
  await page.evaluate(
    ([projectId, taskId]) => window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId),
    [PROJECT_ID, TASK_ID],
  );
}

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({ headless: true });
  const context = await sharedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  sharedPage = await context.newPage();
  await sharedPage.addInitScript({ path: MOCK_SCRIPT });
  await sharedPage.addInitScript(preConfig);
  await loadApp(sharedPage);
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

test.beforeEach(async () => {
  // Full navigation resets both the mock state and React state.
  await loadApp(sharedPage);
});

test.describe('browser pane request bridge', () => {
  test('an open push with no window open opens the window with the pane showing', async () => {
    // Main seeds the task URL before pushing, so the pane can resolve one and
    // mount its active subtree instead of the empty state.
    await sharedPage.evaluate((url) => {
      window.__mockBrowser?.reset();
      window.__mockBrowser?.seedTaskUrl('task-pane-bridge', url);
    }, SEEDED_URL);

    // Nothing is open yet: this is the state an agent hits `no-pane-open` in.
    await expect(sharedPage.locator('[data-testid="task-detail-dialog"]')).toHaveCount(0);

    await emitOpenRequest(sharedPage);

    await sharedPage
      .locator('[data-testid="task-detail-dialog"]')
      .waitFor({ state: 'visible', timeout: 10000 });
    await sharedPage.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test('an open push makes a pane sitting on the empty state pick up the seeded URL', async () => {
    // The case the refresh token exists for. Open the pane with NO URL saved so
    // it renders the empty state and registers nothing, then seed a URL the way
    // main does and push. The pane's fetch keys on taskId + projectId, so
    // without the nudge it would never see the new URL.
    await sharedPage.evaluate(() => window.__mockBrowser?.reset());

    const card = sharedPage
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Pane Bridge Task')
      .first();
    await card.click();
    await sharedPage
      .locator('[data-testid="task-detail-dialog"]')
      .waitFor({ state: 'visible', timeout: 10000 });
    await sharedPage.locator('[data-testid="browser-toggle"]').click();
    await sharedPage
      .locator('[data-testid="browser-empty-state"]')
      .waitFor({ state: 'visible', timeout: 10000 });

    await sharedPage.evaluate((url) => {
      window.__mockBrowser?.seedTaskUrl('task-pane-bridge', url);
    }, SEEDED_URL);
    await emitOpenRequest(sharedPage);

    await sharedPage.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 10000 });
    await expect(sharedPage.locator('[data-testid="browser-empty-state"]')).toHaveCount(0);
  });

  test('a second open push on an already-active pane refetches without remounting the live guest', async () => {
    // Coverage for the promise in useBrowserUrl's refreshToken doc comment:
    // "a live pane's guest is never torn down." browser-pane-refetch-guard
    // .spec.ts already pins this for the OTHER refetch trigger (a project
    // switch), but that trigger changes `projectId` itself, which is also
    // BrowserPane's registration effect dependency
    // (`[sessionId, taskId, projectId]`) - so a broken guard there produces a
    // NEW register call for the wrong project, which is what that spec's
    // "last register call" discriminator catches.
    //
    // This push changes NONE of those three: it fires again on a pane that
    // is already open, already resolved, and already registered. That makes
    // the register-call-log discriminator blind here even if the loading
    // guard breaks: with stable deps, BrowserPane's registration effect
    // would never re-run at all, so a torn-down-and-rebuilt <webview> would
    // sit unregistered with zero new register/unregister calls logged - the
    // call log would look identical to the guarded run. The only thing that
    // actually distinguishes "same guest" from "silently replaced, and now
    // permanently unregistered" is whether the DOM node itself survives,
    // which is what the property-injection check below verifies directly.
    await sharedPage.evaluate((url) => {
      window.__mockBrowser?.reset();
      window.__mockBrowser?.seedTaskUrl('task-pane-bridge', url);
    }, SEEDED_URL);

    await emitOpenRequest(sharedPage);
    await sharedPage
      .locator('[data-testid="task-detail-dialog"]')
      .waitFor({ state: 'visible', timeout: 10000 });
    await sharedPage.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 10000 });

    // Register the guest, exactly as browser-pane-refetch-guard.spec.ts does:
    // inject getWebContentsId/getURL onto the plain HTMLElement stub, then
    // fire the dom-ready listener the registration effect attached on mount.
    await sharedPage.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 5000 });
    await sharedPage.evaluate((webContentsId: number) => {
      const element = document.querySelector('[data-testid="browser-webview"]');
      if (!element) throw new Error('browser-webview element not found in DOM');
      const stub = element as HTMLElement & { getWebContentsId: () => number; getURL: () => string };
      stub.getWebContentsId = () => webContentsId;
      stub.getURL = () => SEEDED_URL;
      element.dispatchEvent(new Event('dom-ready'));
    }, MOCK_WEB_CONTENTS_ID);

    await expect
      .poll(
        async () => {
          const calls = await sharedPage.evaluate(() => window.__mockBrowser?.getPaneCalls() ?? []);
          return calls.filter((call) => call.type === 'register').length;
        },
        { timeout: 5000 },
      )
      .toBe(1);

    // The mock's getUrls normally resolves in the same microtask turn as the
    // effect's synchronous setLoading(true), so React coalesces both updates
    // into one commit and the intermediate loading state never actually
    // paints - masking a broken guard even though real IPC always has
    // non-zero latency. Delay this one refetch so the race genuinely plays
    // out the way it would in production, instead of hiding behind the
    // mock's unrealistic instant resolution. 500ms (not the ~150ms this only
    // strictly needs) so the mid-flight probe below has a comfortable margin
    // over CI's slower, more heavily loaded headless Linux runners.
    const REFETCH_DELAY_MS = 500;
    await sharedPage.evaluate((delayMs: number) => {
      const original = window.electronAPI.browser.getUrls;
      window.electronAPI.browser.getUrls = (taskId: string, projectId?: string | null) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(original(taskId, projectId)), delayMs);
        });
    }, REFETCH_DELAY_MS);

    // Re-seed (a real second open_pane call would re-seed too) and push again
    // on the SAME task/project/session: the pane is already live when this
    // arrives, which is the scenario this test targets.
    await sharedPage.evaluate((url) => {
      window.__mockBrowser?.seedTaskUrl('task-pane-bridge', url);
    }, SEEDED_URL);
    await emitOpenRequest(sharedPage);

    // Mid-flight probe: the delayed refetch above is still pending here, so
    // this is exactly the window a broken loading guard would unmount the
    // guest in. Intentional fixed wait, not a settle poll - it only needs to
    // land inside the artificial delay above, well before it resolves.
    // Empirically confirmed NOT to be this test's only discriminator: with
    // the loading guard removed, the post-settle check below (a fresh
    // <webview> can never regain the property this test injected onto the
    // original node) fails on its own too. This probe adds an earlier,
    // independent catch rather than being load-bearing by itself, so a
    // timing slip that pushes it past the delay does not silently defang
    // the test.
    await sharedPage.waitForTimeout(REFETCH_DELAY_MS / 4);
    await expect(sharedPage.locator('[data-testid="browser-pane-loading"]')).toHaveCount(0);
    const survivedMidFlight = await sharedPage.evaluate((expectedId: number) => {
      const element = document.querySelector('[data-testid="browser-webview"]') as
        | (HTMLElement & { getWebContentsId?: () => number })
        | null;
      return typeof element?.getWebContentsId === 'function' && element.getWebContentsId() === expectedId;
    }, MOCK_WEB_CONTENTS_ID);
    expect(survivedMidFlight).toBe(true);

    // Settle: the pane must still read as active, never having shown a
    // loading spinner (which would mean the guard broke and the active
    // subtree - including the <webview> - was unmounted).
    await expect(sharedPage.locator('[data-testid="browser-pane"]')).toBeVisible();
    await expect(sharedPage.locator('[data-testid="browser-pane-loading"]')).toHaveCount(0);

    // The load-bearing check: getWebContentsId is a plain JS property
    // monkeypatched onto ONE DOM node. It survives only if that exact node
    // is still mounted - a remount produces a fresh <webview> stub with no
    // injected function at all. This is what actually proves the guarantee
    // (confirmed above to independently catch a broken guard, not merely
    // corroborate the mid-flight probe).
    const survivedSameGuest = await sharedPage.evaluate((expectedId: number) => {
      const element = document.querySelector('[data-testid="browser-webview"]') as
        | (HTMLElement & { getWebContentsId?: () => number })
        | null;
      return typeof element?.getWebContentsId === 'function' && element.getWebContentsId() === expectedId;
    }, MOCK_WEB_CONTENTS_ID);
    expect(survivedSameGuest).toBe(true);

    // Corroborates the mechanism explained above: with sessionId/taskId/
    // projectId unchanged, the registration effect never re-ran on the live
    // guest, so no second register call was ever logged for it, and it was
    // never unregistered. Scoped to THIS guest's id on purpose, matching
    // browser-pane-registration.spec.ts's established convention: StrictMode
    // double-invokes mount effects, so the log also carries one throwaway
    // unregister from the initial mount (before this test injects
    // getWebContentsId), which never registered and so carries `undefined`.
    // What must never appear is a register or unregister for the id that is
    // actually driving the pane.
    const finalCalls = await sharedPage.evaluate(() => window.__mockBrowser?.getPaneCalls() ?? []);
    expect(
      finalCalls.filter((call) => call.type === 'register' && call.input.webContentsId === MOCK_WEB_CONTENTS_ID),
    ).toHaveLength(1);
    expect(
      finalCalls.filter((call) => call.type === 'unregister' && call.webContentsId === MOCK_WEB_CONTENTS_ID),
    ).toHaveLength(0);
  });

  test('a close push hides the pane but leaves the task-detail window open', async () => {
    await sharedPage.evaluate((url) => {
      window.__mockBrowser?.reset();
      window.__mockBrowser?.seedTaskUrl('task-pane-bridge', url);
    }, SEEDED_URL);

    await emitOpenRequest(sharedPage);
    const dialog = sharedPage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await sharedPage.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 10000 });

    await sharedPage.evaluate(
      ([projectId, taskId]) => window.__mockBrowser?.emitPaneCloseRequest(projectId, [taskId]),
      [PROJECT_ID, TASK_ID],
    );

    await sharedPage.locator('[data-testid="browser-pane"]').waitFor({ state: 'hidden', timeout: 10000 });
    // Closing puts the PANE away, exactly as the Browser pill does. The window
    // it lives in is the user's, and this tool never closes it.
    await expect(dialog).toBeVisible();
  });
});
