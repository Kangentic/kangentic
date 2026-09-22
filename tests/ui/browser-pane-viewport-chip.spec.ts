/**
 * The pane's viewport chip: what tells the user an agent changed the size
 * their page is rendering at.
 *
 * An override is a property of main's CDP session with the guest, and the
 * `<webview>` element never changes size, so from the pane's side the page
 * simply starts laying out at a width nothing on screen accounts for - and on
 * a docked pane it may be showing only part of that layout. The chip is the
 * only thing that says so, and its reset control is the user's way out when
 * the agent that set it has finished.
 *
 * Four assertions carry this file, and the last is the load-bearing one:
 *
 * 1. It appears on a push for THIS guest, showing the MEASURED size.
 * 2. It does NOT appear on a push for a different guest. Without the converse
 *    a chip that ignored the id entirely would pass the first assertion.
 * 3. Reset invokes the clear for this guest's id.
 * 4. The registered webContentsId is UNCHANGED across the chip appearing and
 *    disappearing. The chip is a conditional child of the pane's toolbar, and
 *    a conditional that shifted the `<webview>`'s sibling index would remount
 *    it and kill the guest - which looks identical in the DOM. A presence
 *    check passes against a brand-new guest; only the id does not.
 *    See `.claude/rules/retained-pane-never-remounts.md`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-viewport';
const TASK_ID = 'task-browser-viewport';
const SESSION_ID = 'sess-browser-viewport';
const PROJECT_PATH = '/mock/browser-viewport-test';
const MOCK_WEB_CONTENTS_ID = 7272;
const OTHER_WEB_CONTENTS_ID = 7373;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Browser Viewport Test',
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
      var id = 'lane-bv-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
      title: 'Browser Viewport Task',
      description: 'Used to drive the viewport chip',
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
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

// Each test owns its setup from a known state rather than inheriting the
// previous one's open dialog: a single flaky interaction must not cascade.
test.beforeEach(async () => {
  await sharedPage.goto(VITE_URL);
  await sharedPage.waitForLoadState('load');
  await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
  await sharedPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

function registersFor(page: Page, webContentsId: number): Promise<number> {
  return page.evaluate((id: number) => {
    const calls = window.__mockBrowser?.getPaneCalls() ?? [];
    return calls.filter((call) => call.type === 'register' && call.input.webContentsId === id).length;
  }, webContentsId);
}

function viewportClearsFor(page: Page, webContentsId: number): Promise<number> {
  return page.evaluate((id: number) => {
    const calls = window.__mockBrowser?.getPaneCalls() ?? [];
    return calls.filter((call) => call.type === 'viewport-clear' && call.webContentsId === id).length;
  }, webContentsId);
}

/** Which guest id the pane currently has registered, read from the call log. */
async function lastRegisteredId(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const calls = window.__mockBrowser?.getPaneCalls() ?? [];
    const registers = calls.filter((call) => call.type === 'register');
    const last = registers[registers.length - 1];
    return last ? last.input.webContentsId : null;
  });
}

async function openRegisteredPane(page: Page): Promise<void> {
  await page.evaluate((taskId: string) => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl(taskId, 'http://localhost:5173/');
  }, TASK_ID);

  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Browser Viewport Task').first().click();
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

function emitOverride(page: Page, webContentsId: number, measured: { width: number; height: number } | null) {
  return page.evaluate(
    ({ id, size }) => {
      window.__mockBrowser?.emitViewportOverride(
        id,
        size
          ? {
              mechanism: 'device-emulation',
              requested: size,
              measured: size,
              deviceScaleFactor: 0,
              appliedAt: new Date().toISOString(),
            }
          : null,
      );
    },
    { id: webContentsId, size: measured },
  );
}

