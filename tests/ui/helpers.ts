import { chromium, errors, expect, type Browser, type Locator, type Page, type Request, type Response } from '@playwright/test';
import path from 'node:path';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Single source of truth for known-benign renderer errors, shared with the
// renderer's runtime suppressor (the monaco error-funnel wrapper in
// src/renderer/monacoConfig.ts, which reassigns errorHandler.unexpectedErrorHandler).
// monacoConfig.ts swallows these before they reach the page, so collectPageErrors
// rarely sees them, but the filter stays as a belt-and-suspenders for any path
// that reaches window despite the funnel wrapper.
import { BENIGN_RENDERER_ERRORS, isBenignRendererError } from '../../src/shared/benign-renderer-errors';
import { MONACO_HANDLED_ERROR_LOG_TAG } from '../../src/renderer/monaco-error-funnel';
import { isRetryableViteNavigationError } from './vite-navigation-retry';
export { BENIGN_RENDERER_ERRORS, isBenignRendererError };

/**
 * Attach a `pageerror` collector that drops messages matching
 * BENIGN_RENDERER_ERRORS. Returns a getter yielding the remaining, unexpected
 * error messages so a spec can assert a clean console without tripping on
 * quirks the app cannot control. Attach before the interaction under test so
 * the error window is fully covered.
 *
 * It also collects the monaco funnel's [MONACO] console line. The funnel
 * (src/renderer/monaco-error-funnel.ts) reports Sentry DESKTOP-19's error as
 * handled instead of letting monaco rethrow it, so that error no longer
 * reaches `pageerror`, and without this every spec asserting an empty result
 * would stop seeing it.
 */
export function collectPageErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    if (isBenignRendererError(error)) return;
    errors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (!message.text().startsWith(MONACO_HANDLED_ERROR_LOG_TAG)) return;
    errors.push(message.text());
  });
  return () => errors.slice();
}

/**
 * Count the toasts on screen RIGHT NOW, with no assertion retry.
 *
 * This is the only correct way to assert "no toast appeared", and the reason is
 * not obvious: `expect(locator).toHaveCount(0)` AUTO-RETRIES for up to the expect
 * timeout (~5s by default), while a toast auto-dismisses after
 * `notifications.toasts.durationSeconds` (4s in the mock config). So a wrongly
 * raised toast disappears on its own INSIDE the retry window and the assertion
 * reports a false pass. The test goes green against the bug it exists to catch.
 *
 * That has been rediscovered three times in this suite (add-project-flow,
 * agent-driven-invalidation, idle-toast), each time as a local helper. It lives
 * here now, and `tests/unit/toast-negative-assertion.test.ts` fails any new
 * `toHaveCount(0)` against a toast locator.
 *
 * A fake clock (`page.clock.install()`) also masks the problem, because page
 * timers freeze while Playwright retries in real time. Do not rely on that: the
 * protection is invisible at the call site and vanishes if the clock is dropped.
 *
 * Pair it with a POSITIVE assertion that the path under test actually ran, or
 * "no toast" is indistinguishable from "nothing happened yet".
 */
export async function toastCountRightNow(page: Page, hasText?: string | RegExp): Promise<number> {
  const toasts = page.getByTestId('toast');
  return hasText === undefined ? toasts.count() : toasts.filter({ hasText }).count();
}

/**
 * Poll the Vite dev server until it responds with HTTP 200.
 * Prevents thundering-herd timeouts when multiple workers launch simultaneously
 * before Vite finishes its initial compilation.
 */
export async function waitForViteReady(url: string = VITE_URL, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server not ready */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Vite dev server at ${url} not ready after ${timeoutMs}ms`);
}

const VITE_GOTO_ATTEMPTS = 3;

/**
 * `page.goto` against the Vite dev server, retrying only a navigation that never reached it or that a
 * reload cut short.
 *
 * Seen in a full 3-worker UI run: waitForViteReady's fetch probe got its 200, then Chromium's
 * navigation a moment later failed with `net::ERR_CONNECTION_REFUSED`, while the same server went
 * on serving every other test with no restart or reload in its log. A refused connect is what
 * waitForViteReady already exists to absorb, so it gets the same treatment here.
 *
 * The same failed connect can also reach Playwright as the navigation being "interrupted by
 * another navigation to chrome-error://chromewebdata/", because Chromium committed its network
 * error page before goto saw the error. The v0.46.0 release run hit that form in
 * project-move.spec.ts's beforeAll, with nothing in the server log and the spec passing alone, so it
 * is retried too.
 *
 * A navigation can also be "interrupted by another navigation to" the SAME url: something reloaded
 * the page while its first load was still running. The v0.48.0 release's local UI run hit that form
 * in toast-behavior.spec.ts, 248 ms into launchPage, with no reload, optimizer or HMR line in the
 * Vite server log and the spec passing alone, so it is retried too. Chromium reports the url
 * normalized (`http://localhost:5174/` for a VITE_URL with no trailing slash), so the match uses
 * `new URL(url).href`. A page that really reloads itself on boot reloads on every attempt and still
 * fails after the last one.
 *
 * No assertion is ever retried, since none of these forms means the app loaded. Any other
 * navigation error, and any of these forms on the last attempt, is rethrown.
 *
 * A fourth form reaches the app but never mounts it. The v0.46.0 release's local UI run failed
 * search-palette.spec.ts:335 on a page whose load event fired and whose #root stayed empty for 15 s,
 * while every other test in the file booted the same way in about a second. Load fires after the
 * entry's module graph has run or failed, so an empty root that long after load is a boot that
 * died, most likely on a module request that failed. gotoVite reloads such a page once, after
 * logging the requests that failed or never finished so the next occurrence names its cause. The
 * caller's own wait for the app judges the second boot, so a boot that was only slow still passes.
 */
export async function gotoVite(page: Page, url: string = VITE_URL): Promise<void> {
  const bootRequests = trackBootRequests(page);
  try {
    await navigateToVite(page, url);
    if (await appMounted(page, VITE_BOOT_MOUNT_GRACE_MS)) return;
    console.warn(
      `[gotoVite] the app did not mount within ${VITE_BOOT_MOUNT_GRACE_MS} ms of load, reloading once. ${bootRequests.describe()}`,
    );
    await page.reload();
  } finally {
    bootRequests.dispose();
  }
}

/**
 * How long after load gotoVite waits for #root to gain a child before it reloads. A healthy boot
 * mounts within a second of load even on a loaded runner. The UI project's 15 s test budget has to
 * hold this wait, the second boot and the test's own steps.
 */
const VITE_BOOT_MOUNT_GRACE_MS = 5000;

async function navigateToVite(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url);
      return;
    } catch (error) {
      if (!isRetryableViteNavigationError(error, url) || attempt >= VITE_GOTO_ATTEMPTS) throw error;
      await waitForViteReady(url);
    }
  }
}

