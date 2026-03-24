/**
 * UI tests for project-scoped session filtering.
 *
 * When switching between projects, the terminal panel and status bar should
 * only show sessions belonging to the current project. Sessions from other
 * projects must stay alive in the store (not cleared) so they reappear when
 * switching back.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'proj-scope-a';
const PROJECT_B_ID = 'proj-scope-b';
const SESSION_A_ID = 'sess-scope-a';
const SESSION_B_ID = 'sess-scope-b';
const TASK_A_ID = 'task-scope-a';
const TASK_B_ID = 'task-scope-b';

/**
 * Pre-configure mock state with two projects, each having a running session.
 * Starts with Project A active.
 */
function twoProjectPreConfig(options?: { withUsage?: boolean }): string {
  const withUsage = options?.withUsage ?? false;
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      // --- Project A ---
      state.projects.push({
        id: '${PROJECT_A_ID}',
        name: 'Project Alpha',
        path: '/mock/project-alpha',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // --- Project B ---
      state.projects.push({
        id: '${PROJECT_B_ID}',
        name: 'Project Beta',
        path: '/mock/project-beta',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // Swimlanes (shared in mock, but fine for session-scope testing)
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-scope-' + i,
          position: i,
          created_at: ts,
        }));
      });

      // --- Session A (belongs to Project A) ---
      state.sessions.push({
        id: '${SESSION_A_ID}',
        taskId: '${TASK_A_ID}',
        projectId: '${PROJECT_A_ID}',
        pid: 1001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/project-alpha',
        startedAt: ts,
        exitCode: null,
      });

      // --- Session B (belongs to Project B) ---
      state.sessions.push({
        id: '${SESSION_B_ID}',
        taskId: '${TASK_B_ID}',
        projectId: '${PROJECT_B_ID}',
        pid: 1002,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/project-beta',
        startedAt: ts,
        exitCode: null,
      });

      state.activityCache['${SESSION_A_ID}'] = 'idle';
      state.activityCache['${SESSION_B_ID}'] = 'idle';

      // Tasks -- one per project
      state.tasks.push({
        id: '${TASK_A_ID}',
        title: 'Alpha Task',
        description: '',
        swimlane_id: 'lane-scope-0',
        position: 0,
        agent: null,
        session_id: '${SESSION_A_ID}',
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
        id: '${TASK_B_ID}',
        title: 'Beta Task',
        description: '',
        swimlane_id: 'lane-scope-0',
        position: 1,
        agent: null,
        session_id: '${SESSION_B_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_A_ID}' };
    });
    ${withUsage ? `
    var origGetUsage = window.electronAPI.sessions.getUsage;
    window.electronAPI.sessions.getUsage = async function () {
      var result = {};
      result['${SESSION_A_ID}'] = {
        model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
        contextWindow: { usedPercentage: 25, usedTokens: 1500, cacheTokens: 0, totalInputTokens: 1000, totalOutputTokens: 500, contextWindowSize: 200000 },
        cost: { totalCostUsd: 0.05, totalDurationMs: 5000 },
      };
      result['${SESSION_B_ID}'] = {
        model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
        contextWindow: { usedPercentage: 50, usedTokens: 5000, cacheTokens: 0, totalInputTokens: 3000, totalOutputTokens: 2000, contextWindowSize: 200000 },
        cost: { totalCostUsd: 0.20, totalDurationMs: 10000 },
      };
      return result;
    };
    ` : ''}
  `;
}

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

test.describe('Project Session Scope', () => {
  test('terminal panel only shows current project sessions', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Project A is active -- should see alpha-task tab, not beta-task
      const alphaTab = page.locator('button:has-text("alpha-task")');
      const betaTab = page.locator('button:has-text("beta-task")');

      await expect(alphaTab).toBeVisible();
      await expect(betaTab).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('switching projects updates terminal panel to new project sessions', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Project A active -- alpha-task visible
      await expect(page.locator('button:has-text("alpha-task")')).toBeVisible();

      // Switch to Project B via sidebar
      await page.locator('[role="button"]:has-text("Project Beta")').click();
      await page.waitForTimeout(500);

      // Now beta-task should be visible, alpha-task hidden
      const betaTab = page.locator('button:has-text("beta-task")');
      const alphaTab = page.locator('button:has-text("alpha-task")');

      await expect(betaTab).toBeVisible();
      await expect(alphaTab).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('status bar counts only current project sessions', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig({ withUsage: true }));

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Project A is active -- status bar should show 1 agent (not 2)
      const sessionCount = page.locator('[data-testid="session-count"]');
      await expect(sessionCount).toContainText('1 agents');

      // Usage should only reflect Project A's session ($0.05, not $0.25)
      const cost = page.locator('[data-testid="aggregate-cost"]');
      await expect(cost).toContainText('$0.05');

      // Switch to Project B
      await page.locator('[role="button"]:has-text("Project Beta")').click();
      await page.waitForTimeout(500);

      // Status bar now shows Project B's session ($0.20)
      await expect(sessionCount).toContainText('1 agents');
      await expect(cost).toContainText('$0.20');
    } finally {
      await browser.close();
    }
  });

  test('sidebar shows idle badge for all projects with idle sessions', async () => {
    // Default fixture has both sessions set to 'idle' activity
    const { browser, page } = await launchWithState(twoProjectPreConfig());

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Project Alpha (active) should show idle mail+count badge
      const alphaRow = page.locator('[role="button"]:has-text("Project Alpha")');
      const alphaIdleBadge = alphaRow.locator('span[title*="idle"]');
      await expect(alphaIdleBadge).toBeVisible();
      await expect(alphaIdleBadge).toContainText('1');

      // Project Beta (non-active) should also show idle mail+count badge
      const betaRow = page.locator('[role="button"]:has-text("Project Beta")');
      const betaIdleBadge = betaRow.locator('span[title*="idle"]');
      await expect(betaIdleBadge).toBeVisible();
      await expect(betaIdleBadge).toContainText('1');

      // Neither should show a thinking badge (idle takes priority)
      await expect(alphaRow.locator('span[title*="thinking"]')).not.toBeVisible();
      await expect(betaRow.locator('span[title*="thinking"]')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('sidebar shows thinking badge for project with thinking sessions', async () => {
    // Override activity so Session A is thinking (not idle)
    const preConfig = twoProjectPreConfig() + `
      window.__mockPreConfigure(function (state) {
        state.activityCache['${SESSION_A_ID}'] = 'thinking';
      });
    `;
    const { browser, page } = await launchWithState(preConfig);

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Project Alpha should show thinking badge, no idle badge
      const alphaRow = page.locator('[role="button"]:has-text("Project Alpha")');
      await expect(alphaRow.locator('span[title*="thinking"]')).toBeVisible();
      await expect(alphaRow.locator('span[title*="thinking"]')).toContainText('1');
      await expect(alphaRow.locator('span[title*="idle"]')).not.toBeVisible();

      // Project Beta still idle -- shows idle mail badge (not a dot)
      const betaRow = page.locator('[role="button"]:has-text("Project Beta")');
      await expect(betaRow.locator('span[title*="idle"]')).toBeVisible();
      await expect(betaRow.locator('span[title*="idle"]')).toContainText('1');
      await expect(betaRow.locator('span[title*="thinking"]')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('sidebar shows no badge for project with no running sessions', async () => {
    // Add a third project with no sessions
    const preConfig = twoProjectPreConfig() + `
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();
        state.projects.push({
          id: 'proj-scope-c',
          name: 'Project Gamma',
          path: '/mock/project-gamma',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });
      });
    `;
    const { browser, page } = await launchWithState(preConfig);

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Project Gamma has no sessions -- no badges or dots at all
      const gammaRow = page.locator('[role="button"]:has-text("Project Gamma")');
      await expect(gammaRow).toBeVisible();
      await expect(gammaRow.locator('span[title*="thinking"]')).not.toBeVisible();
      await expect(gammaRow.locator('span[title*="idle"]')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('sidebar shows both idle and thinking badges when project has mixed sessions', async () => {
    // Add a second session to Project A (thinking) while first stays idle
    const preConfig = twoProjectPreConfig() + `
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();
        state.sessions.push({
          id: 'sess-scope-a2',
          taskId: 'task-scope-a2',
          projectId: '${PROJECT_A_ID}',
          pid: 1003,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/project-alpha',
          startedAt: ts,
          exitCode: null,
        });
        state.activityCache['sess-scope-a2'] = 'thinking';
        state.tasks.push({
          id: 'task-scope-a2',
          title: 'Alpha Task 2',
          description: '',
          swimlane_id: 'lane-scope-0',
          position: 2,
          agent: null,
          session_id: 'sess-scope-a2',
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });
      });
    `;
    const { browser, page } = await launchWithState(preConfig);

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Project Alpha should show both idle and thinking badges side by side
      const alphaRow = page.locator('[role="button"]:has-text("Project Alpha")');
      const thinkingBadge = alphaRow.locator('span[title*="thinking"]');
      const idleBadge = alphaRow.locator('span[title*="idle"]');

      await expect(thinkingBadge).toBeVisible();
      await expect(thinkingBadge).toContainText('1');
      await expect(idleBadge).toBeVisible();
      await expect(idleBadge).toContainText('1');
    } finally {
      await browser.close();
    }
  });

  test('sessions persist across project switch and reappear when switching back', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Project A -- alpha-task visible
      await expect(page.locator('button:has-text("alpha-task")')).toBeVisible();

      // Switch to Project B
      await page.locator('[role="button"]:has-text("Project Beta")').click();
      await page.waitForTimeout(500);
      await expect(page.locator('button:has-text("beta-task")')).toBeVisible();
      await expect(page.locator('button:has-text("alpha-task")')).not.toBeVisible();

      // Switch back to Project A
      await page.locator('[role="button"]:has-text("Project Alpha")').click();
      await page.waitForTimeout(500);

      // Alpha session reappears -- it was not cleared
      await expect(page.locator('button:has-text("alpha-task")')).toBeVisible();
      await expect(page.locator('button:has-text("beta-task")')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
