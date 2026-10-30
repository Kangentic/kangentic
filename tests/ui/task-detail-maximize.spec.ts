/**
 * UI tests for the Task Detail maximize / restore toggle.
 *
 * Covers:
 * - Maximize button toggle: window frame transitions between floating (rounded-lg)
 *   and maximized (rounded-none, fills the window-overlay area between app chrome)
 * - Ctrl/Cmd+Shift+M keyboard toggle (maximize/restore)
 * - Ctrl/Cmd+Shift+W closes the window
 * - Ctrl/Cmd+Shift+B toggles the Browser pane when canShowBrowser is true
 * - Edit mode: maximize button is present and the hotkey maximizes/restores
 * - Create dialog (New Task): maximize button + hotkey toggle the layout
 * - BaseDialog default-prop non-regression: plain consumers keep inset-0 / rounded-lg
 *
 * Window model notes: the task-detail surface is now a MODELESS window rendered
 * inside WindowFrame on a WindowLayer portal overlay. There is no modal backdrop.
 * The dialog content div (`data-testid="task-detail-dialog"`) is always
 * `flex h-full w-full flex-col` regardless of maximized state; sizing is expressed
 * on the FRAME (`data-testid="window-frame-<id>"`) via inline absolute positioning
 * and corner-radius classes: `rounded-lg` = floating/restored, `rounded-none` =
 * maximized (or tiled). The overlay itself is always `top-10 bottom-9` (constrained
 * to the space between the title bar and status bar) - the frame fills it when maximized.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import {
  waitForViteReady, gotoVite, recordLayoutChange, expectHoldThenDraw, expectNoFrameHold, expectNoFrameHoldRecovery,
  pictureStages, brightPixelsIn, markSessionFirstOutput, readTerminalTrace, settleFrames, isManagerResizeGateOpen,
  TERMINAL_FRAME_HOLD_ATTRIBUTE, TERMINAL_FRAME_HOLD_SELECTOR,
} from './helpers';
import { launch as launchMonitorSeed, openMonitor, byTestId, sessionIdOf } from './monitor-writes-seed';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Wait until no PTY resize has been sent for a beat, then forget the ones that were. */
async function settleResizeLog(ownPage: Page): Promise<void> {
  let previousCount = -1;
  await expect.poll(async () => {
    const count = await ownPage.evaluate(() => window.electronAPI.sessions.__resizeCalls.length);
    const settled = count === previousCount;
    previousCount = count;
    return settled;
  }, { intervals: [300], timeout: 8000 }).toBe(true);
  await ownPage.evaluate(() => { window.electronAPI.sessions.__resizeCalls.length = 0; });
}

const PROJECT_ID = 'proj-maximize';
const TASK_ID = 'task-maximize';
const SESSION_ID = 'sess-maximize';

// A second task in To Do opens in edit mode by default (no session context).
const EDIT_TASK_ID = 'task-maximize-edit';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Maximize Test',
      path: '/mock/maximize-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so displayState.kind === 'running' -> dialog opens in
    // non-editing mode (large layout) and the maximize button is rendered.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/maximize-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'Maximize Task',
      description: 'Task used for the maximize toggle test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/maximize',
      branch_name: 'feature/maximize',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // A To Do task with no session - opens in edit mode (initialEdit = true
    // is forced by useTaskSessionState when role=todo and no session context).
    state.tasks.push({
      id: '${EDIT_TASK_ID}',
      display_id: 2,
      title: 'Edit Mode Task',
      description: 'Task used to reach edit mode for the maximize guard test',
      swimlane_id: laneIds['To Do'],
      position: 0,
      agent: null,
      session_id: null,
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  // Closing a Chromium that has run a terminal can take longer than the project's 15 s hook budget on
  // a starved runner, and a hook timeout fails whichever test ran last in the worker.
  test.setTimeout(45000);
  await browser?.close();
});

