/**
 * UI test for a terminal conforming to a grid main HOLDS (SessionResizeResult.held).
 *
 * When main refuses a resize and names the grid it keeps, the terminal takes that grid as its
 * own and picks the font size that fits it into the pane, letterboxed, instead of keeping its
 * natural fit and showing the PTY's frame wrapped or clipped inside it (useTerminal's
 * conformToHeldGrid). The web demo holds every replayed session at its recording's grid this
 * way, and the desktop's mobile sub-floor hold gets the same treatment. Three things are pinned
 * here, all read off the dev-mode renderer trace ring and grid registry rather than terminal
 * text (WebGL is left on, as window-reveal-grid-width.spec.ts explains):
 *
 * 1. A held answer conforms: the grid becomes the held one and the font goes below the
 *    configured 14 px, because the held grid is wider than the pane's natural fit.
 * 2. A probe main accepts releases the hold: once the mock stops holding, a refit sends the
 *    natural grid, main takes it, and the terminal goes back to its own fit at 14 px.
 * 3. A held grid far smaller than the pane stays at the configured font (no scaling up).
 * 4. A plain refusal without a held grid conforms nothing (the echo re-assert's contract).
 * 5. A SECOND held grid the pane cannot show at any font releases the hold instead of leaving
 *    the terminal silently claiming the first one (requestGrid's held-grid-changed branch).
 * 6. A held grid whose conform walks FOUR OR MORE quarter-pixel steps below its proposal is still
 *    taken, which is what raising CONFORM_MAX_STEPS from 4 to 12 bought. The walk length depends on
 *    the host's monospace face, so that test measures the face and seeds the size that walks long.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-held-grid';
const TASK_ID = 'task-held-grid';
const SESSION_ID = 'sess-held-grid';
const HELD = { cols: 154, rows: 37 };
const CONFIGURED_FONT_PX = 14;
// The long-walk test seeds its own face and size (see chooseWalkingFontSize). The family is the
// mock's default, written out so the size is chosen and rendered against the same string.
const WALK_FONT_FAMILY = 'Consolas, "Courier New", monospace';
const WALK_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
// conformToHeldGrid tries CONFORM_MAX_STEPS sizes, the proposal and then each quarter pixel below
// it, so a budget of N takes a grid that needs at most N - 1 steps down. The budget was 4 and is
// 12: a grid that needs between 4 and 11 steps is the one the raise made reachable.
const OLD_STEP_BUDGET = 4;
const CURRENT_STEP_BUDGET = 12;
const FONT_STEP_PX = 0.25;

function preConfig(resizeResult: string, terminalOverrides?: { fontFamily: string; fontSize: number }): string {
  return `
  window.__mockResizeResult = ${resizeResult};
  window.__mockPreConfigure(function (state) {
    ${terminalOverrides ? `Object.assign(state.config.terminal, ${JSON.stringify(terminalOverrides)});` : ''}
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Held Grid Test', path: '/mock/held-grid-test', github_url: null,
      default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999, status: 'running',
      shell: 'bash', cwd: '/mock/held-grid-test', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', display_id: 1, title: 'Held Grid Task', description: 'A terminal main holds at a grid',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/held-grid', branch_name: 'feature/held-grid', pr_number: null, pr_url: null,
      base_branch: 'main', archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;
}

interface RendererTraceEvent { sessionId: string | null; event: string; detail?: Record<string, unknown> }
interface TerminalGridReport { sessionId: string | null; cols: number; rows: number }
interface TestWindow {
  __mockResizeResult?: unknown;
  __kangenticTerminalTrace?: () => RendererTraceEvent[];
  __kangenticTerminalGrids?: () => TerminalGridReport[];
}

async function openBrowserContext(): Promise<{ browser: Browser; context: BrowserContext }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  return { browser, context };
}

async function openPage(context: BrowserContext, preConfigScript: string): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return page;
}

async function launch(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  const { browser, context } = await openBrowserContext();
  const page = await openPage(context, preConfigScript);
  return { browser, page };
}

function readGrid(page: Page): Promise<TerminalGridReport | null> {
  return page.evaluate((sessionId) => {
    const read = (window as unknown as TestWindow).__kangenticTerminalGrids;
    const grids = read ? read() : [];
    return grids.find((grid) => grid.sessionId === sessionId) ?? null;
  }, SESSION_ID);
}

function readEvents(page: Page, event: string): Promise<RendererTraceEvent[]> {
  return page.evaluate(({ sessionId, name }) => {
    const read = (window as unknown as TestWindow).__kangenticTerminalTrace;
    return (read ? read() : []).filter((entry) => entry.sessionId === sessionId && entry.event === name);
  }, { sessionId: SESSION_ID, name: event });
}

async function openTaskWindow(page: Page): Promise<void> {
  await page.locator(`[data-task-id="${TASK_ID}"]`).first().click();
  await page.locator('[data-testid="task-detail-terminal-dim"] .xterm').first().waitFor({ timeout: 15000 });
}

async function closeTaskWindow(page: Page): Promise<void> {
  // Dispatched at document level: a focused xterm swallows a real Escape keypress.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.locator('[data-testid="task-detail-terminal-dim"] .xterm').first().waitFor({ state: 'detached', timeout: 5000 });
}

/** The grid the terminal fits on its own once its pane stops moving: unchanged across three reads. */
async function readSettledGrid(page: Page): Promise<{ cols: number; rows: number }> {
  let previous = '';
  let unchangedReads = 0;
  await expect.poll(async () => {
    const grid = await readGrid(page);
    const current = grid ? `${grid.cols}x${grid.rows}` : '';
    unchangedReads = current !== '' && current === previous ? unchangedReads + 1 : 0;
    previous = current;
    return unchangedReads;
  }, { timeout: 10000, intervals: [100, 150, 200] }).toBeGreaterThanOrEqual(3);
  const settled = await readGrid(page);
  if (!settled) throw new Error('the terminal disappeared while its grid settled');
  return { cols: settled.cols, rows: settled.rows };
}

