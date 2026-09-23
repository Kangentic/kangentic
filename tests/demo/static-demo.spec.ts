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
import { test, expect, chromium, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { startDemoServer } from '../../demo/static-server.mjs';
import { isBenignRendererError } from '../ui/helpers';
import { SCENES } from '../captures/scenes';
import {
  DEMO_ARCHIVED_SUMMARIES, DEMO_LANES_BY_PROJECT, DEMO_SESSIONS, DEMO_TASKS, PROJECT_CONTOSO,
  SESSION_CONTOSO_TERMINAL, SESSION_EMPTY_STATES, SESSION_MIDDLEWARE, SESSION_RATE_LIMIT, SESSION_WEBSOCKET, TASK_MIDDLEWARE, TASK_WEBSOCKET,
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
  __demoBoot?: {
    sceneName: string | null;
    focusRectOf(selector: string): { x: number; y: number; w: number; h: number } | null;
  };
}

let server: DemoServer;

// The site frame's size, which every terminal recording was made for (demo/README.md,
// geometry): the window geometry in the scenes and the state blobs below is fractional, so this
// is what gives a default-rect window its recorded 154 by 37 grid (a fitted floating window takes
// its recording's grid at any display scale), and it is wide enough for the Changes panel's file
// tree and split diff to lay out side by side.
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
    // actually finds and patches the lanes; the `ready` selector alone (the tab having switched)
    // proves nothing about the patch landing. OverviewToggle renders the column page's own
    // read-only ToggleSwitch, so this is the same aria-checked a visitor would read.
    const row = (name: string): Locator => page.locator('[data-testid="board-manager-overview-row"]').filter({ hasText: name });
    const handoff = (name: string): Locator => row(name).getByRole('switch', { name: 'Hand off context when the agent changes' });
    // On exactly where the agent changes, as the alt says. The two off are the sibling negatives
    // that keep the switch from simply always reading on: the dataset leaves every lane off.
    for (const name of ['Code Review', 'Testing', 'Merge']) await expect(handoff(name)).toHaveAttribute('aria-checked', 'true');
    for (const name of ['Planning', 'Executing']) await expect(handoff(name)).toHaveAttribute('aria-checked', 'false');
    await expect(row('Code Review')).toContainText('Codex CLI');
    await expect(row('Merge')).toContainText('GitHub Copilot CLI');
    // A model reads the way its column's form reads it: the name Claude reports, Codex's raw id.
    await expect(row('Planning')).toContainText('Opus 5');
    await expect(row('Code Review')).toContainText('gpt-5.5');
    // Every value reads whole at the site's frame. Before DataTable's colgroup carried the widths,
    // every column was an equal tenth of the table and "Plan (Read-Only)" was cut mid-glyph. The 1px
    // allowance absorbs sub-pixel rounding between font stacks; a real clip loses whole glyphs.
    const clipped = await page.evaluate(() => Array.from(document.querySelectorAll(
      '[data-testid="board-manager-overview-row"] [data-state="changed"] > span, [data-testid="board-manager-overview-row"] [data-state="unchanged"]',
    )).filter((label) => label.scrollWidth - label.clientWidth > 1).map((label) => label.textContent));
    expect(clipped).toEqual([]);
  },
  'edit-columns': async (page) => {
    // The Code Review form on the shared ladder: Codex CLI reviews on the model it was recorded on,
    // and there is no Effort field because Codex takes none from Kangentic. Without the dataset's
    // Codex capabilities the Model field would be missing too.
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog.locator('input[data-testid="column-agent-override"]')).toHaveValue('Codex CLI');
    await expect(dialog.locator('input[data-testid="column-model-override"]')).toHaveValue('gpt-5.5');
    await expect(dialog.locator('[data-testid="column-effort-override"]')).toHaveCount(0);
    // Automation-free on purpose: column-automation is the configured counterpart.
    await expect(dialog.locator('[data-testid="column-automation-row"]')).toHaveCount(0);
  },
  'column-automation': async (page) => {
    // The same column as edit-columns, plus the one row column-handoff counts in its On enter cell.
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog.locator('input[data-testid="column-agent-override"]')).toHaveValue('Codex CLI');
    await expect(dialog.locator('[data-testid="column-automation-row"]')).toHaveCount(1);
    await expect(dialog.locator('[data-testid="column-automation-row"]')).toContainText('Ask for a review pass');
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
    // The seed folds the patches in before it builds the Monitor, so the Monitor shows the two
    // stopped as the board does. Applied to the rows afterwards, both rows still read running.
    expect((await monitorFields(page, SESSION_EMPTY_STATES))?.status).toBe('suspended');
    expect((await monitorFields(page, SESSION_RATE_LIMIT))?.status).toBe('queued');
    // A card that is not live shows its task's description (monitorSlotKind), which main's
    // snapshot always carries; without it the paused and queued cards printed agent output.
    const description = (taskId: string) => DEMO_TASKS.find((task) => task.id === taskId)?.description;
    expect((await monitorFields(page, SESSION_EMPTY_STATES))?.description).toBe(description('task-cw-empty-states'));
    expect((await monitorFields(page, SESSION_RATE_LIMIT))?.description).toBe(description('task-cw-rate-limit'));
    // A queued session has never started, so it has no usage: no model and no context.
    expect(await monitorFields(page, SESSION_RATE_LIMIT)).toMatchObject({ modelDisplayName: null, contextPercent: null });
    const queuedUsage = await page.evaluate(async (sessionId) => {
      const usage = await (window as unknown as { electronAPI: { sessions: { getUsage: () => Promise<Record<string, unknown>> } } }).electronAPI.sessions.getUsage();
      return usage[sessionId] ?? null;
    }, SESSION_RATE_LIMIT);
    expect(queuedUsage).toBeNull();
  },
  'session-resume': async (page) => {
    // The resuming card draws the spinner footer rather than a model: main has no usage for a
    // respawned agent until its status line paints, and the seed holds the session's back.
    const resumingCard = page.locator(`[data-task-id="${TASK_WEBSOCKET}"]`);
    await expect(resumingCard.locator('[data-testid="usage-bar"]')).toContainText('Resuming agent...');
    await expect(resumingCard.locator('[data-testid="usage-bar-model"]')).toHaveCount(0);
    // A resumed agent keeps what its previous run said (message-trail-tracker.ts reads it at once).
    await expect(resumingCard.locator('[data-testid="task-card-trail"]')).toBeVisible();
    const pausedCard = page.locator('[data-task-id="task-cw-empty-states"]');
    await expect(pausedCard.locator('[data-testid="status-bar"]')).toContainText('Paused');
    // Sibling negative: a session the scene does not patch keeps its model footer, so the held
    // usage landed on the resuming session alone.
    await expect(page.locator(`[data-task-id="${TASK_MIDDLEWARE}"] [data-testid="usage-bar-model"]`)).toBeVisible();
    // The Monitor row agrees with the card: no model and no context before the usage arrives.
    expect(await monitorFields(page, SESSION_WEBSOCKET)).toMatchObject({ status: 'running', modelDisplayName: null, contextPercent: null });
  },
  'completed-tasks': async (page) => {
    // Only the open project's archive, as the desktop's per-project DB answers, and every row
    // carries the stats its last session left, so the footer is not "$0.00 total cost".
    const contosoArchived = DEMO_TASKS.filter((task) => task.projectId === PROJECT_CONTOSO && task.archivedDaysAgo);
    const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
    await expect(dialog).toContainText(`Completed Tasks (${contosoArchived.length})`);
    await expect(dialog).toContainText(`${contosoArchived.length} tasks`);
    await expect(dialog).not.toContainText('$0.00 total cost');
    const summarized = new Set(DEMO_ARCHIVED_SUMMARIES.map((summary) => summary.taskId));
    for (const task of contosoArchived) expect(summarized.has(task.id), `${task.id} has no summary`).toBe(true);
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
    // A field-focusing step swaps the boot veil from `visibility: hidden` to `opacity: 0` plus
    // `pointer-events: none` on #root (clickTarget), and unveil() then clears all three inline
    // styles on both its success and error paths. toBeVisible() above ignores opacity and
    // pointer-events entirely, so a regression that left #root at opacity: 0 (the veil never
    // lifted) would still pass it; this reads the inline styles boot.js itself sets and clears.
    const rootVeilStyles = await page.evaluate(() => {
      const root = document.getElementById('root');
      return root ? { visibility: root.style.visibility, opacity: root.style.opacity, pointerEvents: root.style.pointerEvents } : null;
    });
    expect(rootVeilStyles, `${scene.name} has no #root`).not.toBeNull();
    expect(rootVeilStyles, `${scene.name} left the boot veil applied to #root`).toEqual({ visibility: '', opacity: '', pointerEvents: '' });
    const deepMarker = SCENE_MARKERS[scene.name];
    if (deepMarker) await deepMarker(page);
    if (scene.focus) {
      // A focus the site crops to must be a real region: not a missing element (the ready
      // message would carry null), not a zero box, and not the whole frame (the Quick Find
      // scenes once named the palette's full-frame backdrop, which crops to nothing). The rect is
      // the box around every element the selector names, which is how boot.js measures it.
      const focusRect = await page.evaluate((selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        if (elements.length === 0) return null;
        const boxes = elements.map((element) => element.getBoundingClientRect());
        const left = Math.min(...boxes.map((box) => box.left));
        const top = Math.min(...boxes.map((box) => box.top));
        const right = Math.max(...boxes.map((box) => box.right));
        const bottom = Math.max(...boxes.map((box) => box.bottom));
        return { w: (right - left) / window.innerWidth, h: (bottom - top) / window.innerHeight, count: elements.length };
      }, scene.focus);
      expect(focusRect, `${scene.name}.focus (${scene.focus}) matches no element`).not.toBeNull();
      // Each selector in the list names exactly one element. A single selector that began matching
      // a second element would widen that figure's crop to take both in without failing anything.
      const selectorCount = scene.focus.split(',').length;
      expect(focusRect?.count, `${scene.name}.focus should name ${selectorCount} element(s)`).toBe(selectorCount);
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

  // The capture rig measures each poster's focus through this same function, so the rect in the
  // poster manifest and the rect a live frame posts are one measure (demo/posters.mjs).
  const frame = await (await page.locator('#demo').elementHandle())?.contentFrame();
  if (!frame) throw new Error('the demo iframe has no content frame');
  const rigRect = await frame.evaluate((selector) => (window as DemoBootGlobal).__demoBoot?.focusRectOf(selector) ?? null, focusScene.focus ?? '');
  expect(rigRect).toEqual(focused.focus);

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

test('releasing push-to-talk over the focused Settings search box lands no text in it', async ({ page }) => {
  // The dictation-field scene's own steps only PRESS Mouse:Back over the Settings search box and
  // never release it (tests/captures/scenes.ts), so nothing before this exercised the release.
  // demo-dataset.ts overrides window.electronAPI.dictation.stop to resolve '' rather than the
  // mock's stock 'This is a test of dictation.' (tests/ui/mock-electron-api.js), because a
  // silent microphone transcribes to nothing and no transcript is authored here - so releasing
  // over a focused field must leave it exactly as the visitor found it.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'dictation-field', embed: '1', still: '1' });
  const searchInput = page.locator('[data-testid="settings-search"]');
  await expect(searchInput).toHaveValue('');

  // The release half of the same gesture boot.js's pressCombo started: a pointerup on the same
  // button (Mouse:Back is button 3, src/shared/keybindings.ts), dispatched on `document` the way
  // boot.js dispatches its pointerdown, which useDictation's capture-phase `window` listener
  // (src/renderer/hooks/useDictation.ts) matches via matchesMouseRelease(event, 'Mouse:Back').
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerup', {
      button: 3, buttons: 0, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  });

  // LiveDictationChip renders null once the dictation store is back to 'idle', which
  // finalizeOnRelease reaches only after stop() has resolved and the input sink's submit() has
  // run - the observable end of the release, not a fixed wait for it.
  await expect(page.locator('[data-testid="dictation-live-chip"]')).toHaveCount(0, { timeout: 5000 });
  await expect(searchInput).toHaveValue('');
  expect(getUnexpectedErrors()).toEqual([]);
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
  __mockMonitorRows?: Array<{
    sessionId: string; activity: string; outputPeek?: string[];
    status?: string; modelDisplayName?: string | null; contextPercent?: number | null; description?: string | null;
  }>;
}

interface MonitorFields { status?: string; modelDisplayName?: string | null; contextPercent?: number | null; description?: string | null }

/** The Monitor snapshot fields a row carries beyond its activity: the status, model, context, and description. */
function monitorFields(page: Page, sessionId: string): Promise<MonitorFields | null> {
  return page.evaluate((id) => {
    const row = ((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).find((candidate) => candidate.sessionId === id);
    return row ? { status: row.status, modelDisplayName: row.modelDisplayName, contextPercent: row.contextPercent, description: row.description } : null;
  }, sessionId);
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

interface WindowGeometry { x: number; y: number; w: number; h: number }

/** The window manager's DEFAULT rect (defaultWindowGeometry: 0.58 of the frame, centred). */
const DEFAULT_WINDOW_GEOMETRY: WindowGeometry = { x: 0.21, y: 0.15, w: 0.58, h: 0.7 };

/**
 * One floating task-detail window, by default at the window manager's default rect: the window a
 * visitor's own click opens and the one each task session was recorded at. Unlike the fitted
 * `task` scene it is a fixed fraction, so its grid moves with the display, which is what the hold
 * cases below need.
 */
function floatingWindowState(taskId: string, title: string, geometry: WindowGeometry = DEFAULT_WINDOW_GEOMETRY) {
  return {
    config: {
      workspaceByProject: {
        'proj-contoso-web': {
          version: 1,
          windows: [{
            taskId,
            kind: 'task-detail',
            title,
            geometry,
            restoreGeometry: null,
            state: 'floating',
          }],
          tileTree: null,
          tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
          focusedTaskId: taskId,
        },
      },
    },
  };
}

/**
 * A task-detail window on "Add rate limiting", whose session the board seeds IDLE, at the default
 * rect, so the window mounts its terminal on the grid the recording fits and takes the live path
 * rather than the frame fallback.
 */
const RATE_LIMIT_WINDOW_STATE = floatingWindowState('task-cw-rate-limit', 'Add rate limiting');

/** The middleware task at the default rect, where a display at another scale fits another grid. */
const MIDDLEWARE_DEFAULT_WINDOW_STATE = floatingWindowState(TASK_MIDDLEWARE, 'Extract auth middleware');

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
 * A terminal frame as plain text. A frame spells runs of spaces as cursor-forward moves, so those
 * become a space before the rest of the escapes go.
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[\d*C/g, ' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/ +/g, ' ');
}

/** The ids of every session row the mock lists for one task. */
function sessionIdsForTask(page: Page, taskId: string): Promise<string[]> {
  return page.evaluate(async (wantedTaskId) => {
    const sessions = await (window as unknown as DemoElectronWindow).electronAPI.sessions.list();
    return sessions.filter((session) => session.taskId === wantedTaskId).map((session) => session.id);
  }, taskId);
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
 * The most a terminal may leave empty around its screen, beside it and below it: the leftover of
 * whole cells a fit always has, twice over, since a held pane is taken at the least its natural
 * grid allows and then filled at a smaller cell (displayFor in demo-dataset.ts). A letterboxed
 * recording left 56px beside and 23px below every card window at 125 percent, and 314px below the
 * Browser scene's terminal at 100; a pane the seed fills stays inside these on every display.
 */
const MAX_EMPTY_BESIDE_PX = 16;
const MAX_EMPTY_BELOW_PX = 30;

interface PaneBands { right: number; below: number }

/** The empty band beside and below the screen of every terminal on the page, as the fit addon measures its box. */
function paneBands(page: Page): Promise<PaneBands[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.xterm')).flatMap((xterm) => {
    const parent = xterm.parentElement;
    const viewport = xterm.querySelector<HTMLElement>('.xterm-viewport');
    const screen = xterm.querySelector<HTMLElement>('.xterm-screen');
    if (!parent || !viewport || !screen) return [];
    const parentBox = parent.getBoundingClientRect();
    if (parentBox.width === 0 || parentBox.height === 0) return [];
    const style = getComputedStyle(xterm);
    const screenBox = screen.getBoundingClientRect();
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return [{
      right: Math.round(parentBox.width - padding - (viewport.offsetWidth - viewport.clientWidth) - screenBox.width),
      below: Math.round(parentBox.height - screenBox.height),
    }];
  }));
}

/**
 * Every terminal on the page fills its pane. Polled, because a held terminal conforms a resize
 * debounce after it mounts, and a window's layout lands a frame after its first report.
 */
async function expectPanesFilled(page: Page, label: string): Promise<void> {
  await expect.poll(async () => {
    const bands = await paneBands(page);
    if (bands.length === 0) return ['no terminal on the page'];
    return bands.filter((band) => band.right > MAX_EMPTY_BESIDE_PX || band.below > MAX_EMPTY_BELOW_PX);
  }, { timeout: 15_000, message: `${label}: a terminal left its pane empty around it` }).toEqual([]);
}

interface ReplayState { mode: 'bytes' | 'frames' | null; held: Grid | null }

/** How the seed is feeding a session's terminal (window.__demoReplayMode) and the grid it holds it at, if any (window.__demoHeldGrid). */
function replayState(page: Page, sessionId: string): Promise<ReplayState> {
  return page.evaluate((id) => {
    const demo = window as unknown as { __demoReplayMode?: Record<string, 'bytes' | 'frames'>; __demoHeldGrid?: Record<string, Grid | null> };
    return { mode: demo.__demoReplayMode?.[id] ?? null, held: demo.__demoHeldGrid?.[id] ?? null };
  }, sessionId);
}

/** The grids a session was recorded at: its single recording's, and its tiled sibling's when it has one. */
function recordingGridsOf(page: Page, sessionId: string): Promise<Grid[]> {
  return page.evaluate((id) => {
    interface Indexed { cols: number; rows: number; tiled?: Indexed }
    const sessions = (window as unknown as { __demoRecordings?: { sessions: Record<string, Indexed> } }).__demoRecordings?.sessions ?? {};
    const indexed = sessions[id];
    if (!indexed) return [];
    return [indexed, ...(indexed.tiled ? [indexed.tiled] : [])].map((entry) => ({ cols: entry.cols, rows: entry.rows }));
  }, sessionId);
}

/**
 * The replay invariant: bytes reach a terminal only on its recording's grid, and every other grid
 * plays frames from the page's emulator. A session the seed holds at a smaller type has to see
 * the terminal report the held grid back, which is the conform landing: a hold with no report back
 * is the decline that wrapped every padded row into a blank one and put Copilot's scrollbar in
 * column zero. Which path a pane takes rides on the platform's font metrics, so this asserts
 * whichever one the seed took rather than predicting it.
 */
async function expectFaithfulReplay(page: Page, sessionId: string): Promise<ReplayState> {
  await expect.poll(async () => (await replayState(page, sessionId)).mode, { timeout: 15_000, message: `${sessionId} was never fed` }).not.toBeNull();
  const state = await replayState(page, sessionId);
  if (state.held) {
    await expect.poll(() => sentGrids(page, sessionId), { timeout: 10_000, message: `${sessionId} was held at ${state.held.cols}x${state.held.rows} and never conformed` }).toContainEqual(state.held);
  }
  if (state.mode === 'bytes') {
    const recorded = await recordingGridsOf(page, sessionId);
    const terminalGrid = state.held ?? await naturalGrid(page, sessionId);
    if (recorded.length > 0) expect(recorded, `${sessionId} was handed bytes on a grid none of its recordings has`).toContainEqual(terminalGrid);
  }
  return state;
}

/** The natural grid the seed last recorded for a session (window.__demoNaturalGeometry): what its window fits, before any hold. */
function naturalGrid(page: Page, sessionId: string): Promise<Grid | null> {
  return page.evaluate((id) => {
    const natural = (window as unknown as { __demoNaturalGeometry?: Record<string, Grid> }).__demoNaturalGeometry ?? {};
    return natural[id] ?? null;
  }, sessionId);
}

/**
 * The floating terminal scenes, each with the session its window is fitted to
 * (FITTED_FLOATING_GEOMETRY in scenes.ts) and that session's single recording, whose grid the
 * window must take: 154 columns and 37 rows, both Claude sessions recorded at the task window.
 */
const FITTED_WINDOW_SCENES = [
  { view: 'task', sessionId: SESSION_MIDDLEWARE, fileStem: 'contoso-web-claude-middleware' },
  { view: 'command-terminal', sessionId: SESSION_CONTOSO_TERMINAL, fileStem: 'contoso-web-claude-terminal' },
] as const;

/**
 * Opens a fitted scene and asserts its window's terminal took exactly the recording's columns,
 * rows to spare, and the SINGLE recording's bytes. Polls for the columns because a terminal
 * reports once at a transitional size before its window's layout lands (demo/measure.mjs); a
 * window that never lands on the recording's width fails the poll.
 */
async function expectFittedToRecording(page: Page, scene: typeof FITTED_WINDOW_SCENES[number], label: string): Promise<void> {
  const getRecordingRequests = recordingRequests(page);
  await page.goto(demoUrl({ view: scene.view, embed: '1' }));
  await waitForDemoReady(page);
  await expect.poll(async () => (await naturalGrid(page, scene.sessionId))?.cols, { timeout: 10_000, message: `${label}: the window's terminal columns` })
    .toBe(MIDDLEWARE_RECORDED_GRID.cols);
  expect((await naturalGrid(page, scene.sessionId))?.rows ?? 0, `${label}: the window's terminal rows`).toBeGreaterThanOrEqual(MIDDLEWARE_RECORDED_GRID.rows);
  await expect.poll(() => getRecordingRequests().some((url) => url.includes(`/recordings/${scene.fileStem}-`) && !url.includes('-tiled-')), { timeout: 15_000 }).toBe(true);
  await expectFaithfulReplay(page, scene.sessionId);
}

/**
 * The same, for the Copilot rate-limit session. Claude's context bar wraps to two rows and every
 * other agent's does not, so a non-Claude session records two rows taller (manifest geometry,
 * rowsByAgent).
 */
const RATE_LIMIT_RECORDED_GRID: Grid = { cols: 154, rows: 39 };

/**
 * Every frame the mock paints into a terminal on the frames path, parsed: the rows between the
 * autowrap-off and autowrap-on brackets, each measured in cells (code points plus cursor-forward
 * gaps; the sample install's frames carry no wide glyph). A full paint joins its rows with line
 * breaks; a repaint that builds on the last one redraws each screen row in place behind a cursor
 * move to its first column. What the bottom-panel case asserts on.
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
      frames.push(data.slice(start + 5, end).split(/\r\n|\x1b\[\d+;1H/).filter((row, index) => index > 0 || row !== '').map((row) => {
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

test('the tiled task windows take each session\'s tiled recording, fill their panes, on the session\'s own clock', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'windows-tiled', embed: '1' });
  for (const [sessionId, fileStem] of [['sess-cw-middleware', 'contoso-web-claude-middleware'], ['sess-cw-api-client', 'contoso-web-claude-api-client']] as const) {
    await expect.poll(() => sentGrids(page, sessionId), { timeout: 10_000 }).not.toHaveLength(0);
    // A tiled pane is within about eight columns either side of the tiled recording's 115 on every
    // platform (123 at 100 percent on Windows, 107 on this runner's Liberation Mono), and the tiled
    // recording shows it at a larger type than the single one could (layoutFor).
    await expectFaithfulReplay(page, sessionId);
    await expect.poll(() => getRecordingRequests().some((url) => url.includes(`/recordings/${fileStem}-tiled-`)), { timeout: 15_000 }).toBe(true);
    expect(getRecordingRequests().some((url) => url.includes(`/recordings/${fileStem}-`) && !url.includes('-tiled-'))).toBe(false);
  }
  await expectPanesFilled(page, 'windows-tiled');
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

// The floating terminal scenes size their window to the recording at the visitor's own cell
// (FITTED_FLOATING_GEOMETRY in scenes.ts, fitLayoutBlob in demo-dataset.ts), so the terminal takes
// exactly the recording's columns and fills its pane at native type on every display. At a fixed
// 0.64 of the frame it did not: at 100 percent the 6.0 px Consolas cell fitted 170 columns and left
// about 100px empty on the right, and at a 7.0 px cell (Liberation Mono on this runner, where the
// release posters are shot) the window fitted 146, took the 115-column tiled recording, and left a
// fifth of the pane empty. Each scale here rounds the cell to device pixels differently (6.0, 6.4,
// 6.5 CSS px for Consolas), which is what a fixed fraction cannot follow.
for (const deviceScaleFactor of [1, 1.25, 2]) {
  test(`a floating terminal window fits its recording's columns at device scale ${deviceScaleFactor}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor });
    try {
      for (const scene of FITTED_WINDOW_SCENES) {
        const page = await context.newPage();
        const getUnexpectedErrors = collectUnexpectedErrors(page);
        await expectFittedToRecording(page, scene, `${scene.view} at scale ${deviceScaleFactor}`);
        await expectPanesFilled(page, `${scene.view} at scale ${deviceScaleFactor}`);
        expect(getUnexpectedErrors()).toEqual([]);
        await page.close();
      }
    } finally {
      await context.close();
    }
  });
}

// Every scene with a terminal in it, at the display scales a visitor has: the terminal fills its
// pane, wider or narrower than its recording, taller or shorter. Before the fill, the Browser
// scene's terminal left 314px below it at 100 percent, the tiled windows 52px beside them, and
// the Changes scene 300px below at 125. A still fills too, since the posters are stills, shot at
// twice scale; this runner's Liberation Mono is the face whose heights round unevenly, the case
// the renderer's conform used to stop short on.
const TERMINAL_SCENES = ['task', 'windows-tiled', 'browser', 'changes', 'command-terminal', 'command-terminal-tiled', 'board'] as const;
for (const [deviceScaleFactor, still] of [[1, false], [1.25, false], [2, false], [2, true]] as const) {
  test(`every terminal scene fills its panes at device scale ${deviceScaleFactor}${still ? ', as a still' : ''}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor });
    try {
      for (const view of TERMINAL_SCENES) {
        const page = await context.newPage();
        const getUnexpectedErrors = collectUnexpectedErrors(page);
        await gotoScene(page, { view, embed: '1', ...(still ? { still: '1' } : {}) });
        await expectPanesFilled(page, `${view} at scale ${deviceScaleFactor}${still ? ' (still)' : ''}`);
        expect(getUnexpectedErrors()).toEqual([]);
        await page.close();
      }
    } finally {
      await context.close();
    }
  });
}

test('a card opened on a desktop browser at 100 percent replays its terminal on the grid the terminal has', async () => {
  // A desktop browser reserves the app's 8px scrollbar gutter, which leaves the default task
  // window a column short of a 154-column recording on Consolas. The seed used to hold that pane
  // anyway; the conform declined (four quarter-pixel font steps cannot move a 6px cell to 5), the
  // terminal kept its own 153 columns, and the bytes it was sent addressed 154: every padded row
  // wrapped into a blank one and Copilot's right-edge scrollbar landed in column zero. A near
  // miss now plays frames at the pane's grid, and anything held has to land. Copilot and Claude,
  // the two renderers the report showed, opened the way a visitor opens them: a click on the card.
  test.setTimeout(120_000);
  const browserWithScrollbars = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const context = await browserWithScrollbars.newContext({ viewport: { width: 1600, height: 1000 } });
    for (const [taskId, sessionId] of [['task-cw-rate-limit', SESSION_RATE_LIMIT], [TASK_MIDDLEWARE, SESSION_MIDDLEWARE]] as const) {
      const page = await context.newPage();
      const getUnexpectedErrors = collectUnexpectedErrors(page);
      await gotoScene(page, { view: 'board', embed: '1' });
      await page.locator(`[data-task-id="${taskId}"]`).first().click();
      await expect(page.locator('[data-testid^="window-frame-"] .xterm-screen')).toBeVisible({ timeout: 15_000 });
      await expectFaithfulReplay(page, sessionId);
      await expectPanesFilled(page, `${taskId} at 100 percent`);
      expect(getUnexpectedErrors()).toEqual([]);
      await page.close();
    }
  } finally {
    await browserWithScrollbars.close();
  }
});

test('a window one column short of its recording plays frames at its own grid rather than holding', async ({ browser }) => {
  // The case above reaches one column short only on Windows' Consolas; this runner's Liberation
  // Mono floors to a wider cell, the default window fits far fewer columns, and the pane holds.
  // So this builds the near miss on any font: the fitted window, one cell narrower. The fit leaves
  // half a cell of slack, so that floors to exactly one column under the recording. Smaller type
  // is not worth a column (NEAR_MISS_COLUMNS in demo-dataset.ts), so the seed plays frames at the
  // pane's grid at the configured type, with nothing held.
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  try {
    const fittedPage = await context.newPage();
    await expectFittedToRecording(fittedPage, FITTED_WINDOW_SCENES[0], 'the fitted task window');
    const fitted = await fittedPage.evaluate(async (taskId) => {
      // The stored workspace, which the seed rewrote with the fitted rect on the renderer's first read.
      const api = (window as unknown as { electronAPI: { config: { getGlobal: () => Promise<{
        workspaceByProject: Record<string, { windows: Array<{ taskId: string; geometry: WindowGeometry }> }>;
      }> } } }).electronAPI;
      const config = await api.config.getGlobal();
      const managedWindow = config.workspaceByProject['proj-contoso-web'].windows.find((candidate) => candidate.taskId === taskId);
      const screen = document.querySelector<HTMLElement>('[data-testid="task-detail-dialog"] .xterm-screen');
      return { geometry: managedWindow?.geometry ?? null, screenWidth: screen ? screen.getBoundingClientRect().width : null };
    }, TASK_MIDDLEWARE);
    await fittedPage.close();
    expect(fitted.geometry, 'the fitted window geometry').not.toBeNull();
    expect(fitted.screenWidth, 'the fitted terminal screen').not.toBeNull();
    const cellWidth = (fitted.screenWidth ?? 0) / MIDDLEWARE_RECORDED_GRID.cols;
    const fittedGeometry = fitted.geometry as WindowGeometry;
    const width = fittedGeometry.w - cellWidth / 1600;
    const shortGeometry: WindowGeometry = { x: (1 - width) / 2, y: fittedGeometry.y, w: width, h: fittedGeometry.h };

    const page = await context.newPage();
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    await gotoScene(page, { view: 'task', embed: '1', state: encodeState(floatingWindowState(TASK_MIDDLEWARE, 'Extract auth middleware', shortGeometry)) });
    // Not vacuous: the pane really is one column short, with the recording's rows to spare.
    await expect.poll(async () => (await naturalGrid(page, SESSION_MIDDLEWARE))?.cols, { timeout: 10_000, message: 'the narrowed window\'s terminal columns' })
      .toBe(MIDDLEWARE_RECORDED_GRID.cols - 1);
    expect((await naturalGrid(page, SESSION_MIDDLEWARE))?.rows ?? 0).toBeGreaterThanOrEqual(MIDDLEWARE_RECORDED_GRID.rows);
    await expect.poll(() => replayState(page, SESSION_MIDDLEWARE), { timeout: 15_000, message: 'a near miss was held rather than left on frames' })
      .toEqual({ mode: 'frames', held: null });
    expect(getUnexpectedErrors()).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a floating terminal window fits its recording with the scrollbar gutter a desktop browser reserves', async () => {
  // Headless Chromium hides scrollbars, so every other case here measures a zero gutter. A browser
  // on Windows reserves the app's 8px (index.css), and the fitted width has to carry it or the
  // window lands a column short. The seed measures the gutter the way fit-addon.ts does; this is
  // the one launch that exercises that measurement with a gutter to measure.
  test.setTimeout(120_000);
  const browserWithScrollbars = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const context = await browserWithScrollbars.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    const scene = FITTED_WINDOW_SCENES[0];
    await expectFittedToRecording(page, scene, 'task with visible scrollbars');
    // Not vacuous: the gutter this case exists for is really there.
    const gutter = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="task-detail-dialog"] .xterm-viewport');
      return viewport ? viewport.offsetWidth - viewport.clientWidth : null;
    });
    expect(gutter).toBeGreaterThan(0);
    expect(getUnexpectedErrors()).toEqual([]);
  } finally {
    await browserWithScrollbars.close();
  }
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

/**
 * The rate-limit window in the 1233px frame, wide enough that the seed HOLDS it on either runner
 * font: 139 columns in Consolas's 6px cell and 119 in Liberation Mono's 7px one, inside the bands
 * displayFor holds a 154-column recording at (102 to 151 columns and 109 to 151). The default
 * rect fits 101 in Liberation Mono there, below its band, so nothing would be held on CI.
 */
const RATE_LIMIT_HELD_WINDOW_STATE = floatingWindowState('task-cw-rate-limit', 'Add rate limiting', { x: 0.16, y: 0.15, w: 0.68, h: 0.7 });

test('a held terminal reporting its conformed grid is not a resize, so a finished session stays silent', async ({ browser }) => {
  // The case above runs at the frame size, where the default-rect window fits the recording's
  // columns or a near miss of them and the hold never engages. Narrow the frame and it does: the
  // terminal takes the held grid and its own xterm resize reports that grid straight back. That
  // report is the conform landing, not the window moving, and reading it as a resize repaints a
  // session whose replay is at its end, which is a whole frame arriving in a terminal that should
  // get nothing. It reached CI as one retried run out of many, because whether the hold engages
  // at all rides on the runner's font metrics; the window is sized to be held on both faces
  // (RATE_LIMIT_HELD_WINDOW_STATE).
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1233, height: 771 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.goto(demoUrl({ view: 'task', embed: '1', loop: '1', state: encodeState(RATE_LIMIT_HELD_WINDOW_STATE) }));
  await waitForDemoReady(page);
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Add rate limiting');
  const state = await expectFaithfulReplay(page, 'sess-cw-rate-limit');
  expect(state.held, 'the narrowed window was not held').not.toBeNull();
  expect((await sentGrids(page, 'sess-cw-rate-limit'))[0].cols).toBeLessThan(RATE_LIMIT_RECORDED_GRID.cols);
  await expectPanesFilled(page, 'the narrowed window');
  expect(await streamedBytes(page, 'sess-cw-rate-limit', 15_000)).toBe(0);
  expect(getUnexpectedErrors()).toEqual([]);
  await context.close();
});

test('a display that fits another grid replays the task window on the grid it shows, and the session keeps streaming', async ({ browser }) => {
  // A display at 125 percent scaling fits fewer columns and rows in the default-rect window than
  // the recorded 154 by 37 (143 by 36 on Windows, 128 by 36 on CI's Linux fonts), and a
  // recording's bytes address rows for their own grid. The pane is held at a smaller type, at the
  // grid the WHOLE pane takes there, and the page's emulator plays the recording into it, so the
  // terminal fills the window where the recording held at its own grid left 56px beside it and
  // 23px below. The window is the default rect rather than the `task` scene's, which is fitted to
  // the recording at every scale. Which recording plays follows the grid the page measured (the
  // seed's layoutFor), from the moment the session's clock began, and the session goes on working
  // through it on its own clock, as an agent does on the desktop when its window is resized.
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.goto(demoUrl({ view: 'task', embed: '1', loop: '1', state: encodeState(MIDDLEWARE_DEFAULT_WINDOW_STATE) }));
  await waitForDemoReady(page);
  await SCENE_MARKERS.task(page);
  await expect.poll(() => sentGrids(page, 'sess-cw-middleware'), { timeout: 10_000 }).not.toHaveLength(0);
  const natural = (await sentGrids(page, 'sess-cw-middleware'))[0];
  expect(natural.rows).toBeLessThan(MIDDLEWARE_RECORDED_GRID.rows);
  await expectFaithfulReplay(page, 'sess-cw-middleware');
  await expectPanesFilled(page, 'the default window at 125 percent');
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

test('a state= blob that resumes a stopped session is refused', async ({ page }) => {
  // Main marks only a live respawn as resuming, so a resume on a paused session is a state the
  // desktop never draws. validateState refuses it before anything is seeded.
  const stoppedResumeBlob = encodeState({ sessions: { [SESSION_WEBSOCKET]: { resuming: true, status: 'suspended' } } });
  await page.goto(demoUrl({ state: stoppedResumeBlob, embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText('a resuming session is running');
  await expect(page.locator('[data-swimlane-name]')).toHaveCount(0);

  // Positive control, same plumbing: a resume alone boots, and the card reads it.
  await gotoScene(page, { state: encodeState({ sessions: { [SESSION_WEBSOCKET]: { resuming: true } } }), embed: '1', still: '1' });
  await expect(page.locator(`[data-task-id="${TASK_WEBSOCKET}"] [data-testid="usage-bar"]`)).toContainText('Resuming agent...');
});

test('a resuming card comes back in the live frame the way a Resume click does', async ({ page }) => {
  // A still holds the moment (the per-scene boot above). Live, the seed plays what main sends:
  // first output a beat after page open, then the status line's usage, so the card ends on its
  // model and the Monitor row gains its model and context with it.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'session-resume', embed: '1' });
  const card = page.locator(`[data-task-id="${TASK_WEBSOCKET}"]`);
  // The resume starts when the frame reveals, as auto-resume starts once the desktop's window is
  // up, so a live visitor sees the moment the scene is named for. Started at page open, it had
  // already resolved by the reveal.
  expect(await card.locator('[data-testid="usage-bar"]').textContent()).toContain('Resuming agent...');
  await expect(card.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });
  // Its first output is timed off the recorded resume boot, so the frame fetched it.
  expect(getRecordingRequests().some((url) => url.includes('/recordings/resume-sess-cw-websocket-'))).toBe(true);
  await expect(card.locator('[data-testid="usage-bar"]')).not.toContainText('Resuming agent...');
  const websocket = DEMO_SESSIONS.find((session) => session.id === SESSION_WEBSOCKET);
  await expect.poll(() => monitorFields(page, SESSION_WEBSOCKET)).toMatchObject({
    modelDisplayName: websocket?.model?.displayName, contextPercent: websocket?.contextPercent,
  });
  // The paused card stays paused: a session paused on purpose does not come back on relaunch.
  await expect(page.locator('[data-task-id="task-cw-empty-states"] [data-testid="status-bar"]')).toContainText('Paused');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('resuming a paused card keeps what its agent last said, and the card never reads Starting agent', async ({ page }) => {
  // A resume continues the paused session's transcript, and main's trail tracker reads its tail on
  // the new session's first read, so the card shows the previous run's last line at once rather
  // than falling back to the task description. The resume goes through the bridge method the
  // task window's Resume control calls.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'session-resume', embed: '1', still: '1' });
  const pausedCard = page.locator('[data-task-id="task-cw-empty-states"]');
  await expect(pausedCard.locator('[data-testid="task-card-trail"]')).toHaveCount(0);
  const footerLabels: string[] = [];
  await page.exposeFunction('__recordFooter', (label: string) => { footerLabels.push(label); });
  await page.evaluate(() => {
    const read = () => document.querySelector('[data-task-id="task-cw-empty-states"] [data-testid="usage-bar"]')?.textContent ?? '';
    new MutationObserver(() => { (window as unknown as { __recordFooter: (label: string) => void }).__recordFooter(read()); })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.evaluate(() => (window as unknown as { electronAPI: { sessions: { resume: (taskId: string) => Promise<unknown> } } })
    .electronAPI.sessions.resume('task-cw-empty-states'));
  await expect(pausedCard.locator('[data-testid="task-card-trail"]')).toBeVisible({ timeout: 10_000 });
  await expect(pausedCard.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });
  // Between the resume and the model, the spinner says Resuming the whole way through.
  expect(footerLabels.some((label) => label.includes('Resuming agent...'))).toBe(true);
  expect(footerLabels.some((label) => label.includes('Starting agent...'))).toBe(false);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('pausing and resuming a working agent brings back the same session and view, not a fresh boot', async ({ page }) => {
  // Main clears the task's session pointer on a pause and finds the paused record again on
  // Resume, and the respawn carries the paused terminal's scrollback over. The demo once read
  // only the pointer, so a Pause then Resume started the task's recorded boot from scratch.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'task', embed: '1' });
  const toggle = page.locator('[data-testid="header-toggle-session-btn"]');
  await expect(toggle).toHaveAttribute('title', 'Pause session');
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, SESSION_MIDDLEWARE))?.status).toBe('suspended');
  // A paused agent stops: its Monitor peek, which changes every 2.5 to 6 seconds while the
  // recording plays, holds still for longer than the longest gap.
  expect(await countPeekChanges(page, SESSION_MIDDLEWARE, 7000)).toBe(0);

  // Pausing closed the window; the card reopens it on the Resume prompt.
  await page.locator(`[data-task-id="${TASK_MIDDLEWARE}"]`).click();
  await expect(toggle).toHaveAttribute('title', 'Resume session');
  await toggle.click();
  await expect(toggle).toHaveAttribute('title', 'Pause session');

  const readRows = () => page.evaluate(async (taskId) => {
    const sessions = await (window as unknown as { electronAPI: { sessions: { list: () => Promise<Array<{ id: string; taskId: string; status: string; resuming: boolean }>> } } }).electronAPI.sessions.list();
    return sessions.filter((session) => session.taskId === taskId).map((session) => ({ id: session.id, status: session.status, resuming: session.resuming }));
  }, TASK_MIDDLEWARE);
  // The task's only row is the resume: main deletes the paused row when it respawns.
  const rows = await readRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'running', resuming: true });
  expect(rows[0].id).toContain('-resumed-');

  // The terminal opens on the conversation the paused one showed, not on a fresh CLI's prompt.
  const handed = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), rows[0].id));
  expect(handed).toContain('routes file');
  expect(handed).not.toContain('Try "');
  // And it stays there: a resumed agent waits for the user, so nothing streams on.
  const handedAgain = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), rows[0].id));
  expect(handedAgain).toBe(handed);
  // The usage carries over once the resumed agent's status line lands.
  await expect.poll(() => monitorFields(page, rows[0].id), { timeout: 10_000 }).toMatchObject({ status: 'running', contextPercent: DEMO_SESSIONS.find((session) => session.id === SESSION_MIDDLEWARE)?.contextPercent });
  // Paused mid-recording, so the recorded resume boot, which reprints the WHOLE conversation,
  // would show what the frame had not reached: it is never fetched.
  expect(getRecordingRequests().filter((url) => url.includes('/recordings/resume-'))).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('resuming a session paused at its recording\'s end replays the recorded resume boot', async ({ page }) => {
  // The WebSocket session waits on the user at its recording's end, so the conversation a real
  // resume reprints is exactly the one the frame showed: Resume plays the boot the capture matrix
  // recorded (claude --resume, resume-<sessionId>.json) rather than freezing the paused frame.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'board', embed: '1' });
  const card = page.locator(`[data-task-id="${TASK_WEBSOCKET}"]`);
  const toggle = page.locator('[data-testid="header-toggle-session-btn"]');
  await card.click();
  await expect(toggle).toHaveAttribute('title', 'Pause session');
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, SESSION_WEBSOCKET))?.status).toBe('suspended');
  await card.click();
  await expect(toggle).toHaveAttribute('title', 'Resume session');
  await toggle.click();
  await expect(toggle).toHaveAttribute('title', 'Pause session');

  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/resume-sess-cw-websocket-')), { timeout: 10_000 }).toBe(true);
  const resumedId = await sessionIdsForTask(page, TASK_WEBSOCKET);
  expect(resumedId).toHaveLength(1);
  // The card goes from Resuming to its model once the boot's first output and usage land.
  await expect(card.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });
  // The terminal was handed the resumed CLI reprinting the session's own conversation.
  const handed = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), resumedId[0]));
  expect(handed).toContain('exponential');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a second Pause then Resume on that same session replays the recorded resume boot again', async ({ page }) => {
  // The sibling test above resumes a session paused at its own recording's end, and that resume
  // boot itself counts as "at its end" the moment it starts (resumeBootEntry's endMs: 0), so a
  // SECOND Pause then Resume must replay the same recorded resume boot again rather than freezing
  // whatever frame the resumed terminal happened to show. The lookup for which resume-*.json to
  // fetch has to walk back through recordedIdBySession to the ORIGINAL dataset session
  // (sess-cw-websocket): the first resumed session's own id has no resume-*.json recording of its
  // own, since only an original seeded session was ever captured pausing at a recording's end.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'board', embed: '1' });
  const card = page.locator(`[data-task-id="${TASK_WEBSOCKET}"]`);
  const toggle = page.locator('[data-testid="header-toggle-session-btn"]');

  // First cycle: identical to the sibling test above.
  await card.click();
  await expect(toggle).toHaveAttribute('title', 'Pause session');
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, SESSION_WEBSOCKET))?.status).toBe('suspended');
  await card.click();
  await expect(toggle).toHaveAttribute('title', 'Resume session');
  await toggle.click();
  await expect(toggle).toHaveAttribute('title', 'Pause session');
  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/resume-sess-cw-websocket-')), { timeout: 10_000 }).toBe(true);
  const firstResumedIds = await sessionIdsForTask(page, TASK_WEBSOCKET);
  expect(firstResumedIds).toHaveLength(1);
  const firstResumed = firstResumedIds[0];
  expect(firstResumed).toContain('-resumed-');
  await expect(card.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });

  // Second cycle, on the resumed session. The window stays open across a resume (only a pause
  // closes it), so there is no card click to reopen it before pausing again here.
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, firstResumed))?.status).toBe('suspended');
  await card.click();
  await expect(toggle).toHaveAttribute('title', 'Resume session');
  // Listen for streamed bytes BEFORE the click that starts the second resume: the resume-boot
  // path streams the recording live through onData, while a frozen fallback emits nothing at all,
  // so which one (if either) streams for the new session id is the direct signal that the second
  // resume took the boot-replay branch rather than silently falling back to a frozen frame.
  const pendingStreamedSessionId = firstStreamedSession(page, 8000);
  await toggle.click();
  await expect(toggle).toHaveAttribute('title', 'Pause session');

  const secondResumedIds = await sessionIdsForTask(page, TASK_WEBSOCKET);
  expect(secondResumedIds).toHaveLength(1);
  const secondResumed = secondResumedIds[0];
  expect(secondResumed).not.toBe(firstResumed);
  expect(secondResumed).toContain('-resumed-');

  expect(await pendingStreamedSessionId).toBe(secondResumed);
  await expect(card.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });

  const handedSecond = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), secondResumed));
  expect(handedSecond).toContain('exponential');

  const description = DEMO_TASKS.find((task) => task.id === TASK_WEBSOCKET)?.description;
  expect((await monitorFields(page, secondResumed))?.description).toBe(description);

  expect(getUnexpectedErrors()).toEqual([]);
});

