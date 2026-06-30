/**
 * UI tests for the description peek pill in the task detail header.
 *
 * Opens a dialog on a task with an active session and a description, verifies
 * the "Description" pill appears, toggles the description strip on/off, and
 * confirms the kebab menu item does the same.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-desc-peek';
const TASK_ID = 'task-desc-peek';
const SESSION_ID = 'sess-desc-peek';
const TASK_DESCRIPTION = 'Implement the OAuth login flow with PKCE';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Description Peek Test',
      path: '/mock/desc-peek-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so displayState.kind === 'running' -> hasSessionContext is true.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/desc-peek-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Description Peek Task',
      description: '${TASK_DESCRIPTION}',
      swimlane_id: laneIds['Executing'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/desc-peek',
      branch_name: 'feature/desc-peek',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Task Detail description peek', () => {
  test('pill toggles description strip on and off', async () => {
    // Open the task detail dialog
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Description Peek Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Description peek pill is visible (task has a description and a running session)
    const descriptionPill = page.locator('[data-testid="description-peek-toggle"]');
    await expect(descriptionPill).toBeVisible({ timeout: 8000 });

    // Description text is not yet visible (peek is closed by default)
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible();

    // Open peek -> description text appears
    await descriptionPill.click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });

    // Pill shows active state when open
    await expect(descriptionPill).toBeVisible();

    // Close peek -> description text hides again
    await descriptionPill.click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible({ timeout: 8000 });

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('kebab menu item toggles description strip', async () => {
    // Open the task detail dialog fresh for this test (cross-test state isolation)
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Description Peek Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Description not visible initially
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible();

    // Open kebab and click "Show description"
    await dialog.locator('[title="Actions"]').click();
    await page.locator('text=Show description').click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });

    // Open kebab again -> item now reads "Hide description"
    await dialog.locator('[title="Actions"]').click();
    await expect(page.locator('text=Hide description')).toBeVisible({ timeout: 5000 });
    await page.locator('text=Hide description').click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible({ timeout: 8000 });

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
