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
import { test, expect, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { startDemoServer } from '../../demo/static-server.mjs';
import { isBenignRendererError } from '../ui/helpers';
import { SCENES } from '../captures/scenes';
import {
  DEMO_LANES_BY_PROJECT, DEMO_SESSIONS, PROJECT_CONTOSO,
  SESSION_MIDDLEWARE, SESSION_RATE_LIMIT, SESSION_WEBSOCKET, TASK_MIDDLEWARE,
} from '../captures/helpers/demo-dataset';

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

/** The scenes the web build can boot by name; a driver scene is the rig's and is refused here. */
const BOOTABLE_SCENES = Object.values(SCENES).filter((scene) => scene.reach !== 'driver');

/**
 * Deeper assertions for the scenes other tests in this file build on, beyond the `ready` selector
 * every entry carries: the element a visitor would recognize the scene by, with the counts the
 * sample install fixes. Every bootable scene is booted below whether or not it has one of these.
 */
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
  'column-handoff': async (page) => {
    // The scene's __mockSwimlanePatches seed only takes effect if hydrateSeededSwimlanePatches
    // actually finds and patches the Code Review lane; the `ready` selector alone (the tab having
    // switched) proves nothing about the patch landing. OverviewToggle renders the column page's
    // own read-only ToggleSwitch, so this is the same aria-checked a visitor would read.
    const reviewRow = page.locator('[data-testid="board-manager-overview-row"]').filter({ hasText: 'Code Review' });
    await expect(reviewRow.getByRole('switch', { name: 'Hand off context when the agent changes' })).toHaveAttribute('aria-checked', 'true');
    // Sibling negative: every other lane keeps handoff_context false in the dataset, so this is
    // what makes the scene's own alt text ("Handoff is on for Code Review alone") falsifiable
    // rather than the switch simply always reading on.
    const executingRow = page.locator('[data-testid="board-manager-overview-row"]').filter({ hasText: 'Executing' });
    await expect(executingRow.getByRole('switch', { name: 'Hand off context when the agent changes' })).toHaveAttribute('aria-checked', 'false');
  },
  'session-states': async (page) => {
    // The scene's `ready` selector (the Onboarding empty states card existing at all) resolves
    // whether or not demo/boot.js's new session.status patch actually landed: that card is in the
    // sample install either way. CardStatusBar's own testid is what a visitor reads the state from.
    const pausedCard = page.locator('[data-task-id="task-cw-empty-states"]');
    await expect(pausedCard.locator('[data-testid="status-bar"]')).toContainText('Paused');
    const queuedCard = page.locator('[data-task-id="task-cw-rate-limit"]');
    await expect(queuedCard.locator('[data-testid="status-bar"]')).toContainText('Queued');
    // Sibling negative, in the SAME boot rather than a second one: the scene's own click step
    // targets the middleware session, which the patch does not name and which stays 'running' in
    // the dataset, so its card keeps the running footer instead of picking up Paused or Queued
    // from a patch that landed on the wrong row.
    const middlewareCard = page.locator(`[data-task-id="${TASK_MIDDLEWARE}"]`);
    await expect(middlewareCard.locator('[data-testid="usage-bar"]')).toBeVisible();
    await expect(middlewareCard.locator('[data-testid="status-bar"]')).toHaveCount(0);
  },
  'activity-overlay': async (page) => {
    const overlay = page.locator('[data-testid="activity-debug-overlay"]');
    // `ready` only waits for this element to mount, which happens as soon as ANY session in the
    // project is 'running' - with or without real snapshot data (ActivityDebugOverlayContent
    // renders on `projectSessionIds.length > 0` alone). If activityStatsCache never populated, or
    // activityStatsFor threw while the seed built it, the panel falls back to its own "no state"
    // diagnostic instead of failing the boot, which the ready gate would not catch.
    await expect(overlay).not.toContainText('Activity engine has no state');
    // One row per running contoso-web session, proving activityStatsCache was populated for
    // every one of them and not just enough to dodge the diagnostic above.
    const runningContosoSessionIds = DEMO_SESSIONS
      .filter((session) => session.projectId === PROJECT_CONTOSO && session.status === 'running')
      .map((session) => session.id);
    for (const sessionId of runningContosoSessionIds) {
      await expect(overlay.locator(`[data-session-id="${sessionId}"]`)).toBeVisible();
    }
    // The derived reason branches, read off one session of each activity kind: activityStatsFor's
    // three-way switch (permission / thinking-with-tool / idle) drives the pill label straight
    // from the seeded session, so a wrong branch here means the derivation broke, not the wiring
    // checked above. currentTool is the seeded session's own last event, not an invented value.
    const middlewareRow = overlay.locator(`[data-session-id="${SESSION_MIDDLEWARE}"]`);
    await expect(middlewareRow).toContainText('Thinking');
    await expect(middlewareRow).toContainText('running Bash');
    await expect(overlay.locator(`[data-session-id="${SESSION_WEBSOCKET}"]`)).toContainText('Awaiting permission');
    await expect(overlay.locator(`[data-session-id="${SESSION_RATE_LIMIT}"]`)).toContainText('Idle');
  },
};

test('every deep marker names a scene the build can boot', () => {
  // A marker for a renamed or retired scene would otherwise sit here asserting nothing.
  const bootableNames = new Set(BOOTABLE_SCENES.map((scene) => scene.name));
  for (const name of Object.keys(SCENE_MARKERS)) expect(bootableNames.has(name), `SCENE_MARKERS.${name}`).toBe(true);
});

for (const scene of BOOTABLE_SCENES) {
  test(`view=${scene.name} boots to its ready element with a clean console`, async ({ page }) => {
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    await gotoScene(page, { view: scene.name, embed: '1', still: '1' });
    await expect(page.locator('html')).toHaveAttribute('data-demo-scene', scene.name);
    // boot.js waited for this before it revealed; asserting it VISIBLE is the half boot.js cannot
    // see, since it polls for existence and a mounted-but-hidden element would pass it.
    await expect(page.locator(scene.ready).first()).toBeVisible();
    const deepMarker = SCENE_MARKERS[scene.name];
    if (deepMarker) await deepMarker(page);
    if (scene.focus) {
      // A focus the site crops to must be a real region: not a missing element (the ready
      // message would carry null), not a zero box, and not the whole frame (the Quick Find
      // scenes once named the palette's full-frame backdrop, which crops to nothing).
      const focusRect = await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { w: box.width / window.innerWidth, h: box.height / window.innerHeight };
      }, scene.focus);
      expect(focusRect, `${scene.name}.focus (${scene.focus}) matches no element`).not.toBeNull();
      const focusArea = (focusRect?.w ?? 0) * (focusRect?.h ?? 0);
      expect(focusArea, `${scene.name}.focus is an empty box`).toBeGreaterThan(0);
      expect(focusArea, `${scene.name}.focus is the whole frame`).toBeLessThan(0.95);
    }
    expect(getUnexpectedErrors()).toEqual([]);
  });
}

