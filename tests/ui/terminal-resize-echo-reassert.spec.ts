/**
 * UI test for the terminal width-drift self-heal: the SESSION_PTY_RESIZED echo
 * listener in useTerminal, driven end to end through a REAL mounted xterm.
 *
 * The bug family: main's PTY can be reshaped under a mounted xterm (a lost
 * resize, another surface's late write, a respawn), and xterm re-sends its
 * dimensions only when its OWN size changes - so the two diverge with no
 * recovery path, and live absolute-positioned TUI output wraps into a
 * staircase until the window is resized by hand. Main now broadcasts a dims
 * echo on every real PTY grid change; the mounted owner compares it to its own
 * grid and re-asserts its fit, then repairs the frame with a scrollback
 * replay. The guard matrix itself (resolvePtyEchoReassert) is unit-tested in
 * tests/unit/pty-resize-echo-reassert.test.ts; this spec pins the WIRING: the
 * listener reads the real xterm's dims, the re-assert goes out as a real
 * sessions.resize, the repair replay repaints, and the budget/self-echo guards
 * are consulted through the real refs.
 *
 * Launches with WebGL disabled (the window-park-reveal.spec.ts pattern) so
 * xterm uses its DOM renderer and terminal content is assertable as text.
 * The bounded-attempts and self-echo tests read the dev-mode renderer trace
 * ring (window.__kangenticTerminalTrace, installed by DevtoolsBootstrap under
 * the Vite dev server) - a deterministic "the echo was processed" signal, so
 * no negative assertion needs a bare timeout.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-resize-echo';
const TASK_ID = 'task-resize-echo';
const SESSION_ID = 'sess-resize-echo';
const TASK_TITLE = 'Resize Echo Task';

const INITIAL_CONTENT = 'INITIAL-SCROLLBACK-FRAME';
const REPAIRED_CONTENT = 'REPAIRED-AT-OWNER-WIDTH';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Resize Echo Test',
      path: '/mock/resize-echo-test',
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

    // Running session so the task-detail window opens with a live terminal.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/resize-echo-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: '${TASK_TITLE}',
      description: 'Task used to verify the width-drift echo re-assert',
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

interface ResizeCall {
  sessionId: string;
  cols: number;
  rows: number;
}

interface RendererTraceEvent {
  sessionId: string | null;
  event: string;
  detail?: Record<string, unknown>;
}

interface TestWindow {
  __scrollbackValue?: string;
  __scrollbackReads?: number;
  __mockFireSessionData?: (sessionId: string, data: string) => void;
  __mockFirePtyResized?: (sessionId: string, cols: number, rows: number, origin?: string) => void;
  __mockResizeResult?: { colsChanged: boolean; refused?: boolean };
  __kangenticTerminalTrace?: () => RendererTraceEvent[];
  __zustandStores?: {
    session?: {
      getState: () => { markFirstOutput: (id: string) => void };
    };
  };
  electronAPI?: {
    sessions: {
      getScrollback: (sessionId: string) => Promise<string>;
      __resizeCalls: ResizeCall[];
    };
  };
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  // Disable WebGL so xterm renders through its DOM renderer and terminal
  // CONTENT is assertable as text (with WebGL, innerText is empty).
  const browser = await chromium.launch({ headless: true, args: ['--disable-webgl', '--disable-webgl2'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Opens the task detail on a settled mount replay and returns the grid the
 *  window's xterm fitted to (captured from the mount-time resize IPC). */
