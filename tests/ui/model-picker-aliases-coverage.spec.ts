/**
 * Coverage holes left by model-picker-aliases.spec.ts, each pinned red-green:
 *
 *   1. ModelCombobox typed-text commit on its close paths (Escape, chevron) and
 *      the two places the remembered typing must be forgotten (a row pick and
 *      the Clear control), so leftover text never rewrites a later choice.
 *   2. The Column Manager All columns table reading a column's SAVED model
 *      override, and a lane on another agent borrowing neither the Claude alias
 *      title nor the newer-version mark.
 *   3. The context bar popover checking the alias row a live alias model id names.
 *   4. The Settings > Agent default-model combobox listing the alias rows.
 *
 * The fixture mirrors what the Claude adapter reports (see the sibling spec).
 * Each test launches its own page, so no state crosses tests.
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, waitForBoard, waitForViteReady } from './helpers';
import type { Browser, Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const ALIAS_CAPABILITIES = {
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
  },
  modelAliases: [
    { id: 'opus', resolvesTo: 'claude-opus-5-5' },
    { id: 'fable', resolvesTo: 'claude-fable-5-1' },
    { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
  ],
};

const CLAUDE_WITH_ALIASES = { claude: { capabilities: ALIAS_CAPABILITIES } };

/** The same fixture without the learned bare `sonnet`, so an alias id is offered ONLY as an alias. */
const CLAUDE_WITH_ALIASES_ONLY = {
  claude: {
    capabilities: {
      ...ALIAS_CAPABILITIES,
      models: ALIAS_CAPABILITIES.models.filter((modelId) => modelId !== 'sonnet'),
    },
  },
};

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
// 1. ModelCombobox typed-text commit
// ---------------------------------------------------------------------------

test.describe('ModelCombobox typed-text commit (New Task, Advanced)', () => {
  const OPUS_TITLE = 'Latest Opus, currently Opus 5.5';

  async function openAdvanced(page: Page): Promise<void> {
    await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await page.locator('[data-testid="task-advanced-toggle"]').click();
  }

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
      await openAdvanced(page);
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
      await openAdvanced(page);
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
  // matches it. "Sonnet" would normalize to the alias `sonnet`, so picking the
  // pinned Sonnet 5 row is a value the leftover typing would visibly overwrite
  // (an alias row named by the typing itself would be indistinguishable).
  test('typing then picking a row keeps the pick when focus later leaves the field', async () => {
    await withAliasPage(async (page) => {
      await openAdvanced(page);
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
      await openAdvanced(page);
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
// 2. Column Manager All columns overview
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
// 3. Context bar popover checkmark
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-alias-coverage';
const TASK_ID = 'task-alias-coverage';
const SESSION_ID = 'sess-alias-coverage';
const SWIMLANE_ID = 'lane-alias-coverage';

const RUNNING_TASK_PRECONFIG = `
  window.__mockAgentListOverrides = ${JSON.stringify(CLAUDE_WITH_ALIASES_ONLY)};
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Alias Coverage Context Bar', path: '/mock/alias-coverage',
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
      shell: 'bash', cwd: '/mock/alias-coverage', startedAt: timestamp, exitCode: null, resuming: false,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Alias Coverage Task', description: '', swimlane_id: '${SWIMLANE_ID}', position: 0,
      agent: 'claude', session_id: '${SESSION_ID}', worktree_path: null, branch_name: null, pr_number: null,
      pr_url: null, base_branch: null, labels: [], priority: 0, model_override: null, effort_override: null,
      attachment_count: 0, archived_at: null, created_at: timestamp, updated_at: timestamp,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchRunningTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(RUNNING_TASK_PRECONFIG);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/** Report a live model for the session, as the agent's status telemetry would. */
async function applyLiveModel(page: Page, modelId: string, displayName: string): Promise<void> {
  await page.evaluate(
    ({ sessionId, liveModelId, name }) => {
      const stores = (window as unknown as {
        __zustandStores?: { session: { getState: () => { updateUsage: (id: string, data: unknown) => void } } };
      }).__zustandStores;
      stores?.session.getState().updateUsage(sessionId, {
        model: { id: liveModelId, displayName: name, effort: 'high' },
        contextWindow: {
          usedPercentage: 0, usedTokens: 0, cacheTokens: 0, totalInputTokens: 0, totalOutputTokens: 0,
          contextWindowSize: 1_000_000,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
      });
    },
    { sessionId: SESSION_ID, liveModelId: modelId, name: displayName },
  );
}

test.describe('Context bar model popover checkmark for a live alias id', () => {
  test('with no override anywhere, a live model id that is an alias id checks that alias row', async () => {
    const { browser, page } = await launchRunningTask();
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

// ---------------------------------------------------------------------------
// 4. Settings > Agent default-model combobox
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
      const aliasIds = menu.locator('button[data-model-alias]');
      await expect(aliasIds).toHaveCount(3);
      await expect(menu.locator('[data-model-alias-target]')).toHaveText(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5']);
    });
  });
});