interface PaneMeasurement {
  /** The box a grid is fitted into: the fit addon's own arithmetic (parent box less padding and scrollbar gutter). */
  availableWidth: number;
  availableHeight: number;
  /** One cell in CSS px at the terminal's current font, read off the rendered screen. */
  cellWidth: number;
  cellHeight: number;
}

function measurePane(page: Page): Promise<PaneMeasurement> {
  return page.evaluate(() => {
    const xterm = document.querySelector<HTMLElement>('[data-testid="task-detail-terminal-dim"] .xterm');
    const parent = xterm?.parentElement;
    const viewport = xterm?.querySelector<HTMLElement>('.xterm-viewport');
    const screen = xterm?.querySelector<HTMLElement>('.xterm-screen');
    const read = (window as unknown as TestWindow).__kangenticTerminalGrids;
    const grid = read ? read()[0] : undefined;
    if (!xterm || !parent || !viewport || !screen || !grid) throw new Error('no mounted terminal to measure');
    const parentStyle = getComputedStyle(parent);
    const elementStyle = getComputedStyle(xterm);
    const screenBox = screen.getBoundingClientRect();
    return {
      availableWidth: parseInt(parentStyle.width, 10) - parseInt(elementStyle.paddingLeft, 10) - parseInt(elementStyle.paddingRight, 10)
        - (viewport.offsetWidth - viewport.clientWidth),
      availableHeight: parseInt(parentStyle.height, 10) - parseInt(elementStyle.paddingTop, 10) - parseInt(elementStyle.paddingBottom, 10),
      cellWidth: screenBox.width / grid.cols,
      cellHeight: screenBox.height / grid.rows,
    };
  });
}

/**
 * The integer font size, from the range a user can set, at which the host's own monospace face makes
 * a one-column-wider grid walk the longest sensible way down from the configured size.
 *
 * How many quarter-pixel steps a conform needs is a property of the face, not of the grid. The
 * renderer floors a cell's width to whole device pixels, so a grid one column wider than the pane's
 * natural fit needs the cell to lose one pixel, and the font has to drop until the face's advance
 * crosses that line. Consolas at 14 px walks about five steps; a face with a 0.6 em advance walks
 * about two at the same size, so the same test would pass at the old budget of four there. Measuring
 * the face here, the same way the second test does, and seeding the size whose walk comes nearest
 * `targetSteps` keeps the test discriminating on any host, instead of on this one machine's fonts.
 */
