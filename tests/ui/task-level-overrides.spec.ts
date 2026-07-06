import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, createTask, waitForViteReady } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

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
 * produce: a bare alias, its [1m] context-window variant, a dated pinned
 * build, AND a superseded generation (`claude-opus-4-7`, older than the
 * `claude-opus-4-8` also present). The combobox must collapse the base-model
 * duplicates to one row, demote the superseded generation alongside the
 * dated pin into "Older versions", and label every row from the
 * adapter-provided `modelDisplayNames` map (falling back to the raw id)
 * while every selectable value stays the exact discovered string (the spawn
 * value).
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
              'claude-opus-4-7',
              'claude-opus-4-8',
              'claude-opus-4-8[1m]',
            ],
            // Mirrors what the Claude adapter's discoverCapabilities()
            // populates via humanizeClaudeModelId(): the headless mock does
            // not run real main-process discovery, so this must be supplied
            // explicitly or every row falls back to its raw id.
            modelDisplayNames: {
              'claude-haiku-4-5': 'Haiku 4.5',
              'claude-haiku-4-5-20251001': 'Haiku 4.5',
              'claude-opus-4-7': 'Opus 4.7',
              'claude-opus-4-8': 'Opus 4.8',
              'claude-opus-4-8[1m]': 'Opus 4.8 (1M)',
            },
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

  test('collapses variants to one humanized row per current-generation model, demoting the superseded generation and the dated pin', async () => {
    await openDialog();

    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    const optionTexts = await groupedPage.locator('[data-model-option]').allTextContents();
    // One primary row per current-generation base model, humanized. The [1m]
    // variant never gets its own row; the older Opus 4.7 generation and the
    // dated Haiku pin are demoted, so they are not present while collapsed.
    expect(optionTexts).toEqual(['Haiku 4.5', 'Opus 4.8']);

    // The opus row carries an always-visible 1M chip.
    await expect(groupedPage.locator('[data-model-1m]')).toHaveCount(1);

    // Opus 4.7 (superseded) and the dated Haiku pin sit behind a collapsed
    // "Older versions" toggle.
    const olderToggle = groupedPage.locator('[data-model-pinned-toggle]');
    await expect(olderToggle).toHaveText(/Older versions \(2\)/);
    await expect(groupedPage.locator('[data-model-pinned-option]')).toHaveCount(0);
    await expect(groupedPage.locator('[title="claude-opus-4-7"]')).toHaveCount(0);

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

  test('expanding Older versions and selecting the dated pin persists the exact dated string, humanized with its date', async () => {
    await openDialog();

    await groupedPage.locator('input[placeholder="Task title"]').fill('Pinned Build Task');
    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    await groupedPage.locator('[data-model-pinned-toggle]').click();
    // The dated pin's row is humanized but keeps its date appended (the
    // humanizer drops the date, so it is re-appended generically); the raw
    // id is still selectable via its title attribute.
    const pinnedRow = groupedPage.locator('[data-model-pinned-option][title="claude-haiku-4-5-20251001"]');
    await expect(pinnedRow).toHaveText('Haiku 4.5 · 2025-10-01');
    await pinnedRow.click();
    await expect(groupedPage.locator('input[data-testid="task-model-override"]')).toHaveValue('claude-haiku-4-5-20251001');

    await groupedPage.locator('button[type="submit"]:has-text("Create")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await groupedPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Pinned Build Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('claude-haiku-4-5-20251001');
  });

  test('expanding Older versions and selecting the superseded generation persists its exact id', async () => {
    await openDialog();

    await groupedPage.locator('input[placeholder="Task title"]').fill('Older Generation Task');
    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    await groupedPage.locator('[data-model-pinned-toggle]').click();
    const olderOpusRow = groupedPage.locator('[data-model-option][title="claude-opus-4-7"]');
    await expect(olderOpusRow).toHaveText('Opus 4.7');
    await olderOpusRow.click();
    await expect(groupedPage.locator('input[data-testid="task-model-override"]')).toHaveValue('claude-opus-4-7');

    await groupedPage.locator('button[type="submit"]:has-text("Create")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await groupedPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Older Generation Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('claude-opus-4-7');
  });

  test('a query that only matches a demoted row auto-expands the Older versions section', async () => {
    await openDialog();

    const modelInput = groupedPage.locator('input[data-testid="task-model-override"]');
    await modelInput.click();
    await modelInput.fill('20251001');

    // No primary row matches, so the section opens by itself and the dated
    // build is selectable without touching the toggle.
    await expect(groupedPage.locator('[data-model-pinned-option]')).toHaveText(['Haiku 4.5 · 2025-10-01']);
    await groupedPage.locator('[data-model-pinned-option]').click();
    await expect(modelInput).toHaveValue('claude-haiku-4-5-20251001');

    // Escape closes the suggestion popover and (the form is dirty) opens the
    // discard confirm; Discard then closes the dialog.
    await groupedPage.keyboard.press('Escape');
    await groupedPage.locator('button:has-text("Discard")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('opening the dropdown on a task already set to a superseded generation auto-expands Older versions', async () => {
    await openDialog();

    const titleInput = groupedPage.locator('input[placeholder="Task title"]');
    const modelInput = groupedPage.locator('input[data-testid="task-model-override"]');
    // Simulate an existing selection of the superseded generation (as if the
    // task was created before Opus 4.8 shipped). Close the suggestion popover
    // by clicking elsewhere in the dialog (not Escape, to avoid any ambiguity
    // with the dialog's own Escape-to-discard handling), leaving the value set.
    await modelInput.fill('claude-opus-4-7');
    await titleInput.click();
    await expect(modelInput).toHaveValue('claude-opus-4-7');

    // Reopen the dropdown: the section is expanded WITHOUT the user touching
    // the toggle, and the toggle stays visible (still collapsible) since this
    // is value-driven, not the query-driven force-open.
    await modelInput.click();
    await expect(groupedPage.locator('[data-model-pinned-toggle]')).toBeVisible();
    await expect(groupedPage.locator('[data-model-option][title="claude-opus-4-7"]')).toBeVisible();

    // Close the dropdown via an outside click, then discard the dirty form.
    await titleInput.click();
    await groupedPage.keyboard.press('Escape');
    await groupedPage.locator('button:has-text("Discard")').click();
    await titleInput.waitFor({ state: 'hidden', timeout: 2000 });
  });
});

/**
 * Opening the Model dropdown fires a forced, on-demand agent-list rescan
 * (config-store's `rescanModels()`) so a newly shipped model appears without a
 * Kangentic restart. `rescanModels()` is throttled by a MODULE-SCOPE in-flight
 * lock plus a 60s cooldown, so this block gets its OWN browser instance: every
 * other test in this file also opens `task-model-override`, and reusing a
 * shared page would mean an earlier test silently "spends" the cooldown before
 * these assertions ever run (cross-test state leakage the cooldown itself
 * would then hide, not just slow down).
 */
test.describe('NewTaskDialog Advanced - Model dropdown open triggers a rescan', () => {
  let rescanBrowser: Browser;
  let rescanPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    rescanBrowser = await chromium.launch({ headless: true });
    const context = await rescanBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    rescanPage = await context.newPage();
    await rescanPage.addInitScript({ path: MOCK_SCRIPT });
    await rescanPage.goto(VITE_URL);
    await rescanPage.waitForLoadState('load');
    await rescanPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(rescanPage, `ModelRescan ${Date.now()}`);
  });

  test.afterAll(async () => {
    await rescanBrowser?.close();
  });

  async function openDialog() {
    const column = rescanPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await rescanPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await rescanPage.locator('[data-testid="task-advanced-toggle"]').click();
  }

  /**
   * Wrap window.electronAPI.agents.list to record every call's forceRefresh
   * argument. Always wraps the PRISTINE mock implementation (cached in
   * window.__originalAgentsListFn on first use), so re-instrumenting never
   * compounds an earlier call's artificial delay.
   *
   * `delayMs`, when set, holds the mock's resolution back so a test can prove
   * the dropdown paints BEFORE the rescan settles (rescanModels() is
   * fire-and-forget and must never gate the render).
   */
  async function instrumentAgentListCalls(page: Page, delayMs = 0): Promise<void> {
    await page.evaluate(({ delayMs }) => {
      const api = window.electronAPI as unknown as {
        agents: { list: (forceRefresh?: boolean) => Promise<unknown> };
      };
      const globalWindow = window as unknown as {
        __originalAgentsListFn?: (forceRefresh?: boolean) => Promise<unknown>;
      };
      if (!globalWindow.__originalAgentsListFn) {
        globalWindow.__originalAgentsListFn = api.agents.list.bind(api.agents);
      }
      const original = globalWindow.__originalAgentsListFn;
      (window as Record<string, unknown>).__rescanAgentListCalls = {
        callCount: 0,
        forcedCallCount: 0,
      };
      api.agents.list = async function instrumentedList(forceRefresh?: boolean) {
        const state = (window as Record<string, unknown>).__rescanAgentListCalls as {
          callCount: number;
          forcedCallCount: number;
        };
        state.callCount += 1;
        if (forceRefresh === true) state.forcedCallCount += 1;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return original(forceRefresh);
      };
    }, { delayMs });
  }

  async function readAgentListCalls(page: Page): Promise<{ callCount: number; forcedCallCount: number }> {
    return page.evaluate(() => {
      const calls = (window as Record<string, unknown>).__rescanAgentListCalls as
        | { callCount: number; forcedCallCount: number }
        | undefined;
      return calls ?? { callCount: 0, forcedCallCount: 0 };
    });
  }

  test('focusing the model input fires a forced rescan without blocking the dropdown, and a reopen within the cooldown does not fire a second one', async () => {
    await openDialog();

    // Delay the mock's resolution well past any legitimate render time, so the
    // visibility assertion below can only pass if the dropdown renders
    // BEFORE the rescan settles.
    await instrumentAgentListCalls(rescanPage, 1000);

    const modelInput = rescanPage.locator('input[data-testid="task-model-override"]');
    await modelInput.click();

    const modelOptions = rescanPage.locator('[data-model-option]');
    await expect(modelOptions.first()).toBeVisible({ timeout: 500 });

    // The forced rescan call did fire; it just hasn't resolved yet.
    await expect
      .poll(async () => (await readAgentListCalls(rescanPage)).forcedCallCount, {
        timeout: 3000,
        intervals: [100, 100, 200, 300, 500],
      })
      .toBe(1);

    // Close and reopen the dropdown via its own chevron toggle (not Escape):
    // the form has no other field set (isDirty stays false), so Escape would
    // route through NewTaskDialog's close guard and animate-close the WHOLE
    // dialog, not just the suggestion popover. The chevron toggle is a plain
    // mouse click scoped to ModelCombobox's own open/close state, so it
    // exercises the cooldown in isolation from that unrelated close path.
    const chevronToggle = rescanPage.locator('button[title="Close dropdown"]');
    await chevronToggle.click();
    await expect(modelOptions.first()).not.toBeVisible();

    const reopenToggle = rescanPage.locator('button[title="Open dropdown"]');
    await reopenToggle.click();
    await expect(modelOptions.first()).toBeVisible();

    // Intentional fixed wait: this asserts a NON-occurrence (no second forced
    // call within the 60s cooldown window), which cannot be expressed as a
    // poll condition.
    await rescanPage.waitForTimeout(500);
    const calls = await readAgentListCalls(rescanPage);
    expect(calls.forcedCallCount).toBe(1);
  });
});

/**
 * The model-dropdown context-window badge is learned entirely from live
 * telemetry (`rememberModelContextWindow`, fed by a real session's
 * status.json) - never hardcoded per model. These specs seed
 * `config.discoveredContextWindowsByAgent` directly via
 * `window.__mockConfigOverrides`, which `mock-electron-api.js` merges into
 * its config object at init (mirroring how the real store persists a
 * learned window), so nothing here asserts a hardcoded context-size
 * assumption - the seeded value IS the expectation. Own browser instance:
 * the override must be injected before the mock script runs, so it cannot
 * be layered onto the shared `page` without restarting the app.
 */
test.describe('NewTaskDialog Advanced - context-window badge (telemetry-learned)', () => {
  let contextWindowBrowser: Browser;
  let contextWindowPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    contextWindowBrowser = await chromium.launch({ headless: true });
    const context = await contextWindowBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    contextWindowPage = await context.newPage();

    await contextWindowPage.addInitScript(() => {
      (window as Record<string, unknown>).__mockConfigOverrides = {
        discoveredContextWindowsByAgent: {
          claude: {
            opus: 1_000_000,
            sonnet: 200_000,
            // haiku intentionally has no observed window: expect no badge.
          },
        },
      };
    });
    await contextWindowPage.addInitScript({ path: MOCK_SCRIPT });
    await contextWindowPage.goto(VITE_URL);
    await contextWindowPage.waitForLoadState('load');
    await contextWindowPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(contextWindowPage, `ContextWindowBadge ${Date.now()}`);
  });

  test.afterAll(async () => {
    await contextWindowBrowser?.close();
  });

  test('badges rows with a learned context window and omits rows with none observed', async () => {
    const column = contextWindowPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await contextWindowPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await contextWindowPage.locator('[data-testid="task-advanced-toggle"]').click();
    await contextWindowPage.locator('input[data-testid="task-model-override"]').click();

    const opusRow = contextWindowPage.locator('[data-model-row]').filter({ hasText: 'opus' });
    await expect(opusRow.locator('[data-model-context-window]')).toHaveText('1M');

    const sonnetRow = contextWindowPage.locator('[data-model-row]').filter({ hasText: 'sonnet' });
    await expect(sonnetRow.locator('[data-model-context-window]')).toHaveText('200K');

    const haikuRow = contextWindowPage.locator('[data-model-row]').filter({ hasText: 'haiku' });
    await expect(haikuRow.locator('[data-model-context-window]')).toHaveCount(0);

    // Close the suggestion dropdown, then the dialog (nothing was edited, so
    // this closes directly without the discard-confirm path).
    await contextWindowPage.keyboard.press('Escape');
    await contextWindowPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });
});

