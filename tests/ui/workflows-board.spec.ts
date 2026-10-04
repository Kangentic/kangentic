/**
 * UI tests for a workflow's tasks on the board (#732 boards 6, 7 and 8): the
 * workflow strip on a card, the To Do footer that says what a card waits for,
 * the card menu's workflow items and the rows the lock disables with their
 * reasons, a refused move (the toast with Open workflow, and the links
 * overlay), and New workflow from a To Do card.
 *
 * Every reason asserted here is the sentence main refuses with
 * (`src/shared/workflow-refusals.ts`), asked through the same predicate
 * (`src/shared/workflow-lock.ts`). Assertions read state (attributes, text,
 * counts), never pixel geometry (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflows-board-proj';

/** Board 6's running workflow: two done, one in Merge, one in Executing, five in To Do. Lanes by index. */
const TASKS: Array<[number, string, number]> = [
  [411, 'Budgets table and repository', 6],
  [412, 'Budget settings tab', 6],
  [413, 'Roll session cost up to its task', 5],
  [414, 'Refuse to spawn past the hard cap', 2],
  [419, 'Phone alert at 80 percent', 0],
  [415, 'Budget in the card footer', 0],
  [416, 'MCP budgets in board summary', 0],
  [417, 'Suspend a task past its cap', 0],
  [418, 'Docs for budgets', 0],
];
const LINKS: Array<[number, number]> = [[411, 413], [412, 414], [413, 415], [413, 416], [414, 417], [415, 418], [416, 418], [417, 418], [419, 418]];
const LOCKED = '#414 is locked while Usage budgets runs.';

interface Options {
  state?: 'running' | 'paused';
  /** Lane indexes whose column starts no agent: a human gate. */
  gateLanes?: number[];
  /** Override where #414 sits. */
  lane414?: number;
}