test.describe('Task Detail: the terminal through a maximize', () => {
  /** Open the task's window with its agent on screen, its terminal full of text, the cursor hidden (it blinks) and motion off. */
  async function openStillTerminal(ownPage: Page): Promise<void> {
    await ownPage.locator('[data-swimlane-name="Code Review"]').locator('text=Maximize Task').first().click();
    await ownPage.locator('[data-testid="task-detail-dialog"] .xterm-screen').waitFor({ timeout: 10000 });
    // The agent on screen, so its launch overlay lifts.
    await markSessionFirstOutput(ownPage, SESSION_ID);
    await expect(ownPage.locator('[data-testid="task-detail-dialog"] [data-testid="launch-overlay"]')).toHaveCount(0);
    await ownPage.evaluate((sessionId) => {
      let screen = '';
      for (let row = 0; row < 24; row += 1) screen += `frame text line ${row} `.padEnd(100, '.') + '\r\n';
      (window as unknown as { __mockFireSessionData: (id: string, data: string) => void }).__mockFireSessionData(sessionId, `${screen}\x1b[?25l`);
      document.documentElement.classList.add('no-motion');
    }, SESSION_ID);
    await ownPage.waitForTimeout(800);
  }

  /** The PTY resizes the renderer asked for since `since` (ms since epoch), by origin. */
  const resizeOrigins = (ownPage: Page, since: number) => ownPage.evaluate((from) => (window as unknown as {
    __kangenticTerminalTrace: () => Array<{ ts: number; event: string; detail?: { origin?: string } }>;
  }).__kangenticTerminalTrace().filter((event) => event.ts >= from && event.event === 'resize-request').map((event) => event.detail?.origin), since);

  test('maximize shows at once with the terminal holding its frame, then the new one: one PTY resize', async () => {
    // Its own browser plus a screencast whose frames are decoded in the page:
    // measured at 9 to 14 s locally, too close to the 15 s default for CI.
    test.setTimeout(45000);
    // Its own browser: the shared page above carries other tests' window state.
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await openStillTerminal(ownPage);
      const since = Date.now();
      const recording = await recordLayoutChange(ownPage, '[data-testid="window-overlay"]', () =>
        ownPage.locator('[data-testid="task-detail-maximize"]').click());
      expectHoldThenDraw(recording);
      // The PTY was resized once, for the grid the maximized window fits, and the
      // hold's own resize at its end sent nothing more.
      expect(await resizeOrigins(ownPage, since)).toEqual(['frame-hold']);
      await expectNoFrameHoldRecovery(ownPage, since);
      await expect(ownPage.locator('[data-testid^="window-frame-"]').filter({
        has: ownPage.locator('[data-testid="task-detail-dialog"]'),
      })).toHaveClass(/rounded-none/);
    } finally {
      await own.browser.close();
    }
  });

  test('an agent whose finished frame lands 130 ms after the resize ends the hold on that frame, drawn whole', async () => {
    // The repaint wait ends 20 ms after the agent's first finished frame (a
    // synchronized update) instead of waiting out its 190 ms floor. Drawing it
    // that soon is only right if xterm has drawn the frame by then, which only
    // the compositor's own frames can show.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await openStillTerminal(ownPage);
      // The agent, the way a resize arrives through ConPTY: first ConPTY's own
      // redraw of the screen, 30 ms after the send (here a cleared screen with
      // three lines, the flash this whole change exists to keep off screen), then
      // the agent's whole frame at the new grid 130 ms after it, inside a
      // synchronized update. The frame's text depends on the grid, so a frame
      // drawn at the old size reads as a different picture.
      await ownPage.evaluate((sessionId) => {
        const holder = window as unknown as {
          electronAPI: { sessions: { resize: (id: string, cols: number, rows: number) => Promise<unknown> } };
          __mockFireSessionData: (id: string, data: string) => void;
        };
        const original = holder.electronAPI.sessions.resize;
        holder.electronAPI.sessions.resize = (id, cols, rows) => {
          if (id === sessionId) {
            setTimeout(() => {
              holder.__mockFireSessionData(id, '\x1b[H\x1b[2Jredraw 1\r\nredraw 2\r\nredraw 3\r\n');
            }, 30);
            setTimeout(() => {
              let screen = '';
              for (let row = 0; row < rows - 1; row += 1) screen += `${cols}x${rows} row ${row} `.padEnd(cols - 2, '.') + '\r\n';
              holder.__mockFireSessionData(id, `\x1b[?2026h\x1b[H\x1b[2J${screen}\x1b[?25l\x1b[?2026l`);
            }, 130);
          }
          return original(id, cols, rows);
        };
      }, SESSION_ID);

      const since = Date.now();
      const recording = await recordLayoutChange(ownPage, '[data-testid="window-overlay"]', () =>
        ownPage.locator('[data-testid="task-detail-maximize"]').click());
      // Three pictures: before, the kept frame in the maximized window, and the
      // agent's frame whole. Never ConPTY's early redraw, and never the old frame
      // reflowed onto the new grid before the agent's.
      expectHoldThenDraw(recording);
      expect(pictureStages(recording).length).toBe(3);
      expect(await resizeOrigins(ownPage, since)).toEqual(['frame-hold']);
      await expectNoFrameHoldRecovery(ownPage, since);
      // The fast path decided it: the wait settled on the agent's frame, not on
      // the floor or the quiet beat. Asserted on the decision rather than the
      // clock: headless software GL takes a third of a second to draw a full
      // screen, and a loaded runner fires the fake agent's own timer late.
      const settled = await ownPage.evaluate(() => (window as unknown as {
        __kangenticTerminalTrace: () => Array<{ event: string; detail?: { reason?: string } }>;
      }).__kangenticTerminalTrace().filter((event) => event.event === 'repaint-wait-settled').at(-1)?.detail);
      expect(settled?.reason).toBe('frame');
      // And the terminal holds the agent's frame at the maximized grid.
      const rows = await ownPage.evaluate((sessionId) => (window as unknown as {
        __kangenticTerminalGridRows: (id: string) => Array<{ cols: number; viewportRows: string[] }>;
      }).__kangenticTerminalGridRows(sessionId)[0], SESSION_ID);
      expect(rows?.viewportRows.some((row) => row.startsWith(`${rows.cols}x`))).toBe(true);
    } finally {
      await own.browser.close();
    }
  });

  /**
   * A full-screen agent the way Claude Code draws one: a banner on the top rows,
   * the input box on the bottom rows, nothing between, and every PTY resize
   * answered by ConPTY's early redraw at 30 ms and the agent's whole frame at the
   * new grid at 130 ms. Draws its first frame at the terminal's current grid.
   */
  async function fullScreenAgent(ownPage: Page): Promise<void> {
    await ownPage.evaluate((sessionId) => {
      const holder = window as unknown as {
        electronAPI: { sessions: { resize: (id: string, cols: number, rows: number) => Promise<unknown> } };
        __mockFireSessionData: (id: string, data: string) => void;
        __kangenticTerminalGridRows: (id: string) => Array<{ cols: number; viewportRows: string[] }>;
      };
      const screenFor = (cols: number, rows: number) => '\x1b[?2026h\x1b[H\x1b[2J'
        + '\x1b[1;1HClaude Code v2.1.310 banner line one'
        + '\x1b[2;1HHaiku with low effort banner line two'
        + `\x1b[${rows - 3};1H` + '='.repeat(cols - 1)
        + `\x1b[${rows - 2};1H> type here, the input box`
        + `\x1b[${rows - 1};1H` + '='.repeat(cols - 1)
        + `\x1b[${rows};1H>> accept edits on\x1b[?25l\x1b[?2026l`;
      const original = holder.electronAPI.sessions.resize;
      holder.electronAPI.sessions.resize = (id, cols, rows) => {
        if (id === sessionId) {
          setTimeout(() => holder.__mockFireSessionData(id, '\x1b[H\x1b[2Jredraw\r\n'), 30);
          setTimeout(() => holder.__mockFireSessionData(id, screenFor(cols, rows)), 130);
        }
        return original(id, cols, rows);
      };
      const grid = holder.__kangenticTerminalGridRows(sessionId)[0];
      holder.__mockFireSessionData(sessionId, screenFor(grid.cols, grid.viewportRows.length));
    }, SESSION_ID);
    await ownPage.waitForTimeout(500);
  }

  /**
   * The task window terminal's box in page pixels, and its top and bottom rows.
   * Inset from the host's edges: a picture 240 px wide rounds a region outward,
   * which took in a row of the window header's border, and the scrollbar's
   * column at the right edge is drawn whether or not the screen is shown.
   */
  async function terminalRegions(ownPage: Page): Promise<{ whole: { x: number; y: number; width: number; height: number }; top: { x: number; y: number; width: number; height: number }; bottom: { x: number; y: number; width: number; height: number } }> {
    const host = await ownPage.locator('[data-testid="task-detail-dialog"] [data-terminal-host]').boundingBox();
    if (!host) throw new Error('no terminal host');
    const inset = 16;
    const box = { x: host.x + inset, y: host.y + inset, width: host.width - inset - 32, height: host.height - inset * 2 };
    const band = box.height * 0.12;
    return {
      whole: box,
      top: { x: box.x, y: box.y, width: box.width, height: band },
      bottom: { x: box.x, y: box.y + box.height - band, width: box.width, height: band },
    };
  }

  test('a terminal whose box grows draws no old text in it until the agent\'s frame is in', async () => {
    // The old frame no longer fills a box that grew, and drawn there it sat
    // narrow and low in the maximized window, so it is not drawn at all.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await openStillTerminal(ownPage);
      await fullScreenAgent(ownPage);
      const recording = await recordLayoutChange(ownPage, '[data-testid="window-overlay"]', () =>
        ownPage.locator('[data-testid="task-detail-maximize"]').click());
      expectHoldThenDraw(recording);
      // From the frame the window maximized on, the terminal shows nothing, then
      // the agent's frame, and nothing else (not ConPTY's early redraw).
      const { whole } = await terminalRegions(ownPage);
      const changedAt = pictureStages(recording)[1].at;
      const shown = recording.frames.filter((frame) => frame.at >= changedAt).map((frame) => brightPixelsIn(recording, frame.picture, whole));
      const finalText = shown.at(-1) ?? 0;
      const summary = shown.join(' ');
      expect(finalText, summary).toBeGreaterThan(50);
      const firstDrawn = shown.findIndex((bright) => bright >= 10);
      expect(firstDrawn, summary).toBeGreaterThan(0);
      expect(shown.slice(firstDrawn).every((bright) => Math.abs(bright - finalText) <= finalText * 0.1), summary).toBe(true);
    } finally {
      await own.browser.close();
    }
  });

  test('a terminal whose box shrinks keeps its bottom rows, the input box, where the agent\'s frame puts them', async () => {
    // An agent keeps its input box on the bottom rows, so a frame that still
    // fills its box is pinned to the bottom. Pinned to the top, a restore showed
    // the banner with the input box cut off until the agent's frame put it back.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await openStillTerminal(ownPage);
      await fullScreenAgent(ownPage);
      await ownPage.locator('[data-testid="task-detail-maximize"]').click();
      await expectNoFrameHold(ownPage);
      await ownPage.waitForTimeout(500);
      const recording = await recordLayoutChange(ownPage, '[data-testid="window-overlay"]', () =>
        ownPage.locator('[data-testid="task-detail-maximize"]').click());
      expectHoldThenDraw(recording);
      // From the frame the window restored on: the input box on the bottom rows
      // in every frame, the top empty while the frame is held, then filled.
      const { top, bottom } = await terminalRegions(ownPage);
      const changedAt = pictureStages(recording)[1].at;
      const shown = recording.frames.filter((frame) => frame.at >= changedAt).map((frame) => ({
        bottom: brightPixelsIn(recording, frame.picture, bottom),
        top: brightPixelsIn(recording, frame.picture, top),
      }));
      const summary = shown.map((frame) => `${frame.top}/${frame.bottom}`).join(' ');
      // The swap, as the app traced it: when it hid the screen to resize and parse, when it showed
      // it again, and how many frames painted in between. Both times are on the page's clock, so
      // only their difference is used. They are never compared with the screencast's frame stamps.
      const swap = await ownPage.evaluate(() => {
        const trace = (window as unknown as {
          __kangenticTerminalTrace: () => Array<{ ts: number; event: string; detail?: { framesHidden?: number } }>;
        }).__kangenticTerminalTrace();
        const started = trace.filter((event) => event.event === 'frame-hold-finish-start').at(-1);
        const finished = trace.filter((event) => event.event === 'frame-hold-finished').at(-1);
        return { startedAt: started?.ts ?? null, finishedAt: finished?.ts ?? null, framesHidden: finished?.detail?.framesHidden ?? null };
      });
      expect(swap.startedAt, summary).not.toBeNull();
      expect(swap.finishedAt, summary).not.toBeNull();
      expect(swap.framesHidden, summary).not.toBeNull();
      const swapStartedAt = swap.startedAt ?? 0;
      const swapFinishedAt = swap.finishedAt ?? 0;
      // The swap hides the screen on purpose while xterm resizes and parses the agent's frame, and a
      // frame that paints in that gap is blank (a blank frame beats the old one reflowed onto the
      // new grid). Whether one does is the compositor's timing against the parse, which a loaded
      // runner decides. This test saw one blank frame in 4 of 40 runs on two cores, each with the
      // trace's framesHidden at 1. So the held frames are strict, and a blank frame is accepted only
      // where the app hides the screen, which is one unbroken run after the kept frame was on screen
      // and before the agent's frame is. That position is read from the recording's own order, not
      // from timestamps. The screencast stamps its frames on the compositor's clock and the trace
      // stamps the swap on the page's, and on a starved CI runner the two disagreed by more than the
      // swap is wide (a 56 ms swap with its one blank frame stamped outside 100 ms of it).
      const firstFilled = shown.findIndex((frame) => frame.top >= 10);
      // Held at least a frame, then filled for good.
      expect(firstFilled, summary).toBeGreaterThan(0);
      expect(shown.slice(firstFilled).every((frame) => frame.top >= 10), summary).toBe(true);
      const blankIndexes = shown.flatMap((frame, index) => (frame.bottom <= 20 ? [index] : []));
      const blankAt = `blank frames at index ${blankIndexes.join(',') || 'none'} of ${shown.length}, the agent's frame from ${firstFilled}: ${summary}`;
      // The input box is on the bottom rows in every frame the screen was not hidden for. The kept
      // frame is on screen from the first frame the window restored on.
      expect(shown[0].bottom > 20, `the first frame has no input box, ${blankAt}`).toBe(true);
      // The screen is hidden once, so its blank frames are one unbroken run, never a flash that
      // comes back and goes again.
      const lastBlank = blankIndexes.at(-1) ?? -1;
      expect(
        blankIndexes.length === 0 || lastBlank - blankIndexes[0] + 1 === blankIndexes.length,
        `the blank frames are not one run, ${blankAt}`,
      ).toBe(true);
      // And it ends before the agent's frame is on screen, never after it.
      expect(lastBlank < firstFilled, `a blank frame at or after the agent's frame, ${blankAt}`).toBe(true);
      // Every blank frame is one the app counted. framesHidden is exact on both ways the swap shows
      // the screen: in the next frame, or from nextFrame's 50 ms fallback on a runner too starved to
      // paint one (countHiddenFrames). It was a frame short on the fallback, so one blank frame
      // read as a flash the app had not counted. And the screen was never hidden past the repaint
      // wait's draw cap and that fallback (useTerminal's FRAME_HOLD_DRAW_MAX_MS), with room for a
      // starved runner.
      expect(blankIndexes.length, summary).toBeLessThanOrEqual(swap.framesHidden ?? 0);
      expect(swapFinishedAt - swapStartedAt, summary).toBeLessThanOrEqual(1000);
    } finally {
      await own.browser.close();
    }
  });

  test('a frame in a box that grew fades in, and one in a box that shrank does not, with Animations on', async () => {
    // The only test with motion on: every other one sets `.no-motion`, under which
    // the fade is an instant cut.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await openStillTerminal(ownPage);
      await fullScreenAgent(ownPage);
      await ownPage.evaluate(() => document.documentElement.classList.remove('no-motion'));
      // The animations on the terminal's screen the moment its hold ends, read
      // as the hold's mark comes off the host.
      const animationsWhenHoldEnds = () => ownPage.evaluate((hold) => new Promise<Array<{ duration: number; opacity: boolean }>>((resolve) => {
        let held = false;
        new MutationObserver((records, observer) => {
          if (document.querySelector(hold.selector)) {
            held = true;
            return;
          }
          if (!held) return;
          observer.disconnect();
          const screen = document.querySelector('[data-testid="task-detail-dialog"] .xterm-screen');
          resolve((screen?.getAnimations() ?? []).map((animation) => {
            const effect = animation.effect as KeyframeEffect;
            return { duration: Number(effect.getTiming().duration), opacity: Object.keys(effect.getKeyframes()[0] ?? {}).includes('opacity') };
          }));
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: [hold.attribute] });
      }), { selector: TERMINAL_FRAME_HOLD_SELECTOR, attribute: TERMINAL_FRAME_HOLD_ATTRIBUTE });

      const onMaximize = animationsWhenHoldEnds();
      await ownPage.locator('[data-testid="task-detail-maximize"]').click();
      expect(await onMaximize).toEqual([{ duration: 80, opacity: true }]);
      await expectNoFrameHold(ownPage);
      await ownPage.waitForTimeout(300);

      const onRestore = animationsWhenHoldEnds();
      await ownPage.locator('[data-testid="task-detail-maximize"]').click();
      expect(await onRestore).toEqual([]);
    } finally {
      await own.browser.close();
    }
  });

  test('a frame hold whose resize throws ends at once and the terminal refits: its output is never held for good', async () => {
    // A frame hold keeps the agent's output back until it ends, so a throw on the
    // way to its end must not strand it. Measured once in the desktop app: a
    // dev-mode update left the terminals holding with their output held.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await openStillTerminal(ownPage);
      await ownPage.evaluate(() => {
        const sessions = (window as unknown as {
          electronAPI: { sessions: { resize: (id: string, cols: number, rows: number) => Promise<unknown> } };
        }).electronAPI.sessions;
        const original = sessions.resize;
        let thrown = false;
        sessions.resize = (id, cols, rows) => {
          if (!thrown) {
            thrown = true;
            throw new Error('resize failed');
          }
          return original(id, cols, rows);
        };
      });
      await ownPage.locator('[data-testid="task-detail-maximize"]').click();
      await expectNoFrameHold(ownPage);
      const trace = await ownPage.evaluate(() => (window as unknown as {
        __kangenticTerminalTrace: () => Array<{ event: string; detail?: { reason?: string } }>;
      }).__kangenticTerminalTrace().filter((event) => event.event === 'frame-hold-dropped').map((event) => event.detail?.reason));
      expect(trace).toContain('send-failed');
      // The terminal took the maximized grid as a plain refit, and its output flows.
      await ownPage.evaluate((sessionId) => {
        (window as unknown as { __mockFireSessionData: (id: string, data: string) => void }).__mockFireSessionData(sessionId, 'after the throw\r\n');
      }, SESSION_ID);
      await expect.poll(async () => {
        const rows = await ownPage.evaluate((sessionId) => (window as unknown as {
          __kangenticTerminalGridRows: (id: string) => Array<{ viewportRows: string[] }>;
        }).__kangenticTerminalGridRows(sessionId)[0], SESSION_ID);
        return rows?.viewportRows.some((row) => row.startsWith('after the throw')) ?? false;
      }, { timeout: 3000 }).toBe(true);
    } finally {
      await own.browser.close();
    }
  });

  test('output that never stops still ends the hold by the cap, and every byte of it is drawn', async () => {
    // The agent's output is held while its frame is. A stream that never goes
    // quiet must not keep the hold open for good: the repaint wait's cap ends it,
    // and what was held is drawn when it ends, not dropped.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await openStillTerminal(ownPage);
      // The stream writes a line every 10 ms for as long as the page gets the CPU to, so how many
      // lines it writes belongs to the runner: a loaded 2-core CI runner wrote 20 across the whole
      // hold, where an idle one writes about 50. Every count below is read from what was sent, never
      // assumed from the rate. The stream stops itself a few lines after the hold ends, so the
      // screen shows held output and the live lines that followed it.
      const linesAfterRelease = 5;
      type StreamHolder = {
        __mockFireSessionData: (id: string, data: string) => void;
        __streamTimer: ReturnType<typeof setInterval>;
        __streamCount: number;
        __streamReleasedAt: number | null;
      };
      await ownPage.evaluate(({ sessionId, afterRelease }) => {
        const holder = window as unknown as StreamHolder;
        holder.__streamCount = 0;
        holder.__streamReleasedAt = null;
        holder.__streamTimer = setInterval(() => {
          if (holder.__streamReleasedAt !== null && holder.__streamCount >= holder.__streamReleasedAt + afterRelease) {
            clearInterval(holder.__streamTimer);
            return;
          }
          holder.__streamCount += 1;
          holder.__mockFireSessionData(sessionId, `stream ${holder.__streamCount}\r\n`);
        }, 10);
      }, { sessionId: SESSION_ID, afterRelease: linesAfterRelease });
      const streamSince = Date.now();
      // The observer runs as a microtask of the change that put the hold's mark on or took it off,
      // before the stream's next tick, so each count is exactly what had been sent at that moment.
      const hold = await ownPage.evaluate((holdMark) => new Promise<{ heldFor: number; sentWhenHeld: number; sentWhenReleased: number }>((resolve) => {
        const holder = window as unknown as StreamHolder;
        let heldAt = 0;
        let sentWhenHeld = 0;
        new MutationObserver(() => {
          const holding = document.querySelector(holdMark.selector) !== null;
          if (holding && heldAt === 0) {
            heldAt = performance.now();
            sentWhenHeld = holder.__streamCount;
          }
          if (!holding && heldAt !== 0 && holder.__streamReleasedAt === null) {
            holder.__streamReleasedAt = holder.__streamCount;
            resolve({ heldFor: performance.now() - heldAt, sentWhenHeld, sentWhenReleased: holder.__streamCount });
          }
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: [holdMark.attribute] });
        document.querySelector<HTMLElement>('[data-testid="task-detail-maximize"]')?.click();
      }), { selector: TERMINAL_FRAME_HOLD_SELECTOR, attribute: TERMINAL_FRAME_HOLD_ATTRIBUTE });
      // Not before the wait's 500 ms cap, and ended well before a stuck hold
      // would show (the send waits a frame, and headless draws slowly).
      expect(hold.heldFor).toBeGreaterThanOrEqual(450);
      expect(hold.heldFor).toBeLessThanOrEqual(2000);
      // Output arrived while the hold was up, so there was output for it to hold.
      expect(hold.sentWhenReleased).toBeGreaterThan(hold.sentWhenHeld);
      // The cap ended it, not the watchdog.
      await expectNoFrameHoldRecovery(ownPage, streamSince);
      const sent = hold.sentWhenReleased + linesAfterRelease;
      const readScreen = async () => {
        const grid = await ownPage.evaluate((sessionId) => (window as unknown as {
          __kangenticTerminalGridRows: (id: string) => Array<{ viewportRows: string[]; cursorRow: number | null }>;
        }).__kangenticTerminalGridRows(sessionId)[0], SESSION_ID);
        const lines = (grid?.viewportRows ?? []).map((row) => /^stream (\d+)/.exec(row)?.[1]).filter((line): line is string => line !== undefined).map(Number);
        return { lines, cursorRow: grid?.cursorRow ?? null };
      };
      // The last line streamed shows, so the stream has stopped and everything is drawn.
      await expect.poll(async () => (await readScreen()).lines.at(-1), { timeout: 3000 }).toBe(sent);
      const { lines, cursorRow } = await readScreen();
      if (cursorRow === null) throw new Error('The terminal grid reported no cursor row.');
      // Every row above the cursor is a streamed line, or every streamed line is on screen. A flush
      // that dropped the head of what was held leaves fewer.
      expect(lines.length).toBe(Math.min(sent, cursorRow));
      // The lines on screen reach back into what the hold kept back, and run without a gap across
      // the moment it ended: nothing held was dropped, and none of it was drawn out of order.
      expect(lines[0]).toBeLessThanOrEqual(hold.sentWhenReleased);
      expect(lines.every((line, index) => index === 0 || line === lines[index - 1] + 1)).toBe(true);
    } finally {
      await own.browser.close();
    }
  });

  // main answers a hold's grid with one it keeps instead (a refusal, or the grid a phone holds the
  // PTY at). No repaint at the grid the hold asked for is coming, so the repaint wait must not run
  // out its floor (190 ms) or its cap (500 ms) for one.
  for (const answer of [
    { kept: 'refuses', result: { colsChanged: false, refused: true } },
    { kept: 'keeps another grid for', result: { colsChanged: false, held: { cols: 60, rows: 20 } } },
  ]) {
    test(`when main ${answer.kept} the terminal, the repaint wait is released at the answer and the hold ends`, async () => {
      test.setTimeout(45000);
      const own = await launchWithState(preConfig);
      try {
        const ownPage = own.page;
        await openStillTerminal(ownPage);
        // Only from here: the terminal's own startup fits were answered plainly.
        await ownPage.evaluate((result) => {
          (window as unknown as { __mockResizeResult: unknown }).__mockResizeResult = result;
        }, answer.result);
        const since = Date.now();

        await ownPage.locator('[data-testid="task-detail-maximize"]').click();

        // The wait settles because it was released, not because the agent went quiet or the cap came.
        await expect.poll(async () => (await readTerminalTrace(ownPage, since, ['repaint-wait-settled'])).length, { timeout: 5000 }).toBeGreaterThan(0);
        const [firstSettled] = await readTerminalTrace(ownPage, since, ['repaint-wait-settled']);
        expect(firstSettled.detail?.reason).toBe('released');
        await expectNoFrameHold(ownPage);
        await expectNoFrameHoldRecovery(ownPage, since);
      } finally {
        await own.browser.close();
      }
    });
  }

  test('a pty-resized echo during a frame hold is skipped: the hold sends its grid once and nothing re-asserts', async () => {
    // main announces every change to the PTY's grid, the hold's own included. An unheld terminal
    // that disagrees with an echo re-asserts its own grid, which during a hold would send the old
    // grid back to the PTY.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await openStillTerminal(ownPage);
      // Fire a disagreeing echo from inside the hold's own resize, where the hold is open for certain.
      await ownPage.evaluate(({ sessionId, holdSelector }) => {
        const holder = window as unknown as {
          electronAPI: { sessions: { resize: (id: string, cols: number, rows: number) => Promise<unknown> } };
          __mockFirePtyResized: (id: string, cols: number, rows: number, origin: string) => void;
          __echoFiredDuringHold: boolean | null;
        };
        holder.__echoFiredDuringHold = null;
        const original = holder.electronAPI.sessions.resize;
        holder.electronAPI.sessions.resize = (id, cols, rows) => {
          if (id === sessionId && holder.__echoFiredDuringHold === null) {
            holder.__echoFiredDuringHold = document.querySelector(holdSelector) !== null;
            holder.__mockFirePtyResized(id, cols + 7, rows, 'desktop');
          }
          return original(id, cols, rows);
        };
      }, { sessionId: SESSION_ID, holdSelector: TERMINAL_FRAME_HOLD_SELECTOR });
      const since = Date.now();

      await ownPage.locator('[data-testid="task-detail-maximize"]').click();
      await expectNoFrameHold(ownPage);

      // The echo did land inside an open hold, or the rest proves nothing.
      expect(await ownPage.evaluate(() => (window as unknown as { __echoFiredDuringHold: boolean | null }).__echoFiredDuringHold)).toBe(true);
      const echoes = (await readTerminalTrace(ownPage, since, ['pty-resize-echo'])).map((entry) => entry.detail);
      expect(echoes).toHaveLength(1);
      expect(echoes[0]).toMatchObject({ action: 'skip', reason: 'frame-hold' });
      // Frames, not a timer: long enough for a re-assert (debounced 150 ms), were one scheduled, to send.
      await settleFrames(ownPage, 30);
      expect(await readTerminalTrace(ownPage, since, ['echo-reassert', 'echo-reassert-deferred'])).toEqual([]);
      expect(await resizeOrigins(ownPage, since)).toEqual(['frame-hold']);
      await expectNoFrameHoldRecovery(ownPage, since);
    } finally {
      await own.browser.close();
    }
  });

  test('dropping a window on the screen edge snaps it as a layout change: its terminal holds its frame until it repaints', async () => {
    // The drop resizes the window, so useWindowDrag runs it through runTerminalLayoutChange. A
    // snap that called the store directly would reflow the terminal's old frame onto the new grid.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await openStillTerminal(ownPage);
      const frame = ownPage.locator('[data-testid^="window-frame-"]').filter({
        has: ownPage.locator('[data-testid="task-detail-dialog"]'),
      });
      const windowId = ((await frame.getAttribute('data-testid')) ?? '').replace('window-frame-', '');
      const windowState = () => ownPage.evaluate((id) => (window as unknown as {
        __zustandStores: { window: { getState: () => { windows: Record<string, { state: string }> } } };
      }).__zustandStores.window.getState().windows[id]?.state ?? 'gone', windowId);
      expect(await windowState()).toBe('floating');

      const overlay = await ownPage.locator('[data-testid="window-overlay"]').boundingBox();
      const titleBar = await frame.locator('[data-testid="task-detail-titlebar"]').boundingBox();
      if (!overlay || !titleBar) throw new Error('no overlay or title bar');
      // Every hold from here: one that comes and goes is gone by a final read.
      await ownPage.evaluate((hold) => {
        const holder = window as unknown as { __frameHolds: Array<{ held: number; drawn: number | null }> };
        holder.__frameHolds = [];
        new MutationObserver(() => {
          const holding = document.querySelector(hold.selector) !== null;
          const last = holder.__frameHolds.at(-1);
          if (holding && (!last || last.drawn !== null)) holder.__frameHolds.push({ held: performance.now(), drawn: null });
          if (!holding && last && last.drawn === null) last.drawn = performance.now();
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: [hold.attribute] });
      }, { selector: TERMINAL_FRAME_HOLD_SELECTOR, attribute: TERMINAL_FRAME_HOLD_ATTRIBUTE });
      const since = Date.now();

      // Grab the title bar's middle and take the pointer into the overlay's left edge: a screen dock.
      await ownPage.mouse.move(titleBar.x + titleBar.width / 2, titleBar.y + titleBar.height / 2);
      await ownPage.mouse.down();
      await ownPage.mouse.move(overlay.x + 2, overlay.y + overlay.height / 2, { steps: 14 });
      await ownPage.mouse.up();

      await expect.poll(windowState, { timeout: 5000 }).toBe('snapped');
      expect((await readTerminalTrace(ownPage, since, ['layout-landing-begin'])).map((entry) => entry.detail))
        .toContainEqual({ scope: 'window-overlay' });
      // The terminal held its frame for the snap and drew the new one.
      await expect.poll(() => ownPage.evaluate(() => (window as unknown as {
        __frameHolds: Array<{ held: number; drawn: number | null }>;
      }).__frameHolds.length), { timeout: 5000 }).toBeGreaterThan(0);
      await expectNoFrameHold(ownPage);
      expect(await ownPage.evaluate(() => (window as unknown as {
        __frameHolds: Array<{ held: number; drawn: number | null }>;
      }).__frameHolds.every((span) => span.drawn !== null))).toBe(true);
      await expectNoFrameHoldRecovery(ownPage, since);
    } finally {
      await own.browser.close();
    }
  });

  /** Watch for any terminal holding its frame from now on; the returned function reports whether one has. */
  async function watchForFrameHold(ownPage: Page): Promise<() => Promise<boolean>> {
    await ownPage.evaluate((hold) => {
      const holder = window as unknown as { __frameHoldSeen: boolean };
      holder.__frameHoldSeen = false;
      new MutationObserver(() => {
        if (document.querySelector(hold.selector) !== null) holder.__frameHoldSeen = true;
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: [hold.attribute] });
    }, { selector: TERMINAL_FRAME_HOLD_SELECTOR, attribute: TERMINAL_FRAME_HOLD_ATTRIBUTE });
    return () => ownPage.evaluate(() => (window as unknown as { __frameHoldSeen: boolean }).__frameHoldSeen);
  }

  /**
   * A maximize that must not hold the frame: the window grows and the terminal refits as a plain
   * terminal does. The PTY hears the larger grid (so the refit did happen), and no terminal ever
   * marked itself held.
   */
  async function expectPlainRefitOnMaximize(ownPage: Page, since: number, holdSeen: () => Promise<boolean>): Promise<void> {
    await ownPage.locator('[data-testid="task-detail-maximize"]').click();
    await expect.poll(() => ownPage.evaluate(() => window.electronAPI.sessions.__resizeCalls.length), { timeout: 5000 }).toBeGreaterThan(0);
    // Frames, not a timer: a hold, were one to start, begins within a few frames of the refit.
    await settleFrames(ownPage, 30);
    expect(await holdSeen()).toBe(false);
    expect(await readTerminalTrace(ownPage, since, ['frame-hold'])).toEqual([]);
    await expect(ownPage.locator('[data-testid^="window-frame-"]').filter({
      has: ownPage.locator('[data-testid="task-detail-dialog"]'),
    })).toHaveClass(/rounded-none/);
  }

  test('a terminal still under its launch overlay does not hold a frame through a maximize', async () => {
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await ownPage.locator('[data-swimlane-name="Code Review"]').locator('text=Maximize Task').first().click();
      await ownPage.locator('[data-testid="task-detail-dialog"] .xterm-screen').waitFor({ timeout: 10000 });
      // The agent is not on screen, so the overlay covers the terminal.
      await expect(ownPage.locator('[data-testid="task-detail-dialog"] [data-testid="launch-overlay"]')).toBeVisible();
      await settleResizeLog(ownPage);
      const holdSeen = await watchForFrameHold(ownPage);
      await expectPlainRefitOnMaximize(ownPage, Date.now(), holdSeen);
    } finally {
      await own.browser.close();
    }
  });

  test('a terminal still replaying its scrollback does not hold a frame through a maximize', async () => {
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      // The terminal's replay waits on this until the test says otherwise (the watchdog is 5 s).
      await ownPage.evaluate((sessionId) => {
        const holder = window as unknown as { __mockScrollbackGate: Record<string, Promise<void>> };
        holder.__mockScrollbackGate = { [sessionId]: new Promise<void>(() => { /* never released */ }) };
      }, SESSION_ID);
      await ownPage.locator('[data-swimlane-name="Code Review"]').locator('text=Maximize Task').first().click();
      await ownPage.locator('[data-testid="task-detail-dialog"] .xterm-screen').waitFor({ timeout: 10000 });
      await markSessionFirstOutput(ownPage, SESSION_ID);
      await expect(ownPage.locator('[data-testid="task-detail-dialog"] [data-testid="launch-overlay"]')).toHaveCount(0);
      // The replay the overlay's lift asks for is in flight and held by the gate.
      await expect.poll(() => ownPage.evaluate(() => (
        (window as unknown as { __mockScrollbackCalls?: Array<{ gated: boolean }> }).__mockScrollbackCalls ?? []
      ).some((call) => call.gated)), { timeout: 5000 }).toBe(true);
      await settleResizeLog(ownPage);
      const holdSeen = await watchForFrameHold(ownPage);
      await expectPlainRefitOnMaximize(ownPage, Date.now(), holdSeen);
    } finally {
      await own.browser.close();
    }
  });
});


