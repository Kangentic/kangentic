/**
 * The Command Terminal's launch overlay holds until main says the session's
 * agent is on screen (`sessionFirstOutput`, main's markAgentReady), and the
 * pane underneath mounts early so its fit sizes the PTY before the agent draws.
 *
 * Bug: the window mounted xterm on `hasFirstOutput || hasUsage`. The spawn seeds
 * usage with the model name and the shell's startup frame tripped the
 * first-output detector, so either one revealed the PowerShell prompt for about
 * three seconds before Claude's TUI.
 *
 * Pinned here, one test each:
 *  1. The lift. The usage seed alone does not lift the overlay. Bytes the PTY
 *     sends while it is up (the shell's prompt) are dropped BEFORE the lift, not
 *     only absent after it, and the mount replay skips its scrollback fetch. The
 *     pane resized the PTY. First output lifts it, and the lift (not the mount)
 *     is what replays the scrollback. Live bytes reach the terminal afterwards.
 *  2. The spawn in flight. Until `spawnTransient` resolves there is no session,
 *     so no pane: the window itself draws the overlay. Once it resolves the pane
 *     mounts and the overlay is the pane's own, with the same label, and nothing
 *     is drawn twice.
 *  3. The agent already on screen when the pane mounts (a first-output mark that
 *     beat the spawn reply). No overlay is ever drawn inside the pane, the
 *     terminal takes live bytes, and the mount replay is the only replay.
 *
 * Red-green. Each production edit below was made on its own, the spec was run,
 * and the named assertion read red:
 *  - `|| hasUsage` put back into CommandTerminalWindow's `terminalReady`: test 1,
 *    the overlay check right after the usage push.
 *  - `suppressDataRef.current = !ready` removed from CommandTerminalPane: test 1,
 *    the pre-lift `.xterm-rows` check (the shell's prompt is on screen). With
 *    that check out, the pre-lift scrollback count reads 1 instead of 0.
 *  - `{!sessionId && <LaunchOverlay .../>}` removed from CommandTerminalWindow:
 *    test 2, the overlay check while the spawn is held.
 *  - `ready={terminalReady}` replaced by `ready={false}`: test 3, the
 *    overlay-in-pane check (test 1 never lifts).
 *  - `suppressDataRef.current = !ready` replaced by `= true`: tests 1 and 3, the
 *    live-bytes check.
 *  - An extra `reloadScrollback()` in the pane's init when `ready`: test 3, the
 *    replay count reads 2.
 *  - The pane's overlay drawn for its first frame only: test 3, the overlay
 *    watcher. Its final-state checks stay green, which is why the watcher exists.
 *
 * Not pinned, and not reachable today: the pane's `wasReady` check in its
 * ready-edge effect. `reloadScrollback` is stable for a session, so the effect
 * only re-runs when `ready` flips, and on a pane that mounts ready the
 * `initialized` check (and `reloadScrollback`'s own no-terminal guard) already
 * stop a reload. Dropping `wasReady`, or `wasReady` and `initialized` together,
 * leaves every test here green. Test 3 pins the behavior that check protects
 * (one replay for a pane that mounts ready), not the line.
 *
 * WebGL is off so xterm renders through its DOM renderer and the terminal's
 * text is readable from `.xterm-rows`. The mock's `getScrollback` answers an
 * empty string, so a replay never resets the terminal here: anything the
 * terminal shows is what was written to it live. A negative text read right
 * after a write can pass before the renderer has painted that write, which is
 * how the old post-lift read alone stayed green with the drop removed. The reads
 * below wait on the incoming queue's ack and a frame boundary first.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'proj-cmd-launch-overlay';
const SESSION_ID = 'sess-cmd-launch-overlay';
const LAUNCH_LABEL = 'Starting Command Terminal...';
const OVERLAY_SELECTOR = '[data-testid="launch-overlay"]';
const PANE_SELECTOR = '[data-testid="command-bar-terminal-pane"]';
/** What the shell prints while the overlay is up. */
const SHELL_PROMPT = 'PS C:\\Users\\dev\\project> ';
/** What the agent prints once it is on screen. Shares no text with the prompt. */
const AGENT_OUTPUT = 'agent frame ready';

/**
 * The init script every test runs. `holdSpawn` parks `spawnTransient` on a gate
 * the test opens with `window.__releaseSpawn()`, which is what makes the spawn
 * in flight a state a test can stand in. `ackData` is the mock's no-op by
 * default; here it tallies acked bytes per session, because the incoming queue
 * acks a slice once it has either dropped it or written it, so the tally is the
 * fence a "this was NOT written" assertion needs (without it that assertion
 * passes before the bytes have gone anywhere).
 */
