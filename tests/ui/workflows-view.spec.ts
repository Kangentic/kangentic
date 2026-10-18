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
import { waitForViteReady, gotoVite, computedColor, pressPortToStartLink } from './helpers';

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

/** The project of a blocker no board here has: see `SeedExtras.missingBlocker`. */
const MISSING_PROJECT_ID = 'workflows-view-missing';

/**
 * `paused`: board 11's pair, the running workflow paused yesterday at 18:20
 * beside the draft. `across-boards`: the running workflow with one more task,
 * #420, in Done on another board. `all-done`: the running workflow with every
 * task in Done, which has nothing left to run and is still listed.
 */
type Seed = 'running' | 'draft' | 'empty-draft' | 'one-task-draft' | 'two' | 'paused' | 'across-boards' | 'all-done';

/** What a test adds to a seed beyond its workflows; each is off unless asked for. */
interface SeedExtras {
  /** A running agent session on this task of the running workflow, as a started task has. */
  sessionTaskId?: string;
  /** The "Delete task" confirm is skipped, as after its "Don't ask again". */
  skipDeleteConfirm?: boolean;
  /**
   * #419 also waits for a task no board here has, on a project that is either
   * unreadable (its link holds) or gone (the engine drops its link).
   */
  missingBlocker?: 'unreadable' | 'gone';
}

