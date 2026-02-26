import { test, expect, type Browser, type Page } from '@playwright/test';
import { launchPage, createProject, createTask } from './helpers';

const runId = Date.now();

/** Locate a task card within the board (avoids matching toasts or dialogs) */
function taskCard(page: Page, title: string) {
  return page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
}

test.describe('Project Deletion Cleanup', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchPage());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('deleting active project clears board and removes from sidebar', async () => {
    const name = `DelTest ${runId}`;
    await createProject(page, name);
    await createTask(page, `Task A ${runId}`);
    await createTask(page, `Task B ${runId}`);

    // Sanity: tasks and board visible
    await expect(taskCard(page, `Task A ${runId}`)).toBeVisible();
    await expect(taskCard(page, `Task B ${runId}`)).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Backlog"]')).toBeVisible();

    // Hover project in sidebar → click delete icon
    await page.locator(`[role="button"]:has-text("${name}")`).hover();
    await page.locator('button[title="Delete project"]').click();

    // Confirm deletion in dialog
    await expect(page.locator('h3:has-text("Delete Project")')).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForTimeout(300);

    // Board clears — no swimlane columns remain
    await expect(page.locator('[data-swimlane-name="Backlog"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]')).toHaveCount(0);

    // Project removed from sidebar
    await expect(page.locator(`[role="button"]:has-text("${name}")`)).not.toBeVisible();

    // Mock backend state is cleared
    const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
    expect(tasks).toEqual([]);
    const sessions = await page.evaluate(() => window.electronAPI.sessions.list());
    expect(sessions).toEqual([]);
  });

  test('new project after deletion loads clean state (no cross-project bleed)', async () => {
    const name = `PostDel ${runId}`;
    await createProject(page, name);

    // Default swimlanes present
    await expect(page.locator('[data-swimlane-name="Backlog"]')).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Done"]')).toBeVisible();

    // Board has columns but no leftover tasks from the deleted project
    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await expect(backlog.locator(`text=Task A ${runId}`)).not.toBeVisible();
    await expect(backlog.locator(`text=Task B ${runId}`)).not.toBeVisible();

    // Board is functional — can create new tasks
    await createTask(page, `Fresh Task ${runId}`);
    await expect(taskCard(page, `Fresh Task ${runId}`)).toBeVisible();
  });

  test('cancel delete preserves project and board', async () => {
    const name = `PostDel ${runId}`;

    // Try to delete but cancel
    await page.locator(`[role="button"]:has-text("${name}")`).hover();
    await page.locator('button[title="Delete project"]').click();

    // Dialog appears
    await expect(page.locator('h3:has-text("Delete Project")')).toBeVisible();

    // Cancel
    await page.locator('button:has-text("Cancel")').click();
    await page.waitForTimeout(200);

    // Dialog dismissed, project and board intact
    await expect(page.locator('h3:has-text("Delete Project")')).not.toBeVisible();
    await expect(page.locator(`[role="button"]:has-text("${name}")`)).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Backlog"]')).toBeVisible();
    await expect(taskCard(page, `Fresh Task ${runId}`)).toBeVisible();
  });
});
