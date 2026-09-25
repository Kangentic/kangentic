/**
 * Three contracts of the web demo that static-demo.spec.ts does not reach:
 *
 *  1. demo/boot.js validateSessionPatch refuses a state= blob's session patch for five reasons.
 *     static-demo.spec.ts covers "resumes a session it also stops"; this file covers the other
 *     four: an unknown key, an activity outside its set, a status outside its set, and resuming
 *     set to false.
 *  2. demo/boot.js rectOf(selector) unions every element a selector list matches, not just the
 *     first. static-demo.spec.ts calls the real function only on a single-selector scene.
 *  3. The seed's sessions.resume override (tests/captures/helpers/demo-dataset.ts) returns a
 *     task's own session when it is already running, as main's self-heal does, instead of
 *     starting a fresh one.
 *
 * The harness is a small copy of static-demo.spec.ts's (server boot, demoUrl, gotoScene,
 * encodeState, readyMessageFor). Importing that file instead would register its tests here too.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { startDemoServer } from '../../demo/static-server.mjs';
import { isBenignRendererError } from '../ui/helpers';
import { SCENES } from '../captures/scenes';
import { SESSION_WEBSOCKET, TASK_MIDDLEWARE, SESSION_MIDDLEWARE } from '../captures/helpers/demo-dataset';

const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist', 'demo');

/** demo/boot.js gives itself 10s to reach the reveal; the cold module load rides on top of that. */
const READY_TIMEOUT_MS = 20_000;

type DemoServer = Awaited<ReturnType<typeof startDemoServer>>;

let server: DemoServer;

test.beforeAll(async () => {
  server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
});

test.afterAll(async () => {
  if (server) await server.close();
});

function demoUrl(params: Record<string, string>): string {
  const url = new URL(server.url);
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

function encodeState(state: unknown): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

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

// validateSessionPatch refusals

interface SessionPatchRefusalCase {
  readonly title: string;
  readonly patch: Record<string, unknown>;
  /** A substring unique to the branch this case exercises, so a check reading the wrong array or
   *  skipping the unknown-key loop fails on the wrong text rather than passing by accident. */
  readonly expectedText: string;
}

const SESSION_PATCH_REFUSAL_CASES: readonly SessionPatchRefusalCase[] = [
  { title: 'an unknown key', patch: { foo: 1 }, expectedText: 'has an unknown key "foo"' },
  // A valid STATUS, not a valid activity: if the two arrays were ever swapped this would still
  // pass validation instead of being refused, so 'excited' (invalid in both) would not catch it.
  { title: 'an activity outside the allowed set', patch: { activity: 'running' }, expectedText: '.activity must be one of thinking, idle, permission' },
  // A valid ACTIVITY, not a valid status, for the same reason in the other direction.
  { title: 'a status outside the allowed set', patch: { status: 'idle' }, expectedText: '.status must be one of running, suspended, queued' },
  { title: 'resuming set to false', patch: { resuming: false }, expectedText: '.resuming can only be true' },
];

for (const refusalCase of SESSION_PATCH_REFUSAL_CASES) {
  test(`a state= blob whose session patch carries ${refusalCase.title} is refused`, async ({ page }) => {
    const blob = encodeState({ sessions: { [SESSION_WEBSOCKET]: refusalCase.patch } });
    await page.goto(demoUrl({ state: blob, embed: '1', still: '1' }));
    const errorCard = page.locator('[data-testid="demo-error"]');
    await expect(errorCard).toBeVisible();
    await expect(errorCard).toContainText(refusalCase.expectedText);
    await expect(page.locator('[data-swimlane-name]')).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');
  });
}

// rectOf over a selector list

interface FractionalRect { x: number; y: number; w: number; h: number }

interface DemoBootGlobal {
  __demoBoot?: {
    focusRectOf(selector: string): FractionalRect | null;
  };
}

/**
 * The union rect of a selector list, measured directly from getBoundingClientRect rather than by
 * calling boot.js's own rectOf, so the comparison below cannot pass by calling the same code twice.
 */
async function measuredUnion(page: Page, selectors: readonly string[]): Promise<FractionalRect> {
  return page.evaluate((selectorList) => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const selector of selectorList) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    return { x: left / width, y: top / height, w: (right - left) / width, h: (bottom - top) / height };
  }, selectors);
}

