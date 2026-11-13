/**
 * The frame's pinned clock (demo/boot.js, pinClock).
 *
 * kangentic.com shows a poster until the frame lifts it, and the poster's printed times must be the
 * ones the live frame prints in every visitor's zone and locale (kangentic.com #137). A CI runner
 * in UTC and en-US would pass with the pin removed, so this context is deliberately far from both:
 * Pacific/Auckland and de-DE. Every assertion below differs under that context without the pin.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { startDemoServer } from '../../demo/static-server.mjs';

const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist', 'demo');
const READY_TIMEOUT_MS = 20_000;
/** boot.js DEMO_CLOCK_START: Date.UTC(2026, 10, 9, 12, 0, 0). */
const DEMO_CLOCK_START = Date.UTC(2026, 10, 9, 12, 0, 0);
/** How far past the opening instant the page may be when it is read: boot plus a slow runner. */
const MAX_DRIFT_MS = 5 * 60_000;

type DemoServer = Awaited<ReturnType<typeof startDemoServer>>;
let server: DemoServer;

test.use({
  viewport: { width: 1600, height: 1000 },
  timezoneId: 'Pacific/Auckland',
  locale: 'de-DE',
});

test.beforeAll(async () => {
  server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
});

test.afterAll(async () => {
  if (server) await server.close();
});

test('the frame keeps its own clock, zone and locale whatever the visitor runs', async ({ page }) => {
  const url = new URL(server.url);
  url.searchParams.set('stage', '0');
  url.searchParams.set('view', 'board');
  url.searchParams.set('embed', '1');
  url.searchParams.set('still', '1');
  await page.goto(url.toString());
  await expect(page.locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });

  const read = await page.evaluate((openingInstant) => {
    const now = new Date();
    const noon = new Date(Date.UTC(2026, 10, 9, 12, 0, 0));
    return {
      driftMs: now.getTime() - openingInstant,
      year: now.getUTCFullYear(),
      month: now.getUTCMonth(),
      localHours: now.getHours(),
      utcHours: now.getUTCHours(),
      localDate: now.getDate(),
      utcDate: now.getUTCDate(),
      offset: now.getTimezoneOffset(),
      dateNowDriftMs: Date.now() - openingInstant,
      noonTime: noon.toLocaleTimeString(),
      noonDate: noon.toLocaleDateString(),
      number: (1234.5).toLocaleString(),
      formattedNumber: new Intl.NumberFormat().format(1234.5),
      zone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: new Intl.DateTimeFormat().resolvedOptions().locale,
      explicit: noon.toLocaleString('de-DE', { timeZone: 'Asia/Tokyo' }),
      explicitNumber: (1234.5).toLocaleString('de-DE'),
    };
  }, DEMO_CLOCK_START);

  // The page opened at the fixed instant and runs from there at real speed.
  expect(read.year).toBe(2026);
  expect(read.month).toBe(10);
  expect(read.driftMs).toBeGreaterThanOrEqual(0);
  expect(read.driftMs).toBeLessThan(MAX_DRIFT_MS);
  expect(read.dateNowDriftMs).toBeGreaterThanOrEqual(0);
  expect(read.dateNowDriftMs).toBeLessThan(MAX_DRIFT_MS);

  // Local time is UTC: the getters, and the zone offset.
  expect(read.localHours).toBe(read.utcHours);
  expect(read.localDate).toBe(read.utcDate);
  expect(read.offset).toBe(0);

  // Defaults are UTC and en-US.
  expect(read.noonTime).toBe('12:00:00 PM');
  expect(read.noonDate).toBe('11/9/2026');
  expect(read.number).toBe('1,234.5');
  expect(read.formattedNumber).toBe('1,234.5');
  expect(read.zone).toBe('UTC');
  expect(read.locale).toBe('en-US');

  // A caller's own locale or zone is honored: noon UTC is 21:00 in Tokyo, written the German way.
  expect(read.explicit).toContain('21:00');
  expect(read.explicit).toContain('9.11.2026');
  expect(read.explicitNumber).toBe('1.234,5');
});
