/**
 * Command Terminal scenes the generic static-demo loops cannot see into. static-demo.spec.ts plays
 * every choreography back to rest and compares cards, layers, form values and focus, but not a
 * tile's width, and it boots the Earlier scene without ever looking at the scenes that must NOT
 * carry its seed. Two things only the built bundle proves:
 *
 *   - the tiled scene's `dblclick` on the seam reaches TileSplitter as a real double-click and
 *     evens the pair its drag unevened (the cut then removes the pair, so the width has to be read
 *     while the cycle runs);
 *   - the `__mockCommandTerminalEarlier` seed is read only by the scene that sets it, so the
 *     Command Terminal figures already placed keep a rail with no Earlier list.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { startDemoServer } from '../../demo/static-server.mjs';
import { SCENES } from '../captures/scenes';

const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist', 'demo');
const READY_TIMEOUT_MS = 20_000;
/** boot.js's pacing divisor, set before any script runs, so a cycle fits the test's timeout. */
const CHOREOGRAPHY_TEST_RATE = 8;
const EARLIER_ROW = '[data-testid="command-terminal-earlier-row"]';
const EARLIER_SEARCH = '[data-testid="command-terminal-earlier-search"]';

// The site frame's size, which the tiled scene's seam room is measured for (see the scene).
test.use({ viewport: { width: 1600, height: 1000 } });

let server: Awaited<ReturnType<typeof startDemoServer>>;

test.beforeAll(async () => {
  server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
});

test.afterAll(async () => {
  if (server) await server.close();
});

async function gotoScene(page: Page, params: Record<string, string>): Promise<void> {
  const url = new URL(server.url);
  url.searchParams.set('stage', '0');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  await page.goto(url.toString());
  await expect(page.locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });
}

interface WidthSample { first: number; second: number }

test('command-terminal-tiled: the seam drag unevens the pair and its double-click evens it again', async ({ page }) => {
  test.setTimeout(90_000);
  // The cut removes both terminals, so the widths are sampled in the page while the FIRST cycle
  // runs (data-demo-cycles still 0). The next cycle reopens an even pair, which would otherwise
  // pass for the evening.
  await page.addInitScript((rate) => {
    (window as unknown as { __demoChoreographyRate: number }).__demoChoreographyRate = rate;
    const samples: Array<{ first: number; second: number }> = [];
    (window as unknown as { __tileWidthSamples: typeof samples }).__tileWidthSamples = samples;
    let folded = false;
    setInterval(() => {
      const cycles = document.documentElement.getAttribute('data-demo-cycles') ?? '0';
      if (cycles !== '0') return;
      // Folding the rail refits the pair to an even split by itself (measured), so the evening the
      // double-click is responsible for must show before the fold, never after it.
      if (document.querySelector('[data-testid="command-terminal-rail"][data-collapsed="true"]')) folded = true;
      if (folded) return;
      const windows = document.querySelectorAll('[data-testid="command-terminal-panel"] [data-testid="command-terminal-window"]');
      if (windows.length !== 2) return;
      samples.push({ first: windows[0].getBoundingClientRect().width, second: windows[1].getBoundingClientRect().width });
    }, 20);
  }, CHOREOGRAPHY_TEST_RATE);
  await gotoScene(page, { view: 'command-terminal-tiled', embed: '1', loop: '1' });
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-demo-cycles', '1', { timeout: 60_000 });
  await expect(root).not.toHaveAttribute('data-demo-choreography', 'stopped');

  const samples = await page.evaluate(() => (window as unknown as { __tileWidthSamples: WidthSample[] }).__tileWidthSamples);
  expect(samples.length, 'the pair was sampled while both terminals were open').toBeGreaterThan(10);
  const gaps = samples.map((sample) => Math.abs(sample.first - sample.second));
  // The drag moves the seam 40px, so the two widths differ by about 80px. 20px is well under that.
  const unevenAt = gaps.findIndex((gap) => gap > 20);
  expect(unevenAt, 'the seam drag left the pair uneven').toBeGreaterThanOrEqual(0);
  // The few pixels of slack are rounding and a scrollbar gutter, far under the drag.
  const evenAfter = gaps.findIndex((gap, index) => index > unevenAt && gap <= 4);
  expect(evenAfter, 'the double-click on the seam evened the pair again').toBeGreaterThan(unevenAt);
});

test.describe('the Earlier conversations seed', () => {
  for (const sceneName of ['command-terminal', 'command-terminal-tiled'] as const) {
    test(`view=${sceneName} as a still has no Earlier list in its rail`, async ({ page }) => {
      await gotoScene(page, { view: sceneName, embed: '1', still: '1' });
      await expect(page.locator(SCENES[sceneName].ready).first()).toBeVisible();
      await expect(page.locator('[data-testid="command-terminal-rail"]')).toBeVisible();
      await expect(page.locator(EARLIER_ROW)).toHaveCount(0);
      await expect(page.locator(EARLIER_SEARCH)).toHaveCount(0);
    });
  }

  test('view=command-terminal-earlier as a still does show it (the selectors above can match)', async ({ page }) => {
    await gotoScene(page, { view: 'command-terminal-earlier', embed: '1', still: '1' });
    await expect(page.locator(SCENES['command-terminal-earlier'].ready).first()).toBeVisible();
    await expect(page.locator(EARLIER_SEARCH)).toHaveCount(1);
    expect(await page.locator(EARLIER_ROW).count()).toBeGreaterThan(0);
  });
});