function seedScript(options: Options): string {
  const workflow = { workflow: { id: 'wf-usage', title: 'Usage budgets', state: options.state ?? 'running', draft: null, color_slot: 5 } };
  const links = LINKS.map(([blocker, blocked]) => ({ workflow_id: 'wf-usage', blocker_task_id: `t${blocker}`, blocked_task_id: `t${blocked}` }));
  const tasks = TASKS.map(([id, title, lane]) => [id, title, id === 414 && options.lane414 !== undefined ? options.lane414 : lane]);
  return `
    window.__mockWorkflows = ${JSON.stringify([workflow])};
    window.__mockWorkflowLinks = ${JSON.stringify(links)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      var gates = ${JSON.stringify(options.gateLanes ?? [])};
      state.projects.push({ id: '${PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var lane = Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: ts });
        if (gates.indexOf(index) !== -1) lane.auto_spawn = false;
        state.swimlanes.push(lane);
      });
      function row(id, title, lane, workflowId) {
        return {
          id: 't' + id, display_id: id, title: title, description: 'Planned by the workflow agent.',
          swimlane_id: 'lane-' + lane, position: id, agent: 'claude', session_id: null, worktree_path: null, branch_name: null,
          pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: 0, labels: [], priority: 0,
          attachment_count: 0, archived_at: lane === 6 ? ts : null, workflow_id: workflowId, workflow_project_id: workflowId ? '${PROJECT_ID}' : null,
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
          created_at: ts, updated_at: ts,
        };
      }
      ${JSON.stringify(tasks)}.forEach(function (entry) {
        var task = row(entry[0], entry[1], entry[2], 'wf-usage');
        if (task.archived_at) state.archivedTasks.push(task); else state.tasks.push(task);
      });
      // An ordinary task beside them, in To Do.
      state.tasks.push(row(500, 'Split the settings search index', 0, null));
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(options: Options = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1700, height: 950 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(options));
  await page.goto(VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  // The strip appears once the workflow list has loaded.
  await page.locator('[data-task-id="t414"] [data-testid="workflow-card-strip"]').waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page };
}

const boardCard = (page: Page, id: string) => page.locator(`[data-board-lanes] [data-task-id="${id}"]`);
const byTestId = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);

async function openMenu(page: Page, id: string): Promise<void> {
  await boardCard(page, id).click({ button: 'right' });
  await byTestId(page, 'task-context-menu').waitFor({ state: 'visible' });
}

async function dragToColumn(page: Page, id: string, columnName: string): Promise<void> {
  const card = boardCard(page, id);
  const box = await card.boundingBox();
  const targetBox = await page.locator(`[data-board-lanes] [data-testid="swimlane"][data-swimlane-name="${columnName}"]`).boundingBox();
  if (!box || !targetBox) throw new Error('No box for the drag');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY, { steps: 3 });
  await expect(page.locator('.drag-overlay')).toBeVisible({ timeout: 2000 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 120, { steps: 15 });
  await page.mouse.up();
}

test.describe('Workflow tasks on the board', () => {
  test('a workflow card carries the strip with its workflow, step track and lock; an ordinary card does not', async () => {
    const { browser, page } = await launch();
    try {
      const strip = boardCard(page, 't414').locator('[data-testid="workflow-card-strip"]');
      await expect(strip).toContainText('Usage budgets');
      // Planning done, Executing current, Code Review, Testing and Merge ahead.
      await expect(strip.locator('[data-step-state]')).toHaveCount(5);
      await expect(strip.locator('[data-step-state="current"]')).toHaveAttribute('title', 'Executing: now');
      await expect(strip.locator('[data-testid="workflow-card-lock"]')).toHaveAttribute('title', 'Moved by its workflow');
      await expect(boardCard(page, 't500').locator('[data-testid="workflow-card-strip"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a To Do card says what it waits for, or that it is queued', async () => {
    const { browser, page } = await launch();
    try {
      await expect(boardCard(page, 't415').locator('[data-testid="workflow-status-bar"]')).toHaveText('Blocked by #413...');
      await expect(boardCard(page, 't418').locator('[data-testid="workflow-status-bar"]')).toHaveText('Blocked by 4 tasks...');
      await expect(boardCard(page, 't419').locator('[data-testid="workflow-status-bar"]')).toHaveText('Queued...');
      await expect(boardCard(page, 't500').locator('[data-testid="workflow-status-bar"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('the menu of a running workflow card leads with the workflow and keeps its locked rows, disabled with the reason', async () => {
    const { browser, page } = await launch();
    try {
      await openMenu(page, 't414');
      const menu = byTestId(page, 'task-context-menu');
      await expect(menu.locator('[data-testid="context-open-workflow"]')).toBeVisible();
      await expect(menu.locator('[data-testid="context-show-workflow-links"]')).toBeVisible();
      const moveRows = menu.locator('[data-testid="context-move-to"]');
      await expect(moveRows).toHaveCount(5);
      for (const row of await moveRows.all()) await expect(row).toHaveAttribute('aria-disabled', 'true');
      // To Do is refused for any workflow task, in its own words; the rest by the lock.
      await expect(moveRows.filter({ hasText: 'To Do' }))
        .toHaveAttribute('title', '#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
      for (const name of ['Planning', 'Code Review', 'Testing', 'Merge']) {
        await expect(moveRows.filter({ hasText: name })).toHaveAttribute('title', LOCKED);
      }
      for (const testId of ['context-send-to-backlog', 'context-archive-task']) {
        await expect(menu.locator(`[data-testid="${testId}"]`)).toHaveAttribute('title', LOCKED);
      }
      await expect(menu.locator('[data-testid="context-edit-task"]')).not.toHaveAttribute('aria-disabled', 'true');
      await expect(menu.locator('[data-testid="context-new-workflow"]')).toHaveCount(0);

      // A disabled row does nothing: the menu stays and the card stays. (`force`:
      // Playwright will not click an aria-disabled control on its own.)
      await moveRows.filter({ hasText: 'Code Review' }).click({ force: true });
      await expect(menu).toBeVisible();
      await expect(page.locator('[data-swimlane-name="Executing"] [data-task-id="t414"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a paused workflow\'s card moves by hand except to To Do, and Backlog and Archive say to remove it first', async () => {
    const { browser, page } = await launch({ state: 'paused' });
    try {
      await expect(boardCard(page, 't414').locator('[data-testid="workflow-card-lock"]')).toHaveCount(0);
      await expect(boardCard(page, 't419').locator('[data-testid="workflow-status-bar"]')).toHaveText('Paused');
      await openMenu(page, 't414');
      const menu = byTestId(page, 'task-context-menu');
      await expect(menu.locator('[data-testid="context-move-to"]').filter({ hasText: 'To Do' }))
        .toHaveAttribute('title', '#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
      await expect(menu.locator('[data-testid="context-move-to"]').filter({ hasText: 'Code Review' })).not.toHaveAttribute('aria-disabled', 'true');
      await expect(menu.locator('[data-testid="context-send-to-backlog"]')).toHaveAttribute('title', 'Remove #414 from Usage budgets first.');
    } finally {
      await browser.close();
    }
  });

  test('in a human gate, a person may drag the card on to the next column of its route, and nowhere else', async () => {
    // Code Review starts no agent here, so no agent judges its work.
    const { browser, page } = await launch({ gateLanes: [3], lane414: 3 });
    try {
      await expect(boardCard(page, 't414').locator('[data-testid="workflow-card-lock"]')).toHaveCount(0);
      await openMenu(page, 't414');
      const rows = byTestId(page, 'task-context-menu').locator('[data-testid="context-move-to"]');
      await expect(rows.filter({ hasText: 'Testing' })).not.toHaveAttribute('aria-disabled', 'true');
      await expect(rows.filter({ hasText: 'Executing' })).toHaveAttribute('title', LOCKED);
    } finally {
      await browser.close();
    }
  });

  test('a refused drag stays in its column, says why with Open workflow, and shows the card\'s links', async () => {
    const { browser, page } = await launch();
    try {
      await dragToColumn(page, 't414', 'Code Review');
      const toast = page.locator('[data-testid="toast"]').filter({ hasText: LOCKED });
      await expect(toast).toBeVisible();
      await expect(toast.getByRole('button', { name: 'Open workflow' })).toBeVisible();
      await expect(page.locator('[data-swimlane-name="Executing"] [data-task-id="t414"]')).toBeVisible();

      const overlay = byTestId(page, 'workflow-links-overlay');
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');
      // #417 waits for #414, and it is on the board.
      await expect(overlay.locator('[data-link="out:t417"]')).toHaveCount(1);
      // A card with no relation to #414 is dimmed; #417 is not.
      await expect.poll(() => boardCard(page, 't419').evaluate((element) => getComputedStyle(element).opacity)).toBe('0.3');
      await expect.poll(() => boardCard(page, 't417').evaluate((element) => getComputedStyle(element).opacity)).toBe('1');

      await page.keyboard.press('Escape');
      await expect(overlay).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('main refusing a move the board allowed shows main\'s sentence, not a failure', async () => {
    const { browser, page } = await launch({ state: 'paused' });
    try {
      // The workflow resumed in another window between the menu opening and the move.
      await page.evaluate((message) => { (window as unknown as { __mockTaskMoveThrow: string }).__mockTaskMoveThrow = message; }, LOCKED);
      await openMenu(page, 't414');
      await byTestId(page, 'task-context-menu').locator('[data-testid="context-move-to"]').filter({ hasText: 'Code Review' }).click();
      const toast = page.locator('[data-testid="toast"]').filter({ hasText: LOCKED });
      await expect(toast).toBeVisible();
      await expect(toast).not.toContainText('Failed to move task');
      await expect(toast.getByRole('button', { name: 'Open workflow' })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Show workflow links draws the overlay; a press on empty board space clears it', async () => {
    const { browser, page } = await launch();
    try {
      await openMenu(page, 't413');
      await byTestId(page, 'context-show-workflow-links').click();
      const overlay = byTestId(page, 'workflow-links-overlay');
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't413');
      // #413 holds up #415 and #416.
      await expect(overlay.locator('[data-link="out:t415"]')).toHaveCount(1);
      await expect(overlay.locator('[data-link="out:t416"]')).toHaveCount(1);

      // The middle of the Testing column's list, which holds no card. (The board
      // scrolled right to reach #413 in Merge, so a column on the left is off screen.)
      const testing = page.locator('[data-board-lanes] [data-testid="swimlane"][data-swimlane-name="Testing"]');
      await testing.scrollIntoViewIfNeeded();
      const box = await testing.boundingBox();
      if (!box) throw new Error('No Testing column');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(overlay).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Open workflow switches to the Workflows view on that task', async () => {
    const { browser, page } = await launch();
    try {
      await openMenu(page, 't414');
      await byTestId(page, 'context-open-workflow').click();
      await expect(byTestId(page, 'workflows-view')).toBeVisible();
      await expect(byTestId(page, 'workflow-picker')).toContainText('Usage budgets');
      await expect(byTestId(page, 'workflow-inspector-title')).toContainText('Refuse to spawn past the hard cap');
    } finally {
      await browser.close();
    }
  });

  test('New workflow on an ordinary To Do card opens a new workflow from it', async () => {
    const { browser, page } = await launch();
    try {
      await openMenu(page, 't500');
      const menu = byTestId(page, 'task-context-menu');
      await expect(menu.locator('[data-testid="context-open-workflow"]')).toHaveCount(0);
      await menu.locator('[data-testid="context-new-workflow"]').click();
      await expect(byTestId(page, 'workflows-view')).toBeVisible();
      await expect(byTestId(page, 'workflow-picker')).toContainText('Untitled workflow');
      // Not offered on a task that has left To Do.
      await page.locator('[data-testid="view-toggle-board"]').click();
      await openMenu(page, 't414');
      await expect(byTestId(page, 'context-new-workflow')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