/**
 * True once React has put anything into #root: the app, a pop-out surface, or an error boundary's
 * fallback. Each of those counts as a boot that ran, so only a root that stays empty is retried.
 */
async function appMounted(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForSelector('#root > *', { state: 'attached', timeout: timeoutMs });
    return true;
  } catch (error) {
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  }
}

/** Records the page's requests during a boot, so a boot that never mounts can say what it was waiting on. */
function trackBootRequests(page: Page): { describe: () => string; dispose: () => void } {
  const unanswered = new Set<Request>();
  const failed: string[] = [];
  const onRequest = (request: Request): void => {
    unanswered.add(request);
  };
  const onRequestFinished = (request: Request): void => {
    unanswered.delete(request);
  };
  const onRequestFailed = (request: Request): void => {
    unanswered.delete(request);
    failed.push(`${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
  };
  const onResponse = (response: Response): void => {
    if (response.status() >= 400) failed.push(`${response.url()} (HTTP ${response.status()})`);
  };
  page.on('request', onRequest);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);
  return {
    describe: () => {
      const unansweredUrls = [...unanswered].map((request) => request.url());
      return `Failed: ${failed.length > 0 ? failed.join(', ') : 'none'}. Never answered: ${
        unansweredUrls.length > 0 ? unansweredUrls.join(', ') : 'none'
      }.`;
    },
    dispose: () => {
      page.off('request', onRequest);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    },
  };
}

/** What `launchWithTransientTerminal` seeds: one project, and the id every Command Terminal spawns with. */
export interface TransientTerminalSetup {
  projectId: string;
  projectName: string;
  /** The transient session id `spawnTransient` returns, so `__mockFireSessionData` can target it. */
  sessionId: string;
  /** Extra `browser.newContext` options (e.g. `deviceScaleFactor`). The viewport defaults to 1600x1000. */
  contextOptions?: Parameters<Browser['newContext']>[0];
  /** Seeds the global `terminal.fontSize` before the app mounts, so a terminal is constructed at it. */
  terminalFontSize?: number;
}

/**
 * Launch a page with one project open and a deterministic Command Terminal
 * session, ready for `openTransientCommandTerminal`. Each call owns its browser,
 * so a spec using it can run its tests in parallel. Close the returned browser
 * in a `finally`.
 */
export async function launchWithTransientTerminal(setup: TransientTerminalSetup): Promise<{ browser: Browser; page: Page }> {
  const projectPath = `/mock/${setup.projectId}`;
  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: ${JSON.stringify(setup.projectId)},
        name: ${JSON.stringify(setup.projectName)},
        path: ${JSON.stringify(projectPath)},
        github_url: null,
        default_agent: 'claude',
        last_opened: timestamp,
        created_at: timestamp,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, {
          id: ${JSON.stringify(setup.projectId)} + '-lane-' + index,
          position: index,
          created_at: timestamp,
        }));
      });
      ${setup.terminalFontSize === undefined ? '' : `state.config.terminal = Object.assign({}, state.config.terminal, { fontSize: ${JSON.stringify(setup.terminalFontSize)} });`}
      return { currentProjectId: ${JSON.stringify(setup.projectId)} };
    });
    window.electronAPI.sessions.spawnTransient = async function (input) {
      return {
        session: {
          id: ${JSON.stringify(setup.sessionId)},
          taskId: ${JSON.stringify(setup.sessionId)},
          projectId: input.projectId,
          pid: null,
          status: 'running',
          shell: '/bin/bash',
          cwd: ${JSON.stringify(projectPath)},
          startedAt: new Date().toISOString(),
          exitCode: null,
          resuming: false,
          transient: true,
        },
        branch: 'main',
      };
    };
  `;

  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ...setup.contextOptions });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await gotoVite(page);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/**
 * Open the Command Terminal with Ctrl+Shift+P and return its window once its
 * xterm is mounted. Marks the session's first output, which is what lifts the
 * launch overlay over a transient terminal that the mock never writes to.
 */
export async function openTransientCommandTerminal(page: Page, sessionId: string): Promise<Locator> {
  await page.keyboard.press('Control+Shift+P');
  const commandWindow = page.getByTestId('command-terminal-window');
  await expect(commandWindow).toBeVisible();
  await page.evaluate((targetSessionId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { markFirstOutput: (id: string) => void } } };
    }).__zustandStores;
    stores?.session?.getState().markFirstOutput(targetSessionId);
  }, sessionId);
  await expect(commandWindow.locator('.xterm-helper-textarea').first()).toBeAttached({ timeout: 8000 });
  return commandWindow;
}

/** Deliver `data` to one session's mounted terminal as live PTY output. */
export async function fireSessionData(page: Page, sessionId: string, data: string): Promise<void> {
  await page.evaluate(({ targetSessionId, payload }) => {
    (window as unknown as { __mockFireSessionData: (id: string, data: string) => void })
      .__mockFireSessionData(targetSessionId, payload);
  }, { targetSessionId: sessionId, payload: data });
}

/** Everything the page has written to one session's PTY so far, joined, read
 *  from the mock's `sessions.write` log. */
export async function writtenToSession(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((targetSessionId) => {
    const calls = (window as unknown as {
      electronAPI: { sessions: { __writeCalls: Array<{ sessionId: string; payload: string }> } };
    }).electronAPI.sessions.__writeCalls;
    return calls.filter((call) => call.sessionId === targetSessionId).map((call) => call.payload).join('');
  }, sessionId);
}

/**
 * Chromium flags for a spec that asserts on terminal CONTENT as text. Under
 * WebGL, xterm draws rows to a canvas and `.xterm` innerText is empty; with
 * WebGL disabled xterm falls back to its DOM renderer and the rows are real
 * text nodes. Pass as `chromium.launch({ args: TERMINAL_TEXT_LAUNCH_ARGS })`.
 * Costs a "WebGL unavailable" console warning per terminal, nothing else.
 */
export const TERMINAL_TEXT_LAUNCH_ARGS = ['--disable-webgl', '--disable-webgl2'];

