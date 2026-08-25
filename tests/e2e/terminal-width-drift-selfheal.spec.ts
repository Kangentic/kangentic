/**
 * The terminal width-drift self-heal, exercised against a real PTY by
 * deterministically injecting the incident it exists to recover from.
 *
 * THE INCIDENT: a task-detail window's xterm at one width while the PTY (and
 * main's headless parser) draw at another - observed live as a staircased
 * frame (rows shifted progressively right, labels clipped at the left edge).
 * xterm re-sends dimensions only when its OWN size changes, so before the
 * self-heal this divergence had NO recovery path: the window stayed garbled
 * until resized by hand.
 *
 * THE INJECTION: `window.electronAPI.sessions.resize(sessionId, rogue dims)`
 * from page.evaluate. That call is exactly what any lost or overridden resize
 * does to the PTY - main honors it (last-writer-wins, no surface identity),
 * the PTY and headless grid move to the rogue dims, and the mounted window
 * xterm is left behind at its own fit. Production-safe: the preload bridge is
 * not tree-shaken (unlike the devtools globals - see terminal-fit-invariant's
 * header for why nothing here may touch those).
 *
 * THE ORACLES:
 * - The new SESSION_PTY_RESIZED echo (subscribed via the preload bridge):
 *   main announces every real PTY grid change, so the recorder sees the rogue
 *   dims land (positive control) and then the owner's dims return (the heal).
 * - A one-shot destructive probe at the END: resize(owner dims) returning
 *   `colsChanged: false` proves the PTY is at the owner's grid. Never used as
 *   a poll - each probe call would itself heal the PTY and mask a broken fix.
 * - Linux only: the TUI fixture embeds the width it drew at into its ruler
 *   line (`RULER-<cols>-`). This oracle is DIAGNOSTIC ONLY, not load-bearing
 *   in either direction: the fixture cancels and re-arms its repaint timer on
 *   every observed resize (see mock-claude.js onResizeObserved), so whether a
 *   given resize (rogue or corrective) ever produces a drawn ruler is itself
 *   a race against whichever resize arrives next. Requiring the rogue-width
 *   frame to manifest would flake in exact proportion to how well the heal -
 *   the feature under test - is working, since the heal is allowed and
 *   encouraged to win that race and supersede the draw before it happens.
 *   Gated off win32: ConPTY delivers no SIGWINCH to the grandchild fixture,
 *   so it never redraws at new dims there (measured; see mock-claude.js).
 *   CI's gate is Linux, where the full set runs.
 * - A grid-width recorder on `.xterm-screen`: the heal must re-assert the
 *   OWNER's grid, never refit the visible xterm to the rogue dims - exactly
 *   one distinct detail-window width across injection + heal.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  launchApp,
  closeApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  getTaskIdByTitle,
  moveTaskIpc,
  waitForBoard,
  resolveMockAgentPath,
  armPtyEchoRecorder,
  readPtyEchoes,
  settledPtyEchoes,
  rulerWidths,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

const TEST_NAME = 'terminal-width-drift-selfheal';
const PROJECT_NAME = 'WidthDriftHeal';
const TASK_NAME = 'Width drift heal task';

let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;
let resizeLogPath: string;

function readLogLines(): string[] {
  try {
    return fs.readFileSync(resizeLogPath, 'utf-8').split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/** True once the fixture process is actually running (see terminal-fit-invariant). */
function fixtureIsLive(): boolean {
  return readLogLines().some((line) => line.startsWith('start:'));
}

async function getSwimlaneByName(target: Page, name: string): Promise<string> {
  const swimlaneId = await target.evaluate(async (laneName) => {
    const swimlanes: Array<{ id: string; name: string }> = await window.electronAPI.swimlanes.list();
    return swimlanes.find((swimlane) => swimlane.name === laneName)?.id ?? null;
  }, name);
  if (!swimlaneId) throw new Error(`Swimlane "${name}" not found`);
  return swimlaneId;
}

/** First-output latch, polled instead of scrollback content: getScrollback
 *  drains the pending flush buffer as a side effect, and a read landing inside
 *  the 16ms flush window starves the latch forever. ORDERING IS LOAD-BEARING -
 *  no scrollback read (direct or via mounting a terminal) before this is true.
 *  Full flake history: terminal-fullscreen-select-replay-focus.spec.ts. */
