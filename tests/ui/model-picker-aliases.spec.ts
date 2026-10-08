/**
 * UI tests for floating model aliases (`AgentCapabilities.modelAliases`) in the
 * model pickers.
 *
 * With aliases reported, every picker leads with a "Latest" group (one row per
 * alias, the version it runs today as a muted second column, no 1M chip), keeps
 * any current version no alias covers at the top level, and folds every other
 * specific version into one collapsed "Specific versions" section. A stored
 * alias reads as its bare family name. With no aliases the lists are exactly
 * what they were, which the default mock (no `modelAliases`) keeps covering in
 * task-level-overrides.spec.ts and context-bar-popover.spec.ts.
 *
 * The fixture mirrors what the Claude adapter reports: the probe's aliases
 * (opus, fable, sonnet; no haiku alias, so Haiku 4.5 stays on top), display
 * names over both the ids and the alias ids, and a bare `sonnet` in the model
 * list the way a spawn seeded with `--model sonnet` can learn it, plus its
 * `sonnet[1m]` form, which is a real value and stays selectable.
 *
 * Typed text in the model combobox is rewritten from the agent's own display
 * names (`modelDisplayNames`), never from a Claude-shaped id synthesis, so the
 * fixtures name every model id AND every alias id the way the adapter does, and
 * one case uses a non-Claude agent whose names are not Claude-shaped.
 *
 * Coverage in this file:
 *   - the New Task model combobox (list shape, alias pick, typed-text commit on
 *     every close path, the forget-on-pick and forget-on-clear cases);
 *   - the context bar popover (checkmarks, footer, live alias id, Command Terminal);
 *   - the Column Manager All columns table (picked, saved, other-agent lanes,
 *     discovered-only newer version);
 *   - the Settings > Agent default-model combobox.
 * Each test that is not in a shared-page describe launches its own page, so no
 * state crosses tests.
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, waitForBoard, waitForViteReady, gotoVite } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Most cases launch their own browser, so a busy parallel shard can spend most
// of the default 15s on the launch alone (seen under --repeat-each=3).
test.describe.configure({ mode: 'parallel', timeout: 30_000 });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const CLAUDE_WITH_ALIASES = {
  claude: {
    capabilities: {
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsModelOverride: true,
      models: [
        'claude-fable-5',
        'claude-fable-5-1',
        'claude-haiku-4-5',
        'claude-opus-4-8',
        'claude-opus-5-5',
        'claude-opus-5-5[1m]',
        'claude-sonnet-5',
        'claude-sonnet-5-5',
        'sonnet',
        'sonnet[1m]',
      ],
      modelDisplayNames: {
        'claude-fable-5': 'Fable 5',
        'claude-fable-5-1': 'Fable 5.1',
        'claude-haiku-4-5': 'Haiku 4.5',
        'claude-opus-4-8': 'Opus 4.8',
        'claude-opus-5-5': 'Opus 5.5',
        'claude-opus-5-5[1m]': 'Opus 5.5 (1M)',
        'claude-sonnet-5': 'Sonnet 5',
        'claude-sonnet-5-5': 'Sonnet 5.5',
        opus: 'Opus',
        fable: 'Fable',
        sonnet: 'Sonnet',
        'sonnet[1m]': 'Sonnet (1M)',
      },
      modelAliases: [
        { id: 'opus', resolvesTo: 'claude-opus-5-5' },
        { id: 'fable', resolvesTo: 'claude-fable-5-1' },
        { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
      ],
    },
  },
};

/**
 * The same aliases with an empty model list: an agent that names floating
 * selectors but reports no specific version, so the alias rows are all it has.
 */
const CLAUDE_ALIASES_WITHOUT_MODELS = {
  claude: {
    capabilities: {
      ...CLAUDE_WITH_ALIASES.claude.capabilities,
      models: [] as string[],
    },
  },
};

/**
 * The same fixture without the learned bare `sonnet`, so an alias id is offered
 * ONLY as an alias (no model row carries the same value).
 */
const CLAUDE_WITH_ALIASES_ONLY = {
  claude: {
    capabilities: {
      ...CLAUDE_WITH_ALIASES.claude.capabilities,
      models: CLAUDE_WITH_ALIASES.claude.capabilities.models.filter((modelId) => modelId !== 'sonnet'),
    },
  },
};

/** Open the New Task dialog on the board and expand its Advanced section. */
async function openNewTaskAdvanced(target: Page): Promise<void> {
  await target.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
  await target.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
  await target.locator('[data-testid="task-advanced-toggle"]').click();
}

/** Replace the mock's agent-list overrides and reload the config store's agent list. */
async function setAgentListOverrides(target: Page, overrides: Record<string, unknown>): Promise<void> {
  await target.evaluate(async (nextOverrides) => {
    const testWindow = window as unknown as {
      __mockAgentListOverrides?: Record<string, unknown>;
      __zustandStores?: { config: { getState: () => { loadAgentList: () => Promise<void> } } };
    };
    testWindow.__mockAgentListOverrides = nextOverrides;
    await testWindow.__zustandStores?.config.getState().loadAgentList();
  }, overrides);
}

/** Launch a page with a project and the alias fixture loaded, run the body, always close the browser. */
async function withAliasPage(body: (page: Page) => Promise<void>): Promise<void> {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `AliasCoverage ${Date.now()}`);
    await waitForBoard(page);
    await setAgentListOverrides(page, CLAUDE_WITH_ALIASES);
    await body(page);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// The model combobox (New Task, Advanced)
// ---------------------------------------------------------------------------

