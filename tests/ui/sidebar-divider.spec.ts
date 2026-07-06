/**
 * UI tests for the project-sidebar resize divider (useSidebarResize).
 *
 * The divider between the PROJECTS sidebar and the board is a resize handle.
 * A plain click on it must NOT collapse the sidebar (that used to fire
 * accidentally when a click landed on the thin divider). Collapse happens only
 * via the PROJECTS-panel chevron or by dragging the divider closed past the
 * COLLAPSE_THRESHOLD. Sub-threshold movement (a "dead drag") is treated as a
 * click and is a no-op.
 *
 * Assertions read the mock's `sidebarVisible` / `sidebar.width` config (the
 * programmatic source of truth the hook persists) rather than pixel geometry,
 * per .claude/rules/cross-platform-parity.md. Drag input is driven from the
 * divider's live boundingBox.
 *
 * All four tests share one Chromium launch; page.goto() in beforeEach resets the
 * in-memory mock config so each test starts from a known open sidebar (default
 * sidebarVisible: true, sidebar.width: 224).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'divider-proj';
const DEFAULT_SIDEBAR_WIDTH = 224; // matches the mock config default

/** One project with swimlanes, active, so the board and sidebar (with divider) render. */
function oneProjectScript(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Alpha',
        path: '/mock/alpha',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'divider-lane-' + i,
          position: i,
          created_at: ts,
        }));
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/** Read the current global config from the mock. */
async function getConfig(page: Page): Promise<{ sidebarVisible: boolean; sidebar: { width: number } }> {
  return page.evaluate(async () => {
    // Settle any discrete-event React flush + a rAF before reading, so a would-be
    // collapse has definitely landed by the time we assert a no-op.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const cfg = await window.electronAPI.config.getGlobal();
    return cfg as { sidebarVisible: boolean; sidebar: { width: number } };
  });
}

async function resetPage(page: Page): Promise<void> {
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  // Board rendered (sidebar + divider present alongside it).
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="sidebar-resize-handle"]').waitFor({ state: 'attached', timeout: 5000 });
}

/** Center of the divider from its live boundingBox (read immediately before use). */
async function dividerCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-testid="sidebar-resize-handle"]').boundingBox();
  if (!box || box.width === 0) throw new Error('divider has no measurable box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('Sidebar resize divider', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(oneProjectScript());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await resetPage(page);
  });

  test('a plain click on the divider does not collapse the sidebar', async () => {
    // Sanity: sidebar starts open.
    expect((await getConfig(page)).sidebarVisible).toBe(true);

    const center = await dividerCenter(page);
    // A pure click (mousedown + mouseup, zero movement) - the accidental-click case.
    await page.mouse.click(center.x, center.y);

    // Must remain open. (On the old click-to-toggle behavior this flipped to false.)
    const config = await getConfig(page);
    expect(config.sidebarVisible).toBe(true);
  });

  test('a sub-threshold "dead drag" is a no-op (no collapse, no resize)', async () => {
    const before = await getConfig(page);
    expect(before.sidebarVisible).toBe(true);

    const center = await dividerCenter(page);
    // Press, nudge 2px (below the 5px activation distance), release.
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 2, center.y);
    await page.mouse.up();

    // Sidebar stays open and its width is unwritten (a real drag would resize it).
    const after = await getConfig(page);
    expect(after.sidebarVisible).toBe(true);
    expect(after.sidebar.width).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  test('dragging the divider past the collapse threshold still collapses', async () => {
    expect((await getConfig(page)).sidebarVisible).toBe(true);

    const center = await dividerCenter(page);
    // Drag far left so the panel width falls below COLLAPSE_THRESHOLD (200).
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x - 220, center.y, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(async () => (await getConfig(page)).sidebarVisible, { timeout: 5000 })
      .toBe(false);
  });

  test('a normal drag still resizes the sidebar without collapsing', async () => {
    const before = await getConfig(page);
    expect(before.sidebar.width).toBe(DEFAULT_SIDEBAR_WIDTH);

    const center = await dividerCenter(page);
    // Drag right to widen well past the activation distance and above the threshold.
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 80, center.y, { steps: 10 });
    await page.mouse.up();

    const after = await getConfig(page);
    expect(after.sidebarVisible).toBe(true);
    // Width increased (tolerance-based: assert it grew, not an exact pixel value).
    expect(after.sidebar.width).toBeGreaterThan(DEFAULT_SIDEBAR_WIDTH + 30);
  });
});
