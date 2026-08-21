/**
 * UI test for the grid width a park -> reveal catch-up replay writes at, driven
 * through a REAL mounted xterm with a REAL WebGL renderer swap.
 *
 * The bug: a task-detail window's terminal came back from a Board -> Backlog ->
 * Board round trip rendering its agent frame hard-wrapped, and never recovered.
 * Parking a terminal disposes its WebGL addon for the GPU budget; the DOM
 * renderer it falls back to measures a WIDER cell, so FitAddon (which divides
 * the container by `_renderService.dimensions.css.cell.width`) proposes FEWER
 * columns for a container that never moved. The reveal used to fit in that
 * window and write main's full-width frame into the narrower grid, and the refit
 * afterwards widened the grid back without reflowing it - xterm reflows the
 * normal buffer on resize and never the ALTERNATE one, which is where a
 * full-screen agent TUI lives. Measured on a 1483px window: 210 columns
 * attached, 191 suspended, byte-identical hostWidth.
 *
 * WHY THIS SPEC KEEPS WEBGL ON DELIBERATELY. The terminal specs that assert on
 * xterm CONTENT pass `--disable-webgl` so the DOM renderer paints readable text
 * (window-park-reveal.spec.ts, terminal-resize-echo-reassert.spec.ts). That is
 * exactly the configuration in which this bug CANNOT happen: with no WebGL there
 * is no renderer to suspend and no metric to change. So this one keeps
 * SwiftShader on purpose and gives up reading terminal text, asserting on the
 * dev-mode renderer trace ring (window.__kangenticTerminalTrace) instead.
 *
 * Because the scenario depends on WebGL actually attaching, the first assertion
 * is a POSITIVE CONTROL: the round trip must really have suspended and resumed
 * the renderer. Without it a run on a machine where SwiftShader is unavailable
 * would pass having exercised nothing.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-reveal-grid-width';
const TASK_ID = 'task-reveal-grid-width';
const SESSION_ID = 'sess-reveal-grid-width';
const TASK_TITLE = 'Reveal Grid Width Task';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Reveal Grid Width Test',
      path: '/mock/reveal-grid-width-test',
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
      cwd: '/mock/reveal-grid-width-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: '${TASK_TITLE}',
      description: 'Task used to verify the reveal replay writes at the grid width',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/reveal-grid-width',
      branch_name: 'feature/reveal-grid-width',
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

interface RendererTraceEvent {
  ts: number;
  sessionId: string | null;
  event: string;
  detail?: Record<string, unknown>;
}

interface TestWindow {
  __scrollbackValue?: string;
  __kangenticTerminalTrace?: () => RendererTraceEvent[];
  __zustandStores?: {
    session?: { getState: () => { markFirstOutput: (id: string) => void } };
  };
  electronAPI?: { sessions: { getScrollback: (sessionId: string) => Promise<string> } };
}

async function launchWithWebgl(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  // Deliberately NO --disable-webgl: headless Chromium ships SwiftShader, and
  // the renderer swap this spec is about only exists when WebGL attaches. The
  // cost is that terminal content is painted to a canvas and unreadable as
  // text, so every assertion below reads the trace ring instead.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function readTrace(page: Page): Promise<RendererTraceEvent[]> {
  return page.evaluate((sessionId) => {
    const read = (window as unknown as TestWindow).__kangenticTerminalTrace;
    if (typeof read !== 'function') return [];
    return read().filter((entry) => entry.sessionId === sessionId);
  }, SESSION_ID);
}

test.describe('Reveal replay writes at the grid width', () => {
  test('a Board -> Backlog -> Board round trip fits on the renderer it keeps', async () => {
    // Triples the ui project's 15s budget. This spec pays a SwiftShader init the
    // --disable-webgl siblings skip, then waits out two full replays (the mount
    // and the reveal catch-up). It runs in ~2s unloaded, but the margin under a
    // loaded CI shard is what the headroom is for.
    test.slow();
    const { browser, page } = await launchWithWebgl(preConfig);
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

      // Lift the startup overlay so the xterm mounts unsuppressed, and give the
      // replay something to write. The content is never read back (WebGL paints
      // to a canvas); only the width it is written AT matters here.
      //
      // getScrollback MUST be re-pointed at __scrollbackValue: the baseline mock
      // returns '' unconditionally, and useTerminal skips the reset + write (and
      // so emits no replay-write) when the sample is empty. Without this the
      // width assertions below have no write to check. Same wiring as
      // window-park-reveal.spec.ts and terminal-resize-echo-reassert.spec.ts.
      await page.evaluate((sessionId) => {
        const testWindow = window as unknown as TestWindow;
        testWindow.__zustandStores?.session?.getState().markFirstOutput(sessionId);
        testWindow.__scrollbackValue = 'REVEAL-GRID-WIDTH-FRAME\r\n';
        if (testWindow.electronAPI) {
          testWindow.electronAPI.sessions.getScrollback = async () =>
            (window as unknown as TestWindow).__scrollbackValue ?? '';
        }
      }, SESSION_ID);

      await page
        .locator('[data-swimlane-name="Code Review"]')
        .locator(`text=${TASK_TITLE}`)
        .first()
        .click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await dialog.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 10000 });

      // Settle the mount before parking, so the reveal below is the only replay
      // in flight and the trace reads cleanly.
      await expect
        .poll(async () => (await readTrace(page)).filter((entry) => entry.event === 'replay-done').length, {
          timeout: 15000,
        })
        .toBeGreaterThan(0);
      const mountedTrace = await readTrace(page);
      const mountDone = mountedTrace.filter((entry) => entry.event === 'replay-done').pop();
      const mountedCols = mountDone?.detail?.cols as number | undefined;
      expect(mountedCols, 'the mount replay never recorded a grid width').toBeGreaterThan(10);
      // The task-detail dialog's OWN 'initial' fit, kept for the hostWidth
      // positive control below. `.pop()`, not `.find()`, for the same reason
      // mountDone above uses it: this session's terminal mounts TWICE before
      // the dialog settles (once in the bottom panel, once in the dialog once
      // it claims the session), and only the LAST one is the terminal this
      // test goes on to park/reveal.
      // hostWidth is a pure CSS/DOM measurement (WindowLayer keeps a parked
      // window's overlay `visibility:hidden`, which preserves its measured size
      // rather than collapsing it), so it is safe to compare across a renderer
      // swap in a way a raw `cols` count is not - see the note at the reveal fit.
      const mountFit = mountedTrace
        .filter((entry) => entry.event === 'fit' && entry.detail?.phase === 'initial')
        .pop();

      const revealDoneCount = mountedTrace.filter((entry) => entry.event === 'terminal-reveal').length;

      // The repro, exactly as reported.
      await page.locator('[data-testid="view-toggle-backlog"]').click();
      await page.locator('[data-testid="view-toggle-board"]').click();

      await expect
        .poll(
          async () => (await readTrace(page)).filter((entry) => entry.event === 'terminal-reveal').length,
          { timeout: 15000 },
        )
        .toBeGreaterThan(revealDoneCount);
      // ...and for the reveal's own replay to finish, so replay-write and the
      // post-write refit are both on the ring before anything is asserted.
      await expect
        .poll(
          async () => {
            const trace = await readTrace(page);
            const revealAt = trace.map((entry) => entry.event).lastIndexOf('terminal-reveal');
            return trace.slice(revealAt).some((entry) => entry.event === 'replay-done');
          },
          { timeout: 15000 },
        )
        .toBe(true);

      const trace = await readTrace(page);
      const events = trace.map((entry) => entry.event);
      const revealAt = events.lastIndexOf('terminal-reveal');
      const after = trace.slice(revealAt);

      // POSITIVE CONTROL. If the renderer was never suspended and resumed, this
      // run exercised none of the mechanism and every assertion below is
      // vacuous - which is exactly how a WebGL-disabled spec would "pass".
      const suspendAt = events.lastIndexOf('webgl-suspend');
      const resumeAt = events.lastIndexOf('webgl-resume');
      expect(
        suspendAt,
        'The round trip never suspended the WebGL renderer, so this run did not '
        + 'reproduce the renderer swap and proves nothing. Either SwiftShader is '
        + 'unavailable on this machine (xterm fell back to the DOM renderer for the '
        + 'whole run) or the parked-terminal WebGL budget stopped firing. Trace: '
        + JSON.stringify(events),
      ).toBeGreaterThan(-1);
      expect(resumeAt, 'the renderer was suspended but never resumed').toBeGreaterThan(suspendAt);

      // THE FIX, observed end to end: the renderer is back before the reveal is
      // published, so the catch-up replay's fit runs on the renderer it keeps.
      // RED: moving applyWebglAttachmentPlan back below syncParkedTerminals in
      // useFocusedSessionsSync puts webgl-resume after terminal-reveal here.
      expect(
        resumeAt,
        'The WebGL renderer resumed AFTER the reveal was published, so the reveal '
        + 'replay fitted itself against the DOM fallback\'s cell metric.',
      ).toBeLessThan(revealAt);

      // THE INVARIANT. The reveal fit must run against the same container the
      // mount fit did (below), and the frame it writes must be laid out at the
      // width the grid still has once the write settles (further below).
      // RED against the original bug: replay-write recorded cols 191 while
      // replay-done reported 210 - a frame laid out for a width the grid no
      // longer had.
      const revealFit = after.find(
        (entry) => entry.event === 'fit' && entry.detail?.phase === 'reload-initial',
      );
      expect(revealFit, 'the reveal produced no reload-initial fit').toBeTruthy();
      expect(revealFit?.detail?.applied, 'the reveal fit declined; the grid kept a stale width').toBe(true);

      // POSITIVE CONTROL: the container itself did not move across the round
      // trip. Compared against hostWidth (a plain DOM measurement), not cols -
      // `cols` is a function of BOTH hostWidth and the live renderer's cell
      // metric (WebGL floors the measured cell width to an integer device
      // pixel, the DOM renderer does not - see useTerminal.ts's describeFit),
      // so two fits an entire park/reveal round trip apart can legitimately
      // read a different `cols` off an UNCHANGED hostWidth. Asserting on cols
      // here previously false-failed intermittently: with the renderer-swap
      // ordering bug live, colsBefore and cols disagree WITHIN the same
      // reload (unstable mid-flight), which the write/settle check below
      // already catches directly; comparing against a colsBefore snapshot
      // taken as early as mount time additionally trips on any OTHER, benign
      // cause of the metric changing between mount and this reveal.
      expect(
        revealFit?.detail?.hostWidth,
        'The reveal fit ran against a different container width than the mount fit '
        + '(mount hostWidth ' + String(mountFit?.detail?.hostWidth) + ', reveal hostWidth '
        + String(revealFit?.detail?.hostWidth) + '), so this run does not isolate a '
        + 'renderer-metric change from an actual layout change.',
      ).toBe(mountFit?.detail?.hostWidth);

      const revealWrite = after.find((entry) => entry.event === 'replay-write');
      const revealDone = after.find((entry) => entry.event === 'replay-done');
      expect(revealDone, 'the reveal replay never completed').toBeTruthy();
      // Asserted, not `if`-guarded: the two checks below ARE the invariant this
      // spec exists for, so a run that produced no write must fail rather than
      // skip them and report green.
      expect(
        revealWrite,
        'the reveal replay wrote nothing, so its width was never checked',
      ).toBeTruthy();
      expect(
        revealWrite?.detail?.cols,
        'The reveal wrote main\'s frame at one width and settled at another. In the '
        + 'alternate screen buffer xterm never reflows, so that frame stays wrapped '
        + 'until something makes the agent repaint.',
      ).toBe(revealDone?.detail?.cols);
      expect(revealDone?.detail?.widthReason).toBe('width-held');
    } finally {
      await browser.close();
    }
  });
});
