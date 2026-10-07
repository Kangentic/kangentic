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

/** The other board in `across-boards`, whose Done column has its own color. */
const OTHER_PROJECT_ID = 'workflows-view-mobile';
const OTHER_DONE_COLOR = '#a855f7';

/**
 * `paused`: board 11's pair, the running workflow paused yesterday at 18:20
 * beside the draft. `across-boards`: the running workflow with one more task,
 * #420, in Done on another board.
 */
type Seed = 'running' | 'draft' | 'empty-draft' | 'one-task-draft' | 'two' | 'paused' | 'across-boards';

function seedScript(seed: Seed, sidebarWidth: number, iconlessColumn: string | null = null): string {
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
  const running = { workflow: { id: 'wf-usage', title: 'Usage budgets', state: seed === 'paused' ? 'paused' : 'running', draft: null, color_slot: 5 } };
  const hasRunning = seed === 'running' || seed === 'two' || seed === 'paused' || seed === 'across-boards';
  const workflows = seed === 'running' || seed === 'across-boards' ? [running] : seed === 'two' || seed === 'paused' ? [running, draft] : [draft];
  // A task row and a Done column tagged with the other project are on its board.
  const otherBoard = seed === 'across-boards'
    ? `state.projects.push({ id: '${OTHER_PROJECT_ID}', name: 'kangentic-mobile', path: '/mock/kangentic-mobile', github_url: null, default_agent: 'claude', group_id: null, position: 1, last_opened: ts, created_at: ts });
       state.swimlanes.push(Object.assign({}, state.DEFAULT_SWIMLANES[6], { id: 'mobile-done', position: 6, color: '${OTHER_DONE_COLOR}', projectId: '${OTHER_PROJECT_ID}', created_at: ts }));
       state.tasks.push({
         id: 't420', display_id: 420, title: 'Budgets on the phone', description: 'Planned by the workflow agent.',
         swimlane_id: 'mobile-done', position: 0, agent: 'claude', session_id: null, worktree_path: null, branch_name: null,
         pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: 0, labels: [], priority: 0,
         attachment_count: 0, archived_at: ts, workflow_id: 'wf-usage', workflow_project_id: '${PROJECT_ID}', projectId: '${OTHER_PROJECT_ID}',
         route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
         created_at: ts, updated_at: ts,
       });`
    : '';
  const links = hasRunning
    ? RUNNING_LINKS.map(([blocker, blocked]) => ({ workflow_id: 'wf-usage', blocker_task_id: `t${blocker}`, blocked_task_id: `t${blocked}` }))
    : [];
  const tasks = hasRunning ? RUNNING_TASKS : [];
  // Yesterday at 18:20 in the page's own time zone, so the note's day is the page's.
  const pausedAt = seed === 'paused'
    ? `var pausedAt = new Date(); pausedAt.setDate(pausedAt.getDate() - 1); pausedAt.setHours(18, 20, 0, 0);
       window.__mockWorkflows[0].workflow.paused_at = pausedAt.toISOString();`
    : '';
  return `
    window.__mockWorkflows = ${JSON.stringify(workflows)};
    ${pausedAt}
    window.__mockWorkflowLinks = ${JSON.stringify(links)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.config.sidebar = { width: ${sidebarWidth} };
      state.config.sidebarVisible = true;
      state.projects.push({ id: '${PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: ts }));
      });
      ${iconlessColumn ? `state.swimlanes.forEach(function (lane) { if (lane.name === ${JSON.stringify(iconlessColumn)}) lane.icon = null; });` : ''}
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
      ${otherBoard}
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(seed: Seed, options: { width?: number; sidebarWidth?: number; iconlessColumn?: string } = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: options.width ?? 1600, height: 950 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(seed, options.sidebarWidth ?? 240, options.iconlessColumn ?? null));
  await page.goto(VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="view-toggle-workflows"]').click();
  await page.locator('[data-testid="workflows-view"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const byTestId = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);
const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);

/** A CSS color as the page computes it, so a token, a hex and an element's own color compare as one string. */
async function computedColor(page: Page, cssColor: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, cssColor);
}

test.describe('Workflows header', () => {
  test('a running workflow shows Running, its progress, and pauses and resumes in place', async () => {
    const { browser, page } = await launch('running');
    try {
      await expect(byTestId(page, 'workflow-picker')).toContainText('Usage budgets');
      await expect(byTestId(page, 'workflow-picker')).toContainText('9 tasks');
      await expect(byTestId(page, 'workflow-pause')).toHaveAttribute('aria-label', 'Running. Pause workflow');
      // A native tooltip cannot follow the width ladder, so each carries the floor's.
      await expect(byTestId(page, 'workflow-pause')).toHaveAttribute('title', 'Running. Pause workflow');
      await expect(byTestId(page, 'workflow-rename')).toHaveAttribute('title', 'Rename');
      await expect(byTestId(page, 'workflow-delete')).toHaveAttribute('title', 'Delete');
      await expect(byTestId(page, 'workflow-progress')).toHaveText('2 of 9 done');
      // Two done, one in Merge, one in Executing: one continuous done segment,
      // then one segment per working task.
      const segments = page.locator('[data-testid="workflow-progress-bar"] i');
      await expect(segments).toHaveCount(3);
      await expect(segments.first()).toHaveAttribute('data-segment', 'done');
      await expect(page.locator('[data-testid="workflow-progress-bar"] i[data-segment="working"]')).toHaveCount(2);
      // The done segment is the Done column's color, as the board draws Done.
      const doneLaneColor = await page.evaluate(async () => (
        (await window.electronAPI.swimlanes.list()).find((lane) => lane.role === 'done')?.color ?? ''
      ));
      expect(doneLaneColor).not.toBe('');
      expect(await segments.first().evaluate((element) => getComputedStyle(element).backgroundColor))
        .toBe(await computedColor(page, doneLaneColor));
      await expect(byTestId(page, 'workflow-progress-bar')).toHaveAttribute('title', '2 of 9 done. 2 in progress, 1 queued, 4 blocked.');
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
      // The confirm button leads with the header's own Play mark (board J5).
      const startButton = confirm.getByRole('button', { name: 'Start workflow' });
      await expect(startButton.locator('[data-testid="workflow-start-confirm-icon"]')).toHaveCount(1);
      // The other confirms keep a label alone.
      await expect(confirm.getByRole('button', { name: 'Cancel' }).locator('svg')).toHaveCount(0);
      await startButton.click();
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
      // Nothing to select: the inspector shows the empty run order, with no prompt.
      await expect(byTestId(page, 'workflow-run-order')).toContainText('No tasks yet.');
      await expect(byTestId(page, 'workflow-inspector-title')).toHaveCount(0);
      await expect(byTestId(page, 'workflow-inspector-prompt')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('an empty workflow\'s canvas shows the three steps until its first cards land, selected from the run order', async () => {
    const { browser, page } = await launch('empty-draft');
    try {
      const welcome = byTestId(page, 'workflow-canvas-welcome');
      await expect(welcome).toBeVisible();
      await expect(welcome.locator('[data-testid="workflows-empty-illustration"]')).toHaveCount(1);
      await expect(byTestId(page, 'workflow-canvas-welcome-title')).toHaveText('Nothing planned yet');
      const steps = welcome.locator('[data-testid="workflow-canvas-welcome-step"]');
      await expect(steps.locator(':scope > span:first-child')).toHaveText(['1', '2', '3']);
      await expect(steps.locator(':scope > span:last-child')).toHaveText([
        'Tell the workflow agent what to build, and it plans the tasks.',
        'Review the plan, and click a task to change its route or blockers.',
        'Press Start and the tasks run automatically in order until complete.',
      ]);
      // No button: Add task stays in the canvas tools, and the inspector keeps the empty run order.
      await expect(welcome.locator('button, [role="button"], a')).toHaveCount(0);
      await expect(byTestId(page, 'workflow-add-task')).toBeVisible();
      await expect(byTestId(page, 'workflow-run-order')).toContainText('No tasks yet.');

      // The workflow agent's first draft lands while the user watches: two
      // tasks in one change, the second added blocking the first.
      await page.evaluate(async (projectId) => {
        const workflows = window.electronAPI.workflows;
        await workflows.addTask(projectId, 'wf-draft', { title: 'Token docs' });
        await workflows.addTask(projectId, 'wf-draft', { title: 'Token table' });
        await workflows.setLink(projectId, 'wf-draft', 'task-2', 'task-1', true);
      }, PROJECT_ID);
      await expect(welcome).toHaveCount(0);
      // The first in the run order is selected, not the first added.
      await expect(card(page, 'task-2')).toHaveAttribute('data-selected', 'true');
      await expect(card(page, 'task-1')).toHaveAttribute('data-selected', 'false');
      await expect(byTestId(page, 'workflow-inspector-title')).toContainText('Token table');

      // Cleared with tasks present, the selection stays cleared as more land.
      await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
      await expect(page.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toHaveCount(0);
      await page.evaluate(async (projectId) => {
        await window.electronAPI.workflows.addTask(projectId, 'wf-draft', { title: 'Token picker' });
      }, PROJECT_ID);
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(3);
      await expect(page.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toHaveCount(0);
      await expect(welcome).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Rename opens with the name selected and renames on Enter', async () => {
    const { browser, page } = await launch('draft');
    try {
      await byTestId(page, 'workflow-rename').click();
      // The header button's pencil leads the title, as on the other titled dialogs (Final 8).
      const pencil = byTestId(page, 'workflow-rename-icon');
      await expect(pencil).toHaveCount(1);
      expect(await pencil.evaluate((element) => getComputedStyle(element).color)).toBe(await computedColor(page, 'var(--color-fg-muted)'));
      const input = byTestId(page, 'workflow-rename-input');
      await expect(input).toHaveValue('Theme tokens');
      await expect.poll(() => input.evaluate((element) => {
        const field = element as HTMLInputElement;
        return [field.selectionStart, field.selectionEnd];
      })).toEqual([0, 'Theme tokens'.length]);
      // Rename is enabled from the start (board 12).
      await expect(byTestId(page, 'workflow-rename-confirm')).toBeEnabled();
      await page.keyboard.type('Design tokens');
      await page.keyboard.press('Enter');
      await expect(byTestId(page, 'workflow-picker')).toContainText('Design tokens');
    } finally {
      await browser.close();
    }
  });

  test('Rename\'s footer is the confirms\' own: a bordered Cancel, and Rename in the accent\'s text color', async () => {
    const { browser, page } = await launch('draft');
    try {
      await byTestId(page, 'workflow-rename').click();
      const dialog = byTestId(page, 'workflow-rename-dialog');
      await expect(dialog).toBeVisible();
      const cancel = byTestId(page, 'workflow-rename-cancel');
      expect(await cancel.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('solid');
      // The footer sits under a rule, as every confirm's does.
      expect(await cancel.evaluate((element) => {
        const footer = element.closest('.border-t');
        return footer ? getComputedStyle(footer).borderTopStyle : 'none';
      })).toBe('solid');
      // `accent-on` is the token: the label is not left at the body's color.
      const confirm = byTestId(page, 'workflow-rename-confirm');
      expect(await confirm.evaluate((element) => getComputedStyle(element).color))
        .toBe(await computedColor(page, 'var(--color-accent-on)'));

      // The same name renames nothing: the dialog closes and the name stands.
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await expect(byTestId(page, 'workflow-picker')).toContainText('Theme tokens');

      // An empty name cannot rename.
      await byTestId(page, 'workflow-rename').click();
      await byTestId(page, 'workflow-rename-input').fill('   ');
      await expect(byTestId(page, 'workflow-rename-confirm')).toBeDisabled();
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
      // Workflows draw two linked cards, in the view toggle and on every
      // picker row. The list tree is the Changes panel's file tree.
      await expect(byTestId(page, 'view-toggle-workflows').locator('svg.lucide-workflow')).toHaveCount(1);
      await expect(options.locator('svg.lucide-workflow')).toHaveCount(2);
      await expect(page.locator('[data-testid="view-toggle-workflows"] svg.lucide-list-tree, [data-testid="workflow-picker-option"] svg.lucide-list-tree')).toHaveCount(0);
      await expect(options.filter({ hasText: 'Usage budgets' })).toContainText('Running');
      await expect(options.filter({ hasText: 'Theme tokens' })).toContainText('Not started');
      await options.filter({ hasText: 'Theme tokens' }).click();
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(3);
      await expect(byTestId(page, 'workflow-picker')).toContainText('Theme tokens');
      // Another workflow opens on its own first task (Final 4).
      await expect(card(page, 'task-1')).toHaveAttribute('data-selected', 'true');
      await expect(page.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('the picker\'s paused row says when it paused, and its grey chips carry a ring', async () => {
    const { browser, page } = await launch('paused');
    try {
      await byTestId(page, 'workflow-picker').click();
      const pausedRow = page.locator('[data-testid="workflow-picker-option"][data-workflow-id="wf-usage"]');
      const draftRow = page.locator('[data-testid="workflow-picker-option"][data-workflow-id="wf-draft"]');
      // Seeded paused yesterday at 18:20, in the page's time zone (board 11).
      await expect(pausedRow.locator('[data-testid="workflow-picker-note"]')).toHaveText(/^Paused yesterday \S/);
      await expect(pausedRow.locator('[data-testid="workflow-state-chip"]')).toHaveAttribute('data-state', 'paused');
      await expect(draftRow.locator('[data-testid="workflow-state-chip"]')).toHaveAttribute('data-state', 'draft');
      // Paused and Not started: a grey tint inside a ring, as Running's is green.
      for (const chip of [pausedRow.locator('[data-testid="workflow-state-chip"]'), draftRow.locator('[data-testid="workflow-state-chip"]')]) {
        const style = await chip.evaluate((element) => {
          const computed = getComputedStyle(element);
          return { background: computed.backgroundColor, ring: computed.boxShadow, color: computed.color };
        });
        expect(style.ring).toContain('inset');
        expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(style.color).toBe(await computedColor(page, 'var(--color-fg-muted)'));
      }
      await page.keyboard.press('Escape');

      // Resume clears the time; Pause stamps today's.
      await byTestId(page, 'workflow-resume').click();
      await expect(byTestId(page, 'workflow-pause')).toBeVisible();
      await byTestId(page, 'workflow-picker').click();
      await expect(pausedRow.locator('[data-testid="workflow-picker-note"]')).not.toHaveText(/^Paused/);
      await page.keyboard.press('Escape');
      await byTestId(page, 'workflow-pause').click();
      await expect(byTestId(page, 'workflow-resume')).toBeVisible();
      await byTestId(page, 'workflow-picker').click();
      await expect(pausedRow.locator('[data-testid="workflow-picker-note"]')).toHaveText(/^Paused \d/);
    } finally {
      await browser.close();
    }
  });

  test('the header holds at every width from the floor up: no wrap, nothing past its edge', async () => {
    // A 400px sidebar, which Workflows folds on entry: the header is most of the
    // viewport (about 864px at 900), so this sweep holds the wide rungs; the
    // rung test below sets the narrower ones on the header directly.
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

  test('each rung of the header ladder: the floor tightens the row, and the bar narrows by step', async () => {
    const { browser, page } = await launch('running');
    try {
      // The ladder reads the header's own width. At the 900px window the app
      // keeps the sidebar narrow enough that the header stays past 830, so each
      // rung is set on the header directly: 495 is board 11b's floor (a 900px
      // window beside a 400px sidebar), 760 sits between 710 and 830.
      const rungs = [
        { headerWidth: 495, gap: '6px', padding: '12px', barWidth: '48px', dividerWidth: '0px', lifecycleText: '' },
        { headerWidth: 760, gap: '12px', padding: '16px', barWidth: '72px', dividerWidth: '1px', lifecycleText: 'Running' },
        { headerWidth: 1000, gap: '12px', padding: '16px', barWidth: '120px', dividerWidth: '1px', lifecycleText: 'Running' },
      ];
      for (const rung of rungs) {
        const reading = await page.evaluate(async (width) => {
          const header = document.querySelector('[data-testid="workflow-header"]') as HTMLElement;
          header.style.width = `${width}px`;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const row = header.firstElementChild as HTMLElement;
          const style = getComputedStyle(row);
          const contentRight = Math.round(row.getBoundingClientRect().right - parseFloat(style.paddingRight));
          const ids = ['workflow-picker', 'workflow-rename', 'workflow-pause', 'workflow-delete', 'workflow-new'];
          const overflow = ids.filter((id) => {
            const element = document.querySelector(`[data-testid="${id}"]`);
            return element !== null && Math.round(element.getBoundingClientRect().right) > contentRight + 1;
          });
          const bar = document.querySelector('[data-testid="workflow-progress-bar"]') as HTMLElement;
          const divider = document.querySelector('[data-testid="workflow-header-divider"]') as HTMLElement;
          const lifecycle = document.querySelector('[data-testid="workflow-pause"]') as HTMLElement;
          return {
            gap: style.columnGap,
            padding: style.paddingLeft,
            barWidth: getComputedStyle(bar).width,
            dividerWidth: getComputedStyle(divider).width,
            lifecycleText: lifecycle.innerText.trim(),
            overflow,
          };
        }, rung.headerWidth);
        const { headerWidth, ...wanted } = rung;
        expect(reading, `the header at ${headerWidth}px`).toEqual({ ...wanted, overflow: [] });
      }
    } finally {
      await browser.close();
    }
  });
});

test.describe('Workflows inspector', () => {
  test('opens on the first task in the run order; cleared, it shows the run order, and a row selects its card', async () => {
    const { browser, page } = await launch('running');
    try {
      // The first stop's first row is #411, so the inspector opens on it (Final 4).
      await expect(card(page, 't411')).toHaveAttribute('data-selected', 'true');
      await expect(byTestId(page, 'workflow-inspector-title')).toContainText('Budgets table and repository');
      await expect(byTestId(page, 'workflow-inspector-prompt')).toHaveCount(0);

      // A click on empty canvas clears it, and nothing selects it again.
      await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
      await expect(page.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toHaveCount(0);
      await expect(byTestId(page, 'workflow-inspector-prompt')).toHaveCount(0);
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

  test('a link row names its task at weight 500 and its number in monospace, over a footer with no rule', async () => {
    const { browser, page } = await launch('running');
    try {
      await card(page, 't414').click();
      // #412 is done (the check-mark row); #417 waits in To Do (the two-line row).
      for (const [key, title, number] of [['t412', 'Budget settings tab', '#412'], ['t417', 'Suspend a task past its cap', '#417']]) {
        const row = page.locator(`[data-testid="workflow-link-row"][data-task-key="${key}"]`);
        const titleElement = row.locator('[data-testid="workflow-link-title"]');
        const numberElement = row.locator('[data-testid="workflow-link-number"]');
        await expect(titleElement).toHaveText(title);
        await expect(numberElement).toHaveText(number);
        expect(await titleElement.evaluate((element) => getComputedStyle(element).fontWeight)).toBe('500');
        expect(await numberElement.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/mono/i);
      }
      expect(await byTestId(page, 'workflow-inspector-footer').evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
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

  test('a Done card wears the Done column\'s color, and every card\'s 2px border when selected', async () => {
    const { browser, page } = await launch('running');
    try {
      const doneLaneColor = await page.evaluate(async () => (
        (await window.electronAPI.swimlanes.list()).find((lane) => lane.role === 'done')?.color ?? ''
      ));
      expect(doneLaneColor).not.toBe('');
      const doneColor = await computedColor(page, doneLaneColor);
      // The selected border every card shares: 2px of the muted grey at 75%.
      const selectedBorder = await computedColor(page, 'color-mix(in oklab, var(--color-fg-muted) 75%, transparent)');

      // #411 is done and opens selected (the run order's first row): the 2px
      // border inside the card, no ring outside it.
      await expect(card(page, 't411')).toHaveAttribute('data-selected', 'true');
      await expect(card(page, 't411')).toHaveCSS('border-top-width', '2px');
      await expect(card(page, 't411')).toHaveCSS('border-top-color', selectedBorder);
      await expect(card(page, 't411')).toHaveCSS('box-shadow', 'none');
      // #412, done and not selected: 1px in the board's Done column color (Final 1).
      await expect(card(page, 't412')).toHaveCSS('border-top-width', '1px');
      await expect(card(page, 't412')).toHaveCSS('border-top-color', doneColor);
      // A card that is not done keeps its grey edge.
      await expect(card(page, 't415')).toHaveCSS('border-top-color', await computedColor(page, 'var(--color-edge)'));

      // Selecting a card that is not done moves the same border there, and #411 wears the Done color again.
      await card(page, 't414').click();
      await expect(card(page, 't414')).toHaveAttribute('data-selected', 'true');
      await expect(card(page, 't414')).toHaveCSS('border-top-color', selectedBorder);
      await expect(card(page, 't411')).toHaveCSS('border-top-width', '1px');
      await expect(card(page, 't411')).toHaveCSS('border-top-color', doneColor);
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

  // An empty list is a dead end, so with nothing left to wait for the button
  // is disabled and says why, and no menu opens.
  test('Add blocker is disabled with the reason once no task is left to wait for', async () => {
    const { browser, page } = await launch('running');
    try {
      await card(page, 't419').click();
      const addBlocker = byTestId(page, 'workflow-add-blocker');
      const options = page.locator('[data-testid="workflow-add-blocker-option"]');
      for (let remaining = 5; remaining > 0; remaining -= 1) {
        await addBlocker.click();
        await expect(options).toHaveCount(remaining);
        await options.first().click();
        await expect(options).toHaveCount(0);
      }
      await expect(addBlocker).toBeDisabled();
      await expect(addBlocker).toHaveAttribute('title', 'No task it can wait for.');
      await addBlocker.click({ force: true });
      await expect(byTestId(page, 'workflow-add-blocker-menu')).toBeHidden();
    } finally {
      await browser.close();
    }
  });

  // The board's column header resolves a column's glyph as icon, then its To Do
  // or Done default, then a dot in its color, and the phone's strip does the
  // same. So a column with no icon is a dot here too, never a stand-in square.
  test('a column with no icon is a dot in its color on the card strip and the route rail; a column with one keeps it', async () => {
    const { browser, page } = await launch('running', { iconlessColumn: 'Executing' });
    try {
      const executingColor = await computedColor(page, '#3b82f6');

      // #414 works in Executing, which has no icon: its marker holds the dot.
      const executingStrip = card(page, 't414').locator('[data-testid="workflow-card-strip"]');
      const stripDot = executingStrip.locator('[data-testid="workflow-step-marker"] [data-testid="column-glyph-dot"]');
      await expect(stripDot).toHaveCount(1);
      // The dot is 8px, centered in the marker's 12px glyph box, as the phone draws it.
      await expect(stripDot).toHaveCSS('width', '12px');
      await expect(stripDot.locator('span')).toHaveCSS('width', '8px');
      await expect(stripDot.locator('span')).toHaveCSS('background-color', executingColor);

      // #413 works in Merge, which has an icon: its strip keeps it.
      const mergeStrip = card(page, 't413').locator('[data-testid="workflow-card-strip"]');
      await expect(mergeStrip.locator('[data-testid="column-glyph-dot"]')).toHaveCount(0);
      await expect(mergeStrip.locator('svg').first()).toBeVisible();

      // The inspector's route rail draws Executing the same way.
      await card(page, 't414').click();
      const executingRow = page.locator('[data-testid="workflow-route-row"]').filter({ hasText: 'Executing' });
      await expect(executingRow.locator('[data-testid="column-glyph-dot"]')).toHaveCount(1);
      const mergeRow = page.locator('[data-testid="workflow-route-row"]').filter({ hasText: 'Merge' });
      await expect(mergeRow.locator('[data-testid="column-glyph-dot"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // The phone's strip design, matched: the track's current step is the
  // column's own marker, so the strip names no column, and a task off its
  // route (To Do, Done) shows that column's marker alone, uncolored.
  test('a canvas card names its column by the marker in its track, never in words', async () => {
    const { browser, page } = await launch('running');
    try {
      // #414 works in Executing: no column name on the strip, the name on the marker.
      const strip = card(page, 't414').locator('[data-testid="workflow-card-strip"]');
      await expect(strip).not.toContainText('Executing');
      const marker = strip.locator('[data-testid="workflow-step-marker"]');
      await expect(marker).toHaveAttribute('data-step-state', 'current');
      await expect(marker).toHaveAttribute('aria-label', 'Executing: now');
      await expect(marker).toHaveCSS('background-color', await computedColor(page, 'color-mix(in srgb, #3b82f6 18%, transparent)'));
      await expect(marker.locator('svg')).toHaveCSS('color', await computedColor(page, '#3b82f6'));
      // The marker is the one color in the track: Planning, done, is neutral.
      const doneStep = strip.locator('[data-step-state="done"]');
      await expect(doneStep).toHaveCSS('background-color', await computedColor(page, 'var(--color-fg-faint)'));
      await expect(doneStep).toHaveCSS('opacity', '0.55');

      // #415 waits in To Do: the To Do marker alone, in the faint grey, with no step marks.
      const toDoTrack = card(page, 't415').locator('[data-testid="workflow-step-track"]');
      const toDoMarker = toDoTrack.locator('[data-testid="workflow-step-marker"]');
      await expect(toDoMarker).toHaveAttribute('data-outside-route', 'todo');
      await expect(toDoMarker).toHaveAttribute('aria-label', 'To Do');
      await expect(toDoMarker.locator('svg')).toHaveCSS('color', await computedColor(page, 'var(--color-fg-faint)'));
      await expect(toDoTrack.locator('[data-step-state]')).toHaveCount(0);
      await expect(card(page, 't415').locator('[data-testid="workflow-card-strip"]')).not.toContainText('To Do');

      // #411 is done: the Done marker alone.
      const doneMarker = card(page, 't411').locator('[data-testid="workflow-step-marker"]');
      await expect(doneMarker).toHaveAttribute('data-outside-route', 'done');
      await expect(doneMarker).toHaveAttribute('aria-label', 'Done');
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
      // The selection moves to the run order's first task, not to a prompt (Final 4).
      await expect(card(page, 't411')).toHaveAttribute('data-selected', 'true');
      await expect(byTestId(page, 'workflow-inspector-title')).toContainText('Budgets table and repository');
      await expect(byTestId(page, 'workflow-inspector-prompt')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Workflows across boards', () => {
  test('a Done card on another board wears that board\'s Done color, and the open board\'s keep its own', async () => {
    const { browser, page } = await launch('across-boards');
    try {
      const homeDoneColor = await page.evaluate(async () => (
        (await window.electronAPI.swimlanes.list()).find((lane) => lane.role === 'done')?.color ?? ''
      ));
      expect(homeDoneColor).not.toBe(OTHER_DONE_COLOR);
      const otherDone = await computedColor(page, OTHER_DONE_COLOR);
      const homeDone = await computedColor(page, homeDoneColor);
      // #411 opens selected; #412 (this board) and #420 (the other) are Done and not.
      await expect(card(page, 't411')).toHaveAttribute('data-selected', 'true');
      await expect(card(page, 't420')).toHaveCSS('border-top-width', '1px');
      await expect(card(page, 't420')).toHaveCSS('border-top-color', otherDone);
      await expect(card(page, 't412')).toHaveCSS('border-top-color', homeDone);

      // The inspector's route ends in that board's Done too.
      const doneMark = byTestId(page, 'workflow-route-done').locator('.lucide-circle-check-big');
      await card(page, 't420').click();
      await expect(doneMark).toHaveCSS('color', otherDone);
      await card(page, 't412').click();
      await expect(doneMark).toHaveCSS('color', homeDone);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Workflows canvas tools and search', () => {
  test('Add task opens New Task with the board form\'s project, base branch and run rows, and the card lands selected', async () => {
    const { browser, page } = await launch('draft');
    try {
      await byTestId(page, 'workflow-add-task').click();
      const dialog = byTestId(page, 'new-task-dialog');
      await expect(dialog).toBeVisible();
      // The board's own rows (sign-offs 9 and 25), less the branch name and
      // attachments, which a task gets once Start creates it.
      await expect(dialog.locator('input[data-testid="workflow-task-project"]')).toHaveValue('kangentic');
      await expect(dialog.locator('[data-testid="task-branch-row"]')).toBeVisible();
      await expect(dialog.locator('[data-testid="task-run-mode"]')).toBeVisible();
      await expect(dialog.locator('[data-testid="custom-branch-name-input"]')).toHaveCount(0);
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
    // Its own browser plus two drags, slow under a full gate's load.
    test.setTimeout(30_000);
    const { browser, page } = await launch('draft');
    // A press on a port and a first step, then the canvas's own word that a
    // link is being drawn, so the moves after it cannot run ahead of the drag.
    const pressPort = async (portBox: { x: number; y: number; width: number; height: number }): Promise<void> => {
      const start = { x: portBox.x + portBox.width / 2, y: portBox.y + portBox.height / 2 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 8, start.y + 8, { steps: 2 });
      await expect(byTestId(page, 'workflow-canvas')).toHaveAttribute('data-linking', '', { timeout: 15_000 });
    };
    try {
      const port = page.locator('.react-flow__node[data-id="task-1"] .react-flow__handle.source').first();
      const portBox = await port.boundingBox();
      const loopTarget = await card(page, 'task-1').boundingBox();
      const target = await card(page, 'task-3').boundingBox();
      if (!portBox || !target || !loopTarget) throw new Error('canvas not laid out');
      await pressPort(portBox);
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
      const hint = byTestId(page, 'workflow-link-hint');
      await expect(hint).toHaveText('Release to make "Token docs" wait for "Token table"', { timeout: 15_000 });
      await page.mouse.up();
      // The task that now waits is selected, with both of its blockers.
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      await expect(page.locator('[data-testid="workflow-link-row"]')).toHaveCount(2);

      // From the last task back onto the first closes a loop: refused, and said so.
      const lastPort = await page.locator('.react-flow__node[data-id="task-3"] .react-flow__handle.source').first().boundingBox();
      if (!lastPort) throw new Error('no port on the last task');
      await pressPort(lastPort);
      await page.mouse.move(loopTarget.x + loopTarget.width / 2, loopTarget.y + loopTarget.height / 2, { steps: 12 });
      await expect(byTestId(page, 'workflow-link-hint')).toHaveText('That link closes a loop. A workflow\'s links cannot go in a circle.', { timeout: 15_000 });
      await page.mouse.up();
      await expect(byTestId(page, 'workflow-link-hint')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a task that waits for nothing sits in the column just before the task that waits on it', async () => {
    const { browser, page } = await launch('running');
    try {
      // The column a node sits in, from the translate React Flow writes on it: state, not a measured box.
      const columnOf = (key: string) => page.locator(`.react-flow__node[data-id="${key}"]`).evaluate((element) => (
        /translate\(\s*(-?[\d.]+)px/.exec((element as HTMLElement).style.transform)?.[1] ?? ''
      ));
      await expect(card(page, 't419')).toBeVisible();
      // #419 waits for nothing and only #418 waits on it: it sits beside #418's
      // other blockers (#415, #416, #417), not with the first tasks (Final 2).
      const column419 = await columnOf('t419');
      expect(column419).not.toBe('');
      expect(column419).toBe(await columnOf('t415'));
      expect(await columnOf('t411')).toBe(await columnOf('t412'));
      expect(column419).not.toBe(await columnOf('t411'));
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
      // The run order shows with nothing selected, and the workflow opens on its first task.
      await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
      await expect(page.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toHaveCount(0);
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
