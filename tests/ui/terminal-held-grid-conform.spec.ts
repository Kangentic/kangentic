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
 * 3. A held grid far smaller than the pane is capped at 1.5 times the configured font.
 * 4. A plain refusal without a held grid conforms nothing (the echo re-assert's contract).
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

test('a held grid much smaller than the pane is capped at 1.5 times the configured font', async () => {
  // A 60 by 12 grid would fit the window at several times the configured size; the terminal
  // stops at CONFORM_MAX_SCALE and letterboxes, so it never reads as a different scale from the
  // UI around it.
  const small = { cols: 60, rows: 12 };
  const { browser, page } = await launch(preConfig(JSON.stringify({ colsChanged: false, refused: true, held: small })));
  try {
    await openTaskWindow(page);
    await expect.poll(async () => (await readGrid(page)) ?? undefined, { timeout: 15000 }).toMatchObject(small);
    const conforms = await readEvents(page, 'conform');
    expect(conforms.length).toBeGreaterThan(0);
    const fontSize = conforms[conforms.length - 1].detail?.fontSize as number;
    expect(fontSize).toBe(CONFIGURED_FONT_PX * 1.5);
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
