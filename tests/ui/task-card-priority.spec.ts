/**
 * UI tests for priority on the task card (#1053).
 *
 * Intent: a task's priority is the first pill in the row that holds its labels,
 * with a leading flag so an orange level and an orange label read apart. The
 * bottom entry of the scale (index 0, "None" by default) draws nothing, so a
 * board where nobody sets priority looks as it did. A card whose only pill is
 * its priority keeps the rule above its footer, as a labelled card does. The
 * task detail header carries no priority badge any more.
 *
 * Only a browser proves these: the order inside one wrap row, a computed
 * border, and what a live update of the board store repaints.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-card-priority';
const LABELLED_TASK_ID = 'task-priority-labelled';
const NONE_TASK_ID = 'task-priority-none';
const TRAIL_TASK_ID = 'task-priority-trail';
const TRAIL_SESSION_ID = 'session-priority-trail';
const DONE_TASK_ID = 'task-priority-done';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Card Priority Test', path: '/mock/card-priority-test',
      github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-priority-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
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
      id: '${LABELLED_TASK_ID}', display_id: 1048, title: 'Show failing checks on the card',
      swimlane_id: laneIds['To Do'], position: 0, priority: 3, labels: ['ui', 'git'],
    }));
    state.tasks.push(task({
      id: '${NONE_TASK_ID}', display_id: 1050, title: 'Rename the base picker local',
      swimlane_id: laneIds['To Do'], position: 1, priority: 0, labels: ['refactor'],
    }));
    // Running, with an agent trail and a priority but no labels: the card the
    // footer rule's trail-only exception used to strip.
    state.sessions.push({
      id: '${TRAIL_SESSION_ID}', taskId: '${TRAIL_TASK_ID}', projectId: '${PROJECT_ID}', pid: 9001,
      status: 'running', shell: 'bash', cwd: '/mock/card-priority-test', startedAt: timestamp,
      exitCode: null, resuming: false, agentSessionId: 'agent-priority-trail',
    });
    state.activityCache['${TRAIL_SESSION_ID}'] = 'thinking';
    state.messageTrailCache['${TRAIL_SESSION_ID}'] = [{ uuid: 't1', ts: 1, text: 'The tap works.' }];
    state.tasks.push(task({
      id: '${TRAIL_TASK_ID}', display_id: 1040, title: 'Install channels', agent: 'claude',
      session_id: '${TRAIL_SESSION_ID}', swimlane_id: laneIds['Executing'], position: 0, priority: 2,
    }));
    state.archivedTasks.push(task({
      id: '${DONE_TASK_ID}', display_id: 1035, title: 'Base a task on a tag',
      swimlane_id: laneIds['Done'], position: 0, priority: 4, labels: ['git'], archived_at: timestamp,
    }));
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await gotoVite(page, VITE_URL);
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator(`[data-task-id="${LABELLED_TASK_ID}"]`).waitFor({ state: 'visible', timeout: 15000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Task card priority pill', () => {
  test('leads the label row with a flag and the level name', async () => {
    const pills = page.locator(`[data-task-id="${LABELLED_TASK_ID}"] [data-testid="task-pills"]`);
    await expect(pills).toBeVisible();
    const first = pills.locator('> *').first();
    await expect(first).toHaveAttribute('data-testid', 'priority-pill');
    await expect(first).toHaveText('High');
    await expect(first.locator('svg.lucide-flag')).toHaveCount(1);
    await expect(pills.locator('> *')).toHaveText(['High', 'ui', 'git']);
  });

  test('the bottom entry of the scale draws no pill', async () => {
    const card = page.locator(`[data-task-id="${NONE_TASK_ID}"]`);
    await expect(card.locator('[data-testid="task-pills"]')).toHaveText('refactor');
    await expect(card.locator('[data-testid="priority-pill"]')).toHaveCount(0);
  });

  test('a priority-only card under an agent trail keeps the rule above its footer', async () => {
    const card = page.locator(`[data-task-id="${TRAIL_TASK_ID}"]`);
    // The trail must be showing, or the rule is there for the old reason and
    // this passes without the fix.
    await expect(card.locator('[data-testid="task-card-trail"]')).toBeVisible();
    await expect(card.locator('[data-testid="priority-pill"]')).toHaveText('Medium');
    const footer = card.locator('[data-testid="usage-bar"], [data-testid="status-bar"]').first();
    await expect(footer).toBeVisible();
    await expect.poll(() => footer.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('solid');
  });

  test('the Done list row shows the pill', async () => {
    const row = page.locator(`[data-task-id="${DONE_TASK_ID}"]`);
    await expect(row.locator('[data-testid="priority-pill"]')).toHaveText('Urgent');
  });

  test('an agent update to priority repaints the card without a reload', async () => {
    await page.evaluate(async ({ taskId, projectId }) => {
      await window.electronAPI.tasks.update({ id: taskId, priority: 4 });
      const fire = (window as unknown as { __mockFireTaskUpdatedByAgent?: (id: string, title: string, project: string) => void }).__mockFireTaskUpdatedByAgent;
      fire?.(taskId, 'Rename the base picker local', projectId);
    }, { taskId: NONE_TASK_ID, projectId: PROJECT_ID });
    await expect(page.locator(`[data-task-id="${NONE_TASK_ID}"] [data-testid="priority-pill"]`)).toHaveText('Urgent');
  });

  test('the task detail header carries no priority badge', async () => {
    await page.locator(`[data-task-id="${TRAIL_TASK_ID}"]`).click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.locator('[data-testid="task-display-id"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="priority-pill"]')).toHaveCount(0);
  });
});