test.describe('Task Detail: the terminal through a drag of the OS window edge', () => {
  // The page sees no pointer for that drag, only a resize event a frame, and
  // every one used to reach the PTY: measured, 40 resizes for a 40-step drag, each
  // a SIGWINCH and a full agent redraw. The gate holds a run of window resizes as
  // one gesture (manager-resize-gate.ts), so the terminal resizes once more when
  // the size holds. Asking for a refit afterwards sends nothing: the grid is final.
  const resizeCount = (target: Page) => target.evaluate(() => window.electronAPI.sessions.__resizeCalls.length);
  const clearResizes = (target: Page) => target.evaluate(() => { window.electronAPI.sessions.__resizeCalls.length = 0; });
  /** 40 steps, one a frame, as an OS drag delivers them: steps sharing a frame would coalesce on their own. */
  async function dragWindowEdge(target: Page, from: { width: number; height: number }, direction: 1 | -1): Promise<void> {
    for (let step = 1; step <= 40; step += 1) {
      await target.setViewportSize({ width: from.width + direction * step * 8, height: from.height + direction * step * 4 });
      await target.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      // An OS drag's first step is often the slow one, and a run of resizes only opens the gate on its
      // second. Two more frames (about 33 ms, well under the gate's 150 ms) let the terminal's
      // ResizeObserver see the first layout and arm its 200 ms refit before the gate is open, which is
      // the race a slow first step opens. Frames, not a timer, so the gap is the same on any runner.
      if (step === 1) {
        for (let extraFrame = 0; extraFrame < 2; extraFrame += 1) {
          await target.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        }
      }
    }
  }
  /** Ask for a refit until one has nothing to send: the terminal's grid fits the layout as it stands. */
  async function settleGrid(target: Page): Promise<void> {
    await expect.poll(async () => {
      await clearResizes(target);
      await target.evaluate(() => window.dispatchEvent(new Event('terminal-panel-resize')));
      await settleFrames(target, 3);
      return resizeCount(target);
    }, { intervals: [200], timeout: 10000 }).toBe(0);
  }
  /**
   * Watch the drag that follows: the window resizes as the page sees them, stamped with the clock the
   * gate groups them by (Date.now), and every send to the PTY stamped with whether the gate was
   * holding when it went out. The gate is the same module instance the app runs (what
   * `isManagerResizeGateOpen` reads too).
   */
  async function watchDrag(target: Page): Promise<void> {
    await target.evaluate(async () => {
      const gate = await import('/src/renderer/window-manager/terminal/manager-resize-gate.ts' as string) as {
        isManagerResizeInProgress: () => boolean;
      };
      const holder = window as unknown as { __windowResizes: number[]; __sendsWhileHeld: number; __gate: typeof gate };
      holder.__windowResizes = [];
      holder.__sendsWhileHeld = 0;
      holder.__gate = gate;
      window.addEventListener('resize', () => holder.__windowResizes.push(Date.now()));
      const sessions = window.electronAPI.sessions;
      const sendResize = sessions.resize.bind(sessions);
      sessions.resize = (...args: Parameters<typeof sessions.resize>) => {
        if (gate.isManagerResizeInProgress()) holder.__sendsWhileHeld += 1;
        return sendResize(...args);
      };
    });
  }
  /**
   * Wait for the drag to be over for the PTY, then report what it heard. Over means the gate has
   * closed and the held refit has gone out: no window resize for longer than the gate's settle plus
   * the terminal's own 200 ms observer debounce, and nothing new sent between two polls.
   */
  async function settleAfterDrag(target: Page): Promise<{ sent: number; sendsWhileHeld: number; runs: number }> {
    let previousSent = -1;
    await expect.poll(async () => {
      const state = await target.evaluate(() => {
        const holder = window as unknown as { __windowResizes: number[]; __gate: { isManagerResizeInProgress: () => boolean } };
        return {
          sent: window.electronAPI.sessions.__resizeCalls.length,
          idleMs: Date.now() - holder.__windowResizes[holder.__windowResizes.length - 1],
          held: holder.__gate.isManagerResizeInProgress(),
        };
      });
      const settled = !state.held && state.idleMs >= 500 && state.sent > 0 && state.sent === previousSent;
      previousSent = state.sent;
      return settled;
    }, { intervals: [250], timeout: 15000 }).toBe(true);
    // A resize that comes WINDOW_RESIZE_SETTLE_MS (150 ms) or more after the last starts a run of its
    // own, which a starved runner does between any two steps. The two reads of the clock sit a ms
    // apart, so a gap of 149 ms or more counts as a split: a run too many is never held against the
    // gate, a run too few would be.
    return target.evaluate(() => {
      const holder = window as unknown as { __windowResizes: number[]; __sendsWhileHeld: number };
      const times = holder.__windowResizes;
      let runs = times.length > 0 ? 1 : 0;
      for (let index = 1; index < times.length; index += 1) if (times[index] - times[index - 1] >= 149) runs += 1;
      return { sent: window.electronAPI.sessions.__resizeCalls.length, sendsWhileHeld: holder.__sendsWhileHeld, runs };
    });
  }
  async function expectGridFinal(target: Page): Promise<void> {
    await clearResizes(target);
    await target.evaluate(() => window.dispatchEvent(new Event('terminal-panel-resize')));
    // A fixed budget on purpose: nothing sent cannot be polled for. 500 ms clears the bottom panel
    // terminal's 50 ms debounced refit (a window terminal refits synchronously) with room for load.
    await target.waitForTimeout(500);
    expect(await resizeCount(target)).toBe(0);
  }

  test('a maximized task window terminal resizes a few times, not once a step, and ends on the final grid', async () => {
    // This test launches its own browser (launchWithState), then spends a 40-step drag of
    // three round trips a step on a runner that can be several times slower than a dev
    // machine, so the project's 15 s default is not enough. The siblings that launch their
    // own browser carry the same 45 s.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await ownPage.setViewportSize({ width: 1400, height: 900 });
      await ownPage.locator('[data-swimlane-name="Code Review"]').locator('text=Maximize Task').first().click();
      await ownPage.locator('[data-testid="task-detail-dialog"] .xterm-screen').waitFor({ timeout: 10000 });
      await markSessionFirstOutput(ownPage, SESSION_ID);
      await expect(ownPage.locator('[data-testid="task-detail-dialog"] [data-testid="launch-overlay"]')).toHaveCount(0);
      await ownPage.locator('[data-testid="task-detail-maximize"]').click();
      await expect(ownPage.locator('[data-testid^="window-frame-"]').filter({
        has: ownPage.locator('[data-testid="task-detail-dialog"]'),
      })).toHaveClass(/rounded-none/);
      await expectNoFrameHold(ownPage);
      // The maximize's own refit is still on its way until a refit has nothing left to send. A
      // fixed wait here let a late one land inside the drag and count as one of its sends.
      await settleGrid(ownPage);
      await clearResizes(ownPage);
      await watchDrag(ownPage);
      await dragWindowEdge(ownPage, { width: 1400, height: 900 }, 1);
      const { sent, sendsWhileHeld, runs } = await settleAfterDrag(ownPage);
      expect(sent).toBeGreaterThan(0);
      // Held means held: the gate lets nothing through while it is open, however slow the runner.
      expect(sendsWhileHeld, 'resizes the PTY heard while the gate was holding').toBe(0);
      // And a few sends, not one a step. Each run may send its first step at once, send the held
      // refit when the size holds, and once more when its last step's layout commits after the
      // gate has closed (the held refit fits the DOM as it stands, which a starved render can
      // leave one commit behind). A gate that holds nothing sends one a step, far past this.
      expect(sent, `${runs} run(s) of window resizes`).toBeLessThanOrEqual(3 * runs);
      await expectGridFinal(ownPage);
    } finally {
      await own.browser.close();
    }
  });

  test('the bottom panel terminal, which the gate holds too, still refits once the drag ends', async () => {
    // Same reason as the maximized window's test above: its own browser and a 40-step drag.
    test.setTimeout(45000);
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await ownPage.setViewportSize({ width: 1720, height: 1060 });
      await ownPage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
      await expect(ownPage.locator('[data-testid="task-detail-dialog"]')).toHaveCount(0);
      await expect(ownPage.locator('.xterm-screen')).toHaveCount(1, { timeout: 10000 });
      // The mount's own refits are over once nothing has been sent for a beat.
      await settleResizeLog(ownPage);
      await watchDrag(ownPage);
      await dragWindowEdge(ownPage, { width: 1720, height: 1060 }, -1);
      // The refit the drag held reaches the PTY once the size holds.
      expect((await settleAfterDrag(ownPage)).sent).toBeGreaterThan(0);
      await expectGridFinal(ownPage);
    } finally {
      await own.browser.close();
    }
  });
});