function buildPreConfig(holdSpawn: boolean): string {
  return `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Launch Overlay Project',
      path: '/mock/cmd-launch-overlay',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.DEFAULT_SWIMLANES.forEach(function (template, index) {
      state.swimlanes.push(Object.assign({}, template, {
        id: 'lane-cmd-launch-overlay-' + index,
        position: index,
        created_at: ts,
      }));
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
  window.__ackedBytes = {};
  window.electronAPI.sessions.ackData = function (sessionId, bytes) {
    window.__ackedBytes[sessionId] = (window.__ackedBytes[sessionId] || 0) + bytes;
  };
  var spawnGate = ${holdSpawn
    ? 'new Promise(function (resolve) { window.__releaseSpawn = resolve; })'
    : 'Promise.resolve()'};
  window.electronAPI.sessions.spawnTransient = async function (input) {
    await spawnGate;
    var session = {
      id: '${SESSION_ID}',
      taskId: '${SESSION_ID}',
      projectId: input.projectId,
      pid: null,
      status: 'running',
      shell: '/bin/bash',
      cwd: '/mock/cmd-launch-overlay',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: true,
      commandTerminalSlot: input.slot || 'slot-1',
      commandTerminalBranch: 'main',
      commandTerminalLabel: null,
      isolatedSwimlaneId: null,
      agentSessionId: null,
    };
    return { session: session, slot: session.commandTerminalSlot, branch: 'main' };
  };
`;
}

async function launch(holdSpawn: boolean): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true, args: ['--disable-webgl', '--disable-webgl2'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(buildPreConfig(holdSpawn));
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/** The usage a spawn seeds: the model off the command, nothing used yet. */
const SEEDED_USAGE = {
  model: { id: 'claude-haiku', displayName: 'Haiku' },
  contextWindow: {
    usedPercentage: 0,
    usedTokens: 0,
    cacheTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    contextWindowSize: 200000,
  },
  cost: { totalCostUsd: 0, totalDurationMs: 0 },
};

type SessionStoreHandle = {
  __zustandStores?: {
    session?: {
      getState: () => {
        updateUsage: (id: string, data: object) => void;
        markFirstOutput: (id: string) => void;
        sessionFirstOutput: Record<string, boolean>;
      };
    };
  };
};

/** Ctrl+Shift+P once the board is up, and the window it opens. */
async function openCommandTerminal(page: Page): Promise<Locator> {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.keyboard.press('Control+Shift+P');
  const commandWindow = page.getByTestId('command-terminal-window');
  await expect(commandWindow).toBeVisible();
  return commandWindow;
}

/** The pane's init has run: its xterm exists and it has sized the PTY. */
async function waitForPaneInitialized(page: Page, pane: Locator): Promise<void> {
  await expect(pane.locator('.xterm-helper-textarea').first()).toBeAttached({ timeout: 8000 });
  await expect.poll(() => page.evaluate((sessionId) => {
    const calls = (window as unknown as {
      electronAPI: { sessions: { __resizeCalls: Array<{ sessionId: string }> } };
    }).electronAPI.sessions.__resizeCalls;
    return calls.some((call) => call.sessionId === sessionId);
  }, SESSION_ID), { timeout: 8000 }).toBe(true);
}

async function fireSessionData(page: Page, data: string): Promise<void> {
  await page.evaluate(({ sessionId, payload }) => {
    (window as unknown as { __mockFireSessionData: (id: string, data: string) => void })
      .__mockFireSessionData(sessionId, payload);
  }, { sessionId: SESSION_ID, payload: data });
}

/** Bytes the incoming queue has consumed for the session, written or dropped. */
async function ackedBytes(page: Page): Promise<number> {
  return page.evaluate((sessionId) => {
    return (window as unknown as { __ackedBytes: Record<string, number> }).__ackedBytes[sessionId] ?? 0;
  }, SESSION_ID);
}

/**
 * Two animation frames. xterm's DOM renderer paints a parsed write on the next
 * frame, so this is the boundary after which "it was written" is visible in
 * `.xterm-rows`. A frame boundary, not a timer.
 */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function scrollbackCallCount(page: Page): Promise<number> {
  return page.evaluate((sessionId) => {
    const calls = (window as unknown as { __mockScrollbackCalls?: Array<{ sessionId: string }> }).__mockScrollbackCalls ?? [];
    return calls.filter((call) => call.sessionId === sessionId).length;
  }, SESSION_ID);
}

async function markFirstOutput(page: Page): Promise<void> {
  await page.evaluate((sessionId) => {
    (window as unknown as SessionStoreHandle).__zustandStores?.session?.getState().markFirstOutput(sessionId);
  }, SESSION_ID);
}

async function hasFirstOutputMark(page: Page): Promise<boolean> {
  return page.evaluate((sessionId) => {
    return (window as unknown as SessionStoreHandle).__zustandStores?.session?.getState().sessionFirstOutput[sessionId] === true;
  }, SESSION_ID);
}

/** Opens the spawn gate `buildPreConfig(true)` parked `spawnTransient` on. */
async function releaseSpawn(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __releaseSpawn: () => void }).__releaseSpawn();
  });
}

