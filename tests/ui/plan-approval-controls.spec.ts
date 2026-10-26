/**
 * UI tests for the Plan approval controls that the base specs
 * (board-manager-dialog.spec.ts, workflows-view.spec.ts) leave open:
 *
 * - Under a Board Profile the Column Manager locks both options, with the reason.
 * - Changing a plan column's agent to one that cannot approve plans resets the
 *   value that gets SAVED to Manual (the control would only DISPLAY Manual).
 * - A column that is not in plan mode never sends a plan_approval change, so a
 *   stored Automatic survives an unrelated edit.
 * - A workflow task's own Plan approval offers Automatic only when some plan
 *   column on its route runs an agent that can approve plans, and task detail's
 *   Workflow panel draws the same control.
 *
 * Every test launches its own page: the mock keeps swimlane state in the page,
 * so a shared page would leak one test's seeded Automatic or agent override
 * into the next. Assertions read state (aria attributes, stored rows), never
 * pixels (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import type { BoardProfile } from '../../src/shared/types';
import { waitForViteReady, gotoVite, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROFILE_ID = 'profile-heavy';
const PROFILE_REASON = 'Plan approval is shared by every profile. Switch to Default to change it.';
const CODEX_COLUMN_REASON = "Kangentic can't approve Codex CLI's plans, so they wait for you.";
const TASK_AUTOMATIC_TIP = "Approve this task's plans for you. Questions the agent asks still wait.";
const TASK_MANUAL_TIP = "You approve this task's plans.";

interface BoardLaunchOptions {
  /** Board Profiles the mock serves from the start. */
  boardProfiles?: BoardProfile[];
  /** Per-agent patches over the mock's agents.list(), e.g. `{ codex: { found: true } }`. */
  agentListOverrides?: Record<string, Record<string, unknown>>;
}

/** A project on the headless mock, at the board. Mock seeds go in before the mock script reads them. */
async function launchBoard(options: BoardLaunchOptions = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
    if (options.boardProfiles) {
      // The mock reads the board's profiles once, when it loads, so they go in first.
      await page.addInitScript((profiles) => { window.__mockBoardProfiles = profiles; }, options.boardProfiles);
    }
    await page.addInitScript({ path: MOCK_SCRIPT });
    if (options.agentListOverrides) {
      await page.addInitScript((overrides) => { window.__mockAgentListOverrides = overrides; }, options.agentListOverrides);
    }
    await gotoVite(page, VITE_URL);
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(page, `Plan Approval ${Date.now()}`);
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function openColumnManager(page: Page, columnName: string): Promise<void> {
  await page.locator(`[data-swimlane-name="${columnName}"]`).locator(`text=${columnName}`).click();
  await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 3000 });
}

/** Re-read the board after a direct mock write, so the next dialog drafts from it. */
async function reloadBoard(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { loadBoard: () => Promise<void> } } };
    }).__zustandStores;
    // Without the store the dialog would draft from the stale board and the
    // spec would pass for the wrong reason.
    if (!stores) throw new Error('window.__zustandStores is not exposed');
    await stores.board.getState().loadBoard();
  });
}

/** A column's stored row, read through the bridge the board uses. */
async function readColumn(
  page: Page,
  columnName: string,
): Promise<{ plan_approval: string | undefined; agent_override: string | null; description: string | null }> {
  return page.evaluate(async (wanted) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const lane = lanes.find((candidate) => candidate.name === wanted);
    if (!lane) throw new Error(`No column named ${wanted}`);
    return { plan_approval: lane.plan_approval, agent_override: lane.agent_override, description: lane.description };
  }, columnName);
}

