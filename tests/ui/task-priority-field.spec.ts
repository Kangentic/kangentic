/**
 * The Priority field in New Task and in Edit Task (#1160).
 *
 * Both dialogs draw it through the shared PriorityLabelsRow, whose listbox draws each
 * level with its meter. The backlog dialog's copy of that field is pinned in
 * backlog-dialog-ux.spec.ts, and the keyboard behavior of the listbox (ArrowDown onto
 * the chosen option, Tab closing onto the trigger) is pinned through the column picker
 * in edit-automation-guards.spec.ts. What neither reaches is each board dialog handing
 * the picked level to its own save, which is what a user would lose: a level that looks
 * chosen and is stored as None.
 *
 * One page and one task, since the edit step opens the task the create step made.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { launchPage, createProject, waitForBoard } from './helpers';

const TASK_TITLE = 'Priority Field Task';
const MEDIUM_LEVEL = '2';
const URGENT_LEVEL = '4';
const LEVEL_COUNT = 5;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Priority Field ${Date.now()}`);
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

/** The persisted priority of the task, read from the mock's own task list. */
function storedPriority(title: string): Promise<number | undefined> {
  return page.evaluate(async (wanted) => {
    const task = (await window.electronAPI.tasks.list()).find((candidate) => candidate.title === wanted);
    return task?.priority;
  }, title);
}

test('New Task and Edit Task draw each level with its meter and save the chosen level', async () => {
  const newTaskDialog = page.locator('[data-testid="new-task-dialog"]');

  await test.step('New Task lists every level with a meter and stores the pick', async () => {
    await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
    await expect(newTaskDialog).toBeVisible();
    await newTaskDialog.locator('input[placeholder="Task title"]').fill(TASK_TITLE);

    const field = newTaskDialog.locator('[data-testid="task-priority"]');
    await expect(field).toHaveAttribute('data-value', '0');
    await field.click();
    // The menu is portaled out of the dialog, so its rows are found on the page.
    await expect(page.locator('[data-testid="task-priority-option"] [data-testid="priority-meter"]')).toHaveCount(LEVEL_COUNT);
    await page.locator(`[data-testid="task-priority-option"][data-value="${MEDIUM_LEVEL}"]`).click();
    await expect(field).toHaveAttribute('data-value', MEDIUM_LEVEL);
    await expect(field).toContainText('Medium');

    await newTaskDialog.locator('button[type="submit"]:has-text("Create")').click();
    await expect(newTaskDialog).toBeHidden({ timeout: 8000 });
    await expect.poll(() => storedPriority(TASK_TITLE)).toBe(2);
  });

  await test.step('Edit Task shows the stored level and saves a new one', async () => {
    await page.locator('[data-swimlane-name="To Do"]').locator(`text=${TASK_TITLE}`).first().click();
    const taskWindow = page.locator('[data-testid="task-detail-dialog"]');
    await taskWindow.waitFor({ state: 'visible', timeout: 5000 });

    const field = taskWindow.locator('[data-testid="task-priority"]');
    await expect(field).toHaveAttribute('data-value', MEDIUM_LEVEL);
    await expect(field).toContainText('Medium');
    await field.click();
    await expect(page.locator('[data-testid="task-priority-option"] [data-testid="priority-meter"]')).toHaveCount(LEVEL_COUNT);
    await page.locator(`[data-testid="task-priority-option"][data-value="${URGENT_LEVEL}"]`).click();
    await expect(field).toHaveAttribute('data-value', URGENT_LEVEL);
    await expect(field).toContainText('Urgent');

    // Ctrl+S is the edit form's own Save (task-detail-save-hotkey.spec.ts).
    await page.keyboard.press('Control+S');
    await expect(taskWindow).toBeHidden({ timeout: 8000 });
    await expect.poll(() => storedPriority(TASK_TITLE)).toBe(4);
  });
});