/**
 * Put a mounted xterm into bracketed-paste mode the way an agent TUI does, and
 * return once it is provably there. The mock never sends `\x1b[?2004h` and its
 * scrollback is empty, so every UI-tier terminal starts with the mode OFF; a
 * spec asserting a `\x1b[200~ ... \x1b[201~` packet must enable it first.
 *
 * Fires the DECSET as live PTY bytes with a sentinel in the same chunk and
 * waits for the sentinel to render (xterm parses in order, so a visible
 * sentinel means the mode landed, with no fixed wait). Fired INSIDE the poll: a
 * chunk that lands while the mount replay is still in flight is held and then
 * superseded by the replay's frame, so it is simply re-fired until one lands
 * live; the DECSET is idempotent. Needs `TERMINAL_TEXT_LAUNCH_ARGS`, since the
 * sentinel is read from `.xterm` innerText. `scope` is the container the
 * terminal lives in (a task-detail dialog, the command-terminal window).
 */
export async function enableBracketedPaste(page: Page, scope: Locator, sessionId: string): Promise<void> {
  const sentinel = 'MODE2004READY';
  await expect
    .poll(async () => {
      await page.evaluate(
        ({ targetSessionId, text }) => {
          (window as unknown as { __mockFireSessionData: (id: string, data: string) => void })
            .__mockFireSessionData(targetSessionId, `\x1b[?2004h${text}\r\n`);
        },
        { targetSessionId: sessionId, text: sentinel },
      );
      return scope.locator('.xterm').first().innerText();
    }, { timeout: 10000, intervals: [250] })
    .toContain(sentinel);
}

/**
 * Press one of the Changes panel's resize handles (`data-testid` selector) and
 * return its box once the drag is genuinely in flight, meaning the handle
 * publishes `data-resizing="true"`. Dispatch the moves only after this
 * resolves, so they cannot land before the handler installs its document
 * listeners.
 *
 * `hover()` waits for the handle's box to stop moving (expanding History runs a
 * height transition, which was the first CI flake on this shape). The press
 * itself then still lost once on UI shard 4: the hover had verifiably hit the
 * handle, the box never moved again, and `data-resizing` stayed `false` for
 * the full 5 s, which is the shape of an input event starved under
 * parallel-worker load rather than a moving target. A press that has not armed
 * within a short window is therefore released and re-issued from a freshly
 * read box, bounded, the same treatment `dragTaskToColumn` gives a missed
 * dnd-kit activation. The hard cap keeps a handle that never arms a failure
 * rather than a hang.
 */
export async function pressResizeHandle(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const handle = page.locator(selector);
  const armed = page.locator(`${selector}[data-resizing="true"]`);
  const PRESS_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= PRESS_ATTEMPTS; attempt += 1) {
    await handle.hover();
    const box = await handle.boundingBox();
    if (!box) throw new Error(`${selector} has no bounding box`);
    await page.mouse.down();
    const inFlight = await armed.waitFor({ state: 'attached', timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    if (inFlight) return box;
    await page.mouse.up();
  }
  throw new Error(`${selector} did not enter its drag after ${PRESS_ATTEMPTS} presses`);
}

/**
 * Press a Workflows canvas card's outgoing port and take a first step, then
 * return once the canvas says a link is being drawn (`data-linking` on
 * `workflow-canvas`), so the moves after it cannot run ahead of the drag.
 *
 * The same treatment as `pressResizeHandle`, for the same shape. Under a full UI
 * run's load the first press once never started a link, and the canvas went the
 * full 15 s without `data-linking`. A longer wait cannot help a press that has
 * already happened. `hover()` waits for the port to stop moving and to be the
 * element under the pointer, which covers a box read while the canvas was still
 * settling. A press that has not started a link within a short window is
 * released and re-issued, bounded, and the cap keeps a port that never links a
 * failure rather than a hang.
 */
export async function pressPortToStartLink(page: Page, port: Locator): Promise<void> {
  const linking = page.locator('[data-testid="workflow-canvas"][data-linking]');
  // A port takes a press only while the workflow agent is not mid-turn (the plan is held).
  await expect(page.locator('[data-testid="workflow-agent-working"]')).toHaveAttribute('data-working', 'false');
  const PRESS_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= PRESS_ATTEMPTS; attempt += 1) {
    await port.hover();
    const box = await port.boundingBox();
    if (!box) throw new Error('the port has no bounding box');
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 2 });
    const started = await linking.waitFor({ state: 'attached', timeout: 5000 }).then(() => true, () => false);
    if (started) return;
    await page.mouse.up();
  }
  throw new Error(`the port did not start a link after ${PRESS_ATTEMPTS} presses`);
}

/**
 * How many windows the config store's saved layout holds for a project. The window layout
 * save is debounced, so this is how a test knows the save, and the config rebuild it makes,
 * has landed.
 */
export async function readSavedWindowCount(page: Page, projectId: string): Promise<number> {
  return page.evaluate((targetProjectId) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        config: { getState: () => { config: { workspaceByProject?: Record<string, { windows?: unknown[] }> } } };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    return stores.config.getState().config.workspaceByProject?.[targetProjectId]?.windows?.length ?? 0;
  }, projectId);
}

/** The sidebar's rendered width as React set it (its inline style), not its animating box. */
export async function readSidebarStyleWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sidebarArea = document.querySelector<HTMLElement>('[data-testid="sidebar-area"]');
    if (!sidebarArea) throw new Error('sidebar area not rendered');
    return parseFloat(sidebarArea.style.width);
  });
}

/**
 * Expand the task-detail Changes panel's History section and return only once
 * it is provably open: the section's resize handle
 * (`changes-history-resize`) renders ONLY while the section is open, so its
 * presence is the signal, and a click that has not produced it within a short
 * window is re-issued from a fresh `aria-expanded` read, bounded.
 *
 * Do not read the open state off `commit-graph-panel` being visible. The graph
 * stays mounted while collapsed, clipped inside a `height: 0; overflow: hidden`
 * body, and Playwright's visibility check reads the element's OWN box (which is
 * not empty) rather than its ancestors' clipping, so that wait passes on a
 * collapsed section too. That is how the History resize test in
 * commit-graph-panel.spec.ts lost its expand click on UI shard 4 (the same
 * starved-input shape `pressResizeHandle` re-presses for), sailed past the
 * panel wait, and then spent the rest of its budget hovering a handle that was
 * never going to render. The hard cap keeps a section that never opens a
 * failure rather than a hang.
 */