test.describe('Column Manager Plan approval', () => {
  test('a Board Profile locks both options and says why; Default unlocks them', async () => {
    const { browser, page } = await launchBoard({ boardProfiles: [{ id: PROFILE_ID, name: 'Heavy', columns: {} }] });
    try {
      await openColumnManager(page, 'Planning');
      const dialog = page.locator('[data-testid="board-manager-dialog"]');
      const automatic = dialog.locator('[data-testid="column-plan-approval-automatic"]');
      const manual = dialog.locator('[data-testid="column-plan-approval-manual"]');

      // Under Default the claude column can use either option: this is what keeps
      // the locked state below from passing for some other reason.
      await expect(automatic).toBeEnabled();
      await expect(manual).toBeEnabled();
      await expect(automatic).toHaveAccessibleDescription('Approve each plan for you. Questions the agent asks still wait.');

      await dialog.locator('[data-testid="board-manager-profile-select"]').selectOption(PROFILE_ID);
      await expect(dialog.locator('[data-testid="board-manager-active-profile-pill"]')).toHaveText('Heavy');
      await expect(automatic).toBeDisabled();
      await expect(manual).toBeDisabled();
      await expect(automatic).toHaveAccessibleDescription(PROFILE_REASON);
      await expect(manual).toHaveAccessibleDescription(PROFILE_REASON);

      // Back to Default, the column's own value is editable again.
      await dialog.locator('[data-testid="board-manager-profile-select"]').selectOption('');
      await expect(automatic).toBeEnabled();
      await expect(manual).toBeEnabled();
    } finally {
      await browser.close();
    }
  });

  test('switching the agent to one that cannot approve plans saves Manual, not the Automatic picked before', async () => {
    const { browser, page } = await launchBoard({ agentListOverrides: { codex: { found: true } } });
    try {
      await openColumnManager(page, 'Planning');
      const dialog = page.locator('[data-testid="board-manager-dialog"]');
      const automatic = dialog.locator('[data-testid="column-plan-approval-automatic"]');
      const manual = dialog.locator('[data-testid="column-plan-approval-manual"]');

      // Claude can approve plans: Automatic lands.
      await automatic.click();
      await expect(automatic).toHaveAttribute('aria-checked', 'true');

      // The combobox menu portals to document.body, so the option is page-scoped.
      const agentInput = dialog.locator('input[data-testid="column-agent-override"]');
      await agentInput.click();
      await page.locator('[data-testid="column-agent-override-option-codex"]').click();
      await expect(agentInput).toHaveValue('Codex CLI');
      await expect(manual).toHaveAttribute('aria-checked', 'true');
      await expect(automatic).toBeDisabled();
      await expect(automatic).toHaveAccessibleDescription(CODEX_COLUMN_REASON);

      await dialog.locator('[data-testid="board-manager-save"]').click();
      await dialog.waitFor({ state: 'detached', timeout: 3000 });

      // The control shows Manual for such an agent whatever the draft holds, so
      // only the saved row proves the draft was reset, not just displayed.
      await expect.poll(() => readColumn(page, 'Planning')).toMatchObject({ agent_override: 'codex', plan_approval: 'manual' });
    } finally {
      await browser.close();
    }
  });

  test('saving a column that is not in plan mode sends no plan_approval and keeps a stored Automatic', async () => {
    const { browser, page } = await launchBoard();
    try {
      // A teammate's board: Code Review (no plan mode) carrying a stored Automatic.
      await page.evaluate(async () => {
        const lanes = await window.electronAPI.swimlanes.list();
        const lane = lanes.find((candidate) => candidate.name === 'Code Review');
        if (lane) await window.electronAPI.swimlanes.update({ id: lane.id, plan_approval: 'automatic' });
      });
      await reloadBoard(page);
      await expect.poll(() => readColumn(page, 'Code Review')).toMatchObject({ plan_approval: 'automatic' });

      // Spy on the update the dialog sends, and forward it untouched. The mock
      // applies only the keys that are not undefined, as the real repository
      // does (swimlane-repository.ts).
      await page.evaluate(() => {
        const spy = window as unknown as { __updateInputs?: Array<{ id: string; planApproval: string }> };
        spy.__updateInputs = [];
        const original = window.electronAPI.swimlanes.update;
        window.electronAPI.swimlanes.update = async (input) => {
          spy.__updateInputs?.push({
            id: input.id,
            planApproval: input.plan_approval === undefined ? 'not sent' : String(input.plan_approval),
          });
          return original(input);
        };
      });

      await openColumnManager(page, 'Code Review');
      const dialog = page.locator('[data-testid="board-manager-dialog"]');
      await expect(dialog.locator('[data-testid="column-plan-approval"]')).toHaveCount(0);

      // An unrelated edit, so the column is dirty and Save sends it.
      await dialog.locator('[data-testid="board-manager-description"]').fill('Reviews the diff before Testing.');
      await dialog.locator('[data-testid="board-manager-save"]').click();
      await dialog.waitFor({ state: 'detached', timeout: 3000 });

      const sentInputs = await page.evaluate(
        () => (window as unknown as { __updateInputs: Array<{ id: string; planApproval: string }> }).__updateInputs,
      );
      expect(sentInputs).toHaveLength(1);
      expect(sentInputs[0].planApproval).toBe('not sent');

      await expect.poll(() => readColumn(page, 'Code Review')).toMatchObject({
        description: 'Reviews the diff before Testing.',
        plan_approval: 'automatic',
      });
    } finally {
      await browser.close();
    }
  });
});