test.describe('Task Detail: window shortcuts with the Command Terminal open over it', () => {
  test('Ctrl+Shift+M maximizes the Command Terminal panel, and Ctrl+Shift+W hides it, never the task window under it', async () => {
    // Both register the same capture-phase shortcuts on the window; the focused
    // task window behind the panel must not act on them as well.
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await ownPage.locator('[data-swimlane-name="Code Review"]').locator('text=Maximize Task').first().click();
      await ownPage.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      const taskFrame = ownPage.locator('[data-testid^="window-frame-"]').filter({
        has: ownPage.locator('[data-testid="task-detail-dialog"]'),
      });
      await expect(taskFrame).toHaveClass(/rounded-lg/);

      await ownPage.keyboard.press('Control+Shift+P');
      const panel = ownPage.getByTestId('command-terminal-panel');
      await expect(panel).toBeVisible();
      await ownPage.keyboard.press('Control+Shift+M');
      await expect(panel).toHaveAttribute('data-maximized', 'true');
      await expectNoFrameHold(ownPage);
      await expect(taskFrame).toHaveClass(/rounded-lg/);

      await ownPage.keyboard.press('Control+Shift+W');
      await expect(panel).toBeHidden();
      await expect(ownPage.locator('[data-testid="task-detail-dialog"]')).toBeVisible();
    } finally {
      await own.browser.close();
    }
  });

  test('Ctrl+Shift+M and Ctrl+Shift+W act on a conversation window, but with the Command Terminal open over it only the panel reacts', async () => {
    // The conversation window binds the same two capture-phase shortcuts as the panel
    // (`windowOwnsKeys` in ConversationWindow), so one press used to act on both.
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await ownPage.evaluate((sessionId) => {
        (window as unknown as {
          __zustandStores: { session: { getState: () => { setConversationSessionId: (id: string) => void } } };
        }).__zustandStores.session.getState().setConversationSessionId(sessionId);
      }, SESSION_ID);
      const conversation = ownPage.getByTestId('conversation-window');
      await expect(conversation).toBeVisible({ timeout: 5000 });
      const conversationFrame = ownPage.locator('[data-testid^="window-frame-"]').filter({ has: conversation });
      await expect(conversationFrame).toHaveClass(/rounded-lg/);

      // With no panel the window owns the keys: without this, a window that never took
      // them would pass everything below.
      await ownPage.keyboard.press('Control+Shift+M');
      await expect(conversationFrame).toHaveClass(/rounded-none/);
      await ownPage.keyboard.press('Control+Shift+M');
      await expect(conversationFrame).toHaveClass(/rounded-lg/);

      await ownPage.keyboard.press('Control+Shift+P');
      const panel = ownPage.getByTestId('command-terminal-panel');
      await expect(panel).toBeVisible();
      await ownPage.keyboard.press('Control+Shift+M');
      await expect(panel).toHaveAttribute('data-maximized', 'true');
      await expect(conversationFrame).toHaveClass(/rounded-lg/);

      await ownPage.keyboard.press('Control+Shift+W');
      await expect(panel).toBeHidden();
      await expect(conversation).toBeVisible();

      // The panel gone, the keys are the window's again: this press closes it.
      await ownPage.keyboard.press('Control+Shift+W');
      await expect(conversation).toHaveCount(0, { timeout: 5000 });
    } finally {
      await own.browser.close();
    }
  });

  test('Ctrl+Shift+M and Ctrl+Shift+W act on the Agent Monitor\'s task window, but with the Command Terminal open over it only the panel reacts', async () => {
    // The monitor's host folds the panel into `shortcutsSuppressed`, as the board's does.
    const taskId = 'task-monitor-shortcuts';
    const own = await launchMonitorSeed({
      tasks: [{ id: taskId, displayId: 61, title: 'Monitor shortcuts task', lane: 'Executing', session: true }],
    });
    try {
      const ownPage = own.page;
      await openMonitor(ownPage);
      await byTestId(ownPage, 'monitor-page')
        .locator(`[data-session-id="${sessionIdOf(taskId)}"] [data-testid="monitor-card-title"]`)
        .click();
      const detailFrame = ownPage.locator('#monitor-detail-layer-root [data-testid^="window-frame-"]');
      await expect(detailFrame).toHaveCount(1);
      await expect(detailFrame).toHaveClass(/rounded-lg/);

      // With no panel the task window owns the keys.
      await ownPage.keyboard.press('Control+Shift+M');
      await expect(detailFrame).toHaveClass(/rounded-none/);
      await ownPage.keyboard.press('Control+Shift+M');
      await expect(detailFrame).toHaveClass(/rounded-lg/);

      await ownPage.keyboard.press('Control+Shift+P');
      const panel = ownPage.getByTestId('command-terminal-panel');
      await expect(panel).toBeVisible();
      await ownPage.keyboard.press('Control+Shift+M');
      await expect(panel).toHaveAttribute('data-maximized', 'true');
      await expect(detailFrame).toHaveClass(/rounded-lg/);

      await ownPage.keyboard.press('Control+Shift+W');
      await expect(panel).toBeHidden();
      await expect(detailFrame).toHaveCount(1);
      await expect(byTestId(ownPage, 'monitor-page')).toBeVisible();

      // The panel gone, the keys are the task window's again: this press closes it.
      await ownPage.keyboard.press('Control+Shift+W');
      await expect(detailFrame).toHaveCount(0, { timeout: 5000 });
    } finally {
      await own.browser.close();
    }
  });
});