async function openDetailAndCaptureOwnerDims(page: Page): Promise<{ cols: number; rows: number }> {
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

  // Lift the startup overlay (xterm mounts unsuppressed) and point
  // getScrollback at a mutable value, counting reads for the self-echo test.
  await page.evaluate(
    ({ sessionId, initialContent }) => {
      const testWindow = window as unknown as TestWindow;
      testWindow.__zustandStores?.session?.getState().markFirstOutput(sessionId);
      testWindow.__scrollbackValue = `${initialContent}\r\n`;
      testWindow.__scrollbackReads = 0;
      if (testWindow.electronAPI) {
        testWindow.electronAPI.sessions.getScrollback = async () => {
          const liveWindow = window as unknown as TestWindow;
          liveWindow.__scrollbackReads = (liveWindow.__scrollbackReads ?? 0) + 1;
          return liveWindow.__scrollbackValue ?? '';
        };
      }
    },
    { sessionId: SESSION_ID, initialContent: INITIAL_CONTENT },
  );

  await page
    .locator('[data-swimlane-name="Code Review"]')
    .locator(`text=${TASK_TITLE}`)
    .first()
    .click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  await dialog.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 10000 });
  await expect
    .poll(async () => dialog.locator('.xterm').first().innerText(), { timeout: 10000 })
    .toContain(INITIAL_CONTENT);

  // The mount replay sent an immediate resize at the fitted grid; the last
  // recorded call for this session is the owner's dims.
  await expect
    .poll(
      async () =>
        page.evaluate(
          (sessionId) =>
            ((window as unknown as TestWindow).electronAPI?.sessions.__resizeCalls ?? []).filter(
              (call) => call.sessionId === sessionId,
            ).length,
          SESSION_ID,
        ),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0);
  const ownerDims: ResizeCall = await page.evaluate((sessionId) => {
    const calls = ((window as unknown as TestWindow).electronAPI?.sessions.__resizeCalls ?? []).filter(
      (call) => call.sessionId === sessionId,
    );
    return calls[calls.length - 1];
  }, SESSION_ID);
  expect(ownerDims.cols).toBeGreaterThan(10);
  expect(ownerDims.rows).toBeGreaterThan(5);

  // Clean slate for the assertions: only re-assert sends land after this.
  await page.evaluate(() => {
    const testWindow = window as unknown as TestWindow;
    if (testWindow.electronAPI) testWindow.electronAPI.sessions.__resizeCalls.length = 0;
  });

  return { cols: ownerDims.cols, rows: ownerDims.rows };
}

async function readEchoTraceEvents(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((sessionId) => {
    const readTrace = (window as unknown as TestWindow).__kangenticTerminalTrace;
    if (typeof readTrace !== 'function') return [];
    return readTrace()
      .filter((entry) => entry.event === 'pty-resize-echo' && entry.sessionId === sessionId)
      .map((entry) => entry.detail ?? {});
  }, SESSION_ID);
}

/** Same shape as readEchoTraceEvents, but for the DIFFERENT event name
 *  reassertOwnGrid traces when main refuses a corrective re-assert (the
 *  mobile sub-floor hold) - a separate reader rather than a shared/parameterized
 *  one, so this new helper cannot change what the three existing tests read. */
async function readRefusedTraceEvents(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((sessionId) => {
    const readTrace = (window as unknown as TestWindow).__kangenticTerminalTrace;
    if (typeof readTrace !== 'function') return [];
    return readTrace()
      .filter((entry) => entry.event === 'echo-reassert-refused' && entry.sessionId === sessionId)
      .map((entry) => entry.detail ?? {});
  }, SESSION_ID);
}

/** Quiescence gate: waits until the renderer trace ring stops growing for two
 *  consecutive checks. A StrictMode second mount's replay can still be in
 *  flight right after openDetailAndCaptureOwnerDims resolves (skips a
 *  disagreeing echo as 'replay-in-flight'), and separately the window's own
 *  entrance-driven layout resize (debounced PTY_RESIZE_DEBOUNCE_MS = 200ms in
 *  useTerminal.ts) can still be pending (skips as 'own-resize-pending'). A
 *  content-only settle (fire data, wait for it to paint) catches the first
 *  but is blind to the second, since a pending onResize touches no terminal
 *  content - the gap that let the single-heal and budget-bound tests below
 *  flake under worker contention (an intermittent skip where the test expects
 *  a scheduled re-assert). Watching the trace ring's length covers both:
 *  either state keeps emitting trace events (replay-start/fit/resize-request/
 *  replay-write/replay-done, or the eventual debounced resize-request) until
 *  it actually settles. */
async function waitForTerminalTraceQuiescence(page: Page): Promise<void> {
  let previousTraceLength = -1;
  let stableChecks = 0;
  await expect
    .poll(async () => {
      const currentTraceLength = await page.evaluate(
        (sessionId) =>
          ((window as unknown as TestWindow).__kangenticTerminalTrace?.() ?? []).filter(
            (entry) => entry.sessionId === sessionId,
          ).length,
        SESSION_ID,
      );
      stableChecks = currentTraceLength === previousTraceLength ? stableChecks + 1 : 0;
      previousTraceLength = currentTraceLength;
      return stableChecks;
    }, { timeout: 10000, intervals: [250, 250, 250] })
    .toBeGreaterThanOrEqual(2);
}

