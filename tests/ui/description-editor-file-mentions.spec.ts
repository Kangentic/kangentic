import { expect, test } from '@playwright/test';
import { createProject, createTask, launchPage } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `Description Mention Test ${Date.now()}`;
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

/**
 * Wait for all dialog backdrops (fixed inset-0 overlays) to fully unmount.
 * BaseDialog animates close over 150ms and only unmounts on `animationend`.
 * Without this wait, a backdrop from the prior test intercepts clicks on "Add
 * task" in the next test, causing deterministic timeouts in a shared-page suite.
 */
async function waitForNoBackdrop(): Promise<void> {
  await expect(page.locator('.fixed.inset-0')).toHaveCount(0, { timeout: 2000 });
}

async function openNewTaskDialog() {
  // Ensure any dialog/backdrop from a prior test is fully gone before clicking.
  await waitForNoBackdrop();
  await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

test.describe('DescriptionEditor file mentions', () => {
  test('supports keyboard selection in New Task', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.fill('@src');

    const menu = page.locator('[data-testid="description-mention-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('src');

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="description-mention-item"]').nth(1)).toHaveClass(/bg-surface-hover/);

    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    const selectedValue = await textarea.inputValue();
    await expect(selectedValue.startsWith('@src')).toBeTruthy();
    await expect(menu).not.toBeVisible();

    // Form is dirty (description filled) - Cancel shows "Discard unsaved
    // changes?" confirm. Dismiss via Discard so the dialog fully closes before
    // the next test opens it.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('tab selects the highlighted item and escape closes only the menu', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.fill('@desc');

    const menu = page.locator('[data-testid="description-mention-menu"]');
    await expect(menu).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(page.locator('input[placeholder="Task title"]')).toBeVisible();

    await textarea.fill('');
    await textarea.fill('@desc');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('DescriptionEditor.tsx');
    await page.keyboard.press('Tab');
    await expect(textarea).toHaveValue('@src/renderer/components/DescriptionEditor.tsx ');

    // Form is dirty (description filled) - Cancel shows "Discard unsaved
    // changes?" confirm. Dismiss via Discard so the dialog fully closes before
    // the next test runs.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('is available in backlog editing and preview preserves plain text', async () => {
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="new-backlog-task-btn"]').click();
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toBeVisible();

    const backlogTextarea = page.locator('[data-testid="backlog-task-description"]');
    await backlogTextarea.fill('@read');
    await expect(page.locator('[data-testid="description-mention-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="description-mention-menu"]')).toContainText('README.md');
    await page.keyboard.press('Enter');
    await expect(backlogTextarea).toHaveValue('@README.md ');

    await page.locator('[data-testid="description-preview-toggle"]').click();
    await expect(page.locator('[data-testid="description-preview"]')).toContainText('@README.md');
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="view-toggle-board"]').click();
  });

  test('uses worktree or project editor wiring in task detail', async () => {
    await createTask(page, 'Mention Detail Task');
    await page.locator('[data-testid="swimlane"]').locator('text=Mention Detail Task').first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.fill('@workt');
    await expect(page.locator('[data-testid="description-mention-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="description-mention-menu"]')).toContainText('worktree-strategy.md');

    await page.keyboard.press('Enter');
    await expect(textarea).toHaveValue('@docs/worktree-strategy.md ');

    // Close via Cancel (description-only edits via Playwright fill() do not
    // trigger the dirty guard, so Cancel closes directly without a confirm).
    // Using Cancel rather than Escape avoids the bubble-phase interception risk
    // on CI Linux where focus is in the textarea after Enter.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 5000 });
  });
});
