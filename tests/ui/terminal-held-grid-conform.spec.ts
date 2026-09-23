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
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-held-grid';
const TASK_ID = 'task-held-grid';
const SESSION_ID = 'sess-held-grid';
const HELD = { cols: 154, rows: 37 };
const CONFIGURED_FONT_PX = 14;

function preConfig(resizeResult: string): string {
  return `
  window.__mockResizeResult = ${resizeResult};
  window.__mockPreConfigure(function (state) {
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

async function launch(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
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
