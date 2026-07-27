/**
 * UI tests for the Remote Execution fields inside the Agent settings tab
 * (support-remote-opencode follow-up: these fields originally lived on a
 * standalone "Execution" tab, then moved inline next to the CLI Path row so
 * they only ever appear for the currently-selected agent - see
 * `agent-execution-fields.tsx`).
 *
 * Covers:
 *  - A remote-capable agent (OpenCode, per the mock fixture's
 *    `remoteExecution` field) shows an Execution mode picker right in the
 *    Agent tab when it is the project's default agent; Remote reveals
 *    Server URL, auth, and Server Working Directory fields.
 *  - A non-capable agent (e.g. Claude) shows none of these rows at all -
 *    there is no separate "not supported" list anymore, since the Agent tab
 *    only ever displays the one currently-selected agent.
 *  - Test connection calls agents.probeExecutionServer and renders the result.
 *
 * Tier: UI (headless Chromium). Pure React driven by Zustand store state
 * seeded from mock-electron-api.js. No PTY, no real Electron main process.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, dismissOnboardingChecklist } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * Open a project, switch its default agent, and navigate to Settings > Agent.
 * Mirrors `agent-tab-auth-warning.spec.ts`'s `openAgentSettingsTab`.
 */
async function openAgentSettingsTabAs(page: Page, agentId: string): Promise<void> {
  await page.evaluate((agent: string) => {
    (window as Record<string, unknown>).__mockFolderPath = `/mock/projects/${agent}-execution-test`;
  }, agentId);

  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');
  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }
  await dismissOnboardingChecklist(page);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  // Switch the project default agent via the mock API, then resync the
  // renderer's project store so AgentTab's effectiveAgent picks up it.
  await page.evaluate(async (agent: string) => {
    const projects = await window.electronAPI.projects.list();
    if (projects.length === 0) return;
    await window.electronAPI.projects.setDefaultAgent(projects[0].id, agent);
    const projectStore = (window as unknown as {
      __zustandStores?: { project?: { getState: () => { loadCurrent: () => Promise<void> } } };
    }).__zustandStores?.project;
    if (projectStore) await projectStore.getState().loadCurrent();
  }, agentId);

  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