test('a driver scene is refused by name, with the rig named as the way to build it', async ({ page }) => {
  const driverScene = Object.values(SCENES).find((scene) => scene.reach === 'driver');
  if (!driverScene) throw new Error('the registry has no driver scene to refuse; add one or drop this test');
  await page.goto(demoUrl({ view: driverScene.name, embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText(`Scene "${driverScene.name}" needs the capture rig`);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');
});

test('scenes.json is served unhashed, matches the registry, and names the build version', async ({ page, request }) => {
  const response = await request.get(`${server.url}scenes.json`);
  expect(response.ok(), 'scenes.json is not served beside index.html').toBe(true);
  const manifest = await response.json() as { version: string; frame: { width: number; height: number }; scenes: Array<{ name: string; reach: string; alt: string; description: string }> };
  expect(manifest.frame).toEqual({ width: 1600, height: 1000 });
  expect(manifest.scenes.map((scene) => scene.name)).toEqual(Object.keys(SCENES));
  for (const scene of manifest.scenes) {
    expect(scene.reach, scene.name).toBe(SCENES[scene.name].reach);
    expect(scene.alt.trim(), `${scene.name}.alt`).not.toBe('');
  }
  // The version a docs page stamps on its figure is the one the frame itself reports.
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  const frameVersion = await page.evaluate(() => (window as { __demoVersion?: string }).__demoVersion);
  expect(manifest.version).toBe(frameVersion);
});

interface DemoReadyMessage { type: string; scene: string | null; version: string; focus: { x: number; y: number; w: number; h: number } | null }

/**
 * Host the frame in an iframe the way the site does and return the ready message it posts.
 * boot.js posts to its parent only when it has one, so a top-level visit observes nothing.
 */
async function readyMessageFor(page: Page, sceneName: string): Promise<DemoReadyMessage> {
  const src = demoUrl({ view: sceneName, embed: '1', still: '1' });
  await page.setContent(
    '<script>window.__demoMessages = []; window.addEventListener("message", (event) => { window.__demoMessages.push(event.data); });</script>'
    + `<iframe id="demo" width="1600" height="1000" style="border:0" src="${src}"></iframe>`,
  );
  await expect(page.frameLocator('#demo').locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });
  const readMessages = () => page.evaluate(() => (window as { __demoMessages?: DemoReadyMessage[] }).__demoMessages ?? []);
  await expect.poll(async () => (await readMessages()).some((message) => message.type === 'kangentic-demo-ready')).toBe(true);
  const message = (await readMessages()).find((candidate) => candidate.type === 'kangentic-demo-ready');
  if (!message) throw new Error('no ready message');
  return message;
}

test('the ready message carries the focus rect of a dialog scene, and null for a scene without one', async ({ page }) => {
  // A dialog, not a popover: the New Task dialog is a large centred box, so a rect that is not
  // its box (a null, a zero, the whole frame) is unmistakable.
  const focusScene = SCENES['new-task'];
  expect(focusScene.focus, 'the new-task scene stopped naming a focus element').toBeDefined();

  const focused = await readyMessageFor(page, focusScene.name);
  expect(focused.scene).toBe(focusScene.name);
  expect(focused.focus).not.toBeNull();
  for (const value of Object.values(focused.focus ?? {})) {
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  }
  const area = (focused.focus?.w ?? 0) * (focused.focus?.h ?? 0);
  expect(area, 'the dialog covers a real region of the frame').toBeGreaterThan(0.1);
  expect(area, 'the dialog is not the whole frame').toBeLessThan(0.9);

  const plain = await readyMessageFor(page, 'board');
  expect(plain.scene).toBe('board');
  expect(plain.focus).toBeNull();
});

/** Host the frame in an iframe the site's way and hand back the frame plus a message reader. */
async function hostFrame(page: Page, sceneName: string): Promise<() => Promise<DemoReadyMessage[]>> {
  const src = demoUrl({ view: sceneName, embed: '1', still: '1' });
  await page.setContent(
    '<script>window.__demoMessages = []; window.addEventListener("message", (event) => { window.__demoMessages.push(event.data); });</script>'
    + `<iframe id="demo" width="1600" height="1000" style="border:0" src="${src}"></iframe>`,
  );
  await expect(page.frameLocator('#demo').locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });
  return () => page.evaluate(() => (window as { __demoMessages?: DemoReadyMessage[] }).__demoMessages ?? []);
}

const hasEscape = (messages: DemoReadyMessage[]) => messages.some((message) => message.type === 'kangentic-demo-escape');

/**
 * Focus an element inside the cross-origin `#demo` iframe and wait for the TOP-LEVEL browsing
 * context's focus to actually land there before returning.
 *
 * `Locator.focus()` calls the element's `focus()` inside the iframe's own renderer, which
 * updates that document's `activeElement` immediately. But `page.keyboard.press()` at the top
 * level dispatches through whichever frame the BROWSER PROCESS currently believes is focused,
 * and for a cross-origin iframe that hand-off is a separate, asynchronous step (an IPC round
 * trip between renderer processes on Chromium). Pressing Escape right after `.focus()` can race
 * that hand-off: the key lands on the top-level document (which has no listener) instead of the
 * iframe, so the dialog never sees it and stays open until Playwright's retry. `document.hasFocus()`,
 * read from INSIDE the iframe, reflects the browser process's actual routing rather than just the
 * iframe's local `activeElement`, so polling it (instead of a fixed pad) makes the wait real.
 */
async function focusAcrossFrame(locator: Locator): Promise<void> {
  await locator.focus();
  await expect
    .poll(() => locator.evaluate((element) => document.hasFocus() && document.activeElement === element))
    .toBe(true);
}

test('Escape posts an escape message when the app has nothing of its own to close', async ({ page }) => {
  // The case a host cannot handle itself: keyboard focus is inside the cross-origin frame, on the
  // terminal's textarea, where the renderer's arrival-focus arbiter puts it, so every key goes
  // there and no listener on the parent page ever sees one.
  const readMessages = await hostFrame(page, 'board');
  const textarea = page.frameLocator('#demo').locator('.xterm-helper-textarea').first();
  await textarea.waitFor({ state: 'attached', timeout: READY_TIMEOUT_MS });
  await textarea.focus();
  // The keyboard, not `locator('#demo').press()`: that form focuses the iframe ELEMENT first, so
  // the keystroke reaches the textarea only by Chromium restoring the frame's previously focused
  // descendant. That is the one thing this test is proving, so it must not also be the mechanism.
  await page.keyboard.press('Escape');

  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
  const escape = (await readMessages()).find((message) => message.type === 'kangentic-demo-escape');
  expect(escape?.scene).toBe('board');
});

test('Escape posts nothing while a plain text field is focused, with no dialog or window involved', async ({ page }) => {
  // The BASE rule the xterm-helper-textarea case above carves its one exemption out of: a focused
  // INPUT/TEXTAREA/contenteditable blocks the post on its own, with no dialog and no restored
  // window anywhere in the DOM. The board scene's search field is always mounted (no click needed
  // to reveal it), which is what keeps this rung 1 rather than accidentally exercising rung 2
  // ([data-dismissable-layer]) or rung 3 ([data-testid^="window-frame-"]).
  const readMessages = await hostFrame(page, 'board');
  const frame = page.frameLocator('#demo');
  // Pin the isolation: nothing in the DOM could make this pass on rung 2 or 3 instead of rung 1.
  await expect(frame.locator('[data-dismissable-layer]')).toHaveCount(0);
  await expect(frame.locator('[data-testid^="window-frame-"]')).toHaveCount(0);

  const searchInput = frame.locator('[data-testid="board-search"]');
  await searchInput.focus();
  await page.keyboard.press('Escape');
  // Fixed wait, not a poll: this is a negative assertion (nothing posted). Polling "is it still
  // false" would pass the instant it is called, whether or not the guard is even wired up.
  await page.waitForTimeout(500);
  expect(hasEscape(await readMessages()), 'a focused text field owns Escape before xterm is ever asked').toBe(false);

  // Positive control, same frame: focusing the terminal's helper textarea (the one exemption)
  // does post, so the absence above is the base rule firing rather than dead plumbing.
  const textarea = frame.locator('.xterm-helper-textarea').first();
  await textarea.waitFor({ state: 'attached', timeout: READY_TIMEOUT_MS });
  await textarea.focus();
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
});

test('Escape posts nothing while the app owns it, and the app closes its own surface', async ({ page }) => {
  // Each case settles on the app's OWN visible answer (the surface closing), never on a timer:
  // that is both the proof the keystroke was processed and the behaviour being asserted. A
  // second Escape, which this does not press, is what would then reach the host.
  //
  // Both cases focus a BUTTON inside the frame and press through the frame's own keyboard, for two
  // separate reasons. `page.locator('#demo').press()` focuses the iframe ELEMENT, so the key
  // reaches the frame's content only if Chromium restores the frame's previously focused
  // descendant: it does on Windows and does NOT on the headless Linux runner, where this read
  // green locally and red on every CI push. And a button rather than a text field keeps each case
  // on the rung it is named for, since a focused input would satisfy rung 1 first and the assertion
  // would hold for the wrong reason (rung 1 has its own test above).
  const readDialogMessages = await hostFrame(page, 'new-task');
  const dialog = page.frameLocator('#demo').locator('[data-testid="new-task-dialog"]');
  await expect(dialog).toBeVisible();
  await focusAcrossFrame(dialog.getByRole('button', { name: 'Cancel' }));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(hasEscape(await readDialogMessages()), 'a dialog owns the first Escape').toBe(false);

  // A restored task window owns it the same way, through the [data-testid^="window-frame-"] rung.
  const readWindowMessages = await hostFrame(page, 'task');
  const frame = page.frameLocator('#demo');
  const detail = frame.locator('[data-testid="task-detail-titlebar"]');
  await expect(detail).toBeVisible();
  // Pin the isolation the way the rung-1 test does: no dialog is open, so this can only be rung 3.
  await expect(frame.locator('[data-dismissable-layer]')).toHaveCount(0);
  await focusAcrossFrame(frame.locator('[data-testid="task-detail-close"]'));
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  expect(hasEscape(await readWindowMessages()), 'a task window owns the first Escape').toBe(false);
});

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

test('both product ids resolve, and every spelling the site may have written still lands', async ({ page }) => {
  // The site embeds this frame by URL, so these spellings are its contract: the ids, the bare
  // `kangentic` alias, and the pair's short-lived earlier ids. Nothing ties demo/boot.js's
  // APP_THEMES to ThemeMode in src/shared/types.ts, which makes this the only mechanical guard
  // that a theme added to the type is reachable from the web build at all.
  for (const [requested, expected] of [
    ['clay', 'theme-clay'],
    ['rust', 'theme-rust'],
    ['kangentic', 'theme-clay'],
    ['kangentic-light', 'theme-clay'],
    ['kangentic-dark', 'theme-rust'],
  ]) {
    await gotoScene(page, { view: 'board', theme: requested, embed: '1', still: '1' });
    const themeClasses = await page.evaluate(() =>
      Array.from(document.documentElement.classList).filter((className) => className.startsWith('theme-')),
    );
    expect(themeClasses, `?theme=${requested}`).toEqual([expected]);
  }
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

test('the emitted config-shape guard omits a block with no populated default', async ({ page }) => {
  // nestedConfigShape() (demo/vite.config.mts) is what lets boot.js refuse a state= blob naming
  // only part of a nested config block ("a state= blob naming only part of a nested config block
  // is refused", above); nothing asserted its SKIP branches actually leave a block out rather than
  // emitting it empty. Read off the real built asset rather than re-implemented here: the function
  // is private to the Vite config, and reaching it would need either exporting it (a production
  // change with no other motivation) or importing dist/demo from the unit tier, which breaks tier
  // isolation (web-demo-parity.md) - so this lives in the tier that already boots the real build.
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  const shape = await page.evaluate(() => (window as { __demoConfigShape?: Record<string, string[]> }).__demoConfigShape ?? {});
  // A populated object block is kept, with every field named.
  expect(Object.keys(shape)).toContain('monitor');
  expect(shape.monitor).toContain('layout');
  // A zero-key object default (a project-keyed map with nothing in DEFAULT_CONFIG) is skipped.
  expect(Object.keys(shape)).not.toContain('workspaceByProject');
  // A primitive default is skipped.
  expect(Object.keys(shape)).not.toContain('theme');
  // A null default is skipped.
  expect(Object.keys(shape)).not.toContain('commandTerminalWorkspace');
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
interface DemoRecordingsWindow {
  __demoRecordings: { base: string; sessions: Record<string, { file: string; cols: number; rows: number }> };
  __demoScrollback: Record<string, string>;
}
interface DemoElectronWindow {
  electronAPI: {
    sessions: {
      list: () => Promise<DemoSessionRow[]>;
      getActivity: () => Promise<Record<string, string>>;
      onData: (callback: (sessionId: string, data: string) => void) => () => void;
      __resizeCalls?: Array<{ sessionId: string; cols: number; rows: number }>;
    };
    tasks: { list: () => Promise<DemoTaskRow[]> };
  };
}

interface DemoMonitorWindow {
  __mockMonitorRows?: Array<{ sessionId: string; activity: string; outputPeek?: string[] }>;
}

/** The Monitor row state the mock publishes: what a card shows without opening a terminal. */
function monitorRow(page: Page, sessionId: string): Promise<{ activity: string; peek: string } | null> {
  return page.evaluate((id) => {
    const row = ((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).find((candidate) => candidate.sessionId === id);
    return row ? { activity: row.activity, peek: (row.outputPeek ?? []).join(' | ') } : null;
  }, sessionId);
}

/** How many DISTINCT output peeks a session's Monitor row shows over the given span. */
async function countPeekChanges(page: Page, sessionId: string, spanMs: number): Promise<number> {
  return page.evaluate(({ id, span }) => new Promise<number>((resolve) => {
    let previous: string | null = null;
    let changes = 0;
    const timer = setInterval(() => {
      const row = ((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).find((candidate) => candidate.sessionId === id);
      const peek = (row?.outputPeek ?? []).join(' | ');
      if (previous !== null && peek !== previous) changes += 1;
      previous = peek;
    }, 100);
    setTimeout(() => { clearInterval(timer); resolve(changes); }, span);
  }), { id: sessionId, span: spanMs });
}

/** The message trail a session's Monitor card is rendering right now, empty when it draws none. */
function readTrail(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => {
    // Scoped to the card: a terminal tab in the board's bottom panel carries the same id.
    const card = document.querySelector(`[data-testid="monitor-card"][data-session-id="${id}"]`);
    return card?.querySelector('[data-testid="monitor-card-trail"]')?.textContent ?? '';
  }, sessionId);
}

/**
 * How many DISTINCT message trails a session's Monitor CARD renders over the given span.
 *
 * The rendered text, not the mock's state: the point of the trail is what a visitor reads on the
 * card, and the peek counterpart above deliberately measures the row instead.
 */
async function countTrailChanges(page: Page, sessionId: string, spanMs: number): Promise<number> {
  return page.evaluate(({ id, span }) => new Promise<number>((resolve) => {
    let previous: string | null = null;
    let changes = 0;
    const read = (): string => {
      // Scoped to the card: a terminal tab in the board's bottom panel carries the same id.
      const card = document.querySelector(`[data-testid="monitor-card"][data-session-id="${id}"]`);
      return card?.querySelector('[data-testid="monitor-card-trail"]')?.textContent ?? '';
    };
    const timer = setInterval(() => {
      const text = read();
      if (previous !== null && text !== previous) changes += 1;
      previous = text;
    }, 100);
    setTimeout(() => { clearInterval(timer); resolve(changes); }, span);
  }), { id: sessionId, span: spanMs });
}

/**
 * A task-detail window on "Add rate limiting", whose session the board seeds IDLE. Same shape as
 * the task scene's workspace, so the window mounts its terminal on the grid the recording fits
 * and takes the live path rather than the frame fallback.
 */
const RATE_LIMIT_WINDOW_STATE = {
  config: {
    workspaceByProject: {
      'proj-contoso-web': {
        version: 1,
        windows: [{
          taskId: 'task-cw-rate-limit',
          kind: 'task-detail',
          title: 'Add rate limiting',
          geometry: { x: 0.21, y: 0.15, w: 0.58, h: 0.7 },
          restoreGeometry: null,
          state: 'floating',
        }],
        tileTree: null,
        tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
        focusedTaskId: 'task-cw-rate-limit',
      },
    },
  },
};

function encodeState(state: unknown): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

/** Total bytes the mock delivers for one session over the given span, through its own data path. */
function streamedBytes(page: Page, sessionId: string, spanMs: number): Promise<number> {
  return page.evaluate(({ id, span }) => new Promise<number>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    let total = 0;
    const unsubscribe = api.sessions.onData((candidate, data) => {
      if (candidate === id) total += data.length;
    });
    setTimeout(() => { unsubscribe(); resolve(total); }, span);
  }), { id: sessionId, span: spanMs });
}

function recordingRequests(page: Page): () => string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/recordings/')) urls.push(request.url());
  });
  return () => urls.slice();
}

/**
 * Resolves with the first session id the mock's onData listeners deliver bytes for. `only` scopes
 * it to one session, which every caller wants: the sample install's pre-seeded working sessions
 * now play frames into whatever terminal is mounted, so an unscoped listener resolves on whoever
 * happens to repaint first rather than on the session the test started.
 */
function firstStreamedSession(page: Page, timeoutMs: number, only?: string): Promise<string | null> {
  return page.evaluate(({ timeout, wanted }) => new Promise<string | null>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    // Whatever the sample install already has running: those play their recordings' frames into
    // whichever terminal is mounted, so without this the listener resolves on whoever repaints
    // first rather than on the session the test started. A spawn's id is minted at spawn time,
    // so it cannot be named up front; not being one of these is what identifies it.
    const seeded = new Set(((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).map((row) => row.sessionId));
    const timer = setTimeout(() => resolve(null), timeout);
    const unsubscribe = api.sessions.onData((sessionId, data) => {
      if (!data) return;
      if (wanted === null ? seeded.has(sessionId) : sessionId !== wanted) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(sessionId);
    });
  }), { timeout: timeoutMs, wanted: only ?? null });
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

/**
 * Every grid the renderer has sent the mock for the session. A terminal main HOLDS at a grid sends
 * that grid once it has conformed (its own xterm resize reports it), and keeps probing with its
 * natural grid afterwards, so the LAST call is not the grid it shows; the held grid appearing in
 * the list is what says the terminal conformed (see the hold in demo-dataset.ts's resize wrapper).
 */
function sentGrids(page: Page, sessionId: string): Promise<Grid[]> {
  return page.evaluate((id) => {
    const calls = (window as unknown as DemoElectronWindow).electronAPI.sessions.__resizeCalls ?? [];
    return calls.filter((call) => call.sessionId === id).map((call) => ({ cols: call.cols, rows: call.rows }));
  }, sessionId);
}

/** The grid the middleware session was recorded at (tests/captures/fixtures/demo/manifest.json, a Claude task window). */
const MIDDLEWARE_RECORDED_GRID: Grid = { cols: 154, rows: 37 };

/** The same session's tiled recording (manifest geometry taskWindowTiled, measured at the rig's 2x launch). */
const MIDDLEWARE_TILED_GRID: Grid = { cols: 115, rows: 37 };

/**
 * The same, for the Copilot rate-limit session. Claude's context bar wraps to two rows and every
 * other agent's does not, so a non-Claude session records two rows taller (manifest geometry,
 * rowsByAgent).
 */
const RATE_LIMIT_RECORDED_GRID: Grid = { cols: 154, rows: 39 };

/**
 * Every frame the mock paints into a terminal on the frames path, parsed: the rows between the
 * autowrap-off and autowrap-on brackets, each measured in cells (code points plus cursor-forward
 * gaps; the sample install's frames carry no wide glyph). What the bottom-panel case asserts on.
 */
function paintedFrameRowWidths(page: Page, sessionId: string, spanMs: number): Promise<number[][]> {
  return page.evaluate(({ id, span }) => new Promise<number[][]>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const frames: number[][] = [];
    const unsubscribe = api.sessions.onData((candidate, data) => {
      if (candidate !== id) return;
      const start = data.indexOf('\x1b[?7l');
      const end = data.lastIndexOf('\x1b[?7h');
      if (start === -1 || end === -1 || end < start) return;
      frames.push(data.slice(start + 5, end).split('\r\n').map((row) => {
        const text = row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        const gaps = (row.match(/\x1b\[(\d*)C/g) ?? []).reduce((sum, move) => sum + Number(move.replace(/\D/g, '') || '1'), 0);
        return Array.from(text).length + gaps;
      }));
    });
    setTimeout(() => { unsubscribe(); resolve(frames); }, span);
  }), { id: sessionId, span: spanMs });
}

