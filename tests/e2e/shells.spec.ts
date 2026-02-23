import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTempProject,
  cleanupTempProject,
  detectAvailableShells,
  type ShellInfo,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

// Detect shells once at module level
const availableShells = detectAvailableShells();
console.log(
  'Detected shells:',
  availableShells.map((s) => `${s.name} (${s.path})`).join(', '),
);

const runId = Date.now();

for (const shell of availableShells) {
  test.describe(`Shell: ${shell.name}`, () => {
    const testName = `shell-${shell.name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
    const projectName = `Shell ${shell.name} ${runId}`;
    const taskName = `Shell test ${shell.name} ${runId}`;
    let app: ElectronApplication;
    let page: Page;
    let tmpDir: string;

    test.beforeAll(async () => {
      tmpDir = createTempProject(testName);
      const result = await launchApp();
      app = result.app;
      page = result.page;
      await createProject(page, projectName, tmpDir);
    });

    test.afterAll(async () => {
      await app?.close();
      cleanupTempProject(testName);
    });

    test('can open settings panel', async () => {
      const settingsBtn = page.locator('button[title="Settings"]');
      await settingsBtn.click();
      await page.waitForTimeout(500);

      // Verify settings opened
      const settingsVisible = await page.locator('text=/[Ss]ettings|[Cc]onfig|[Ss]hell|[Pp]ermission/').first().isVisible().catch(() => false);
      expect(settingsVisible).toBeTruthy();

      // Close settings
      await settingsBtn.click();
      await page.waitForTimeout(300);
    });

    test('can create a task', async () => {
      const backlog = page.locator('[data-swimlane-name="Backlog"]');
      await backlog.locator('text=+ Add task').click();

      await page.locator('input[placeholder="Task title"]').fill(taskName);
      await page.locator('textarea[placeholder="Description (optional)"]').fill('Testing terminal with ' + shell.name);
      await page.locator('button:has-text("Create")').click();
      await page.waitForTimeout(500);

      await expect(page.locator(`text=${taskName}`).first()).toBeVisible();
    });

    test('task appears in Backlog column', async () => {
      const backlog = page.locator('[data-swimlane-name="Backlog"]');
      await expect(backlog.locator(`text=${taskName}`).first()).toBeVisible();
    });

    test('session counter is visible', async () => {
      await expect(page.locator('text=/\\d+\\/\\d+ sessions/')).toBeVisible();
    });

    test('board renders all default columns', async () => {
      for (const name of ['Backlog', 'Planning', 'Running', 'Review', 'Done']) {
        await expect(page.locator(`[data-swimlane-name="${name}"]`)).toBeVisible();
      }
    });
  });
}

// Fallback if no shells detected
if (availableShells.length === 0) {
  test('no shells detected', () => {
    test.skip(true, 'No shells detected on this machine');
  });
}
