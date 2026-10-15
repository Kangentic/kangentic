/**
 * A planned task's form (#732, sign-offs 9 and 25): Add task and a planned
 * task's editor are the board's own New Task form, led by the project picker,
 * with Base branch, Worktree or Project, and Column Settings or Agent
 * Override. What the form chooses round-trips through the workflow's draft,
 * and Save waits while the workflow agent's turn runs. A task on another
 * project's board reads that board's facts: its branches, default base
 * branch, Worktrees switch, default agent and profiles.
 *
 * Assertions read state (values, aria attributes, the mock's stored draft),
 * never pixels (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'planned-form-proj';
const OTHER_PROJECT_ID = 'planned-form-mobile';
const WORKFLOW_ID = 'wf-draft';

function plannedTask(key: string, title: string, settings: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key, title, description: `${title}, planned by the workflow agent.`, project_id: null, existing_task_id: null,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
    labels: [], priority: 0, canvas_x: null, canvas_y: null,
    ...settings,
  };
}

function seedScript(): string {
  const workflow = {
    workflow: {
      id: WORKFLOW_ID, title: 'Theme tokens', state: 'draft', color_slot: 2,
      draft: {
        tasks: [
          plannedTask('task-1', 'Token table'),
          // What the workflow agent saved for it: a pinned agent on the project folder.
          plannedTask('task-2', 'Token picker', {
            base_branch: 'develop', use_worktree: 0, run_mode: 'agent_override', profile_id: null,
            agent_override: 'claude', model_override: null, effort_override: 'high', permission_mode: 'plan',
          }),
          // On the other board, with that board's profile, as the workflow agent set it over MCP.
          plannedTask('task-3', 'Token picker on the phone', {
            project_id: OTHER_PROJECT_ID, base_branch: 'release/phone', run_mode: 'column_settings', profile_id: 'profile-phone',
          }),
          // A profile its board has since deleted.
          plannedTask('task-4', 'Token audit', { run_mode: 'column_settings', profile_id: 'profile-gone' }),
        ],
        links: [],
      },
    },
  };
  return `
    window.__mockWorkflows = ${JSON.stringify([workflow])};
    // The other board's own facts: its branches and its profiles.
    window.__mockGitBranchesByProject = { '${OTHER_PROJECT_ID}': ['trunk', 'release/phone'] };
    window.__mockBoardProfilesByProject = { '${OTHER_PROJECT_ID}': [{ id: 'profile-phone', name: 'Phone', columns: {} }] };
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      // The Workflow agent, which no workflow agent starts without.
      state.config.workflows = { agent: 'claude', model: 'haiku', effort: null };
      state.projects.push({ id: '${PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.projects.push({ id: '${OTHER_PROJECT_ID}', name: 'kangentic-mobile', path: '/mock/kangentic-mobile', github_url: null, default_agent: 'codex', group_id: null, position: 1, last_opened: ts, created_at: ts });
      // Its default base branch, and its Worktrees switch off.
      state.projectConfigs['/mock/kangentic-mobile'] = { git: { defaultBaseBranch: 'trunk', worktreesEnabled: false } };
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: ts }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1700, height: 1000 } })).newPage();
  // The mock reads the board's profiles when it loads, so they go in first.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__mockBoardProfiles = [{ id: 'profile-heavy', name: 'Heavy', columns: {} }];
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript());
  await gotoVite(page, VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="view-toggle-workflows"]').click();
  await page.locator('[data-testid="workflows-view"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const byTestId = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);
const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);

async function selectCombobox(page: Page, testId: string, optionValue: string): Promise<void> {
  await page.locator(`input[data-testid="${testId}"]`).click();
  await page.locator(`[data-testid="${testId}-option-${optionValue}"]`).click();
}

/** A planned task as the mock's draft holds it, read through the bridge the view uses. */
async function plannedRow(page: Page, title: string): Promise<Record<string, unknown> | null> {
  return page.evaluate(async ([projectId, workflowId, wanted]) => {
    const detail = await window.electronAPI.workflows.get(projectId, workflowId);
    const found = detail.tasks.find((task) => task.title === wanted);
    return found?.planned ? { ...found.planned } : null;
  }, [PROJECT_ID, WORKFLOW_ID, title] as const);
}

/** The workflow agent's session id, read off its mounted terminal. */
async function agentSessionId(page: Page): Promise<string> {
  const handle = await page.waitForFunction(() => (
    document.querySelector('[data-testid="workflow-agent-terminal-pane"]')?.getAttribute('data-session-id') ?? null
  ));
  return String(await handle.jsonValue());
}