test.describe('browser pane viewport chip', () => {
  test('is absent until an agent sets a viewport', async () => {
    await openRegisteredPane(sharedPage);
    await expect(sharedPage.locator('[data-testid="browser-viewport-chip"]')).toBeHidden();
  });

  test('shows the MEASURED viewport on a push for this guest', async () => {
    await openRegisteredPane(sharedPage);

    // 1264x761, not the 1280x800 that was requested: the chip must print what
    // the page got, or it contradicts the zoom pill sitting beside it.
    await emitOverride(sharedPage, MOCK_WEB_CONTENTS_ID, { width: 1264, height: 761 });

    const chip = sharedPage.locator('[data-testid="browser-viewport-chip"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('1264');
    await expect(chip).toContainText('761');
  });

  test('replaces the zoom pill rather than sitting beside it', async () => {
    // The two control the same thing: an override is applied pre-scaled by the
    // zoom, so a user zooming while one is active changes the viewport out
    // from under the number on the chip. One home for it, and the chip's reset
    // brings the pill back.
    await openRegisteredPane(sharedPage);
    await expect(sharedPage.locator('[data-testid="browser-zoom-pill"]')).toBeVisible();

    await emitOverride(sharedPage, MOCK_WEB_CONTENTS_ID, { width: 1920, height: 1080 });

    await expect(sharedPage.locator('[data-testid="browser-viewport-chip"]')).toBeVisible();
    await expect(sharedPage.locator('[data-testid="browser-zoom-pill"]')).toBeHidden();

    await emitOverride(sharedPage, MOCK_WEB_CONTENTS_ID, null);
    await expect(sharedPage.locator('[data-testid="browser-zoom-pill"]')).toBeVisible();
  });

  test('the chip is exactly as tall as the zoom pill it replaces', async () => {
    // Reported from a live drive: `maxWindowViewport` came back 1272 on the
    // first set_viewport of a session and 1274 on every call after it, which
    // reads as the tool contradicting itself. The toolbar is the guest's
    // sibling in a flex column, so its height is pixels the `<webview>` does
    // not get; the chip was 1.5px shorter than the pill it replaces, so the
    // page grew the moment an override landed and the window needed 2px less
    // outer height for the same viewport.
    //
    // It asserts the two PILLS match rather than that the row height is
    // unchanged, and that difference is the whole point. Docked, the row is
    // held at 28 by Close browser and the pop-out button, so a row-height
    // check passes no matter what the chip does - it passed against the bug,
    // which is how the first diagnosis went out wrong. Both of those controls
    // are hidden inside a POP-OUT window, and that is exactly where the bug
    // was reported, so the invariant has to be one that does not depend on
    // which host is rendering.
    await openRegisteredPane(sharedPage);
    const pill = sharedPage.locator('[data-testid="browser-zoom-pill"]');
    await expect(pill).toBeVisible();
    const pillHeight = (await pill.boundingBox())?.height;

    await emitOverride(sharedPage, MOCK_WEB_CONTENTS_ID, { width: 1920, height: 1080 });
    const chip = sharedPage.locator('[data-testid="browser-viewport-chip"]');
    await expect(chip).toBeVisible();
    const chipHeight = (await chip.boundingBox())?.height;

    expect(pillHeight).toBeGreaterThan(0);
    expect(chipHeight).toBe(pillHeight);
  });

  test('ignores a push for a DIFFERENT guest', async () => {
    // The converse that stops a vacuous pass: a chip wired to every push would
    // satisfy the test above while lighting up on another pane's override.
    await openRegisteredPane(sharedPage);

    await emitOverride(sharedPage, OTHER_WEB_CONTENTS_ID, { width: 1920, height: 1080 });

    await expect(sharedPage.locator('[data-testid="browser-viewport-chip"]')).toBeHidden();
  });

  test('reset invokes the clear for this guest and takes the chip away', async () => {
    await openRegisteredPane(sharedPage);
    await emitOverride(sharedPage, MOCK_WEB_CONTENTS_ID, { width: 1920, height: 1080 });
    await expect(sharedPage.locator('[data-testid="browser-viewport-chip"]')).toBeVisible();

    await sharedPage.locator('[data-testid="browser-viewport-reset"]').click();

    await expect
      .poll(() => viewportClearsFor(sharedPage, MOCK_WEB_CONTENTS_ID), { timeout: 5000 })
      .toBeGreaterThan(0);
    await expect(sharedPage.locator('[data-testid="browser-viewport-chip"]')).toBeHidden();
  });

  test('keeps the SAME guest across the chip appearing and disappearing', async () => {
    // The assertion that catches a remount. The chip is a conditional child of
    // the pane toolbar; if it ever shifted the <webview>'s sibling index, React
    // would rebuild the element and the guest, its page and the agent's handle
    // would all be silently replaced by identical-looking ones.
    await openRegisteredPane(sharedPage);
    expect(await lastRegisteredId(sharedPage)).toBe(MOCK_WEB_CONTENTS_ID);

    await emitOverride(sharedPage, MOCK_WEB_CONTENTS_ID, { width: 1920, height: 1080 });
    await expect(sharedPage.locator('[data-testid="browser-viewport-chip"]')).toBeVisible();
    expect(await lastRegisteredId(sharedPage)).toBe(MOCK_WEB_CONTENTS_ID);

    await emitOverride(sharedPage, MOCK_WEB_CONTENTS_ID, null);
    await expect(sharedPage.locator('[data-testid="browser-viewport-chip"]')).toBeHidden();

    expect(await lastRegisteredId(sharedPage)).toBe(MOCK_WEB_CONTENTS_ID);
    // And nothing unregistered it along the way, which is the other half of
    // "the same guest": a remount unregisters the old id before registering a
    // new one.
    const unregisters = await sharedPage.evaluate((id: number) => {
      const calls = window.__mockBrowser?.getPaneCalls() ?? [];
      return calls.filter((call) => call.type === 'unregister' && call.webContentsId === id).length;
    }, MOCK_WEB_CONTENTS_ID);
    expect(unregisters).toBe(0);
  });
});