const WORKFLOW_PROJECT_ID = 'plan-approval-proj';
const WORKFLOW_ID = 'wf-plan-approval';

interface PlanningSeed {
  /** The Planning column's own agent override. */
  agentOverride: string | null;
  planApproval: 'manual' | 'automatic';
  /** An agent override set on each of the workflow's tasks. Left out, the tasks carry none. */
  taskAgentOverride?: string | null;
  /** A Plan approval stored on each of the workflow's tasks (the task row's own field). Left out, the tasks store none. */
  taskPlanApproval?: 'manual' | 'automatic' | null;
}

/**
 * One running workflow whose three tasks wait in To Do, so every column on their
 * default route is "ahead", Planning among them. The Planning lane is seeded with
 * the given agent and Plan approval, and each task with the given agent override
 * and stored Plan approval, before the app loads.
 */
function workflowSeedScript(planning: PlanningSeed): string {
  const workflow = { workflow: { id: WORKFLOW_ID, title: 'Plan approval', state: 'running', draft: null, color_slot: 5 } };
  const taskRows: Array<[number, string]> = [[501, 'First task'], [502, 'Second task'], [503, 'Third task']];
  return `
    window.__mockWorkflows = ${JSON.stringify([workflow])};
    window.__mockWorkflowLinks = [];
    window.__mockPreConfigure(function (state) {
      var seededAt = new Date().toISOString();
      state.config.sidebar = { width: 240 };
      state.config.sidebarVisible = true;
      // The Workflow agent, so the workflow starts as in a set-up install.
      state.config.workflows = { agent: 'claude', model: 'haiku', effort: null };
      state.projects.push({ id: '${WORKFLOW_PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: seededAt, created_at: seededAt });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: seededAt }));
      });
      state.swimlanes.forEach(function (lane) {
        if (lane.name === 'Planning') {
          lane.agent_override = ${JSON.stringify(planning.agentOverride)};
          lane.plan_approval = ${JSON.stringify(planning.planApproval)};
        }
      });
      ${JSON.stringify(taskRows)}.forEach(function (row, index) {
        state.tasks.push({
          id: 't' + row[0], display_id: row[0], title: row[1], description: 'Planned by the workflow agent.',
          swimlane_id: 'lane-0', position: index, agent: 'claude', agent_override: ${JSON.stringify(planning.taskAgentOverride ?? null)}, session_id: null, worktree_path: null, branch_name: null,
          pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: 0, labels: [], priority: 0,
          plan_approval: ${JSON.stringify(planning.taskPlanApproval ?? null)},
          attachment_count: 0, archived_at: null, workflow_id: '${WORKFLOW_ID}', workflow_project_id: '${WORKFLOW_PROJECT_ID}',
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
          created_at: seededAt, updated_at: seededAt,
        });
      });
      return { currentProjectId: '${WORKFLOW_PROJECT_ID}' };
    });
  `;
}

/**
 * The seeded workflow, either in the Workflows view (the inspector opens on the
 * first task, whose route visits Planning) or on the board.
 */
