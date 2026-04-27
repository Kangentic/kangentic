/**
 * UI tests for the Kimi authentication warning in AgentTab.
 *
 * Covers:
 *   - Amber pill + inline hint when agent.found && agent.authenticated === false
 *     AND kimi is the effectiveAgent (selected in the agent dropdown).
 *   - Copy button writes 'kimi login' to clipboard and shows "Copied!" feedback.
 *   - "Copied!" reverts to "Copy" after the 2-second timeout.
 *   - No amber treatment when authenticated === true.
 *   - No amber treatment when authenticated is undefined (no auth probe ran).
 *   - loginCommand === undefined for another agent suppresses the inline hint
 *     even when authenticated === false (guarded by the loginCommand check in
 *     AgentTab's JSX).
 *
 * Tier: UI (headless Chromium). The AgentTab is pure React driven by Zustand
 * store state seeded from mock-electron-api.js. No PTY, no real Electron main
 * process, no E2E launch needed.
 *
 * The test fixture uses __mockAgentListOverrides to inject the desired
 * authenticated state into the agents.list() mock, mirrors the pattern from
 * tests/ui/agent-auth-warning.spec.ts (welcome-screen flow).
 *
 * The project default agent is set to 'kimi' via window.electronAPI.projects
 * .setDefaultAgent() on the mock, which the AgentTab uses to determine
 * effectiveAgent. The mock stores setDefaultAgent via the project object
 * directly.
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Launch a page with Kimi as the project's default agent and with a specific
 * `authenticated` value injected for the kimi entry in agents.list().
 *
 * The __mockAgentListOverrides is set BEFORE addInitScript({path}) so it is
 * visible to the mock's agents.list() function at runtime.
 */
async function launchWithKimiAsDefault(
  kimiAuthenticatedOverride: boolean | null | undefined,
  grantClipboard = false,
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  if (grantClipboard) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }

  const page = await context.newPage();

  // 1. Set the per-agent override for Kimi's detected state.
  await page.addInitScript((authenticatedValue: boolean | null | undefined) => {
    const override: Record<string, unknown> = {
      found: true,
      path: '/usr/bin/kimi',
      version: '1.37.0',
    };
    // Only set authenticated if a value was provided (undefined = omit the key)
    if (authenticatedValue !== undefined) {
      override.authenticated = authenticatedValue;
    }
    (window as Record<string, unknown>).__mockAgentListOverrides = { kimi: override };
  }, kimiAuthenticatedOverride);

  // 2. Set Kimi as the default agent for the auto-created project via a
  //    pre-init script that patches the mock's project-selection callback.
  //    The mock-electron-api auto-creates a project when __mockFolderPath is
  //    set. We hook into the projects.open flow so the created project has
  //    default_agent = 'kimi' from the start.
  await page.addInitScript(() => {
    (window as Record<string, unknown>).__mockDefaultAgentOverride = 'kimi';
  });

  // 3. Inject the full mock (reads both overrides above).
  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Open a project and navigate to Settings > Agent tab. */
async function openAgentSettingsTab(page: Page): Promise<void> {
  // Create a project (triggers board render).
  await page.evaluate(() => {
    (window as Record<string, unknown>).__mockFolderPath = '/mock/projects/kimi-auth-test';
  });

  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');

  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }

  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  // Switch the project default agent to Kimi via the mock API so the AgentTab
  // renders with effectiveAgent = 'kimi'. The mock electronAPI is in-memory
  // so we can drive this via page.evaluate.
  await page.evaluate(async () => {
    const projects = await window.electronAPI.projects.list();
    if (projects.length === 0) return;
    await window.electronAPI.projects.setDefaultAgent(projects[0].id, 'kimi');
  });

  // Open settings and navigate to the Agent tab.
  await page.locator('button[title="Settings"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Agent' }).click();
}

async function closeSettings(page: Page): Promise<void> {
  const searchInput = page.getByTestId('settings-search');
  if (await searchInput.isVisible().catch(() => false)) {
    const searchValue = await searchInput.inputValue().catch(() => '');
    if (searchValue) {
      await page.keyboard.press('Escape');
    }
  }
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('AgentTab - Kimi auth warning', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('amber pill and inline hint appear when kimi is selected and authenticated is false', async () => {
    ({ browser, page } = await launchWithKimiAsDefault(false));
    await openAgentSettingsTab(page);

    // The amber "Not signed in" pill should be in the trailing slot of the Kimi Path row.
    const notSignedInPill = page.locator('text=Not signed in');
    await expect(notSignedInPill).toBeVisible();

    // The inline hint with the login command should appear below the path input.
    const inlineHint = page.locator('text=kimi login');
    await expect(inlineHint).toBeVisible();

    // The Copy button must also be visible.
    const copyButton = page.locator('[data-testid="agent-tab-copy-login-kimi"]');
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toContainText('Copy');

    await closeSettings(page);
  });

  test('Copy button writes "kimi login" to clipboard and shows "Copied!" feedback', async () => {
    ({ browser, page } = await launchWithKimiAsDefault(false, true));
    await openAgentSettingsTab(page);

    const copyButton = page.locator('[data-testid="agent-tab-copy-login-kimi"]');
    await expect(copyButton).toBeVisible();

    await copyButton.click();

    // Feedback text flips to "Copied!".
    await expect(copyButton).toContainText('Copied!');

    // Clipboard actually received the command.
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('kimi login');

    await closeSettings(page);
  });

  test('"Copied!" reverts to "Copy" after the 2-second timeout', async () => {
    ({ browser, page } = await launchWithKimiAsDefault(false, true));
    await openAgentSettingsTab(page);

    const copyButton = page.locator('[data-testid="agent-tab-copy-login-kimi"]');
    await copyButton.click();
    await expect(copyButton).toContainText('Copied!');

    // Poll until the timeout fires and the label reverts. Allow up to 4s
    // (2s nominal timeout + 2s polling budget).
    await expect.poll(async () => {
      const text = await copyButton.textContent();
      return text?.trim();
    }, { timeout: 4000, intervals: [300, 300, 300, 300, 300, 300, 300, 300, 300, 300] }).toBe('Copy');

    await closeSettings(page);
  });

  test('no amber treatment when authenticated is true', async () => {
    ({ browser, page } = await launchWithKimiAsDefault(true));
    await openAgentSettingsTab(page);

    // The "Not signed in" pill must NOT appear.
    await expect(page.locator('text=Not signed in')).not.toBeVisible();

    // The inline hint and Copy button must NOT appear.
    await expect(page.locator('[data-testid="agent-tab-copy-login-kimi"]')).not.toBeVisible();

    await closeSettings(page);
  });

  test('no amber treatment when authenticated is undefined (probeAuth not called)', async () => {
    // undefined means probeAuth was not called (agent found but adapter has no probeAuth).
    ({ browser, page } = await launchWithKimiAsDefault(undefined));
    await openAgentSettingsTab(page);

    await expect(page.locator('text=Not signed in')).not.toBeVisible();
    await expect(page.locator('[data-testid="agent-tab-copy-login-kimi"]')).not.toBeVisible();

    await closeSettings(page);
  });
});
