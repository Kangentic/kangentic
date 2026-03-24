import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Launch a page with hasCompletedFirstRun set to false.
 * Sets __mockConfigOverrides before the mock IIFE runs so the config
 * is initialized with the override applied.
 */
async function launchFirstRunPage(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  // Set override BEFORE the mock script runs (addInitScript order is guaranteed)
  await page.addInitScript(() => {
    (window as Record<string, unknown>).__mockConfigOverrides = { hasCompletedFirstRun: false };
  });
  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * Create a project so the board is visible.
 */
async function createProject(page: Page, name: string): Promise<void> {
  await page.evaluate((projectName: string) => {
    (window as Record<string, unknown>).__mockFolderPath = '/mock/projects/' + projectName;
  }, name);

  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');

  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }

  await page
    .locator('[data-swimlane-name="To Do"]')
    .waitFor({ state: 'visible', timeout: 15000 });
}

test.describe('Welcome Overlay', () => {
  let browser: Browser;
  let page: Page;

  test.beforeEach(async () => {
    ({ browser, page } = await launchFirstRunPage());
    await createProject(page, 'first-run-test');
  });

  test.afterEach(async () => {
    await browser.close();
  });

  test('overlay appears when hasCompletedFirstRun is false', async () => {
    const overlay = page.locator('[data-testid="welcome-overlay"]');
    await expect(overlay).toBeVisible({ timeout: 5000 });
  });

  test('overlay shows 3-step guide', async () => {
    const card = page.locator('[data-testid="welcome-overlay-card"]');
    await expect(card).toBeVisible({ timeout: 5000 });

    await expect(card.locator('text=Create a task')).toBeVisible();
    await expect(card.locator('text=Drag to run')).toBeVisible();
    await expect(card.locator('text=Watch it code')).toBeVisible();
  });

  test('overlay shows project name in heading', async () => {
    const card = page.locator('[data-testid="welcome-overlay-card"]');
    await expect(card.locator('text=Welcome to first-run-test')).toBeVisible({ timeout: 5000 });
  });

  test('Get Started button dismisses overlay', async () => {
    const overlay = page.locator('[data-testid="welcome-overlay"]');
    await expect(overlay).toBeVisible({ timeout: 5000 });

    const dismissButton = page.locator('[data-testid="welcome-overlay-dismiss"]');
    await dismissButton.click();

    // Overlay fades out (500ms)
    await expect(overlay).toBeHidden({ timeout: 2000 });
  });

  test('first-run hint card appears in empty To Do', async () => {
    // Dismiss overlay first so we can see the board
    const dismissButton = page.locator('[data-testid="welcome-overlay-dismiss"]');
    await expect(dismissButton).toBeVisible({ timeout: 5000 });
    await dismissButton.click();
    await page.locator('[data-testid="welcome-overlay"]').waitFor({ state: 'hidden', timeout: 2000 });

    const hint = page.locator('[data-testid="first-run-hint"]');
    await expect(hint).toBeVisible();
    await expect(hint.locator('text=Create your first task')).toBeVisible();
  });
});