/**
 * Starts recording every launch overlay that is added to, or removed from, the
 * pane. A final-state check (`toHaveCount(0)`) cannot say "never": an overlay
 * that painted for a frame and went away leaves nothing to find. Records are
 * read from the observer's queue, not just its callback, so a node added and
 * removed inside one task still counts. The window's own overlay (the spawn in
 * flight) sits outside the pane and is not counted.
 */
async function watchPaneOverlays(page: Page): Promise<void> {
  await page.evaluate(({ paneSelector, overlaySelector }) => {
    const sightings = { count: 0 };
    const holdsOverlay = (node: Node): boolean => node instanceof Element
      && (node.matches(overlaySelector) || node.querySelector(overlaySelector) !== null);
    const holdsOverlayInPane = (node: Node): boolean => node instanceof Element
      && (node.matches(`${paneSelector} ${overlaySelector}`)
        || node.querySelector(`${paneSelector} ${overlaySelector}`) !== null);
    const inspect = (records: MutationRecord[]): void => {
      for (const record of records) {
        const targetInPane = record.target instanceof Element && record.target.closest(paneSelector) !== null;
        record.addedNodes.forEach((node) => {
          if (targetInPane ? holdsOverlay(node) : holdsOverlayInPane(node)) sightings.count += 1;
        });
        if (targetInPane) {
          record.removedNodes.forEach((node) => {
            if (holdsOverlay(node)) sightings.count += 1;
          });
        }
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true });
    (window as unknown as { __paneOverlayWatch: { read: () => number } }).__paneOverlayWatch = {
      read: () => {
        inspect(observer.takeRecords());
        return sightings.count;
      },
    };
  }, { paneSelector: PANE_SELECTOR, overlaySelector: OVERLAY_SELECTOR });
}

async function paneOverlaySightings(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as unknown as { __paneOverlayWatch: { read: () => number } }).__paneOverlayWatch.read();
  });
}

test('the overlay holds through the usage seed and the shell, and lifts on first output', async () => {
  const { browser, page } = await launch(false);
  try {
    const commandWindow = await openCommandTerminal(page);

    // The pane mounts under its own overlay as soon as the session exists, and
    // its init fits the terminal and resizes the PTY to the window.
    const pane = commandWindow.getByTestId('command-bar-terminal-pane');
    await expect(pane).toHaveAttribute('data-session-id', SESSION_ID, { timeout: 8000 });
    const overlay = pane.locator(OVERLAY_SELECTOR);
    await expect(overlay).toBeVisible();
    await waitForPaneInitialized(page, pane);

    // The spawn seeds usage with the model name (main's accumulator fills in the
    // rest of the shape). The context bar shows it, which proves the window
    // rendered after the push, and the overlay stays.
    await page.evaluate(({ sessionId, usage }) => {
      (window as unknown as SessionStoreHandle).__zustandStores?.session?.getState().updateUsage(sessionId, usage);
    }, { sessionId: SESSION_ID, usage: SEEDED_USAGE });
    await expect(commandWindow.locator('[data-testid="usage-bar"]')).toContainText('Haiku', { timeout: 5000 });
    await expect(overlay).toBeVisible();

    // The shell's prompt arrives while the overlay is up: dropped, never written.
    // Fence first. The queue acks a slice once it has dropped or written it, so
    // waiting for the ack and a painted frame is what makes the "not on screen"
    // assertion below mean something; without it that read passes before the
    // bytes have reached (or been kept from) the terminal.
    await fireSessionData(page, SHELL_PROMPT);
    await expect.poll(() => ackedBytes(page), { timeout: 5000 }).toBeGreaterThanOrEqual(SHELL_PROMPT.length);
    await settleFrames(page);
    await expect(overlay).toBeVisible();
    await expect(pane.locator('.xterm-rows')).not.toContainText('PS C:');

    // A suppressed mount skips the scrollback fetch (the pane's own contract),
    // so the only replay still to come is the lift's.
    const scrollbackCallsBeforeLift = await scrollbackCallCount(page);
    expect(scrollbackCallsBeforeLift).toBe(0);

    await markFirstOutput(page);
    await expect(overlay).toBeHidden({ timeout: 5000 });
    await expect(commandWindow.locator(OVERLAY_SELECTOR)).toHaveCount(0);
    // The lift replayed the scrollback (main's view of the screen), and the
    // dropped prompt is not in the terminal.
    await expect.poll(() => scrollbackCallCount(page), { timeout: 5000 }).toBeGreaterThan(scrollbackCallsBeforeLift);
    await settleFrames(page);
    await expect(pane.locator('.xterm-rows')).not.toContainText('PS C:');

    // Dropping ends with the overlay: live bytes reach the terminal now.
    await fireSessionData(page, AGENT_OUTPUT);
    await expect(pane.locator('.xterm-rows')).toContainText(AGENT_OUTPUT, { timeout: 5000 });
  } finally {
    await browser.close();
  }
});

