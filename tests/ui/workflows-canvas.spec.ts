/**
 * UI tests for the Workflows view's canvas: the third view, its empty state,
 * a workflow's cards and links drawn on the canvas, selection, and the
 * shortcut that opens the view and returns from it.
 *
 * Assertions read state the view exposes (`data-selected`, the active
 * segment's `aria-checked`, counts of cards and drawn links), never pixel
 * geometry (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflows-canvas-proj';

function plannedTask(key: string, title: string): Record<string, unknown> {
  return {
    key, title, description: `${title}, planned by the workflow agent.`, project_id: null, existing_task_id: null,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
    labels: [], priority: 0, canvas_x: null, canvas_y: null,
  };
}

/** One project; with `withWorkflow`, one not-started workflow of three tasks and two links. */
function seedScript(withWorkflow: boolean): string {
  const workflows = withWorkflow ? [{
    workflow: {
      id: 'wf-usage', title: 'Usage budgets', state: 'draft',
      draft: {
        tasks: [
          plannedTask('task-1', 'Budget table and repository'),
          plannedTask('task-2', 'Budget checks on spawn'),
          plannedTask('task-3', 'Budgets in board_summary'),
        ],
        links: [{ blocker: 'task-1', blocked: 'task-2' }, { blocker: 'task-2', blocked: 'task-3' }],
      },
    },
  }] : [];
  return `
    window.__mockWorkflows = ${JSON.stringify(workflows)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'workflows-canvas', path: '/mock/workflows-canvas', github_url: null,
        default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'wf-canvas-lane-' + index, position: index, created_at: ts }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(withWorkflow: boolean): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(withWorkflow));
  await page.goto(VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);

test.describe('Workflows canvas', () => {
  test('a project with no workflows shows the empty state', async () => {
    const { browser, page } = await launch(false);
    try {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      await expect(page.locator('[data-testid="workflows-empty"]')).toBeVisible();
      await expect(page.locator('[data-testid="workflows-create-first"]')).toHaveText('Create your first workflow');
      // The Workflows segment carries no count with nothing unfinished.
      await expect(page.locator('[data-testid="view-toggle-workflows"]')).toHaveAttribute('aria-label', 'Workflows');
    } finally {
      await browser.close();
    }
  });

  test('draws a workflow\'s cards and the links between them', async () => {
    const { browser, page } = await launch(true);
    try {
      await expect(page.locator('[data-testid="view-toggle-workflows"]')).toHaveAttribute('aria-label', 'Workflows, 1 unfinished');
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(3);
      await expect(card(page, 'task-2')).toContainText('Budget checks on spawn');
      // Two links, one per blocker; the layout puts each task a column right of what it waits for.
      await expect(page.locator('.react-flow__edge')).toHaveCount(2);
      // A not-started task has no ticket number yet.
      await expect(card(page, 'task-1')).not.toContainText('#');
    } finally {
      await browser.close();
    }
  });

  test('a click selects a card, and a click on empty canvas or Escape clears it', async () => {
    const { browser, page } = await launch(true);
    try {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      await expect(card(page, 'task-1')).toBeVisible();

      await card(page, 'task-2').click();
      await expect(card(page, 'task-2')).toHaveAttribute('data-selected', 'true');
      await expect(card(page, 'task-1')).toHaveAttribute('data-selected', 'false');

      await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
      await expect(card(page, 'task-2')).toHaveAttribute('data-selected', 'false');

      await card(page, 'task-3').click();
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      await page.keyboard.press('Escape');
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'false');
    } finally {
      await browser.close();
    }
  });

  test('Mod+Shift+L opens Workflows and returns to the view it came from', async () => {
    const { browser, page } = await launch(true);
    try {
      const segment = (view: string) => page.locator(`[data-testid="view-toggle-${view}"]`);
      await page.locator('body').click({ position: { x: 600, y: 500 } });
      await page.keyboard.press('Control+Shift+L');
      await expect(segment('workflows')).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(3);
      await page.keyboard.press('Control+Shift+L');
      await expect(segment('board')).toHaveAttribute('aria-checked', 'true');

      await segment('backlog').click();
      await page.keyboard.press('Control+Shift+L');
      await expect(segment('workflows')).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Control+Shift+L');
      await expect(segment('backlog')).toHaveAttribute('aria-checked', 'true');
    } finally {
      await browser.close();
    }
  });
});