test.describe('Model combobox with floating aliases', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchPage();
    browser = result.browser;
    page = result.page;
    await createProject(page, `ModelAliases ${Date.now()}`);
    await waitForBoard(page);
    await setAgentListOverrides(page, CLAUDE_WITH_ALIASES);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  const modelInput = () => page.locator('input[data-testid="task-model-override"]');
  const menu = () => page.locator('[data-testid="task-model-override-menu"]');

  async function openAdvanced(): Promise<void> {
    await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await page.locator('[data-testid="task-advanced-toggle"]').click();
  }

  /** Close the (dirty) dialog: an open menu takes the first Escape, then the discard confirm. */
  async function discardDialog(): Promise<void> {
    const openChevron = page.locator('button[aria-label="Close dropdown"]').first();
    if (await openChevron.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await expect(openChevron).toBeHidden({ timeout: 2000 });
    }
    await page.keyboard.press('Escape');
    await page.locator('button:has-text("Discard")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  }

  test('leads with the Latest group, keeps an unaliased family on top, and folds every version into one collapsed section', async () => {
    await openAdvanced();
    await modelInput().click();

    // One row per alias, in the CLI's order, each naming the version it runs.
    const aliasIds = await menu()
      .locator('button[data-model-alias]')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-model-alias')));
    expect(aliasIds).toEqual(['opus', 'fable', 'sonnet']);
    await expect(menu().locator('[data-model-alias-target]')).toHaveText(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5']);
    // An alias names a family, not a context window: no 1M chip on its row.
    await expect(menu().locator('[data-model-alias-group] [data-model-1m]')).toHaveCount(0);

    // Haiku has no alias, so its current version stays at the top level; every
    // version an alias covers is folded away, with nothing listed twice.
    const topLevelRows = menu().locator('[data-model-option]:not([data-model-alias])');
    await expect(topLevelRows).toHaveText(['Haiku 4.5']);
    const toggle = menu().locator('[data-model-pinned-toggle]');
    await expect(toggle).toHaveText(/Specific versions \(7\)/);

    await toggle.click();
    await expect(menu().locator('[data-model-option][title="claude-opus-5-5"]')).toBeVisible();
    await expect(menu().locator('[data-model-option][title="claude-sonnet-5-5"]')).toBeVisible();
    // The version rows keep their 1M chip.
    await expect(menu().locator('[data-model-1m][title="claude-opus-5-5[1m]"]')).toHaveCount(1);
    // The learned bare `sonnet` folds into the Sonnet alias row, but its
    // `sonnet[1m]` form is a different value and is listed as a version.
    await expect(menu().locator('[data-model-option][title="sonnet"]')).toHaveCount(0);
    await expect(menu().locator('[data-model-option][title="sonnet[1m]"]')).toHaveText(/Sonnet \(1M\)/);

    await discardDialog();
  });

  test('picking an alias stores it, and the closed field reads the family name with its target in the title', async () => {
    await openAdvanced();
    await page.locator('input[placeholder="Task title"]').fill('Alias Task');

    await modelInput().click();
    await page.locator('button[data-model-alias="sonnet"]').click();
    await expect(modelInput()).toHaveValue('Sonnet');
    await expect(modelInput()).toHaveAttribute('title', 'Latest Sonnet, currently Sonnet 5.5');

    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });
    const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
    const created = tasks.find((task: { title: string }) => task.title === 'Alias Task');
    expect(created?.model_override).toBe('sonnet');
  });

  test('a typed friendly name is stored in the CLI\'s spelling once the menu closes', async () => {
    // Typed text commits per keystroke, and "Opus" now reads exactly like the
    // alias row, so a typed "Opus" must land as `opus`, never as `Opus`.
    await openAdvanced();
    await page.locator('input[placeholder="Task title"]').fill('Typed Alias Task');

    // Enter both closes the menu and submits the New Task form, in one keystroke.
    await modelInput().fill('Opus');
    await modelInput().press('Enter');
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });
    const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
    const created = tasks.find((task: { title: string }) => task.title === 'Typed Alias Task');
    expect(created?.model_override).toBe('opus');
  });

  test('typed text that resolves to an id the agent does not offer is stored as typed', async () => {
    // "Gemini 2.5" would become `claude-gemini-2-5`, which is not in this
    // agent's list and not an alias, so the rewrite must leave the text alone.
    await openAdvanced();
    await page.locator('input[placeholder="Task title"]').fill('Unoffered Model Task');

    await modelInput().fill('Gemini 2.5');
    await modelInput().press('Enter');
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });
    const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
    const created = tasks.find((task: { title: string }) => task.title === 'Unoffered Model Task');
    expect(created?.model_override).toBe('Gemini 2.5');
  });

  // Keyboard only, no click: a click anywhere fires the capture-phase mousedown
  // close path, which would commit through a different route than the field's
  // blur. Shift+Tab leaves the field directly from the input.
  test('a typed friendly name is committed when Shift+Tab moves focus out of the field', async () => {
    await openAdvanced();
    await page.locator('input[placeholder="Task title"]').fill('Blurred Alias Task');

    await modelInput().fill('Opus');
    // Typed text is stored as typed until something commits it: the input's
    // title names an alias only once the stored value is `opus`.
    await expect(modelInput()).not.toHaveAttribute('title');

    await page.keyboard.press('Shift+Tab');
    const focusLeftField = await modelInput().evaluate((input) => {
      const field = input.parentElement?.parentElement ?? input;
      const active = document.activeElement;
      return active !== null && !field.contains(active);
    });
    expect(focusLeftField).toBe(true);

    await expect(modelInput()).toHaveAttribute('title', 'Latest Opus, currently Opus 5.5');
    await discardDialog();
  });

  // Forward Tab leaves through the field's own Clear button and chevron, so the
  // commit has to fire when focus leaves the whole field, not the input.
  test('a typed friendly name is committed when forward Tab walks focus out of the field', async () => {
    await openAdvanced();
    await page.locator('input[placeholder="Task title"]').fill('Tabbed Alias Task');

    await modelInput().fill('Opus');
    await expect(modelInput()).not.toHaveAttribute('title');

    const focusIsInField = () =>
      modelInput().evaluate((input) => {
        const field = input.parentElement?.parentElement ?? input;
        return document.activeElement !== null && field.contains(document.activeElement);
      });
    // Input, Clear, chevron: at most three stops inside the field.
    for (let press = 0; press < 3 && (await focusIsInField()); press++) {
      await page.keyboard.press('Tab');
    }
    expect(await focusIsInField()).toBe(false);

    await expect(modelInput()).toHaveAttribute('title', 'Latest Opus, currently Opus 5.5');
    await discardDialog();
  });

  // A real click on another input also moves focus, and the field's own blur
  // commit would then fire, so the mousedown close path could be deleted with
  // this test still green. A synthetic mousedown has no default action: focus
  // never leaves the model input, which leaves the capture-phase outside-press
  // handler as the only thing that can commit the typing.
  test('a press outside the field commits typed "Opus" as the alias while focus stays in the field', async () => {
    await openAdvanced();
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Outside Press Task');

    await modelInput().fill('Opus');
    await expect(menu()).toBeVisible();
    await expect(modelInput()).not.toHaveAttribute('title');

    await titleInput.dispatchEvent('mousedown');
    await expect(menu()).toBeHidden({ timeout: 3000 });
    await expect(modelInput()).toHaveAttribute('title', 'Latest Opus, currently Opus 5.5');
    // Proves the blur route was not the one that committed.
    await expect(modelInput()).toBeFocused();

    await discardDialog();
  });

  test('a field holding an older version opens with the section expanded and names the newer version', async () => {
    await openAdvanced();

    await modelInput().click();
    await menu().locator('[data-model-pinned-toggle]').click();
    await menu().locator('[data-model-option][title="claude-sonnet-5"]').click();
    await expect(modelInput()).toHaveValue('Sonnet 5');
    // A pinned value carries no alias title.
    await expect(modelInput()).not.toHaveAttribute('title');

    await modelInput().click();
    await expect(menu().locator('[data-model-option][title="claude-sonnet-5"]')).toBeVisible();
    await expect(menu().locator('[data-model-newer]')).toHaveText('Sonnet 5.5 available');

    await discardDialog();
  });

  test('a query that matches only a specific version opens the section on its own', async () => {
    await openAdvanced();

    await modelInput().fill('4.8');
    await expect(menu().locator('[data-model-option][title="claude-opus-4-8"]')).toBeVisible();
    await expect(menu().locator('[data-model-pinned-toggle]')).toHaveCount(0);
    await expect(menu().locator('button[data-model-alias]')).toHaveCount(0);

    await discardDialog();
  });
});