async function launchWorkflowPage(
  planning: PlanningSeed,
  view: 'workflows' | 'board' = 'workflows',
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(workflowSeedScript(planning));
    await gotoVite(page, VITE_URL);
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    if (view === 'workflows') {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      await page.locator('[data-testid="workflows-view"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.locator('[data-testid="workflow-task-plan-approval-section"]')).toBeVisible();
    }
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

const automaticOption = (page: Page) => page.locator('[data-testid="workflow-task-plan-approval-automatic"]');
const manualOption = (page: Page) => page.locator('[data-testid="workflow-task-plan-approval-manual"]');

test.describe('Workflow task Plan approval availability', () => {
  test('where its plan column runs an agent that cannot approve plans, Manual is lit and Automatic is off with the reason', async () => {
    // Planning is the board's only plan column. A teammate stored Automatic on it,
    // which Codex can never act on, so the task reads Manual.
    const { browser, page } = await launchWorkflowPage({ agentOverride: 'codex', planApproval: 'automatic' });
    try {
      const section = page.locator('[data-testid="workflow-task-plan-approval-section"]');
      const automatic = automaticOption(page);
      const manual = manualOption(page);

      await expect(manual).toHaveAttribute('aria-checked', 'true');
      await expect(automatic).toHaveAttribute('aria-checked', 'false');
      await expect(section).toHaveAttribute('data-set', 'columns');
      await expect(automatic).toBeDisabled();
      await expect(automatic).toHaveAccessibleDescription(CODEX_COLUMN_REASON);
      // Only Automatic is off. The whole control is also disabled when the host
      // gives it no setter, which would disable Manual too.
      await expect(manual).toBeEnabled();
      await expect(manual).toHaveAccessibleDescription("Manual, because Kangentic can't approve Codex CLI's plans.");
    } finally {
      await browser.close();
    }
  });

  test("picking the lit Manual clears a stale Automatic stored on the task, which a Codex plan column hides", async () => {
    // Each task stored Automatic back when its plan column ran an agent Kangentic
    // can approve plans for. The column now runs Codex, so the task reads Manual
    // (lit) while its own stored value is still Automatic (data-set="automatic").
    // The pick must be judged against what is stored, not what is lit: judged
    // against the lit value, Manual is a no-op and the stale override can never
    // be cleared from the UI.
    const { browser, page } = await launchWorkflowPage({
      agentOverride: 'codex',
      planApproval: 'automatic',
      taskPlanApproval: 'automatic',
    });
    try {
      const section = page.locator('[data-testid="workflow-task-plan-approval-section"]');
      const automatic = automaticOption(page);
      const manual = manualOption(page);

      await expect(manual).toHaveAttribute('aria-checked', 'true');
      await expect(automatic).toHaveAttribute('aria-checked', 'false');
      await expect(automatic).toBeDisabled();
      await expect(section).toHaveAttribute('data-set', 'automatic');

      const readStored = () => page.evaluate(async () => {
        const detail = await window.electronAPI.workflows.get('plan-approval-proj', 'wf-plan-approval');
        return Object.fromEntries(detail.tasks.map((workflowTask) => [workflowTask.key, workflowTask.task?.plan_approval ?? null]));
      });
      expect(await readStored()).toEqual({ t501: 'automatic', t502: 'automatic', t503: 'automatic' });

      // Record what the inspector sends, and forward it untouched.
      await page.evaluate(() => {
        const spy = window as unknown as { __planApprovalCalls?: Array<{ key: string; planApproval: string | null }> };
        spy.__planApprovalCalls = [];
        const original = window.electronAPI.workflows.setTaskPlanApproval;
        window.electronAPI.workflows.setTaskPlanApproval = async (projectId, workflowId, key, planApproval) => {
          spy.__planApprovalCalls?.push({ key, planApproval });
          return original(projectId, workflowId, key, planApproval);
        };
      });

      await manual.click();

      // The stored value is gone, so the task follows its plan columns again.
      await expect(section).toHaveAttribute('data-set', 'columns');
      await expect(manual).toHaveAttribute('aria-checked', 'true');
      const calls = await page.evaluate(
        () => (window as unknown as { __planApprovalCalls: Array<{ key: string; planApproval: string | null }> }).__planApprovalCalls,
      );
      // One call, carrying null (clear the override), not the raw 'manual' pick.
      expect(calls).toHaveLength(1);
      expect(calls[0].planApproval).toBeNull();
      // Only the inspected task changed.
      const expectedStored: Record<string, string | null> = { t501: 'automatic', t502: 'automatic', t503: 'automatic' };
      expectedStored[calls[0].key] = null;
      expect(await readStored()).toEqual(expectedStored);
    } finally {
      await browser.close();
    }
  });

  test("a task's own agent beats the plan column's: a Claude task on a Codex column still offers Automatic", async () => {
    // The agent that runs a task in a column is the task's override first, then
    // the column's, then the project's default. The column runs Codex, which
    // cannot approve plans, but every task is pinned to Claude, which can. Were
    // the column's agent to win, Automatic would be disabled with the reason.
    const { browser, page } = await launchWorkflowPage({
      agentOverride: 'codex',
      planApproval: 'automatic',
      taskAgentOverride: 'claude',
    });
    try {
      const section = page.locator('[data-testid="workflow-task-plan-approval-section"]');
      const automatic = automaticOption(page);
      const manual = manualOption(page);

      await expect(automatic).toBeEnabled();
      // Not set: the value is the plan column's own Automatic, which now takes effect.
      await expect(automatic).toHaveAttribute('aria-checked', 'true');
      await expect(automatic).toHaveAccessibleDescription("Automatic, from kangentic's Planning column.");
      await expect(manual).toHaveAttribute('aria-checked', 'false');
      await expect(manual).toHaveAccessibleDescription(TASK_MANUAL_TIP);
      await expect(section).toHaveAttribute('data-set', 'columns');
    } finally {
      await browser.close();
    }
  });

  test('with the default Claude plan column, Automatic is offered and enabled', async () => {
    const { browser, page } = await launchWorkflowPage({ agentOverride: null, planApproval: 'manual' });
    try {
      const automatic = automaticOption(page);
      const manual = manualOption(page);

      await expect(manual).toHaveAttribute('aria-checked', 'true');
      await expect(automatic).toBeEnabled();
      await expect(manual).toBeEnabled();
      await expect(automatic).toHaveAccessibleDescription(TASK_AUTOMATIC_TIP);
    } finally {
      await browser.close();
    }
  });

  test("task detail's Workflow panel draws the same control, above the route, and a pick sets the task's own value", async () => {
    const { browser, page } = await launchWorkflowPage({ agentOverride: null, planApproval: 'manual' }, 'board');
    try {
      await page.locator('[data-board-lanes] [data-task-id="t501"]').click();
      await page.locator('[data-testid="task-detail-edit-scroll"]').waitFor({ state: 'visible' });
      await page.locator('[data-testid="task-detail-dialog"] [data-testid="workflow-toggle"]').click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      const section = dialog.locator('[data-testid="workflow-task-plan-approval-section"]');
      await expect(section).toBeVisible();
      await expect(dialog.locator('[data-testid="workflow-route-row"]').first()).toBeVisible();
      const sectionFirst = await page.evaluate(() => {
        const host = document.querySelector('[data-testid="task-detail-dialog"]');
        const approval = host?.querySelector('[data-testid="workflow-task-plan-approval-section"]');
        const route = host?.querySelector('[data-testid="workflow-route-row"]');
        return !!approval && !!route && (approval.compareDocumentPosition(route) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      expect(sectionFirst).toBe(true);

      await dialog.locator('[data-testid="workflow-task-plan-approval-automatic"]').click();
      await expect(section).toHaveAttribute('data-set', 'automatic');
      const stored = await page.evaluate(async () => {
        const detail = await window.electronAPI.workflows.get('plan-approval-proj', 'wf-plan-approval');
        return detail.tasks.find((task) => task.key === 't501')?.task?.plan_approval ?? null;
      });
      expect(stored).toBe('automatic');
    } finally {
      await browser.close();
    }
  });
});