async function chooseWalkingFontSize(context: BrowserContext, targetSteps: number): Promise<number> {
  const probePage = await context.newPage();
  try {
    return await probePage.evaluate(({ fontFamily, candidateSizes, target, configuredBaseline }) => {
      const canvasContext = new OffscreenCanvas(16, 16).getContext('2d');
      if (!canvasContext) throw new Error('no 2d context to measure a cell with');
      const scale = window.devicePixelRatio;
      const cellWidthAt = (size: number): number => {
        canvasContext.font = `${size}px ${fontFamily}`;
        return Math.floor(canvasContext.measureText('W').width * scale) / scale;
      };
      let bestSize = candidateSizes[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of candidateSizes) {
        // The proposal for a grid one column past the natural fit lands within a quarter pixel below
        // the configured size, so the walk starts there and ends at the first size whose cell is
        // one device pixel narrower than the cell at the configured size.
        const narrowerWidth = cellWidthAt(candidate) - 1 / scale;
        let size = candidate - 0.25;
        let steps = 0;
        while (size >= 4 && cellWidthAt(size) > narrowerWidth) {
          size -= 0.25;
          steps += 1;
        }
        const distance = Math.abs(steps - target) * 100 + Math.abs(candidate - configuredBaseline);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestSize = candidate;
        }
      }
      return bestSize;
    }, { fontFamily: WALK_FONT_FAMILY, candidateSizes: WALK_FONT_SIZES, target: targetSteps, configuredBaseline: CONFIGURED_FONT_PX });
  } finally {
    await probePage.close();
  }
}

test('a held answer conforms the terminal to the held grid at a smaller font', async () => {
  const { browser, page } = await launch(preConfig(JSON.stringify({ colsChanged: false, refused: true, held: HELD })));
  try {
    await openTaskWindow(page);
    await expect.poll(async () => (await readGrid(page)) ?? undefined, { timeout: 15000 }).toMatchObject(HELD);
    const conforms = await readEvents(page, 'conform');
    expect(conforms.length).toBeGreaterThan(0);
    const fontSize = conforms[conforms.length - 1].detail?.fontSize;
    expect(typeof fontSize).toBe('number');
    // The held grid is wider than the window's natural fit at 14 px, so the font came down.
    expect(fontSize as number).toBeLessThan(CONFIGURED_FONT_PX);
    expect(fontSize as number).toBeGreaterThan(4);
    // The conformed grid's own resize is what main sees last; it is accepted, not re-held.
    expect((await readEvents(page, 'unhold')).length).toBe(0);
  } finally {
    await browser.close();
  }
});

test('a held answer conforms at the LARGEST font that fits, not the first one the linear proposal names', async () => {
  // The proposal scales the font by the ratio of the grid to the box, as if a cell scaled with it.
  // It does not: the renderer floors a cell's width to device pixels, so several quarter-pixel sizes
  // draw the same width, and the proposal lands on the smallest of them. At that size the held grid
  // fits with rows to spare that a larger size would have filled, and the terminal letterboxed
  // them: in the web demo, three empty rows under a tiled window in the posters' face. Pinned by
  // measuring the box and the cell one quarter step up the way the fit addon and xterm do: that
  // step must either pass the configured size or no longer hold the grid.
  const { browser, page } = await launch(preConfig(JSON.stringify({ colsChanged: false, refused: true, held: HELD })));
  try {
    await openTaskWindow(page);
    await expect.poll(async () => (await readGrid(page)) ?? undefined, { timeout: 15000 }).toMatchObject(HELD);
    const conforms = await readEvents(page, 'conform');
    const fontSize = conforms[conforms.length - 1].detail?.fontSize as number;
    expect(fontSize).toBeLessThan(CONFIGURED_FONT_PX);
    const nextStep = fontSize + 0.25;
    const fitsOneStepUp = await page.evaluate(async ({ larger, grid }) => {
      const api = (window as unknown as { electronAPI: { config: { getGlobal: () => Promise<{ terminal: { fontFamily: string } }> } } }).electronAPI;
      const fontFamily = (await api.config.getGlobal()).terminal.fontFamily;
      const xterm = document.querySelector<HTMLElement>('[data-testid="task-detail-terminal-dim"] .xterm');
      const parent = xterm?.parentElement;
      const viewport = xterm?.querySelector<HTMLElement>('.xterm-viewport');
      if (!xterm || !parent || !viewport) throw new Error('no conformed terminal to measure');
      const parentStyle = getComputedStyle(parent);
      const elementStyle = getComputedStyle(xterm);
      const availableWidth = parseInt(parentStyle.width, 10) - parseInt(elementStyle.paddingLeft, 10) - parseInt(elementStyle.paddingRight, 10)
        - (viewport.offsetWidth - viewport.clientWidth);
      const availableHeight = parseInt(parentStyle.height, 10) - parseInt(elementStyle.paddingTop, 10) - parseInt(elementStyle.paddingBottom, 10);
      // xterm's CharSizeService and the WebGL renderer's rounding (WebglRenderer._updateDimensions).
      const context = new OffscreenCanvas(16, 16).getContext('2d');
      if (!context) throw new Error('no 2d context to measure a cell with');
      context.font = `${larger}px ${fontFamily}`;
      const metrics = context.measureText('W');
      const scale = window.devicePixelRatio;
      const cellWidth = Math.floor(metrics.width * scale) / scale;
      const cellHeight = Math.ceil((metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) * scale) / scale;
      return grid.cols * cellWidth <= availableWidth && grid.rows * cellHeight <= availableHeight;
    }, { larger: nextStep, grid: HELD });
    expect(nextStep > CONFIGURED_FONT_PX || !fitsOneStepUp, `the grid still fits at ${nextStep}px, a quarter step above the ${fontSize}px it conformed at`).toBe(true);
  } finally {
    await browser.close();
  }
});