test.describe('Task Detail: a resize whose release went unseen', () => {
  test('the next maximize still refits the terminal: the drag closes once the pointer shows its button up', async () => {
    // The reported break: an edge drag's release never reached the window frame,
    // the manager-resize gate stayed open, and every later refit waited on it.
    // The window maximized while its terminal kept the grid it had.
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await ownPage.locator('[data-swimlane-name="Code Review"]').locator('text=Maximize Task').first().click();
      await ownPage.locator('[data-testid="task-detail-dialog"] .xterm-screen').waitFor({ timeout: 10000 });
      await markSessionFirstOutput(ownPage, SESSION_ID);
      await expect(ownPage.locator('[data-testid="task-detail-dialog"] [data-testid="launch-overlay"]')).toHaveCount(0);

      type ResizeCall = { sessionId: string; cols: number; rows: number };
      const resizeCalls = () => ownPage.evaluate(() => (
        window as unknown as { electronAPI: { sessions: { __resizeCalls: ResizeCall[] } } }
      ).electronAPI.sessions.__resizeCalls.slice());
      // The terminal settled: no resize for a beat. Its last grid is the one to beat.
      let previousCount = -1;
      await expect.poll(async () => {
        const count = (await resizeCalls()).length;
        const settled = count === previousCount && count > 0;
        previousCount = count;
        return settled;
      }, { intervals: [300], timeout: 10000 }).toBe(true);
      const settledCols = (await resizeCalls()).filter((call) => call.sessionId === SESSION_ID).at(-1)?.cols ?? 0;
      expect(settledCols).toBeGreaterThan(0);

      const windowId = ((await ownPage.locator('[data-testid^="window-frame-"]')
        .filter({ has: ownPage.locator('[data-testid="task-detail-dialog"]') })
        .getAttribute('data-testid')) ?? '').replace('window-frame-', '');
      // Press the east edge and drag it in, then lose the frame's capture: the
      // release never reaches the frame.
      await ownPage.evaluate((id) => {
        const handle = document.querySelector<HTMLElement>(`[data-testid="window-resize-${id}-e"]`);
        const frame = document.querySelector<HTMLElement>(`[data-testid="window-frame-${id}"]`);
        if (!handle || !frame) throw new Error('no edge handle');
        const box = handle.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const init = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        handle.dispatchEvent(new PointerEvent('pointerdown', { ...init, button: 0, buttons: 1, clientX: x, clientY: y }));
        frame.dispatchEvent(new PointerEvent('pointermove', { ...init, button: -1, buttons: 1, clientX: x - 40, clientY: y }));
        if (frame.hasPointerCapture(1)) frame.releasePointerCapture(1);
      }, windowId);
      const gateOpen = () => ownPage.evaluate(async () => {
        const gate = await import('/src/renderer/window-manager/terminal/manager-resize-gate.ts' as string) as {
          isManagerResizeInProgress: () => boolean;
        };
        return gate.isManagerResizeInProgress();
      });
      expect(await gateOpen()).toBe(true);

      // The pointer moves on with no button held: the drag is over.
      await ownPage.mouse.move(20, 20);
      await expect.poll(gateOpen).toBe(false);

      // The user resizes again, the way the report went. Before the gate closed
      // drags itself, this press replaced the open drag without ending it.
      const edge = await ownPage.locator(`[data-testid="window-resize-${windowId}-e"]`).boundingBox();
      if (!edge) throw new Error('no edge handle box');
      const edgeX = edge.x + edge.width / 2;
      const edgeY = edge.y + edge.height / 2;
      await ownPage.mouse.move(edgeX, edgeY);
      await ownPage.mouse.down();
      await ownPage.mouse.move(edgeX - 30, edgeY, { steps: 3 });
      await ownPage.mouse.up();

      const callsBeforeMaximize = (await resizeCalls()).length;
      await ownPage.locator('[data-testid="task-detail-maximize"]').click();
      await expect.poll(async () => Math.max(0, ...(await resizeCalls())
        .slice(callsBeforeMaximize)
        .filter((call) => call.sessionId === SESSION_ID)
        .map((call) => call.cols)), { timeout: 5000 }).toBeGreaterThan(settledCols);
    } finally {
      await own.browser.close();
    }
  });

  test('a tiled group\'s outer edge drag ends where it stood once the pointer shows its button up, and the edge takes the next drag', async () => {
    // The footprint resizer's release can miss the strip too. The gate abandons its drag, the
    // resizer commits the footprint it reached (as a layout change), and its own re-entry guard
    // lets go, or the next press on the edge would be ignored for good.
    const own = await launchWithState(preConfig);
    try {
      const ownPage = own.page;
      await ownPage.locator('[data-swimlane-name="Code Review"]').locator('text=Maximize Task').first().click();
      const dialogs = ownPage.locator('[data-testid="task-detail-dialog"]');
      await expect(dialogs).toHaveCount(1);
      // The first window covers the board, so the second opens through the store, the entry point
      // every card click funnels into; docking tiles the pair.
      await ownPage.evaluate((taskId) => {
        (window as unknown as {
          __zustandStores: { session: { getState: () => { setDetailTaskId: (id: string) => void } } };
        }).__zustandStores.session.getState().setDetailTaskId(taskId);
      }, EDIT_TASK_ID);
      await expect(dialogs).toHaveCount(2);
      type Footprint = { x: number; y: number; w: number; h: number };
      await ownPage.evaluate(() => {
        const windowState = (window as unknown as {
          __zustandStores: {
            window: {
              getState: () => {
                windows: Record<string, unknown>;
                dockIntoWindow: (draggedId: string, targetId: string, side: string) => void;
                setTileTreeRect: (rect: { x: number; y: number; w: number; h: number }) => void;
              };
            };
          };
        }).__zustandStores.window.getState();
        const [firstId, secondId] = Object.keys(windowState.windows);
        windowState.dockIntoWindow(secondId, firstId, 'right');
        // An inset footprint, so the right edge has board to grow into.
        windowState.setTileTreeRect({ x: 0.1, y: 0.1, w: 0.7, h: 0.8 });
      });
      const footprint = () => ownPage.evaluate(() => (window as unknown as {
        __zustandStores: { window: { getState: () => { tileTreeRect: { x: number; y: number; w: number; h: number } } } };
      }).__zustandStores.window.getState().tileTreeRect);
      await expect.poll(async () => Math.abs((await footprint()).w - 0.7) < 0.001).toBe(true);
      const before: Footprint = await footprint();
      const overlayWidth = (await ownPage.locator('[data-testid="window-overlay"]').boundingBox())?.width ?? 0;
      expect(overlayWidth).toBeGreaterThan(0);

      // The pointer is not known to the page until it has moved once.
      const edgeBox = await ownPage.getByTestId('footprint-resizer-right').boundingBox();
      if (!edgeBox) throw new Error('no right footprint edge');
      const edgeX = edgeBox.x + edgeBox.width / 2;
      const edgeY = edgeBox.y + edgeBox.height / 2;
      await ownPage.mouse.move(edgeX, edgeY);
      const since = Date.now();
      // Press the right edge and drag it 120px out, with the real mouse: the browser then holds
      // the same button state the page does. A press made of synthetic events left the browser
      // thinking no button was down, so the mouse move it issues itself after a layout change
      // read as a missed release and ended the drag early, on a loaded runner.
      await ownPage.mouse.down();
      await ownPage.mouse.move(edgeX + 120, edgeY, { steps: 4 });
      // Lose the strip's capture: the release will not reach the strip.
      await ownPage.evaluate(() => {
        const edge = document.querySelector<HTMLElement>('[data-testid="footprint-resizer-right"]');
        if (edge?.hasPointerCapture(1)) edge.releasePointerCapture(1);
      });
      await expect.poll(() => isManagerResizeGateOpen(ownPage)).toBe(true);
      // Nothing is committed while the drag is live.
      expect(Math.abs((await footprint()).w - before.w)).toBeLessThan(0.001);

      // The pointer leaves the strip with the button still down, then lets go over dead space:
      // the strip never sees the release, and the first pointer event that shows the button up
      // ends the drag.
      await ownPage.mouse.move(20, 20);
      await ownPage.mouse.up();
      await expect.poll(() => isManagerResizeGateOpen(ownPage)).toBe(false);
      const abandoned = (await readTerminalTrace(ownPage, since, ['manager-resize-abandoned'])).map((entry) => entry.detail);
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]).toMatchObject({ owner: 'footprint-edge' });
      // The footprint it reached is the one committed, and as a layout change of the board's overlay.
      const dragged: Footprint = await footprint();
      expect(Math.abs(dragged.w - (before.w + 120 / overlayWidth))).toBeLessThan(0.005);
      expect(Math.abs(dragged.x - before.x)).toBeLessThan(0.001);
      expect((await readTerminalTrace(ownPage, since, ['layout-landing-begin'])).map((entry) => entry.detail))
        .toContainEqual({ scope: 'window-overlay' });

      // The edge is not left holding the lost drag: the next one moves it.
      const nextBox = await ownPage.getByTestId('footprint-resizer-right').boundingBox();
      if (!nextBox) throw new Error('no right footprint edge after the drag');
      const nextX = nextBox.x + nextBox.width / 2;
      const nextY = nextBox.y + nextBox.height / 2;
      await ownPage.mouse.move(nextX, nextY);
      await ownPage.mouse.down();
      await ownPage.mouse.move(nextX + 60, nextY, { steps: 3 });
      await ownPage.mouse.up();
      await expect.poll(async () => (await footprint()).w, { timeout: 5000 }).toBeGreaterThan(dragged.w + 0.02);
    } finally {
      await own.browser.close();
    }
  });
});

