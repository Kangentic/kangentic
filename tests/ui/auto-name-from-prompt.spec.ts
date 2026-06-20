/**
 * UI tests for the "Name from prompt" affordance in the New Task dialog and
 * the Task Detail edit form.
 *
 * The button visibility depends on three runtime gates:
 *   - The global toggle `autoNameTasksFromPrompt` is on
 *   - The active project's default agent is detected and exposes summarize
 *   - The description is non-empty
 *
 * Tests use the in-memory mock electronAPI: agents.list() returns Claude as
 * `supportsSummarize: true, found: true` by default, and agent.summarize()
 * returns a deterministic mocked title.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `Auto Name ${Date.now()}`;
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

/** Open the New Task dialog in the To Do column. */
async function openNewTaskDialog(): Promise<void> {
  // Ensure any dialog/backdrop from a prior test is fully gone before clicking.
  await waitForNoBackdrop();
  const column = page.locator('[data-swimlane-name="To Do"]');
  await column.locator('text=Add task').click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

test.describe('NewTaskDialog - Name from prompt button', () => {
  test('button is hidden when description is empty', async () => {
    await openNewTaskDialog();
    // No description typed - button should not appear.
    await expect(page.getByTestId('name-from-prompt-button')).toHaveCount(0);
    // Form is clean - Escape closes directly (no ConfirmDialog) and animates out.
    await page.keyboard.press('Escape');
  });

  test('button appears with non-empty description', async () => {
    await openNewTaskDialog();
    const description = page.locator('textarea').first();
    await description.fill('the toast keeps reappearing every time the dialog opens');
    await expect(page.getByTestId('name-from-prompt-button')).toBeVisible();
    // Form is dirty - Cancel shows a "Discard unsaved changes?" confirm.
    // Dismiss via Discard so the dialog fully closes before the next test opens it.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('clicking the button populates the title via mocked summarize', async () => {
    await openNewTaskDialog();
    const description = page.locator('textarea').first();
    await description.fill('rename a task whose title is fix bug');
    const button = page.getByTestId('name-from-prompt-button');
    await expect(button).toBeVisible();

    // Inject an explicit summarize override so we can assert on a known string.
    await page.evaluate(() => {
      (window as unknown as { __mockAgentSummarize: (input: { prompt: string }) => unknown }).__mockAgentSummarize =
        (input) => ({ ok: true, title: `Suggested: ${input.prompt.slice(0, 30)}` });
    });

    await button.click();
    const titleInput = page.locator('input[placeholder="Task title"]');
    await expect(titleInput).toHaveValue(/^Suggested:/);
    // Form is dirty - Cancel shows a "Discard unsaved changes?" confirm.
    // Dismiss via Discard so the dialog fully closes before the next test opens it.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('button is hidden when project default agent does not support summarize', async () => {
    // Switch project default to an agent that does NOT support summarize (aider).
    await page.evaluate(async () => {
      const projects = await window.electronAPI.projects.list();
      if (projects.length === 0) return;
      await window.electronAPI.projects.setDefaultAgent(projects[0].id, 'aider');
      const w = window as unknown as { __zustandStores?: {
        project: { getState: () => { loadCurrent: () => Promise<void> } };
        config: { getState: () => { loadAgentList: () => Promise<void> } };
      } };
      await w.__zustandStores?.project.getState().loadCurrent();
      await w.__zustandStores?.config.getState().loadAgentList();
    });
    // Intentional fixed wait: the two IPC awaits above resolve synchronously in
    // the mock, but React's state flush happens in a microtask after the evaluate
    // returns. 50ms is a minimal budget to let the render cycle complete before
    // we assert the button is absent. Cannot use expect.poll for non-occurrence.
    await page.waitForTimeout(50);

    await openNewTaskDialog();
    await page.locator('textarea').first().fill('description for an aider-default project');
    await expect(page.getByTestId('name-from-prompt-button')).toHaveCount(0);
    // Form is dirty - Cancel shows a "Discard unsaved changes?" confirm.
    // Dismiss via Discard so the dialog fully closes before restoring agent state.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();

    // Restore project default to Claude for downstream tests.
    await page.evaluate(async () => {
      const projects = await window.electronAPI.projects.list();
      if (projects.length === 0) return;
      await window.electronAPI.projects.setDefaultAgent(projects[0].id, 'claude');
      const w = window as unknown as { __zustandStores?: {
        project: { getState: () => { loadCurrent: () => Promise<void> } };
      } };
      await w.__zustandStores?.project.getState().loadCurrent();
    });
  });
});

test.describe('TaskDetailEditForm - Name from prompt button', () => {
  test('button appears in edit mode with description', async () => {
    // Create a To Do task with a description so we can edit it.
    const cardTitle = `auto-name-edit-${Date.now()}`;
    await openNewTaskDialog();
    await page.locator('input[placeholder="Task title"]').fill(cardTitle);
    await page.locator('.fixed textarea').first().fill('Real description for the existing task');
    await page.locator('button[type="submit"]:has-text("Create")').click();
    // Wait for the NewTaskDialog backdrop to fully unmount before clicking the
    // card. The card can appear in the DOM while the backdrop is still animating
    // out (150ms exit animation), and a click on the card during that window is
    // intercepted by the backdrop overlay.
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });

    // Wait for the new card to appear in the To Do swimlane and click it.
    // To Do tasks open directly in edit mode (no pencil click required).
    const card = page.locator('[data-testid="swimlane"]').locator(`text=${cardTitle}`).first();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();

    // The detail dialog opens in edit mode for To Do tasks. The Name from prompt
    // button should be visible next to the title input.
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await expect(page.getByTestId('name-from-prompt-button')).toBeVisible();

    // Inject a deterministic summarize mock + click; verify the title input updates.
    await page.evaluate(() => {
      (window as unknown as { __mockAgentSummarize: (input: { prompt: string }) => unknown }).__mockAgentSummarize =
        (input) => ({ ok: true, title: `EditSuggested: ${input.prompt.slice(0, 25)}` });
    });
    await page.getByTestId('name-from-prompt-button').click();

    const titleInput = page.locator('.fixed input[placeholder="Task title"]');
    await expect(titleInput).toHaveValue(/^EditSuggested:/);

    // Save and close.
    await page.locator('button:has-text("Save")').click();
  });
});