test('an accepted probe releases the hold and the terminal returns to its own fit', async () => {
  const { browser, page } = await launch(preConfig(JSON.stringify({ colsChanged: false, refused: true, held: HELD })));
  try {
    await openTaskWindow(page);
    await expect.poll(async () => (await readGrid(page)) ?? undefined, { timeout: 15000 }).toMatchObject(HELD);
    // Main lets go: the next probe (a refit sends one) is accepted.
    await page.evaluate(() => { (window as unknown as TestWindow).__mockResizeResult = null; });
    await page.setViewportSize({ width: 1500, height: 1000 });
    await expect.poll(async () => (await readEvents(page, 'unhold')).length, { timeout: 15000 }).toBeGreaterThan(0);
    await expect.poll(async () => {
      const grid = await readGrid(page);
      return grid ? grid.cols !== HELD.cols || grid.rows !== HELD.rows : false;
    }, { timeout: 15000 }).toBe(true);
    // Back at the configured font: a fit after the release is a plain container fit.
    const conformsAfter = (await readEvents(page, 'conform')).length;
    await page.setViewportSize({ width: 1450, height: 1000 });
    await page.waitForTimeout(600);
    expect((await readEvents(page, 'conform')).length).toBe(conformsAfter);
  } finally {
    await browser.close();
  }
});

test('a held grid much smaller than the pane stays at the configured font, letterboxed', async () => {
  // A 60 by 12 grid would fit the window at several times the configured size; the terminal
  // never scales up (CONFORM_MAX_SCALE is 1) and letterboxes instead, so it is never in bigger
  // type than the panel beside it.
  const small = { cols: 60, rows: 12 };
  const { browser, page } = await launch(preConfig(JSON.stringify({ colsChanged: false, refused: true, held: small })));
  try {
    await openTaskWindow(page);
    await expect.poll(async () => (await readGrid(page)) ?? undefined, { timeout: 15000 }).toMatchObject(small);
    const conforms = await readEvents(page, 'conform');
    expect(conforms.length).toBeGreaterThan(0);
    const fontSize = conforms[conforms.length - 1].detail?.fontSize as number;
    expect(fontSize).toBe(CONFIGURED_FONT_PX);
  } finally {
    await browser.close();
  }
});

test('a refusal without a held grid conforms nothing', async () => {
  const { browser, page } = await launch(preConfig(JSON.stringify({ colsChanged: false, refused: true })));
  try {
    await openTaskWindow(page);
    await expect.poll(async () => (await readGrid(page)) ?? undefined, { timeout: 15000 }).toBeDefined();
    await page.waitForTimeout(800);
    expect((await readEvents(page, 'conform')).length).toBe(0);
    const grid = await readGrid(page);
    expect(grid && (grid.cols !== HELD.cols || grid.rows !== HELD.rows)).toBe(true);
  } finally {
    await browser.close();
  }
});

