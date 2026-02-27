import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const isWorktree = __dirname.replace(/\\/g, '/').includes('.kangentic/worktrees/');
const VITE_PORT = process.env.VITE_PORT || (isWorktree ? '5174' : '5173');
const VITE_URL = `http://localhost:${VITE_PORT}`;

/**
 * Launch a headless Chromium page with the electronAPI mock injected.
 * The Vite dev server must be running (started by playwright webServer config).
 */
export async function launchPage(): Promise<{ browser: Browser; page: Page }> {
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
    .locator('[data-swimlane-name="Backlog"]')
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

  const addButton = page.locator('button[title="Open folder as project"]');
  await addButton.click();

  await waitForBoard(page);
}

// Create a task via the UI
export async function createTask(
  page: Page,
  title: string,
  description: string = '',
  columnName: string = 'Backlog',
): Promise<void> {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  const addButton = column.locator('text=+ Add task');
  await addButton.click();

  const titleInput = page.locator('input[placeholder="Task title"]');
  await titleInput.fill(title);

  if (description) {
    const descInput = page.locator('textarea').first();
    await descInput.fill(description);
  }

  const createButton = page.locator('button:has-text("Create")');
  await createButton.click();
  await page.waitForTimeout(300);
}
