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
import { waitForViteReady, gotoVite, computedColor, toastCountRightNow } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflows-board-proj';
/** The board a `homeElsewhere` workflow lives on: its tasks are on `PROJECT_ID`'s board, its home is this one. */
const HOME_PROJECT_ID = 'workflows-board-home';

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
  /** `done`: the workflow finished, so every one of its tasks is in Done and it leaves the picker. */
  state?: 'running' | 'paused' | 'done';
  /** Lane indexes whose column starts no agent: a human gate. */
  gateLanes?: number[];
  /** Override where #414 sits. */
  lane414?: number;
  /** The workflow was made from #409, which Start moved to Done (board 7's superseded row). */
  supersededSource?: boolean;
  /** Ordinary tasks completed after the workflow's, enough of them to push #411 and #412 out of Done's list. */
  newerCompleted?: number;
  /** #414 has a running session, so its window opens on the session view and its header pills. */
  session414?: boolean;
  /**
   * The workflow's home is ANOTHER board (`HOME_PROJECT_ID`), where a decoy workflow
   * is listed ahead of it, so a view that opens there and takes the first workflow
   * lands on the wrong one. The workflow's tasks stay on this board.
   */
  homeElsewhere?: boolean;
  /** #420 joins the running workflow in To Do with no link either way, as a task just added to it would. */
  unlinkedTask?: boolean;
  /** A link from #413 to #418, which #413 to #415 to #418 already covers. */
  impliedLink?: boolean;
  /**
   * #421 sits in To Do still carrying the membership of a workflow that was
   * deleted: a deleted workflow's Done tasks keep theirs, and this one was moved back.
   */
  orphanTask?: boolean;
  viewport?: { width: number; height: number };
}

