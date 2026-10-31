/**
 * UI tests for the Command Terminal rail's width and fold (#684).
 *
 * The rail opens at 300px and its edge drags it from 200 to 400. Below 200 it
 * holds there down to 100 and folds to a 37px strip past that, while the drag
 * runs. Its bottom row folds and opens it from the same spot. Width and fold are one global setting
 * (`AppConfig.commandTerminalRail`). A narrow panel shows the rail narrower
 * without rewriting that setting. Within the room beside the terminals' floor a
 * drag changes only the terminals' share of the panel, and each terminal refits
 * once; past that room it pushes the panel's right edge out instead, and the
 * terminals keep their size.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, isManagerResizeGateOpen } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'proj-cmd-rail';
/** Wide enough for two terminals side by side at the 630px floor, with the rail at its widest. */
const WIDE_VIEWPORT = { width: 2560, height: 1440 };
/** The app window's floor (`minWidth` / `minHeight` in src/main/index.ts). */
const FLOOR_VIEWPORT = { width: 900, height: 600 };
/** Sub-pixel rounding differs between Windows and headless Linux. */
const PIXEL_TOLERANCE = 2;

interface HistoryEntry { agentSessionId: string; agentName: string; label: string | null; firstPrompt: string | null; endedAt: string }
interface RailState { width: number; collapsed: boolean }