test.describe('Task Detail: maximize / restore', () => {
  test('maximize fills the screen and insets the backdrop; restore returns to windowed size', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Maximize Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The window frame is the direct parent of task-detail-dialog. It carries
    // rounded-lg (floating) or rounded-none (maximized/tiled) so tests can assert
    // the window's maximize state without inspecting pixel geometry.
    const frame = page.locator('[data-testid^="window-frame-"]').filter({
      has: page.locator('[data-testid="task-detail-dialog"]'),
    });

    const maximizeButton = page.locator('[data-testid="task-detail-maximize"]');
    await expect(maximizeButton).toBeVisible();

    // Starts windowed (running session -> floating state): action is "Maximize",
    // frame has rounded corners. The dialog content is always w-full h-full inside
    // the frame - sizing is expressed on the frame, not the content div.
    await expect(maximizeButton).toHaveAccessibleName(/^Maximize/);
    await expect(frame).toHaveClass(/rounded-lg/);
    await expect(frame).not.toHaveClass(/rounded-none/);

    // Maximize -> frame fills the window-overlay area (between title bar and status
    // bar), corners squared so the border meets the overlay edges flush.
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAccessibleName(/^Restore/);
    await expect(frame).toHaveClass(/rounded-none/);
    await expect(frame).not.toHaveClass(/rounded-lg/);
    // The window overlay is always top-10 bottom-9 (between app chrome) in the
    // window model - that's the boundary the maximized frame fills.
    const overlay = page.locator('[data-testid="window-overlay"]');
    await expect(overlay).toHaveClass(/top-10/);
    await expect(overlay).toHaveClass(/bottom-9/);

    // Restore -> frame back to floating with rounded corners.
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAccessibleName(/^Maximize/);
    await expect(frame).toHaveClass(/rounded-lg/);
    await expect(frame).not.toHaveClass(/rounded-none/);

    // Hotkey: Ctrl/Cmd+Shift+M toggles maximize (terminal-safe combo).
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAccessibleName(/^Restore/);
    await expect(frame).toHaveClass(/rounded-none/);
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAccessibleName(/^Maximize/);
    await expect(frame).toHaveClass(/rounded-lg/);

    // Hotkey: Ctrl/Cmd+Shift+W closes the window (terminal-safe combo).
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible();
  });

  test('Ctrl+Shift+B toggles the Browser pane when canShowBrowser is true', async () => {
    // The Code Review task has a running session, no browser.enabled override in
    // projectConfigs (so browserEnabled = undefined !== false = true), and the
    // session display state is 'running'. All three canShowBrowser conditions are met.
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Maximize Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The Browser toggle pill is visible (canShowBrowser = true).
    const browserToggle = dialog.locator('[data-testid="browser-toggle"]');
    await expect(browserToggle).toBeVisible();

    // Browser pane is closed initially - the pill's tip reads "Show browser", suffixed with the
    // live hotkey combo, as its accessible description.
    await expect(browserToggle).toHaveAccessibleDescription(/^Show browser/);
    // Nothing to keep yet, so the tip has no second line (its detail is "Kept alive until you
    // close it" while the pane is open and "Page kept" while a hidden pane still has a guest).
    await expect(browserToggle).not.toHaveAccessibleDescription(/Kept alive|Page kept/);

    // Ctrl+Shift+B opens the browser pane.
    await page.keyboard.press('Control+Shift+B');
    await expect(browserToggle).toHaveAccessibleDescription(/^Hide browser/);
    // Hiding is not closing: the open pane's tip says the page outlives the hide. The detail is
    // a second line of the tip, which the accessible description joins with a space.
    await expect(browserToggle).toHaveAccessibleDescription(/^Hide browser.*Kept alive until you close it$/);

    // Ctrl+Shift+B again closes the browser pane.
    await page.keyboard.press('Control+Shift+B');
    await expect(browserToggle).toHaveAccessibleDescription(/^Show browser/);
    // No guest was ever attached here (no URL was seeded), so the hidden pane has nothing to keep
    // and the detail is gone with the pane. The "Page kept" case is in browser-pane-close.spec.ts.
    await expect(browserToggle).not.toHaveAccessibleDescription(/Kept alive|Page kept/);

    // Close the dialog so subsequent tests start clean.
    //
    // This doubles as a regression guard for the park policy. Ctrl+Shift+B only
    // HIDES the pane, so the second press above left it held, and this task's
    // session is running: the two conditions that park a window on close. It
    // must still close for real, because no URL was ever seeded here, so the
    // pane only ever rendered its empty state and never attached a `<webview>`.
    // Parking exists to preserve a guest, and there is none. If this starts
    // failing because the dialog stayed "visible", the policy has gone back to
    // parking on pane-open state alone and is hiding windows with nothing in
    // them (a parked frame is opacity 0, which Playwright counts as visible).
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible();
  });

  // The terminal-aware Escape policy (view mode: Escape over the PTY goes to the
  // agent, Escape with the pointer elsewhere closes the dialog) is covered
  // deterministically in tests/unit/terminal-escape-release.test.ts. Driving the
  // real xterm focus + :hover + propagation from the UI tier is flaky, so it is
  // verified manually instead.

  test('edit mode: maximize button is present and Ctrl+Shift+M toggles the layout', async () => {
    // A To Do task with no session opens in edit mode (initialEdit=true, forced
    // by the component when role='todo' and hasSessionContext=false). Maximize
    // is now available in edit mode (the #184 gate was removed).
    const card = page
      .locator('[data-swimlane-name="To Do"]')
      .locator('text=Edit Mode Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // To Do tasks open in edit mode - a title input is visible.
    await expect(page.locator('input[placeholder="Task title"]')).toBeVisible();

    // The window frame is the direct parent of task-detail-dialog.
    const frame = page.locator('[data-testid^="window-frame-"]').filter({
      has: page.locator('[data-testid="task-detail-dialog"]'),
    });

    // The maximize button is surfaced in the edit header.
    const maximizeButton = page.locator('[data-testid="task-detail-maximize"]');
    await expect(maximizeButton).toBeVisible();
    await expect(maximizeButton).toHaveAccessibleName(/^Maximize/);
    // Starts floating: frame has rounded corners.
    await expect(frame).toHaveClass(/rounded-lg/);
    await expect(frame).not.toHaveClass(/rounded-none/);

    // Ctrl+Shift+M maximizes: frame fills the overlay area, corners squared.
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAccessibleName(/^Restore/);
    await expect(frame).toHaveClass(/rounded-none/);
    await expect(frame).not.toHaveClass(/rounded-lg/);

    // Restore via the hotkey so the window state does not leak into the next test.
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAccessibleName(/^Maximize/);
    await expect(frame).toHaveClass(/rounded-lg/);
    await expect(frame).not.toHaveClass(/rounded-none/);

    // Close the window to leave a clean state for the next test.
    // Use the dedicated panel.close hotkey (capture-phase, isFocused-gated) rather
    // than Escape: after Ctrl+Shift+M restore, the keyboard focus on some Linux
    // headless Chromium builds lands on an intermediate element whose Escape
    // handler intercepts before the bubble-phase window listener fires, leaving
    // the dialog stuck open (CI flake). Control+Shift+W is capture-phase and
    // cannot be intercepted. Mirrors the cleanup in the other tests in this file.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('edit mode: discarding unsaved changes confirms, layered over the still-visible dialog', async () => {
    const card = page
      .locator('[data-swimlane-name="To Do"]')
      .locator('text=Edit Mode Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Edit Mode Task (changed)');

    // Escape on a dirty edit form shows the discard confirm ON TOP, with the
    // edit dialog still mounted/visible behind it (not replaced).
    await page.keyboard.press('Escape');
    const confirmHeading = page.locator('[data-testid="task-detail-unsaved-confirm"]');
    await expect(confirmHeading).toBeVisible();
    await expect(dialog).toBeVisible();

    // Keep editing returns to the form with the edit intact.
    await page.locator('button:has-text("Keep editing")').click();
    await expect(confirmHeading).not.toBeVisible();
    await expect(titleInput).toHaveValue('Edit Mode Task (changed)');

    // Discard abandons the edit and closes the dialog (no save).
    await page.keyboard.press('Escape');
    await expect(confirmHeading).toBeVisible();
    await page.locator('button:has-text("Discard")').click();
    await expect(dialog).not.toBeVisible();
  });

  test('New Task create dialog: maximize button and Ctrl+Shift+M toggle the layout', async () => {
    const todoColumn = page.locator('[data-swimlane-name="To Do"]');
    await todoColumn.locator('text=Add task').click();

    // Wait for the dialog to mount.
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.waitFor({ state: 'visible', timeout: 5000 });

    // The content box is the rounded dialog container around the title input.
    const contentBox = titleInput.locator('xpath=ancestor::div[contains(@class,"shadow-2xl")][1]');
    await expect(contentBox).toHaveClass(/w-\[840px\]/);
    await expect(contentBox).toHaveClass(/rounded-lg/);
    const backdropWindowed = await contentBox.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropWindowed).toContain('inset-0');
    expect(backdropWindowed).not.toContain('top-10');

    // The standard-header close button advertises the panel.close hotkey
    // (Escape is the hidden universal closer and is deliberately not shown).
    // Its tip repeats its name, so what it adds to read is the shortcut alone.
    const closeButton = page.locator('[aria-label="Close dialog"]');
    await expect(closeButton).toHaveAccessibleDescription(/\S/);

    // Maximize via the header button.
    const maximizeButton = page.locator('[data-testid="dialog-maximize"]');
    await expect(maximizeButton).toBeVisible();
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAccessibleName(/^Restore/);
    await expect(contentBox).toHaveClass(/w-full/);
    await expect(contentBox).toHaveClass(/h-full/);
    await expect(contentBox).toHaveClass(/rounded-none/);
    const backdropMaximized = await contentBox.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropMaximized).toContain('top-10');
    expect(backdropMaximized).toContain('bottom-9');

    // Restore via the hotkey so the sentinel-keyed flag does not leak.
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAccessibleName(/^Maximize/);
    await expect(contentBox).toHaveClass(/w-\[840px\]/);

    // Dismiss the dialog.
    await page.keyboard.press('Escape');
    await expect(titleInput).not.toBeVisible();
  });

  test('BaseDialog default props: non-maximize consumer keeps inset-0 and rounded-lg', async () => {
    // The delete-confirm dialog (ConfirmDialog) uses BaseDialog with no
    // backdropPositionClass or contentRadiusClass overrides. This proves the
    // optional maximize props default safely for plain BaseDialog consumers.
    const card = page
      .locator('[data-swimlane-name="To Do"]')
      .locator('text=Edit Mode Task')
      .first();
    await card.click();

    const editDialog = page.locator('[data-testid="task-detail-dialog"]');
    await editDialog.waitFor({ state: 'visible', timeout: 5000 });

    // To Do tasks show a Delete button in the edit footer; it opens ConfirmDialog.
    await page.locator('button:has-text("Delete")').first().click();

    // The confirm dialog heading identifies the plain BaseDialog consumer.
    const heading = page.locator('h3:has-text("Delete task")');
    await heading.waitFor({ state: 'visible', timeout: 5000 });
    const contentBox = heading.locator('xpath=ancestor::div[contains(@class,"shadow-2xl")][1]');
    await expect(contentBox).toHaveClass(/rounded-lg/);
    await expect(contentBox).not.toHaveClass(/rounded-none/);

    const backdropClass = await contentBox.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropClass).toContain('inset-0');
    expect(backdropClass).not.toContain('top-10');

    // Dismiss the confirm dialog with Escape (ConfirmDialog is a BaseDialog modal,
    // reliable Escape handling), then close the task-detail window with
    // Control+Shift+W (capture-phase): after the ConfirmDialog closes, focus
    // position is uncertain, so using the capture-phase hotkey avoids the
    // bubble-phase Escape interception risk on CI Linux.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+W');
    await expect(editDialog).not.toBeVisible({ timeout: 8000 });
  });
});