export async function expandHistorySection(page: Page): Promise<void> {
  const historyToggle = page.locator('[data-testid="changes-history-toggle"]');
  const resizeHandle = page.locator('[data-testid="changes-history-resize"]');
  await historyToggle.waitFor({ state: 'visible', timeout: 10000 });
  const EXPAND_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= EXPAND_ATTEMPTS; attempt += 1) {
    if ((await historyToggle.getAttribute('aria-expanded')) !== 'true') {
      await historyToggle.click();
    }
    const opened = await resizeHandle.waitFor({ state: 'attached', timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }
  throw new Error(`changes-history-toggle did not expand the History section after ${EXPAND_ATTEMPTS} clicks`);
}

/**
 * Click a control right after a dnd-kit drop, retrying past a swallowed click.
 *
 * `@dnd-kit/core`'s `AbstractPointerSensor` arms a document-level, capture-phase
 * `click` -> `stopPropagation` listener on drag start and removes it in
 * `detach()` with `setTimeout(this.documentListeners.removeAll, 50)`. That timer
 * is a browser main-thread task, so under parallel workers it lands late and the
 * first click ANYWHERE on the page after a drop goes nowhere.
 *
 * The symptom is maximally misleading. The button is enabled, `pointer-events`
 * is `auto`, `elementFromPoint` returns the button itself, and there is no
 * toast, console error, or React error. It stays that way for as long as you
 * wait, so raising a timeout cannot help: the listener is removed on a timer the
 * test cannot observe or wait for. Only a second click does.
 *
 * `settles` is the caller's proof the click took effect, usually the dialog
 * going `hidden` or `detached`. The helper returns on the first settle, so a
 * click that lands the first time costs nothing beyond the wait the caller
 * needed anyway.
 *
 * The budget is sized against the `ui` project's 15s per-test timeout, not
 * against the race. Three attempts is already far past what the mechanism
 * needs. The first retry waits a full settle, 30 times the 50 ms removal timer;
 * if that timer has not fired by then, the main thread was blocked for the
 * whole window, and a fourth click does not fix that either. What the budget
 * has to leave room for is the caller, which runs a drag before this and an
 * assertion after. An exhausted budget CONSUMES the enclosing test's timeout,
 * so a caller that adds waits of its own must size them against what is left.
 *
 * Exhausting the attempts on a click that kept landing returns normally rather
 * than throwing. The caller keeps its own assertion, and a genuinely broken
 * handler should fail on that named assertion rather than on a retry. A click
 * that never landed is a different case. A strict-mode violation, a selector
 * that never resolves, and a click an overlay is blocking are all test bugs, so
 * the last attempt rethrows that error to name itself here. The settle check
 * runs before that rethrow, so a target that detached because an EARLIER click
 * did take effect still returns cleanly instead of failing on the teardown it
 * caused.
 *
 * Verified in `node_modules/@dnd-kit/core/dist/core.cjs.development.js`
 * (`handleStart` adds the listener, `detach` removes it on the 50 ms timer).
 */
const DRAG_SWALLOW_ATTEMPTS = 3;
const DRAG_SWALLOW_CLICK_TIMEOUT_MS = 1500;
const DRAG_SWALLOW_SETTLE_TIMEOUT_MS = 1500;

export async function clickPastDragSwallow(
  target: Locator,
  settles: Locator,
  state: 'hidden' | 'detached' | 'visible' | 'attached' = 'hidden',
): Promise<void> {
  for (let attempt = 0; attempt < DRAG_SWALLOW_ATTEMPTS; attempt += 1) {
    const isLastAttempt = attempt === DRAG_SWALLOW_ATTEMPTS - 1;
    let clickError: unknown;
    try {
      await target.click({ timeout: DRAG_SWALLOW_CLICK_TIMEOUT_MS });
    } catch (error) {
      clickError = error;
    }
    const settled = await settles
      .waitFor({ state, timeout: DRAG_SWALLOW_SETTLE_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (settled) return;
    if (isLastAttempt && clickError) throw clickError;
  }
}

/**
 * Wait until a dnd-kit keyboard drag that has just started can take its next key.
 *
 * dnd-kit registers the keyboard sensor's own `keydown` listener on a 0ms timer
 * after pickup (`KeyboardSensor.attach`), so the activating key cannot end the
 * drag it started. Blink runs an input task ahead of a due timer task, so a key
 * pressed within a frame of the lifted item appearing can arrive before that
 * listener exists and do nothing (seen as "the second Space did not drop, the
 * third did"). A person cannot press two keys inside one frame; an automation
 * can. A timer queued here lands BEHIND dnd-kit's in the same queue, so once it
 * fires the listener is attached. This is a deterministic wait, not a fixed one.
 *
 * Call it after asserting the pickup happened (the overlay is visible, or the
 * handle reads `aria-pressed="true"`) and before the next `keyboard.press`.
 */
export async function settleDndKitKeyboardSensor(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/**
 * Resolves once `frames` animation frames have run. A state change that has
 * already landed in a store needs one frame for React to commit it and another
 * for anything that commit scheduled (a canvas repaint, a follow-up render), so
 * two is the floor for "it has settled". For asserting that something is
 * ABSENT after a result lands, where an assertion read right after the call
 * would pass before the thing it guards against has had a chance to appear.
 */
export async function settleFrames(page: Page, frames = 2): Promise<void> {
  await page.evaluate((frameCount) => new Promise<void>((resolve) => {
    let remaining = frameCount;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);
}

/** What the screen showed of a layout change's scope, frame by frame. */
export interface LayoutChangeRecording {
  /** Every frame the compositor produced: when, and the scope's pixels as a small grayscale image. */
  frames: Array<{ at: number; picture: Uint8Array }>;
  /** Wall-clock seconds the action started. */
  actedAt: number;
  /** Wall-clock seconds the first terminal in the scope held its frame and the last one's new frame was on screen (null if none held one). */
  heldAt: number | null;
  drawnAt: number | null;
  /** The scope's box in page pixels, which every picture covers, and the pictures' size. */
  scopeBox: { x: number; y: number; width: number; height: number };
  pictureWidth: number;
  pictureHeight: number;
}

/**
 * How many pixels of `picture` inside `rect` (page pixels, inside the scope)
 * are bright enough to be text. At the pictures' 240 px width a line of 14 px
 * text averages to a faint gray (30 to 60 of 255) over a terminal background
 * near 11, so the cut sits between them, and a rect a terminal shows nothing in
 * counts close to none.
 */
export function brightPixelsIn(recording: LayoutChangeRecording, picture: Uint8Array, rect: { x: number; y: number; width: number; height: number }): number {
  const scale = recording.pictureWidth / recording.scopeBox.width;
  const left = Math.max(0, Math.floor((rect.x - recording.scopeBox.x) * scale));
  const top = Math.max(0, Math.floor((rect.y - recording.scopeBox.y) * scale));
  const right = Math.min(recording.pictureWidth, Math.ceil((rect.x + rect.width - recording.scopeBox.x) * scale));
  const bottom = Math.min(recording.pictureHeight, Math.ceil((rect.y + rect.height - recording.scopeBox.y) * scale));
  let bright = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      if (picture[row * recording.pictureWidth + column] > 28) bright += 1;
    }
  }
  return bright;
}

/** The width the scope is reduced to for comparing pictures: text antialiasing averages out, layout does not. */
const PICTURE_WIDTH = 240;

/**
 * The attribute a terminal's host carries while it holds its last frame (`TERMINAL_FRAME_HOLD_ATTRIBUTE`
 * in useTerminal.ts, which a spec cannot import: it pulls in xterm and React). A `page.evaluate`
 * closure cannot see these module constants, so a caller passes them in as arguments.
 */
export const TERMINAL_FRAME_HOLD_ATTRIBUTE = 'data-terminal-frame-hold';
/** Matches the host of every terminal that holds its last frame right now. */
export const TERMINAL_FRAME_HOLD_SELECTOR = `[${TERMINAL_FRAME_HOLD_ATTRIBUTE}]`;

/** Wait until no terminal anywhere holds its frame: every layout change has drawn its new frames. */
export async function expectNoFrameHold(page: Page, timeout = 3000): Promise<void> {
  await expect(page.locator(TERMINAL_FRAME_HOLD_SELECTOR)).toHaveCount(0, { timeout });
}

/**
 * No frame hold since `since` (ms since epoch) ended through a recovery: its
 * watchdog, or a throw on the way to its end. Those rescue a terminal from
 * being held for good, so a test on the normal path would pass through them and
 * never see the path break.
 */
export async function expectNoFrameHoldRecovery(page: Page, since: number): Promise<void> {
  const recoveries = await page.evaluate((from) => (window as unknown as {
    __kangenticTerminalTrace: () => Array<{ ts: number; event: string; detail?: { reason?: string } }>;
  }).__kangenticTerminalTrace()
    .filter((event) => event.ts >= from && event.event === 'frame-hold-dropped')
    .map((event) => event.detail?.reason)
    .filter((reason) => reason === 'watchdog' || reason === 'send-failed' || reason === 'finish-failed'), since);
  expect(recoveries).toEqual([]);
}

/** One entry of the renderer's terminal trace ring (`traceTerminalRenderer`), as `window.__kangenticTerminalTrace` hands it back. */
export interface TerminalTraceEvent {
  ts: number;
  sessionId: string | null;
  event: string;
  detail?: Record<string, unknown>;
}

/**
 * The terminal trace events named in `events` that happened at or after `since` (ms since
 * epoch), oldest first. The ring keeps the last 300 events, so a caller reads soon after the
 * thing it traces. Events from the repaint wait carry `sessionId: null`.
 */
export async function readTerminalTrace(page: Page, since: number, events: readonly string[]): Promise<TerminalTraceEvent[]> {
  return page.evaluate(({ from, names }) => (window as unknown as {
    __kangenticTerminalTrace: () => TerminalTraceEvent[];
  }).__kangenticTerminalTrace().filter((entry) => entry.ts >= from && names.includes(entry.event)), { from: since, names: [...events] });
}

/**
 * Whether any resizer holds the manager-resize gate open right now
 * (`manager-resize-gate.ts`): true from a seam, edge or panel press until the gesture ends,
 * commits or is abandoned. A stuck gate freezes every window terminal's refit, so a spec that
 * pins a gesture's end reads this.
 */
export async function isManagerResizeGateOpen(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const gate = await import('/src/renderer/window-manager/terminal/manager-resize-gate.ts' as string) as {
      isManagerResizeInProgress: () => boolean;
    };
    return gate.isManagerResizeInProgress();
  });
}

/**
 * Tell the renderer a session's agent is on screen, which lifts its terminal's launch overlay
 * (`sessionFirstOutput`). The mock never writes to a terminal, so without this a task window's
 * xterm never mounts.
 */
export async function markSessionFirstOutput(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((targetSessionId) => {
    (window as unknown as {
      __zustandStores: { session: { getState: () => { markFirstOutput: (id: string) => void } } };
    }).__zustandStores.session.getState().markFirstOutput(targetSessionId);
  }, sessionId);
}

/**
 * Record what the screen shows of `scopeSelector` while `action` runs a
 * layout change (`terminal-layout-transition.ts`). Frames come from CDP's
 * screencast, which reports the compositor's own frames: a screenshot forces a
 * fresh one and would not see a frame between two others. Each frame is cut to
 * the scope's box, so whatever draws outside it does not count, and reduced to
 * a small grayscale picture. The reduction matters: the browser draws a frozen
 * picture as a texture whose text antialiasing differs from the live page by a
 * few edge pixels, which an exact comparison would call a change.
 *
 * Callers hide the terminal cursor (DECTCEM), fill the terminals with text and
 * set `.no-motion` first, so the only thing that can change the scope is the
 * change itself.
 */
export async function recordLayoutChange(
  page: Page,
  scopeSelector: string,
  action: () => Promise<void>,
): Promise<LayoutChangeRecording> {
  const box = await page.locator(scopeSelector).boundingBox();
  if (!box) throw new Error(`no box for ${scopeSelector}`);
  await page.evaluate(({ selector, holdSelector }) => {
    const scope = document.querySelector(selector);
    if (!scope) throw new Error(`no ${selector}`);
    // A frame pump outside every scope: a 4px dot in the title bar's corner that
    // never stops changing, so the compositor keeps producing frames (a still
    // page produces none) and a held picture has frames to be seen in.
    // Script-driven, so `.no-motion` does not stop it.
    const pump = document.createElement('div');
    pump.dataset.testid = 'layout-change-frame-pump';
    pump.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;z-index:2147483647;pointer-events:none;background:#fff';
    document.body.appendChild(pump);
    let lit = false;
    const pumpFrame = () => {
      if (!pump.isConnected) return;
      lit = !lit;
      pump.style.background = lit ? '#fff' : '#000';
      requestAnimationFrame(pumpFrame);
    };
    requestAnimationFrame(pumpFrame);
    const times: { held: number | null; drawn: number | null } = { held: null, drawn: null };
    (window as unknown as { __layoutChangeTimes: typeof times }).__layoutChangeTimes = times;
    new MutationObserver(() => {
      const heldNow = scope.querySelectorAll(holdSelector).length;
      if (heldNow > 0 && times.held === null) times.held = Date.now() / 1000;
      if (heldNow === 0 && times.held !== null) times.drawn = Date.now() / 1000;
      else if (heldNow > 0) times.drawn = null;
    }).observe(scope, { subtree: true, attributes: true, attributeFilter: ['data-terminal-frame-hold'] });
  }, { selector: scopeSelector, holdSelector: TERMINAL_FRAME_HOLD_SELECTOR });
  const readTimes = () => page.evaluate(() =>
    (window as unknown as { __layoutChangeTimes: { held: number | null; drawn: number | null } }).__layoutChangeTimes);

  const cdp = await page.context().newCDPSession(page);
  const captured: Array<{ at: number; data: string }> = [];
  cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    captured.push({ at: frame.metadata.timestamp ?? 0, data: frame.data });
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  // Small JPEG frames: the comparison shrinks the scope to PICTURE_WIDTH anyway,
  // and full-size PNGs made one recording take most of a test's time budget.
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 960, maxHeight: 960, everyNthFrame: 1 });
  await page.waitForTimeout(250);
  const actedAt = Date.now() / 1000;
  await action();
  await expect.poll(async () => (await readTimes()).held, { timeout: 5000 }).not.toBeNull();
  await expect.poll(async () => (await readTimes()).drawn, { timeout: 5000 }).not.toBeNull();
  await page.waitForTimeout(400);
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  await page.evaluate(() => document.querySelector('[data-testid="layout-change-frame-pump"]')?.remove());

  const area = { x: box.x, y: box.y, width: box.width, height: box.height };
  const pictures = await page.evaluate(async ({ images, region, pictureWidth }) => {
    const width = pictureWidth;
    const height = Math.max(1, Math.round(region.height * (pictureWidth / region.width)));
    const results: string[] = [];
    for (const image of images) {
      const blob = await (await fetch(`data:image/jpeg;base64,${image}`)).blob();
      const bitmap = await createImageBitmap(blob);
      // The screencast scaled the page down to fit its frame size.
      const scale = bitmap.width / window.innerWidth;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, region.x * scale, region.y * scale, region.width * scale, region.height * scale, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      // Grayscale bytes, sent back as base64: an array of numbers this size
      // costs seconds per recording to serialize.
      let binary = '';
      for (let index = 0; index < pixels.length; index += 4) {
        binary += String.fromCharCode(Math.round(pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114));
      }
      results.push(btoa(binary));
    }
    return results;
  }, { images: captured.map((frame) => frame.data), region: area, pictureWidth: PICTURE_WIDTH });
  const times = await readTimes();
  return {
    frames: captured.map((frame, index) => ({ at: frame.at, picture: new Uint8Array(Buffer.from(pictures[index], 'base64')) })),
    actedAt,
    heldAt: times.held,
    drawnAt: times.drawn,
    scopeBox: area,
    pictureWidth: PICTURE_WIDTH,
    pictureHeight: Math.max(1, Math.round(area.height * (PICTURE_WIDTH / area.width))),
  };
}

