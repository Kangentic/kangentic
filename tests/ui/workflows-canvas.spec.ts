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

/** A started workflow's two tasks, both in To Do, the second waiting for the first. */
function startedSeedScript(): string {
  return `
    window.__mockWorkflows = [{ workflow: { id: 'wf-running', title: 'Relay reconnect', state: 'running', draft: null } }];
    window.__mockWorkflowLinks = [{ workflow_id: 'wf-running', blocker_task_id: 'run-task-1', blocked_task_id: 'run-task-2' }];
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'workflows-canvas', path: '/mock/workflows-canvas', github_url: null,
        default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'wf-canvas-lane-' + index, position: index, created_at: ts }));
      });
      ['run-task-1', 'run-task-2'].forEach(function (id, index) {
        state.tasks.push({
          id: id, display_id: 40 + index, title: 'Reconnect step ' + (index + 1), description: '',
          swimlane_id: 'wf-canvas-lane-0', position: index, agent: 'claude', session_id: null,
          worktree_path: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null,
          base_branch: null, use_worktree: 0, labels: [], priority: 0, attachment_count: 0, archived_at: null,
          workflow_id: 'wf-running', workflow_project_id: '${PROJECT_ID}',
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
          canvas_x: null, canvas_y: null, created_at: ts, updated_at: ts,
        });
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

const OTHER_PROJECT_ID = 'workflows-canvas-mobile';

/**
 * One project; with `withWorkflow`, one not-started workflow of three tasks and
 * two links. With `acrossBoards`, its third task goes on a second project's board.
 */
function seedScript(withWorkflow: boolean, acrossBoards = false): string {
  const workflows = withWorkflow ? [{
    workflow: {
      id: 'wf-usage', title: 'Usage budgets', state: 'draft',
      draft: {
        tasks: [
          plannedTask('task-1', 'Budget table and repository'),
          plannedTask('task-2', 'Budget checks on spawn'),
          { ...plannedTask('task-3', 'Budgets in board_summary'), project_id: acrossBoards ? OTHER_PROJECT_ID : null },
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
      state.projects.push({
        id: '${OTHER_PROJECT_ID}', name: 'workflows-mobile', path: '/mock/workflows-mobile', github_url: null,
        default_agent: 'claude', group_id: null, position: 1, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'wf-canvas-lane-' + index, position: index, created_at: ts }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(seed: boolean | 'started' | 'acrossBoards'): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seed === 'started' ? startedSeedScript() : seed === 'acrossBoards' ? seedScript(true, true) : seedScript(seed));
  await page.goto(VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);

/**
 * One of a card's two link ports, the one links arrive at (left) or leave from
 * (right). The editable canvas also gives each node a whole-card drop target
 * (handle id "card") on the left, which is not a port and is left out here.
 */
const port = (page: Page, key: string, side: 'left' | 'right') =>
  page.locator(`.react-flow__node[data-id="${key}"] .react-flow__handle-${side}:not([data-handleid="card"])`);

/** The ports sit on the title row, so the node sets where from its own inline `top`, state rather than measured pixels. */
const portTop = (offset: number) => new RegExp(`(^|;)\\s*top:\\s*${offset}px`);

/** A theme token's color as this page computes it, so a style check holds in every theme. */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

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
      // Every task on one board: no card names its project (board 17).
      await expect(page.locator('[data-testid="workflow-card-project"]')).toHaveCount(0);
      // So the title row is the first thing under the strip, and the link ports
      // stay at the middle of it, 49px down.
      for (const key of ['task-1', 'task-2', 'task-3']) {
        await expect(port(page, key, 'left')).toHaveAttribute('style', portTop(49));
        await expect(port(page, key, 'right')).toHaveAttribute('style', portTop(49));
      }
      // A port is a dot ringed in the accent on the canvas's own fill (boards 1, 10).
      const accentForeground = await tokenColor(page, '--color-accent-fg');
      const surface = await tokenColor(page, '--color-surface');
      for (const side of ['left', 'right'] as const) {
        await expect(port(page, 'task-2', side)).toHaveCSS('border-top-color', accentForeground);
        await expect(port(page, 'task-2', side)).toHaveCSS('border-top-width', '2px');
        await expect(port(page, 'task-2', side)).toHaveCSS('background-color', surface);
      }
    } finally {
      await browser.close();
    }
  });

  test('once a task is on another board, every card names its project', async () => {
    const { browser, page } = await launch('acrossBoards');
    try {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(3);
      // Home cards too, not only the one on the other board (board 17).
      await expect(card(page, 'task-1').locator('[data-testid="workflow-card-project"]')).toHaveText('workflows-canvas');
      await expect(card(page, 'task-3').locator('[data-testid="workflow-card-project"]')).toHaveText('workflows-mobile');
      await expect(page.locator('[data-testid="workflow-card-project"]')).toHaveCount(3);
      // The project row (24px) pushes the title row down, and the ports with it:
      // 49 + 24 = 73px on every card, the home ones as well as the other board's.
      for (const key of ['task-1', 'task-2', 'task-3']) {
        await expect(port(page, key, 'left')).toHaveAttribute('style', portTop(73));
        await expect(port(page, key, 'right')).toHaveAttribute('style', portTop(73));
      }
      // The row reads at 12px on a faint fill, its folder in the muted grey.
      const projectRow = card(page, 'task-1').locator('[data-testid="workflow-card-project"]');
      await expect(projectRow).toHaveCSS('font-size', '12px');
      await expect(projectRow).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(projectRow.locator('svg')).toHaveCSS('color', await tokenColor(page, '--color-fg-muted'));
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
      // Selected: a 2px border inside the card, solid on a planned card, with
      // no ring outside it. An unselected planned card keeps its 1px dash.
      await expect(card(page, 'task-2')).toHaveCSS('border-top-width', '2px');
      await expect(card(page, 'task-2')).toHaveCSS('border-top-style', 'solid');
      await expect(card(page, 'task-2')).toHaveCSS('box-shadow', 'none');
      await expect(card(page, 'task-1')).toHaveCSS('border-top-width', '1px');
      await expect(card(page, 'task-1')).toHaveCSS('border-top-style', 'dashed');

      await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
      await expect(card(page, 'task-2')).toHaveAttribute('data-selected', 'false');
      await expect(card(page, 'task-2')).toHaveCSS('border-top-style', 'dashed');

      await card(page, 'task-3').click();
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      await page.keyboard.press('Escape');
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'false');
    } finally {
      await browser.close();
    }
  });

  test('a started task\'s card follows the board when an agent renames it', async () => {
    // An agent's rename (MCP) reloads the board and announces no workflow
    // change, so the card has to read the board's live row, not the workflow's
    // snapshot, or it shows the old title until the view reopens.
    const { browser, page } = await launch('started');
    try {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      await expect(card(page, 'run-task-1')).toContainText('Reconnect step 1');
      await page.evaluate(async (projectId) => {
        await window.electronAPI.tasks.update({ id: 'run-task-1', title: 'Reconnect with backoff' });
        (window as unknown as { __mockFireTaskUpdatedByAgent: (taskId: string, title: string, project: string) => void })
          .__mockFireTaskUpdatedByAgent('run-task-1', 'Reconnect with backoff', projectId);
      }, PROJECT_ID);
      await expect(card(page, 'run-task-1')).toContainText('Reconnect with backoff');
      // A task in To Do that waits shows why, in the card's own footer.
      await expect(card(page, 'run-task-2')).toContainText('Blocked by #40...');
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
