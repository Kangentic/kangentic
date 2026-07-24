/**
 * UI tests for the AgentTab re-detect button wiring.
 *
 * The PR wired a `forceRefresh=true` argument through 7 IPC layers so the
 * re-detect button in AgentTab triggers a fresh capability probe rather than
 * returning the cached result. These tests pin that wiring.
 *
 * Test A: clicking the RefreshCw button in AgentTab calls agents.list(true).
 * Test B: a normal Settings open (with an empty store) calls agents.list()
 *         without forceRefresh=true, i.e. with a falsy argument.
 *
 * Tier: UI (headless Chromium). Each test owns its own browser.
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

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

/**
 * Instrument agents.list to record each call. The recorded state is an object
 * with `callCount` and `lastForceRefreshArg` (the raw first argument, which may
 * be `true`, `false`, or `undefined`). The `wasCalledWithTrue` flag is set to
 * `true` when forceRefresh=true was passed at least once; it is never reset to
 * false, so the poll-until-true pattern works correctly.
 *
 * Call AFTER any bootstrap-settle work to avoid contaminating the recorded state.
 */
async function instrumentAgentListCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Record<string, unknown>).__agentListCalls = {
      callCount: 0,
      lastForceRefreshArg: undefined,
      wasCalledWithTrue: false,
    };
    const api = window.electronAPI as { agents: { list: (forceRefresh?: boolean) => Promise<unknown> } };
    const original = api.agents.list.bind(api.agents);
    api.agents.list = async function instrumentedList(forceRefresh?: boolean) {
      const state = (window as Record<string, unknown>).__agentListCalls as {
        callCount: number;
        lastForceRefreshArg: boolean | undefined;
        wasCalledWithTrue: boolean;
      };
      state.callCount += 1;
      state.lastForceRefreshArg = forceRefresh;
      if (forceRefresh === true) state.wasCalledWithTrue = true;
      return original(forceRefresh);
    };
  });
}

async function readAgentListCalls(page: Page): Promise<{
  callCount: number;
  lastForceRefreshArg: boolean | undefined;
  wasCalledWithTrue: boolean;
}> {
  return page.evaluate(() => {
    const calls = (window as Record<string, unknown>).__agentListCalls as {
      callCount: number;
      lastForceRefreshArg: boolean | undefined;
      wasCalledWithTrue: boolean;
    } | undefined;
    return calls ?? { callCount: 0, lastForceRefreshArg: undefined, wasCalledWithTrue: false };
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
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

test.describe('AgentTab - re-detect button wires forceRefresh=true', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('re-detect button calls agents.list(forceRefresh=true)', async () => {
    ({ browser, page } = await launchFreshPage());
    await createProjectAndWaitForBoard(page, 'agent-tab-force-refresh-true');

    await waitForBootstrapComplete(page);

    // Install the call interceptor AFTER bootstrap so bootstrap calls
    // do not contaminate the recorded state.
    await instrumentAgentListCalls(page);

    await openSettings(page);

    // Navigate to the Agent tab using the exact name to avoid ambiguity with
    // other elements that have "Agent" in their accessible name.
    await page.getByRole('button', { name: 'Agent', exact: true }).click();

    // The RefreshCw button has title "Re-detect agent" when the agent is found.
    const reDetectButton = page.locator('[title="Re-detect agent"]').first();
    await reDetectButton.waitFor({ state: 'visible', timeout: 3000 });
    await reDetectButton.click();

    // The handler has an 800ms minimum delay (Promise.all([minimumDelay, refreshAgentList(true)])).
    // Poll until wasCalledWithTrue is set (allow 3000ms total budget).
    await expect.poll(
      async () => {
        const calls = await readAgentListCalls(page);
        return calls.wasCalledWithTrue;
      },
      { timeout: 3000, intervals: [300, 300, 300, 300, 300] },
    ).toBe(true);

    await closeSettings(page);
  });

  test('normal Settings open does NOT call agents.list with forceRefresh=true', async () => {
    ({ browser, page } = await launchFreshPage());
    await createProjectAndWaitForBoard(page, 'agent-tab-normal-open-no-force');

    await waitForBootstrapComplete(page);

    // Clear the agentList so Settings open DOES trigger a loadAgentList() call
    // (giving us a call to observe the argument on).
    await page.evaluate(() => {
      const configStore = (window as unknown as {
        __zustandStores?: {
          config?: { setState: (partial: { agentList: unknown[] }) => void };
        };
      }).__zustandStores?.config;
      configStore?.setState({ agentList: [] });
    });

    // Install the call interceptor AFTER clearing the store.
    await instrumentAgentListCalls(page);

    await openSettings(page);

    // Poll until agents.list() has been called at least once (the gate detected
    // the empty store and called loadAgentList()).
    await expect.poll(
      async () => {
        const calls = await readAgentListCalls(page);
        return calls.callCount;
      },
      { timeout: 5000, intervals: [200, 200, 500] },
    ).toBeGreaterThanOrEqual(1);

    // The normal Settings-open path must NOT pass forceRefresh=true; it should
    // call agents.list() with undefined or false (the non-forced variant).
    const finalCalls = await readAgentListCalls(page);
    expect(finalCalls.wasCalledWithTrue).toBe(false);

    await closeSettings(page);
  });

  test('updateConfig with a cliPaths change refreshes the agent inventory', async () => {
    // config-store's updateConfig() calls get().loadAgentList() (a plain,
    // non-forced reload) whenever partial.agent is present, so a CLI-path
    // save picks up the new binary immediately instead of requiring a
    // restart. Drive updateConfig directly against the store (no Settings UI
    // involved) so this test pins the store-level wiring in isolation from
    // the AgentTab input form.
    ({ browser, page } = await launchFreshPage());
    await createProjectAndWaitForBoard(page, 'agent-tab-cli-path-refresh');

    await waitForBootstrapComplete(page);

    // Install the call interceptor AFTER bootstrap so bootstrap's own
    // agents.list() call does not contaminate the recorded state.
    await instrumentAgentListCalls(page);

    await page.evaluate(async () => {
      const configStore = (window as unknown as {
        __zustandStores?: {
          config?: { getState: () => { updateConfig: (partial: unknown) => Promise<void> } };
        };
      }).__zustandStores?.config;
      await configStore?.getState().updateConfig({ agent: { cliPaths: { claude: '/mock/bin/claude' } } });
    });

    // A cliPaths change must trigger at least one agents.list() call so the
    // UI reflects the new path without a restart.
    await expect.poll(
      async () => {
        const calls = await readAgentListCalls(page);
        return calls.callCount;
      },
      { timeout: 3000, intervals: [200, 200, 300, 300] },
    ).toBeGreaterThanOrEqual(1);
  });
});