/** The share of a picture's pixels that differ visibly (by more than 24 of 255) between two pictures. */
export function pictureChange(first: Uint8Array, second: Uint8Array): number {
  let changed = 0;
  for (let index = 0; index < first.length; index += 1) {
    if (Math.abs(first[index] - (second[index] ?? 0)) > 24) changed += 1;
  }
  return changed / Math.max(1, first.length);
}

/** The mean difference between two pictures, in gray levels (0 to 255). */
export function pictureDistance(first: Uint8Array, second: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < first.length; index += 1) total += Math.abs(first[index] - (second[index] ?? 0));
  return total / Math.max(1, first.length);
}

/**
 * Below this mean difference two pictures are the same. A frozen picture is a
 * texture whose text antialiasing differs from the live page by about 0.1 gray
 * levels on average (measured on Expand, panel maximize and window maximize).
 */
const PICTURE_NOISE_MEAN = 0.5;

/**
 * The run of distinct pictures a recording shows, in order: consecutive frames
 * that show the same picture are one stage. Same means same on BOTH measures,
 * each taken relative to the size of the whole change. The pixel count sees a
 * small change in high contrast; the mean sees a blend, which moves most pixels
 * by less than the count's threshold.
 */
export function pictureStages(recording: LayoutChangeRecording): Array<{ at: number; picture: Uint8Array }> {
  const { frames, actedAt } = recording;
  const before = frames.filter((frame) => frame.at < actedAt).at(-1);
  const final = frames.at(-1);
  if (!before || !final) throw new Error('no frames around the layout change');
  const changeCount = pictureChange(before.picture, final.picture);
  const changeMean = pictureDistance(before.picture, final.picture);
  const same = (first: Uint8Array, second: Uint8Array) => pictureChange(first, second) < changeCount / 8
    && pictureDistance(first, second) < Math.max(PICTURE_NOISE_MEAN, changeMean / 8);
  const stages: Array<{ at: number; picture: Uint8Array }> = [];
  for (const frame of frames.filter((candidate) => candidate.at >= before.at)) {
    const last = stages.at(-1);
    if (!last || !same(last.picture, frame.picture)) stages.push(frame);
  }
  return stages;
}