function seedScript(options: Options): string {
  const homeProjectId = options.homeElsewhere ? HOME_PROJECT_ID : PROJECT_ID;
  const workflow = {
    workflow: {
      // Planned by its own workflow agent, so the pane starts it on open.
      id: 'wf-usage', title: 'Usage budgets', state: options.state ?? 'running', draft: null, color_slot: 5, agent_name: 'claude',
      source_task_id: options.supersededSource ? 't409' : null,
    },
    ...(options.homeElsewhere ? { projectId: HOME_PROJECT_ID } : {}),
  };
  const decoy = {
    workflow: { id: 'wf-decoy', title: 'Decoy plan', state: 'draft', draft: { tasks: [], links: [] }, color_slot: 2 },
    projectId: HOME_PROJECT_ID,
  };
  const links = [...LINKS, ...(options.impliedLink ? [[413, 418] as [number, number]] : [])].map(([blocker, blocked]) => ({ workflow_id: 'wf-usage', blocker_task_id: `t${blocker}`, blocked_task_id: `t${blocked}` }));
  const finished = options.state === 'done';
  const tasks = TASKS.map(([id, title, lane]) => [
    id,
    title,
    finished ? 6 : id === 414 && options.lane414 !== undefined ? options.lane414 : lane,
  ]);
  return `
    window.__mockWorkflows = ${JSON.stringify(options.homeElsewhere ? [decoy, workflow] : [workflow])};
    window.__mockWorkflowLinks = ${JSON.stringify(links)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      var gates = ${JSON.stringify(options.gateLanes ?? [])};
      var supersededSource = ${options.supersededSource ? 'true' : 'false'};
      var newerCompleted = ${options.newerCompleted ?? 0};
      var homeElsewhere = ${options.homeElsewhere ? 'true' : 'false'};
      state.projects.push({ id: '${PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts });
      if (homeElsewhere) {
        state.projects.push({ id: '${HOME_PROJECT_ID}', name: 'kangentic-planning', path: '/mock/kangentic-planning', github_url: null, default_agent: 'claude', group_id: null, position: 1, last_opened: ts, created_at: ts });
      }
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var lane = Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: ts });
        if (gates.indexOf(index) !== -1) lane.auto_spawn = false;
        state.swimlanes.push(lane);
      });
      function row(id, title, lane, workflowId) {
        var task = {
          id: 't' + id, display_id: id, title: title, description: 'Planned by the workflow agent.',
          swimlane_id: 'lane-' + lane, position: id, agent: 'claude', session_id: null, worktree_path: null, branch_name: null,
          pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: 0, labels: [], priority: 0,
          attachment_count: 0, archived_at: lane === 6 ? ts : null, workflow_id: workflowId, workflow_project_id: workflowId ? '${homeProjectId}' : null,
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
          created_at: ts, updated_at: ts,
        };
        // Tagged, the row belongs to this board alone: the home board lists none of the workflow's tasks.
        if (workflowId && homeElsewhere) task.projectId = '${PROJECT_ID}';
        return task;
      }
      ${JSON.stringify(tasks)}.forEach(function (entry) {
        var task = row(entry[0], entry[1], entry[2], 'wf-usage');
        if (task.archived_at) state.archivedTasks.push(task); else state.tasks.push(task);
      });
      // An ordinary task beside them, in To Do.
      state.tasks.push(row(500, 'Split the settings search index', 0, null));
      if (${options.unlinkedTask ? 'true' : 'false'}) state.tasks.push(row(420, 'Rate limit the budgets API', 0, 'wf-usage'));
      if (${options.orphanTask ? 'true' : 'false'}) state.tasks.push(row(421, 'Left by a deleted workflow', 0, 'wf-deleted'));
      // Number each column's cards from zero in task-number order, as the app
      // does: the mock's reorder shifts positions as if they run 0, 1, 2.
      var lanes = {};
      state.tasks.forEach(function (task) { (lanes[task.swimlane_id] = lanes[task.swimlane_id] || []).push(task); });
      Object.keys(lanes).forEach(function (laneId) {
        lanes[laneId].sort(function (first, second) { return first.display_id - second.display_id; })
          .forEach(function (task, index) { task.position = index; });
      });
      // The To Do task the workflow was made from, closed into Done at Start.
      if (supersededSource) state.archivedTasks.push(row(409, 'Usage budgets and a hard cap', 6, null));
      if (${options.session414 ? 'true' : 'false'}) {
        state.tasks.find(function (task) { return task.id === 't414'; }).session_id = 'sess-414';
        state.sessions.push({
          id: 'sess-414', taskId: 't414', projectId: '${PROJECT_ID}',
          pid: 9414, status: 'running', shell: 'bash', cwd: '/mock/kangentic', startedAt: ts, exitCode: null,
        });
      }
      for (var index = 0; index < newerCompleted; index += 1) {
        var completed = row(600 + index, 'Completed later ' + index, 6, null);
        completed.archived_at = new Date(Date.now() + (index + 1) * 60000).toISOString();
        state.archivedTasks.push(completed);
      }
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(options: Options = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: options.viewport ?? { width: 1700, height: 950 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(options));
  await gotoVite(page, VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  if (options.state === 'done') {
    // A finished workflow leaves the list, so no card carries its strip: wait for Done's list instead.
    await page.locator('[data-board-lanes] [data-task-id="t411"]').waitFor({ state: 'visible', timeout: 10000 });
  } else {
    // The strip appears once the workflow list has loaded.
    await page.locator('[data-task-id="t414"] [data-testid="workflow-card-strip"]').waitFor({ state: 'visible', timeout: 10000 });
  }
  return { browser, page };
}

const boardCard = (page: Page, id: string) => page.locator(`[data-board-lanes] [data-task-id="${id}"]`);
const byTestId = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);

/** The workflow store the dev build exposes on `window.__zustandStores`, as far as these tests drive it. */
interface WorkflowStoreHandle {
  getState: () => {
    showLinks: (taskId: string, homeProjectId: string, workflowId: string) => Promise<void>;
    clearLinks: () => void;
  };
}

/** The `window` an evaluate reads the workflow store from: one cast, shared by every caller. */
interface WorkflowStoreWindow {
  __zustandStores: { workflow: WorkflowStoreHandle };
}

/**
 * Keep a card's links on the board, as a refused move does, through the store
 * the dev build exposes. Not awaited in the page, so a held load stays held.
 */
async function keepLinks(page: Page, id: string): Promise<void> {
  await page.evaluate(({ taskId, projectId }) => {
    const store = (window as unknown as WorkflowStoreWindow).__zustandStores.workflow;
    void store.getState().showLinks(taskId, projectId, 'wf-usage');
  }, { taskId: id, projectId: PROJECT_ID });
}

async function openMenu(page: Page, id: string): Promise<void> {
  await boardCard(page, id).click({ button: 'right' });
  await byTestId(page, 'task-context-menu').waitFor({ state: 'visible' });
}

/** The mock's hold on `workflows.get`: see `__mockHoldNextWorkflowGet` in mock-electron-api.js. */
interface HeldWorkflowGetWindow {
  __mockHoldNextWorkflowGet?: boolean;
  __mockReleaseWorkflowGet?: () => void;
}

/** Make the next `workflows.get` wait for `releaseHeldWorkflowGet`, which is the answer a links load is waiting on. */
async function holdNextWorkflowGet(page: Page): Promise<void> {
  await page.evaluate(() => {
    const windowHandle = window as unknown as HeldWorkflowGetWindow;
    delete windowHandle.__mockReleaseWorkflowGet;
    windowHandle.__mockHoldNextWorkflowGet = true;
  });
}

/** The bridge's workflow read and the mock's change push, as the unreadable-panel test swaps and fires them. */
interface WorkflowReadWindow {
  electronAPI: { workflows: { get: (projectId: string, workflowId: string) => Promise<unknown> } };
  __mockFireWorkflowChanged: (event: { projectId: string; workflowId: string }) => void;
  __testRealWorkflowGet?: (projectId: string, workflowId: string) => Promise<unknown>;
}

/**
 * Make every `workflows.get` from here on fail as a locked database would: a
 * rejection that is not main's not-found refusal. Every call fails, not one, so
 * the panel's mount cannot slip a second, successful read past the failure.
 */
async function failWorkflowReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const windowHandle = window as unknown as WorkflowReadWindow;
    const workflows = windowHandle.electronAPI.workflows;
    windowHandle.__testRealWorkflowGet = workflows.get;
    workflows.get = () => Promise.reject(new Error('database is locked'));
  });
}

/** Put the real read back, then push a change for the workflow so the watching panel reads it again. */
async function recoverWorkflowReads(page: Page, workflowId: string): Promise<void> {
  await page.evaluate(({ projectId, id }) => {
    const windowHandle = window as unknown as WorkflowReadWindow;
    if (windowHandle.__testRealWorkflowGet) windowHandle.electronAPI.workflows.get = windowHandle.__testRealWorkflowGet;
    windowHandle.__mockFireWorkflowChanged({ projectId, workflowId: id });
  }, { projectId: PROJECT_ID, id: workflowId });
}

/** The held call is in flight: the mock only defines the release while it holds an answer. */
async function expectWorkflowGetHeld(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as HeldWorkflowGetWindow).__mockReleaseWorkflowGet === 'function'))
    .toBe(true);
}

/**
 * Whether the links overlay shows on any of the next three frames, after the
 * held call is answered when `release` is set. The answer is delivered in
 * microtasks and painted a frame or two later, so a count taken right after the
 * release would pass before a late answer had a chance to draw anything. Release
 * and frames are one evaluate, so the frames are all after the answer.
 */
async function overlayShowsWithinThreeFrames(page: Page, options: { release: boolean }): Promise<boolean> {
  return page.evaluate(async ({ release }) => {
    if (release) (window as unknown as HeldWorkflowGetWindow).__mockReleaseWorkflowGet?.();
    let shown = false;
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (document.querySelector('[data-testid="workflow-links-overlay"]')) shown = true;
    }
    return shown;
  }, options);
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
  test('a workflow card carries the strip with its workflow and step track; an ordinary card does not', async () => {
    const { browser, page } = await launch();
    try {
      const strip = boardCard(page, 't414').locator('[data-testid="workflow-card-strip"]');
      await expect(strip).toContainText('Usage budgets');
      // The workflow's icon, drawn at the board's stroke width.
      await expect(strip.locator('svg').first()).toHaveAttribute('stroke-width', '2');
      // The whole journey (sign-off T2): To Do and Planning passed, Executing
      // current, Code Review, Testing, Merge and Done ahead.
      await expect(strip.locator('[data-step-state]')).toHaveCount(7);
      await expect(strip.locator('[data-step-state]').first()).toHaveAttribute('data-step-end', 'todo');
      await expect(strip.locator('[data-step-state]').last()).toHaveAttribute('data-step-end', 'done');
      // On the board the lane names the column, so the current step stays a
      // bar (15 by 6), not the column marker the Workflows canvas draws.
      const current = strip.locator('[data-step-state="current"]');
      await expect(current).toHaveAccessibleName('Executing: now');
      await expect(current).toHaveCSS('width', '15px');
      await expect(current).toHaveCSS('height', '6px');
      await expect(strip.locator('[data-testid="workflow-step-marker"]')).toHaveCount(0);
      // A stop it has passed is the faint grey, whatever its column's color.
      const faint = await computedColor(page, 'var(--color-fg-faint)');
      await expect(strip.locator('[data-step-state="done"]')).toHaveCount(2);
      for (const passed of await strip.locator('[data-step-state="done"]').all()) await expect(passed).toHaveCSS('background-color', faint);
      // A stop still ahead carries its column's color, so it is not the grey.
      for (const ahead of await strip.locator('[data-step-state="ahead"]').all()) {
        expect(await ahead.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(faint);
      }
      // A card in To Do: To Do is where it is, its whole route and Done ahead, and no marker.
      const toDoTrack = boardCard(page, 't415').locator('[data-testid="workflow-step-track"]');
      await expect(toDoTrack.locator('[data-step-state="current"]')).toHaveAttribute('data-step-end', 'todo');
      await expect(toDoTrack.locator('[data-step-state="ahead"]')).toHaveCount(6);
      await expect(toDoTrack.locator('[data-testid="workflow-step-marker"]')).toHaveCount(0);
      // The strip ends at the track (board 8c): no lock, since a locked card's
      // drag stays in its column, and no links button, since resting on the
      // card shows its links.
      await expect(page.locator('[data-testid="workflow-card-lock"]')).toHaveCount(0);
      await expect(strip.locator('button')).toHaveCount(0);
      await expect(strip.locator('[data-testid="workflow-card-paused"]')).toHaveCount(0);
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

  test('the menu of a running workflow card offers its workflow and keeps its locked rows, disabled with the reason', async () => {
    const { browser, page } = await launch();
    try {
      await openMenu(page, 't414');
      const menu = byTestId(page, 'task-context-menu');
      await expect(menu.locator('[data-testid="context-open-workflow"]')).toBeVisible();
      // A card's links show by resting on it, so the menu offers nothing for them.
      await expect(menu.locator('[data-testid="context-show-workflow-links"]')).toHaveCount(0);
      const moveRows = menu.locator('[data-testid="context-move-to"]');
      await expect(moveRows).toHaveCount(5);
      for (const row of await moveRows.all()) await expect(row).toHaveAttribute('aria-disabled', 'true');
      // While it runs, every row says the lock, To Do included (boards 6 and 1d).
      for (const name of ['To Do', 'Planning', 'Code Review', 'Testing', 'Merge']) {
        await expect(moveRows.filter({ hasText: name })).toHaveAccessibleDescription(LOCKED);
      }
      for (const testId of ['context-send-to-backlog', 'context-archive-task']) {
        await expect(menu.locator(`[data-testid="${testId}"]`)).toHaveAccessibleDescription(LOCKED);
      }
      // A disabled row dims whole, with the not-allowed cursor; a live row does neither.
      for (const disabledRow of [moveRows.filter({ hasText: 'Code Review' }), menu.locator('[data-testid="context-archive-task"]')]) {
        await expect(disabledRow).toHaveCSS('opacity', '0.4');
        await expect(disabledRow).toHaveCSS('cursor', 'not-allowed');
      }
      await expect(menu.locator('[data-testid="context-edit-task"]')).toHaveCSS('opacity', '1');
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
      await expect(boardCard(page, 't419').locator('[data-testid="workflow-status-bar"]')).toHaveText('Paused');
      // The strip draws no pause glyph (sign-off 2026-10-21): at 11px it read as
      // stray bars. The To Do card's footer above is what says Paused.
      await expect(boardCard(page, 't414').locator('[data-testid="workflow-card-strip"]')).toBeVisible();
      await expect(boardCard(page, 't414').locator('[data-testid="workflow-card-paused"]')).toHaveCount(0);
      await openMenu(page, 't414');
      const menu = byTestId(page, 'task-context-menu');
      await expect(menu.locator('[data-testid="context-move-to"]').filter({ hasText: 'To Do' }))
        .toHaveAccessibleDescription('#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
      await expect(menu.locator('[data-testid="context-move-to"]').filter({ hasText: 'Code Review' })).not.toHaveAttribute('aria-disabled', 'true');
      await expect(menu.locator('[data-testid="context-send-to-backlog"]')).toHaveAccessibleDescription('Remove #414 from Usage budgets first.');
    } finally {
      await browser.close();
    }
  });

  test('in a human gate, a person may drag the card on to the next column of its route, and nowhere else', async () => {
    // Code Review starts no agent here, so no agent judges its work.
    const { browser, page } = await launch({ gateLanes: [3], lane414: 3 });
    try {
      await openMenu(page, 't414');
      const rows = byTestId(page, 'task-context-menu').locator('[data-testid="context-move-to"]');
      await expect(rows.filter({ hasText: 'Testing' })).not.toHaveAttribute('aria-disabled', 'true');
      await expect(rows.filter({ hasText: 'Executing' })).toHaveAccessibleDescription(LOCKED);
    } finally {
      await browser.close();
    }
  });

  test('a canvas card\'s strip has no lock: the canvas draws every link', async () => {
    const { browser, page } = await launch();
    try {
      await byTestId(page, 'view-toggle-workflows').click();
      const strip = page.locator('[data-testid="workflow-canvas-card"][data-workflow-task-key="t414"] [data-testid="workflow-card-strip"]');
      await expect(strip).toBeVisible();
      await expect(strip.locator('[data-testid="workflow-step-track"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="workflow-canvas-card"] [data-testid="workflow-card-lock"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a locked card drags only within its own column: it never reaches another, and its links stay with it', async () => {
    const { browser, page } = await launch();
    try {
      // #414 runs in Executing, so only its workflow moves it. Its links are kept.
      await keepLinks(page, 't414');
      const overlay = byTestId(page, 'workflow-links-overlay');
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');

      const card = boardCard(page, 't414');
      const box = await card.boundingBox();
      const executing = await page.locator('[data-board-lanes] [data-testid="swimlane"][data-swimlane-name="Executing"]').boundingBox();
      const codeReview = await page.locator('[data-board-lanes] [data-testid="swimlane"][data-swimlane-name="Code Review"]').boundingBox();
      if (!box || !executing || !codeReview) throw new Error('No box for the drag');
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 12, startY, { steps: 3 });
      await expect(page.locator('.drag-overlay')).toBeVisible({ timeout: 2000 });
      await page.mouse.move(codeReview.x + codeReview.width / 2, codeReview.y + 120, { steps: 15 });

      // Over Code Review, the card is still over its own column, and Code Review is no target.
      const ghost = await page.locator('.drag-overlay').boundingBox();
      if (!ghost) throw new Error('No drag overlay');
      const ghostCenter = ghost.x + ghost.width / 2;
      expect(ghostCenter).toBeGreaterThan(executing.x);
      expect(ghostCenter).toBeLessThan(executing.x + executing.width);
      await expect(page.locator('[data-board-lanes] [data-swimlane-name="Code Review"].drop-highlight')).toHaveCount(0);
      // No other column parts its cards or shows a slot for it either
      // (board-drop-preview.ts gives a locked card no cross-column gap).
      await expect(page.locator('[data-drop-shift], [data-drop-slot][data-visible]')).toHaveCount(0);
      // Dragging the card whose links are up keeps them.
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');
      await page.mouse.up();

      await expect(page.locator('[data-swimlane-name="Executing"] [data-task-id="t414"]')).toBeVisible();
      await expect(page.locator('[data-swimlane-name="Code Review"] [data-task-id="t414"]')).toHaveCount(0);
      expect(await toastCountRightNow(page, LOCKED)).toBe(0);
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');
    } finally {
      await browser.close();
    }
  });

  test('a locked card reorders within its column, so a person can regroup it', async () => {
    const { browser, page } = await launch();
    try {
      const order = () => page.locator('[data-board-lanes] [data-swimlane-name="To Do"] [data-task-id]')
        .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-task-id')));
      expect((await order()).slice(0, 3)).toEqual(['t415', 't416', 't417']);
      // What the board asks main for. (The mock's reorder renumbers positions from
      // zero, and this board seeds them by task number, so the order it reloads is
      // not the board's to assert.)
      await page.evaluate(() => {
        const tasksApi = window.electronAPI.tasks as unknown as { move: (input: unknown, projectId: unknown) => Promise<unknown> };
        const original = tasksApi.move;
        const recorded: unknown[] = [];
        (window as unknown as { __recordedMoves: unknown[] }).__recordedMoves = recorded;
        tasksApi.move = (input, projectId) => {
          recorded.push(input);
          return original(input, projectId);
        };
      });

      // #415 waits in To Do while its workflow runs: locked, but it can move down the column.
      const from = await boardCard(page, 't415').boundingBox();
      const to = await boardCard(page, 't417').boundingBox();
      if (!from || !to) throw new Error('No box for the reorder');
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12, { steps: 3 });
      await expect(page.locator('.drag-overlay')).toBeVisible({ timeout: 2000 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
      // Intentional fixed wait, as drag-and-drop.spec.ts's within-column reorder
      // has it: no DOM signal says the target card is hovered before the release.
      await page.waitForTimeout(400);
      await page.mouse.up();

      // A reorder in its own column, below where it was, and nothing refused.
      await expect.poll(() => page.evaluate(() => (window as unknown as { __recordedMoves: Array<{ taskId: string; targetSwimlaneId: string; targetPosition: number }> }).__recordedMoves))
        .toEqual([expect.objectContaining({ taskId: 't415', targetSwimlaneId: 'lane-0' })]);
      const [move] = await page.evaluate(() => (window as unknown as { __recordedMoves: Array<{ targetPosition: number }> }).__recordedMoves);
      expect(move.targetPosition).toBeGreaterThan(0);
      expect(await toastCountRightNow(page, 'locked')).toBe(0);
      await expect(page.locator('[data-board-lanes] [data-swimlane-name="To Do"] [data-task-id="t415"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a refused drag stays in its column, says why with Open workflow, and shows the card\'s links', async () => {
    // #414 waits in a human gate (Code Review starts no agent), so a person may
    // drag it on to Testing, the next column of its route, and nowhere else.
    const { browser, page } = await launch({ gateLanes: [3], lane414: 3 });
    try {
      await dragToColumn(page, 't414', 'Merge');
      const toast = page.locator('[data-testid="toast"]').filter({ hasText: LOCKED });
      await expect(toast).toBeVisible();
      await expect(toast.getByRole('button', { name: 'Open workflow' })).toBeVisible();
      await expect(page.locator('[data-swimlane-name="Code Review"] [data-task-id="t414"]')).toBeVisible();

      const overlay = byTestId(page, 'workflow-links-overlay');
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');
      // #417 waits for #414, and it is on the board.
      await expect(overlay.locator('[data-link="out:t417"]')).toHaveCount(1);
      // The focused card wears the accent border the canvas gives its selected
      // card; no other card changes, the Done column included.
      await expect(boardCard(page, 't414')).toHaveCSS('border-top-color', await computedColor(page, 'var(--color-accent)'));
      for (const id of ['t419', 't417']) await expect(boardCard(page, id)).toHaveCSS('opacity', '1');
      await expect(boardCard(page, 't417')).toHaveCSS('outline-style', 'none');
      await expect(page.locator('[data-board-lanes] [data-done-drop-zone]')).toHaveCSS('opacity', '1');
      // A dependent's line is drawn in the accent's foreground.
      await expect(overlay.locator('[data-link="out:t417"] path').nth(1)).toHaveAttribute('stroke', 'var(--color-accent-fg)');

      await page.keyboard.press('Escape');
      await expect(overlay).toHaveCount(0);
      await expect(boardCard(page, 't414')).not.toHaveCSS('border-top-color', await computedColor(page, 'var(--color-accent)'));
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

  test('kept links draw the overlay; a press on empty board space clears them', async () => {
    const { browser, page } = await launch();
    try {
      await keepLinks(page, 't413');
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

  test('the overlay draws a link as the canvas draws a selected task\'s: flowing, in its colors, and under the header row', async () => {
    const { browser, page } = await launch();
    try {
      await keepLinks(page, 't414');
      const overlay = byTestId(page, 'workflow-links-overlay');
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');
      const line = overlay.locator('[data-link="out:t417"] path.workflow-link-flow');
      const look = () => line.evaluate((element) => ({ dash: getComputedStyle(element).strokeDasharray, animation: getComputedStyle(element).animationName }));
      // The canvas's flow (index.css, WorkflowEdge): 7 on, 4 off, moving toward the arrow.
      await expect.poll(look).toEqual({ dash: '7px, 4px', animation: 'workflow-link-flow' });
      await expect(line).toHaveAttribute('stroke', 'var(--color-accent-fg)');

      // The lines are clipped to the lanes below the header row, so a line to a
      // card out of view leaves under the headers. Red: a line drawn over them.
      const clip = await page.evaluate(() => {
        const svg = document.querySelector('[data-testid="workflow-links-overlay"]')!;
        const rect = svg.querySelector('[data-testid="workflow-links-clip"]')!;
        const list = document.querySelector('[data-board-lanes] [data-swimlane-task-list]')!;
        return {
          top: Number(rect.getAttribute('y')),
          headerBottom: Math.round(list.getBoundingClientRect().top - svg.getBoundingClientRect().top),
          applied: svg.querySelector('g[clip-path]')?.getAttribute('clip-path') ?? null,
          linesInside: svg.querySelectorAll('g[clip-path] [data-testid="workflow-link-line"]').length,
        };
      });
      expect(clip.top).toBe(clip.headerBottom);
      expect(clip.applied).toBe('url(#workflow-links-overlay-clip)');
      expect(clip.linesInside).toBeGreaterThan(0);

      // Ports, as the canvas draws them: one per side of a card, at the middle
      // of its title row, which every line on that side shares, and a ring only
      // where the canvas draws one. #414 has started, so it gives a link (its
      // left port, toward #417) but takes none: #412's line from Done arrives
      // at its right side with no ring, and #412, done, has none either. #417
      // waits in To Do, so its incoming port is a ring.
      const portCheck = await page.evaluate(() => {
        const svg = document.querySelector('[data-testid="workflow-links-overlay"]')!;
        const origin = svg.getBoundingClientRect();
        const row = document.querySelector('[data-board-lanes] [data-task-id="t414"] [data-card-title-row]')!.getBoundingClientRect();
        return {
          rowMiddle: row.top + row.height / 2 - origin.top,
          ports: Array.from(svg.querySelectorAll('[data-testid="workflow-link-port"]'))
            .map((port) => ({ key: port.getAttribute('data-port') ?? '', cy: Number(port.getAttribute('cy')) })),
        };
      });
      expect(portCheck.ports.map((port) => port.key).sort()).toEqual(['t414:left', 't417:right']);
      const focusPort = portCheck.ports.find((port) => port.key === 't414:left')!;
      expect(Math.abs(focusPort.cy - portCheck.rowMiddle)).toBeLessThan(1);

      // A blocker not done yet is the canvas's muted grey: #418 waits on #417 in To Do.
      await page.keyboard.press('Escape');
      await expect(overlay).toHaveCount(0);
      await keepLinks(page, 't418');
      await expect(overlay.locator('[data-link="in:t417"] path.workflow-link-flow')).toHaveAttribute('stroke', 'var(--color-fg-muted)');

      // With reduced motion the dashes hold still, as on the canvas.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect.poll(() => overlay.locator('[data-link="in:t417"] path.workflow-link-flow').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
    } finally {
      await browser.close();
    }
  });

  test('a card above the focused one growing moves the focused card\'s lines, with no scroll, resize or board change to say so', async () => {
    /** The board store's lists the overlay re-measures on when one changes. */
    interface BoardLists {
      tasks: unknown;
      swimlanes: unknown;
      archivedTasks: unknown;
    }
    /** What fired on the page after the baseline. The overlay re-measures on a scroll, a resize or a board change, none of which a card growing in place causes. */
    interface RemeasureTriggers {
      scroll: number;
      resize: number;
      boardChange: number;
    }
    interface RemeasureTriggersWindow {
      __remeasureTriggers: RemeasureTriggers;
      __zustandStores: {
        board: {
          subscribe: (listener: (state: BoardLists, previous: BoardLists) => void) => () => void;
        };
      };
    }

    const { browser, page } = await launch();
    try {
      // #417 waits on #414 and holds up #418 in its own column, and #416 sits
      // directly above it in To Do with no link to it. A card the focused one
      // is not linked to has to be watched too, or nothing re-measures.
      await keepLinks(page, 't417');
      const overlay = byTestId(page, 'workflow-links-overlay');
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't417');
      await expect(overlay).toHaveAttribute('data-phase', 'shown');

      // #417's one port, on its right: #414's line arrives there and its own
      // line to #418 leaves from it. Both ends are read in the overlay's
      // coordinates, as the port check above reads them.
      const portAgainstTitleRow = () => page.evaluate(() => {
        const svg = document.querySelector('[data-testid="workflow-links-overlay"]');
        const port = svg?.querySelector('[data-testid="workflow-link-port"][data-port="t417:right"]');
        const titleRow = document.querySelector('[data-board-lanes] [data-task-id="t417"] [data-card-title-row]');
        if (!svg || !port || !titleRow) return null;
        const titleRowRect = titleRow.getBoundingClientRect();
        return {
          portY: Number(port.getAttribute('cy')),
          titleRowMiddle: titleRowRect.top + titleRowRect.height / 2 - svg.getBoundingClientRect().top,
        };
      });
      await expect.poll(async () => {
        const reading = await portAgainstTitleRow();
        return reading !== null && Math.abs(reading.portY - reading.titleRowMiddle) < 1;
      }).toBe(true);
      const baseline = await portAgainstTitleRow();
      if (!baseline) throw new Error('No port for #417');

      // Count what else could re-measure, from here on. Chromium's scroll
      // anchoring adjusts a scrolled lane when a card above its anchor grows,
      // which is a real scroll event that would re-measure on its own and let
      // this pass with the card observer gone.
      await page.evaluate(() => {
        const triggers: RemeasureTriggers = { scroll: 0, resize: 0, boardChange: 0 };
        const windowHandle = window as unknown as RemeasureTriggersWindow;
        windowHandle.__remeasureTriggers = triggers;
        document.addEventListener('scroll', () => { triggers.scroll += 1; }, true);
        window.addEventListener('resize', () => { triggers.resize += 1; });
        windowHandle.__zustandStores.board.subscribe((state, previous) => {
          if (state.tasks !== previous.tasks || state.swimlanes !== previous.swimlanes || state.archivedTasks !== previous.archivedTasks) triggers.boardChange += 1;
        });
      });

      // #416 grows by 120px in place: nothing but its own height changes.
      const growth = 120;
      await boardCard(page, 't416').evaluate((card, extraHeight) => {
        card.style.minHeight = `${card.getBoundingClientRect().height + extraHeight}px`;
      }, growth);

      // #417 moved down with it, and its port followed.
      await expect.poll(async () => {
        const reading = await portAgainstTitleRow();
        if (!reading) return null;
        return {
          moved: reading.titleRowMiddle - baseline.titleRowMiddle > growth / 2,
          followed: Math.abs(reading.portY - reading.titleRowMiddle) < 1,
        };
      }, { timeout: 5000 }).toEqual({ moved: true, followed: true });

      // Only the card growing could have said so.
      expect(await page.evaluate(() => (window as unknown as RemeasureTriggersWindow).__remeasureTriggers))
        .toEqual({ scroll: 0, resize: 0, boardChange: 0 });
    } finally {
      await browser.close();
    }
  });

  // The overlay re-watches the board's cards (a ResizeObserver per card) after
  // the board's tasks change. These two tests count `observe` calls on board
  // cards across writes landing inside ONE page task, so every write is before
  // the next frame. The re-observe is an animation frame callback the first
  // write registers; ours is registered after it, so it has run by the first
  // frame the page waits for, and three are waited for.
  test.describe('the overlay re-watching the cards after board changes', () => {
    /** The two stores the page-side counter drives: a board write gives `tasks` a new array, which is what the overlay re-observes on. */
    interface RewatchWindow {
      __zustandStores: {
        board: {
          getState: () => { tasks: unknown[] };
          setState: (partial: { tasks: unknown[] }) => void;
        };
        workflow: WorkflowStoreHandle;
      };
    }

    /** Write the board's tasks `writes` times in one task, optionally close the overlay in that same task, and count the card watches over the next three frames. */
    const cardWatchesAfterWrites = (page: Page, writes: number, closeOverlay: boolean) => page.evaluate(async ({ writeCount, close }) => {
      let watched = 0;
      const observe = ResizeObserver.prototype.observe;
      ResizeObserver.prototype.observe = function patchedObserve(this: ResizeObserver, target: Element, options?: ResizeObserverOptions) {
        if (target.hasAttribute('data-task-id') && target.closest('[data-board-lanes]')) watched += 1;
        return observe.call(this, target, options);
      };
      try {
        const stores = (window as unknown as RewatchWindow).__zustandStores;
        for (let write = 0; write < writeCount; write += 1) stores.board.setState({ tasks: [...stores.board.getState().tasks] });
        if (close) stores.workflow.getState().clearLinks();
        for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
      } finally {
        ResizeObserver.prototype.observe = observe;
      }
      return watched;
    }, { writeCount: writes, close: closeOverlay });

    test('board changes landing inside one frame re-watch the cards once, not once per change', async () => {
      const { browser, page } = await launch();
      try {
        await keepLinks(page, 't417');
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveAttribute('data-phase', 'shown');

        // One change re-watches the board's cards (the overlay did re-observe,
        // so the count below is not equal for want of a pass).
        const forOneWrite = await cardWatchesAfterWrites(page, 1, false);
        expect(forOneWrite).toBeGreaterThan(0);
        // Six changes in the same frame cost the same single pass.
        expect(await cardWatchesAfterWrites(page, 6, false)).toBe(forOneWrite);
      } finally {
        await browser.close();
      }
    });

    test('a re-watch still waiting when the overlay closes is cancelled, so it never watches the cards again', async () => {
      const { browser, page } = await launch();
      try {
        // With reduced motion the overlay leaves at once instead of fading out,
        // so closing it unmounts its observer in the same turn.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await keepLinks(page, 't417');
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveAttribute('data-phase', 'shown');

        // The same write with the overlay left open does re-watch the cards...
        expect(await cardWatchesAfterWrites(page, 1, false)).toBeGreaterThan(0);
        // ...and closed in the same turn it does not: the pass that was waiting
        // went with the observer it would have handed every card again.
        expect(await cardWatchesAfterWrites(page, 1, true)).toBe(0);
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });
  });

  // Board 8c: resting the pointer on a card previews its links until the
  // pointer leaves the card; a refused move keeps them. Each test asserts an
  // end state, never that a crossing did not flash: under load a pointer can
  // rest longer than the test meant it to.
  test.describe('a card\'s links, by resting on it', () => {
    const overlayOf = (page: Page) => byTestId(page, 'workflow-links-overlay');

    /** Rest the pointer on a card's body, below its strip, where its description is. */
    async function restOnCard(page: Page, id: string): Promise<void> {
      const card = boardCard(page, id);
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      if (!box) throw new Error(`No card #${id}`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6, { steps: 4 });
    }

    /** Past the 400ms rest, so a preview that was going to show has shown. */
    async function waitPastTheRest(page: Page): Promise<void> {
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 800)));
    }

    test('resting anywhere on a card previews its links, and leaving the card hides them', async () => {
      const { browser, page } = await launch();
      try {
        await restOnCard(page, 't414');
        const overlay = overlayOf(page);
        await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');
        await expect(overlay).toHaveAttribute('data-phase', 'shown');
        await expect(overlay.locator('[data-link="out:t417"]')).toHaveCount(1);
        // The card wears the canvas's selected border while its links show.
        await expect(boardCard(page, 't414')).toHaveCSS('border-top-color', await computedColor(page, 'var(--color-accent)'));
        // No button on the strip: the card itself is the way in.
        await expect(page.locator('[data-testid="workflow-links-button"]')).toHaveCount(0);

        // Off the card, over the page's top corner: the preview goes.
        await page.mouse.move(2, 2, { steps: 4 });
        await expect(overlay).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('a previewed card keeps its lines while it is dragged, and they go when it is let go away from it', async () => {
      const { browser, page } = await launch();
      try {
        await restOnCard(page, 't414');
        const overlay = overlayOf(page);
        await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');

        // A press and a drag: the pointer leaves the card with the button held.
        const box = await boardCard(page, 't414').boundingBox();
        const codeReview = await page.locator('[data-board-lanes] [data-testid="swimlane"][data-swimlane-name="Code Review"]').boundingBox();
        if (!box || !codeReview) throw new Error('No box for the drag');
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6 + 12, { steps: 3 });
        await expect(page.locator('.drag-overlay')).toBeVisible({ timeout: 2000 });
        await page.mouse.move(codeReview.x + codeReview.width / 2, codeReview.y + 160, { steps: 10 });
        // Still up, not fading out: read past the length of a fade.
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
        await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');
        await expect(overlay).toHaveAttribute('data-phase', 'shown');

        // Let go away from it: the preview ends with the drag.
        await page.mouse.up();
        await expect(overlay).toHaveCount(0);
        await expect(page.locator('[data-swimlane-name="Executing"] [data-task-id="t414"]')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('a card dragged in its column keeps its links all the way through, and after the drop while the pointer stays on it', async () => {
      const { browser, page } = await launch();
      try {
        // #415 waits in To Do: locked, so it reorders within its column.
        await restOnCard(page, 't415');
        const overlay = overlayOf(page);
        await expect(overlay).toHaveAttribute('data-focus-task-id', 't415');

        const from = await boardCard(page, 't415').boundingBox();
        const to = await boardCard(page, 't416').boundingBox();
        const planning = await page.locator('[data-board-lanes] [data-testid="swimlane"][data-swimlane-name="Planning"]').boundingBox();
        if (!from || !to || !planning) throw new Error('No box for the drag');
        await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height * 0.6 + 12, { steps: 3 });
        await expect(page.locator('.drag-overlay')).toBeVisible({ timeout: 2000 });

        // Off the card and out of its column while the button is held: the
        // lines stay. A leave event that reports no button held, as Electron
        // can send mid-drag, does not end them either: the card knows its own press.
        await page.mouse.move(planning.x + planning.width / 2, to.y + to.height / 2, { steps: 12 });
        await boardCard(page, 't415').evaluate((card) => card.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse', buttons: 0 })));
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
        await expect(overlay).toHaveAttribute('data-focus-task-id', 't415');
        await expect(overlay).toHaveAttribute('data-phase', 'shown');

        // Back over #416's place and let go: #415 lands there, under a pointer
        // that has not moved since.
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
        // Intentional fixed wait, as drag-and-drop.spec.ts's within-column reorder
        // has it: no DOM signal says the target card is hovered before the release.
        await page.waitForTimeout(400);
        await page.mouse.up();
        await expect(page.locator('.drag-overlay')).toHaveCount(0);
        await expect.poll(() => page.locator('[data-board-lanes] [data-swimlane-name="To Do"] [data-task-id]')
          .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-task-id')).slice(0, 2))).toEqual(['t416', 't415']);

        // The links stay while the pointer rests on it, read past the landing and any fade.
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 800)));
        await expect(overlay).toHaveAttribute('data-focus-task-id', 't415');
        await expect(overlay).toHaveAttribute('data-phase', 'shown');

        // Off the card: they go.
        await page.mouse.move(2, 2, { steps: 4 });
        await expect(overlay).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('kept links (a refused move\'s) outlast the pointer leaving, and while they are kept another card previews nothing', async () => {
      const { browser, page } = await launch();
      try {
        await keepLinks(page, 't414');
        const overlay = overlayOf(page);
        await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');

        await page.mouse.move(2, 2, { steps: 4 });
        await waitPastTheRest(page);
        await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');

        await restOnCard(page, 't413');
        await waitPastTheRest(page);
        await expect(overlay).toHaveAttribute('data-focus-task-id', 't414');
      } finally {
        await browser.close();
      }
    });

    test('a card with no links yet previews nothing', async () => {
      const { browser, page } = await launch({ unlinkedTask: true });
      try {
        await restOnCard(page, 't420');
        await waitPastTheRest(page);
        await expect(overlayOf(page)).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('the overlay fades in and out, and switches at once with motion off', async () => {
      const { browser, page } = await launch();
      try {
        const overlay = overlayOf(page);
        // The fade runs: as the overlay mounts, its lines carry a running opacity
        // transition and the focused card a running border one. Read from the
        // same task that opens it, on the frames until the overlay is there, so
        // it is caught while it runs.
        const easing = await page.evaluate(async (projectId) => {
          const store = (window as unknown as WorkflowStoreWindow).__zustandStores.workflow;
          void store.getState().showLinks('t414', projectId, 'wf-usage');
          const running = (target: Element | null, property: string) => (target?.getAnimations() ?? [])
            .some((animation) => animation.playState === 'running' && (animation as CSSTransition).transitionProperty.startsWith(property));
          for (let frame = 0; frame < 30; frame += 1) {
            const svg = document.querySelector('[data-testid="workflow-links-overlay"]');
            if (svg) return { lines: running(svg, 'opacity'), focusedCard: running(document.querySelector('[data-board-lanes] [data-task-id="t414"]'), 'border') };
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          return null;
        }, PROJECT_ID);
        expect(easing).toEqual({ lines: true, focusedCard: true });
        await expect(overlay).toHaveAttribute('data-phase', 'shown');
        await expect(overlay).toHaveCSS('transition-duration', '0.16s');

        // Cleared, it stays up, fading, then goes. Read a tick after the clear:
        // the fade lasts longer than that, so this is not a race.
        const clear = () => page.evaluate(async () => {
          const store = (window as unknown as WorkflowStoreWindow).__zustandStores.workflow;
          store.getState().clearLinks();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return document.querySelector('[data-testid="workflow-links-overlay"]')?.getAttribute('data-phase') ?? 'gone';
        });
        expect(await clear()).toBe('exit');
        await expect(overlay).toHaveCount(0);

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await keepLinks(page, 't414');
        await expect(overlay).toHaveAttribute('data-phase', 'shown');
        await expect(overlay).toHaveCSS('transition-duration', '0s');
        expect(await clear()).toBe('gone');
      } finally {
        await browser.close();
      }
    });
  });

  test('a board drag clears the overlay as it starts', async () => {
    const { browser, page } = await launch();
    try {
      await keepLinks(page, 't413');
      const overlay = byTestId(page, 'workflow-links-overlay');
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't413');

      // Pick up the ordinary card in To Do; the overlay goes before the drop.
      const card = boardCard(page, 't500');
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      if (!box) throw new Error('No box for #500');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
      await expect(page.locator('.drag-overlay')).toBeVisible({ timeout: 2000 });
      await expect(overlay).toHaveCount(0);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
      await page.mouse.up();
    } finally {
      await browser.close();
    }
  });

  // The overlay's Escape and press-on-empty-space listeners exist from the
  // moment a load starts, so a clear reaches a load still in flight: the very
  // first one, before anything is drawn, and a SECOND card's links fetched over
  // the first's (or on a change push). The answer that lands after the clear
  // must not bring the overlay back.
  test.describe('a clear while a workflow is still loading', () => {
    /** #413's links are waiting on its workflow, and nothing is drawn yet. */
    async function showLinksWhileFirstLoadHeld(page: Page): Promise<void> {
      await holdNextWorkflowGet(page);
      await keepLinks(page, 't413');
      await expectWorkflowGetHeld(page);
      await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);
    }

    test('Escape during the first load cancels it, so its answer draws nothing', async () => {
      const { browser, page } = await launch();
      try {
        await showLinksWhileFirstLoadHeld(page);

        await page.keyboard.press('Escape');

        expect(await overlayShowsWithinThreeFrames(page, { release: true })).toBe(false);
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('a press on empty board space during the first load cancels it, so its answer draws nothing', async () => {
      const { browser, page } = await launch();
      try {
        await showLinksWhileFirstLoadHeld(page);

        const testing = page.locator('[data-board-lanes] [data-testid="swimlane"][data-swimlane-name="Testing"]');
        await testing.scrollIntoViewIfNeeded();
        const box = await testing.boundingBox();
        if (!box) throw new Error('No Testing column');
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

        expect(await overlayShowsWithinThreeFrames(page, { release: true })).toBe(false);
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('a board drag that starts during the first load cancels it, so its answer never lands under the drag', async () => {
      const { browser, page } = await launch();
      try {
        await showLinksWhileFirstLoadHeld(page);

        // A press on a card is not a press on empty space: only the drag starting clears.
        const card = boardCard(page, 't500');
        await card.scrollIntoViewIfNeeded();
        const box = await card.boundingBox();
        if (!box) throw new Error('No box for #500');
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
        await expect(page.locator('.drag-overlay')).toBeVisible({ timeout: 2000 });

        expect(await overlayShowsWithinThreeFrames(page, { release: true })).toBe(false);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
        await page.mouse.up();
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    /** #413's overlay is up, and #414's links are waiting on their workflow. */
    async function showLinksOnWhileLoadingAnother(page: Page): Promise<void> {
      await keepLinks(page, 't413');
      await expect(byTestId(page, 'workflow-links-overlay')).toHaveAttribute('data-focus-task-id', 't413');

      await holdNextWorkflowGet(page);
      await keepLinks(page, 't414');
      await expectWorkflowGetHeld(page);
      // The new card's links have not landed, so #413's overlay is still the one up.
      await expect(byTestId(page, 'workflow-links-overlay')).toHaveAttribute('data-focus-task-id', 't413');
    }

    test('Escape clears the overlay, and the answer that lands afterwards does not bring it back', async () => {
      const { browser, page } = await launch();
      try {
        await showLinksOnWhileLoadingAnother(page);

        await page.keyboard.press('Escape');
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);

        expect(await overlayShowsWithinThreeFrames(page, { release: true })).toBe(false);
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('a press on empty board space clears the overlay, and the answer that lands afterwards does not bring it back', async () => {
      const { browser, page } = await launch();
      try {
        await showLinksOnWhileLoadingAnother(page);

        // The middle of the Testing column's list, which holds no card.
        const testing = page.locator('[data-board-lanes] [data-testid="swimlane"][data-swimlane-name="Testing"]');
        await testing.scrollIntoViewIfNeeded();
        const box = await testing.boundingBox();
        if (!box) throw new Error('No Testing column');
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);

        expect(await overlayShowsWithinThreeFrames(page, { release: true })).toBe(false);
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    // Not here: leaving the board while the FIRST load is in flight. The overlay's
    // unmount clears the store (the same `clearLinks`), but React.StrictMode's
    // dev remount runs that cleanup again on every mount, so the board that
    // returns is clean with or without the generation guard and a UI test of it
    // cannot fail. That case lives in tests/unit/workflow-store-stale-answers.test.ts.

    test('an answer nothing cleared draws the overlay when it lands', async () => {
      const { browser, page } = await launch();
      try {
        await holdNextWorkflowGet(page);
        await keepLinks(page, 't413');
        await expectWorkflowGetHeld(page);
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveCount(0);

        // The control for the three above: the same hold, released with nothing in between.
        expect(await overlayShowsWithinThreeFrames(page, { release: true })).toBe(true);
        await expect(byTestId(page, 'workflow-links-overlay')).toHaveAttribute('data-focus-task-id', 't413');
      } finally {
        await browser.close();
      }
    });
  });

  test('a link another path already covers is left out, as the canvas leaves it out', async () => {
    const { browser, page } = await launch({ impliedLink: true });
    try {
      await keepLinks(page, 't413');
      const overlay = byTestId(page, 'workflow-links-overlay');
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't413');
      await expect(overlay.locator('[data-link="out:t415"]')).toHaveCount(1);
      await expect(overlay.locator('[data-link="out:t416"]')).toHaveCount(1);
      // #418 already waits on #413 through #415, so the direct link is not drawn,
      // and #418 gets no port of #413's.
      await expect(overlay.locator('[data-link="out:t418"]')).toHaveCount(0);
      await expect(overlay.locator('[data-port^="t418:"]')).toHaveCount(0);
      // Its footer still counts every task it waits for.
      await expect(boardCard(page, 't418').locator('[data-testid="workflow-status-bar"]')).toHaveText('Blocked by 5 tasks...');
    } finally {
      await browser.close();
    }
  });

  test('a related card pushed out of the Done column\'s list draws no line', async () => {
    // Fifteen tasks completed after #411 and #412 fill Done's list, so neither is rendered.
    const { browser, page } = await launch({ newerCompleted: 15 });
    try {
      await expect(boardCard(page, 't411')).toHaveCount(0);
      await keepLinks(page, 't413');
      const overlay = byTestId(page, 'workflow-links-overlay');
      await expect(overlay).toHaveAttribute('data-focus-task-id', 't413');
      // #413 holds up #415 and #416, both on the board; it waits for #411, which is not drawn.
      await expect(overlay.locator('[data-link="out:t415"]')).toHaveCount(1);
      await expect(overlay.locator('[data-link="out:t416"]')).toHaveCount(1);
      await expect(overlay.locator('[data-link="in:t411"]')).toHaveCount(0);
      await expect(overlay.locator('[data-testid="workflow-link-line"]')).toHaveCount(2);
    } finally {
      await browser.close();
    }
  });

  test('a task the workflow replaced at Start says so under its Done row, in the workflow\'s color', async () => {
    const { browser, page } = await launch({ supersededSource: true });
    try {
      const sourceRow = page.locator('[data-board-lanes] [data-task-id="t409"]').locator('..');
      const line = sourceRow.locator('[data-testid="superseded-line"]');
      await expect(line).toHaveText('Superseded by Usage budgets');
      await expect(line.locator('svg')).toHaveAttribute('style', /--color-chart-5/);
      // A completed task of the workflow itself is not superseded by it: #409's is the only line.
      await expect(page.locator('[data-board-lanes] [data-task-id="t411"]').locator('..').locator('[data-testid="superseded-line"]')).toHaveCount(0);
      await expect(page.locator('[data-board-lanes] [data-testid="superseded-line"]')).toHaveCount(1);

      // A rename reaches the line through the workflow's change push.
      await page.evaluate(() => window.electronAPI.workflows.rename('workflows-board-proj', 'wf-usage', 'Spend limits'));
      await expect(line).toHaveText('Superseded by Spend limits');
    } finally {
      await browser.close();
    }
  });

  test('the line stays once the workflow has finished and left the picker', async () => {
    const { browser, page } = await launch({ supersededSource: true, state: 'done' });
    try {
      const line = page.locator('[data-board-lanes] [data-task-id="t409"]').locator('..').locator('[data-testid="superseded-line"]');
      await expect(line).toHaveText('Superseded by Usage budgets');
      await expect(line.locator('svg')).toHaveAttribute('style', /--color-chart-5/);
      await expect(page.locator('[data-board-lanes] [data-testid="superseded-line"]')).toHaveCount(1);
      // Finished: the summaries the board loads leave it out, so the Workflows segment counts none.
      await expect.poll(() => page.evaluate(() => window.electronAPI.workflows.list('workflows-board-proj').then((summaries) => summaries.length))).toBe(0);
      await expect(byTestId(page, 'view-toggle-workflows')).toHaveAttribute('aria-label', 'Workflows');
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

  test('Open workflow on a card whose workflow lives on another board switches to that board and lands on the task', async () => {
    const { browser, page } = await launch({ homeElsewhere: true });
    try {
      const currentProjectId = () => page.evaluate(() => (
        window as unknown as { __zustandStores: { project: { getState: () => { currentProject: { id: string } | null } } } }
      ).__zustandStores.project.getState().currentProject?.id ?? null);
      expect(await currentProjectId()).toBe(PROJECT_ID);

      await openMenu(page, 't414');
      await byTestId(page, 'context-open-workflow').click();

      // The other board is open, and so is the Workflows view on it.
      await expect.poll(currentProjectId).toBe(HOME_PROJECT_ID);
      await expect(byTestId(page, 'workflows-view')).toBeVisible();
      // That board lists its decoy first. The open waits for the board's list,
      // then picks the card's own workflow and task rather than the first.
      await expect(byTestId(page, 'workflow-picker')).toContainText('Usage budgets');
      await expect(byTestId(page, 'workflow-picker')).not.toContainText('Decoy plan');
      await expect(byTestId(page, 'workflow-inspector-title')).toContainText('Refuse to spawn past the hard cap');
    } finally {
      await browser.close();
    }
  });

  test('task detail\'s Workflow panel edits the task\'s own route and links, with the same guards', async () => {
    const { browser, page } = await launch();
    try {
      // #414 is in Executing: its window opens on the session view.
      await boardCard(page, 't414').click();
      await byTestId(page, 'task-detail-dialog').waitFor({ state: 'visible' });
      await page.locator('[data-testid="task-detail-dialog"] [data-testid="workflow-toggle"]').click();
      const panel = byTestId(page, 'task-workflow-panel');
      await expect(panel.locator('[data-testid="task-workflow-panel-header"]')).toHaveCSS('font-weight', '600');
      await expect(panel.locator('[data-testid="workflow-panel-workflow"]')).toContainText('Usage budgets');
      await expect(panel.locator('[data-testid="workflow-state-chip"]')).toHaveAttribute('data-state', 'running');
      await expect(panel.locator('[data-testid="workflow-route-switch-lane-1"]')).toHaveAccessibleDescription('#414 has reached Executing. Only the columns after it can change.');
      await expect(panel.locator('[data-testid="workflow-link-row"][data-task-key="t412"] [data-testid="workflow-unlink"]')).toBeDisabled();

      // A step still ahead switches off, in the task's own workflow.
      await panel.locator('[data-testid="workflow-route-switch-lane-3"]').click();
      await expect(panel.locator('[data-testid="workflow-route-row"]').nth(2)).toHaveAttribute('data-step-state', 'skipped');

      // Open workflow lands on the Workflows view with this task selected.
      await panel.locator('[data-testid="workflow-open-task"]').click();
      await expect(byTestId(page, 'workflows-view')).toBeVisible();
      await expect(byTestId(page, 'workflow-inspector-title')).toContainText('Refuse to spawn past the hard cap');
    } finally {
      await browser.close();
    }
  });

  test('a running task\'s header puts the Workflow toggle last among its pills, after Conversation', async () => {
    const { browser, page } = await launch({ session414: true });
    try {
      await boardCard(page, 't414').click();
      const header = page.locator('[data-testid="task-detail-dialog"] [data-testid="task-detail-titlebar"]');
      await header.locator('[data-pill-id="workflow"]').waitFor({ state: 'visible' });
      const pillIds = await header.locator('[data-pill-id]').evaluateAll((pills) => pills.map((pill) => pill.getAttribute('data-pill-id')));
      expect(pillIds.indexOf('conversation')).toBeGreaterThanOrEqual(0);
      expect(pillIds.indexOf('workflow')).toBe(pillIds.indexOf('conversation') + 1);
      // The session header keeps its own divider before the window controls; the form's is separate.
      await expect(header.locator('[data-testid="edit-titlebar-divider"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a To Do task opens in the form, and its Workflow panel is there too', async () => {
    const { browser, page } = await launch();
    try {
      await boardCard(page, 't415').click();
      await byTestId(page, 'task-detail-edit-scroll').waitFor({ state: 'visible' });
      // The form's title bar divides the Workflow toggle from the window controls,
      // with the divider the session header draws before them.
      const titleBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="task-detail-titlebar"]');
      await expect(titleBar.locator('[data-testid="edit-titlebar-divider"]')).toBeVisible();
      await expect(titleBar.locator('[data-testid="edit-titlebar-divider"]')).toHaveClass('w-px h-5 bg-surface-hover flex-shrink-0');
      await page.locator('[data-testid="task-detail-dialog"] [data-testid="workflow-toggle"]').click();
      const panel = byTestId(page, 'task-workflow-panel');
      // It waits for #413, which is not done, so the link is live and Add blocker is offered.
      await expect(panel.locator('[data-testid="workflow-link-row"][data-task-key="t413"] [data-testid="workflow-unlink"]')).toBeEnabled();
      await expect(panel.locator('[data-testid="workflow-add-blocker"]')).toBeEnabled();
      await page.locator('[data-testid="task-workflow-panel-close"]').click();
      await expect(panel).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a task whose workflow was deleted gets a Workflow panel that says so, not one that loads forever', async () => {
    const { browser, page } = await launch({ orphanTask: true });
    try {
      await boardCard(page, 't421').click();
      await byTestId(page, 'task-detail-edit-scroll').waitFor({ state: 'visible' });
      await page.locator('[data-testid="task-detail-dialog"] [data-testid="workflow-toggle"]').click();
      const panel = byTestId(page, 'task-workflow-panel');
      await expect(panel.locator('[data-testid="workflow-panel-gone"]')).toHaveText('The workflow this task was in no longer exists.');
      await expect(panel.locator('[data-testid="workflow-panel-loading"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a task whose workflow cannot be read right now gets a Workflow panel that says so, not "gone" or a load that never ends, and the next change brings the workflow back', async () => {
    // #415 is in the live workflow, so the failure is a passing one, not a deletion.
    const { browser, page } = await launch();
    try {
      await failWorkflowReads(page);
      await boardCard(page, 't415').click();
      await byTestId(page, 'task-detail-edit-scroll').waitFor({ state: 'visible' });
      await page.locator('[data-testid="task-detail-dialog"] [data-testid="workflow-toggle"]').click();
      const panel = byTestId(page, 'task-workflow-panel');
      await expect(panel.locator('[data-testid="workflow-panel-unreadable"]')).toHaveText('The workflow this task is in could not be loaded.');
      await expect(panel.locator('[data-testid="workflow-panel-loading"]')).toHaveCount(0);
      await expect(panel.locator('[data-testid="workflow-panel-gone"]')).toHaveCount(0);

      // The failure was passing: the next change push reads again and the inspector replaces the message.
      await recoverWorkflowReads(page, 'wf-usage');
      await expect(panel.locator('[data-testid="workflow-link-row"][data-task-key="t413"]')).toBeVisible();
      await expect(panel.locator('[data-testid="workflow-panel-unreadable"]')).toHaveCount(0);
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

  test('a workflow card\'s menu opened low in a short window stays inside it, its last item showing', async () => {
    const viewport = { width: 900, height: 600 };
    const { browser, page } = await launch({ viewport });
    try {
      // The lowest point on screen that lands on a workflow card in To Do.
      const press = await page.evaluate(() => {
        const lane = document.querySelector('[data-board-lanes] [data-testid="swimlane"][data-swimlane-name="To Do"]');
        let lowest: { x: number; y: number } | null = null;
        for (const card of Array.from(lane?.querySelectorAll('[data-task-id]') ?? [])) {
          if (!card.querySelector('[data-testid="workflow-card-strip"]')) continue;
          const rect = card.getBoundingClientRect();
          const x = rect.left + 24;
          for (let y = Math.min(rect.bottom - 4, window.innerHeight - 4); y > rect.top; y -= 4) {
            if (!card.contains(document.elementFromPoint(x, y))) continue;
            if (!lowest || y > lowest.y) lowest = { x, y };
            break;
          }
        }
        return lowest;
      });
      if (!press) throw new Error('No workflow card on screen in To Do');
      await page.mouse.click(press.x, press.y, { button: 'right' });
      const menu = byTestId(page, 'task-context-menu');
      await menu.waitFor({ state: 'visible' });
      await expect(menu.locator('[data-testid="context-open-workflow"]')).toBeVisible();
      // Its entrance scales it up from the corner; measure the settled menu.
      await expect.poll(() => menu.evaluate((element) => element.getAnimations().every((animation) => animation.playState === 'finished'))).toBe(true);

      const menuBox = await menu.boundingBox();
      if (!menuBox) throw new Error('No box for the menu');
      // The menu does not fit below the press, so it had to move up to stay inside.
      expect(press.y + menuBox.height).toBeGreaterThan(viewport.height);
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.y).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
      await expect(byTestId(page, 'context-delete-task')).toBeInViewport({ ratio: 1 });
    } finally {
      await browser.close();
    }
  });
});
