/**
 * The terminal fit invariant, exercised by the rapid open/close cycle that breaks
 * it in practice.
 *
 * THE INVARIANT: an xterm's rendered grid must never be wider than the box showing
 * it. `.xterm-screen` width <= `.xterm-viewport` clientWidth. When it is wider the
 * right-hand column is cut off and a horizontal scrollbar appears, which is the
 * "opens un-resized" report - and because xterm re-sends dimensions only when its
 * OWN size changes, an overflowing grid has no path back: no refit is triggered, so
 * the terminal stays wrong until the window is resized by hand.
 *
 * SECOND INVARIANT: one detail-open should produce exactly ONE grid width. Two
 * means the mount fitted twice, so the PTY was resized twice, the agent repainted
 * twice, and the user watched the second repaint land - the "opens like this, then
 * refits" report. Counted from xterm's own `.xterm-screen` inline width via a
 * MutationObserver (see startGridWidthRecorder): pure DOM, so it works in the
 * production builds CI runs, where the devtools bridge is tree-shaken away, and on
 * Windows, where the fixture's own resize log cannot fill at all.
 *
 * WHY E2E AND NOT UI TIER: this needs a real PTY. A real agent produces real
 * content, which is what makes the viewport scroll and the geometry settle the way
 * it does at runtime; the UI tier's mock has no PTY and cannot reproduce any of it.
 *
 * WHY A REPAINTING TUI FIXTURE: plain `mock-claude` never repaints, so it has no
 * race, so this harness went GREEN against it while the real app flickered - it
 * proved nothing. `MOCK_CLAUDE_TUI_REPAINT=1` makes the fixture behave like Claude's
 * renderer in the ways that matter: alt screen, a full-screen erase per frame, a
 * DEC 2026 synchronized frame, and a DELAYED repaint on SIGWINCH so the agent's
 * redraw can land after the renderer has already sampled scrollback.
 *
 * WHY PURE DOM AND NOT THE DEVTOOLS ROUTE: `/terminal-state` reports this invariant
 * (plus the PTY-vs-grid half the DOM cannot see), but the inspection bridge is
 * tree-shaken out of production builds and CI builds production - a route-based
 * assertion would SKIP on CI and gate nothing. `.xterm-screen` and
 * `.xterm-viewport` are real DOM in every build, so this runs everywhere.
 * Use `kangentic_devtools_terminal_state` for the richer cross-process picture
 * when investigating locally against a dev build.
 *
 * WHY RAPID CYCLES: a single open is not enough. The failure needs the handoff to
 * race - the bottom panel and the detail window fitting to different widths while a
 * repaint is in flight - so the loop opens and closes with a short dwell and checks
 * the invariant after every cycle, reporting the first cycle that breaks it.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  launchApp,
  closeApp,
  createProject,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  waitForBoard,
  resolveMockAgentPath,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

const TEST_NAME = 'terminal-fit-invariant';
const PROJECT_NAME = 'FitInvariant';
const TASK_NAME = 'Fit invariant task';

/** Enough cycles to hit the race, few enough to stay inside the E2E budget. */
const CYCLES = 8;
/** Short dwell: the point is to reopen while the previous handoff is still settling. */
const DWELL_MS = 150;

let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

// Platform-correct via the shared helper. Pointing `cliPath` at a bare `.js` on
// Windows makes the shell pop "Select an app to open this .js file" instead of
// running the mock: the agent never starts, so the PTY never resizes, so this
// harness observed zero resizes and its assertions were vacuous. That is exactly
// how it happened here.

/** Where the fixture appends its `start:` line and then one line per observed
 *  PTY resize. */
let resizeLogPath: string;

function readLogLines(): string[] {
  try {
    return fs.readFileSync(resizeLogPath, 'utf-8').split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/** True once the fixture process is actually running.
 *
 *  The mock is a grandchild of the PTY (shell, then node), so it can take several
 *  hundred ms to boot - comfortably longer than it takes this spec to open a task
 *  detail. Measuring before then reads an empty resize log and a fixture whose
 *  FIRST frame is already at the final width, which is indistinguishable from "the
 *  app never resized the PTY". That is not hypothetical: it is what made the run
 *  before this check trip its own positive control. */
function fixtureIsLive(): boolean {
  return readLogLines().some((line) => line.startsWith('start:'));
}

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);
  resizeLogPath = path.join(dataDir, 'tui-resizes.log');
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: resolveMockAgentPath('mock-claude'),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }),
  );
  const result = await launchApp({
    dataDir,
    extraEnv: {
      // A fullscreen TUI that repaints on SIGWINCH, which is what creates the
      // race this harness exists to catch. See the fixture for why the repaint
      // is deliberately delayed.
      MOCK_CLAUDE_TUI_REPAINT: '1',
      MOCK_CLAUDE_TUI_REPAINT_DELAY_MS: '80',
      MOCK_CLAUDE_RESIZE_LOG: resizeLogPath,
    },
  });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await closeApp(app);
  cleanupTempProject(TEST_NAME);
});