/** Drops whatever __resizeCalls has accumulated so far. Used AFTER
 *  waitForTerminalTraceQuiescence, right before a test fires the echo it
 *  actually means to pin: the window manager's own layout-settle flush
 *  (scheduleWindowTerminalResize -> flushResize, origin 'flush') can land
 *  after openDetailAndCaptureOwnerDims's own clear but before quiescence is
 *  reached, at the SAME dims as ownerDims - benign window housekeeping, not a
 *  corrective re-assert, but indistinguishable from one by dims alone.
 *  Clearing again here (post-quiescence, so no further window-layout resize
 *  is expected) means the only calls left by the time a test asserts are the
 *  ones it is actually pinning. */
async function clearResizeCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as unknown as TestWindow;
    if (testWindow.electronAPI) testWindow.electronAPI.sessions.__resizeCalls.length = 0;
  });
}

test.describe('Terminal width-drift echo re-assert', () => {
  test('a disagreeing echo makes the mounted owner re-assert its grid once and repair the frame', async () => {
    const { browser, page } = await launchWithState(preConfig);
    try {
      const ownerDims = await openDetailAndCaptureOwnerDims(page);
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      const rogueCols = ownerDims.cols + 80;

      // Quiescence gate before the incident is provoked: a still-pending
      // replay or window-entrance-driven layout resize (see
      // waitForTerminalTraceQuiescence) would otherwise let the TRIGGERING
      // echo below land while resolvePtyEchoReassert still sees
      // 'replay-in-flight' or 'own-resize-pending', silently skipping the
      // re-assert this test means to pin and leaving the torn frame
      // unrepaired.
      await waitForTerminalTraceQuiescence(page);
      await clearResizeCalls(page);

      // The incident, reproduced: the PTY (simulated by the fired data) draws
      // a ruler exactly rogueCols wide while the xterm sits at ownerDims. The
      // line must wrap - the staircase positive control: #END lands on a row
      // of its own, torn off the RULER- prefix. Fired inside the poll: a byte
      // swallowed by a still-in-flight mount replay (held, then superseded by
      // its sample) is simply re-fired until one lands live.
      await expect
        .poll(async () => {
          await page.evaluate(
            ({ sessionId, cols }) => {
              const ruler = (`RULER-${cols}-`).padEnd(cols - 4, '.') + '#END';
              (window as unknown as TestWindow).__mockFireSessionData?.(sessionId, `${ruler}\r\n`);
            },
            { sessionId: SESSION_ID, cols: rogueCols },
          );
          const text = await dialog.locator('.xterm').first().innerText();
          const endRow = text.split('\n').find((row) => row.includes('#END'));
          return endRow !== undefined && !endRow.includes('RULER-');
        }, { timeout: 10000, intervals: [250] })
        .toBe(true);

      // The repair replay will fetch this frame (main's parsed grid, drawn at
      // the corrected width).
      await page.evaluate((repaired) => {
        (window as unknown as TestWindow).__scrollbackValue = `${repaired}\r\n`;
      }, REPAIRED_CONTENT);

      // The echo: main announces the PTY moved to the rogue grid.
      await page.evaluate(
        ({ sessionId, cols }) => {
          (window as unknown as TestWindow).__mockFirePtyResized?.(sessionId, cols, 15, 'desktop');
        },
        { sessionId: SESSION_ID, cols: rogueCols },
      );

      // The heal: exactly one corrective resize, at the OWNER's dims - not the
      // rogue ones (a bad fix that refits the xterm to the echoed grid would
      // send rogueCols here), and not more than one (ownership gating: no
      // second surface re-asserts).
      await expect
        .poll(
          async () => page.evaluate(() => (window as unknown as TestWindow).electronAPI?.sessions.__resizeCalls ?? []),
          { timeout: 10000 },
        )
        .toEqual([{ sessionId: SESSION_ID, cols: ownerDims.cols, rows: ownerDims.rows }]);

      // The repair replay replaced the torn frame (xterm.reset before the
      // write), so the staircased ruler is gone and the repaired frame shows.
      await expect
        .poll(async () => dialog.locator('.xterm').first().innerText(), { timeout: 10000 })
        .toContain(REPAIRED_CONTENT);
      const repairedText = await dialog.locator('.xterm').first().innerText();
      expect(repairedText).not.toContain('#END');
    } finally {
      await browser.close();
    }
  });

  test('the echo of the terminal own grid is skipped in-sync: no resize, no replay', async () => {
    const { browser, page } = await launchWithState(preConfig);
    try {
      const ownerDims = await openDetailAndCaptureOwnerDims(page);

      const scrollbackReadsBefore = await page.evaluate(
        () => (window as unknown as TestWindow).__scrollbackReads ?? 0,
      );

      // An echo carrying the terminal's own dims - what its own resize (or a
      // remount re-send) reflects back.
      await page.evaluate(
        ({ sessionId, cols, rows }) => {
          (window as unknown as TestWindow).__mockFirePtyResized?.(sessionId, cols, rows, 'desktop');
        },
        { sessionId: SESSION_ID, cols: ownerDims.cols, rows: ownerDims.rows },
      );

      // Deterministic "the echo was processed" signal: the listener traces
      // every echo with its decision. This is the positive control that makes
      // the negative assertions below meaningful without a bare timeout.
      await expect
        .poll(async () => readEchoTraceEvents(page), { timeout: 5000 })
        .toEqual([
          expect.objectContaining({ action: 'skip', reason: 'in-sync', cols: ownerDims.cols, rows: ownerDims.rows }),
        ]);

      const resizeCalls = await page.evaluate(
        () => (window as unknown as TestWindow).electronAPI?.sessions.__resizeCalls ?? [],
      );
      expect(resizeCalls).toEqual([]);
      const scrollbackReadsAfter = await page.evaluate(
        () => (window as unknown as TestWindow).__scrollbackReads ?? 0,
      );
      expect(scrollbackReadsAfter).toBe(scrollbackReadsBefore);
    } finally {
      await browser.close();
    }
  });

  test('repeated echoes of one divergence are bounded by the re-assert budget', async () => {
    const { browser, page } = await launchWithState(preConfig);
    try {
      const ownerDims = await openDetailAndCaptureOwnerDims(page);
      const rogueCols = ownerDims.cols + 80;

      // Quiescence gate: without this, the FIRST of the four echoes fired
      // below can legitimately skip as 'replay-in-flight' (a StrictMode
      // second mount's replay still in flight) or 'own-resize-pending' (the
      // window's own entrance-driven layout resize still debouncing), and the
      // test never reaches the cap it means to pin - the exact flake this
      // test hit under worker contention (all four decisions read 'skip'
      // instead of ['reassert', 'reassert', 'skip', 'skip']).
      await waitForTerminalTraceQuiescence(page);
      await clearResizeCalls(page);

      // Fire the SAME rogue echo four times in ONE synchronous evaluate: the
      // 150ms re-assert debounce cannot fire inside a single JS turn, so the
      // decisions are fully deterministic - reassert (count 1), reassert
      // (count 2, timer rescheduled), attempt-cap, attempt-cap - and the two
      // scheduled re-asserts coalesce into exactly one corrective send.
      await page.evaluate(
        ({ sessionId, cols }) => {
          for (let fired = 0; fired < 4; fired += 1) {
            (window as unknown as TestWindow).__mockFirePtyResized?.(sessionId, cols, 15, 'desktop');
          }
        },
        { sessionId: SESSION_ID, cols: rogueCols },
      );

      await expect
        .poll(async () => (await readEchoTraceEvents(page)).map((event) => event.action), { timeout: 5000 })
        .toEqual(['reassert', 'reassert', 'skip', 'skip']);
      const echoEvents = await readEchoTraceEvents(page);
      expect(echoEvents.filter((event) => event.reason === 'attempt-cap')).toHaveLength(2);

      // The coalesced debounced pass sends exactly one corrective resize, at
      // the OWNER's dims.
      await expect
        .poll(
          async () => page.evaluate(() => (window as unknown as TestWindow).electronAPI?.sessions.__resizeCalls ?? []),
          { timeout: 5000 },
        )
        .toEqual([{ sessionId: SESSION_ID, cols: ownerDims.cols, rows: ownerDims.rows }]);
    } finally {
      await browser.close();
    }
  });

  test('main refusing a re-assert arms a time-stamped hold that skips every later echo', async () => {
    const { browser, page } = await launchWithState(preConfig);
    try {
      const ownerDims = await openDetailAndCaptureOwnerDims(page);
      const rogueCols = ownerDims.cols + 80;

      // Quiescence gate before the triggering echo, so it is never skipped as
      // 'replay-in-flight' or 'own-resize-pending' (see
      // waitForTerminalTraceQuiescence). Re-clear __resizeCalls afterward: the
      // window manager's own layout-settle flush can land in the same window
      // (see clearResizeCalls) and would otherwise contaminate the
      // exactly-one-call assertion below.
      await waitForTerminalTraceQuiescence(page);
      await clearResizeCalls(page);

      // Force the corrective re-assert's resize IPC to come back refused (the
      // mobile sub-floor hold). Set only AFTER the mount replay has settled -
      // the mock returns __mockResizeResult for EVERY resize call, including
      // the mount-time fit, so setting this earlier would corrupt
      // openDetailAndCaptureOwnerDims's own resize call and its ownerDims read.
      await page.evaluate(() => {
        (window as unknown as TestWindow).__mockResizeResult = { colsChanged: false, refused: true };
      });

      const scrollbackReadsBefore = await page.evaluate(
        () => (window as unknown as TestWindow).__scrollbackReads ?? 0,
      );

      // The disagreeing echo: main announces the PTY moved to a rogue grid.
      await page.evaluate(
        ({ sessionId, cols }) => {
          (window as unknown as TestWindow).__mockFirePtyResized?.(sessionId, cols, 15, 'desktop');
        },
        { sessionId: SESSION_ID, cols: rogueCols },
      );

      // Deterministic "the refusal was processed" signal, so the negative
      // assertions below aren't racing the debounce + async resize round trip.
      await expect
        .poll(async () => (await readRefusedTraceEvents(page)).length, { timeout: 5000 })
        .toBe(1);

      // Exactly one corrective re-assert landed, at the OWNER's width (not the
      // rogue one echoed) - the send main refused.
      const resizeCallsAfterFirstEcho = await page.evaluate(
        () => (window as unknown as TestWindow).electronAPI?.sessions.__resizeCalls ?? [],
      );
      expect(resizeCallsAfterFirstEcho).toEqual([
        { sessionId: SESSION_ID, cols: ownerDims.cols, rows: ownerDims.rows },
      ]);

      // The refused trace's dims are read from the exact same re-fit as the
      // resize call above (reassertOwnGrid reads `{ cols, rows }` once and
      // uses it for both), so they must agree with each other.
      const refusedEvents = await readRefusedTraceEvents(page);
      expect(refusedEvents).toEqual([
        { cols: resizeCallsAfterFirstEcho[0].cols, rows: resizeCallsAfterFirstEcho[0].rows },
      ]);

      // No repair replay ran: a refused result returns before
      // reloadScrollbackRef is ever called.
      const scrollbackReadsAfter = await page.evaluate(
        () => (window as unknown as TestWindow).__scrollbackReads ?? 0,
      );
      expect(scrollbackReadsAfter).toBe(scrollbackReadsBefore);

      // A SECOND disagreeing echo, with a DIFFERENT cols value, is skipped
      // too: the refusal hold is time-stamped, not signature-keyed (see
      // ECHO_REASSERT_BUDGET_WINDOW_MS in useTerminal.ts), so a fresh
      // divergence signature does not reopen healing during the hold window.
      const secondRogueCols = ownerDims.cols + 40;
      await page.evaluate(
        ({ sessionId, cols }) => {
          (window as unknown as TestWindow).__mockFirePtyResized?.(sessionId, cols, 15, 'desktop');
        },
        { sessionId: SESSION_ID, cols: secondRogueCols },
      );

      await expect
        .poll(async () => readEchoTraceEvents(page), { timeout: 5000 })
        .toEqual([
          expect.objectContaining({ action: 'reassert' }),
          expect.objectContaining({
            action: 'skip', reason: 'refused-hold', cols: secondRogueCols, rows: 15,
          }),
        ]);

      // No further resize call: the second echo never scheduled a re-assert.
      const resizeCallsFinal = await page.evaluate(
        () => (window as unknown as TestWindow).electronAPI?.sessions.__resizeCalls ?? [],
      );
      expect(resizeCallsFinal).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });
});
