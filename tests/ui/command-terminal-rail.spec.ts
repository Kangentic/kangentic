/**
 * UI tests for the Command Terminal rail's width and fold (#684).
 *
 * The rail opens at 300px and its edge drags it from 200 to 400. Below 200 it
 * holds there down to 100 and folds to a 37px strip past that, while the drag
 * runs. Its bottom row folds and opens it from the same spot. Width and fold are one global setting
 * (`AppConfig.commandTerminalRail`). A narrow panel shows the rail narrower
 * without rewriting that setting. None of it moves or resizes the panel itself:
 * only the terminals' share of it changes, and each terminal refits once.
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
  test('opens at 300px; an edge drag widens it live, saves once on release, and refits each terminal once', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      const sessions = await sessionIdsOf(page, ['slot-1', 'slot-2']);
      await settleResizes(page);
      expectNear(await railWidth(page), 300, 'rail width at open');
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: false });
      const panelBefore = await boxOf(page, 'command-terminal-panel');

      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 60, grab.y, { steps: 6 });

      // Mid-drag the rail has the new width and the gate holds every refit.
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeGreaterThan(355);
      expect(await isManagerResizeGateOpen(page)).toBe(true);
      expect(await resizeCalls(page)).toHaveLength(0);
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: false });

      await page.mouse.up();
      await expect.poll(() => savedRail(page), { timeout: 3000 }).toEqual({ width: 360, collapsed: false });
      expectNear(await railWidth(page), 360, 'rail width after release');
      const counts = await settledResizesPerSession(page);
      expect(counts).toEqual({ [sessions[0]]: 1, [sessions[1]]: 1 });
      // The panel itself never moved: only the terminals' share of it changed.
      expect(await boxOf(page, 'command-terminal-panel')).toEqual(panelBefore);
    } finally {
      await browser.close();
    }
  });

  test('Escape cancels an edge drag: the rail goes back and nothing is saved', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 1);
      await settleResizes(page);
      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 80, grab.y, { steps: 6 });
      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeGreaterThan(375);
      await page.keyboard.press('Escape');
      await page.mouse.up();

      await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeLessThan(302);
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: false });
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
    } finally {
      await browser.close();
    }
  });

  test('a drag past half the minimum folds the rail while it runs, keeps its width, refits once; back out it opens at 200', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 1);
      const [sessionId] = await sessionIdsOf(page, ['slot-1']);
      await settleResizes(page);

      const grab = await edgeGrab(page);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      // 220px left: the pointer 80px from the rail's left side, past the fold line at 100.
      await page.mouse.move(grab.x - 220, grab.y, { steps: 10 });
      // Folded while the drag still runs, so the release keeps what the screen shows.
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');
      expectNear(await railWidth(page), 37, 'strip width mid-drag');
      expect(await resizeCalls(page)).toHaveLength(0);
      // The terminal's tile follows the strip under the drag, before the release.
      await expect.poll(async () => {
        const area = await boxOf(page, 'command-terminal-area');
        const frame = await page.locator('[data-testid^="window-frame-"]').first().boundingBox();
        return Math.abs((frame?.width ?? 0) - area.width) <= PIXEL_TOLERANCE;
      }, { timeout: 3000 }).toBe(true);

      await page.mouse.up();
      // Folded, it keeps the width it opens at again.
      await expect.poll(() => savedRail(page), { timeout: 3000 }).toEqual({ width: 300, collapsed: true });
      // The fold landed during the drag, so the terminal refits once, at the strip's layout.
      expect(await settledResizesPerSession(page)).toEqual({ [sessionId]: 1 });
      const foldedGrid = (await resizeCalls(page)).at(-1);
      await settleResizes(page);

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
      await settleResizes(page);

      // The button folds to the same grid the drag did.
      await page.getByTestId('command-terminal-rail-toggle').click();
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'true');
      expect(await settledResizesPerSession(page)).toEqual({ [sessionId]: 1 });
      expect((await resizeCalls(page)).at(-1)).toEqual(foldedGrid);
    } finally {
      await browser.close();
    }
  });

  test('the footer button folds and opens the rail in place: Add terminal and the button keep their spots, and the panel keeps its box', async () => {
    const { browser, page } = await launch(WIDE_VIEWPORT);
    try {
      await openTerminals(page, 2);
      const sessions = await sessionIdsOf(page, ['slot-1', 'slot-2']);
      await settleResizes(page);
      const panelBefore = await boxOf(page, 'command-terminal-panel');
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
      expect(await boxOf(page, 'command-terminal-panel')).toEqual(panelBefore);
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: true });
      expect(await settledResizesPerSession(page)).toEqual({ [sessions[0]]: 1, [sessions[1]]: 1 });

      await page.getByTestId('command-terminal-rail-toggle').click();
      await expect(railOf(page)).toHaveAttribute('data-collapsed', 'false');
      expectNear(await railWidth(page), 300, 'rail width after opening');
      expect(await savedRail(page)).toEqual({ width: 300, collapsed: false });
      expect(await boxOf(page, 'command-terminal-panel')).toEqual(panelBefore);

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