// ---------------------------------------------------------------------------
// Pop out of tiling: a tiled pane's header carries a control that floats it back out.
// The control is icon-only, so its aria-label is its name, and its tip repeats that name:
// the tip shows on hover but is not read a second time as a description.
// Own browser, because docking two windows leaves a tile tree behind that would leak into
// the next test on a shared page.
// ---------------------------------------------------------------------------
test.describe('Task Detail: pop out of tiling', () => {
  test('a tiled pane has a named Pop out of tiling control that floats it, and a lone window has none', async () => {
    const { browser, page } = await launchWithState(preConfig);
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

      const dialogs = page.locator('[data-testid="task-detail-dialog"]');
      const runningPane = dialogs.filter({ hasText: 'Maximize Task' });
      const undock = runningPane.locator('[data-testid="task-detail-undock"]');

      await page.locator('[data-swimlane-name="Code Review"]').locator('text=Maximize Task').first().click();
      await expect(runningPane).toBeVisible();
      // A lone floating window is not tiled, so it has no pop-out control.
      await expect(undock).toHaveCount(0);

      // The first window covers the board, so the second opens through the store, the entry point
      // every card click funnels into. `dockIntoWindow` is what a drag-to-dock commits: it tiles both.
      await page.evaluate((taskId) => {
        (window as unknown as {
          __zustandStores: { session: { getState: () => { setDetailTaskId: (id: string) => void } } };
        }).__zustandStores.session.getState().setDetailTaskId(taskId);
      }, EDIT_TASK_ID);
      await expect(dialogs).toHaveCount(2);
      await page.evaluate(() => {
        const windowState = (window as unknown as {
          __zustandStores: {
            window: {
              getState: () => {
                windows: Record<string, unknown>;
                dockIntoWindow: (draggedId: string, targetId: string, side: string) => void;
              };
            };
          };
        }).__zustandStores.window.getState();
        const [firstId, secondId] = Object.keys(windowState.windows);
        windowState.dockIntoWindow(secondId, firstId, 'right');
      });

      await expect(undock).toHaveCount(1);
      await expect(undock).toHaveAccessibleName('Pop out of tiling');
      // The tip is the name, so it is not read a second time.
      await expect(undock).toHaveAccessibleDescription('');
      await undock.hover();
      await expect(page.locator('[data-tooltip]')).toHaveText('Pop out of tiling');

      // The tip does not swallow the click: the pane floats and its control goes.
      await undock.click();
      await expect(undock).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Maximize focus restore - pins the fix from PR #33 (Surface 2):
// toggling maximize on a task-detail WINDOW must restore keyboard focus to the
// window's embedded xterm terminal (before the fix, the maximize button kept
// DOM focus, so the next keystroke hit the button instead of the terminal).
//
// This test requires the xterm terminal to actually mount inside the window,
// which means the session must be running AND sessionFirstOutput must be set
// (so terminalReady flips to true in TerminalTab). Each step:
//   1. Launch a fresh browser with the standard preConfig (running session).
//   2. Open the task-detail window by clicking the task card.
//   3. Inject markFirstOutput so the LaunchOverlay lifts and xterm.open() runs.
//   4. Wait for .xterm-helper-textarea to be attached inside the window frame.
//   5. Click the maximize button (button takes DOM focus - the pre-fix broken state).
//   6. Assert .xterm-helper-textarea is focused afterward.
//      toBeFocused() has built-in retry, absorbing the useEffect tick.
// ---------------------------------------------------------------------------
test.describe('Task Detail: maximize focus restore', () => {
  test('maximize then restore via button returns keyboard focus to the xterm textarea', async () => {
    // This test pins the behavior fixed in PR #33 Surface 2: the useEffect in
    // TaskDetailWindow.tsx that calls textarea.focus() whenever isMaximized
    // changes after mount (wasMaximizedRef skips the initial-mount no-op).
    //
    // Red-green: removing the useEffect([isMaximized, windowId]) focus block from
    // TaskDetailWindow.tsx makes the maximize button keep DOM focus, so the
    // xtermTextarea toBeFocused() assertion fails.
    const { browser, page } = await launchWithState(preConfig);
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

      // Open the task-detail window for the running session task.
      const card = page
        .locator('[data-swimlane-name="Code Review"]')
        .locator('text=Maximize Task')
        .first();
      await card.click();

      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // The window frame wraps the task-detail-dialog content.
      const frame = page.locator('[data-testid^="window-frame-"]').filter({
        has: page.locator('[data-testid="task-detail-dialog"]'),
      });

      // Inject sessionFirstOutput so TerminalTab's terminalReady flips to true
      // immediately, lifting the LaunchOverlay shimmer and triggering xterm.open().
      await markSessionFirstOutput(page, SESSION_ID);

      // Wait for xterm to open: .xterm-helper-textarea is the focusable element
      // xterm attaches immediately after terminal.open() completes.
      const xtermTextarea = frame.locator('.xterm-helper-textarea').first();
      await xtermTextarea.waitFor({ state: 'attached', timeout: 8000 });

      // The maximize button is surfaced in the TaskDetailHeader for running sessions.
      const maximizeButton = page.locator('[data-testid="task-detail-maximize"]');
      await expect(maximizeButton).toBeVisible();
      await expect(maximizeButton).toHaveAccessibleName(/^Maximize/);

      // Click maximize - the button takes DOM focus (this is the pre-fix broken
      // state: without the useEffect the xterm textarea would stay unfocused).
      await maximizeButton.click();
      await expect(maximizeButton).toHaveAccessibleName(/^Restore/);

      // The fix: the useEffect([isMaximized, windowId]) in TaskDetailWindow calls
      // textarea.focus() on every toggle after mount. toBeFocused() retries
      // internally, absorbing the React useEffect + rAF scheduling.
      await expect(xtermTextarea).toBeFocused({ timeout: 3000 });

      // Restore via button - focus must also return to xterm after the downward toggle.
      await maximizeButton.click();
      await expect(maximizeButton).toHaveAccessibleName(/^Maximize/);
      await expect(xtermTextarea).toBeFocused({ timeout: 3000 });
    } finally {
      await browser.close();
    }
  });
});