/**
 * A spawn's boot has to ARRIVE, whichever path carries it. Bytes replay only into a terminal whose
 * grid equals the recording's; any other grid plays the recording's frames instead. Both reach the
 * page through the mock's onData path, which is what the bottom-panel case below proves at a grid
 * no font size can ever reconcile, so one listener observes either path and the grid does not have
 * to be classified first.
 *
 * `streamed` is armed by the caller BEFORE the spawn, and that timing is the whole point: a boot
 * recording is short and plays out in seconds, so a listener attached after the fact hears an
 * already-finished session and reports silence. An earlier version classified the grid first and
 * only then attached a listener on the non-fitting branch. That branch is unreachable on a machine
 * whose fonts fit the recorded grid, so it went green on Windows and failed on CI's Linux runner,
 * where it spent its whole budget waiting for a fit that never comes and then heard nothing.
 */
async function expectStreamedOrStill(page: Page, sessionId: string, streamed: Promise<string | null>): Promise<void> {
  expect(await streamed).toBe(sessionId);
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

/** Each row of a painted frame in cells: the text between the autowrap brackets, plus its cursor-forward gaps. */
function frameRowWidths(frame: string): number[] {
  const start = frame.indexOf('\x1b[?7l');
  const end = frame.lastIndexOf('\x1b[?7h');
  if (start === -1 || end === -1 || end < start) return [];
  return frame.slice(start + 5, end).split('\r\n').map((row) => {
    const text = row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const gaps = (row.match(/\x1b\[(\d*)C/g) ?? []).reduce((sum, move) => sum + Number(move.replace(/\D/g, '') || '1'), 0);
    return Array.from(text).length + gaps;
  });
}

test('a still terminal narrower than its recording and not held paints the open frame cut to its grid', async ({ page }) => {
  // The probe that found the gap: the changes scene with the divider at a quarter of the width
  // leaves the terminal well below the hold floor, so the still paints its recording's opening
  // frame into a grid the frame's rows are wider than. Raw, every row wrapped mid-word; fitted,
  // each is cut at the edge the way the live frame's applier cuts it.
  const getRecordingRequests = recordingRequests(page);
  const narrow = { tasks: [{ id: 'task-cw-middleware', detail_view_state: JSON.stringify({ changesOpen: true, changesViewMode: 'split', changesSelectedFile: 'server/routes.ts', changesScope: 'branch', dividerRatio: 0.25 }) }] };
  await gotoScene(page, { view: 'changes', embed: '1', still: '1', state: encodeState(narrow) });
  await SCENE_MARKERS.changes(page);
  const grid = await mountedGrid(page, 'sess-cw-middleware');
  expect(grid).not.toBeNull();
  // Narrower than either layout's recording and past the hold floor, so the terminal kept its own grid.
  expect((grid as Grid).cols).toBeLessThan(MIDDLEWARE_TILED_GRID.cols * 0.6);
  const painted = await page.evaluate(() => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback('sess-cw-middleware'));
  const widths = frameRowWidths(painted);
  expect(widths.length, 'the still was handed over without the autowrap bracket').toBeGreaterThan(0);
  expect(Math.max(...widths)).toBe((grid as Grid).cols);
  expect(getRecordingRequests()).toEqual([]);
});

test('the conversation scene shows the transcript recorded beside the middleware session', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  const transcriptRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/transcripts/')) transcriptRequests.push(request.url()); });
  await gotoScene(page, { view: 'conversation', embed: '1', still: '1' });
  await expect(page.locator('[data-testid="conversation-window"]')).toBeVisible();
  await expect(page.locator('[data-testid="conversation-title"]')).toContainText('Extract auth middleware');
  // Rendered from the transcript, not the mock's empty default. The viewer follows a running
  // session to its newest turn, so what is on screen is the agent's closing message: the same
  // line the recording's trail ends on (tests/unit/demo-transcript-seeded.test.ts ties the two).
  await expect(page.locator('[data-testid="conversation-row-assistant"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="conversation-view"]')).toContainText('Typecheck is clean and the suite passes');
  await expect(page.locator('[data-testid="conversation-empty"]')).toHaveCount(0);
  // The transcript is its own lazy asset: one fetch for the viewer, none of the recordings.
  expect(transcriptRequests).toHaveLength(1);
  const transcript = await (await page.request.get(transcriptRequests[0])).json() as { entries?: unknown[] };
  expect(Array.isArray(transcript.entries) && transcript.entries.length > 10).toBe(true);
  expect(getRecordingRequests()).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('the tiled task windows take each session\'s tiled recording, held at its grid, on the session\'s own clock', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'windows-tiled', embed: '1' });
  for (const [sessionId, fileStem] of [['sess-cw-middleware', 'contoso-web-claude-middleware'], ['sess-cw-api-client', 'contoso-web-claude-api-client']] as const) {
    await expect.poll(() => sentGrids(page, sessionId), { timeout: 10_000 }).not.toHaveLength(0);
    // The pane's natural width decides the layout (a pane narrower than the single recording
    // takes the tiled one); the font metrics decide the natural width, and they differ between
    // Windows and CI's Linux, so the expectation follows the width the page measured.
    const natural = (await sentGrids(page, sessionId))[0];
    const tiled = natural.cols < MIDDLEWARE_RECORDED_GRID.cols;
    const expectedGrid = tiled ? MIDDLEWARE_TILED_GRID : MIDDLEWARE_RECORDED_GRID;
    if (natural.cols !== expectedGrid.cols || natural.rows !== expectedGrid.rows) {
      await expect.poll(() => sentGrids(page, sessionId), { timeout: 10_000 }).toContainEqual(expectedGrid);
    }
    const expectedFile = tiled ? `${fileStem}-tiled-` : `${fileStem}-`;
    await expect.poll(() => getRecordingRequests().some((url) => url.includes(`/recordings/${expectedFile}`)), { timeout: 15_000 }).toBe(true);
    if (tiled) expect(getRecordingRequests().some((url) => url.includes(`/recordings/${fileStem}-`) && !url.includes('-tiled-'))).toBe(false);
  }
  // A variant is a second run with its own length, played from the moment the SESSION's clock
  // began, and the clock stays the single recording's. A tiled window therefore opens partway
  // into the variant and the session goes on working for the stretch its single recording has
  // left, whether or not the variant has more to stream. Re-basing the clock on the variant used
  // to finish the session the moment its window opened, which CI's Linux runner caught (its
  // fonts put the 125 percent display on the tiled layout too).
  for (const sessionId of ['sess-cw-middleware', 'sess-cw-api-client']) {
    expect((await monitorRow(page, sessionId))?.activity, `${sessionId} finished when its tiled window opened`).toBe('thinking');
  }
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a still paints a working session at the moment the live frame opens it', async ({ page }) => {
  // The auth-middleware recording ran until Claude finished. The live frame opens it 90 seconds
  // before that end and streams the rest; a still paints that same moment (the open frame the
  // capture script kept beside the end), so both read working and neither shows the finished
  // answer at first. The flaky-test recording was cut mid-work, shorter than the tail, so its
  // still is its end and it reads working too.
  const readFrames = () => page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const demo = window as unknown as DemoRecordingsWindow;
    const endFrameOf = async (id: string) => ((await (await fetch(demo.__demoRecordings.base + demo.__demoRecordings.sessions[id].file)).json()) as { serialized: string }).serialized;
    return {
      activity: await api.sessions.getActivity(),
      middlewareSeeded: demo.__demoScrollback['sess-cw-middleware'].length,
      middlewareIsEnd: demo.__demoScrollback['sess-cw-middleware'] === await endFrameOf('sess-cw-middleware'),
      flakyIsEnd: demo.__demoScrollback['sess-pc-flaky-tests'] === await endFrameOf('sess-pc-flaky-tests'),
    };
  });
  await gotoScene(page, { view: 'board', still: '1' });
  await SCENE_MARKERS.board(page);
  const still = await readFrames();
  expect(still.activity['sess-cw-middleware']).toBe('thinking');
  expect(still.activity['sess-pc-flaky-tests']).toBe('thinking');
  expect(still.middlewareSeeded).toBeGreaterThan(0);
  expect(still.middlewareIsEnd).toBe(false);
  expect(still.flakyIsEnd).toBe(true);
  await gotoScene(page, { view: 'board' });
  await SCENE_MARKERS.board(page);
  const live = await readFrames();
  expect(live.activity['sess-cw-middleware']).toBe('thinking');
  expect(live.activity['sess-pc-flaky-tests']).toBe('thinking');
});

