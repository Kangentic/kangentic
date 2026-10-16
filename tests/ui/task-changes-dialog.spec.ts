import { test, expect } from '@playwright/test';
import { launchPage, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `Changes Menu Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
});

test.afterAll(async () => {
  await browser?.close();
});

function taskCard(title: string) {
  return page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
}

test.describe('Task Changes context menu entry', () => {
  test('Show changes item is hidden for tasks without a worktree', async () => {
    await createTask(page, 'No Worktree Task');
    await taskCard('No Worktree Task').click({ button: 'right' });

    // Sanity: menu actually opened (other entries are visible).
    await expect(page.locator('[data-testid="context-edit-task"]')).toBeVisible();
    await expect(page.locator('[data-testid="context-archive-task"]')).toBeVisible();

    // A fresh task has no worktree_path, so the "Show changes" entry must be gated off.
    await expect(page.locator('[data-testid="context-show-changes"]')).not.toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="context-edit-task"]')).not.toBeVisible();
  });
});
