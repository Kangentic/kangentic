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

  // The saved row keeps its tab, so it reads what it is; a new choice of it is refused with the agent named.
  await row.click();
  const editor = page.locator('[data-testid="edit-automation-dialog"]');
  await expect(editor).toBeVisible();
  const userTab = editor.locator('[data-testid="edit-automation-condition-kind-user"]');
  await expect(userTab).toHaveAttribute('aria-checked', 'true');
  await expect(userTab).toBeDisabled();
  await expect(userTab).toHaveAccessibleDescription(/doesn't report the messages you send, so this can't run in Executing\./);
});