test('a planned task opens with the pencil, the project, Base branch and the run choice it holds', async () => {
  const { browser, page } = await launch();
  try {
    await card(page, 'task-2').dblclick();
    const dialog = byTestId(page, 'new-task-dialog');
    await expect(dialog).toContainText('Edit Task');
    await expect(dialog.locator('[data-testid="new-task-dialog-edit-icon"]')).toHaveCount(1);
    await expect(dialog.locator('input[data-testid="workflow-task-project"]')).toHaveValue('kangentic');
    await expect(dialog.locator('[data-testid="workflow-task-project-divider"]')).toHaveCount(1);
    // Base branch, Worktree or Project: the board form's row, without the branch name.
    await expect(dialog.locator('[data-testid="task-branch-row"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="custom-branch-name-input"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="task-branch-row"]')).toContainText('develop');
    await expect(dialog.locator('[data-testid="worktree-option-project"]')).toHaveAttribute('aria-checked', 'true');
    // Agent Override, as the plan saved it.
    await expect(dialog.locator('[data-testid="task-advanced-toggle"]')).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.locator('input[data-testid="task-agent-override"]')).toHaveValue('Claude Code');
    await expect(dialog.locator('input[data-testid="task-effort-override"]')).toHaveValue('high');
    await expect(dialog.locator('input[data-testid="task-permission-override"]')).toHaveValue('Plan (Read-Only)');
  } finally {
    await browser.close();
  }
});

test('choosing Agent Override and saving writes the draft, and the task reopens with it', async () => {
  const { browser, page } = await launch();
  try {
    await card(page, 'task-1').dblclick();
    const dialog = byTestId(page, 'new-task-dialog');
    await expect(dialog.locator('[data-testid="task-run-mode-profile"]')).toHaveAttribute('aria-checked', 'true');
    await dialog.locator('[data-testid="task-advanced-toggle"]').click();
    await selectCombobox(page, 'task-effort-override', 'medium');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(() => plannedRow(page, 'Token table')).toMatchObject({
      run_mode: 'agent_override', effort_override: 'medium', profile_id: null, base_branch: null, use_worktree: null,
    });

    await card(page, 'task-1').dblclick();
    await expect(dialog.locator('[data-testid="task-advanced-toggle"]')).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.locator('input[data-testid="task-effort-override"]')).toHaveValue('medium');
  } finally {
    await browser.close();
  }
});

test('Save waits with the reason while the workflow agent works', async () => {
  const { browser, page } = await launch();
  try {
    const sessionId = await agentSessionId(page);
    await card(page, 'task-1').dblclick();
    const save = byTestId(page, 'new-task-dialog').getByRole('button', { name: 'Save' });
    await expect(save).toBeEnabled();

    await page.evaluate(([id, projectId, workflowId]) => {
      window.__mockFireActivity(id, 'thinking', null, projectId, workflowId);
    }, [sessionId, PROJECT_ID, WORKFLOW_ID]);
    await expect(save).toBeDisabled();
    await expect(save).toHaveAccessibleDescription('Available when the workflow agent finishes');

    await page.evaluate(([id, projectId, workflowId]) => {
      window.__mockFireActivity(id, 'idle', null, projectId, workflowId);
    }, [sessionId, PROJECT_ID, WORKFLOW_ID]);
    await expect(save).toBeEnabled();
    await expect(save).toHaveAccessibleDescription('');
  } finally {
    await browser.close();
  }
});

test('Add task shows the same rows, and Create stores the board, the placement and the run choice', async () => {
  const { browser, page } = await launch();
  try {
    await byTestId(page, 'workflow-add-task').click();
    const dialog = byTestId(page, 'new-task-dialog');
    await expect(dialog).toContainText('New Task');
    await expect(dialog.locator('[data-testid="new-task-dialog-add-icon"]')).toHaveCount(1);
    await expect(dialog.locator('input[data-testid="workflow-task-project"]')).toHaveValue('kangentic');
    await expect(dialog.locator('[data-testid="task-branch-row"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="task-run-mode"]')).toBeVisible();
    // This board's profiles are listed for a task on this board.
    await expect(dialog.locator('[data-testid="task-profile-select"]')).toBeEnabled();
    await expect(dialog.locator('[data-testid="task-profile-select"] option')).toHaveText(['Default', 'Heavy']);

    await dialog.locator('[data-testid="worktree-option-project"]').click();
    await dialog.getByPlaceholder('Task title').fill('Token contrast check');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(() => plannedRow(page, 'Token contrast check')).toMatchObject({
      project_id: null, use_worktree: 0, run_mode: 'column_settings', base_branch: null,
    });
  } finally {
    await browser.close();
  }
});