function seedScript(seed: Seed, sidebarWidth: number, iconlessColumn: string | null = null, extras: SeedExtras = {}): string {
  // Both planned by their own workflow agent, so the pane starts it on open: a
  // plan with no agent recorded opens with nothing started.
  const draft = {
    workflow: {
      id: 'wf-draft', title: 'Theme tokens', state: 'draft', color_slot: 2, agent_name: 'claude',
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
  const running = { workflow: { id: 'wf-usage', title: 'Usage budgets', state: seed === 'paused' ? 'paused' : 'running', draft: null, color_slot: 5, agent_name: 'claude' } };
  const hasRunning = seed === 'running' || seed === 'two' || seed === 'paused' || seed === 'across-boards' || seed === 'all-done';
  const workflows = seed === 'running' || seed === 'across-boards' || seed === 'all-done' ? [running] : seed === 'two' || seed === 'paused' ? [running, draft] : [draft];
  // A task row and a Done column tagged with the other project are on its board.
  const otherBoard = seed === 'across-boards'
    ? `state.projects.push({ id: '${OTHER_PROJECT_ID}', name: 'kangentic-mobile', path: '/mock/kangentic-mobile', github_url: null, default_agent: 'claude', group_id: null, position: 1, last_opened: seededAt, created_at: seededAt });
       state.swimlanes.push(Object.assign({}, state.DEFAULT_SWIMLANES[6], { id: 'mobile-done', position: 6, color: '${OTHER_DONE_COLOR}', projectId: '${OTHER_PROJECT_ID}', created_at: seededAt }));
       state.tasks.push({
         id: 't420', display_id: 420, title: 'Budgets on the phone', description: 'Planned by the workflow agent.',
         swimlane_id: 'mobile-done', position: 0, agent: 'claude', session_id: null, worktree_path: null, branch_name: null,
         pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: 0, labels: [], priority: 0,
         attachment_count: 0, archived_at: seededAt, workflow_id: 'wf-usage', workflow_project_id: '${PROJECT_ID}', projectId: '${OTHER_PROJECT_ID}',
         route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
         created_at: seededAt, updated_at: seededAt,
       });`
    : '';
  const links: Array<Record<string, string>> = hasRunning
    ? RUNNING_LINKS.map(([blocker, blocked]) => ({ workflow_id: 'wf-usage', blocker_task_id: `t${blocker}`, blocked_task_id: `t${blocked}` }))
    : [];
  if (extras.missingBlocker) {
    links.push({ workflow_id: 'wf-usage', blocker_task_id: 't900', blocked_task_id: 't419', blocker_project_id: MISSING_PROJECT_ID });
  }
  const unreadable = extras.missingBlocker === 'unreadable' ? `window.__mockUnreadableProjects = ['${MISSING_PROJECT_ID}'];` : '';
  // Lane 6 is Done: `all-done` puts every one of the running workflow's tasks there.
  const tasks = seed === 'all-done' ? RUNNING_TASKS.map(([number, title]) => [number, title, 6]) : hasRunning ? RUNNING_TASKS : [];
  const sessionSeed = extras.sessionTaskId
    ? `state.tasks.find(function (task) { return task.id === '${extras.sessionTaskId}'; }).session_id = 'sess-${extras.sessionTaskId}';
       state.sessions.push({
         id: 'sess-${extras.sessionTaskId}', taskId: '${extras.sessionTaskId}', projectId: '${PROJECT_ID}',
         pid: 9414, status: 'running', shell: 'bash', cwd: '/mock/kangentic', startedAt: seededAt, exitCode: null,
       });`
    : '';
  // Yesterday at 18:20 in the page's own time zone, so the note's day is the page's.
  const pausedAt = seed === 'paused'
    ? `var pausedAt = new Date(); pausedAt.setDate(pausedAt.getDate() - 1); pausedAt.setHours(18, 20, 0, 0);
       window.__mockWorkflows[0].workflow.paused_at = pausedAt.toISOString();`
    : '';
  return `
    window.__mockWorkflows = ${JSON.stringify(workflows)};
    ${pausedAt}
    window.__mockWorkflowLinks = ${JSON.stringify(links)};
    ${unreadable}
    window.__mockPreConfigure(function (state) {
      var seededAt = new Date().toISOString();
      state.config.sidebar = { width: ${sidebarWidth} };
      state.config.sidebarVisible = true;
      // The Workflow agent, so each workflow's agent starts as in a set-up install.
      state.config.workflows = { agent: 'claude', model: 'haiku', effort: null };
      ${extras.skipDeleteConfirm ? 'state.config.skipDeleteConfirm = true;' : ''}
      state.projects.push({ id: '${PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: seededAt, created_at: seededAt });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: seededAt }));
      });
      ${iconlessColumn ? `state.swimlanes.forEach(function (lane) { if (lane.name === ${JSON.stringify(iconlessColumn)}) lane.icon = null; });` : ''}
      ${JSON.stringify(tasks)}.forEach(function (row, index) {
        state.tasks.push({
          id: 't' + row[0], display_id: row[0], title: row[1], description: 'Planned by the workflow agent.',
          swimlane_id: 'lane-' + row[2], position: index, agent: 'claude', session_id: null, worktree_path: null, branch_name: null,
          pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: 0, labels: [], priority: 0,
          attachment_count: 0, archived_at: row[2] === 6 ? seededAt : null, workflow_id: 'wf-usage', workflow_project_id: '${PROJECT_ID}',
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
          created_at: seededAt, updated_at: seededAt,
        });
      });
      ${otherBoard}
      ${sessionSeed}
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(seed: Seed, options: { width?: number; sidebarWidth?: number; iconlessColumn?: string } & SeedExtras = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: options.width ?? 1600, height: 950 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(seed, options.sidebarWidth ?? 240, options.iconlessColumn ?? null, {
    sessionTaskId: options.sessionTaskId,
    skipDeleteConfirm: options.skipDeleteConfirm,
    missingBlocker: options.missingBlocker,
  }));
  await gotoVite(page, VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="view-toggle-workflows"]').click();
  await page.locator('[data-testid="workflows-view"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const byTestId = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);
const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);

/**
 * Presses a canvas card and drags it by hand: a stepped move down and to the
 * right, then release. The pointer is read from the card's live box right
 * before the press (`.claude/rules/cross-platform-parity.md`).
 */
async function dragCardByHand(page: Page, key: string): Promise<void> {
  const box = await card(page, key).boundingBox();
  if (!box || box.width === 0) throw new Error('card not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 120, { steps: 8 });
  await page.mouse.up();
}

/** A card's outgoing port, where a link starts. */
const outgoingPort = (page: Page, key: string) => page.locator(`.react-flow__node[data-id="${key}"] .react-flow__handle.source`).first();

test.describe('Workflows header', () => {
  test('the Workflows segment shows the working mark while a workflow runs, and no count', async () => {
    const { browser, page } = await launch('running');
    try {
      const segment = byTestId(page, 'view-toggle-workflows');
      const mark = byTestId(page, 'view-toggle-workflows-running');
      await expect(mark).toBeVisible();
      await expect(segment).toHaveAttribute('aria-label', 'Workflows, running');
      // The segment says whether work moves on its own, not how many workflows exist.
      await expect(segment).toHaveText('Workflows');
      expect(await mark.evaluate((element) => getComputedStyle(element).color))
        .toBe(await computedColor(page, 'var(--color-active)'));

      // Paused, nothing runs: the mark goes, and comes back on Resume.
      await byTestId(page, 'workflow-pause').click();
      await expect(byTestId(page, 'workflow-resume')).toBeVisible();
      await expect(mark).toHaveCount(0);
      await expect(segment).toHaveAttribute('aria-label', 'Workflows');
      await byTestId(page, 'workflow-resume').click();
      await expect(mark).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a workflow not started yet puts no mark on the Workflows segment', async () => {
    const { browser, page } = await launch('draft');
    try {
      await expect(byTestId(page, 'workflow-start')).toBeVisible();
      await expect(byTestId(page, 'view-toggle-workflows-running')).toHaveCount(0);
      await expect(byTestId(page, 'view-toggle-workflows')).toHaveAttribute('aria-label', 'Workflows');
    } finally {
      await browser.close();
    }
  });

  test('a running workflow shows Running, its progress, and pauses and resumes in place', async () => {
    const { browser, page } = await launch('running');
    try {
      await expect(byTestId(page, 'workflow-picker')).toContainText('Usage budgets');
      await expect(byTestId(page, 'workflow-picker')).toContainText('9 tasks');
      await expect(byTestId(page, 'workflow-pause')).toHaveAttribute('aria-label', 'Running. Pause workflow');
      // A tip cannot follow the width ladder, so each is named, and tipped, with the floor's text.
      await expect(byTestId(page, 'workflow-pause')).toHaveAccessibleName('Running. Pause workflow');
      await expect(byTestId(page, 'workflow-rename')).toHaveAccessibleName('Rename');
      await expect(byTestId(page, 'workflow-delete')).toHaveAccessibleName('Delete');
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
      await expect(byTestId(page, 'workflow-progress-bar')).toHaveAccessibleName('2 of 9 done. 2 in progress, 1 queued, 4 blocked.');
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
      await expect(byTestId(page, 'workflow-start')).toHaveAccessibleDescription('This workflow has no tasks yet.');
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

  test('Delete on a workflow whose tasks are all done says they stay, and counts no unfinished tasks', async () => {
    const { browser, page } = await launch('all-done');
    try {
      // The premise: every task is done and the workflow is still listed, with Delete live.
      await expect(byTestId(page, 'workflow-progress')).toHaveText('9 of 9 done');
      await byTestId(page, 'workflow-delete').click();
      const confirm = byTestId(page, 'workflow-delete-confirm');
      await expect(confirm).toContainText('Delete Usage budgets?');
      await expect(confirm).toContainText('Its tasks are done and stay where they are. The agent conversation is deleted.');
      await expect(confirm).not.toContainText('unfinished');
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

      // Resume takes the paused note away; Pause stamps today's time. The row is
      // read as running first, so the note's absence is the resumed row's, not a
      // row that never rendered.
      await byTestId(page, 'workflow-resume').click();
      await expect(byTestId(page, 'workflow-pause')).toBeVisible();
      await byTestId(page, 'workflow-picker').click();
      await expect(pausedRow.locator('[data-testid="workflow-state-chip"]')).toHaveAttribute('data-state', 'running');
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
      await expect(byTestId(page, 'workflow-route-switch-lane-1')).toHaveAccessibleDescription('#414 has reached Executing. Only the columns after it can change.');
      await expect(byTestId(page, 'workflow-route-switch-lane-3')).toBeEnabled();
      await expect(byTestId(page, 'workflow-add-blocker')).toBeDisabled();
      await expect(byTestId(page, 'workflow-add-blocker')).toHaveAccessibleDescription('#414 has started. Only a task in To Do can wait for another.');
      // Its blocker #412 is done: removing the link changes nothing.
      const blockedBy = page.locator('[data-testid="workflow-link-row"][data-task-key="t412"] [data-testid="workflow-unlink"]');
      await expect(blockedBy).toBeDisabled();
      await expect(blockedBy).toHaveAccessibleDescription('#412 is done. Removing the link changes nothing.');
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
        .toHaveAccessibleDescription('#414 is locked while Usage budgets runs.');
      await expect(menu.locator('[data-testid="context-archive-task"]')).toHaveAttribute('aria-disabled', 'true');

      // Open on board: Board, with the task's window open.
      await menu.locator('[data-testid="workflow-card-menu-open-on-board"]').click();
      await expect(page.locator('[data-swimlane-name="To Do"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="task-detail-dialog"] [data-testid="task-title-text"]')).toHaveText('Refuse to spawn past the hard cap');
    } finally {
      await browser.close();
    }
  });

  test('Delete from a card whose session will not stop warns, keeps the task, and raises no unhandled rejection', async () => {
    // #414 works in Executing with a running session, so Delete must stop that
    // session first. The confirm is skipped: this is about the kill that fails,
    // and both confirm paths reach the same delete.
    const { browser, page } = await launch('running', { sessionTaskId: 't414', skipDeleteConfirm: true });
    try {
      // A rejection that nothing catches is a promise event, not a window error:
      // count both where the page raises them.
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.evaluate(() => {
        const rejectionWindow = window as unknown as { __unhandledRejections: string[]; __killCalls: string[] };
        rejectionWindow.__unhandledRejections = [];
        rejectionWindow.__killCalls = [];
        window.addEventListener('unhandledrejection', (event) => { rejectionWindow.__unhandledRejections.push(String(event.reason)); });
        // Armed here, after boot, so nothing else can spend the refusal: the next
        // kill fails, the way a PTY that is already gone does.
        const kill = window.electronAPI.sessions.kill;
        let refused = false;
        window.electronAPI.sessions.kill = async (sessionId: string): Promise<void> => {
          rejectionWindow.__killCalls.push(sessionId);
          if (!refused) {
            refused = true;
            throw new Error('The session did not stop');
          }
          return kill(sessionId);
        };
      });

      await card(page, 't414').click({ button: 'right' });
      await expect(byTestId(page, 'workflow-card-menu')).toBeVisible();
      await byTestId(page, 'workflow-card-menu').locator('[data-testid="context-delete-task"]').click();

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Failed to delete' });
      await expect(toast).toHaveText('Failed to delete "Refuse to spawn past the hard cap": The session did not stop');
      // The refusal is the kill the delete asked for, and the delete went no further.
      expect(await page.evaluate(() => (window as unknown as { __killCalls: string[] }).__killCalls)).toEqual(['sess-t414']);
      expect(await page.evaluate(() => (window as unknown as { __mockTaskDeleteCallCount?: Record<string, number> }).__mockTaskDeleteCallCount?.t414 ?? 0)).toBe(0);
      expect(await page.evaluate(async () => (await window.electronAPI.tasks.list()).some((task) => task.id === 't414'))).toBe(true);
      await expect(card(page, 't414')).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __unhandledRejections: string[] }).__unhandledRejections)).toEqual([]);
      expect(pageErrors).toEqual([]);
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
      await expect(byTestId(page, 'workflow-remove-task')).toHaveAccessibleDescription('#411 is done and stays with its workflow.');
    } finally {
      await browser.close();
    }
  });

  test('the route list is the card\'s whole journey: To Do first and Done last, both locked on', async () => {
    // Sign-off T2: the list and the card's track draw the same stops.
    const { browser, page } = await launch('running');
    try {
      // #414 works in Executing: it has left To Do.
      await card(page, 't414').click();
      const todoRow = page.locator('[data-testid="workflow-route-todo"]');
      await expect(todoRow).toContainText('To Do');
      await expect(todoRow).toHaveAttribute('data-step-state', 'done');
      await expect(todoRow.getByRole('switch')).toBeDisabled();
      const doneRow = page.locator('[data-testid="workflow-route-done"]');
      await expect(doneRow).toHaveAttribute('data-step-state', 'ahead');
      await expect(doneRow.getByRole('switch')).toBeDisabled();
      // To Do sits above the route's own rows, Done below them.
      const rows = page.locator('[data-testid="workflow-route-todo"], [data-testid="workflow-route-row"], [data-testid="workflow-route-done"]');
      await expect(rows.first()).toHaveAttribute('data-testid', 'workflow-route-todo');
      await expect(rows.last()).toHaveAttribute('data-testid', 'workflow-route-done');

      // #415 waits in To Do: there it is the current stop.
      await card(page, 't415').click();
      await expect(page.locator('[data-testid="workflow-route-todo"]')).toHaveAttribute('data-step-state', 'current');
    } finally {
      await browser.close();
    }
  });

  test('a Done card wears the Done column\'s color, and every card the accent border when selected', async () => {
    const { browser, page } = await launch('running');
    try {
      const doneLaneColor = await page.evaluate(async () => (
        (await window.electronAPI.swimlanes.list()).find((lane) => lane.role === 'done')?.color ?? ''
      ));
      expect(doneLaneColor).not.toBe('');
      const doneColor = await computedColor(page, doneLaneColor);
      // The selected border every card shares (sign-off S3): the theme's accent, at the border's own 1px.
      const selectedBorder = await computedColor(page, 'var(--color-accent)');

      // #411 is done and opens selected (the run order's first row): the
      // accent border, 1px as every card's, and no halo or ring outside it.
      await expect(card(page, 't411')).toHaveAttribute('data-selected', 'true');
      await expect(card(page, 't411')).toHaveCSS('border-top-width', '1px');
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
      await expect(card(page, 't414')).toHaveCSS('border-top-width', '1px');
      await expect(card(page, 't414')).toHaveCSS('box-shadow', 'none');
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

  // A link can outlive its blocker. One whose project will not open still holds
  // its task, and the card says so in its plain words; one whose task is gone
  // is dropped by the engine, so the card reads as if it never was.
  test('a blocker whose project cannot be read holds its task, in the card\'s plain words', async () => {
    const { browser, page } = await launch('running', { missingBlocker: 'unreadable' });
    try {
      await expect(card(page, 't419')).toContainText('Blocked by a task...');
      await card(page, 't419').click();
      // Nothing to open or remove: the inspector lists only what it can name.
      await expect(page.locator('[data-testid="workflow-link-row"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="workflow-link-row"][data-task-key="t418"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a blocker that is gone holds nothing: its task reads as queued', async () => {
    const { browser, page } = await launch('running', { missingBlocker: 'gone' });
    try {
      await expect(card(page, 't419')).toContainText('Queued...');
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
      await expect(addBlocker).toHaveAccessibleDescription('No task it can wait for.');
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

  // The track is the task's whole journey (sign-off R2 and T2): To Do, the
  // route, Done, the same length for a task's whole life. Where it is, is its
  // column's own marker, so the strip names no column; the stops it passed are
  // grey and the ones ahead carry their columns' colors.
  test('a canvas card draws its whole journey, To Do to Done, with its column as the marker', async () => {
    const { browser, page } = await launch('running');
    try {
      const laneColor = (role: 'todo' | 'done') => page.evaluate(async (wanted) => (
        (await window.electronAPI.swimlanes.list()).find((lane) => lane.role === wanted)?.color ?? ''
      ), role);
      const faint = await computedColor(page, 'var(--color-fg-faint)');

      // #414 works in Executing: no column name on the strip, the name on the marker.
      const strip = card(page, 't414').locator('[data-testid="workflow-card-strip"]');
      await expect(strip).not.toContainText('Executing');
      const marker = strip.locator('[data-testid="workflow-step-marker"]');
      await expect(marker).toHaveAttribute('data-step-state', 'current');
      await expect(marker).toHaveAttribute('aria-label', 'Executing: now');
      await expect(marker).toHaveCSS('background-color', await computedColor(page, 'color-mix(in srgb, #3b82f6 18%, transparent)'));
      await expect(marker.locator('svg')).toHaveCSS('color', await computedColor(page, '#3b82f6'));
      // To Do and Planning are behind it, the faint grey; what is ahead keeps its color.
      const passed = strip.locator('[data-step-state="done"]');
      await expect(passed).toHaveCount(2);
      await expect(passed.first()).toHaveAttribute('data-step-end', 'todo');
      for (const stop of await passed.all()) {
        await expect(stop).toHaveCSS('background-color', faint);
        await expect(stop).toHaveCSS('opacity', '0.55');
      }
      const ahead = strip.locator('[data-step-state="ahead"]');
      await expect(ahead.last()).toHaveAttribute('data-step-end', 'done');
      await expect(ahead.last()).toHaveCSS('background-color', await computedColor(page, `color-mix(in srgb, ${await laneColor('done')} 45%, transparent)`));

      // #415 waits in To Do: To Do's marker, in its column's color, then its route and Done ahead.
      const toDoTrack = card(page, 't415').locator('[data-testid="workflow-step-track"]');
      const toDoMarker = toDoTrack.locator('[data-testid="workflow-step-marker"]');
      await expect(toDoMarker).toHaveAttribute('data-step-end', 'todo');
      await expect(toDoMarker).toHaveAttribute('aria-label', 'To Do: now');
      await expect(toDoMarker.locator('svg')).toHaveCSS('color', await computedColor(page, await laneColor('todo')));
      await expect(toDoTrack.locator('[data-step-state="done"]')).toHaveCount(0);
      await expect(toDoTrack.locator('[data-step-state]').last()).toHaveAttribute('data-step-end', 'done');
      await expect(card(page, 't415').locator('[data-testid="workflow-card-strip"]')).not.toContainText('To Do');

      // #411 is done: everything behind it, and Done's marker in Done's color.
      const doneTrack = card(page, 't411').locator('[data-testid="workflow-step-track"]');
      const doneMarker = doneTrack.locator('[data-testid="workflow-step-marker"]');
      await expect(doneMarker).toHaveAttribute('data-step-end', 'done');
      await expect(doneMarker).toHaveAttribute('aria-label', 'Done: now');
      await expect(doneMarker.locator('svg')).toHaveCSS('color', await computedColor(page, await laneColor('done')));
      await expect(doneTrack.locator('[data-step-state="ahead"]')).toHaveCount(0);
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
    try {
      // Each target box is read once the link is under way, right before the move to it.
      await pressPortToStartLink(page, outgoingPort(page, 'task-1'));
      const target = await card(page, 'task-3').boundingBox();
      if (!target) throw new Error('canvas not laid out');
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
      const hint = byTestId(page, 'workflow-link-hint');
      await expect(hint).toHaveText('Release to make "Token docs" wait for "Token table"', { timeout: 15_000 });
      await page.mouse.up();
      // The task that now waits is selected, with both of its blockers.
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      await expect(page.locator('[data-testid="workflow-link-row"]')).toHaveCount(2);

      // From the last task back onto the first closes a loop: refused, and said so.
      await pressPortToStartLink(page, outgoingPort(page, 'task-3'));
      const loopTarget = await card(page, 'task-1').boundingBox();
      if (!loopTarget) throw new Error('canvas not laid out');
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
      await expect(byTestId(page, 'workflow-auto-layout')).toHaveAccessibleDescription('No card has been moved');
      await dragCardByHand(page, 'task-3');
      await expect(byTestId(page, 'workflow-auto-layout')).toBeEnabled();
      await byTestId(page, 'workflow-auto-layout').click();
      await expect(byTestId(page, 'workflow-auto-layout')).toBeDisabled();
    } finally {
      await browser.close();
    }
  });

  /** Moves #3 by hand, then records whether the canvas raised `data-arranging` from then on. */
  async function moveByHandAndWatchTheSlide(page: Page): Promise<string> {
    const flowNode = page.locator('.react-flow__node[data-id="task-3"]');
    const home = await flowNode.evaluate((element) => (element as HTMLElement).style.transform);
    await dragCardByHand(page, 'task-3');
    await expect(byTestId(page, 'workflow-auto-layout')).toBeEnabled();
    await byTestId(page, 'workflow-canvas').evaluate((element) => {
      const arrangingWindow = window as unknown as { __arranging: boolean };
      arrangingWindow.__arranging = false;
      new MutationObserver(() => { if (element.hasAttribute('data-arranging')) arrangingWindow.__arranging = true; })
        .observe(element, { attributes: true, attributeFilter: ['data-arranging'] });
    });
    return home;
  }

  test('Auto layout slides a moved card home, then the slide ends', async () => {
    const { browser, page } = await launch('draft');
    try {
      const home = await moveByHandAndWatchTheSlide(page);
      await byTestId(page, 'workflow-auto-layout').click();
      const flowNode = page.locator('.react-flow__node[data-id="task-3"]');
      await expect.poll(() => flowNode.evaluate((element) => (element as HTMLElement).style.transform)).toBe(home);
      // The card slid: the canvas held the slide while it moved, and let go after.
      expect(await page.evaluate(() => (window as unknown as { __arranging: boolean }).__arranging)).toBe(true);
      await expect(byTestId(page, 'workflow-canvas')).not.toHaveAttribute('data-arranging');
    } finally {
      await browser.close();
    }
  });

  test('with reduced motion, Auto layout puts the card home without a slide', async () => {
    const { browser, page } = await launch('draft');
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const home = await moveByHandAndWatchTheSlide(page);
      await byTestId(page, 'workflow-auto-layout').click();
      const flowNode = page.locator('.react-flow__node[data-id="task-3"]');
      await expect.poll(() => flowNode.evaluate((element) => (element as HTMLElement).style.transform)).toBe(home);
      expect(await page.evaluate(() => (window as unknown as { __arranging: boolean }).__arranging)).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('Fit view, Auto layout and Add task are one width', async () => {
    // Wide enough that the canvas keeps the tools' words (480px of canvas and up).
    const { browser, page } = await launch('draft', { width: 2000 });
    try {
      await expect(byTestId(page, 'workflow-auto-layout')).toContainText('Auto layout');
      const tools = await page.evaluate(() => ['workflow-fit-view', 'workflow-auto-layout', 'workflow-add-task'].map((testId) => {
        const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        return { testId, width: element?.getBoundingClientRect().width ?? 0, overflows: element ? element.scrollWidth > element.clientWidth : true };
      }));
      // The shared floor is wider than every label, so no platform's font makes one tool wider than the rest.
      expect(tools.filter((tool) => tool.overflows)).toEqual([]);
      const widths = tools.map((tool) => tool.width);
      expect(Math.min(...widths)).toBeGreaterThan(0);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    } finally {
      await browser.close();
    }
  });

  test('Start is the one filled button; Add task and Open task wear the accent tint, and New workflow stays plain', async () => {
    // Each region's main action is tinted (the canvas's, the inspector's); the
    // header's is Start, the view's one fill. New workflow, tinted, would be the
    // only blue in a running workflow's header.
    const { browser, page } = await launch('draft', { width: 2000 });
    try {
      await expect(byTestId(page, 'workflow-open-task')).toBeVisible();
      const accentFg = await computedColor(page, 'var(--color-accent-fg)');
      const accentEmphasis = await computedColor(page, 'var(--color-accent-emphasis)');
      const look = (testId: string) => byTestId(page, testId).evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      });
      const raised = await computedColor(page, 'var(--color-surface-raised)', 'backgroundColor');
      expect((await look('workflow-start')).background).toBe(accentEmphasis);
      for (const testId of ['workflow-add-task', 'workflow-open-task']) {
        const tinted = await look(testId);
        expect(tinted.color, testId).toBe(accentFg);
        // A tint, really drawn: not the fill, not the plain raised surface, and
        // not transparent (an arbitrary class that failed to generate).
        expect(tinted.background, testId).not.toBe(accentEmphasis);
        expect(tinted.background, testId).not.toBe(raised);
        expect(tinted.background, testId).not.toBe('rgba(0, 0, 0, 0)');
      }
      expect((await look('workflow-new')).color).not.toBe(accentFg);
    } finally {
      await browser.close();
    }
  });

  // Add task sits in the bottom right corner, across from the view tools at the
  // bottom left, so they meet only on a narrow canvas: the words go below 480px.
  test('at every width the view tools stay clear of Add task, giving up their words below 480px of canvas', async () => {
    const { browser, page } = await launch('draft', { width: 2000 });
    try {
      for (const width of [2000, 1700, 1500, 1340, 1200, 1000, 900]) {
        await page.setViewportSize({ width, height: 950 });
        const read = () => page.evaluate(() => {
          const box = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.getBoundingClientRect();
          const label = document.querySelector<HTMLElement>('[data-testid="workflow-auto-layout"] span');
          return {
            canvas: box('workflow-canvas').width,
            canvasRight: box('workflow-canvas').right,
            autoLayoutRight: box('workflow-auto-layout').right,
            addTaskLeft: box('workflow-add-task').left,
            addTaskRight: box('workflow-add-task').right,
            labelShown: label !== null && getComputedStyle(label).display !== 'none',
          };
        });
        // Settled: the words show exactly when the canvas has the room.
        await expect.poll(async () => { const state = await read(); return state.labelShown === state.canvas >= 480; }).toBe(true);
        const state = await read();
        const at = `at a ${width}px window (canvas ${Math.round(state.canvas)}px)`;
        expect(state.autoLayoutRight, at).toBeLessThan(state.addTaskLeft);
        // In the corner: the panel's margin from the canvas's right edge.
        expect(state.canvasRight - state.addTaskRight, at).toBeLessThan(24);
      }
      // Without its words a tool keeps its name.
      await expect(byTestId(page, 'workflow-fit-view')).toHaveAttribute('aria-label', 'Fit view');
      await expect(byTestId(page, 'workflow-auto-layout')).toHaveAttribute('aria-label', 'Auto layout');
      await expect(byTestId(page, 'workflow-add-task')).toContainText('Add task');
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
