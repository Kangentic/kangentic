import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Launch a page with `__mockAgentListOverrides` applied, so the agent grid
 * renders Kimi as `found:true, authenticated:false` (the new amber variant).
 */
async function launchWithKimiOverride(override: Record<string, unknown>): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Grant clipboard permission so navigator.clipboard.writeText resolves
  // instead of throwing NotAllowedError.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.addInitScript((kimiOverride: Record<string, unknown>) => {
    (window as Record<string, unknown>).__mockAgentListOverrides = { kimi: kimiOverride };
  }, override);
  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

test.describe('Agent Auth Warning - Welcome Screen', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('Kimi card shows amber "Not signed in" state when found but unauthenticated', async () => {
    ({ browser, page } = await launchWithKimiOverride({
      found: true,
      path: '/usr/bin/kimi',
      version: '1.37.0',
      authenticated: false,
    }));

    const kimiCard = page.locator('[data-testid="welcome-agent-kimi"]');
    await expect(kimiCard).toBeVisible();
    await expect(kimiCard).toHaveClass(/border-l-amber-500/);
    await expect(kimiCard.getByText('Not signed in')).toBeVisible();

    const copyButton = page.locator('[data-testid="welcome-agent-kimi-copy-login"]');
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toContainText('kimi login');
  });

  test('clicking the Copy button writes "kimi login" to the clipboard and flips to "Copied!"', async () => {
    ({ browser, page } = await launchWithKimiOverride({
      found: true,
      path: '/usr/bin/kimi',
      version: '1.37.0',
      authenticated: false,
    }));

    const copyButton = page.locator('[data-testid="welcome-agent-kimi-copy-login"]');
    await copyButton.click();

    await expect(copyButton).toContainText('Copied!');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('kimi login');
  });

  test('Kimi card stays green (authenticated:true) when login succeeded', async () => {
    ({ browser, page } = await launchWithKimiOverride({
      found: true,
      path: '/usr/bin/kimi',
      version: '1.37.0',
      authenticated: true,
    }));

    const kimiCard = page.locator('[data-testid="welcome-agent-kimi"]');
    await expect(kimiCard).toBeVisible();
    await expect(kimiCard).toHaveClass(/border-l-green-500/);
    await expect(kimiCard).not.toHaveClass(/border-l-amber-500/);
    await expect(kimiCard.getByText('Not signed in')).not.toBeVisible();
  });

  test('Kimi card stays in default green state when authenticated is undefined (other agents)', async () => {
    // No override = default fixture has Kimi found:false. Use a different
    // agent (claude) which is the default-detected agent in the mock.
    ({ browser, page } = await launchWithKimiOverride({
      found: true,
      path: '/usr/bin/kimi',
      version: '1.37.0',
      // authenticated intentionally omitted
    }));

    const kimiCard = page.locator('[data-testid="welcome-agent-kimi"]');
    await expect(kimiCard).toBeVisible();
    // No amber treatment when authenticated is undefined
    await expect(kimiCard).not.toHaveClass(/border-l-amber-500/);
    await expect(kimiCard.getByText('Not signed in')).not.toBeVisible();
  });
});