test('on another board the form reads that board: its branches, base branch, Worktrees switch, agent and profiles', async () => {
  const { browser, page } = await launch();
  try {
    await byTestId(page, 'workflow-add-task').click();
    const dialog = byTestId(page, 'new-task-dialog');
    const baseBranch = dialog.locator('[data-testid="branch-picker-chip"]');
    const profileSelect = dialog.locator('[data-testid="task-profile-select"]');
    // The open board's facts first.
    await expect(baseBranch).toContainText('main');
    await expect(dialog.locator('[data-testid="worktree-option-project"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="task-profile-edit"]')).toBeEnabled();

    await selectCombobox(page, 'workflow-task-project', OTHER_PROJECT_ID);
    await expect(dialog.locator('input[data-testid="workflow-task-project"]')).toHaveValue('kangentic-mobile');
    // Its default base branch, and its own branches in the picker.
    await expect(baseBranch).toContainText('trunk');
    await baseBranch.click();
    await expect(page.locator('[data-testid="branch-picker-dropdown"] button')).toHaveText(['trunk', 'release/phone']);
    await page.locator('[data-testid="branch-picker-dropdown"] button', { hasText: 'release/phone' }).click();
    await expect(baseBranch).toContainText('release/phone');
    // Its Worktrees switch is off, so there is no Worktree or Project choice.
    await expect(dialog.locator('[data-testid="worktree-option-project"]')).toHaveCount(0);
    // Its profiles, unlocked. The pencil stays off: the Board Manager edits only the open board's.
    await expect(profileSelect).toBeEnabled();
    await expect(profileSelect.locator('option')).toHaveText(['Default', 'Phone']);
    await expect(dialog.locator('[data-testid="task-profile-edit"]')).toBeDisabled();
    await expect(dialog.locator('[data-testid="task-profile-edit"]')).toHaveAccessibleName('Open that board to edit its profiles');
    // The agent a task there inherits is that project's default, not this one's.
    await dialog.locator('[data-testid="task-advanced-toggle"]').click();
    await expect(dialog.locator('input[data-testid="task-agent-override"]')).toHaveAttribute('placeholder', /codex/i);
    await dialog.locator('[data-testid="task-run-mode-profile"]').click();
    await profileSelect.selectOption('profile-phone');

    await dialog.getByPlaceholder('Task title').fill('Token contrast on the phone');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(() => plannedRow(page, 'Token contrast on the phone')).toMatchObject({
      project_id: OTHER_PROJECT_ID, base_branch: 'release/phone', use_worktree: null, run_mode: 'column_settings', profile_id: 'profile-phone',
    });
  } finally {
    await browser.close();
  }
});

test('a planned task on another board opens on that board, with the profile the agent set shown as itself', async () => {
  const { browser, page } = await launch();
  try {
    await card(page, 'task-3').dblclick();
    const dialog = byTestId(page, 'new-task-dialog');
    await expect(dialog).toContainText('Edit Task');
    await expect(dialog.locator('input[data-testid="workflow-task-project"]')).toHaveValue('kangentic-mobile');
    await expect(dialog.locator('[data-testid="branch-picker-chip"]')).toContainText('release/phone');
    const profileSelect = dialog.locator('[data-testid="task-profile-select"]');
    await expect(profileSelect).toBeEnabled();
    await expect(profileSelect).toHaveValue('profile-phone');
    await expect(profileSelect.locator('option:checked')).toHaveText('Phone');

    // Saved with only its title changed, it keeps its board and its profile.
    await dialog.getByPlaceholder('Task title').fill('Token picker for phones');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => plannedRow(page, 'Token picker for phones')).toMatchObject({
      project_id: OTHER_PROJECT_ID, base_branch: 'release/phone', run_mode: 'column_settings', profile_id: 'profile-phone',
    });
  } finally {
    await browser.close();
  }
});

test('a profile its board has since deleted shows as removed, and the select moves off it', async () => {
  const { browser, page } = await launch();
  try {
    await card(page, 'task-4').dblclick();
    const dialog = byTestId(page, 'new-task-dialog');
    const profileSelect = dialog.locator('[data-testid="task-profile-select"]');
    await expect(profileSelect).toBeEnabled();
    await expect(profileSelect).toHaveValue('profile-gone');
    await expect(profileSelect.locator('option:checked')).toHaveText('Removed profile');
    await expect(profileSelect.locator('option')).toHaveText(['Default', 'Heavy', 'Removed profile']);

    await profileSelect.selectOption('');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => plannedRow(page, 'Token audit')).toMatchObject({ profile_id: null, run_mode: 'column_settings' });
  } finally {
    await browser.close();
  }
});
