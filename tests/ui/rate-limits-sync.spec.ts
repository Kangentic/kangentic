/**
 * Cross-session sync of rate-limit pill values.
 *
 * Rate limits are an account-wide value, but each session only sees its own
 * status.json updates. The renderer keeps a single `latestRateLimits`
 * snapshot in the session store and every `ContextBar` reads from it, so
 * an idle agent never shows stale numbers while a sibling agent shows
 * fresh ones.
 *
 * This spec sets up two sessions with different rateLimits in the initial
 * usage cache and asserts that the displayed percentages on a session's
 * ContextBar match the *fresher* snapshot (the one populated last during
 * sync), regardless of which session's row is in view.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-rate-limits-sync';
const TASK_STALE_ID = 'task-rate-limits-stale';
const TASK_FRESH_ID = 'task-rate-limits-fresh';
const SESSION_STALE_ID = 'sess-rate-limits-stale';
const SESSION_FRESH_ID = 'sess-rate-limits-fresh';
const SWIMLANE_ID = 'lane-rate-limits';

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
 * Pre-configure two tasks, each backed by its own session, and seed the
 * usage cache with different rateLimits for each. The "fresh" entry is
 * pushed last so it wins under the renderer's seeding rule (last entry
 * with rateLimits in `cachedUsage` becomes the snapshot).
 */
function makePreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Rate Limits Sync',
        path: '/mock/rate-limits-sync',
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

      ['${SESSION_STALE_ID}', '${SESSION_FRESH_ID}'].forEach(function (sessionId) {
        state.sessions.push({
          id: sessionId,
          taskId: sessionId === '${SESSION_STALE_ID}' ? '${TASK_STALE_ID}' : '${TASK_FRESH_ID}',
          projectId: '${PROJECT_ID}',
          pid: 9999,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/rate-limits-sync',
          startedAt: ts,
          exitCode: null,
        });
        state.activityCache[sessionId] = 'idle';
      });

      state.tasks.push({
        id: '${TASK_STALE_ID}',
        title: 'Stale agent task',
        description: '',
        swimlane_id: '${SWIMLANE_ID}',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_STALE_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      state.tasks.push({
        id: '${TASK_FRESH_ID}',
        title: 'Fresh agent task',
        description: '',
        swimlane_id: '${SWIMLANE_ID}',
        position: 1,
        agent: 'claude',
        session_id: '${SESSION_FRESH_ID}',
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

    // Seed two distinct rateLimits snapshots. The fresh entry is iterated
    // last by Object.entries (insertion order), so it wins under the
    // renderer's seed rule in syncSessions.
    window.electronAPI.sessions.getUsage = async function () {
      var baseUsage = {
        model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
        contextWindow: { usedPercentage: 25, usedTokens: 1500, cacheTokens: 0, totalInputTokens: 1000, totalOutputTokens: 500, contextWindowSize: 200000 },
        cost: { totalCostUsd: 0.01, totalDurationMs: 5000 },
      };
      var result = {};
      result['${SESSION_STALE_ID}'] = Object.assign({}, baseUsage, {
        rateLimits: [
          { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 18, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 4, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 5 },
        ],
      });
      result['${SESSION_FRESH_ID}'] = Object.assign({}, baseUsage, {
        rateLimits: [
          { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 73, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 41, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 5 },
        ],
      });
      return result;
    };
  `;
}

test.describe('Rate limits cross-session sync', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithState(makePreConfig()));
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('stale session ContextBar shows the fresher snapshot, not its own rateLimits', async () => {
    // Open the stale-agent task. Its own usage entry has 18%/4%, but the
    // global snapshot was last populated by the fresh-agent entry (73%/41%).
    // The pill must reflect the global snapshot.
    await page.locator(`[data-task-id="${TASK_STALE_ID}"]`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
    await expect(contextBar).toBeVisible({ timeout: 10000 });

    const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('73%');
    await expect(pill).toContainText('41%');
    await expect(pill).not.toContainText('18%');
    await expect(pill).not.toContainText('4%');

    await page.locator('[data-testid="task-detail-close"]').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });

  test('fresh session ContextBar shows the same fresher snapshot', async () => {
    await page.locator(`[data-task-id="${TASK_FRESH_ID}"]`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
    await expect(contextBar).toBeVisible({ timeout: 10000 });

    const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('73%');
    await expect(pill).toContainText('41%');

    await page.locator('[data-testid="task-detail-close"]').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });

  test('pill tooltip records the snapshot source as "Updated ... via <agent>"', async () => {
    await page.locator(`[data-task-id="${TASK_STALE_ID}"]`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
    await expect(contextBar).toBeVisible({ timeout: 10000 });

    const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
    const titleAttr = await pill.getAttribute('title');
    expect(titleAttr).toBeTruthy();
    expect(titleAttr).toMatch(/Updated /);
    // The fresh task is what populated the snapshot last (sourceSessionId
    // points at SESSION_FRESH_ID). Its agent is 'claude' so the "via" suffix
    // resolves to 'Claude'. This asserts the snapshot's sourceSessionId is
    // wired through to the tooltip.
    expect(titleAttr).toContain('via Claude');

    await page.locator('[data-testid="task-detail-close"]').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });
});
