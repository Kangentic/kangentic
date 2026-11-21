/**
 * UI tests for the Task tab's Priority and Labels switches (#1146).
 *
 * Intent: Settings > Task > Cards holds two global switches, showTaskPriority and
 * showTaskLabels. Each writes its own key and leaves the other alone. Off hides the
 * meter or the label row on board cards (the full card and the Done list's compact
 * one), and nowhere else: the task window and the Backlog list keep showing both.
 * A saved config with neither key reads as on, so an upgrade changes nothing.
 *
 * The card specs flip the config store directly; only a click on the real switch
 * proves the row is wired to the right key.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-card-pill-settings';
const LABELLED_TASK_ID = 'task-pill-settings-labelled';
const DONE_TASK_ID = 'task-pill-settings-done';
const BACKLOG_TITLE = 'Backlog item with pills';

function seedScript(deleteKeys: boolean): string {
  return `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.config.showTaskNumbers = true;
    ${deleteKeys ? 'delete state.config.showTaskPriority; delete state.config.showTaskLabels;' : ''}
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Card Pill Settings', path: '/mock/card-pill-settings',
      github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-pill-settings-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
    });
    function task(fields) {
      return Object.assign({
        description: '', agent: null, session_id: null, worktree_path: null, branch_name: null,
        pr_number: null, pr_url: null, base_branch: null, archived_at: null, labels: [], priority: 0,
        created_at: timestamp, updated_at: timestamp,
      }, fields);
    }
    state.tasks.push(task({
      id: '${LABELLED_TASK_ID}', display_id: 2001, title: 'Task with a meter and labels',
      swimlane_id: laneIds['To Do'], position: 0, priority: 3, labels: ['ui', 'git'],
    }));
    state.archivedTasks.push(task({
      id: '${DONE_TASK_ID}', display_id: 2002, title: 'Done task with labels', description: 'Finished work.',
      swimlane_id: laneIds['Done'], position: 0, priority: 4, labels: ['git'], archived_at: timestamp,
    }));
    state.backlogTasks.push({
      id: 'backlog-pill-settings', title: '${BACKLOG_TITLE}', description: '', priority: 4, labels: ['bug', 'ui'],
      position: 0, assignee: null, due_date: null, item_type: null, external_id: null, external_source: null,
      external_url: null, sync_status: null, external_metadata: null, attachment_count: 0,
      created_at: timestamp, updated_at: timestamp,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;
}

async function openBoard(deleteKeys: boolean): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const launched = await chromium.launch({ headless: true });
  const context = await launched.newContext({ viewport: { width: 1920, height: 1080 } });
  const opened = await context.newPage();
  await opened.addInitScript({ path: MOCK_SCRIPT });
  await opened.addInitScript(seedScript(deleteKeys));
  await gotoVite(opened, VITE_URL);
  await opened.waitForSelector('text=Kangentic', { timeout: 15000 });
  await opened.locator(`[data-task-id="${LABELLED_TASK_ID}"]`).waitFor({ state: 'visible', timeout: 15000 });
  return { browser: launched, page: opened };
}

const card = (target: Page, taskId: string) => target.locator(`[data-task-id="${taskId}"]`);

async function openTaskTab(target: Page): Promise<void> {
  await target.locator('[data-testid="settings-button"]').click();
  await target.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await target.getByTestId('settings-tab-list').getByRole('button', { name: 'Task', exact: true }).click();
}

async function closeSettings(target: Page): Promise<void> {
  await target.keyboard.press('Escape');
  await target.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

async function readCardKeys(target: Page): Promise<{ priority: boolean | undefined; labels: boolean | undefined }> {
  return target.evaluate(async () => {
    const globalConfig = (await window.electronAPI.config.getGlobal()) as {
      showTaskPriority?: boolean;
      showTaskLabels?: boolean;
    };
    return { priority: globalConfig.showTaskPriority, labels: globalConfig.showTaskLabels };
  });
}

test('the Priority and Labels switches write their own keys, and only cards obey them', async () => {
  test.setTimeout(60_000);
  const { browser, page } = await openBoard(false);
  try {
    const prioritySwitch = page.getByTestId('setting-row-showTaskPriority');
    const labelsSwitch = page.getByTestId('setting-row-showTaskLabels');

    await test.step('each switch writes its own key and leaves the other alone', async () => {
      await openTaskTab(page);
      await expect(prioritySwitch).toHaveAttribute('aria-checked', 'true');
      await expect(labelsSwitch).toHaveAttribute('aria-checked', 'true');

      await prioritySwitch.click();
      await expect(prioritySwitch).toHaveAttribute('aria-checked', 'false');
      await expect.poll(() => readCardKeys(page), { timeout: 3000 }).toEqual({ priority: false, labels: true });

      await prioritySwitch.click();
      await expect.poll(() => readCardKeys(page), { timeout: 3000 }).toEqual({ priority: true, labels: true });

      await labelsSwitch.click();
      await expect(labelsSwitch).toHaveAttribute('aria-checked', 'false');
      await expect.poll(() => readCardKeys(page), { timeout: 3000 }).toEqual({ priority: true, labels: false });

      // Both off, for the checks below.
      await prioritySwitch.click();
      await expect.poll(() => readCardKeys(page), { timeout: 3000 }).toEqual({ priority: false, labels: false });
      await closeSettings(page);
    });

    await test.step('with both off, board and Done cards draw neither', async () => {
      await expect(card(page, LABELLED_TASK_ID).locator('[data-testid="priority-pill"]')).toHaveCount(0);
      await expect(card(page, LABELLED_TASK_ID).locator('[data-testid="task-pills"]')).toHaveCount(0);
      await expect(card(page, DONE_TASK_ID).locator('[data-testid="task-pills"]')).toHaveCount(0);
      await expect(card(page, DONE_TASK_ID).locator('[data-testid="priority-pill"]')).toHaveCount(0);
    });

    await test.step('with both off, the task window still shows the meter and the labels', async () => {
      // A To Do task opens its edit form, which carries the priority picker and the
      // label chips. A Done task opens the read-only view, whose `task-pills` row is
      // the one TaskPills draws.
      await card(page, DONE_TASK_ID).click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await page.getByRole('tab', { name: 'Description' }).click();
      await expect(dialog.locator('[data-testid="priority-pill"]')).toHaveAccessibleName('Priority: Urgent');
      await expect(dialog.locator('[data-testid="task-pills"]')).toContainText('git');
      // Escape at document level: a dialog holding xterm swallows a keyboard press.
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await dialog.waitFor({ state: 'hidden', timeout: 3000 });
    });

    await test.step('with both off, the Backlog list still shows the priority and labels', async () => {
      await page.locator('[data-testid="view-toggle-backlog"]').click();
      const row = page.locator('[data-testid="backlog-task-row"]', { hasText: BACKLOG_TITLE });
      await row.waitFor({ state: 'visible', timeout: 10000 });
      await expect(row.locator('[data-testid="priority-pill"]')).toHaveCount(1);
      await expect(row.locator('[data-testid="backlog-labels"]')).toContainText('bug');
      await expect(row.locator('[data-testid="backlog-labels"]')).toContainText('ui');
    });
  } finally {
    await browser.close();
  }
});

test('a saved config without the keys reads as on', async () => {
  test.setTimeout(60_000);
  const { browser, page } = await openBoard(true);
  try {
    expect(await readCardKeys(page)).toEqual({ priority: undefined, labels: undefined });
    await expect(card(page, LABELLED_TASK_ID).locator('[data-card-title-row] > [data-testid="priority-pill"]')).toHaveCount(1);
    await expect(card(page, LABELLED_TASK_ID).locator('[data-testid="task-pills"]')).toContainText('ui');

    await openTaskTab(page);
    await expect(page.getByTestId('setting-row-showTaskPriority')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('setting-row-showTaskLabels')).toHaveAttribute('aria-checked', 'true');
  } finally {
    await browser.close();
  }
});