test('a second Pause then Resume on a working agent frozen mid-recording opens on the same frame, not a later one', async ({ page }) => {
  // The middleware session pauses mid-recording (the sibling test above), so its resume takes the
  // frozen-frame path rather than replaying a recorded resume boot. A session resumed that way is
  // itself pausable and resumable again, and on a SECOND cycle the seed must carry the ORIGINAL
  // freeze forward rather than re-deriving a later one from a fresh wall-clock elapsed time: "a
  // session already frozen by an earlier resume stays on its frame". So the second resumed
  // terminal must open on exactly the frame the first one did, not one further into the recording.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'task', embed: '1' });
  const toggle = page.locator('[data-testid="header-toggle-session-btn"]');
  const readScrollback = async (sessionId: string): Promise<string> => {
    // Read only once the renderer has resized this session's own terminal: getScrollback fits its
    // frozen frame to the LAST grid it was told about (mountedGeometry), which is unset until that
    // resize call lands. A read before it returns the raw frame and a read after returns the
    // grid-fitted one, a difference the fitter introduces on its own and not the bug this guards.
    await expect.poll(() => mountedGrid(page, sessionId), { timeout: 10_000 }).not.toBeNull();
    return stripAnsi(await page.evaluate((id) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(id), sessionId));
  };

  // First cycle.
  await expect(toggle).toHaveAttribute('title', 'Pause session');
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, SESSION_MIDDLEWARE))?.status).toBe('suspended');
  await page.locator(`[data-task-id="${TASK_MIDDLEWARE}"]`).click();
  await expect(toggle).toHaveAttribute('title', 'Resume session');
  await toggle.click();
  await expect(toggle).toHaveAttribute('title', 'Pause session');

  const firstResumedIds = await sessionIdsForTask(page, TASK_MIDDLEWARE);
  expect(firstResumedIds).toHaveLength(1);
  const firstResumed = firstResumedIds[0];
  const firstView = await readScrollback(firstResumed);
  expect(firstView).toContain('routes file');

  // A fixed wait, not a poll: the divergence a wrong re-derivation would introduce grows with REAL
  // wall-clock time since the ORIGINAL session's own start, so the gap between cycles has to be an
  // actual span of elapsed time, not a condition to poll for.
  await page.waitForTimeout(4000);

  // Second cycle, on the resumed session.
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, firstResumed))?.status).toBe('suspended');
  await page.locator(`[data-task-id="${TASK_MIDDLEWARE}"]`).click();
  await expect(toggle).toHaveAttribute('title', 'Resume session');
  await toggle.click();
  await expect(toggle).toHaveAttribute('title', 'Pause session');

  const secondResumedIds = await sessionIdsForTask(page, TASK_MIDDLEWARE);
  expect(secondResumedIds).toHaveLength(1);
  const secondResumed = secondResumedIds[0];
  expect(secondResumed).not.toBe(firstResumed);
  const secondView = await readScrollback(secondResumed);
  expect(secondView).toBe(firstView);

  // No recorded resume boot was fetched at either cycle: the session paused before its recording
  // reached its own end, so both resumes carried the frozen frame over instead.
  expect(getRecordingRequests().filter((url) => url.includes('/recordings/resume-'))).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a state= blob patching a session the sample install does not seed throws rather than silently no-op-ing', async ({ page }) => {
  // Unlike the refusals above, this is NOT a validateState() check: `sessions` is validated up
  // front for its shape and its fields, not its ids, so a bad id sails through that gate with
  // nothing pushed to `errors`. The "is this id one the sample install seeds" check
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

