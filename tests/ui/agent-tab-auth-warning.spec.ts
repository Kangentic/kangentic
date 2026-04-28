/**
 * UI tests for the authentication warning in AgentTab.
 *
 * Covers both Kimi and OpenCode, since both expose `authenticated` via
 * probeAuth() and have a `loginCommand` in agent-display-name.ts.
 *
 * Per-agent describe blocks:
 *   - AgentTab - Kimi auth warning
 *   - AgentTab - OpenCode auth warning
 *
 * Each block covers:
 *   - Amber pill + inline hint when agent.found && agent.authenticated === false
 *     AND the agent is the effectiveAgent (selected in the agent dropdown).
 *   - Copy button writes the correct command to clipboard and shows "Copied!" feedback.
 *   - "Copied!" reverts to "Copy" after the 2-second timeout (Kimi only - tests
 *     the shared timer code path once; OpenCode does not duplicate it).
 *   - No amber treatment when authenticated === true.
 *   - No amber treatment when authenticated is undefined (no auth probe ran).
 *
 * Tier: UI (headless Chromium). The AgentTab is pure React driven by Zustand
 * store state seeded from mock-electron-api.js. No PTY, no real Electron main
 * process, no E2E launch needed.
 *
 * The test fixture uses __mockAgentListOverrides to inject the desired
 * authenticated state into the agents.list() mock, mirrors the pattern from
 * tests/ui/agent-auth-warning.spec.ts (welcome-screen flow).
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Launch a page with the given agent as the project's default agent and with a
 * specific `authenticated` value injected for that agent's entry in agents.list().
 *
 * The __mockAgentListOverrides is set BEFORE addInitScript({path}) so it is
 * visible to the mock's agents.list() function at runtime.
 */
async function launchWithAgentAsDefault(
  agentId: string,
  agentPath: string,
  agentVersion: string,
  authenticatedOverride: boolean | null | undefined,
  grantClipboard = false,
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  if (grantClipboard) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }

  const page = await context.newPage();

  // 1. Set the per-agent override for the detected state.
  await page.addInitScript((args: { agentId: string; agentPath: string; agentVersion: string; authenticatedOverride: boolean | null | undefined }) => {
    const override: Record<string, unknown> = {
      found: true,
      path: args.agentPath,
      version: args.agentVersion,
    };
    // Only set authenticated if a value was provided (undefined = omit the key).
    if (args.authenticatedOverride !== undefined) {
      override.authenticated = args.authenticatedOverride;
    }
    (window as Record<string, unknown>).__mockAgentListOverrides = { [args.agentId]: override };
  }, { agentId, agentPath, agentVersion, authenticatedOverride });

  // 2. Set the agent as the default for the auto-created project via a
  //    pre-init script that patches the mock's project-selection callback.
  await page.addInitScript((agentName: string) => {
    (window as Record<string, unknown>).__mockDefaultAgentOverride = agentName;
  }, agentId);

  // 3. Inject the full mock (reads both overrides above).
  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * Open a project and navigate to Settings > Agent tab, ensuring the given
 * agent is selected as the default agent for the project.
 */
async function openAgentSettingsTab(page: Page, agentId: string): Promise<void> {
  // Create a project (triggers board render).
  await page.evaluate((agent: string) => {
    (window as Record<string, unknown>).__mockFolderPath = `/mock/projects/${agent}-auth-test`;
  }, agentId);

  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');

  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }

  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  // Switch the project default agent via the mock API so the AgentTab
  // renders with effectiveAgent = agentId.
  await page.evaluate(async (agent: string) => {
    const projects = await window.electronAPI.projects.list();
    if (projects.length === 0) return;
    await window.electronAPI.projects.setDefaultAgent(projects[0].id, agent);
  }, agentId);

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
// Kimi test suite
// ---------------------------------------------------------------------------

test.describe('AgentTab - Kimi auth warning', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('amber pill and inline hint appear when kimi is selected and authenticated is false', async () => {
    ({ browser, page } = await launchWithAgentAsDefault('kimi', '/usr/bin/kimi', '1.37.0', false));
    await openAgentSettingsTab(page, 'kimi');

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
    ({ browser, page } = await launchWithAgentAsDefault('kimi', '/usr/bin/kimi', '1.37.0', false, true));
    await openAgentSettingsTab(page, 'kimi');

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
    ({ browser, page } = await launchWithAgentAsDefault('kimi', '/usr/bin/kimi', '1.37.0', false, true));
    await openAgentSettingsTab(page, 'kimi');

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
    ({ browser, page } = await launchWithAgentAsDefault('kimi', '/usr/bin/kimi', '1.37.0', true));
    await openAgentSettingsTab(page, 'kimi');

    // The "Not signed in" pill must NOT appear.
    await expect(page.locator('text=Not signed in')).not.toBeVisible();

    // The inline hint and Copy button must NOT appear.
    await expect(page.locator('[data-testid="agent-tab-copy-login-kimi"]')).not.toBeVisible();

    await closeSettings(page);
  });

  test('no amber treatment when authenticated is undefined (probeAuth not called)', async () => {
    // undefined means probeAuth was not called (agent found but adapter has no probeAuth).
    ({ browser, page } = await launchWithAgentAsDefault('kimi', '/usr/bin/kimi', '1.37.0', undefined));
    await openAgentSettingsTab(page, 'kimi');

    await expect(page.locator('text=Not signed in')).not.toBeVisible();
    await expect(page.locator('[data-testid="agent-tab-copy-login-kimi"]')).not.toBeVisible();

    await closeSettings(page);
  });
});

// ---------------------------------------------------------------------------
// OpenCode test suite
// ---------------------------------------------------------------------------

test.describe('AgentTab - OpenCode auth warning', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('amber pill and inline hint appear when opencode is selected and authenticated is false', async () => {
    ({ browser, page } = await launchWithAgentAsDefault('opencode', '/usr/bin/opencode', '1.14.25', false));
    await openAgentSettingsTab(page, 'opencode');

    // The amber "Not signed in" pill should be in the trailing slot of the OpenCode Path row.
    const notSignedInPill = page.locator('text=Not signed in');
    await expect(notSignedInPill).toBeVisible();

    // The inline hint with the login command should appear below the path input.
    const inlineHint = page.locator('text=opencode auth login');
    await expect(inlineHint).toBeVisible();

    // The Copy button must also be visible.
    const copyButton = page.locator('[data-testid="agent-tab-copy-login-opencode"]');
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toContainText('Copy');

    await closeSettings(page);
  });

  test('Copy button writes "opencode auth login" to clipboard and shows "Copied!" feedback', async () => {
    ({ browser, page } = await launchWithAgentAsDefault('opencode', '/usr/bin/opencode', '1.14.25', false, true));
    await openAgentSettingsTab(page, 'opencode');

    const copyButton = page.locator('[data-testid="agent-tab-copy-login-opencode"]');
    await expect(copyButton).toBeVisible();

    await copyButton.click();

    // Feedback text flips to "Copied!".
    await expect(copyButton).toContainText('Copied!');

    // Clipboard actually received the command.
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('opencode auth login');

    await closeSettings(page);
  });

  test('no amber treatment when authenticated is true (provider configured)', async () => {
    ({ browser, page } = await launchWithAgentAsDefault('opencode', '/usr/bin/opencode', '1.14.25', true));
    await openAgentSettingsTab(page, 'opencode');

    await expect(page.locator('text=Not signed in')).not.toBeVisible();
    await expect(page.locator('[data-testid="agent-tab-copy-login-opencode"]')).not.toBeVisible();

    await closeSettings(page);
  });
});