/**
 * Companion to the block above: proves the suppression half of the badge
 * rule. A row that already carries a selectable `[1m]` chip must NOT also
 * show the context-window badge (no redundant double "1M"), while a
 * sibling row with a learned window but no `[1m]` chip still badges
 * normally. Own browser + own `__mockAgentListOverrides` fixture (the
 * suffixed-id shape from the grouped-model-dropdown block above), seeded
 * with a learned window for both rows.
 */
test.describe('NewTaskDialog Advanced - context-window badge suppressed by a 1M chip', () => {
  let suppressedBrowser: Browser;
  let suppressedPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    suppressedBrowser = await chromium.launch({ headless: true });
    const context = await suppressedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    suppressedPage = await context.newPage();

    await suppressedPage.addInitScript(() => {
      (window as Record<string, unknown>).__mockAgentListOverrides = {
        claude: {
          capabilities: {
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsModelOverride: true,
            models: [
              'claude-haiku-4-5',
              'claude-opus-4-8',
              'claude-opus-4-8[1m]',
            ],
          },
        },
      };
      (window as Record<string, unknown>).__mockConfigOverrides = {
        discoveredContextWindowsByAgent: {
          claude: {
            'claude-opus-4-8': 1_000_000,
            'claude-haiku-4-5': 200_000,
          },
        },
      };
    });
    await suppressedPage.addInitScript({ path: MOCK_SCRIPT });
    await suppressedPage.goto(VITE_URL);
    await suppressedPage.waitForLoadState('load');
    await suppressedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(suppressedPage, `ContextWindowSuppressed ${Date.now()}`);
  });

  test.afterAll(async () => {
    await suppressedBrowser?.close();
  });

  test('omits the badge on a row with a selectable 1M chip, but shows it on a row without one', async () => {
    const column = suppressedPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await suppressedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await suppressedPage.locator('[data-testid="task-advanced-toggle"]').click();
    await suppressedPage.locator('input[data-testid="task-model-override"]').click();

    const opusRow = suppressedPage.locator('[data-model-row]').filter({ hasText: 'claude-opus-4-8' });
    await expect(opusRow.locator('[data-model-1m]')).toHaveCount(1);
    await expect(opusRow.locator('[data-model-context-window]')).toHaveCount(0);

    const haikuRow = suppressedPage.locator('[data-model-row]').filter({ hasText: 'claude-haiku-4-5' });
    await expect(haikuRow.locator('[data-model-context-window]')).toHaveText('200K');

    await suppressedPage.keyboard.press('Escape');
    await suppressedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });
});