/**
 * The checks every user layout change must pass on screen. The scope shows its
 * picture from before the change, then the change at once with each terminal it
 * resized keeping its last frame as drawn, then each terminal's new frame in one
 * paint, and nothing else: no intermediate redraw, no old frame reflowed onto the
 * new grid, no blend, and no going back. A kept frame and the new one can be the
 * same picture (an agent whose frame did not change), so the middle stage may not
 * show. `terminals` is how many terminals the change resizes on screen, each of
 * which may draw its new frame in a frame of its own.
 */
export function expectHoldThenDraw(recording: LayoutChangeRecording, terminals = 1): void {
  const { heldAt, drawnAt, frames, actedAt } = recording;
  if (heldAt === null || drawnAt === null) throw new Error('no terminal held its frame and drew the new one');
  const stages = pictureStages(recording);
  const summary = `stages at ${stages.map((stage) => `${Math.round((stage.at - actedAt) * 1000)}ms`).join(', ')}; `
    + `held +${Math.round((heldAt - actedAt) * 1000)}ms, drawn +${Math.round((drawnAt - actedAt) * 1000)}ms, ${frames.length} frames`;
  // The change shows at all.
  expect(pictureChange(stages[0].picture, stages.at(-1)?.picture ?? stages[0].picture), summary).toBeGreaterThan(0.001);
  // The change showed before any terminal drew its new frame, so nothing held
  // the layout back.
  expect(stages.length, summary).toBeGreaterThanOrEqual(2);
  expect(stages[1].at, summary).toBeLessThan(drawnAt);
  // One more stage per terminal at most: a terminal draws its new frame in one
  // paint, and no picture comes back once it has gone.
  expect(stages.length, summary).toBeLessThanOrEqual(2 + terminals);
}

