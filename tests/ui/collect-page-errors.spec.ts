/**
 * Pins what collectPageErrors (tests/ui/helpers.ts) collects from the console.
 *
 * It gained a console listener so the monaco funnel's "[MONACO] ... reported as
 * handled" line (Sentry DESKTOP-19, no longer a pageerror) still trips every
 * spec that asserts an empty result. The other half matters as much: about
 * twenty specs assert that list is empty while the app legitimately logs
 * console.error for handled failures, so a listener that collected every
 * console error, or a non-error level, would turn all of them red at once.
 *
 * No app and no Vite page: the collector only needs a Page, so these run on a
 * blank page and emit the console lines directly.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { collectPageErrors } from './helpers';
import { MONACO_HANDLED_ERROR_LOG_TAG } from '../../src/renderer/monaco-error-funnel';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  await browser?.close();
});

test.beforeEach(async () => {
  page = await browser.newPage();
  await page.goto('about:blank');
});

test.afterEach(async () => {
  await page.close();
});

/** Log the lines, then round-trip the page so every console event has been delivered. */
async function logConsoleLines(lines: Array<{ level: 'error' | 'warn' | 'log' | 'info'; text: string }>): Promise<void> {
  await page.evaluate((entries) => {
    for (const entry of entries) console[entry.level](entry.text);
  }, lines);
  // Console events are delivered in order ahead of the evaluate result, so
  // this second round trip is a barrier, not a timing guess.
  await page.evaluate(() => undefined);
}

test.describe('collectPageErrors console handling', () => {
  test('collects the monaco funnel console.error line', async () => {
    const getPageErrors = collectPageErrors(page);

    await logConsoleLines([{ level: 'error', text: `${MONACO_HANDLED_ERROR_LOG_TAG} Illegal value for lineNumber, reported as handled` }]);

    await expect.poll(() => getPageErrors()).toEqual([
      `${MONACO_HANDLED_ERROR_LOG_TAG} Illegal value for lineNumber, reported as handled`,
    ]);
  });

  test('ignores console errors that are not the monaco funnel line', async () => {
    const getPageErrors = collectPageErrors(page);

    // The marker mid-string is not the funnel: the line must START with it.
    await logConsoleLines([
      { level: 'error', text: '[ANALYTICS] Failed to initialize renderer error reporting: boom' },
      { level: 'error', text: `unrelated ${MONACO_HANDLED_ERROR_LOG_TAG} mention` },
      { level: 'error', text: `${MONACO_HANDLED_ERROR_LOG_TAG} sentinel to prove the listener ran` },
    ]);

    await expect.poll(() => getPageErrors()).toEqual([
      `${MONACO_HANDLED_ERROR_LOG_TAG} sentinel to prove the listener ran`,
    ]);
  });

  test('ignores the monaco tag at a non-error console level', async () => {
    const getPageErrors = collectPageErrors(page);

    await logConsoleLines([
      { level: 'warn', text: `${MONACO_HANDLED_ERROR_LOG_TAG} warn level` },
      { level: 'log', text: `${MONACO_HANDLED_ERROR_LOG_TAG} log level` },
      { level: 'info', text: `${MONACO_HANDLED_ERROR_LOG_TAG} info level` },
      { level: 'error', text: `${MONACO_HANDLED_ERROR_LOG_TAG} sentinel to prove the listener ran` },
    ]);

    await expect.poll(() => getPageErrors()).toEqual([
      `${MONACO_HANDLED_ERROR_LOG_TAG} sentinel to prove the listener ran`,
    ]);
  });
});
