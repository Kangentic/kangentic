/**
 * UI tests for the SettingsPanel "load only when store is empty" gate.
 *
 * The PR introduced a guard in SettingsPanel's mount effect: agents.list() is
 * only called when the store's agentList is empty. If the store is already
 * populated (from app bootstrap), the panel reuses the cached value and never
 * re-fetches. These tests pin that optimization so a future refactor cannot
 * silently drop the gate and restore the ~1s UI freeze.
 *
 * Tier: UI (headless Chromium). Each test owns its own browser so the store
 * and mock API state are completely isolated between tests.
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/** Launch a fresh headless Chromium page with the electronAPI mock injected. */
async function launchFreshPage(): Promise<{ browser: Browser; page: Page }> {
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

/** Create a project so the board is visible. */
async function createProjectAndWaitForBoard(page: Page, projectSlug: string): Promise<void> {
  await page.evaluate((slug: string) => {
    (window as Record<string, unknown>).__mockFolderPath = `/mock/projects/${slug}`;
  }, projectSlug);

  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');

  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }

  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
}

/** Poll until the config store's agentList is non-empty (bootstrap complete). */
async function waitForBootstrapComplete(page: Page): Promise<void> {
  await expect.poll(
    async () => page.evaluate(() => {
      const configStore = (window as unknown as {
        __zustandStores?: { config?: { getState: () => { agentList: unknown[] } } };
      }).__zustandStores?.config;
      return configStore?.getState().agentList.length ?? 0;
    }),
    { timeout: 10000, intervals: [200, 200, 200, 500] },
  ).toBeGreaterThan(0);
}

/** Instrument window.electronAPI.agents.list to count calls. Resets the counter to 0. */
async function instrumentAgentListCallCount(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Record<string, unknown>).__agentListCallCount = 0;
    const api = window.electronAPI as { agents: { list: (forceRefresh?: boolean) => Promise<unknown> } };
    const original = api.agents.list.bind(api.agents);
    api.agents.list = async function instrumentedList(forceRefresh?: boolean) {
      (window as Record<string, unknown>).__agentListCallCount =
        ((window as Record<string, unknown>).__agentListCallCount as number || 0) + 1;
      return original(forceRefresh);
    };
  });
}

/** Read the call counter installed by instrumentAgentListCallCount. */
async function readAgentListCallCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as Record<string, unknown>).__agentListCallCount as number || 0,
  );
}

/** Open the Settings panel and wait for it to be visible. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
}

/** Close Settings. Clears search input if present, then sends Escape. */
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

test.describe('SettingsPanel - agents.list() load gate', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('does not re-call agents.list() when store already holds agentList', async () => {
    ({ browser, page } = await launchFreshPage());
    await createProjectAndWaitForBoard(page, 'settings-gate-populated');

    // App bootstrap runs agents.list() and populates the store.
    await waitForBootstrapComplete(page);

    // Install the call counter AFTER bootstrap so we only track calls that
    // happen as a result of the Settings panel opening.
    await instrumentAgentListCallCount(page);

    await openSettings(page);

    // Wait for a positive post-mount signal instead of a bare timeout: the
    // Agent tab button only renders once the panel has fully mounted and its
    // mount effect (the gate under test) has run. Navigating to it and reading
    // store state forces the effect's microtask to have flushed.
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.getByText('Claude Code Path')).toBeVisible({ timeout: 3000 });

    // The gate saw a populated store, so the count must remain 0. Poll briefly
    // to give any (incorrect) async call a chance to land before asserting.
    await expect.poll(
      async () => readAgentListCallCount(page),
      { timeout: 1000, intervals: [200, 200, 200] },
    ).toBe(0);

    await closeSettings(page);
  });

  test('calls agents.list() when store is empty on Settings open', async () => {
    ({ browser, page } = await launchFreshPage());
    await createProjectAndWaitForBoard(page, 'settings-gate-empty');

    await waitForBootstrapComplete(page);

    // Clear the agentList so the gate condition triggers on next open.
    await page.evaluate(() => {
      const configStore = (window as unknown as {
        __zustandStores?: {
          config?: { setState: (partial: { agentList: unknown[] }) => void };
        };
      }).__zustandStores?.config;
      configStore?.setState({ agentList: [] });
    });

    // Install the call counter AFTER clearing the store.
    await instrumentAgentListCallCount(page);

    await openSettings(page);

    // Poll until agents.list() has been called at least once, proving the gate
    // correctly detected the empty store and triggered a fetch.
    await expect.poll(
      async () => readAgentListCallCount(page),
      { timeout: 5000, intervals: [200, 200, 500] },
    ).toBeGreaterThanOrEqual(1);

    await closeSettings(page);
  });
});
