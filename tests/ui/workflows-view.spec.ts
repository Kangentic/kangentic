/**
 * UI tests for the Workflows view around the canvas: the header (picker,
 * Rename, the lifecycle button, Delete, progress, New workflow) in every state
 * and at every width, the inspector (run order, route rail, links, Add
 * blocker, Remove) with the guards it draws, the confirms, the canvas tools,
 * and the board's search applied to the canvas.
 *
 * Every refusal a control shows is the sentence main refuses with
 * (`src/shared/workflow-refusals.ts`), so the disabled reasons asserted here
 * are main's words too.
 *
 * Assertions read state (aria attributes, data attributes, counts), never
 * pixel geometry, except the width sweep, which reads relative edges inside
 * one `page.evaluate` (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflows-view-proj';

/** Board 1's running workflow: two tasks done, one in Merge, one in Executing, five in To Do. */
const RUNNING_TASKS: Array<[number, string, number]> = [
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
const RUNNING_LINKS: Array<[number, number]> = [[411, 413], [412, 414], [413, 415], [413, 416], [414, 417], [415, 418], [416, 418], [417, 418], [419, 418]];

function plannedTask(key: string, title: string): Record<string, unknown> {
  return {
    key, title, description: `${title}, planned by the workflow agent.`, project_id: null, existing_task_id: null,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
    labels: [], priority: 0, canvas_x: null, canvas_y: null,
  };
}

type Seed = 'running' | 'draft' | 'empty-draft' | 'one-task-draft' | 'two';

function seedScript(seed: Seed, sidebarWidth: number): string {
  const draft = {
    workflow: {
      id: 'wf-draft', title: 'Theme tokens', state: 'draft', color_slot: 2,
      draft: seed === 'empty-draft'
        ? { tasks: [], links: [] }
        : seed === 'one-task-draft'
        ? { tasks: [plannedTask('task-1', 'Token table')], links: [] }
        : {
          tasks: [plannedTask('task-1', 'Token table'), plannedTask('task-2', 'Token picker'), plannedTask('task-3', 'Token docs')],
          links: [{ blocker: 'task-1', blocked: 'task-2' }, { blocker: 'task-2', blocked: 'task-3' }],
        },
    },
  };
  const running = { workflow: { id: 'wf-usage', title: 'Usage budgets', state: 'running', draft: null, color_slot: 5 } };
  const workflows = seed === 'running' ? [running] : seed === 'two' ? [running, draft] : [draft];
  const links = seed === 'running' || seed === 'two'
    ? RUNNING_LINKS.map(([blocker, blocked]) => ({ workflow_id: 'wf-usage', blocker_task_id: `t${blocker}`, blocked_task_id: `t${blocked}` }))
    : [];
  const tasks = seed === 'running' || seed === 'two' ? RUNNING_TASKS : [];
  return `
    window.__mockWorkflows = ${JSON.stringify(workflows)};
    window.__mockWorkflowLinks = ${JSON.stringify(links)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.config.sidebar = { width: ${sidebarWidth} };
      state.config.sidebarVisible = true;
      state.projects.push({ id: '${PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: ts }));
      });
      ${JSON.stringify(tasks)}.forEach(function (row, index) {
        state.tasks.push({
          id: 't' + row[0], display_id: row[0], title: row[1], description: 'Planned by the workflow agent.',
          swimlane_id: 'lane-' + row[2], position: index, agent: 'claude', session_id: null, worktree_path: null, branch_name: null,
          pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: 0, labels: [], priority: 0,
          attachment_count: 0, archived_at: row[2] === 6 ? ts : null, workflow_id: 'wf-usage', workflow_project_id: '${PROJECT_ID}',
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
          created_at: ts, updated_at: ts,
        });
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(seed: Seed, options: { width?: number; sidebarWidth?: number } = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: options.width ?? 1600, height: 950 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(seed, options.sidebarWidth ?? 240));
  await page.goto(VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="view-toggle-workflows"]').click();
  await page.locator('[data-testid="workflows-view"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const byTestId = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);
const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);

test.describe('Workflows header', () => {
  test('a running workflow shows Running, its progress, and pauses and resumes in place', async () => {
    const { browser, page } = await launch('running');
    try {
      await expect(byTestId(page, 'workflow-picker')).toContainText('Usage budgets');
      await expect(byTestId(page, 'workflow-picker')).toContainText('9 tasks');
      await expect(byTestId(page, 'workflow-pause')).toHaveAttribute('aria-label', 'Running. Pause workflow');
      await expect(byTestId(page, 'workflow-progress')).toHaveText('2 of 9 done');
      // Two done, one in Merge, one in Executing: four segments.
      await expect(page.locator('[data-testid="workflow-progress-bar"] i')).toHaveCount(4);
      await expect(byTestId(page, 'workflow-counts')).toHaveText('2 in progress, 1 queued, 4 blocked');

      const lifecycleBox = await byTestId(page, 'workflow-pause').boundingBox();
      await byTestId(page, 'workflow-pause').click();
      await expect(byTestId(page, 'workflow-resume')).toBeVisible();
      // The lifecycle button swaps in place: same width, same spot.
      const resumeBox = await byTestId(page, 'workflow-resume').boundingBox();
      expect(Math.abs((resumeBox?.x ?? 0) - (lifecycleBox?.x ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((resumeBox?.width ?? 0) - (lifecycleBox?.width ?? 0))).toBeLessThanOrEqual(1);
      await byTestId(page, 'workflow-resume').click();
      await expect(byTestId(page, 'workflow-pause')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Start confirms with what it creates, then the workflow runs', async () => {
    const { browser, page } = await launch('draft');
    try {
      await expect(byTestId(page, 'workflow-start')).toBeEnabled();
      // No progress before Start.
      await expect(byTestId(page, 'workflow-progress')).toHaveCount(0);
      await byTestId(page, 'workflow-start').click();
      const confirm = byTestId(page, 'workflow-start-confirm');
      await expect(confirm).toContainText('Start Theme tokens?');
      await expect(confirm).toContainText('Creates 3 tasks. They start automatically in the order this workflow sets.');
      await confirm.getByRole('button', { name: 'Start workflow' }).click();
      await expect(byTestId(page, 'workflow-pause')).toBeVisible();
      await expect(byTestId(page, 'workflow-progress')).toHaveText('0 of 3 done');
    } finally {
      await browser.close();
    }
  });

  test('Start\'s confirm reads right for a workflow of one task', async () => {
    const { browser, page } = await launch('one-task-draft');
    try {
      await byTestId(page, 'workflow-start').click();
      await expect(byTestId(page, 'workflow-start-confirm')).toContainText('Creates 1 task. It starts automatically.');
    } finally {
      await browser.close();
    }
  });

  test('Start stays disabled, with the reason, on a workflow with no tasks', async () => {
    const { browser, page } = await launch('empty-draft');
    try {
      await expect(byTestId(page, 'workflow-start')).toBeDisabled();
      await expect(byTestId(page, 'workflow-start')).toHaveAttribute('title', 'This workflow has no tasks yet.');
    } finally {
      await browser.close();
    }
  });

  test('Rename opens with the name selected and renames on Enter', async () => {
    const { browser, page } = await launch('draft');
    try {
      await byTestId(page, 'workflow-rename').click();
      const input = byTestId(page, 'workflow-rename-input');
      await expect(input).toHaveValue('Theme tokens');
      await page.keyboard.type('Design tokens');
      await page.keyboard.press('Enter');
      await expect(byTestId(page, 'workflow-picker')).toContainText('Design tokens');
    } finally {
      await browser.close();
    }
  });

  test('Delete confirms with what goes, and the view falls back to the empty state', async () => {
    const { browser, page } = await launch('draft');
    try {
      await byTestId(page, 'workflow-delete').click();
      const confirm = byTestId(page, 'workflow-delete-confirm');
      await expect(confirm).toContainText('Delete Theme tokens?');
      await expect(confirm).toContainText('Deletes its 3 planned tasks and the agent conversation. Nothing else changes.');
      await confirm.getByRole('button', { name: 'Delete' }).click();
      await expect(byTestId(page, 'workflows-empty')).toBeVisible();
      // New workflow stays in the header with no workflow to show.
      await expect(byTestId(page, 'workflow-new')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('the picker lists each unfinished workflow with its state and switches the canvas', async () => {
    const { browser, page } = await launch('two');
    try {
      await byTestId(page, 'workflow-picker').click();
      const options = page.locator('[data-testid="workflow-picker-option"]');
      await expect(options).toHaveCount(2);
      await expect(options.filter({ hasText: 'Usage budgets' })).toContainText('Running');
      await expect(options.filter({ hasText: 'Theme tokens' })).toContainText('Not started');
      await options.filter({ hasText: 'Theme tokens' }).click();
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(3);
      await expect(byTestId(page, 'workflow-picker')).toContainText('Theme tokens');
    } finally {
      await browser.close();
    }
  });

  test('the header holds at every width from the floor up: no wrap, nothing past its edge', async () => {
    // A 400px sidebar: the header's own width is the viewport minus about 405.
    const { browser, page } = await launch('running', { width: 1700, sidebarWidth: 400 });
    try {
      const wideText = await byTestId(page, 'workflow-header').innerText();
      for (const label of ['Rename', 'Running', 'Delete', '2 of 9 done', '2 in progress', 'New workflow']) {
        expect(wideText, `"${label}" is missing from the header at full width`).toContain(label);
      }
      const broken: string[] = [];
      let baseline = -1;
      for (let width = 900; width <= 1700; width += 20) {
        await page.setViewportSize({ width, height: 700 });
        const reading = await page.evaluate(() => {
          const header = document.querySelector('[data-testid="workflow-header"]') as HTMLElement;
          const row = header.firstElementChild as HTMLElement;
          const style = getComputedStyle(row);
          const contentRight = Math.round(row.getBoundingClientRect().right - parseFloat(style.paddingRight));
          const ids = ['workflow-picker', 'workflow-rename', 'workflow-pause', 'workflow-delete', 'workflow-new'];
          const overflow = ids.filter((id) => {
            const element = document.querySelector(`[data-testid="${id}"]`);
            return element !== null && Math.round(element.getBoundingClientRect().right) > contentRight + 1;
          });
          return { height: Math.round(header.getBoundingClientRect().height), overflow };
        });
        if (baseline < 0) baseline = reading.height;
        if (Math.abs(reading.height - baseline) > 1) broken.push(`${width}px: header is ${reading.height}px, baseline ${baseline}px`);
        for (const id of reading.overflow) broken.push(`${width}px: ${id} ends past the header's edge`);
      }
      expect(broken, 'the header breaks between its steps').toEqual([]);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Workflows inspector', () => {
  test('with nothing selected it shows the run order, and a row selects its card', async () => {
    const { browser, page } = await launch('running');
    try {
      await expect(byTestId(page, 'workflow-inspector-prompt')).toContainText('Select a task');
      // Five tasks with nothing left to wait for start together; then each later step.
      await expect(page.locator('[data-testid="workflow-run-order-row"]')).toHaveCount(9);
      await page.locator('[data-testid="workflow-run-order-row"][data-task-key="t417"]').click();
      await expect(card(page, 't417')).toHaveAttribute('data-selected', 'true');
      await expect(byTestId(page, 'workflow-inspector-title')).toContainText('Suspend a task past its cap');
    } finally {
      await browser.close();
    }
  });

  test('a started task locks what it has reached and says why', async () => {
    const { browser, page } = await launch('running');
    try {
      await card(page, 't414').click();
      // #414 is in Executing: Planning and Executing are reached, the rest can change.
      await expect(byTestId(page, 'workflow-route-switch-lane-1')).toBeDisabled();
      await expect(byTestId(page, 'workflow-route-switch-lane-1')).toHaveAttribute('title', '#414 has reached Executing. Only the columns after it can change.');
      await expect(byTestId(page, 'workflow-route-switch-lane-3')).toBeEnabled();
      await expect(byTestId(page, 'workflow-add-blocker')).toBeDisabled();
      await expect(byTestId(page, 'workflow-add-blocker')).toHaveAttribute('title', '#414 has started. Only a task in To Do can wait for another.');
      // Its blocker #412 is done: removing the link changes nothing.
      const blockedBy = page.locator('[data-testid="workflow-link-row"][data-task-key="t412"] [data-testid="workflow-unlink"]');
      await expect(blockedBy).toBeDisabled();
      await expect(blockedBy).toHaveAttribute('title', '#412 is done. Removing the link changes nothing.');
      // #417 still waits in To Do: removing that link changes something.
      await expect(page.locator('[data-testid="workflow-link-row"][data-task-key="t417"] [data-testid="workflow-unlink"]')).toBeEnabled();

      // A step still ahead switches off.
      await byTestId(page, 'workflow-route-switch-lane-3').click();
      await expect(page.locator('[data-testid="workflow-route-row"]').nth(2)).toHaveAttribute('data-step-state', 'skipped');
    } finally {
      await browser.close();
    }
  });

  test('a card\'s right-click menu is the board\'s, with Open on board and the locked rows disabled', async () => {
    const { browser, page } = await launch('running');
    try {
      await card(page, 't414').click({ button: 'right' });
      const menu = byTestId(page, 'workflow-card-menu');
      await expect(menu).toBeVisible();
      await expect(menu.locator('[data-testid="workflow-card-menu-open-on-board"]')).toBeVisible();
      // The canvas draws every link, so the menu does not offer to show them.
      await expect(menu.locator('[data-testid="context-show-workflow-links"]')).toHaveCount(0);
      await expect(menu.locator('[data-testid="context-move-to"]').filter({ hasText: 'Code Review' }))
        .toHaveAttribute('title', '#414 is locked while Usage budgets runs.');
      await expect(menu.locator('[data-testid="context-archive-task"]')).toHaveAttribute('aria-disabled', 'true');

      // Open on board: Board, with the task's window open.
      await menu.locator('[data-testid="workflow-card-menu-open-on-board"]').click();
      await expect(page.locator('[data-swimlane-name="To Do"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="task-detail-dialog"] [data-testid="task-title-text"]')).toHaveText('Refuse to spawn past the hard cap');
    } finally {
      await browser.close();
    }
  });

  test('a planned card has no board menu', async () => {
    const { browser, page } = await launch('draft');
    try {
      await card(page, 'task-1').click({ button: 'right' });
      await expect(card(page, 'task-1')).toHaveAttribute('data-selected', 'true');
      await expect(byTestId(page, 'workflow-card-menu')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a task in Done cannot be removed, and says why', async () => {
    const { browser, page } = await launch('running');
    try {
      await card(page, 't411').click();
      await expect(byTestId(page, 'workflow-remove-task')).toBeDisabled();
      await expect(byTestId(page, 'workflow-remove-task')).toHaveAttribute('title', '#411 is done and stays with its workflow.');
    } finally {
      await browser.close();
    }
  });

  test('Add blocker lists only what the task can wait for, and links it', async () => {
    const { browser, page } = await launch('running');
    try {
      await card(page, 't419').click();
      await byTestId(page, 'workflow-add-blocker').click();
      const options = page.locator('[data-testid="workflow-add-blocker-option"]');
      // Not the done tasks, not itself, and not #418, which waits for #419 (a loop).
      await expect(options).toHaveCount(5);
      await expect(page.locator('[data-testid="workflow-add-blocker-option"][data-task-key="t418"]')).toHaveCount(0);
      await page.locator('[data-testid="workflow-add-blocker-option"][data-task-key="t414"]').click();
      await expect(page.locator('[data-testid="workflow-link-row"][data-task-key="t414"]')).toBeVisible();
      await expect(card(page, 't419')).toContainText('Blocked by #414...');
    } finally {
      await browser.close();
    }
  });

  test('Remove confirms with the outcome, and the card leaves the canvas', async () => {
    const { browser, page } = await launch('running');
    try {
      await card(page, 't417').click();
      await byTestId(page, 'workflow-remove-task').click();
      const confirm = byTestId(page, 'workflow-remove-confirm');
      await expect(confirm).toContainText('Remove #417 from Usage budgets?');
      await expect(confirm).toContainText('It stays where it is, as an ordinary task.');
      await confirm.getByRole('button', { name: 'Remove' }).click();
      await expect(card(page, 't417')).toHaveCount(0);
      await expect(byTestId(page, 'workflow-inspector-prompt')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

test.describe('Workflows canvas tools and search', () => {
  test('Add task opens New Task without the branch and agent rows, and the card lands selected', async () => {
    const { browser, page } = await launch('draft');
    try {
      await byTestId(page, 'workflow-add-task').click();
      const dialog = byTestId(page, 'new-task-dialog');
      await expect(dialog).toBeVisible();
      // A planned task has no branch, agent or attachments until Start creates it.
      await expect(dialog.getByText('Advanced')).toHaveCount(0);
      await dialog.getByPlaceholder('Task title').fill('Token contrast check');
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(4);
      await expect(page.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toContainText('Token contrast check');
    } finally {
      await browser.close();
    }
  });

  test('a planned task opens in the task form, and Save writes into the workflow', async () => {
    const { browser, page } = await launch('draft');
    try {
      await card(page, 'task-2').dblclick();
      const dialog = byTestId(page, 'new-task-dialog');
      await expect(dialog).toContainText('Edit Task');
      const title = dialog.getByPlaceholder('Task title');
      await expect(title).toHaveValue('Token picker');
      await title.fill('Token picker with search');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(card(page, 'task-2')).toContainText('Token picker with search');
    } finally {
      await browser.close();
    }
  });

  test('drawing a link says what a release does over each card, and links on release', async () => {
    const { browser, page } = await launch('draft');
    try {
      const port = page.locator('.react-flow__node[data-id="task-1"] .react-flow__handle.source').first();
      const portBox = await port.boundingBox();
      const loopTarget = await card(page, 'task-1').boundingBox();
      const target = await card(page, 'task-3').boundingBox();
      if (!portBox || !target || !loopTarget) throw new Error('canvas not laid out');
      await page.mouse.move(portBox.x + portBox.width / 2, portBox.y + portBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
      const hint = byTestId(page, 'workflow-link-hint');
      await expect(hint).toHaveText('Release to make "Token docs" wait for "Token table"');
      await page.mouse.up();
      // The task that now waits is selected, with both of its blockers.
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      await expect(page.locator('[data-testid="workflow-link-row"]')).toHaveCount(2);

      // From the last task back onto the first closes a loop: refused, and said so.
      const lastPort = await page.locator('.react-flow__node[data-id="task-3"] .react-flow__handle.source').first().boundingBox();
      if (!lastPort) throw new Error('no port on the last task');
      await page.mouse.move(lastPort.x + lastPort.width / 2, lastPort.y + lastPort.height / 2);
      await page.mouse.down();
      await page.mouse.move(loopTarget.x + loopTarget.width / 2, loopTarget.y + loopTarget.height / 2, { steps: 12 });
      await expect(byTestId(page, 'workflow-link-hint')).toHaveText('That link closes a loop. A workflow\'s links cannot go in a circle.');
      await page.mouse.up();
      await expect(byTestId(page, 'workflow-link-hint')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Auto layout stays disabled until a card is moved by hand', async () => {
    const { browser, page } = await launch('draft');
    try {
      await expect(byTestId(page, 'workflow-auto-layout')).toBeDisabled();
      await expect(byTestId(page, 'workflow-auto-layout')).toHaveAttribute('title', 'No card has been moved');
      const box = await card(page, 'task-3').boundingBox();
      if (!box) throw new Error('no card to move');
      await page.mouse.move(box.x + box.width / 2, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + 120, { steps: 8 });
      await page.mouse.up();
      await expect(byTestId(page, 'workflow-auto-layout')).toBeEnabled();
      await byTestId(page, 'workflow-auto-layout').click();
      await expect(byTestId(page, 'workflow-auto-layout')).toBeDisabled();
    } finally {
      await browser.close();
    }
  });

  test('the board search hides the cards that do not match, and the run order lists the rest', async () => {
    const { browser, page } = await launch('running');
    try {
      await expect(page.locator('[data-testid="workflow-canvas-card"]:visible')).toHaveCount(9);
      await byTestId(page, 'board-search').fill('budget');
      // Titles with "budget": #411, #412, #415, #416 and #418.
      await expect(page.locator('[data-testid="workflow-run-order-row"]')).toHaveCount(5);
      await expect(page.locator('[data-testid="workflow-canvas-card"]:visible')).toHaveCount(5);
      await byTestId(page, 'board-search').fill('#41');
      await expect(page.locator('[data-testid="workflow-run-order-row"]')).toHaveCount(9);
    } finally {
      await browser.close();
    }
  });
});
