import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Launch a page with `__mockAgentListOverrides` applied, so the agent grid
 * renders the named agent with the given fields (e.g. `found:true,
 * authenticated:false` for the amber "Not signed in" variant).
 */
async function launchWithAgentOverride(agentId: string, override: Record<string, unknown>): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Grant clipboard permission so navigator.clipboard.writeText resolves
  // instead of throwing NotAllowedError.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.addInitScript((args: { agentId: string; override: Record<string, unknown> }) => {
    (window as Record<string, unknown>).__mockAgentListOverrides = { [args.agentId]: args.override };
  }, { agentId, override });
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
    ({ browser, page } = await launchWithAgentOverride('kimi', {
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
    ({ browser, page } = await launchWithAgentOverride('kimi', {
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
    ({ browser, page } = await launchWithAgentOverride('kimi', {
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
    ({ browser, page } = await launchWithAgentOverride('kimi', {
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

test.describe('Agent Auth Warning - OpenCode Welcome Screen', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('OpenCode card shows amber "Not signed in" state when found but unauthenticated', async () => {
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      authenticated: false,
    }));

    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    await expect(opencodeCard).toBeVisible();
    await expect(opencodeCard).toHaveClass(/border-l-amber-500/);
    await expect(opencodeCard.getByText('Not signed in')).toBeVisible();

    const copyButton = page.locator('[data-testid="welcome-agent-opencode-copy-login"]');
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toContainText('opencode auth login');
  });

  test('clicking the Copy button writes "opencode auth login" to the clipboard and flips to "Copied!"', async () => {
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      authenticated: false,
    }));

    const copyButton = page.locator('[data-testid="welcome-agent-opencode-copy-login"]');
    await copyButton.click();

    await expect(copyButton).toContainText('Copied!');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('opencode auth login');
  });

  test('OpenCode card stays green when authenticated:true (provider configured)', async () => {
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      authenticated: true,
    }));

    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    await expect(opencodeCard).toBeVisible();
    await expect(opencodeCard).toHaveClass(/border-l-green-500/);
    await expect(opencodeCard).not.toHaveClass(/border-l-amber-500/);
    await expect(opencodeCard.getByText('Not signed in')).not.toBeVisible();
  });

  test('OpenCode card stays in default state when authenticated is null (probe failed)', async () => {
    // null = probeAuth ran but returned null (e.g. EACCES, malformed JSON, missing file).
    // The renderer treats null identically to undefined: no amber warning.
    // This pins the silent-fail intent so a future change that accidentally
    // treats null as unauthenticated will trip this test.
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      authenticated: null,
    }));

    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    await expect(opencodeCard).toBeVisible();
    await expect(opencodeCard).not.toHaveClass(/border-l-amber-500/);
    await expect(opencodeCard.getByText('Not signed in')).not.toBeVisible();
  });

  test('OpenCode card stays in default state when authenticated is undefined (no probe ran)', async () => {
    // No authenticated field at all = the adapter has no probeAuth or did not
    // set the field. Renderer must not show the amber warning.
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      // authenticated intentionally omitted
    }));

    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    await expect(opencodeCard).toBeVisible();
    await expect(opencodeCard).not.toHaveClass(/border-l-amber-500/);
    await expect(opencodeCard.getByText('Not signed in')).not.toBeVisible();
  });
});