function focusRectOf(page: Page, selector: string): Promise<FractionalRect | null> {
  return page.evaluate((selectorArg) => (window as DemoBootGlobal).__demoBoot?.focusRectOf(selectorArg) ?? null, selector);
}

test('rectOf unions every element a focus selector list matches, not just the first', async ({ page }) => {
  const focusScene = SCENES['session-resume'];
  expect(focusScene.focus, 'the session-resume scene stopped naming a focus selector list').toBeDefined();
  const unionSelector = focusScene.focus ?? '';
  const individualSelectors = unionSelector.split(',').map((selector) => selector.trim());
  expect(individualSelectors.length, 'the session-resume focus is no longer a two-selector list').toBe(2);

  await gotoScene(page, { view: 'session-resume', embed: '1', still: '1' });

  const functionUnion = await focusRectOf(page, unionSelector);
  if (!functionUnion) throw new Error('focusRectOf returned nothing for the union selector');

  const independentUnion = await measuredUnion(page, individualSelectors);
  expect(functionUnion.x).toBeCloseTo(independentUnion.x, 3);
  expect(functionUnion.y).toBeCloseTo(independentUnion.y, 3);
  expect(functionUnion.w).toBeCloseTo(independentUnion.w, 3);
  expect(functionUnion.h).toBeCloseTo(independentUnion.h, 3);

  // A first-element-only implementation would make the union equal to one of these two rects
  // rather than taller than both, so this is the assertion that pins the union behavior.
  for (const selector of individualSelectors) {
    const singleRect = await focusRectOf(page, selector);
    if (!singleRect) throw new Error(`focusRectOf returned nothing for ${selector}`);
    expect(functionUnion.h, `the union is not taller than the single rect for ${selector}`).toBeGreaterThan(singleRect.h);
  }

  // The ready message a host reads carries the same rect this function measures. Compared with a
  // tolerance, not toEqual: this reading comes from a separate iframe navigation, not the same
  // page as functionUnion, so it is two independent measurements rather than one exact echo.
  const ready = await readyMessageFor(page, 'session-resume');
  if (!ready.focus) throw new Error('the ready message carried no focus rect');
  expect(ready.focus.x).toBeCloseTo(functionUnion.x, 3);
  expect(ready.focus.y).toBeCloseTo(functionUnion.y, 3);
  expect(ready.focus.w).toBeCloseTo(functionUnion.w, 3);
  expect(ready.focus.h).toBeCloseTo(functionUnion.h, 3);
});

// The seed's resume on a live session

interface DemoSessionRow { id: string; taskId: string | null; status: string }
interface DemoElectronWindow {
  electronAPI: {
    sessions: {
      list: () => Promise<DemoSessionRow[]>;
      resume: (taskId: string) => Promise<DemoSessionRow>;
    };
  };
}

function sessionRowsForTask(page: Page, taskId: string): Promise<Array<{ id: string; status: string }>> {
  return page.evaluate(
    (taskIdArg) => (window as unknown as DemoElectronWindow).electronAPI.sessions.list()
      .then((rows) => rows.filter((row) => row.taskId === taskIdArg).map((row) => ({ id: row.id, status: row.status }))),
    taskId,
  );
}

test('resuming a task whose agent is still running returns that same session, not a fresh one', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'board', embed: '1' });

  const before = await sessionRowsForTask(page, TASK_MIDDLEWARE);
  expect(before, 'the middleware task should seed with exactly one running session').toEqual([
    { id: SESSION_MIDDLEWARE, status: 'running' },
  ]);

  const resumed = await page.evaluate(
    (taskId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.resume(taskId),
    TASK_MIDDLEWARE,
  );
  expect(resumed.id, 'a task whose agent is still live should get that same session back').toBe(SESSION_MIDDLEWARE);

  const after = await sessionRowsForTask(page, TASK_MIDDLEWARE);
  expect(after, 'resuming a live task should not add a second row for it').toEqual([
    { id: SESSION_MIDDLEWARE, status: 'running' },
  ]);

  expect(getUnexpectedErrors()).toEqual([]);
});