test('a second held grid the pane cannot show releases the hold instead of keeping the first', async () => {
  const { browser, page } = await launch(preConfig(JSON.stringify({ colsChanged: false, refused: true, held: HELD })));
  try {
    await openTaskWindow(page);
    // Confirm the FIRST hold actually conforms before moving it, so this pins the A-then-B
    // transition rather than "one unfittable held grid declines" (which the accepted-probe
    // test above already covers via a fittable B).
    await expect.poll(async () => (await readGrid(page)) ?? undefined, { timeout: 15000 }).toMatchObject(HELD);
    expect((await readEvents(page, 'conform')).length).toBeGreaterThan(0);

    // Main moves the hold to a grid roughly 10x larger on each axis than any pane on any
    // platform can show, even at the 4px floor. The margin matters: the assertion below is
    // "conforming declined", never a measured pixel size, so this must clear
    // CONFORM_MIN_FONT_PX by a wide margin regardless of Windows-vs-Linux monospace metrics.
    const TOO_BIG = { cols: 4000, rows: 2000 };
    // The baseline is taken BEFORE the hold moves, and that ordering is the whole difference
    // between a deterministic test and one that can never pass. The terminal probes main on
    // every refit, so a probe can already be in flight when the mock switches; it then answers
    // TOO_BIG, declines, and spends the release before a baseline read placed after the switch
    // ever runs. The assertion below would then be waiting for a SECOND release that cannot
    // come, since nothing is held any more. Reading it here counts that release too.
    const unholdCountBeforeHoldMoved = (await readEvents(page, 'unhold')).length;
    await page.evaluate((grid) => {
      (window as unknown as TestWindow).__mockResizeResult = { colsChanged: false, refused: true, held: grid };
    }, TOO_BIG);
    // ENLARGE the viewport, not shrink it. A resize is what triggers the ResizeObserver ->
    // fit() -> fitTerminal('fit', true) that both probes main (asking "what grid would I take
    // on my own") and, in the SAME synchronous call, re-conforms to whatever grid is CURRENTLY
    // held (still HELD at this point, since the probe answer has not landed yet) so the pane
    // keeps showing HELD while the probe is in flight. A shrink risks that re-conform itself
    // failing (HELD no longer fitting the smaller box even at 4px) and releasing the hold for a
    // reason that has nothing to do with the second held grid this test is pinning - the
    // resulting `unhold` would be a false positive for a reverted fix. Growing the box can only
    // make the existing HELD conform easier, so the only way `unhold` fires below is the probe's
    // answer (TOO_BIG) landing back at requestGrid and being declined.
    await page.setViewportSize({ width: 1900, height: 1000 });

    // The discriminating assertion. `conform-declined` alone does not tell the fixed behavior
    // apart from the reverted one: conformToHeldGrid traces it either way. Only `unhold` proves
    // heldGridRef actually let go of the FIRST grid - reverting requestGrid's release (calling
    // conformToHeldGrid(result.held, origin) unconditionally, with no fallback release on a
    // decline) leaves this at unholdCountBeforeHoldMoved forever, because the terminal keeps
    // silently claiming HELD.
    await expect
      .poll(async () => (await readEvents(page, 'unhold')).length, { timeout: 15000 })
      .toBeGreaterThan(unholdCountBeforeHoldMoved);

    const declines = await readEvents(page, 'conform-declined');
    expect(declines.length).toBeGreaterThan(0);
    expect(declines[declines.length - 1].detail).toMatchObject({ cols: TOO_BIG.cols, rows: TOO_BIG.rows });
  } finally {
    await browser.close();
  }
});

