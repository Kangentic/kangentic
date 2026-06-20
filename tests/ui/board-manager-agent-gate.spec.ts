/**
 * UI tests for the BoardManagerDialog "load only when store is empty" gate.
 *
 * BoardManagerDialog has the same guard as SettingsPanel: it calls
 * agents.list() on mount only when the store's agentList is empty. These
 * tests pin that optimization so a future refactor cannot silently drop the
 * guard and restore expensive probe calls on every column-manager open.
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

async function readAgentListCallCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as Record<string, unknown>).__agentListCallCount as number || 0,
  );
}

/** Open the BoardManagerDialog by clicking a column header. */
async function openBoardManager(page: Page): Promise<void> {
  const column = page.locator('[data-swimlane-name="Code Review"]');
  await column.locator('text=Code Review').click();
  await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'visible', timeout: 3000 });
}

/** Close the BoardManagerDialog via Cancel, handling a discard confirm if shown. */
async function closeBoardManager(page: Page): Promise<void> {
  const dialog = page.locator('[data-testid="board-manager-dialog"]');
  const cancelButton = dialog.getByRole('button', { name: 'Cancel' });
  await cancelButton.click();
  // Handle possible "Discard unsaved changes?" confirm.
  const discardButton = page.locator('button', { hasText: 'Discard' });
  if (await discardButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await discardButton.click();
  }
  await dialog.waitFor({ state: 'detached', timeout: 2000 });
}

test.describe('BoardManagerDialog - agents.list() load gate', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('does not re-call agents.list() when store already holds agentList', async () => {
    ({ browser, page } = await launchFreshPage());
    await createProjectAndWaitForBoard(page, 'board-manager-gate-populated');

    // App bootstrap populates the store.
    await waitForBootstrapComplete(page);

    // Install the call counter AFTER bootstrap.
    await instrumentAgentListCallCount(page);

    await openBoardManager(page);

    // Wait for a positive post-mount signal instead of a bare timeout: the
    // dialog tab strip only renders once the dialog has mounted and its mount
    // effect (the gate under test) has run.
    await page.locator('[data-testid="board-manager-tab"]').first().waitFor({ state: 'visible', timeout: 3000 });

    // The gate saw a populated store, so the count must remain 0. Poll briefly
    // to give any (incorrect) async call a chance to land before asserting.
    await expect.poll(
      async () => readAgentListCallCount(page),
      { timeout: 1000, intervals: [200, 200, 200] },
    ).toBe(0);

    await closeBoardManager(page);
  });

  test('calls agents.list() when store is empty on BoardManagerDialog open', async () => {
    ({ browser, page } = await launchFreshPage());
    await createProjectAndWaitForBoard(page, 'board-manager-gate-empty');

    await waitForBootstrapComplete(page);

    // Clear only agentList (BoardManagerDialog gates on agentList, not agentInfo).
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

    await openBoardManager(page);

    // Poll until agents.list() has been called, proving the empty-store gate
    // correctly triggered a fetch.
    await expect.poll(
      async () => readAgentListCallCount(page),
      { timeout: 5000, intervals: [200, 200, 500] },
    ).toBeGreaterThanOrEqual(1);

    await closeBoardManager(page);
  });
});