/**
 * A CSS color as the page computes it, so a token (`var(--color-edge)`), a hex
 * and an element's own computed style compare as one string, in every theme.
 * `property` is the style property the value resolves through: `color` by
 * default, `backgroundColor` to compare a fill.
 */
export async function computedColor(page: Page, cssColor: string, property: 'color' | 'backgroundColor' = 'color'): Promise<string> {
  return page.evaluate(({ value, styleProperty }) => {
    const probe = document.createElement('span');
    probe.style[styleProperty] = value;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe)[styleProperty];
    probe.remove();
    return resolved;
  }, { value: cssColor, styleProperty: property });
}

/**
 * Launch a headless Chromium page with the electronAPI mock injected.
 * The Vite dev server must be running (started by playwright webServer config).
 *
 * `beforeLoad` runs after the mock is injected and before the app loads, for a
 * spec that needs its own init script in place before React renders.
 */
export async function launchPage(
  options: { beforeLoad?: (page: Page) => Promise<void> } = {},
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  // Inject the mock before any page scripts run
  await page.addInitScript({ path: MOCK_SCRIPT });
  if (options.beforeLoad) await options.beforeLoad(page);

  await gotoVite(page);
  await page.waitForLoadState('load');
  // Wait for React to render the app shell
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

// Wait for the board to load (swimlanes visible)
export async function waitForBoard(page: Page): Promise<void> {
  await page
    .locator('[data-swimlane-name="To Do"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  await page
    .locator('[data-swimlane-name="Planning"]')
    .waitFor({ state: 'visible', timeout: 5000 });
}

// Create a project via the UI (folder picker flow).
// The project name is derived from the folder path's basename,
// so we construct a mock path whose last segment matches the desired name.
export async function createProject(
  page: Page,
  name: string,
  _projectPath?: string,
): Promise<void> {
  // Set the mock folder selection so basename = project name
  await page.evaluate((projectName: string) => {
    (window as unknown as { __mockFolderPath: string }).__mockFolderPath = '/mock/projects/' + projectName;
  }, name);

  // When no projects exist the sidebar is hidden and the welcome screen
  // provides the "Open a Project" button. Otherwise use the sidebar button.
  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('[data-testid="sidebar-new-project-button"]');

  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }

  // There is no confirmation dialog: picking a folder creates the project and lands on
  // the board directly (git is set up silently, the name is the folder basename, and the
  // default agent is the walkthrough's first step). The onboarding checklist is the only
  // thing between here and the board.
  await dismissOnboardingChecklist(page);
  await waitForBoard(page);
}

/**
 * Dismiss the onboarding checklist if it is open.
 *
 * The FIRST project on a fresh install auto-opens it, and it is a focus-trapping modal over
 * the board whose backdrop intercepts pointer events - so any spec that creates that project
 * and then touches the board must get past it first. "Skip for now" persists the dismissal,
 * so it cannot reappear later in the same test.
 *
 * Onboarding is install-scoped: the checklist auto-opens only while `onboardedProjectIds` is
 * empty, so second-and-later projects never raise it.
 *
 * That "not coming" path is NEW, created by the same change that made the gate install-scoped.
 * Before it, a second project had an id nobody had dismissed, so the checklist did open and
 * this wait resolved fast. So the store check below is not recovered pre-existing waste - it
 * keeps that gate change from regressing UI-suite time, by stopping every extra project in a
 * multi-project spec (`project-groups`, `project-sidebar-search`, whose `beforeEach` creates
 * two or three projects per test) from newly burning the full timeout.
 *
 * Asking the store beats shortening a timeout that has to stay generous on CI.
 *
 * Call this after ANY project-creation flow, not just `createProject`: several specs drive
 * the folder picker and Add project dialog inline.
 */
export async function dismissOnboardingChecklist(page: Page): Promise<void> {
  const checklist = page.locator('[data-testid="onboarding-checklist"]');
  if (!(await checklist.isVisible().catch(() => false))) {
    // `undefined` means App.tsx's backfill has not landed yet, so the checklist may still be
    // on its way - wait in that case too. Any read failure falls back to waiting.
    const mayStillOpen = await page
      .evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            config: { getState: () => { config: { onboardedProjectIds?: string[] } } };
          };
        }).__zustandStores;
        const onboardedProjectIds = stores?.config.getState().config.onboardedProjectIds;
        return !Array.isArray(onboardedProjectIds) || onboardedProjectIds.length === 0;
      })
      .catch(() => true);
    if (!mayStillOpen) return;
    await checklist.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
  }
  if (await checklist.isVisible().catch(() => false)) {
    await page.locator('[data-testid="onboarding-skip"]').click();
    await checklist.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}