test('a held grid that walks past the old budget of four steps is still taken', async () => {
  // Pins CONFORM_MAX_STEPS. The renderer floors a cell to device pixels, so the proposal (linear in
  // the cell) can sit several quarter pixels above the largest size that fits, and the conform walks
  // down to it. At a budget of four a walk of four steps or more was declined and the terminal kept
  // its own fit, showing the PTY's frame wrapped inside a grid it was never laid out for. The walk is
  // 4 to 11 steps here, so it passes at 12 and is declined at 4 (trace: conform-declined, reason steps).
  //
  // Two mounts of one window, plus a probe page, so this is the one test here that needs more than
  // the ui tier's 15 s on a loaded runner.
  test.slow();
  const { browser, context } = await openBrowserContext();
  try {
    // About midway between the old budget (a walk of 4) and the new one (a walk of 11).
    const fontSize = await chooseWalkingFontSize(context, 7);
    const page = await openPage(
      context,
      preConfig(JSON.stringify({ colsChanged: false, refused: true }), { fontFamily: WALK_FONT_FAMILY, fontSize }),
    );

    // Mount one, nothing held: the grid the terminal fits into this pane by itself, and the cell
    // it draws at the configured size, which is what the proposal for a held grid is scaled from.
    await openTaskWindow(page);
    const natural = await readSettledGrid(page);
    const pristine = await measurePane(page);
    expect((await readEvents(page, 'conform')).length).toBe(0);
    await closeTaskWindow(page);

    // Mount two: main keeps a grid one column wider than the pane's natural fit. Same rows, so the
    // width alone sets the walk (a smaller font only ever shortens a cell).
    const held = { cols: natural.cols + 1, rows: natural.rows };
    const resizeCallsBefore = await page.evaluate(() => (
      (window as unknown as { electronAPI: { sessions: { __resizeCalls: unknown[] } } }).electronAPI.sessions.__resizeCalls.length
    ));
    await page.evaluate((grid) => {
      (window as unknown as TestWindow).__mockResizeResult = { colsChanged: false, refused: true, held: grid };
    }, held);
    await openTaskWindow(page);

    // Either the hold is taken, or the conform declined it; the decline's own detail is the failure message.
    await expect.poll(async () => {
      const declines = await readEvents(page, 'conform-declined');
      if (declines.length > 0) return `declined ${JSON.stringify(declines[0].detail)}`;
      const grid = await readGrid(page);
      return grid && grid.cols === held.cols && grid.rows === held.rows ? 'taken' : 'waiting';
    }, { timeout: 10000 }).toBe('taken');

    // The pane did not move between the mounts: the first grid the second terminal asked main for is
    // the first one's natural fit, so "one column wider" still means one column past this pane's fit.
    const firstRequest = await page.evaluate((skip) => (
      (window as unknown as { electronAPI: { sessions: { __resizeCalls: Array<{ cols: number; rows: number }> } } })
        .electronAPI.sessions.__resizeCalls[skip]
    ), resizeCallsBefore);
    expect(firstRequest).toMatchObject(natural);

    // The walk's length, from what the page reports. The proposal is the documented one: the
    // largest quarter-pixel size at which the held grid would fit if the cell scaled with the font,
    // from the cell drawn at the configured size and the box left after padding and the gutter.
    const pane = await measurePane(page);
    const conforms = await readEvents(page, 'conform');
    expect(conforms.length).toBeGreaterThan(0);
    const conformedFontSize = conforms[0].detail?.fontSize as number;
    const scaleToFit = Math.min(
      pane.availableWidth / (held.cols * pristine.cellWidth),
      pane.availableHeight / (held.rows * pristine.cellHeight),
    );
    const proposedFontSize = Math.min(Math.floor((fontSize * scaleToFit) / FONT_STEP_PX) * FONT_STEP_PX, fontSize);
    const stepsBelowProposal = Math.round((proposedFontSize - conformedFontSize) / FONT_STEP_PX);
    expect(
      stepsBelowProposal,
      `the walk from ${proposedFontSize}px down to ${conformedFontSize}px must be long enough to need the raised budget; the host's face walks ${stepsBelowProposal} steps at ${fontSize}px`,
    ).toBeGreaterThanOrEqual(OLD_STEP_BUDGET);
    expect(stepsBelowProposal).toBeLessThan(CURRENT_STEP_BUDGET);

    // The hold stays taken: no later refit of the settled pane let it go.
    expect((await readEvents(page, 'unhold')).length).toBe(0);
    expect((await readEvents(page, 'conform-declined')).length).toBe(0);
    expect(await readGrid(page)).toMatchObject(held);
  } finally {
    await browser.close();
  }
});
