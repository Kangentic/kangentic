import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, createTask, waitForViteReady } from './helpers';
import type { Browser, Page } from '@playwright/test';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_NAME = `TaskOverrides Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openNewTaskDialog() {
  const column = page.locator('[data-swimlane-name="To Do"]');
  await column.locator('text=Add task').click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

async function closeDialog() {
  await page.keyboard.press('Escape');
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
}

test.describe('NewTaskDialog Advanced section', () => {
  test('Advanced toggle is visible and starts collapsed', async () => {
    await openNewTaskDialog();

    const toggle = page.locator('[data-testid="task-advanced-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Section body is hidden until expanded
    await expect(page.locator('[data-testid="task-advanced-section"]')).not.toBeVisible();

    await closeDialog();
  });

  test('expanding Advanced reveals model combobox and effort select with column-default placeholder', async () => {
    await openNewTaskDialog();

    await page.locator('[data-testid="task-advanced-toggle"]').click();

    // Model: free-text combobox seeded by `useKnownModels` (capabilities.models
    // union discoveredModelsByAgent cache). Empty value shows "Use column
    // default" placeholder; focusing the input reveals the suggestion list.
    const modelInput = page.locator('input[data-testid="task-model-override"]');
    await expect(modelInput).toBeVisible();
    await expect(modelInput).toHaveAttribute('placeholder', 'Use column default');
    await modelInput.click();
    const modelOptions = page.locator('[data-model-option]');
    await expect(modelOptions.first()).toBeVisible();
    const modelOptionTexts = await modelOptions.allTextContents();
    expect(modelOptionTexts).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));

    // Close the suggestion dropdown before checking the effort select so its
    // outside-click handler doesn't intercept our next click.
    await page.keyboard.press('Escape');

    // Effort: still a real <select> (efforts are enumeration-only).
    const effortSelect = page.locator('select[data-testid="task-effort-override"]');
    await expect(effortSelect).toBeVisible();
    await expect(effortSelect.locator('option').first()).toHaveText('Use column default');
    const effortOptions = await effortSelect.locator('option').allTextContents();
    expect(effortOptions).toEqual(expect.arrayContaining(['low', 'medium', 'high', 'xhigh', 'max']));

    await closeDialog();
  });

  test('selected overrides persist on the created task row', async () => {
    await openNewTaskDialog();

    await page.locator('input[placeholder="Task title"]').fill('Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();

    // Pick a model via the combobox suggestion list
    await page.locator('input[data-testid="task-model-override"]').click();
    await page.locator('[data-model-option]:has-text("opus")').click();

    // Effort is still a plain select
    await page.locator('select[data-testid="task-effort-override"]').selectOption('high');

    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await page.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Override Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('opus');
    expect(task!.effort_override).toBe('high');
  });

  test('leaving overrides on column default omits them from the row', async () => {
    await openNewTaskDialog();

    await page.locator('input[placeholder="Task title"]').fill('Default Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();
    // Don't change either select - keep "Use column default"

    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await page.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Default Override Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBeNull();
    expect(task!.effort_override).toBeNull();
  });
});

test.describe('TaskDetailEditForm Advanced section (edit-mode overrides)', () => {
  test('Advanced section is available in edit mode when the task has no live session', async () => {
    await createTask(page, 'Edit Advanced Task');

    const card = page.locator('text=Edit Advanced Task').first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // To Do tasks open in edit mode by default. The Advanced section sits
    // inside the edit form so the user can change model/effort before
    // moving the task to a spawning column.
    const toggle = page.locator('[data-testid="task-advanced-toggle"]');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('[data-testid="task-advanced-section"]')).toBeVisible();
    await expect(page.locator('input[data-testid="task-model-override"]')).toBeVisible();

    // Close without saving
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
  });

  test('Advanced section pre-fills from the task and persists changes on save', async () => {
    // Seed via the UI flow (create dialog) so the renderer store hydrates
    // the new row. Set model + effort overrides at create time, then
    // re-open the task and verify the edit-mode Advanced section reflects
    // the saved values.
    const column = page.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').fill('Seeded Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();
    await page.locator('input[data-testid="task-model-override"]').click();
    await page.locator('[data-model-option]:has-text("opus")').click();
    await page.locator('select[data-testid="task-effort-override"]').selectOption('high');
    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Re-open the freshly created task
    const card = page.locator('text=Seeded Override Task').first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // Section opens automatically because the task already has overrides set
    await expect(page.locator('[data-testid="task-advanced-section"]')).toBeVisible();
    await expect(page.locator('input[data-testid="task-model-override"]')).toHaveValue('opus');
    await expect(page.locator('select[data-testid="task-effort-override"]')).toHaveValue('high');

    // Change model to sonnet and effort to medium
    const modelInput = page.locator('input[data-testid="task-model-override"]');
    await modelInput.click();
    await modelInput.fill('');
    await page.locator('[data-model-option]:has-text("sonnet")').click();
    await page.locator('select[data-testid="task-effort-override"]').selectOption('medium');

    await page.locator('button:has-text("Save")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });

    const updated = await page.evaluate(async () => {
      const list = await window.electronAPI.tasks.list();
      return list.find((task: { title: string }) => task.title === 'Seeded Override Task');
    });
    expect(updated!.model_override).toBe('sonnet');
    expect(updated!.effort_override).toBe('medium');
  });

  test('clearing an override in edit mode persists the cleared value', async () => {
    // Seed via the UI flow with a model override set.
    const column = page.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').fill('Clear Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();
    await page.locator('input[data-testid="task-model-override"]').click();
    await page.locator('[data-model-option]:has-text("haiku")').click();
    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Re-open and clear via the combobox's X button (rendered when value is non-empty)
    const card = page.locator('text=Clear Override Task').first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });
    await expect(page.locator('input[data-testid="task-model-override"]')).toHaveValue('haiku');

    await page.locator('button[title="Clear"]').click();
    await expect(page.locator('input[data-testid="task-model-override"]')).toHaveValue('');

    await page.locator('button:has-text("Save")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });

    const updated = await page.evaluate(async () => {
      const list = await window.electronAPI.tasks.list();
      return list.find((task: { title: string }) => task.title === 'Clear Override Task');
    });
    expect(updated!.model_override).toBeNull();
  });
});

/**
 * Agent picker tests use their own browser instance with a multi-agent mock
 * fixture. The default fixture only has Claude `found: true`, so the picker
 * is hidden (nothing to choose between). Enabling Codex here gives us two
 * `found` agents, which surfaces the picker.
 */
test.describe('NewTaskDialog Advanced - Agent picker (multi-agent fixture)', () => {
  let multiBrowser: Browser;
  let multiPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    multiBrowser = await chromium.launch({ headless: true });
    const context = await multiBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    multiPage = await context.newPage();

    // Inject the override BEFORE the mock script so the mock picks it up
    // when defining `agents.list()`.
    await multiPage.addInitScript(() => {
      (window as Record<string, unknown>).__mockAgentListOverrides = {
        codex: {
          found: true,
          path: '/usr/bin/codex',
          version: '1.0.0',
          capabilities: {
            supportsModelOverride: true,
            models: ['gpt-5', 'gpt-5-mini'],
          },
        },
      };
    });
    await multiPage.addInitScript({ path: MOCK_SCRIPT });
    await multiPage.goto(VITE_URL);
    await multiPage.waitForLoadState('load');
    await multiPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(multiPage, `MultiAgent ${Date.now()}`);
  });

  test.afterAll(async () => {
    await multiBrowser?.close();
  });

  async function openDialog() {
    const column = multiPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await multiPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await multiPage.locator('[data-testid="task-advanced-toggle"]').click();
  }

  async function closeDialog() {
    await multiPage.keyboard.press('Escape');
    await multiPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  }

  test('Agent dropdown lists every found agent with a "Use column default" option', async () => {
    await openDialog();

    const agentSelect = multiPage.locator('select[data-testid="task-agent-override"]');
    await expect(agentSelect).toBeVisible();

    const optionTexts = await agentSelect.locator('option').allTextContents();
    expect(optionTexts[0]).toBe('Use column default');
    expect(optionTexts).toEqual(expect.arrayContaining(['Claude Code', 'Codex CLI']));

    await closeDialog();
  });

  test('picking a different agent re-filters the model list and resets the model + effort state', async () => {
    await openDialog();

    // Pick a Claude model first
    await multiPage.locator('input[data-testid="task-model-override"]').click();
    await multiPage.locator('[data-model-option]:has-text("opus")').click();

    // Switch agent to Codex
    await multiPage.locator('select[data-testid="task-agent-override"]').selectOption('codex');

    // Model state was reset (Codex doesn't have 'opus')
    const modelInput = multiPage.locator('input[data-testid="task-model-override"]');
    await expect(modelInput).toHaveValue('');

    // The combobox now shows Codex's models
    await modelInput.click();
    const codexOptionTexts = await multiPage.locator('[data-model-option]').allTextContents();
    expect(codexOptionTexts).toEqual(expect.arrayContaining(['gpt-5', 'gpt-5-mini']));
    expect(codexOptionTexts).not.toContain('opus');

    // Escape closes the suggestion popover and (the form is dirty) opens the
    // discard confirm; Discard then closes the dialog.
    await multiPage.keyboard.press('Escape');
    await multiPage.locator('button:has-text("Discard")').click();
    await multiPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('selected agent persists on the created task row as agent_override', async () => {
    await openDialog();

    await multiPage.locator('input[placeholder="Task title"]').fill('Agent Override Task');
    await multiPage.locator('select[data-testid="task-agent-override"]').selectOption('codex');
    await multiPage.locator('input[data-testid="task-model-override"]').click();
    await multiPage.locator('[data-model-option]:has-text("gpt-5-mini")').click();

    await multiPage.locator('button[type="submit"]:has-text("Create")').click();
    await multiPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await multiPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Agent Override Task');
    expect(task).toBeDefined();
    expect(task!.agent_override).toBe('codex');
    expect(task!.model_override).toBe('gpt-5-mini');
  });

  test('leaving agent on column default omits agent_override from the row', async () => {
    await openDialog();

    await multiPage.locator('input[placeholder="Task title"]').fill('No Agent Override Task');
    // Don't touch the agent dropdown

    await multiPage.locator('button[type="submit"]:has-text("Create")').click();
    await multiPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await multiPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'No Agent Override Task');
    expect(task).toBeDefined();
    expect(task!.agent_override).toBeNull();
  });
});

/**
 * Grouped model dropdown tests use their own browser instance with a fixture
 * whose model list contains the duplicate spellings real Claude transcripts
 * produce: a bare alias, its [1m] context-window variant, and a dated pinned
 * build. The combobox must collapse them to one row per base model while
 * every selectable value stays the exact discovered string (the spawn value).
 */
test.describe('NewTaskDialog Advanced - grouped model dropdown (suffixed fixture)', () => {
  let groupedBrowser: Browser;
  let groupedPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    groupedBrowser = await chromium.launch({ headless: true });
    const context = await groupedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    groupedPage = await context.newPage();

    await groupedPage.addInitScript(() => {
      (window as Record<string, unknown>).__mockAgentListOverrides = {
        claude: {
          capabilities: {
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsModelOverride: true,
            models: [
              'claude-haiku-4-5',
              'claude-haiku-4-5-20251001',
              'claude-opus-4-8',
              'claude-opus-4-8[1m]',
            ],
          },
        },
      };
    });
    await groupedPage.addInitScript({ path: MOCK_SCRIPT });
    await groupedPage.goto(VITE_URL);
    await groupedPage.waitForLoadState('load');
    await groupedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(groupedPage, `GroupedModels ${Date.now()}`);
  });

  test.afterAll(async () => {
    await groupedBrowser?.close();
  });

  async function openDialog() {
    const column = groupedPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await groupedPage.locator('[data-testid="task-advanced-toggle"]').click();
  }

  async function closeDialog() {
    await groupedPage.keyboard.press('Escape');
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  }

  test('collapses variants to one row per base model with a 1M chip and a collapsed pinned section', async () => {
    await openDialog();

    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    const optionTexts = await groupedPage.locator('[data-model-option]').allTextContents();
    // One primary row per base model; the [1m] variant and the dated pin do
    // not get their own visible rows.
    expect(optionTexts).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);

    // The opus row carries an always-visible 1M chip.
    await expect(groupedPage.locator('[data-model-1m]')).toHaveCount(1);

    // The dated build sits behind a collapsed "Pinned builds" toggle.
    const pinnedToggle = groupedPage.locator('[data-model-pinned-toggle]');
    await expect(pinnedToggle).toHaveText(/Pinned builds \(1\)/);
    await expect(groupedPage.locator('[data-model-pinned-option]')).toHaveCount(0);

    // Close the suggestion dropdown before dismissing the dialog.
    await groupedPage.keyboard.press('Escape');
    await closeDialog();
  });

  test('clicking the 1M chip persists the exact [1m] string', async () => {
    await openDialog();

    await groupedPage.locator('input[placeholder="Task title"]').fill('One Million Task');
    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    await groupedPage.locator('[data-model-1m]').click();
    await expect(groupedPage.locator('input[data-testid="task-model-override"]')).toHaveValue('claude-opus-4-8[1m]');

    await groupedPage.locator('button[type="submit"]:has-text("Create")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await groupedPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'One Million Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('claude-opus-4-8[1m]');
  });

  test('expanding pinned builds and selecting one persists the exact dated string', async () => {
    await openDialog();

    await groupedPage.locator('input[placeholder="Task title"]').fill('Pinned Build Task');
    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    await groupedPage.locator('[data-model-pinned-toggle]').click();
    await groupedPage.locator('[data-model-pinned-option]:has-text("claude-haiku-4-5-20251001")').click();
    await expect(groupedPage.locator('input[data-testid="task-model-override"]')).toHaveValue('claude-haiku-4-5-20251001');

    await groupedPage.locator('button[type="submit"]:has-text("Create")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await groupedPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Pinned Build Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('claude-haiku-4-5-20251001');
  });

  test('a query that only matches a pinned build auto-expands the pinned section', async () => {
    await openDialog();

    const modelInput = groupedPage.locator('input[data-testid="task-model-override"]');
    await modelInput.click();
    await modelInput.fill('20251001');

    // No primary row matches, so the pinned section opens by itself and the
    // dated build is selectable without touching the toggle.
    await expect(groupedPage.locator('[data-model-pinned-option]')).toHaveText(['claude-haiku-4-5-20251001']);
    await groupedPage.locator('[data-model-pinned-option]').click();
    await expect(modelInput).toHaveValue('claude-haiku-4-5-20251001');

    // Escape closes the suggestion popover and (the form is dirty) opens the
    // discard confirm; Discard then closes the dialog.
    await groupedPage.keyboard.press('Escape');
    await groupedPage.locator('button:has-text("Discard")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });
});