// ---------------------------------------------------------------------------
// The model combobox: the other close paths and the forget-on-pick / clear cases
// ---------------------------------------------------------------------------

test.describe('Model combobox typed-text commit close paths (New Task, Advanced)', () => {
  const OPUS_TITLE = 'Latest Opus, currently Opus 5.5';

  const modelInput = (page: Page) => page.locator('input[data-testid="task-model-override"]');
  const menu = (page: Page) => page.locator('[data-testid="task-model-override-menu"]');

  /** The field's own controls (Clear, chevron) live beside the input, inside its container. */
  const fieldControl = (page: Page, selector: string) =>
    modelInput(page).locator('xpath=..').locator(selector);

  async function focusIsOutsideField(page: Page): Promise<boolean> {
    return modelInput(page).evaluate((input) => {
      const field = input.parentElement?.parentElement ?? input;
      const active = document.activeElement;
      return active !== null && !field.contains(active);
    });
  }

  test('Escape with the menu open commits typed "Opus" as the alias', async () => {
    await withAliasPage(async (page) => {
      await openNewTaskAdvanced(page);
      await modelInput(page).fill('Opus');
      await expect(menu(page)).toBeVisible();
      // Stored as typed until something commits it: no alias title yet.
      await expect(modelInput(page)).not.toHaveAttribute('title');

      // Focus stays in the input, so Escape is the only close path that can commit.
      await page.keyboard.press('Escape');
      await expect(menu(page)).toBeHidden({ timeout: 3000 });
      await expect(modelInput(page)).toHaveAttribute('title', OPUS_TITLE);
      // The first Escape closes the menu only; the New Task dialog is still up.
      await expect(page.locator('input[placeholder="Task title"]')).toBeVisible();
    });
  });

  test('closing the menu with the chevron commits typed "Opus" as the alias', async () => {
    await withAliasPage(async (page) => {
      await openNewTaskAdvanced(page);
      await modelInput(page).fill('Opus');
      await expect(modelInput(page)).not.toHaveAttribute('title');

      // Pressing the chevron only moves focus within the field, so this click
      // handler is the sole commit path.
      await fieldControl(page, 'button[aria-label="Close dropdown"]').click();
      await expect(menu(page)).toBeHidden({ timeout: 3000 });
      await expect(modelInput(page)).toHaveAttribute('title', OPUS_TITLE);
    });
  });

  // The typed text filters the menu, so the pick has to be a row that still
  // matches it. "Sonnet" is the display name of the alias `sonnet`, so picking
  // the pinned Sonnet 5 row is a value the leftover typing would visibly
  // overwrite (an alias row named by the typing itself would be indistinguishable).
  test('typing then picking a row keeps the pick when focus later leaves the field', async () => {
    await withAliasPage(async (page) => {
      await openNewTaskAdvanced(page);
      await modelInput(page).fill('Sonnet');
      await expect(modelInput(page)).not.toHaveAttribute('title');
      await menu(page).locator('[data-model-pinned-toggle]').click();
      await menu(page).locator('[data-model-option][title="claude-sonnet-5"]').click();
      await expect(menu(page)).toBeHidden({ timeout: 3000 });
      await expect(modelInput(page)).toHaveValue('Sonnet 5');
      // A pinned version carries no alias title.
      await expect(modelInput(page)).not.toHaveAttribute('title');

      // Reopen without typing, then leave the field. Any typing left over from
      // before the pick would be committed here and rewrite the pick to `sonnet`.
      await modelInput(page).click();
      await expect(menu(page)).toBeVisible();
      await page.keyboard.press('Shift+Tab');
      expect(await focusIsOutsideField(page)).toBe(true);

      await expect(modelInput(page)).toHaveValue('Sonnet 5');
      await expect(modelInput(page)).not.toHaveAttribute('title');
    });
  });

  test('typing then clearing leaves the field empty when focus later leaves it', async () => {
    await withAliasPage(async (page) => {
      await openNewTaskAdvanced(page);
      await modelInput(page).fill('Opus');
      await fieldControl(page, 'button[aria-label="Clear"]').click();
      await expect(modelInput(page)).toHaveValue('');

      // Any typing left over from before the clear would be committed here and
      // resurrect `opus`.
      await page.keyboard.press('Shift+Tab');
      expect(await focusIsOutsideField(page)).toBe(true);

      await expect(modelInput(page)).toHaveValue('');
      await expect(modelInput(page)).not.toHaveAttribute('title');
    });
  });
});