async function hasFirstOutputForTask(target: Page, targetTaskId: string): Promise<boolean> {
  return target.evaluate(async (taskId) => {
    const sessions: Array<{ id: string; taskId: string }> = await window.electronAPI.sessions.list();
    const session = sessions.find((sessionEntry) => sessionEntry.taskId === taskId);
    if (!session) return false;
    const firstOutputCache = await window.electronAPI.sessions.getFirstOutput();
    return !!firstOutputCache[session.id];
  }, targetTaskId);
}

const SETTLE_MESSAGE =
  'The PTY-dims echo log never settled non-empty. Either this surface flip '
  + 'produced no real grid change (the two surfaces happened to fit identically '
  + 'in this window size - see terminal-fit-invariant\'s positive control) or '
  + 'the SESSION_PTY_RESIZED broadcast is broken.';

async function scrollbackForSession(target: Page, targetSessionId: string): Promise<string> {
  return target.evaluate(async (sessionId) => window.electronAPI.sessions.getScrollback(sessionId), targetSessionId);
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
      MOCK_CLAUDE_TUI_REPAINT: '1',
      // 20ms, deliberately far under the 150ms heal debounce. The fixture
      // CANCELS and re-arms its repaint timer on every observed resize and
      // draws at the CURRENT grid when the timer fires (see mock-claude.js
      // onResizeObserved), so if the heal's corrective SIGWINCH arrives before
      // the rogue-width draw timer has fired, the rogue frame is silently
      // superseded and the diagnostic ruler read at the end of this test can
      // never see it - the heal legitimately wins that race. The margin here
      // narrows how OFTEN that happens; it cannot eliminate the race, so
      // nothing in this test blocks on the rogue frame actually manifesting
      // (see THE ORACLES at the top of this file).
      MOCK_CLAUDE_TUI_REPAINT_DELAY_MS: '20',
      // Diagnostic output only, never an oracle (empty by construction on
      // Windows - see mock-claude.js). The `start:` line is the liveness signal.
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

test.describe('terminal width-drift self-heal', () => {
  test.setTimeout(120_000);

  test('a rogue PTY resize under an open task-detail window is healed back to the owner grid', async () => {
    await waitForBoard(page);
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

    await createTask(page, TASK_NAME);
    const taskId = await getTaskIdByTitle(page, TASK_NAME);
    const executingSwimlaneId = await getSwimlaneByName(page, 'Executing');
    await moveTaskIpc(page, taskId, executingSwimlaneId);

    await page.locator('[data-testid="terminal-session-pane"] .xterm-screen')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 });
    await expect.poll(fixtureIsLive, {
      message: 'The TUI fixture never announced itself; nothing below would test anything.',
      timeout: 30000,
      intervals: [100],
    }).toBe(true);
    await expect.poll(() => hasFirstOutputForTask(page, taskId), { timeout: 30000, intervals: [100] }).toBe(true);

    const sessionId: string = await page.evaluate(async (targetTaskId) => {
      const sessions: Array<{ id: string; taskId: string }> = await window.electronAPI.sessions.list();
      const session = sessions.find((sessionEntry) => sessionEntry.taskId === targetTaskId);
      if (!session) throw new Error('no session for task');
      return session.id;
    }, taskId);

    // Arm the echo recorder and the grid-width recorder BEFORE opening the
    // window, so the window's own mount echo and every width it renders are
    // captured. ORDERING IS LOAD-BEARING for ownerDims below: the recorder is
    // armed this close to the open so the LAST settled echo after the open is
    // the window's own mount fit. Armed any earlier (before the task move or
    // first output), a pre-open echo could be the last entry whenever the
    // window's fit happens to be a same-dims no-op, silently rebasing the
    // whole test on the wrong grid.
    await armPtyEchoRecorder(page, sessionId);
    await page.evaluate(() => {
      const globalScope = window as unknown as {
        __detailWidths?: number[];
        __detailWidthObserver?: MutationObserver;
      };

      // Trimmed from terminal-fit-invariant's recorder: every distinct width
      // the detail window's xterm renders (from `.xterm-screen`'s inline
      // style, xterm's own authority). Observer-based, not polled, so a width
      // replaced within one frame is still counted.
      globalScope.__detailWidths = [];
      globalScope.__detailWidthObserver?.disconnect();
      const record = (screen: HTMLElement) => {
        if (!screen.closest('#window-layer-root')) return;
        const width = Math.round(parseFloat(screen.style.width || '0'));
        if (!width) return;
        const widths = globalScope.__detailWidths!;
        if (widths[widths.length - 1] !== width) widths.push(width);
      };
      const observer = new MutationObserver((records) => {
        for (const mutation of records) {
          const target = mutation.target as HTMLElement;
          if (target.classList?.contains('xterm-screen')) record(target);
          for (const added of Array.from(mutation.addedNodes)) {
            if (!(added instanceof HTMLElement)) continue;
            const screen = added.classList.contains('xterm-screen') ? added : added.querySelector('.xterm-screen');
            if (screen instanceof HTMLElement) record(screen);
          }
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
      globalScope.__detailWidthObserver = observer;
    });

    // Open the task detail the genuine way (card click) and let the handoff
    // settle: the window's mount fit resizes the PTY, which is the last echo.
    await page.locator(`[data-task-id="${taskId}"]`).first().click();
    await page.locator('#window-layer-root .xterm-screen').first().waitFor({ state: 'visible', timeout: 15000 });
    const settledAfterOpen = await settledPtyEchoes(page, 30000, SETTLE_MESSAGE);
    const ownerDims = settledAfterOpen[settledAfterOpen.length - 1];
    expect(ownerDims.cols).toBeGreaterThan(10);
    expect(ownerDims.rows).toBeGreaterThan(5);

    if (process.platform !== 'win32') {
      // Baseline control: the fixture repainted at the owner width, so the
      // ruler oracle is live before the injection relies on it.
      await expect
        .poll(async () => {
          const widths = rulerWidths(await scrollbackForSession(page, sessionId));
          return widths[widths.length - 1] ?? 0;
        }, { timeout: 15000, intervals: [250] })
        .toBe(ownerDims.cols);
    }

    // THE INJECTION: what a lost or overridden resize does to the PTY. 306x15
    // is the real incident's bottom-panel strip; shifted if the window
    // happens to fit at 306 already.
    const rogueCols = ownerDims.cols === 306 ? 320 : 306;
    const rogueRows = ownerDims.rows === 15 ? 20 : 15;
    const injectionResult: { colsChanged: boolean } = await page.evaluate(
      async ({ sessionId: injectionSessionId, cols, rows }) =>
        window.electronAPI.sessions.resize(injectionSessionId, cols, rows),
      { sessionId, cols: rogueCols, rows: rogueRows },
    );

    // Positive control 1: the PTY actually diverged (main honored the rogue grid).
    expect(injectionResult.colsChanged).toBe(true);

    // Positive control 2: the divergence was broadcast - the signal the heal
    // consumes. The recorder log is append-only, so this cannot be masked by
    // the heal racing it.
    await expect
      .poll(async () => {
        const echoes = await readPtyEchoes(page);
        return echoes.some((echo) => echo.cols === rogueCols && echo.rows === rogueRows);
      }, { timeout: 10000, intervals: [100] })
      .toBe(true);

    // NOTE: there is deliberately no assertion here that the rogue-width
    // frame appears in scrollback before the heal. Positive controls 1 and 2
    // above already prove - deterministically - that the rogue resize reached
    // the PTY: injectionResult.colsChanged and the append-only echo log both
    // resolve from main's own synchronous resize handling, not from the
    // fixture's repaint. Whether the fixture ALSO manages to draw a full
    // frame at the rogue width before the heal's corrective SIGWINCH arrives
    // is a separate race the heal is allowed - encouraged - to win (see THE
    // ORACLES at the top of this file for why that oracle is diagnostic
    // only). A prior version of this test polled scrollback for the
    // rogue-width ruler here and blocked on it; on a fast or loaded CI worker
    // the heal legitimately won that race before the ruler ever landed,
    // timing out a precondition that had nothing to do with whether the heal
    // itself worked. See the diagnostic ruler read at the end of this test
    // for what actually happened on a given run.

    // THE HEAL: the mounted owner re-asserts its grid; main applies it and
    // echoes the owner dims back as the final word.
    await expect
      .poll(async () => {
        const echoes = await readPtyEchoes(page);
        const last = echoes[echoes.length - 1];
        return last ? `${last.cols}x${last.rows}` : 'none';
      }, { timeout: 15000, intervals: [250] })
      .toBe(`${ownerDims.cols}x${ownerDims.rows}`);

    // No resize storm: once healed, the echo log stops moving, and the tail
    // after the rogue entry is exactly the single corrective re-assert.
    const finalEchoes = await settledPtyEchoes(page, 15000, SETTLE_MESSAGE);
    const lastRogueIndex = finalEchoes.map((echo) => echo.cols).lastIndexOf(rogueCols);
    expect(lastRogueIndex).toBeGreaterThanOrEqual(0);
    expect(finalEchoes.slice(lastRogueIndex + 1)).toEqual([
      { cols: ownerDims.cols, rows: ownerDims.rows, origin: 'desktop' },
    ]);

    if (process.platform !== 'win32') {
      // Diagnostic only, not load-bearing (see THE ORACLES at the top of this
      // file): IF the fixture drew a fresh frame anywhere in this window, the
      // last one is at the owner's healed width. This can also be satisfied
      // vacuously by the pre-injection baseline ruler alone, on a run where
      // the fixture's repaint timer never got a clean shot to fire again
      // post-heal - a real, observed outcome (see the end-of-test ruler log
      // for what actually happened). The deterministic proof that the heal
      // occurred is the echo-log assertion above (`finalEchoes` /
      // `lastRogueIndex`), which does not depend on the fixture repainting.
      await expect
        .poll(async () => {
          const widths = rulerWidths(await scrollbackForSession(page, sessionId));
          return widths[widths.length - 1] ?? 0;
        }, { timeout: 15000, intervals: [250] })
        .toBe(ownerDims.cols);
    }

    // The heal must never "fix" the divergence by refitting the visible xterm
    // to the rogue dims: the detail window rendered exactly ONE distinct grid
    // width through injection + heal.
    const detailWidths: number[] = await page.evaluate(() => {
      const widths = (window as unknown as { __detailWidths?: number[] }).__detailWidths ?? [];
      return widths.slice();
    });
    expect(
      new Set(detailWidths).size,
      'The detail window rendered more than one grid width across the injection and '
      + 'heal, so the "heal" moved the visible xterm instead of re-asserting its grid. '
      + 'Recorded widths: ' + JSON.stringify(detailWidths),
    ).toBe(1);

    // END-ONLY destructive probe (never poll with this - each call would
    // itself heal the PTY): a no-op resize at the owner dims proves the PTY
    // is exactly there.
    const probeResult: { colsChanged: boolean } = await page.evaluate(
      async ({ sessionId: probeSessionId, cols, rows }) =>
        window.electronAPI.sessions.resize(probeSessionId, cols, rows),
      { sessionId, cols: ownerDims.cols, rows: ownerDims.rows },
    );
    expect(probeResult.colsChanged).toBe(false);

    // Diagnostic-only ruler read (see THE ORACLES at the top of this file):
    // rulers accumulate in scrollback rather than being erased by the heal,
    // so one unpolled read here - after every assertion above has already
    // run its course - sees every frame the fixture managed to draw across
    // the whole injection+heal window, whichever of the rogue and owner
    // widths (if any) it won the race to draw. Not asserted on: on win32 this
    // is always [] (no SIGWINCH reaches the fixture there), and on Linux it
    // can legitimately show just the pre-injection baseline if the heal's
    // corrective resize beat the fixture's repaint timer on every attempt.
    const observedRulerWidths = rulerWidths(await scrollbackForSession(page, sessionId));

    console.log('[width-drift-selfheal] echoes: ' + JSON.stringify(finalEchoes));
    console.log('[width-drift-selfheal] detail widths: ' + JSON.stringify(detailWidths));
    console.log('[width-drift-selfheal] ruler widths (diagnostic): ' + JSON.stringify(observedRulerWidths));

    await page.evaluate(() => {
      const globalScope = window as unknown as {
        __ptyEchoUnsubscribe?: () => void;
        __detailWidthObserver?: MutationObserver;
      };
      globalScope.__ptyEchoUnsubscribe?.();
      globalScope.__detailWidthObserver?.disconnect();
    });
  });
});