test('the window draws the overlay while the spawn is in flight, then the pane takes it over', async () => {
  const { browser, page } = await launch(true);
  try {
    const commandWindow = await openCommandTerminal(page);
    const windowOverlay = commandWindow.locator(OVERLAY_SELECTOR);
    const pane = commandWindow.getByTestId('command-bar-terminal-pane');

    // The spawn is parked, so there is no session and no pane to hold an
    // overlay. The window draws it.
    await expect(windowOverlay).toBeVisible();
    await expect(windowOverlay).toContainText(LAUNCH_LABEL);
    await expect(windowOverlay).toHaveCount(1);
    await expect(pane).toHaveCount(0);

    await watchPaneOverlays(page);
    await releaseSpawn(page);

    // The pane mounts and the overlay is now its own: same label, drawn once,
    // inside the pane, with the window-level one gone.
    await expect(pane).toHaveAttribute('data-session-id', SESSION_ID, { timeout: 8000 });
    const paneOverlay = pane.locator(OVERLAY_SELECTOR);
    await expect(paneOverlay).toBeVisible();
    await expect(paneOverlay).toContainText(LAUNCH_LABEL);
    await expect(paneOverlay).toHaveCount(1);
    await expect(commandWindow.locator(OVERLAY_SELECTOR)).toHaveCount(1);

    // The positive control for test 3: the watcher does see an overlay drawn in
    // the pane, so "zero sightings" there means the overlay never appeared.
    expect(await paneOverlaySightings(page)).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});

test('a pane that mounts with the agent already on screen never draws the overlay and replays once', async () => {
  const { browser, page } = await launch(true);
  try {
    const commandWindow = await openCommandTerminal(page);
    const pane = commandWindow.getByTestId('command-bar-terminal-pane');

    // The spawn is parked, so there is no pane yet and the mark below lands
    // before it exists. Main's first-output mark beat the spawn reply, so `ready`
    // is true on the pane's first render.
    await expect(pane).toHaveCount(0);
    await markFirstOutput(page);
    // A wiped mark would leave the pane mounting un-ready and the test below
    // asserting on the wrong scenario, so fail here instead.
    expect(await hasFirstOutputMark(page)).toBe(true);

    await watchPaneOverlays(page);
    await releaseSpawn(page);

    await expect(pane).toHaveAttribute('data-session-id', SESSION_ID, { timeout: 8000 });
    await waitForPaneInitialized(page, pane);
    expect(await hasFirstOutputMark(page)).toBe(true);
    await expect(pane.locator(OVERLAY_SELECTOR)).toHaveCount(0);
    await expect(commandWindow.locator(OVERLAY_SELECTOR)).toHaveCount(0);

    // The terminal is live from its first frame. The bytes are kept (the mount
    // replay holds them, then flushes), so seeing them on screen also means the
    // mount replay has settled, which is the fence for the count below: any
    // second replay a ready edge would have started has been issued by now.
    await fireSessionData(page, AGENT_OUTPUT);
    await expect(pane.locator('.xterm-rows')).toContainText(AGENT_OUTPUT, { timeout: 5000 });
    expect(await scrollbackCallCount(page)).toBe(1);

    expect(await paneOverlaySightings(page)).toBe(0);
  } finally {
    await browser.close();
  }
});
