import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Poll the Vite dev server until it responds with HTTP 200.
 * Prevents thundering-herd timeouts when multiple workers launch simultaneously
 * before Vite finishes its initial compilation.
 */
export async function waitForViteReady(url: string = VITE_URL, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server not ready */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Vite dev server at ${url} not ready after ${timeoutMs}ms`);
}

/**
 * Launch a headless Chromium page with the electronAPI mock injected.
 * The Vite dev server must be running (started by playwright webServer config).
 */
export async function launchPage(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  // Inject the mock before any page scripts run
  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  // Wait for React to render the app shell
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

// Wait for the board to load (swimlanes visible)
export async function waitForBoard(page: Page): Promise<void> {
  await page
    .locator('[data-swimlane-name="To Do"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  await page
    .locator('[data-swimlane-name="Planning"]')
    .waitFor({ state: 'visible', timeout: 5000 });
}

// Create a project via the UI (folder picker flow).
// The project name is derived from the folder path's basename,
// so we construct a mock path whose last segment matches the desired name.
export async function createProject(
  page: Page,
  name: string,
  _projectPath?: string,
): Promise<void> {
  // Set the mock folder selection so basename = project name
  await page.evaluate((n: string) => {
    (window as any).__mockFolderPath = '/mock/projects/' + n;
  }, name);

  // When no projects exist the sidebar is hidden and the welcome screen
  // provides the "Open a Project" button. Otherwise use the sidebar button.
  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');

  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }

  await waitForBoard(page);
}

// Create a task via the UI in the To Do column (the only column with an "Add task" button).
// To place a task in a different column, create it in To Do first, then drag it.
export async function createTask(
  page: Page,
  title: string,
  description: string = '',
): Promise<void> {
  const backlog = page.locator('[data-swimlane-name="To Do"]');
  const addButton = backlog.locator('text=Add task');
  await addButton.click();

  const titleInput = page.locator('input[placeholder="Task title"]');
  await titleInput.fill(title);

  if (description) {
    const descInput = page.locator('textarea').first();
    await descInput.fill(description);
  }

  const createButton = page.locator('button:has-text("Create")');
  await createButton.click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });
}