test('a live Monitor changes its output peeks as the recordings play, and a still does not', async ({ page }) => {
  // A Monitor row carries the last lines its session's terminal is displaying, and on the desktop
  // those change as the agent works. The frame schedules the recording's own changes on the same
  // clock it replays the bytes on, so the row moves without a terminal being open anywhere. A
  // still has no clock, so its rows must sit exactly where the seed put them: a capture that
  // shot a moving target would give the hero figures a different Monitor every run.
  //
  // This reads the ROW STATE the mock publishes, not the rendered card. Since the Card Preview
  // default is agent-latest-message, a card whose session has a message trail draws the trail and
  // never the peek (MonitorBody drops it from the wanted set); only a session with no trail draws
  // a peek. The card side of both is asserted in the message-trail test below.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'monitor', embed: '1' });
  await SCENE_MARKERS.monitor(page);
  expect(await countPeekChanges(page, 'sess-cw-api-client', 12_000)).toBeGreaterThan(1);

  await gotoScene(page, { view: 'monitor', embed: '1', still: '1' });
  await SCENE_MARKERS.monitor(page);
  expect(await countPeekChanges(page, 'sess-cw-api-client', 6_000)).toBe(0);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('cards show the agent message trail the recordings carry, and it moves on the session clock', async ({ page }) => {
  // The Card Preview default is agent-latest-message, so a default install prints the agent's
  // newest message where the description used to be. The demo seeds that from each recording's own
  // transcript, on the recording's own clock, so a visitor sees what an install does. Before the
  // trails were seeded every card here fell back to its description and the demo silently showed
  // behaviour no install produces.
  //
  // Three scene loads plus a 60s poll, so the worst case is around 85s. 90s left barely ten
  // seconds of margin, and CI's runner boots the bundle slower than this machine does.
  test.setTimeout(120_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'board' });
  await SCENE_MARKERS.board(page);

  // A board card with a trail draws it INSTEAD of the description, which is the whole change.
  const middlewareCard = page.locator('[data-task-id="task-cw-middleware"]').first();
  await expect(middlewareCard.getByTestId('task-card-trail')).toBeVisible();
  await expect(middlewareCard.getByTestId('task-card-description')).toHaveCount(0);
  const seededLine = (await middlewareCard.getByTestId('task-card-trail').innerText()).trim();
  expect(seededLine.length).toBeGreaterThan(0);

  // The snapshot backs the seed, which is what makes it durable: syncSessions reconciles the store
  // against getMessageTrails(), so a trail only pushed would be dropped on the next re-sync.
  const snapshotSessions = await page.evaluate(async () => {
    const api = (window as unknown as { electronAPI: { sessions: { getMessageTrails?: () => Promise<Record<string, unknown[]>> } } }).electronAPI;
    const trails = (await api.sessions.getMessageTrails?.()) ?? {};
    return Object.entries(trails).filter(([, entries]) => entries.length > 0).map(([id]) => id);
  });
  expect(snapshotSessions).toContain('sess-cw-middleware');

  // On the Monitor, the same session draws the trail and NOT the output peek, because MonitorBody
  // stops asking for a peek once a row has one. A session whose agent has no transcript at all
  // (Copilot here) still draws its peek, which is what the desktop does.
  await gotoScene(page, { view: 'monitor', embed: '1' });
  await SCENE_MARKERS.monitor(page);
  // Scoped to the card: a session's id is also on its terminal tab in the board's bottom panel,
  // which sits earlier in the document, so an unscoped data-session-id lands on the tab.
  const trailCard = page.locator('[data-testid="monitor-card"][data-session-id="sess-cw-api-client"]');
  await expect(trailCard.getByTestId('monitor-card-trail')).toBeVisible();
  await expect(trailCard.getByTestId('monitor-card-peek')).toHaveCount(0);
  const peekCard = page.locator('[data-testid="monitor-card"][data-session-id="sess-ob-currency-a11y"]');
  await expect(peekCard.getByTestId('monitor-card-peek')).toBeVisible();
  await expect(peekCard.getByTestId('monitor-card-trail')).toHaveCount(0);

  // The api-client recording carries five more lines after the moment its live frame opens, so the
  // card changes while the visitor watches, on the same clock the terminal replays on. Polled for
  // the change rather than counted over a fixed span: the clock's offsets are the recording's, but
  // when it starts relative to the page rides on how long the bundle takes to boot.
  const openingLine = await readTrail(page, 'sess-cw-api-client');
  expect(openingLine.length).toBeGreaterThan(0);
  await expect.poll(() => readTrail(page, 'sess-cw-api-client'), { timeout: 60_000 }).not.toBe(openingLine);

  // A still arms no timer, so it holds the line the seed put there.
  await gotoScene(page, { view: 'monitor', embed: '1', still: '1' });
  await SCENE_MARKERS.monitor(page);
  expect(await countTrailChanges(page, 'sess-cw-api-client', 6_000)).toBe(0);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('loop=1 starts a finished session over, and without it the session stays finished', async ({ page }) => {
  // The currency-a11y recording runs 20 seconds and ends with Copilot idle, so it is the one
  // session that completes a whole cycle inside a test. Under loop=1 it goes back to working
  // after a beat; without it, needs-you is where it stays.
  test.setTimeout(120_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const session = 'sess-ob-currency-a11y';

  await gotoScene(page, { view: 'monitor', embed: '1', loop: '1' });
  await SCENE_MARKERS.monitor(page);
  expect((await monitorRow(page, session))?.activity).toBe('thinking');
  await expect.poll(async () => (await monitorRow(page, session))?.activity, { timeout: 45_000 }).toBe('idle');
  await expect.poll(async () => (await monitorRow(page, session))?.activity, { timeout: 30_000 }).toBe('thinking');

  await gotoScene(page, { view: 'monitor', embed: '1' });
  await SCENE_MARKERS.monitor(page);
  await expect.poll(async () => (await monitorRow(page, session))?.activity, { timeout: 45_000 }).toBe('idle');
  // Well past the loop's pause: a frame that was not asked to loop must stay put.
  await page.waitForTimeout(12_000);
  expect((await monitorRow(page, session))?.activity).toBe('idle');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('loop=1 leaves a session that was never working alone', async ({ page }) => {
  // Every session with a recording gets a replay entry, but only one the board seeds as WORKING
  // carries a tail: the rest are already at their recording's end, so their clock lands the
  // moment a terminal mounts. Looping those would flip an idle session to working and blank its
  // terminal, having no opening frame to repaint from and no chunk left to schedule. The
  // reachable case is a visitor opening a task window on such a session, which is a task-window
  // mount on the grid its recording fits, so the frame-fallback guard never sees it.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'task', embed: '1', loop: '1', state: encodeState(RATE_LIMIT_WINDOW_STATE) });
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Add rate limiting');
  expect((await monitorRow(page, 'sess-cw-rate-limit'))?.activity).toBe('idle');
  // Its recording is already at its end, so nothing should reach the terminal at all. A wrongly
  // armed cycle announces itself here first: it clears the screen and repaints an opening frame
  // this session does not have, which is a blank terminal. Twice the loop's six-second pause.
  expect(await streamedBytes(page, 'sess-cw-rate-limit', 15_000)).toBe(0);
  expect((await monitorRow(page, 'sess-cw-rate-limit'))?.activity).toBe('idle');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a held terminal reporting its conformed grid is not a resize, so a finished session stays silent', async ({ browser }) => {
  // The case above runs at the frame size, where the task window already fits 154 by 39 and the
  // hold never engages. Narrow the frame and it does: the terminal takes the held grid and its own
  // xterm resize reports that grid straight back. That report is the conform landing, not the
  // window moving, and reading it as a resize repaints a session whose replay is at its end,
  // which is a whole frame arriving in a terminal that should get nothing. It reached CI as one
  // retried run out of many, because whether the hold engages at all rides on the runner's font
  // metrics; this viewport puts the natural grid a fifth of the columns short on every platform.
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1233, height: 771 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.goto(demoUrl({ view: 'task', embed: '1', loop: '1', state: encodeState(RATE_LIMIT_WINDOW_STATE) }));
  await waitForDemoReady(page);
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Add rate limiting');
  await expect.poll(() => sentGrids(page, 'sess-cw-rate-limit'), { timeout: 10_000 }).toContainEqual(RATE_LIMIT_RECORDED_GRID);
  expect((await sentGrids(page, 'sess-cw-rate-limit'))[0].cols).toBeLessThan(RATE_LIMIT_RECORDED_GRID.cols);
  expect(await streamedBytes(page, 'sess-cw-rate-limit', 15_000)).toBe(0);
  expect(getUnexpectedErrors()).toEqual([]);
  await context.close();
});

test('a display that fits another grid holds the task window at the recording\'s grid and streams its bytes', async ({ browser }) => {
  // A display at 125 percent scaling fits fewer columns and rows in the task window than the
  // recorded 154 by 37 (144 by 36 on Windows, 141 by 36 on CI's Linux fonts), and a recording's
  // bytes address rows for their own grid. The mock answers the terminal's resize with the grid it
  // holds and the terminal conforms: it takes that grid and scales its font to fit the pane, so
  // the bytes replay exactly here too. Which recording is held follows the width the page
  // measured: a pane narrower than the single recording takes the session's tiled one (the seed's
  // layoutFor), played from the moment the session's clock began. Either recording has a stretch
  // left when the page opens (the single 38 s, the variant 26 s), so its bytes stream on either
  // layout, and the session goes on working through it on its own clock, as an agent does on the
  // desktop when its window is resized.
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.goto(demoUrl({ view: 'task', embed: '1', loop: '1' }));
  await waitForDemoReady(page);
  await SCENE_MARKERS.task(page);
  await expect.poll(() => sentGrids(page, 'sess-cw-middleware'), { timeout: 10_000 }).not.toHaveLength(0);
  const natural = (await sentGrids(page, 'sess-cw-middleware'))[0];
  expect(natural.rows).toBeLessThan(MIDDLEWARE_RECORDED_GRID.rows);
  const heldGrid = natural.cols < MIDDLEWARE_RECORDED_GRID.cols ? MIDDLEWARE_TILED_GRID : MIDDLEWARE_RECORDED_GRID;
  await expect.poll(() => sentGrids(page, 'sess-cw-middleware'), { timeout: 10_000 }).toContainEqual(heldGrid);
  expect(await firstStreamedSession(page, 10_000, 'sess-cw-middleware')).toBe('sess-cw-middleware');
  const peekChanges = countPeekChanges(page, 'sess-cw-middleware', 30_000);
  expect(await streamedBytes(page, 'sess-cw-middleware', 30_000)).toBeGreaterThan(0);
  expect(await peekChanges).toBeGreaterThan(0);
  expect((await monitorRow(page, 'sess-cw-middleware'))?.activity).toBe('thinking');
  expect(getUnexpectedErrors()).toEqual([]);
  await context.close();
});

test('loop=1 and still=1 together are refused rather than silently reconciled', async ({ page }) => {
  await page.goto(demoUrl({ view: 'monitor', embed: '1', still: '1', loop: '1' }));
  const card = page.locator('[data-testid="demo-error"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('a still frame has no replay to loop');
});

test('a state= blob carrying a capture-rig step is refused', async ({ page }) => {
  // boot.js's validateState checks a step's SHAPE (one of click/type/press) before it ever
  // checks the per-key allowlist, so a bare `{ hover: ... }` step is refused for missing a
  // discriminant key rather than for naming a capture-rig key. To reach the allowlist branch and
  // pin its message, the step needs a valid `click` alongside the stray `hover` key. The click
  // target is a real swimlane, which the mutation below depends on: it is a column container
  // with no click handler, so clicking it is a no-op rather than something that opens a dialog.
  const hoverStepBlob = encodeState({
    steps: [{ click: '[data-swimlane-name="Executing"]', hover: '[data-swimlane-name="Executing"]' }],
  });
  await page.goto(demoUrl({ state: hoverStepBlob, embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText('"hover" is a capture-rig step');
  // Nothing was seeded: the seed script's afterSeed() call (applyScene) returns before it
  // patches rows or calls __demoApplyFixture whenever validateState already recorded an error,
  // so the board never mounts a single swimlane. Checked only after the card is visible, so this
  // is not a race against a boot that was never going to happen.
  await expect(page.locator('[data-swimlane-name]')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');

  // Positive control, in the same test: a press step carries only one discriminant key (press),
  // so the same state= plumbing validates it and the sample install boots normally.
  const pressStepBlob = encodeState({ steps: [{ press: 'Mouse:Back' }] });
  await gotoScene(page, { state: pressStepBlob, embed: '1', still: '1' });
  await expect(page.locator('[data-testid="demo-error"]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-demo-scene', 'state');
});

test('a state= blob naming only part of a nested config block is refused', async ({ page }) => {
  // The merge is a shallow Object.assign twice over (boot.js into __mockConfigOverrides, then the
  // mock into its defaults), so a nested block REPLACES the default. A partial block used to boot
  // fine with its unnamed siblings undefined, which is a figure that is quietly wrong rather than
  // one that fails. The registry test catches this for SCENES; this is the same guard for the
  // hand-written state= URL the README points developers at.
  const partialBlock = encodeState({ config: { monitor: { layout: 'table' } } });
  await page.goto(demoUrl({ state: partialBlock, embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText('must name every field');
  // Named, so the fix is mechanical rather than a hunt through AppConfig.
  await expect(errorCard).toContainText('groupBy');
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');

  // Positive control: the same block spelled whole boots, and so does a flat key on its own.
  const wholeBlock = encodeState({
    config: {
      monitor: {
        layout: 'table', groupBy: 'project', sort: 'longest-running', liveOnly: false,
        projectFilter: [], stateFilter: [], textFilter: '',
      },
    },
  });
  await gotoScene(page, { state: wholeBlock, embed: '1', still: '1' });
  await expect(page.locator('[data-testid="demo-error"]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-demo-scene', 'state');
});

test('a state= blob patching a session the sample install does not seed throws rather than silently no-op-ing', async ({ page }) => {
  // Unlike the two refusals above, this is NOT a validateState() check: `sessions` is validated
  // only for SHAPE up front ("must be an object keyed by session id"), so a bad id sails through
  // that gate with nothing pushed to `errors`. The "is this id one the sample install seeds" check
  // happens later, inside applyScene()'s __mockPreConfigure callback, called from the generated
  // seed script's bare top-level `window.__demoBoot.afterSeed();` (demo/vite.config.mts) with no
  // try/catch anywhere above it. So the throw is an UNCAUGHT exception, not a caught error: it
  // never reaches the [data-testid="demo-error"] card path at all, and surfaces only as a
  // Playwright pageerror.
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => { pageErrors.push(error.message); });

  const unknownSessionBlob = encodeState({ sessions: { 'sess-does-not-exist': { status: 'queued' } } });
  await page.goto(demoUrl({ state: unknownSessionBlob, embed: '1', still: '1' }));
  await expect
    .poll(() => pageErrors.some((message) => message.includes('Scene patches session "sess-does-not-exist", which the sample install does not contain')))
    .toBe(true);

  // Positive control, same plumbing: patching a session id the sample install DOES seed throws
  // nothing and boots clean.
  pageErrors.length = 0;
  const knownSessionBlob = encodeState({ sessions: { [DEMO_SESSIONS[0].id]: { status: 'queued' } } });
  await gotoScene(page, { state: knownSessionBlob, embed: '1', still: '1' });
  expect(pageErrors).toEqual([]);
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
  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/spawn-task-cw-auth-acceptEdits-')), { timeout: 15_000 }).toBe(true);
  const recordingUrl = getRecordingRequests().find((url) => url.includes('/recordings/spawn-task-cw-auth-acceptEdits-')) as string;
  const sessionId = await page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    return (await api.tasks.list()).find((row) => row.title === 'Add user auth flow')?.session_id ?? null;
  });
  expect(sessionId).not.toBeNull();
  await expectStreamedOrStill(page, sessionId as string, streamed);
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
  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/terminal-proj-contoso-web-tiled-')), { timeout: 15_000 }).toBe(true);
  const sessionId = await page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const sessions = await api.sessions.list();
    return sessions.filter((row) => row.transient && row.status === 'running' && row.id !== 'sess-cw-terminal-1').map((row) => row.id)[0] ?? null;
  });
  expect(sessionId).not.toBeNull();
  await expectStreamedOrStill(page, sessionId as string, streamed);
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
  // from the tiled recording, starting with a cleared screen (after leaving the alternate
  // screen, so the clear lands on the buffer the boot is written into).
  const repainted = page.evaluate(({ sessionId, timeout }) => new Promise<boolean>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const timer = setTimeout(() => resolve(false), timeout);
    const unsubscribe = api.sessions.onData((id, data) => {
      if (id !== sessionId || !data.replace(/^\x1b\[\?1049l/, '').startsWith('\x1b[2J\x1b[3J')) return;
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

test('the site\'s take-control dialog at a 1440 by 900 display holds the task window at the recording\'s grid', async ({ browser }) => {
  // kangentic.com gives the dialog's frame a 1233 by 771 box there, where the task window fits
  // well under the recording's columns and 26 rows: the case in which every wrapped row used to
  // spill (task #673). The pane can show the recording's grid at about 70 percent of the type,
  // above the hold's floor, so the terminal conforms and the bytes replay. Which recording that
  // is follows the width the page measured: a pane narrower than the single recording takes the
  // session's tiled one (the seed's layoutFor), played from the moment the session's clock
  // began; either has a stretch left when the page opens, so its bytes stream, and the session's
  // own clock keeps it working.
  const context = await browser.newContext({ viewport: { width: 1233, height: 771 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.goto(demoUrl({ view: 'task', embed: '1' }));
  await waitForDemoReady(page);
  await SCENE_MARKERS.task(page);
  await expect.poll(() => sentGrids(page, 'sess-cw-middleware'), { timeout: 10_000 }).not.toHaveLength(0);
  const natural = (await sentGrids(page, 'sess-cw-middleware'))[0];
  const heldGrid = natural.cols < MIDDLEWARE_RECORDED_GRID.cols ? MIDDLEWARE_TILED_GRID : MIDDLEWARE_RECORDED_GRID;
  await expect.poll(() => sentGrids(page, 'sess-cw-middleware'), { timeout: 10_000 }).toContainEqual(heldGrid);
  expect(natural.rows).toBeLessThan(heldGrid.rows);
  expect(await firstStreamedSession(page, 10_000, 'sess-cw-middleware')).toBe('sess-cw-middleware');
  expect((await monitorRow(page, 'sess-cw-middleware'))?.activity).toBe('thinking');
  expect(getUnexpectedErrors()).toEqual([]);
  await context.close();
});

test('the board\'s bottom panel is live, where no grid could ever fit a recording', async ({ page }) => {
  // The panel is 15 rows and a session recording is 37, which no font size reconciles: the hold
  // would need type at 40 percent of the configured size, below its floor, so at every display
  // scale this is the frame path. It is also the default layout, so it is the one a visitor
  // meets the product through. Every frame it paints is physical rows fitted to the panel: no
  // row wider than the grid, so nothing can wrap or spill, and the hold never engages.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'board', embed: '1' });
  await SCENE_MARKERS.board(page);
  const grid = await mountedGrid(page, 'sess-cw-middleware');
  expect(grid?.rows).toBe(15);
  expect(await sentGrids(page, 'sess-cw-middleware')).not.toContainEqual(MIDDLEWARE_RECORDED_GRID);
  const frames = await paintedFrameRowWidths(page, 'sess-cw-middleware', 8_000);
  expect(frames.length).toBeGreaterThan(0);
  for (const rows of frames) {
    expect(rows.length).toBeGreaterThan(0);
    for (const width of rows) expect(width).toBeLessThanOrEqual(grid?.cols ?? 0);
  }
  expect((await monitorRow(page, 'sess-cw-middleware'))?.activity).toBe('thinking');
  expect(getUnexpectedErrors()).toEqual([]);
});