// ---------------------------------------------------------------------------
// The typed-text rewrite comes from the agent's own display names
// ---------------------------------------------------------------------------

test.describe('Model combobox typed-text rewrite for an agent with non-Claude names', () => {
  // A Cursor-like agent whose ids and names are not Claude-shaped: the id
  // `gpt-5.5` keeps its dot and its display name is "GPT 5.5". The rewrite has
  // to come from this agent's `modelDisplayNames`, not from Claude id synthesis.
  const CURSOR_LIKE_AGENT = {
    cursor: {
      found: true,
      path: '/usr/bin/cursor-agent',
      capabilities: {
        effortLevels: [] as string[],
        supportsModelOverride: true,
        models: ['gpt-5.5', 'gpt-5.5-mini'],
        modelDisplayNames: { 'gpt-5.5': 'GPT 5.5','gpt-5.5-mini': 'GPT 5.5 Mini' },
      },
    },
  };

  async function launchCursorLikePage(): Promise<{ browser: Browser; page: Page }> {
    const { browser, page } = await launchPage();
    // The next project created defaults to the Cursor-like agent, so the New
    // Task dialog's effective agent is it without touching the Agent picker.
    await page.evaluate(() => {
      (window as unknown as { __mockDefaultAgentOverride?: string }).__mockDefaultAgentOverride = 'cursor';
    });
    await createProject(page, `CursorLikeModels ${Date.now()}`);
    await waitForBoard(page);
    await setAgentListOverrides(page, CURSOR_LIKE_AGENT);
    return { browser, page };
  }

  async function createTaskWithTypedModel(page: Page, title: string, typedModel: string): Promise<string | null | undefined> {
    await openNewTaskAdvanced(page);
    await page.locator('input[placeholder="Task title"]').fill(title);
    const modelInput = page.locator('input[data-testid="task-model-override"]');
    await modelInput.fill(typedModel);
    // Enter both closes the menu and submits the New Task form, in one keystroke.
    await modelInput.press('Enter');
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });
    const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
    return tasks.find((task: { title: string }) => task.title === title)?.model_override;
  }

  test('typed "GPT 5.5" is stored as the offered id gpt-5.5, and typed "Gpt 4" (not offered) as typed', async () => {
    const { browser, page } = await launchCursorLikePage();
    try {
      expect(await createTaskWithTypedModel(page, 'Cursor Like Task', 'GPT 5.5')).toBe('gpt-5.5');
      expect(await createTaskWithTypedModel(page, 'Cursor Unoffered Task', 'Gpt 4')).toBe('Gpt 4');
    } finally {
      await browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The context bar popover
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-model-aliases';
const TASK_ID = 'task-model-aliases';
const SESSION_ID = 'sess-model-aliases';
const SWIMLANE_ID = 'lane-model-aliases';

const RUNNING_TASK_PRECONFIG = `
  window.__mockAgentListOverrides = ${JSON.stringify(CLAUDE_WITH_ALIASES)};
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Model Aliases Context Bar', path: '/mock/model-aliases',
      github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    state.DEFAULT_SWIMLANES.forEach(function (defaultSwimlane, swimlaneIndex) {
      state.swimlanes.push({
        id: swimlaneIndex === 0 ? '${SWIMLANE_ID}' : state.uuid(), name: defaultSwimlane.name,
        role: defaultSwimlane.role, color: defaultSwimlane.color, icon: defaultSwimlane.icon,
        is_archived: defaultSwimlane.is_archived, permission_strategy: defaultSwimlane.permission_strategy ?? null,
        auto_spawn: defaultSwimlane.auto_spawn ?? false, position: swimlaneIndex, created_at: timestamp,
      });
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999, status: 'running',
      shell: 'bash', cwd: '/mock/model-aliases', startedAt: timestamp, exitCode: null, resuming: false,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Alias Popover Task', description: '', swimlane_id: '${SWIMLANE_ID}', position: 0,
      agent: 'claude', session_id: '${SESSION_ID}', worktree_path: null, branch_name: null, pr_number: null,
      pr_url: null, base_branch: null, labels: [], priority: 0, model_override: null, effort_override: null,
      attachment_count: 0, archived_at: null, created_at: timestamp, updated_at: timestamp,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

/** Give the running task's project a default model, with no column override anywhere. */
const PROJECT_DEFAULT_OPUS_SCRIPT = `
  window.__mockPreConfigure(function (state) {
    state.projects.forEach(function (project) {
      if (project.id === '${PROJECT_ID}') project.default_model = 'opus';
    });
  });
`;

async function launchRunningTask(extraInitScript = ''): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(RUNNING_TASK_PRECONFIG);
  if (extraInitScript) await page.addInitScript(extraInitScript);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/** Report a live model for the session, as the agent's status telemetry would. */
async function applyLiveModel(page: Page, model: string, displayName: string): Promise<void> {
  await page.evaluate(
    ({ sessionId, modelId, name }) => {
      const stores = (window as unknown as {
        __zustandStores?: { session: { getState: () => { updateUsage: (id: string, data: unknown) => void } } };
      }).__zustandStores;
      stores?.session.getState().updateUsage(sessionId, {
        model: { id: modelId, displayName: name, effort: 'high' },
        contextWindow: {
          usedPercentage: 0, usedTokens: 0, cacheTokens: 0, totalInputTokens: 0, totalOutputTokens: 0,
          contextWindowSize: 1_000_000,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
      });
    },
    { sessionId: SESSION_ID, modelId: model, name: displayName },
  );
}

/** Set the task's own model override and its column's, straight in the board store. */
async function setOverrides(page: Page, taskModel: string | null, columnModel: string | null): Promise<void> {
  await page.evaluate(
    ({ taskId, laneId, task, column }) => {
      const stores = (window as unknown as {
        __zustandStores?: { board: { setState: (updater: (storeState: unknown) => unknown) => void } };
      }).__zustandStores;
      stores?.board.setState((storeState) => {
        const state = storeState as {
          tasks: Array<{ id: string; model_override: string | null }>;
          swimlanes: Array<{ id: string; model_override: string | null }>;
        };
        return {
          tasks: state.tasks.map((boardTask) => (boardTask.id === taskId ? { ...boardTask, model_override: task } : boardTask)),
          swimlanes: state.swimlanes.map((lane) => (lane.id === laneId ? { ...lane, model_override: column } : lane)),
        };
      });
    },
    { taskId: TASK_ID, laneId: SWIMLANE_ID, task: taskModel, column: columnModel },
  );
}

test.describe('Context bar model popover with floating aliases', () => {
  test('the task\'s own alias pick gets the check while the pill shows the live version, and picking an alias sends it', async () => {
    const { browser, page } = await launchRunningTask();
    try {
      await setOverrides(page, 'opus', null);
      await applyLiveModel(page, 'claude-opus-5-5', 'Opus 5.5');

      const trigger = page.locator('[data-testid="context-bar-model-trigger"]');
      await expect(trigger).toContainText('Opus 5.5');
      await trigger.click();

      const popover = page.locator('[data-testid="context-bar-model-popover"]');
      await expect(popover.locator('[data-testid="context-bar-model-popover-alias-group"]')).toBeVisible();
      // The Latest label leads the popover, with no "Model" heading above it.
      await expect(popover.getByText('Model', { exact: true })).toHaveCount(0);
      await expect(popover.locator('[data-testid="context-bar-model-popover-option-target-opus"]')).toHaveText('Opus 5.5');
      // The check follows the pick (the alias row), not the live version.
      await expect(popover.locator('[data-testid="context-bar-model-popover-option-opus"] svg')).toHaveClass(/text-fg-secondary/);
      await expect(popover.locator('[data-testid="context-bar-model-popover-pinned-toggle"]')).toHaveText(/Specific versions \(7\)/);
      // The live version sits in the collapsed section, which a live match alone never opens.
      await expect(popover.locator('[data-testid="context-bar-model-popover-option-claude-opus-5-5"]')).toHaveCount(0);

      await popover.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();
      await expect(popover).toHaveCount(0);
      const calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
      expect(calls).toEqual([{ taskId: TASK_ID, model: 'sonnet' }]);
    } finally {
      await browser.close();
    }
  });

  test('a task following an alias column default checks the footer, which names the family', async () => {
    const { browser, page } = await launchRunningTask();
    try {
      await setOverrides(page, null, 'opus');
      await applyLiveModel(page, 'claude-opus-5-5', 'Opus 5.5');

      await page.locator('[data-testid="context-bar-model-trigger"]').click();
      const footer = page.locator('[data-testid="context-bar-model-popover-option-clear"]');
      await expect(footer).toHaveText('Use column default (Opus)');
      await expect(footer.locator('svg')).toHaveClass(/text-fg-secondary/);
      await expect(page.locator('[data-testid="context-bar-model-popover-option-opus"] svg')).toHaveClass(/text-transparent/);
    } finally {
      await browser.close();
    }
  });

  test('a task following only the project default model checks the footer, not the live row', async () => {
    const { browser, page } = await launchRunningTask(PROJECT_DEFAULT_OPUS_SCRIPT);
    try {
      // No task pin and no column pin: the project default is the only configured tier.
      await setOverrides(page, null, null);
      // Haiku has no alias, so its row sits at the top level and is visible without
      // opening the versions section.
      await applyLiveModel(page, 'claude-haiku-4-5', 'Haiku 4.5');

      await page.locator('[data-testid="context-bar-model-trigger"]').click();
      const popover = page.locator('[data-testid="context-bar-model-popover"]');
      const footer = popover.locator('[data-testid="context-bar-model-popover-option-clear"]');
      await expect(footer).toHaveText('Use column default (Opus)');
      await expect(footer.locator('svg')).toHaveClass(/text-fg-secondary/);
      // What runs is not what was picked, so the live row stays unchecked.
      await expect(popover.locator('[data-testid="context-bar-model-popover-option-claude-haiku-4-5"] svg')).toHaveClass(/text-transparent/);
      await expect(popover.locator('[data-testid="context-bar-model-popover-option-opus"] svg')).toHaveClass(/text-transparent/);
    } finally {
      await browser.close();
    }
  });

  test('an agent that reports aliases and no model list still gets the model trigger and the alias rows', async () => {
    const { browser, page } = await launchRunningTask();
    try {
      await setAgentListOverrides(page, CLAUDE_ALIASES_WITHOUT_MODELS);
      await applyLiveModel(page, 'claude-opus-5-5', 'Opus 5.5');

      const trigger = page.locator('[data-testid="context-bar-model-trigger"]');
      await expect(trigger).toBeVisible();
      await trigger.click();

      const popover = page.locator('[data-testid="context-bar-model-popover"]');
      await expect(popover.locator('[data-testid="context-bar-model-popover-alias-group"]')).toBeVisible();
      await expect(popover.locator('button[data-model-alias]')).toHaveCount(3);
      // No specific versions to fold away.
      await expect(popover.locator('[data-testid="context-bar-model-popover-pinned-toggle"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Context bar model popover checkmark for a live alias id', () => {
  // Runs after the launcher's own preconfig, so it replaces the alias fixture.
  const ALIASES_ONLY_SCRIPT = `window.__mockAgentListOverrides = ${JSON.stringify(CLAUDE_WITH_ALIASES_ONLY)};`;

  test('with no override anywhere, a live model id that is an alias id checks that alias row', async () => {
    const { browser, page } = await launchRunningTask(ALIASES_ONLY_SCRIPT);
    try {
      // The spawn seeds the live id from `--model sonnet` before telemetry lands.
      await applyLiveModel(page, 'sonnet', 'Sonnet');
      const trigger = page.locator('[data-testid="context-bar-model-trigger"]');
      await expect(trigger).toContainText('Sonnet');
      await trigger.click();

      const popover = page.locator('[data-testid="context-bar-model-popover"]');
      await expect(popover.locator('[data-testid="context-bar-model-popover-alias-group"]')).toBeVisible();
      await expect(popover.locator('[data-testid="context-bar-model-popover-option-sonnet"] svg')).toHaveClass(
        /text-fg-secondary/,
      );
      // Only that row is checked.
      await expect(popover.locator('[data-testid="context-bar-model-popover-option-opus"] svg')).toHaveClass(
        /text-transparent/,
      );
    } finally {
      await browser.close();
    }
  });
});

test.describe('Command Terminal model popover', () => {
  test('a Command Terminal session never checks the column default footer, even with a project default', async () => {
    const { browser, page } = await launchRunningTask(PROJECT_DEFAULT_OPUS_SCRIPT);
    try {
      await page.keyboard.press('Control+Shift+P');
      const overlay = page.getByTestId('command-terminal-window');
      await expect(overlay).toBeVisible();
      await expect(overlay.locator('[data-testid="usage-bar"]')).toBeVisible({ timeout: 5000 });

      // The mock's spawn mints a random id, so read the transient session back.
      let transientSessionId = '';
      await expect
        .poll(async () => {
          transientSessionId = await page.evaluate(async () => {
            const sessions = await window.electronAPI.sessions.list();
            return sessions.find((session: { transient?: boolean }) => session.transient)?.id ?? '';
          });
          return transientSessionId;
        }, { timeout: 5000 })
        .not.toBe('');

      await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores?: { session: { getState: () => { updateUsage: (id: string, data: unknown) => void } } };
        }).__zustandStores;
        stores?.session.getState().updateUsage(sessionId, {
          model: { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', effort: 'high' },
          contextWindow: {
            usedPercentage: 0, usedTokens: 0, cacheTokens: 0, totalInputTokens: 0, totalOutputTokens: 0,
            contextWindowSize: 200_000,
          },
          cost: { totalCostUsd: 0, totalDurationMs: 0 },
        });
      }, transientSessionId);

      await overlay.locator('[data-testid="context-bar-model-trigger"]').click();
      const popover = page.locator('[data-testid="context-bar-model-popover"]');
      const footer = popover.locator('[data-testid="context-bar-model-popover-option-clear"]');
      // The project default still names the revert row...
      await expect(footer).toHaveText('Use column default (Opus)');
      // ...but a Command Terminal has no column, so the check goes to the live model.
      await expect(footer.locator('svg')).toHaveClass(/text-transparent/);
      await expect(popover.locator('[data-testid="context-bar-model-popover-option-claude-haiku-4-5"] svg')).toHaveClass(/text-fg-secondary/);
    } finally {
      await browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// An agent that reports aliases and no model list
// ---------------------------------------------------------------------------

test.describe('Model combobox for an agent with aliases and no model list', () => {
  test('the chevron and the alias rows are offered even though the model list is empty', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `AliasesNoModels ${Date.now()}`);
      await waitForBoard(page);
      await setAgentListOverrides(page, CLAUDE_ALIASES_WITHOUT_MODELS);
      await openNewTaskAdvanced(page);

      const modelInput = page.locator('input[data-testid="task-model-override"]');
      const menu = page.locator('[data-testid="task-model-override-menu"]');
      const chevron = modelInput.locator('xpath=..').locator('button[aria-label="Open dropdown"]');
      await expect(chevron).toBeVisible();

      await chevron.click();
      await expect(menu).toBeVisible();
      const aliasIds = await menu
        .locator('button[data-model-alias]')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-model-alias')));
      expect(aliasIds).toEqual(['opus', 'fable', 'sonnet']);
      await expect(menu.locator('[data-model-alias-target]')).toHaveText(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5']);
      // No specific versions: no top-level version rows and no folded section.
      await expect(menu.locator('[data-model-option]:not([data-model-alias])')).toHaveCount(0);
      await expect(menu.locator('[data-model-pinned-toggle]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The newer-version mark from the discovered list only
// ---------------------------------------------------------------------------

test.describe('Column Manager overview newer-version mark from discovered models', () => {
  // The capability list reports only the older pin. The newer generation is one
  // the user has run, so it lives in config.discoveredModelsByAgent alone.
  const CLAUDE_OLDER_PIN_ONLY = {
    claude: {
      capabilities: {
        effortLevels: ['low', 'medium', 'high'],
        supportsModelOverride: true,
        models: ['claude-sonnet-5'],
        modelDisplayNames: { 'claude-sonnet-5': 'Sonnet 5', 'claude-sonnet-5-5': 'Sonnet 5.5' },
      },
    },
  };
  const INIT_SCRIPT = `
    window.__mockAgentListOverrides = ${JSON.stringify(CLAUDE_OLDER_PIN_ONLY)};
    window.__mockConfigOverrides = { discoveredModelsByAgent: { claude: ['claude-sonnet-5-5'] } };
  `;

  test('a saved older pin gets the mark from a newer model only the discovered list knows', async () => {
    await waitForViteReady(VITE_URL);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      // Before the mock: it reads __mockConfigOverrides once, while it initializes.
      await page.addInitScript(INIT_SCRIPT);
      await page.addInitScript({ path: MOCK_SCRIPT });
      await gotoVite(page, VITE_URL);
      await page.waitForLoadState('load');
      await page.waitForSelector('text=Kangentic', { timeout: 15000 });
      await createProject(page, `DiscoveredNewer ${Date.now()}`);
      await waitForBoard(page);

      // The precondition the test stands on: the capability list does not know 5.5.
      const capabilityModels = await page.evaluate(async () => {
        const agents = await window.electronAPI.agents.list();
        return agents.find((agent: { name: string }) => agent.name === 'claude')?.capabilities?.models ?? [];
      });
      expect(capabilityModels).toEqual(['claude-sonnet-5']);

      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { setState: (updater: (storeState: unknown) => unknown) => void } };
        }).__zustandStores;
        stores?.board.setState((storeState) => {
          const state = storeState as { swimlanes: Array<{ name: string; model_override: string | null }> };
          return {
            swimlanes: state.swimlanes.map((lane) =>
              lane.name === 'Code Review' ? { ...lane, model_override: 'claude-sonnet-5' } : lane,
            ),
          };
        });
      });

      await page.locator('[data-swimlane-name="Code Review"]').locator('text=Code Review').click();
      const dialog = page.locator('[data-testid="board-manager-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 3000 });
      await dialog.locator('[data-testid="board-manager-tab-all"]').click();

      const modelCell = dialog
        .locator('[data-testid="board-manager-overview-row"]')
        .filter({ hasText: 'Code Review' })
        .locator('td')
        .nth(3);
      await expect(modelCell.locator('[data-state="changed"]')).toHaveText('Sonnet 5');
      await expect(modelCell.locator('[data-overview-newer]')).toHaveAttribute('title', 'Sonnet 5.5 available');
    } finally {
      await browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The Column Manager's All columns table, reading saved overrides
// ---------------------------------------------------------------------------

test.describe('Column Manager overview reads saved overrides by the column\'s own agent', () => {
  interface LaneSeed {
    agent: string | null;
    model: string;
  }

  /** Put saved overrides straight on the board store's swimlanes, before the dialog opens. */
  async function seedSavedLaneOverrides(page: Page, seeds: Record<string, LaneSeed>): Promise<void> {
    await page.evaluate((laneSeeds) => {
      const stores = (window as unknown as {
        __zustandStores?: { board: { setState: (updater: (storeState: unknown) => unknown) => void } };
      }).__zustandStores;
      stores?.board.setState((storeState) => {
        const state = storeState as {
          swimlanes: Array<{ name: string; agent_override: string | null; model_override: string | null }>;
        };
        return {
          swimlanes: state.swimlanes.map((lane) => {
            const seed = laneSeeds[lane.name];
            return seed ? { ...lane, agent_override: seed.agent, model_override: seed.model } : lane;
          }),
        };
      });
    }, seeds);
  }

  async function openOverview(page: Page): Promise<void> {
    await page.locator('[data-swimlane-name="Code Review"]').locator('text=Code Review').click();
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await dialog.locator('[data-testid="board-manager-tab-all"]').click();
  }

  const modelCell = (page: Page, laneName: string) =>
    page
      .locator('[data-testid="board-manager-dialog"] [data-testid="board-manager-overview-row"]')
      .filter({ hasText: laneName })
      .locator('td')
      .nth(3);

  test('a saved older pin shows its newer-version mark and an alias pin its target in the title', async () => {
    await withAliasPage(async (page) => {
      await seedSavedLaneOverrides(page, {
        'Code Review': { agent: null, model: 'claude-sonnet-5' },
        Executing: { agent: null, model: 'opus' },
      });
      await openOverview(page);

      const olderPin = modelCell(page, 'Code Review').locator('[data-state]');
      await expect(olderPin).toHaveText('Sonnet 5');
      await expect(modelCell(page, 'Code Review').locator('[data-overview-newer]')).toHaveAttribute(
        'title',
        'Sonnet 5.5 available',
      );

      const aliasPin = modelCell(page, 'Executing').locator('[data-state]');
      await expect(aliasPin).toHaveText('Opus');
      await expect(aliasPin).toHaveAttribute('title', 'Latest Opus, currently Opus 5.5');
      await expect(modelCell(page, 'Executing').locator('[data-overview-newer]')).toHaveCount(0);
    });
  });

  test('another column holding the hand-written "Opus" adds no row to the model menu, but a custom model does', async () => {
    await withAliasPage(async (page) => {
      await seedSavedLaneOverrides(page, {
        // A hand-edited kangentic.json or an MCP call can store the display name.
        Executing: { agent: null, model: 'Opus' },
        // A value nothing offered recognizes still earns a row: a column is using it.
        Merge: { agent: null, model: 'Workhorse' },
      });
      await page.locator('[data-swimlane-name="Code Review"]').locator('text=Code Review').click();
      const dialog = page.locator('[data-testid="board-manager-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 3000 });

      await dialog.locator('input[data-testid="column-model-override"]').click();
      const menu = page.locator('[data-testid="column-model-override-menu"]');
      await expect(menu).toBeVisible();
      await expect(menu.locator('[data-model-alias="opus"]')).toHaveCount(1);
      // The rows outside Latest: the unaliased family and the custom model, no "Opus".
      await expect(menu.locator('[data-model-option]:not([data-model-alias])')).toHaveText(['Haiku 4.5', 'Workhorse']);
    });
  });

  test('a lane on another agent shows neither the alias title nor the newer-version mark', async () => {
    await withAliasPage(async (page) => {
      await setAgentListOverrides(page, { ...CLAUDE_WITH_ALIASES, codex: { found: true } });
      await seedSavedLaneOverrides(page, {
        // Claude control lanes: these prove the marks render in this very dialog.
        'Code Review': { agent: null, model: 'claude-sonnet-5' },
        Executing: { agent: null, model: 'opus' },
        // Same model values on a Codex lane, which reports no aliases or model list.
        Testing: { agent: 'codex', model: 'claude-sonnet-5' },
        Merge: { agent: 'codex', model: 'opus' },
      });
      await openOverview(page);

      await expect(modelCell(page, 'Code Review').locator('[data-overview-newer]')).toHaveCount(1);
      await expect(modelCell(page, 'Executing').locator('[data-state]')).toHaveAttribute(
        'title',
        'Latest Opus, currently Opus 5.5',
      );

      // The Codex lanes are real value cells (the agent gate passes) with no marks.
      const codexPin = modelCell(page, 'Testing').locator('[data-state="changed"]');
      await expect(codexPin).toBeVisible();
      await expect(modelCell(page, 'Testing').locator('[data-overview-newer]')).toHaveCount(0);

      const codexAlias = modelCell(page, 'Merge').locator('[data-state="changed"]');
      await expect(codexAlias).toBeVisible();
      await expect(codexAlias).not.toHaveAttribute('title', /Latest/);
      await expect(modelCell(page, 'Merge').locator('[data-overview-newer]')).toHaveCount(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Settings > Agent default-model combobox
// ---------------------------------------------------------------------------

test.describe('Settings > Agent default model with floating aliases', () => {
  test('the default-model menu leads with the alias rows', async () => {
    await withAliasPage(async (page) => {
      await page.locator('[data-testid="settings-button"]').click();
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
      await page.getByRole('button', { name: 'Agent', exact: true }).click();

      const input = page.locator('input[data-testid="project-default-model"]');
      await expect(input).toBeVisible({ timeout: 3000 });
      await input.locator('xpath=..').locator('button[aria-label="Open dropdown"]').click();

      const menu = page.locator('[data-testid="project-default-model-menu"]');
      await expect(menu).toBeVisible({ timeout: 3000 });
      await expect(menu.locator('button[data-model-alias]')).toHaveCount(3);
      await expect(menu.locator('[data-model-alias-target]')).toHaveText(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5']);
    });
  });
});

// ---------------------------------------------------------------------------
// The Column Manager's All columns table
// ---------------------------------------------------------------------------

test.describe('Column Manager overview with floating aliases', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchPage();
    browser = result.browser;
    page = result.page;
    await createProject(page, `ModelAliasesOverview ${Date.now()}`);
    await waitForBoard(page);
    await setAgentListOverrides(page, CLAUDE_WITH_ALIASES);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('an alias cell names its target on hover, and an older pin carries the newer-version mark', async () => {
    await page.locator('[data-swimlane-name="Code Review"]').locator('text=Code Review').click();
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const modelInput = dialog.locator('input[data-testid="column-model-override"]');
    const modelCell = () =>
      dialog.locator('[data-testid="board-manager-overview-row"]').filter({ hasText: 'Code Review' }).locator('td').nth(3);

    // An older pinned version: the cell shows it with the upgrade mark.
    await modelInput.click();
    await page.locator('[data-testid="column-model-override-menu"] [data-model-pinned-toggle]').click();
    await page.locator('[data-model-option][title="claude-sonnet-5"]').click();
    await dialog.locator('[data-testid="board-manager-tab-all"]').click();
    await expect(modelCell().locator('[data-state="changed"]')).toHaveText('Sonnet 5');
    await expect(modelCell().locator('[data-overview-newer]')).toHaveAttribute('title', 'Sonnet 5.5 available');

    // An alias: the family name, with the version it runs in the title and no mark.
    await dialog.locator('[data-testid="board-manager-overview-row"]').filter({ hasText: 'Code Review' }).click();
    await modelInput.click();
    await page.locator('button[data-model-alias="opus"]').click();
    await dialog.locator('[data-testid="board-manager-tab-all"]').click();
    const aliasValue = modelCell().locator('[data-state="changed"]');
    await expect(aliasValue).toHaveText('Opus');
    await expect(aliasValue).toHaveAttribute('title', 'Latest Opus, currently Opus 5.5');
    await expect(modelCell().locator('[data-overview-newer]')).toHaveCount(0);
  });
});
