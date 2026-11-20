/**
 * A row whose Text match reads the user's message, on a column whose agent cannot report the
 * messages a person sends (#1078). The pane shows it off with its switch disabled and the reason
 * on the switch, and the Edit automation dialog keeps it on its tab while a new row cannot pick it.
 *
 * Its own file because the agent list is read once, at load, so the agent's missing capability
 * has to be in place before the page boots (`__mockAgentListOverrides`).
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `UserMessageUnsupported Test ${Date.now()}`;
const UNSUPPORTED_REASON = "This column's agent doesn't report the messages you send.";
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage({
    beforeLoad: async (target) => {
      await target.addInitScript(() => {
        (window as unknown as { __mockAgentListOverrides: Record<string, unknown> }).__mockAgentListOverrides = {
          claude: { reportsUserMessages: false },
        };
      });
    },
  });
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
  await waitForBoard(page);
  await page.evaluate(async () => {
    const lanes = await window.electronAPI.swimlanes.list();
    const executing = lanes.find((lane) => lane.name === 'Executing');
    if (!executing) throw new Error('no Executing column');
    await window.electronAPI.automations.replaceForColumn(executing.id, [{
      name: 'On to Code Review',
      type: 'move_to_column',
      trigger: 'turn_end',
      enabled: true,
      config: { targetColumn: 'Code Review' },
      condition: null,
      final_line: '*signed off*',
      text_match_source: 'user',
      max_runs: null,
    }], executing.id);
  });
});

test.afterAll(async () => {
  await browser?.close();
});

test('a row on the user\'s message is shown off where the agent cannot report one, with the reason', async () => {
  await page.locator('[data-swimlane-name="Executing"]').locator('text=Executing').click();
  const manager = page.locator('[data-testid="board-manager-dialog"]');
  await expect(manager).toBeVisible({ timeout: 3000 });

  const row = manager.locator('[data-testid="column-automation-row"][data-name="On to Code Review"]');
  await expect(row).toHaveAttribute('data-can-run', 'false');
  // Stored on, shown off: the row comes back by itself on an agent that can serve it.
  await expect(row).toHaveAttribute('data-enabled', 'true');
  const toggle = row.locator('[data-testid="column-automation-enabled"]');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAccessibleDescription(UNSUPPORTED_REASON);

  // The saved row keeps its Prompt line, so it reads what it is; a new choice of Prompt is not
  // offered where the agent cannot report one, though Reply still is.
  await row.click();
  const editor = page.locator('[data-testid="edit-automation-dialog"]');
  await expect(editor).toBeVisible();
  await editor.locator('[data-testid="edit-automation-card-condition-header"]').click();
  const condition = editor.locator('[data-testid="edit-automation-card-condition"]');
  const promptLine = condition.locator('[data-testid="edit-automation-condition-line-prompt"]');
  await expect(promptLine).toBeVisible();
  await expect(condition.locator('[data-testid="edit-automation-final-line-line"]')).toHaveValue('*signed off*');

  const menu = page.locator('[data-testid="edit-automation-add-condition-menu"]');
  await condition.locator('[data-testid="edit-automation-add-condition"]').click();
  await expect(menu).toBeVisible();
  // Text match is one stored field, so the line already holding it leaves both out.
  await expect(menu.locator('[data-testid="edit-automation-add-condition-reply"]')).toHaveCount(0);
  await expect(menu.locator('[data-testid="edit-automation-add-condition-prompt"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeVisible();

  await condition.locator('[data-testid="edit-automation-condition-line-prompt-remove"]').click();
  await expect(promptLine).toHaveCount(0);
  await condition.locator('[data-testid="edit-automation-add-condition"]').click();
  await expect(menu.locator('[data-testid="edit-automation-add-condition-reply"]')).toBeVisible();
  await expect(menu.locator('[data-testid="edit-automation-add-condition-prompt"]')).toHaveCount(0);
});
