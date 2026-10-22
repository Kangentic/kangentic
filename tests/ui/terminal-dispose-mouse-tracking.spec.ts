/**
 * A terminal disposed while xterm's document mouse listeners are pending leaves
 * nothing behind (Sentry DESKTOP-1G).
 *
 * With mouse reporting on (Claude Code's fullscreen TUI sends ?1000h ?1002h ?1003h
 * ?1006h), a mousedown on the terminal parks a `mouseup` and a drag `mousemove`
 * listener on `document`. Under xterm 6.0 only the mouseup handler or a protocol
 * change removed them. Disposed in between, the next mouseup or held mousemove
 * anywhere threw `Cannot read properties of undefined (reading 'dimensions')`,
 * and kept throwing on every click for the life of the page. The app released
 * mouse tracking before every dispose to work around it.
 *
 * xterm 6.1 (xtermjs/xterm.js#5591) registers those listeners as disposables of
 * the terminal, so dispose() removes them and the workaround is gone. This spec
 * now guards the upstream fix across xterm upgrades.
 *
 * The test arms the listeners with a real press, unmounts the terminal while the
 * button is held, then moves, releases and clicks elsewhere. The unmount goes
 * through the store inside page.evaluate rather than a keystroke during the hold,
 * so it is deterministic. The CDP listener count is both the positive control
 * (the press really armed the document) and the proof that nothing outlives the
 * terminal.
 *
 * The second case runs the same sequence in the Agent Monitor's pop-out window,
 * the one surface where a terminal lives in a renderer other than the main
 * window's. xterm 6.1 parks these listeners on the element's own document
 * (xtermjs/xterm.js#6019, #5813), so the pop-out host is checked on its own.
 */
import path from 'node:path';
import { test, expect, chromium, type Locator, type Page, type CDPSession } from '@playwright/test';
import {
  collectPageErrors,
  fireSessionData,
  gotoVite,
  launchWithTransientTerminal,
  openTransientCommandTerminal,
  waitForViteReady,
  writtenToSession,
} from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const TRANSIENT_SESSION_ID = 'sess-dispose-mouse-tracking-1';
const POP_OUT_SESSION_ID = 'sess-dispose-mouse-tracking-pop-out';
/** What Claude Code's fullscreen TUI sends: click, drag, any-motion, SGR encoding. */
const CLAUDE_MOUSE_MODES = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';

/**
 * Turn mouse reporting on the way the agent TUI does. Re-fired inside the poll:
 * a chunk that lands during the mount replay is superseded by the replay's
 * frame, and the DECSETs are idempotent. xterm marks `.xterm` with
 * `enable-mouse-events` once a protocol with events is active.
 */
async function enableMouseReporting(page: Page, terminal: Locator, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    await fireSessionData(page, sessionId, CLAUDE_MOUSE_MODES);
    return terminal.evaluate((element) => element.classList.contains('enable-mouse-events'));
  }, { timeout: 10000, intervals: [250] }).toBe(true);
}

/**
 * One project with one running task session, a Monitor row for it, and the
 * descriptor main hands a Monitor pop-out window, so the page boots as that
 * window's renderer rather than the board.
 */
function monitorPopOutPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: 'proj-pop-out-mouse', name: 'Pop-out Mouse', path: '/mock/pop-out-mouse',
        github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, {
          id: 'lane-pop-out-mouse-' + index, position: index, created_at: timestamp,
        }));
      });
      state.tasks.push({
        id: 'task-pop-out-mouse', title: 'Pop-out terminal', description: '', display_id: 3,
        swimlane_id: 'lane-pop-out-mouse-2', position: 0, labels: [], priority: 0, run_mode: 'agent',
        archived_at: null, created_at: timestamp, updated_at: timestamp,
      });
      state.sessions.push({
        id: '${POP_OUT_SESSION_ID}', taskId: 'task-pop-out-mouse', projectId: 'proj-pop-out-mouse',
        pid: 4300, status: 'running', shell: 'bash', cwd: '/mock/pop-out-mouse', startedAt: timestamp, exitCode: null,
      });
      return { currentProjectId: 'proj-pop-out-mouse' };
    });
    window.__mockMonitorRows = [{
      sessionId: '${POP_OUT_SESSION_ID}', projectId: 'proj-pop-out-mouse', projectName: 'Pop-out Mouse',
      taskId: 'task-pop-out-mouse', taskTitle: 'Pop-out terminal', outputPeek: [], displayId: 3,
      columnName: 'Executing', commandTerminalBranch: null, labels: [], prUrl: null, prNumber: null, prState: null,
      agentName: 'claude', modelDisplayName: 'Haiku 5.5', effort: 'low', permissionMode: 'acceptEdits',
      startedAt: '2026-01-01T00:00:00.000Z', exitedAt: null,
      status: 'running', activity: 'idle', activityReason: null,
      lastEvent: null, contextPercent: null, isolated: false, isCommandTerminal: false
    }];
    window.electronAPI.popOut.descriptor = { kind: 'monitor', params: {} };
  `;
}

/** How many `mouseup` and `mousemove` listeners sit on `document` right now. */
async function countDocumentMouseListeners(client: CDPSession): Promise<number> {
  const { result } = await client.send('Runtime.evaluate', { expression: 'document', objectGroup: 'mouse-listeners' });
  if (!result.objectId) throw new Error('no remote object for document');
  const { listeners } = await client.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  await client.send('Runtime.releaseObjectGroup', { objectGroup: 'mouse-listeners' });
  return listeners.filter((listener) => listener.type === 'mouseup' || listener.type === 'mousemove').length;
}

test('disposing a terminal mid-press leaves no document mouse listener to throw on later clicks', async () => {
  const { browser, page } = await launchWithTransientTerminal({
    projectId: 'proj-dispose-mouse-tracking',
    projectName: 'Dispose Mouse Tracking Project',
    sessionId: TRANSIENT_SESSION_ID,
  });
  try {
    const pageErrors = collectPageErrors(page);
    const client = await page.context().newCDPSession(page);

    await openTransientCommandTerminal(page, TRANSIENT_SESSION_ID);
    await enableMouseReporting(
      page,
      page.getByTestId('command-terminal-window').locator('.xterm').first(),
      TRANSIENT_SESSION_ID,
    );

    const screen = page.getByTestId('command-terminal-window').locator('.xterm-screen').first();
    const box = await screen.boundingBox();
    if (!box || box.width === 0 || box.height === 0) throw new Error('terminal screen has no box');
    const pressX = box.x + box.width / 2;
    const pressY = box.y + box.height / 2;

    const baseline = await countDocumentMouseListeners(client);
    await page.mouse.move(pressX, pressY);
    await page.mouse.down();
    // Positive control: the press armed xterm's document listeners (mouseup,
    // plus the drag mousemove under ?1002h), so the case below is not vacuous.
    expect(await countDocumentMouseListeners(client)).toBeGreaterThan(baseline);

    // Hide the Command Terminal layer while the button is still held, which
    // unmounts the window and disposes its xterm.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { session?: { getState: () => { setCommandBarVisible: (visible: boolean) => void } } };
      }).__zustandStores;
      stores?.session?.getState().setCommandBarVisible(false);
    });
    await expect(page.getByTestId('command-terminal-window')).toHaveCount(0);
    await expect(page.locator('.xterm')).toHaveCount(0);

    // Nothing the dead terminal parked may still be listening. Soft, so a
    // failure still drives the clicks below and reports what they throw.
    expect.soft(await countDocumentMouseListeners(client)).toBe(baseline);

    // A held move (the drag listener), the release (the mouseup listener), then
    // ordinary clicks elsewhere, which is where the field reports kept firing.
    await page.mouse.move(pressX + 40, pressY + 20);
    await page.mouse.up();
    await page.mouse.click(pressX - 60, pressY);
    await page.mouse.click(pressX + 60, pressY + 40);

    expect(pageErrors()).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a terminal in the Monitor pop-out reports the wheel and leaves no document mouse listener when disposed mid-press', async () => {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const pageErrors = collectPageErrors(page);
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(monitorPopOutPreConfig());
    await gotoVite(page);
    const client = await page.context().newCDPSession(page);

    // The pop-out root renders the Monitor body itself; a card opens the task's
    // detail window, with its terminal, in this window's own detail layer.
    const cardTitle = page.locator(`[data-session-id="${POP_OUT_SESSION_ID}"] [data-testid="monitor-card-title"]`);
    await cardTitle.waitFor({ state: 'visible', timeout: 15000 });
    // The pop-out root, not the board with the Monitor overlay open over it.
    await expect(page.locator('[data-swimlane-name="To Do"]')).toHaveCount(0);
    await cardTitle.click();
    const terminal = page.locator('#monitor-detail-layer-root .xterm').first();
    await terminal.waitFor({ state: 'attached', timeout: 10000 });
    // The pop-out mounts no App.tsx, so there is no __zustandStores handle. The
    // Vite-served page imports the same store module the window renders from.
    await page.evaluate(async (sessionId) => {
      const sessionStoreModule = '/src/renderer/stores/session-store.ts';
      const { useSessionStore } = await import(sessionStoreModule) as {
        useSessionStore: { getState: () => { markFirstOutput: (id: string) => void } };
      };
      useSessionStore.getState().markFirstOutput(sessionId);
    }, POP_OUT_SESSION_ID);
    await enableMouseReporting(page, terminal, POP_OUT_SESSION_ID);

    const screen = page.locator('#monitor-detail-layer-root .xterm-screen').first();
    const box = await screen.boundingBox();
    if (!box || box.width === 0 || box.height === 0) throw new Error('pop-out terminal screen has no box');
    const pressX = box.x + box.width / 2;
    const pressY = box.y + box.height / 2;

    // The wheel reaches the agent as an SGR wheel-up report, as it does in the
    // main window.
    await page.mouse.move(pressX, pressY);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => (await writtenToSession(page, POP_OUT_SESSION_ID)).includes('\x1b[<64;'), {
      timeout: 5000,
    }).toBe(true);

    const baseline = await countDocumentMouseListeners(client);
    await page.mouse.down();
    // Positive control: the press armed listeners on the pop-out's document.
    expect(await countDocumentMouseListeners(client)).toBeGreaterThan(baseline);

    // Close the detail window while the button is still held, which disposes
    // its xterm.
    await page.evaluate(async () => {
      const windowStoreModule = '/src/renderer/window-manager/store/window-store.ts';
      const { monitorWindowManager } = await import(windowStoreModule) as {
        monitorWindowManager: { store: { getState: () => { windows: Record<string, unknown>; closeWindow: (id: string) => void } } };
      };
      const state = monitorWindowManager.store.getState();
      for (const windowId of Object.keys(state.windows)) state.closeWindow(windowId);
    });
    await expect(page.locator('#monitor-detail-layer-root .xterm')).toHaveCount(0);

    expect.soft(await countDocumentMouseListeners(client)).toBe(baseline);

    await page.mouse.move(pressX + 40, pressY + 20);
    await page.mouse.up();
    await page.mouse.click(pressX - 60, pressY);
    await page.mouse.click(pressX + 60, pressY + 40);

    expect(pageErrors()).toEqual([]);
  } finally {
    await browser.close();
  }
});