function preConfig(history: HistoryEntry[] = []): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Rail Project',
        path: '/mock/rail-project',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-rail-' + i, position: i, created_at: ts }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
    window.__mockCommandTerminalHistory = { '${PROJECT_ID}': ${JSON.stringify(history)} };
  `;
}

async function launch(
  viewport: { width: number; height: number },
  history: HistoryEntry[] = [],
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(history));
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const railOf = (page: Page) => page.getByTestId('command-terminal-rail');
const frameOf = (page: Page, slot: string) =>
  page.locator('[data-testid^="window-frame-"]', { has: page.locator(`[data-command-slot="${slot}"]`) });

async function boxOf(page: Page, testId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId(testId).first().boundingBox();
  if (!box) throw new Error(`no box for ${testId}`);
  return box;
}

const railWidth = async (page: Page): Promise<number> => (await boxOf(page, 'command-terminal-rail')).width;

const savedRail = (page: Page) => page.evaluate(async () =>
  ((await window.electronAPI.config.getGlobal()) as unknown as { commandTerminalRail?: RailState }).commandTerminalRail ?? null);

/** The width of the row the rail shares with the terminals. */
const rowWidth = (page: Page) => page.evaluate(() =>
  document.querySelector('[data-testid="command-terminal-rail"]')?.parentElement?.clientWidth ?? 0);

function expectNear(actual: number, expected: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(PIXEL_TOLERANCE);
}

const resizeCalls = (page: Page) => page.evaluate(() =>
  (window.electronAPI.sessions as unknown as { __resizeCalls: Array<{ sessionId: string }> }).__resizeCalls.slice());

/** Wait until no terminal resize has reached a PTY for a beat, then forget the ones that did. */
async function settleResizes(page: Page): Promise<void> {
  let previousCount = -1;
  await expect.poll(async () => {
    const count = (await resizeCalls(page)).length;
    const settled = count > 0 && count === previousCount;
    previousCount = count;
    return settled;
  }, { intervals: [500], timeout: 10000 }).toBe(true);
  await page.evaluate(() => {
    (window.electronAPI.sessions as unknown as { __resizeCalls: unknown[] }).__resizeCalls.length = 0;
  });
}

/** How many resizes reached each PTY, once they stop arriving. */
async function settledResizesPerSession(page: Page): Promise<Record<string, number>> {
  let previous = '';
  let counts: Record<string, number> = {};
  await expect.poll(async () => {
    counts = {};
    for (const call of await resizeCalls(page)) counts[call.sessionId] = (counts[call.sessionId] ?? 0) + 1;
    const now = JSON.stringify(counts);
    const settled = now !== '{}' && now === previous;
    previous = now;
    return settled;
  }, { intervals: [500], timeout: 10000 }).toBe(true);
  return counts;
}

/** The gate closed and some frames gone by, long enough for any refit a change would send: none reached a PTY. */
async function expectNoResizes(page: Page): Promise<void> {
  await expect.poll(() => isManagerResizeGateOpen(page), { timeout: 3000 }).toBe(false);
  await page.evaluate(() => new Promise<void>((resolve) => {
    let left = 20;
    const step = () => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }));
  expect(await resizeCalls(page)).toHaveLength(0);
}

const terminalWidths = (page: Page) => page.locator('[data-testid^="window-frame-"]').evaluateAll(
  (frames) => frames.map((frame) => Math.round(frame.getBoundingClientRect().width)));

async function sessionIdsOf(page: Page, slots: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const slot of slots) {
    const pane = page.locator(`[data-command-slot="${slot}"]`).getByTestId('command-bar-terminal-pane');
    await expect(pane).toHaveAttribute('data-session-id', /.+/, { timeout: 5000 });
    ids.push((await pane.getAttribute('data-session-id')) ?? '');
  }
  return ids;
}

async function openTerminals(page: Page, count: number): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
  for (let opened = 2; opened <= count; opened += 1) {
    await page.getByTestId('command-terminal-new').click();
    await expect(page.getByTestId('command-terminal-window')).toHaveCount(opened, { timeout: 5000 });
  }
}

/** A point on the rail's edge handle, inside the rail, where nothing else lies over it. */
async function edgeGrab(page: Page): Promise<{ x: number; y: number }> {
  const edge = await boxOf(page, 'command-terminal-rail-edge');
  expect(edge.width).toBeGreaterThan(0);
  return { x: edge.x + 2, y: edge.y + edge.height / 2 };
}

test.describe('Command Terminal rail', () => {
  test('opens at 300px; an edge drag widens it live and the panel with it, saves once on release, and the terminals keep their size', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      await sessionIdsOf(page, ['slot-1', 'slot-2']);
      await settleResizes(page);
      expectNear(await railWidth(page), 300, 'rail width at open');
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: false });
      const panelBefore = await boxOf(page, 'command-terminal-panel');
      const terminalsBefore = await terminalWidths(page);

      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 60, grab.y, { steps: 6 });

      // Mid-drag the rail has the new width, the panel grew by as much, and nothing refit.
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeGreaterThan(355);
      expectNear((await boxOf(page, 'command-terminal-panel')).width, panelBefore.width + 60, 'panel width mid-drag');
      expect(await resizeCalls(page)).toHaveLength(0);
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: false });

      await page.mouse.up();
      await expect.poll(() => savedRail(page), { timeout: 3000 }).toEqual({ width: 360, collapsed: false });
      expectNear(await railWidth(page), 360, 'rail width after release');
      // The rail is the panel's: the panel took the change, its left edge held, and the terminals kept their size.
      const panelAfter = await boxOf(page, 'command-terminal-panel');
      expectNear(panelAfter.width, panelBefore.width + 60, 'panel width after release');
      expectNear(panelAfter.x, panelBefore.x, 'panel left edge');
      (await terminalWidths(page)).forEach((width, index) => expectNear(width, terminalsBefore[index], `terminal ${index + 1}`));
      await expectNoResizes(page);
    } finally {
      await browser.close();
    }
  });

  test('the edge looks like the seam between terminals: nothing at rest, a thin accent line under the pointer', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      const lineOf = (testId: string) => page.getByTestId(testId).evaluate((element) => {
        const line = element.firstElementChild as HTMLElement;
        return { width: Math.round(line.getBoundingClientRect().width), color: getComputedStyle(line).backgroundColor };
      });
      const railEdge = 'command-terminal-rail-edge';
      expect((await lineOf(railEdge)).color).toBe('rgba(0, 0, 0, 0)');

      // Hovered, each line fades in (`transition-colors`), so the color is read once it has settled.
      const settledLine = async (testId: string) => {
        let previous = '';
        await expect.poll(async () => {
          const current = JSON.stringify(await lineOf(testId));
          const settled = current === previous && !current.includes('rgba(0, 0, 0, 0)');
          previous = current;
          return settled;
        }, { timeout: 3000, intervals: [100] }).toBe(true);
        return lineOf(testId);
      };
      const edge = await boxOf(page, railEdge);
      await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
      const railHovered = await settledLine(railEdge);
      const seamTestId = await page.locator('[data-testid^="tile-splitter-"]').first().getAttribute('data-testid');
      if (!seamTestId) throw new Error('no seam');
      const seam = await boxOf(page, seamTestId);
      await page.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2);
      const seamHovered = await settledLine(seamTestId);
      expect(railHovered).toEqual(seamHovered);
      expect(railHovered.width).toBe(2);
    } finally {
      await browser.close();
    }
  });

  test('the whole edge takes the drag, the half over the terminals too: a terminal focused since never covers it', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      await sessionIdsOf(page, ['slot-1', 'slot-2']);
      // Focusing the terminals raises their windows, whose z-index grows with each focus.
      for (const slot of ['slot-1', 'slot-2', 'slot-1', 'slot-2']) {
        await frameOf(page, slot).locator('.xterm-helper-textarea').focus();
      }
      await frameOf(page, 'slot-1').click({ position: { x: 200, y: 200 } });
      await settleResizes(page);
      // The right half of the edge lies over the first terminal's border: the line itself.
      const edge = await boxOf(page, 'command-terminal-rail-edge');
      const grabX = edge.x + edge.width - 2;
      const grabY = edge.y + edge.height / 2;
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="command-terminal-rail-edge"]') !== null, { x: grabX, y: grabY });
      expect(hit).toBe(true);
      await page.mouse.move(grabX, grabY);
      await page.mouse.down();
      await page.mouse.move(grabX + 60, grabY, { steps: 6 });
      await page.mouse.up();
      await expect.poll(() => savedRail(page), { timeout: 3000 }).toEqual({ width: 360, collapsed: false });
    } finally {
      await browser.close();
    }
  });

  test('in a maximized panel there is no edge to move, so the terminals give the rail its room', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      const sessions = await sessionIdsOf(page, ['slot-1', 'slot-2']);
      await page.getByTestId('command-terminal-panel-maximize').click();
      await settleResizes(page);
      const panelBefore = await boxOf(page, 'command-terminal-panel');
      const terminalsBefore = await terminalWidths(page);

      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 60, grab.y, { steps: 6 });
      await page.mouse.up();

      await expect.poll(() => savedRail(page), { timeout: 3000 }).toEqual({ width: 360, collapsed: false });
      expect(await boxOf(page, 'command-terminal-panel')).toEqual(panelBefore);
      const terminalsAfter = await terminalWidths(page);
      expect(terminalsAfter[0] + terminalsAfter[1]).toBeLessThan(terminalsBefore[0] + terminalsBefore[1] - 50);
      expect(await settledResizesPerSession(page)).toEqual({ [sessions[0]]: 1, [sessions[1]]: 1 });
    } finally {
      await browser.close();
    }
  });

  test('Escape cancels an edge drag: the rail goes back and nothing is saved', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 1);
      await settleResizes(page);
      const panelBefore = await boxOf(page, 'command-terminal-panel');
      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 80, grab.y, { steps: 6 });
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeGreaterThan(375);
      await page.keyboard.press('Escape');
      await page.mouse.up();

      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeLessThan(302);
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: false });
      // The panel went back with it.
      expect(await boxOf(page, 'command-terminal-panel')).toEqual(panelBefore);
      // Escape went to the drag, not to the panel under it.
      await expect(page.getByTestId('command-terminal-panel')).toBeVisible();
      await expect.poll(() => isManagerResizeGateOpen(page), { timeout: 3000 }).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('a drag below 200px holds the rail there down to 100, so a release in between keeps it open at its narrowest', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 1);
      await settleResizes(page);
      const panelBefore = await boxOf(page, 'command-terminal-panel');

      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      // The pointer 150px from the rail's left side: past the minimum, short of the fold line.
      await page.mouse.move(grab.x - 150, grab.y, { steps: 8 });
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeLessThan(202);
      expectNear(await railWidth(page), 200, 'rail held at the minimum');
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'false');

      await page.mouse.up();
      await expect.poll(() => savedRail(page), { timeout: 3000 }).toEqual({ width: 200, collapsed: false });
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'false');
      expectNear(await railWidth(page), 200, 'rail width after release');
      // The panel shrank by what the rail gave up.
      expectNear((await boxOf(page, 'command-terminal-panel')).width, panelBefore.width - 100, 'panel width');
      await expectNoResizes(page);
    } finally {
      await browser.close();
    }
  });

  test('a drag past half the minimum folds the rail while it runs and the panel shrinks to it; back out it opens at 200 and grows the panel; the terminal never refits', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 1);
      await sessionIdsOf(page, ['slot-1']);
      await settleResizes(page);
      const panelOpen = await boxOf(page, 'command-terminal-panel');
      const [terminalBefore] = await terminalWidths(page);

      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      // 220px left: the pointer 80px from the rail's left side, past the fold line at 100.
      await page.mouse.move(grab.x - 220, grab.y, { steps: 10 });
      // Folded while the drag still runs, so the release keeps what the screen shows.
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');
      expectNear(await railWidth(page), 37, 'strip width mid-drag');
      expectNear((await boxOf(page, 'command-terminal-panel')).width, panelOpen.width - (300 - 37), 'panel width mid-fold');
      expect(await resizeCalls(page)).toHaveLength(0);

      // The terminal kept its width through the fold: the strip took its 37px at once.
      expectNear((await terminalWidths(page))[0], terminalBefore, 'terminal width mid-fold');
      await page.mouse.up();
      // Folded, it keeps the width it opens at again.
      await expect.poll(() => savedRail(page), { timeout: 3000 }).toEqual({ width: 300, collapsed: true });
      expectNear((await boxOf(page, 'command-terminal-panel')).width, panelOpen.width - (300 - 37), 'panel width folded');
      expectNear(await railWidth(page), 37, 'strip width after release');
      expectNear((await terminalWidths(page))[0], terminalBefore, 'terminal width folded');
      await expectNoResizes(page);

      // Out of the strip: short of the fold line it stays folded, past it it opens at 200.
      const stripGrab = await edgeGrab(page);
      await page.mouse.move(stripGrab.x, stripGrab.y);
      await page.mouse.down();
      await page.mouse.move(stripGrab.x + 50, stripGrab.y, { steps: 5 });
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');
      await page.mouse.move(stripGrab.x + 90, stripGrab.y, { steps: 5 });
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'false');
      expectNear(await railWidth(page), 200, 'opened at the minimum');
      await page.mouse.up();
      await expect.poll(() => savedRail(page), { timeout: 3000 }).toEqual({ width: 200, collapsed: false });
      expectNear((await boxOf(page, 'command-terminal-panel')).width, panelOpen.width - 100, 'panel width opened at 200');
      expectNear((await terminalWidths(page))[0], terminalBefore, 'terminal width opened');
      await expectNoResizes(page);

      // The button folds it the same way the drag did.
      await page.getByTestId('command-terminal-rail-toggle').click();
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');
      expectNear((await boxOf(page, 'command-terminal-panel')).width, panelOpen.width - (300 - 37), 'panel width folded by the button');
      await expectNoResizes(page);
    } finally {
      await browser.close();
    }
  });

  test('the footer button folds and opens the rail in place: Add terminal and the button keep their spots, and the panel shrinks and grows with it', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      await sessionIdsOf(page, ['slot-1', 'slot-2']);
      await settleResizes(page);
      const panelBefore = await boxOf(page, 'command-terminal-panel');
      const terminalsBefore = await terminalWidths(page);
      const addOpen = await boxOf(page, 'command-terminal-new');
      const toggleOpen = await boxOf(page, 'command-terminal-rail-toggle');
      await expect(page.getByTestId('command-terminal-rail-toggle')).toHaveAccessibleName('Hide rail');
      // Open, the button is the rail's whole bottom row, outlined before the pointer is on it,
      // and carries its word, so it has no tip.
      expect(toggleOpen.width).toBeGreaterThanOrEqual((await railWidth(page)) - 10);
      expect(await page.getByTestId('command-terminal-rail-toggle').evaluate((button) => getComputedStyle(button).borderTopWidth)).toBe('1px');
      await expect(page.getByTestId('command-terminal-rail-toggle')).toHaveText('Hide');
      await expect(page.getByTestId('command-terminal-rail-toggle')).toHaveAccessibleDescription('');

      await page.getByTestId('command-terminal-rail-toggle').click();
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');
      expectNear(await railWidth(page), 37, 'strip width');
      await expect(page.getByTestId('command-terminal-rail-toggle')).toHaveAccessibleName('Show rail');
      // Folded, the strip's icon has no room for the word: the tip names it on hover.
      await expect(page.getByTestId('command-terminal-rail-toggle')).toHaveText('');
      await page.getByTestId('command-terminal-rail-toggle').hover();
      await expect(page.getByRole('tooltip')).toHaveText('Show rail');

      // Add terminal stays on its row, and the button under the pointer stays under it.
      const addFolded = await boxOf(page, 'command-terminal-new');
      expectNear(addFolded.y + addFolded.height / 2, addOpen.y + addOpen.height / 2, 'Add terminal row');
      const toggleFolded = await boxOf(page, 'command-terminal-rail-toggle');
      expectNear(toggleFolded.x, toggleOpen.x, 'toggle x');
      expectNear(toggleFolded.y, toggleOpen.y, 'toggle y');
      // The panel shrank by what the rail gave up, its left edge held; the terminals kept their size.
      const panelFolded = await boxOf(page, 'command-terminal-panel');
      expectNear(panelFolded.width, panelBefore.width - (300 - 37), 'panel width folded');
      expectNear(panelFolded.x, panelBefore.x, 'panel left edge folded');
      (await terminalWidths(page)).forEach((width, index) => expectNear(width, terminalsBefore[index], `terminal ${index + 1} folded`));
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: true });
      await expectNoResizes(page);

      await page.getByTestId('command-terminal-rail-toggle').click();
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'false');
      expectNear(await railWidth(page), 300, 'rail width after opening');
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: false });
      const panelOpened = await boxOf(page, 'command-terminal-panel');
      expectNear(panelOpened.width, panelBefore.width, 'panel width opened');
      expectNear(panelOpened.x, panelBefore.x, 'panel left edge opened');
      (await terminalWidths(page)).forEach((width, index) => expectNear(width, terminalsBefore[index], `terminal ${index + 1} opened`));
      await expectNoResizes(page);

      // From the keyboard, the button keeps focus, so the same key undoes it.
      await page.getByTestId('command-terminal-rail-toggle').focus();
      await page.keyboard.press('Enter');
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');
      await expect(page.getByTestId('command-terminal-rail-toggle')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'false');
      await expect(page.getByTestId('command-terminal-rail-toggle')).toBeFocused();
    } finally {
      await browser.close();
    }
  });

  /** Drag the panel's right edge as far left as it goes: the panel at its minimum. */
  async function shrinkPanelToMinimum(page: Page): Promise<void> {
    const edge = await boxOf(page, 'command-terminal-panel-resize-e');
    const startX = edge.x + edge.width / 2;
    const startY = edge.y + edge.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 2000, startY, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => isManagerResizeGateOpen(page), { timeout: 3000 }).toBe(false);
  }

  const savedPanel = (page: Page) => page.evaluate(async () =>
    ((await window.electronAPI.config.getGlobal()) as unknown as { commandTerminalPanel?: { w: number } | null }).commandTerminalPanel ?? null);

  test('past the room beside the terminals, an edge drag pushes the panel out: the terminals keep their size and refit nothing', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      await sessionIdsOf(page, ['slot-1', 'slot-2']);
      await shrinkPanelToMinimum(page);
      // At the panel's minimum the rail shows narrowed to 200; its own width stays 300.
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeLessThanOrEqual(200 + PIXEL_TOLERANCE);
      await settleResizes(page);
      const panelBefore = await boxOf(page, 'command-terminal-panel');
      const terminalsBefore = [(await frameOf(page, 'slot-1').boundingBox())?.width ?? 0, (await frameOf(page, 'slot-2').boundingBox())?.width ?? 0];
      const savedPanelBefore = await savedPanel(page);

      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 150, grab.y, { steps: 8 });
      // Mid-drag: the rail is 350, the panel 150 wider, the terminals as they were, nothing refit.
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeGreaterThanOrEqual(350 - PIXEL_TOLERANCE);
      expectNear((await boxOf(page, 'command-terminal-panel')).width, panelBefore.width + 150, 'panel width mid-push');
      expectNear((await boxOf(page, 'command-terminal-panel')).x, panelBefore.x, 'panel left edge');
      expect(await isManagerResizeGateOpen(page)).toBe(true);
      // Back toward the start, the panel follows: it shrinks with the rail, never under where it began.
      await page.mouse.move(grab.x + 60, grab.y, { steps: 4 });
      await expect.poll(async () => (await boxOf(page, 'command-terminal-panel')).width, { timeout: 3000 })
        .toBeLessThanOrEqual(panelBefore.width + 60 + PIXEL_TOLERANCE);
      await page.mouse.move(grab.x + 150, grab.y, { steps: 4 });
      await page.mouse.up();

      await expect.poll(() => savedRail(page), { timeout: 3000 }).toEqual({ width: 350, collapsed: false });
      await expect.poll(async () => (await savedPanel(page))?.w ?? 0, { timeout: 3000 }).toBeGreaterThan(savedPanelBefore?.w ?? 0);
      expectNear((await boxOf(page, 'command-terminal-panel')).width, panelBefore.width + 150, 'panel width after release');
      expectNear(await railWidth(page), 350, 'rail width after release');
      expectNear((await frameOf(page, 'slot-1').boundingBox())?.width ?? 0, terminalsBefore[0], 'first terminal');
      expectNear((await frameOf(page, 'slot-2').boundingBox())?.width ?? 0, terminalsBefore[1], 'second terminal');
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
      expect(await resizeCalls(page)).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  test('Escape during a push puts the rail and the panel back where the drag found them', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      await shrinkPanelToMinimum(page);
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeLessThanOrEqual(200 + PIXEL_TOLERANCE);
      const panelBefore = await boxOf(page, 'command-terminal-panel');
      const railBefore = await railWidth(page);

      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 120, grab.y, { steps: 6 });
      await expect.poll(async () => (await boxOf(page, 'command-terminal-panel')).width, { timeout: 3000 })
        .toBeGreaterThan(panelBefore.width + 100);
      await page.keyboard.press('Escape');
      await page.mouse.up();

      await expect.poll(async () => (await boxOf(page, 'command-terminal-panel')).width, { timeout: 3000 })
        .toBeLessThanOrEqual(panelBefore.width + PIXEL_TOLERANCE);
      expectNear(await railWidth(page), railBefore, 'rail width after Escape');
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: false });
    } finally {
      await browser.close();
    }
  });

  test('a panel sized down while the rail is folded still leaves a terminal its 630px floor once the rail opens', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 1);
      await page.getByTestId('command-terminal-rail-toggle').click();
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');

      // Drag the panel's right edge as far left as it goes.
      const edge = await boxOf(page, 'command-terminal-panel-resize-e');
      const startX = edge.x + edge.width / 2;
      const startY = edge.y + edge.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX - 2000, startY, { steps: 10 });
      await page.mouse.up();
      await expect.poll(() => isManagerResizeGateOpen(page), { timeout: 3000 }).toBe(false);

      await page.getByTestId('command-terminal-rail-toggle').click();
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'false');
      await expect.poll(async () => (await boxOf(page, 'command-terminal-area')).width, { timeout: 3000 })
        .toBeGreaterThanOrEqual(630 - PIXEL_TOLERANCE);
      expect(await railWidth(page)).toBeGreaterThanOrEqual(200 - PIXEL_TOLERANCE);
    } finally {
      await browser.close();
    }
  });

  test('folded and tiled, the strip shows every terminal as its activity mark, the focused one marked, and a click focuses that terminal', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      const [first, second] = await sessionIdsOf(page, ['slot-1', 'slot-2']);
      // Each terminal's icon in the open rail's Running list, by its vertical center.
      const iconCenters = (selector: string) => page.locator(selector).evaluateAll((icons) =>
        icons.map((icon) => { const box = icon.getBoundingClientRect(); return box.top + box.height / 2; }));
      const rowCenters = await iconCenters('[data-testid="command-terminal-running-row"] [data-testid="command-terminal-running-stop"] svg');
      expect(rowCenters).toHaveLength(2);
      await page.getByTestId('command-terminal-rail-toggle').click();
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');
      await expect(page.locator('[data-testid^="window-frame-"][data-expanded]')).toHaveCount(0);
      // Folding leaves every terminal's mark at the height its row had.
      const markCenters = await iconCenters('[data-testid="command-terminal-running-chip"] svg');
      markCenters.forEach((center, index) => expectNear(center, rowCenters[index], `mark ${index + 1} height`));

      // The first waits on a question; the second is working.
      await page.evaluate(({ question, working }) => {
        const store = (window as unknown as {
          __zustandStores: { session: { setState: (update: (state: { sessionActivity: Record<string, string> }) => object) => void } };
        }).__zustandStores.session;
        store.setState((state) => ({ sessionActivity: { ...state.sessionActivity, [question]: 'permission', [working]: 'thinking' } }));
      }, { question: first, working: second });

      const marks = page.getByTestId('command-terminal-running-chip');
      await expect(marks).toHaveCount(2);
      expect(await marks.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-command-slot')))).toEqual(['slot-1', 'slot-2']);
      const markOf = (slot: string) => page.locator(`[data-testid="command-terminal-running-chip"][data-command-slot="${slot}"]`);
      await expect(markOf('slot-1').locator('[data-mark]')).toHaveAttribute('data-mark', 'agent-question');
      await expect(markOf('slot-1')).toHaveAccessibleName('Command Terminal 1 (needs you)');
      await expect(markOf('slot-2').locator('[data-mark]')).toHaveAttribute('data-mark', 'agent-working');
      await expect(markOf('slot-2')).toHaveAccessibleName('Command Terminal 2 (working)');
      // Exactly one is in front: the focused tile.
      await expect(page.locator('[data-testid="command-terminal-running-chip"][data-front="true"]')).toHaveCount(1);

      await markOf('slot-1').click();
      await expect(markOf('slot-1')).toHaveAttribute('data-front', 'true');
      await expect(markOf('slot-2')).toHaveAttribute('data-front', 'false');
      // Still tiled, and the keyboard is in that terminal.
      await expect(page.locator('[data-testid^="window-frame-"][data-expanded]')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() =>
        document.activeElement?.closest('[data-command-slot]')?.getAttribute('data-command-slot') ?? null), { timeout: 3000 }).toBe('slot-1');
    } finally {
      await browser.close();
    }
  });

  test('folded with one expanded, every terminal still shows, the expanded one in front: a click expands another, and its Rename opens the header field', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      await sessionIdsOf(page, ['slot-1', 'slot-2']);
      await page.locator('[data-testid="command-terminal-window"][data-command-slot="slot-1"]').getByTestId('command-bar-expand').click();
      await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
      await page.getByTestId('command-terminal-rail-toggle').click();
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');

      const markOf = (slot: string) => page.locator(`[data-testid="command-terminal-running-chip"][data-command-slot="${slot}"]`);
      await expect(page.getByTestId('command-terminal-running-chip')).toHaveCount(2);
      await expect(markOf('slot-1')).toHaveAttribute('data-front', 'true');
      await expect(markOf('slot-2')).toHaveAccessibleName('Command Terminal 2 (resting)');
      await expect(markOf('slot-2').locator('[data-mark]')).toHaveAttribute('data-mark', 'agent-idle');

      await markOf('slot-2').click();
      await expect(frameOf(page, 'slot-2')).toHaveAttribute('data-expanded', 'true');
      await expect(markOf('slot-2')).toHaveAttribute('data-front', 'true');

      // The strip has no room for a name field: Rename brings the terminal up and opens its header's.
      await markOf('slot-1').click({ button: 'right' });
      await expect(page.getByTestId('command-terminal-row-menu')).toBeVisible();
      await page.getByTestId('command-terminal-row-menu-rename').click();
      await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
      const field = page.locator('[data-testid="command-terminal-window"][data-command-slot="slot-1"]').getByTestId('command-bar-name-field');
      await expect(field).toBeFocused();
      // The strip stays folded throughout.
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');
    } finally {
      await browser.close();
    }
  });

  test('a narrow panel shows the rail narrower without rewriting its width, which comes back with room', async () => {
    const { browser, page } = await launch(FLOOR_VIEWPORT);
    try {
      // Saved by another window since this one loaded config: the panel reads it back on open.
      await page.evaluate(() => window.electronAPI.config.set({ commandTerminalRail: { width: 360, collapsed: false } } as never));
      await openTerminals(page, 2);
      await page.keyboard.press('Control+Shift+M');
      await expect(page.getByTestId('command-terminal-panel')).toHaveAttribute('data-maximized', 'true');

      // Two at the 630px floor do not fit a 900px window, so the rail gives way down to its 200px minimum.
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeLessThanOrEqual(200 + PIXEL_TOLERANCE);
      expect(await railWidth(page)).toBeGreaterThanOrEqual(200 - PIXEL_TOLERANCE);
      expect(await savedRail(page)).toEqual({ width: 360, collapsed: false });

      await page.setViewportSize(WIDE_VIEWPORT);
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeGreaterThan(358);
      expectNear(await railWidth(page), 360, 'rail width with room');
      expect(await savedRail(page)).toEqual({ width: 360, collapsed: false });
    } finally {
      await browser.close();
    }
  });

  test('an Earlier name the rail cuts short shows in full on hover, and one shown whole has no tip', async () => {
    const endedAt = new Date().toISOString();
    const longName = 'Investigate the flaky window-edge drag tests on the starved CI runner and the seam settle points';
    const { browser, page } = await launch(WIDE_VIEWPORT, [
      { agentSessionId: 'conversation-long', agentName: 'claude', label: longName, firstPrompt: null, endedAt },
      { agentSessionId: 'conversation-short', agentName: 'claude', label: 'Fix tests', firstPrompt: null, endedAt },
    ]);
    try {
      await openTerminals(page, 1);
      const longRow = page.locator('[data-testid="command-terminal-earlier-row"][data-agent-session-id="conversation-long"]');
      const shortRow = page.locator('[data-testid="command-terminal-earlier-row"][data-agent-session-id="conversation-short"]');
      await expect(longRow).toBeVisible();
      await expect(shortRow).toBeVisible();
      await expect(longRow).toHaveAccessibleDescription(longName);
      await expect(shortRow).toHaveAccessibleDescription('');
    } finally {
      await browser.close();
    }
  });
});