interface FitReading {
  surface: string;
  screenWidth: number;
  viewportClientWidth: number;
  overflowPx: number;
}

/**
 * Measure every mounted xterm straight from the DOM. Rounds to whole pixels: the
 * grid is an integer number of cells, so a sub-pixel difference is layout noise
 * rather than a real overflow, and asserting on raw floats would be the
 * pixel-exact fragility `cross-platform-parity` warns about.
 */
/**
 * Start recording every distinct grid width xterm renders, per surface.
 *
 * THE ORACLE for "how many widths did one open produce". xterm writes its grid
 * size into `.xterm-screen`'s inline style on every resize, and each distinct
 * width is one `terminal.onResize` and so one PTY resize. That makes this a
 * renderer-side count of exactly what the fixture's log was supposed to provide,
 * with three advantages: it is pure DOM (works in the production builds CI runs,
 * unlike the tree-shaken devtools bridge), it works on Windows (where ConPTY
 * leaves the fixture's own geometry frozen - see mock-claude.js), and it cannot
 * be perturbed by the measurement.
 *
 * Installed once and re-armed per cycle rather than polled, so a width that
 * appears and is replaced inside a single frame is still counted. Polling would
 * miss exactly the transient this spec exists to catch.
 */
async function startGridWidthRecorder(target: Page): Promise<void> {
  await target.evaluate(() => {
    const globalScope = window as unknown as {
      __gridWidths?: string[];
      __gridObserver?: MutationObserver;
    };
    globalScope.__gridWidths = [];
    globalScope.__gridObserver?.disconnect();

    const record = (screen: HTMLElement) => {
      const surface = screen.closest('#window-layer-root') ? 'detail-window' : 'bottom-panel';
      // The inline style is the authority (xterm sets it from cols * cellWidth).
      // Rounded so sub-pixel noise cannot masquerade as a distinct grid.
      const width = Math.round(parseFloat(screen.style.width || '0'));
      if (!width) return;
      const entry = `${surface}:${width}`;
      const widths = globalScope.__gridWidths!;
      // Consecutive duplicates are re-renders at the same size, not new widths.
      if (widths[widths.length - 1] !== entry) widths.push(entry);
    };

    const observer = new MutationObserver((records) => {
      for (const record_ of records) {
        const target_ = record_.target as HTMLElement;
        if (target_.classList?.contains('xterm-screen')) record(target_);
        // A freshly mounted terminal arrives as an added subtree, so its first
        // width is an addedNodes record rather than an attribute change.
        for (const added of Array.from(record_.addedNodes)) {
          if (!(added instanceof HTMLElement)) continue;
          const screen = added.classList.contains('xterm-screen')
            ? added
            : added.querySelector('.xterm-screen');
          if (screen instanceof HTMLElement) record(screen);
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    globalScope.__gridObserver = observer;
  });
}

/** Distinct grid widths recorded since the recorder was armed. */
async function readGridWidths(target: Page): Promise<string[]> {
  return target.evaluate(() => {
    const widths = (window as unknown as { __gridWidths?: string[] }).__gridWidths ?? [];
    return widths.slice();
  });
}

/** Drop everything recorded so far, so the next open is counted on its own. */
async function resetGridWidths(target: Page): Promise<void> {
  await target.evaluate(() => {
    (window as unknown as { __gridWidths?: string[] }).__gridWidths = [];
  });
}

async function readFits(target: Page): Promise<FitReading[]> {
  return target.evaluate(() => {
    const readings: Array<{
      surface: string;
      screenWidth: number;
      viewportClientWidth: number;
      overflowPx: number;
    }> = [];
    for (const xterm of Array.from(document.querySelectorAll('.xterm'))) {
      const screen = xterm.querySelector('.xterm-screen') as HTMLElement | null;
      const viewport = xterm.querySelector('.xterm-viewport') as HTMLElement | null;
      if (!screen || !viewport) continue;
      const screenWidth = Math.round(screen.getBoundingClientRect().width);
      const viewportClientWidth = viewport.clientWidth;
      readings.push({
        surface: xterm.closest('#window-layer-root') ? 'detail-window' : 'bottom-panel',
        screenWidth,
        viewportClientWidth,
        overflowPx: screenWidth - viewportClientWidth,
      });
    }
    return readings;
  });
}

test.describe('terminal fit invariant across rapid detail open/close', () => {
  // A real agent spawn plus N open/close cycles does not fit the default 45s.
  // Raised deliberately rather than trimming cycles further: the race needs
  // repetition to surface, so cycle count is the load-bearing part.
  test.setTimeout(150_000);

  test('a terminal grid never renders wider than its viewport', async () => {
    // Spawn a real agent so the terminal has real content and real geometry.
    await waitForBoard(page);
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

    const taskId = await page.evaluate(async (title) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          board: { getState: () => {
            swimlanes: Array<{ id: string; name: string }>;
            createTask: (input: unknown) => Promise<{ id: string }>;
            moveTask: (input: unknown, skip?: boolean) => Promise<unknown>;
          } };
        };
      }).__zustandStores;
      if (!stores) throw new Error('window.__zustandStores not exposed');
      const board = stores.board.getState();
      const todo = board.swimlanes.find((lane) => lane.name === 'To Do');
      const executing = board.swimlanes.find((lane) => lane.name === 'Executing');
      if (!todo || !executing) throw new Error('expected To Do and Executing lanes');
      const task = await board.createTask({ title, swimlane_id: todo.id, description: '' });
      await board.moveTask(
        { taskId: task.id, targetSwimlaneId: executing.id, targetPosition: 0 },
        true,
      );
      return task.id;
    }, TASK_NAME);

    // Wait for the PTY to be live and painting into the bottom panel.
    await page.locator('[data-testid="terminal-session-pane"] .xterm-screen')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 });

    // ...and for the FIXTURE ITSELF to be running, which the xterm above does not
    // imply (see fixtureIsLive). Until it is, no resize can be observed and every
    // count below would be zero for the wrong reason.
    await expect.poll(fixtureIsLive, {
      message:
        'The TUI fixture never announced itself, so MOCK_CLAUDE_TUI_REPAINT did not '
        + 'reach it (or it failed to start). Without the fixture there is no repaint '
        + 'and nothing here tests anything.',
      timeout: 30000,
      intervals: [100],
    }).toBe(true);

    // Open through the same signal every entry point uses (card click, search
    // palette, notification): `detailTaskId` asks main's arbiter, which pushes back
    // and mounts the window.
    const openDetail = async (id: string) => {
      await page.evaluate((detailTaskId) => {
        const stores = (window as unknown as {
          __zustandStores?: { session: { getState: () => { setDetailTaskId: (v: string | null) => void } } };
        }).__zustandStores;
        stores?.session.getState().setDetailTaskId(detailTaskId);
      }, id);
      await page.locator('#window-layer-root .xterm-screen')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });
    };

    // Close via the window's own control, NOT by clearing `detailTaskId`.
    //
    // The bridge is deliberately one-way (useTaskDetailWindowBridge): the signal
    // opens a window, and a window CLOSING clears the signal - never the reverse.
    // So `setDetailTaskId(null)` closes nothing. An earlier version of this spec
    // did exactly that, leaving the window open for all 8 cycles: every cycle
    // then re-"opened" an already-open window, recorded zero new grid widths, and
    // the assertion compared two empty arrays. Green, and completely blind.
    // Clicking the real control also exercises the real teardown (claim release,
    // terminal ownership handoff back to the panel).
    const closeDetail = async () => {
      await page.locator('#window-layer-root [data-testid="task-detail-close"]').first().click();
      await page.locator('#window-layer-root .xterm-screen')
        .first()
        .waitFor({ state: 'detached', timeout: 15000 });
    };

    const violations: Array<{ cycle: number; readings: FitReading[] }> = [];
    const gridWidthsPerOpen: Array<{ cycle: number; widths: string[] }> = [];
    await startGridWidthRecorder(page);

    // POSITIVE CONTROL, asserted before anything else.
    //
    // The handoff this harness exists to test only happens if the bottom panel and
    // the detail window fit to DIFFERENT grid widths - that difference is what
    // resizes the PTY, and the resize is what makes the agent repaint. If the two
    // happen to agree (a small E2E window, a collapsed panel), there is no resize,
    // no repaint, and nothing to catch: every assertion below then passes while
    // testing NOTHING.
    //
    // That is not hypothetical. This harness produced three meaningless greens
    // before this control was sharp enough: once against a non-repainting mock,
    // once against a fixture that never started, and once against a fixture whose
    // resize log CANNOT fill on Windows (ConPTY freezes a grandchild's reported
    // geometry - see mock-claude.js). So the scenario proves it occurred, from the
    // renderer's own grid, before its outcome is worth asserting.
    const panelGeometry = await readFits(page);
    await openDetail(taskId);
    await page.waitForTimeout(500);
    const windowGeometry = await readFits(page);
    const controlWidths = await readGridWidths(page);
    await closeDetail();
    await page.waitForTimeout(300);

    const panelWidths = new Set(
      controlWidths.filter((entry) => entry.startsWith('bottom-panel:')).map((entry) => entry.split(':')[1]),
    );
    const windowWidths = new Set(
      controlWidths.filter((entry) => entry.startsWith('detail-window:')).map((entry) => entry.split(':')[1]),
    );
    const surfacesDiffer = [...windowWidths].some((width) => !panelWidths.has(width));

    expect(
      windowWidths.size > 0 && surfacesDiffer,
      'Opening a task detail did not produce a detail-window grid at a DIFFERENT '
      + 'width from the bottom panel, so this run never reproduced the handoff and '
      + 'the assertions below would be vacuous. Recorded grid widths: '
      + JSON.stringify(controlWidths)
      + ' panel geometry: ' + JSON.stringify(panelGeometry)
      + ' window geometry: ' + JSON.stringify(windowGeometry)
      + '. For reference, the real app shows panel 306x11 and window 209x48.',
    ).toBe(true);

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      await resetGridWidths(page);
      // openDetail waits for the window's own terminal rather than sleeping, so the
      // check runs against a mounted grid (cross-platform-parity: wait for the
      // condition, not a duration).
      await openDetail(taskId);
      await page.waitForTimeout(DWELL_MS);

      const readings = await readFits(page);
      if (readings.some((reading) => reading.overflowPx > 0)) {
        violations.push({ cycle, readings });
      }
      // How many DISTINCT grid widths this ONE open produced in the detail window.
      // More than one means the mount fitted twice, so the PTY was resized twice,
      // the agent repainted twice, and the second repaint is the visible
      // correction the user watches land.
      //
      // Distinct, not raw count: one open legitimately records the same width more
      // than once (StrictMode double-mounts in dev, and the bottom panel's own
      // grid changes land in between so the repeats are not adjacent). Repeats at
      // one width cost no PTY resize. Two different widths do.
      const openWidths = (await readGridWidths(page)).filter((entry) => entry.startsWith('detail-window:'));
      gridWidthsPerOpen.push({ cycle, widths: [...new Set(openWidths)] });

      await closeDetail();
      await page.waitForTimeout(DWELL_MS);
    }

    // Print what the oracle saw on EVERY run, pass or fail. A green run whose
    // recorded widths are empty is not a green run, it is a blind one, and that
    // distinction is invisible if only failures report.
    console.log('[fit-invariant] control widths: ' + JSON.stringify(controlWidths));
    console.log('[fit-invariant] per-open widths: ' + JSON.stringify(gridWidthsPerOpen));

    // Every cycle must have recorded at least one width, or the loop was inert and
    // the multi-width assertion below would compare empty arrays. This is the
    // second half of the positive control: the control proves the surfaces differ,
    // this proves each cycle actually re-mounted a terminal.
    const inertCycles = gridWidthsPerOpen.filter((entry) => entry.widths.length === 0);
    expect(
      inertCycles,
      'Some open/close cycles recorded no detail-window grid at all, so those cycles '
      + 'never re-mounted a terminal and assert nothing. Recorded:\n'
      + JSON.stringify(gridWidthsPerOpen, null, 2),
    ).toEqual([]);

    expect(
      violations,
      'A terminal grid rendered wider than its viewport, so its right-hand column is '
      + 'clipped and a horizontal scrollbar appears. xterm only re-sends dimensions '
      + 'when its OWN size changes, so an overflowing grid never triggers a refit and '
      + 'stays wrong until the window is resized by hand. First offending cycles:\n'
      + JSON.stringify(violations.slice(0, 3), null, 2),
    ).toEqual([]);

    const multiWidthOpens = gridWidthsPerOpen.filter((entry) => entry.widths.length > 1);
    expect(
      multiWidthOpens,
      'Opening one task detail produced more than one grid width, so the PTY was '
      + 'resized twice, the agent repainted twice, and the user sees the later repaint '
      + 'replace the first frame (the "opens like this, then refits" report). Each '
      + 'open must settle on a single width.\n\n'
      + 'The known cause of exactly this: a fit whose result depends on state that '
      + 'changes DURING the mount. The scrollback replay writes the TUI\'s alt-screen '
      + 'enter, so anything the fit reads off the buffer mode (the scrollbar reserve, '
      + 'historically) yields one width before the replay and another after. Keep '
      + 'proposeDimensions a pure function of container geometry.\n\n'
      + 'Offending opens:\n'
      + JSON.stringify(multiWidthOpens, null, 2)
      + '\nAll opens:\n'
      + JSON.stringify(gridWidthsPerOpen, null, 2),
    ).toEqual([]);
  });
});
