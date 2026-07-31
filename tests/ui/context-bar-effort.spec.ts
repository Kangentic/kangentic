/**
 * UI tests for the ContextBar effort suffix/pill.
 *
 * Claude Code 2.1.119+ emits `effort.level` (low/medium/high/xhigh) in
 * status.json. ClaudeStatusParser surfaces it as `usage.model.effort`,
 * and ContextBar renders it next to the model name. The effort pill is a
 * permanent fixture - it doubles as the in-place picker trigger, so there
 * is no toggle to hide it.
 *
 * Mirrors the cursor-context-bar pattern: drive the renderer by calling
 * session-store updateUsage directly (the same path the IPC 'usage'
 * listener uses in production).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-effort-ctx-bar';
const TASK_ID = 'task-effort-ctx-bar';
const SESSION_ID = 'sess-effort-ctx-bar';
const SWIMLANE_ID = 'lane-effort-todo';

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * `effortOverride` is the configured task-level tier. The default (null) keeps
 * the original fixtures' behaviour: no override anywhere, so a session that
 * reports no effort has nothing to fall back to and the pill stays hidden.
 */
const claudeRunningPreconfig = (effortOverride: string | null = null): string => `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Effort ContextBar Test',
      path: '/mock/effort-ctx-bar',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = i === 0 ? '${SWIMLANE_ID}' : state.uuid();
      state.swimlanes.push({
        id: id,
        name: s.name,
        role: s.role,
        color: s.color,
        icon: s.icon,
        is_archived: s.is_archived,
        permission_strategy: s.permission_strategy ?? null,
        auto_spawn: s.auto_spawn ?? false,
        position: i,
        created_at: ts,
      });
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/effort-ctx-bar',
      startedAt: ts,
      exitCode: null,
      resuming: false,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Effort Display Task',
      description: '',
      swimlane_id: '${SWIMLANE_ID}',
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      effort_override: ${effortOverride === null ? 'null' : `'${effortOverride}'`},
      model_override: null,
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function applyClaudeUsage(
  page: Page,
  sessionId: string,
  effort: string | undefined,
  options: { reportedByAgent?: boolean; modelId?: string; modelDisplayName?: string } = {},
): Promise<void> {
  const {
    reportedByAgent = true,
    modelId = 'claude-opus-4-7[1m]',
    modelDisplayName = 'Opus 4.7 (1M context)',
  } = options;
  await page.evaluate(
    ({ sessionId: id, effort: effortLevel, reported, modelIdValue, modelName }) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
        };
      }).__zustandStores;
      stores?.session.getState().updateUsage(id, {
        model: { id: modelIdValue, displayName: modelName, effort: effortLevel, reportedByAgent: reported },
        contextWindow: {
          usedPercentage: 0,
          usedTokens: 0,
          cacheTokens: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          contextWindowSize: 1_000_000,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
      });
    },
    { sessionId, effort, reported: reportedByAgent, modelIdValue: modelId, modelName: modelDisplayName },
  );
}

test.describe('ContextBar effort suffix', () => {
  test('renders effort level next to model name when usage.model.effort is set', async () => {
    const { browser, page } = await launchWithState(claudeRunningPreconfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(usageBar).toBeVisible({ timeout: 10000 });

      await applyClaudeUsage(page, SESSION_ID, 'xhigh');

      // Model name and effort suffix both appear inside the same usage bar
      await expect.poll(async () => usageBar.textContent(), { timeout: 5000 }).toMatch(/Opus 4\.7/);
      await expect(usageBar).toContainText('xhigh');
    } finally {
      await browser.close();
    }
  });

  test('omits effort suffix when usage.model.effort is undefined (older Claude Code)', async () => {
    const { browser, page } = await launchWithState(claudeRunningPreconfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await applyClaudeUsage(page, SESSION_ID, undefined);

      const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect.poll(async () => usageBar.textContent(), { timeout: 5000 }).toMatch(/Opus 4\.7/);
      // No effort levels should leak into the pill text
      await expect(usageBar).not.toContainText('xhigh');
      await expect(usageBar).not.toContainText('high');
      await expect(usageBar).not.toContainText('medium');
      await expect(usageBar).not.toContainText('low');
    } finally {
      await browser.close();
    }
  });
});

/**
 * A value the agent reports and a value we merely configured used to render
 * identically. On a model with no effort levels (Claude Code omits the `effort`
 * key entirely for those) that made the pill show a stale configured tier with
 * full confidence. Provenance is asserted through `data-effort-source` /
 * `data-model-source` rather than classes or measured borders, so these do not
 * depend on rendering geometry.
 */
test.describe('ContextBar pill provenance', () => {
  test('hides the effort control entirely when the model has no effort levels', async () => {
    const { browser, page } = await launchWithState(claudeRunningPreconfig('high'));
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // A Haiku-shaped snapshot: model reported, effort key absent. That pair
      // proves the model has no effort levels, so an effort picker could not
      // apply anything to this session and a configured tier means nothing here.
      await applyClaudeUsage(page, SESSION_ID, undefined, {
        reportedByAgent: true,
        modelId: 'claude-haiku-4-5',
        modelDisplayName: 'Haiku 4.5',
      });

      // Scoped to the bar: a task-detail window plus the bottom panel can mount
      // two context bars, and an unscoped locator would fail strict mode.
      const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
      // The model DID report, so its own pill is live - which is what proves a
      // snapshot landed rather than the bar simply not having painted yet.
      await expect(usageBar.locator('[data-model-source]'))
        .toHaveAttribute('data-model-source', 'live', { timeout: 5000 });
      await expect(usageBar.locator('[data-effort-source]')).toHaveCount(0);
      // The configured `high` must not leak in as bare text either.
      await expect(usageBar).not.toContainText('high');
    } finally {
      await browser.close();
    }
  });

  test('marks the effort pill configured before the first snapshot arrives', async () => {
    const { browser, page } = await launchWithState(claudeRunningPreconfig('high'));
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Spawn-seeded model, nothing reported yet. Whether this model has effort
      // is still unknown, so the configured tier is the best answer available -
      // shown, but marked as not confirmed.
      await applyClaudeUsage(page, SESSION_ID, undefined, { reportedByAgent: false });

      const effortPill = page.locator('[data-testid="usage-bar"].min-h-8').locator('[data-effort-source]');
      await expect(effortPill).toHaveAttribute('data-effort-source', 'configured', { timeout: 5000 });
      await expect(effortPill).toContainText('high');
    } finally {
      await browser.close();
    }
  });

  test('marks the effort pill live when the agent reports one', async () => {
    const { browser, page } = await launchWithState(claudeRunningPreconfig('high'));
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await applyClaudeUsage(page, SESSION_ID, 'low');

      const effortPill = page.locator('[data-testid="usage-bar"].min-h-8').locator('[data-effort-source]');
      await expect(effortPill).toHaveAttribute('data-effort-source', 'live', { timeout: 5000 });
      // Live wins over the configured `high`.
      await expect(effortPill).toContainText('low');
    } finally {
      await browser.close();
    }
  });

  test('marks the model pill configured until a telemetry snapshot lands', async () => {
    const { browser, page } = await launchWithState(claudeRunningPreconfig('high'));
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // A spawn seeds the model name from the `--model` flag with no telemetry.
      await applyClaudeUsage(page, SESSION_ID, undefined, { reportedByAgent: false });
      const modelPill = page.locator('[data-testid="usage-bar"].min-h-8').locator('[data-model-source]');
      await expect(modelPill).toHaveAttribute('data-model-source', 'configured', { timeout: 5000 });

      // The agent reports; the same pill becomes live.
      await applyClaudeUsage(page, SESSION_ID, 'low', { reportedByAgent: true });
      await expect(modelPill).toHaveAttribute('data-model-source', 'live', { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