test.describe('AgentTab - Remote Execution fields', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('shows an Execution mode picker for OpenCode, defaulted to Local, with no separate tab', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'opencode');

    // No standalone "Execution" tab exists anymore.
    await expect(page.getByRole('button', { name: 'Execution', exact: true })).toHaveCount(0);

    const modeSelect = page.locator('[data-testid="execution-mode-opencode"]');
    await expect(modeSelect).toBeVisible();
    await expect(modeSelect).toHaveValue('local');

    // Remote-only fields are not rendered while mode is local.
    await expect(page.locator('[data-testid="execution-server-url-opencode"]')).toHaveCount(0);

    await closeSettings(page);
  });

  test('switching to Remote reveals server URL, auth, and working directory fields', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'opencode');

    await page.locator('[data-testid="execution-mode-opencode"]').selectOption('remote');

    await expect(page.locator('[data-testid="execution-server-url-opencode"]')).toBeVisible();
    await expect(page.locator('[data-testid="execution-server-username-opencode"]')).toBeVisible();
    await expect(page.locator('[data-testid="execution-server-password-opencode"]')).toBeVisible();
    await expect(page.locator('[data-testid="execution-working-directory-opencode"]')).toBeVisible();
    await expect(page.locator('[data-testid="execution-server-url-opencode"]')).toHaveAttribute('placeholder', 'http://10.0.0.5:4096');

    await closeSettings(page);
  });

  test('typing a server URL and clicking Test connection shows a reachable result', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'opencode');

    await page.locator('[data-testid="execution-mode-opencode"]').selectOption('remote');
    await page.locator('[data-testid="execution-server-url-opencode"]').fill('http://10.0.0.5:4096');
    await page.locator('[data-testid="execution-test-connection-opencode"]').click();

    await expect(page.locator('text=v1.14.25')).toBeVisible();

    await closeSettings(page);
  });

  test('Test connection surfaces an unreachable reason when the probe fails', async () => {
    ({ browser, page } = await launch());
    await page.evaluate(() => {
      (window as Record<string, unknown>).__mockProbeExecutionServer = () =>
        Promise.resolve({ reachable: false, reason: 'ECONNREFUSED' });
    });
    await openAgentSettingsTabAs(page, 'opencode');

    await page.locator('[data-testid="execution-mode-opencode"]').selectOption('remote');
    await page.locator('[data-testid="execution-server-url-opencode"]').fill('http://10.0.0.5:4096');
    await page.locator('[data-testid="execution-test-connection-opencode"]').click();

    await expect(page.locator('text=Unreachable')).toBeVisible();

    await closeSettings(page);
  });

  test('a credentials failure surfaces a specific reason on hover, distinct from a generic unreachable', async () => {
    ({ browser, page } = await launch());
    await page.evaluate(() => {
      (window as Record<string, unknown>).__mockProbeExecutionServer = () =>
        Promise.resolve({ reachable: false, reason: 'Authentication failed - check the username and password' });
    });
    await openAgentSettingsTabAs(page, 'opencode');

    await page.locator('[data-testid="execution-mode-opencode"]').selectOption('remote');
    await page.locator('[data-testid="execution-server-url-opencode"]').fill('http://10.0.0.5:4096');
    await page.locator('[data-testid="execution-test-connection-opencode"]').click();

    const unreachablePill = page.locator('text=Unreachable');
    await expect(unreachablePill).toBeVisible();
    await expect(unreachablePill).toHaveAttribute('title', 'Authentication failed - check the username and password');

    await closeSettings(page);
  });

  test('required field is unmarked; optional fields carry an "Optional" pill', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'opencode');

    await page.locator('[data-testid="execution-mode-opencode"]').selectOption('remote');

    const serverUrlRow = page.locator('[data-testid="setting-row-agent.executionServerUrl"]');
    await expect(serverUrlRow.getByText('Server URL')).toBeVisible();
    await expect(serverUrlRow.getByText('Optional')).toHaveCount(0);

    const authRow = page.locator('[data-testid="setting-row-agent.executionServerAuth"]');
    await expect(authRow.getByText('Authentication')).toBeVisible();
    await expect(authRow.getByText('Optional')).toBeVisible();

    const directoryRow = page.locator('[data-testid="setting-row-agent.executionWorkingDirectory"]');
    await expect(directoryRow.getByText('Server Working Directory')).toBeVisible();
    await expect(directoryRow.getByText('Optional')).toBeVisible();

    await closeSettings(page);
  });

  test('reverting to Local hides the remote fields again', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'opencode');

    await page.locator('[data-testid="execution-mode-opencode"]').selectOption('remote');
    await expect(page.locator('[data-testid="execution-server-url-opencode"]')).toBeVisible();

    await page.locator('[data-testid="execution-mode-opencode"]').selectOption('local');
    await expect(page.locator('[data-testid="execution-server-url-opencode"]')).toHaveCount(0);

    await closeSettings(page);
  });

  test('remote mode shows the adapter-declared caveat text; local mode shows none', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'opencode');

    // Local mode: no caveat text anywhere (contrast case for the assertion below).
    await expect(
      page.getByText('The server is the authority for providers, models, and MCP tools in remote mode.'),
    ).toHaveCount(0);

    await page.locator('[data-testid="execution-mode-opencode"]').selectOption('remote');

    // Mock fixture's remoteExecution.remoteModeCaveat (mock-electron-api.js) -
    // asserting the mock's string, not the real OpenCodeAdapter's fuller copy,
    // since this UI tier renders against the mock, not the real adapter.
    await expect(
      page.getByText('The server is the authority for providers, models, and MCP tools in remote mode.'),
    ).toBeVisible();

    await closeSettings(page);
  });

  test('a non-capable agent (Claude) shows no execution rows at all', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'claude');

    await expect(page.locator('[data-testid="execution-mode-claude"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="execution-mode-opencode"]')).toHaveCount(0);
    await expect(page.locator('text=No remote execution support')).toHaveCount(0);

    await closeSettings(page);
  });
});