// Create a task via the UI in the To Do column (the only column with an "Add task" button).
// To place a task in a different column, create it in To Do first, then drag it.
export async function createTask(
  page: Page,
  title: string,
  description: string = '',
): Promise<void> {
  const backlog = page.locator('[data-swimlane-name="To Do"]');
  const addButton = backlog.locator('text=Add task');
  await addButton.click();

  // Scope to the New Task BaseDialog (fixed inset-0 backdrop) to avoid ambiguity
  // with the task-detail window, which renders its own Task title input inside the
  // WindowLayer overlay (fixed top-10 bottom-9 - does NOT have class inset-0).
  const newTaskDialog = page.locator('.fixed.inset-0');
  const titleInput = newTaskDialog.locator('input[placeholder="Task title"]');
  await titleInput.fill(title);

  if (description) {
    const descInput = newTaskDialog.locator('textarea').first();
    await descInput.fill(description);
  }

  // Use type="submit" to distinguish the New Task dialog's Create button from the
  // dev-only TestHarness buttons ("Create Task" / "Create Project", type="button").
  const createButton = newTaskDialog.locator('button[type="submit"]:has-text("Create")');
  await createButton.click();
  // Wait for the new task dialog to unmount (the modal backdrop disappears).
  await newTaskDialog.waitFor({ state: 'hidden', timeout: 3000 });
}

/** The slice of the dev-only `window.__monaco` handle (monacoConfig.ts) the diff helpers below read. */
interface MonacoDiffTestHandle {
  editor: {
    getDiffEditors: () => {
      getModifiedEditor: () => { getScrollHeight: () => number; setScrollTop: (scrollTop: number) => void };
      getLineChanges: () => { modifiedStartLineNumber: number }[] | null;
      onDidUpdateDiff: (listener: () => void) => unknown;
      waitForDiff: () => Promise<void>;
    }[];
  };
}

/** Per-page record of the last diff update waitForDiffToSettle has seen, keyed to the editor it watches. */
interface DiffSettleTracker {
  editor: unknown;
  lastActivityAt: number;
}

// How long the diff editor must go without a diff update before
// waitForDiffToSettle trusts that no compute is still on its way.
const DIFF_QUIET_MS = 500;

/**
 * The modified-side line of the first mounted diff editor's FIRST computed
 * line change, or -1 with no editor mounted or no change computed.
 *
 * A wait on this must name the line it expects, never just "non-empty".
 * Monaco recomputes the diff asynchronously after new content goes in, and an
 * in-place flush into the live models kept `getLineChanges()` on the PREVIOUS
 * file's changes until the new result landed (154 ms after delta.ts loaded, in
 * changes-diff-scroll-memory.spec.ts), so a "length > 0" poll passed inside
 * that window. DiffViewer's detached swap reads -1 there instead. Give each
 * fixture file a first change on a line no other file uses, so the line
 * identifies whose diff it is.
 */
export async function readModifiedFirstChangeLine(target: Page): Promise<number> {
  return target.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: MonacoDiffTestHandle }).__monaco;
    const diffEditors = monaco?.editor.getDiffEditors() ?? [];
    if (diffEditors.length === 0) return -1;
    return diffEditors[0].getLineChanges()?.[0]?.modifiedStartLineNumber ?? -1;
  });
}

/**
 * Wait until the first mounted diff editor has no diff computation left to
 * deliver. Call it before leaving a file whose diff you waited for, and before
 * a final page-error assertion.
 *
 * `readModifiedFirstChangeLine` proves ONE result for the file landed, not
 * that the last one did. Monaco can have a second compute for the same content
 * pending or in flight (measured: an option update or a debounced content
 * change right after the first result, and under CI load two computes started
 * together), and a test that moves on then reads a diff that is about to
 * change.
 *
 * A late result for an OLD file used to throw as well. Its stale-result guard
 * is a single token that only cancels on dispose, and monaco never disposes a
 * view model that `setModel({ original, modified })` built, so after a swap
 * the old file's reply was applied against the new line counts:
 * `UnchangedRegion.fromDiffs` threw "startLineNumber 11 cannot be after
 * endLineNumberExclusive 2" (gamma's insertion line against beta's one line,
 * in changes-diff-scroll-memory.spec.ts), and `normalizeRangeMapping` threw
 * "Illegal value for lineNumber" (Sentry DESKTOP-22). DiffViewer now owns the
 * view model and disposes the outgoing one before each swap flushes the new
 * text, so a stale reply is dropped. diff-swap-stale-view-model.spec.ts pins
 * that with the worker's replies held across the swap.
 *
 * Two signals, because neither is enough alone. `waitForDiff()` resolves once
 * the editor's diff is up to date, which covers a compute that has started.
 * It cannot see one that has not been posted yet, so the editor must also go
 * DIFF_QUIET_MS without a diff update, longer than Monaco's 200ms content
 * debounce plus a compute on a loaded runner. The quiet clock is a page-side
 * `onDidUpdateDiff` listener, installed on first use and kept per editor.
 */
export async function waitForDiffToSettle(target: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        target.evaluate(async (requiredQuietMs) => {
          const pageWindow = window as unknown as {
            __monaco?: MonacoDiffTestHandle;
            __diffSettleTracker?: DiffSettleTracker;
          };
          const diffEditors = pageWindow.__monaco?.editor.getDiffEditors() ?? [];
          if (diffEditors.length === 0) return false;
          const diffEditor = diffEditors[0];
          if (pageWindow.__diffSettleTracker?.editor !== diffEditor) {
            const freshTracker: DiffSettleTracker = { editor: diffEditor, lastActivityAt: performance.now() };
            diffEditor.onDidUpdateDiff(() => {
              freshTracker.lastActivityAt = performance.now();
            });
            pageWindow.__diffSettleTracker = freshTracker;
          }
          const tracker = pageWindow.__diffSettleTracker as DiffSettleTracker;
          // A compute that never lands must not hang the poll, so give up on
          // this read after 2s and let the poll try again.
          const upToDate = await Promise.race([
            diffEditor.waitForDiff().then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
          ]);
          if (!upToDate) return false;
          return performance.now() - tracker.lastActivityAt >= requiredQuietMs;
        }, DIFF_QUIET_MS),
      { timeout: 15000, intervals: [100, 200, 400] },
    )
    .toBe(true);
}

/**
 * Drive the first mounted diff editor's modified side to its bottom.
 * Programmatic rather than Ctrl+End because a click to focus could land in
 * either pane, and Monaco saturates an over-large offset at the real maximum
 * for the current layout. The diff editor mirrors it onto the original side.
 */
export async function scrollModifiedToBottom(target: Page): Promise<void> {
  await target.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: MonacoDiffTestHandle }).__monaco;
    const diffEditors = monaco?.editor.getDiffEditors() ?? [];
    if (diffEditors.length === 0) return;
    const modifiedEditor = diffEditors[0].getModifiedEditor();
    modifiedEditor.setScrollTop(modifiedEditor.getScrollHeight());
  });
}
