/**
 * UI tests for the ContextBar effort suffix on the model pill.
 *
 * Claude Code 2.1.119+ emits `effort.level` (low/medium/high/xhigh) in
 * status.json. ClaudeStatusParser surfaces it as `usage.model.effort`,
 * and ContextBar renders it inline next to the model name (e.g.
 * "Opus 4.7  xhigh"). The suffix is gated by the `contextBar.showEffort`
 * toggle, so toggling it off must hide the suffix even when the data
 * is present.
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

const CLAUDE_RUNNING_PRECONFIG = `
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

async function applyClaudeUsage(page: Page, sessionId: string, effort: string | undefined): Promise<void> {
  await page.evaluate(
    ({ sessionId: id, effort: effortLevel }) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
        };
      }).__zustandStores;
      stores?.session.getState().updateUsage(id, {
        model: { id: 'claude-opus-4-7[1m]', displayName: 'Opus 4.7 (1M context)', effort: effortLevel },
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
    { sessionId, effort },
  );
}

test.describe('ContextBar effort suffix', () => {
  test('renders effort level next to model name when usage.model.effort is set', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
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

  test('hides effort suffix when contextBar.showEffort is false', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Flip the global config flag before usage arrives
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            config: { getState: () => { updateConfig: (patch: unknown) => Promise<void> } };
          };
        }).__zustandStores;
        return stores?.config.getState().updateConfig({ contextBar: { showEffort: false } });
      });

      await applyClaudeUsage(page, SESSION_ID, 'xhigh');

      const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect.poll(async () => usageBar.textContent(), { timeout: 5000 }).toMatch(/Opus 4\.7/);
      await expect(usageBar).not.toContainText('xhigh');
    } finally {
      await browser.close();
    }
  });

  test('omits effort suffix when usage.model.effort is undefined (older Claude Code)', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
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