test('the site\'s take-control dialog at a 1440 by 900 display fills the task window', async ({ browser }) => {
  // kangentic.com gives the dialog's frame a 1233 by 771 box there, where the task window fits
  // well under the recording's columns and 26 rows: the case in which every wrapped row used to
  // spill (task #673). The scene's window is fitted against the 1600px frame the recordings were
  // measured at, so in this smaller frame it keeps the stage's proportions, about 118 columns on
  // Windows. The session's tiled recording is laid out for 115, so the pane shows it at the
  // configured type (layoutFor), widened to the pane, where the single recording held at its own
  // grid left the width beside it empty. A face that measures the pane narrower than 113 holds
  // the tiled recording at a smaller type instead; either way the terminal fills the pane and the
  // emulator plays the recording into it from the moment the session's clock began, which keeps
  // the session working.
  const context = await browser.newContext({ viewport: { width: 1233, height: 771 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.goto(demoUrl({ view: 'task', embed: '1' }));
  await waitForDemoReady(page);
  await SCENE_MARKERS.task(page);
  await expect.poll(() => sentGrids(page, 'sess-cw-middleware'), { timeout: 10_000 }).not.toHaveLength(0);
  const natural = (await sentGrids(page, 'sess-cw-middleware'))[0];
  expect(natural.cols).toBeLessThan(MIDDLEWARE_RECORDED_GRID.cols * 0.9);
  const state = await expectFaithfulReplay(page, 'sess-cw-middleware');
  expect(state.mode).toBe('frames');
  await expectPanesFilled(page, 'the take-control dialog');
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
