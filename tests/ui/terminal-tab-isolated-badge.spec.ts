/**
 * UI tests for the "Isolated" badge on TerminalPanel session tabs.
 *
 * Feature intent (per-column session isolation):
 *   Each session tab in the terminal panel's tab bar shows a text-only
 *   "Isolated" badge (data-testid="terminal-tab-isolated-badge") when the
 *   session's isolatedSwimlaneId is non-null. Tabs whose session has
 *   isolatedSwimlaneId=null (the main track) show NO badge.
 *
 * The badge is the user-visible indicator that the bottom panel is showing a
 * separate, context-isolated session for a specific column rather than the
 * task's main conversation.
 *
 * Test approach: inject pre-configured sessions directly into the mock's
 * session store via __mockPreConfigure (the same pattern used by
 * session-pause-move.spec.ts and command-terminal.spec.ts). The terminal
 * panel renders once a project and at least one running session are present.
 */

import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-isolated-badge-test';
const MAIN_SESSION_ID = 'sess-main-badge-test';
const ISOLATED_SESSION_ID = 'sess-iso-badge-test';
const TASK_MAIN_ID = 'task-main-badge';
const TASK_ISO_ID = 'task-iso-badge';

// ---------------------------------------------------------------------------
// Launch helper
// ---------------------------------------------------------------------------

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * Build a pre-configure script that creates a project with:
 *   - One running session whose isolatedSwimlaneId is null (main track).
 *   - One running session whose isolatedSwimlaneId is 'lane-review' (isolated).
 * Both sessions are tied to tasks in the Executing column so auto_spawn fires.
 */
function buildTwoSessionPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Isolated Badge Test Project',
        path: '/mock/isolated-badge-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // Minimal swimlanes so the board renders.
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-badge-' + i,
          position: i,
          created_at: ts,
        }));
      });

      // Task for the main session.
      state.tasks.push({
        id: '${TASK_MAIN_ID}',
        display_id: 1,
        title: 'main-track-task',
        description: '',
        swimlane_id: 'lane-badge-0',
        position: 0,
        agent: 'claude',
        agent_override: null,
        model_override: null,
        effort_override: null,
        session_id: '${MAIN_SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: null,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Task for the isolated session.
      state.tasks.push({
        id: '${TASK_ISO_ID}',
        display_id: 2,
        title: 'isolated-track-task',
        description: '',
        swimlane_id: 'lane-badge-0',
        position: 1,
        agent: 'claude',
        agent_override: null,
        model_override: null,
        effort_override: null,
        session_id: '${ISOLATED_SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: null,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Main-track session: isolatedSwimlaneId is null.
      state.sessions.push({
        id: '${MAIN_SESSION_ID}',
        taskId: '${TASK_MAIN_ID}',
        projectId: '${PROJECT_ID}',
        pid: 3001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/isolated-badge-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        isolatedSwimlaneId: null,
      });

      // Isolated-track session: isolatedSwimlaneId is the swimlane id.
      state.sessions.push({
        id: '${ISOLATED_SESSION_ID}',
        taskId: '${TASK_ISO_ID}',
        projectId: '${PROJECT_ID}',
        pid: 3002,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/isolated-badge-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        isolatedSwimlaneId: 'lane-review-isolated',
      });

      // Mark both sessions as idle so the terminal panel renders them.
      state.activityCache['${MAIN_SESSION_ID}'] = 'idle';
      state.activityCache['${ISOLATED_SESSION_ID}'] = 'idle';

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/**
 * Build a pre-configure script that creates a project with a single
 * running session whose isolatedSwimlaneId is null.
 */
function buildMainOnlyPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}-main-only',
        name: 'Main Only Badge Test',
        path: '/mock/main-only-badge-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-monly-' + i,
          position: i,
          created_at: ts,
        }));
      });

      state.tasks.push({
        id: '${TASK_MAIN_ID}-main-only',
        display_id: 1,
        title: 'main-only-task',
        description: '',
        swimlane_id: 'lane-monly-0',
        position: 0,
        agent: 'claude',
        agent_override: null,
        model_override: null,
        effort_override: null,
        session_id: '${MAIN_SESSION_ID}-main-only',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: null,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      state.sessions.push({
        id: '${MAIN_SESSION_ID}-main-only',
        taskId: '${TASK_MAIN_ID}-main-only',
        projectId: '${PROJECT_ID}-main-only',
        pid: 4001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/main-only-badge-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        isolatedSwimlaneId: null,
      });

      state.activityCache['${MAIN_SESSION_ID}-main-only'] = 'idle';

      return { currentProjectId: '${PROJECT_ID}-main-only' };
    });
  `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('TerminalPanel: isolated session badge', () => {
  test('isolated session tab renders the isolated badge', async () => {
    // A session with isolatedSwimlaneId != null must show the badge.
    // The badge is the user's signal that this tab is a separate, context-
    // isolated session for a specific column, not the main conversation.
    const { browser, page } = await launchWithState(buildTwoSessionPreConfig());
    try {
      // Wait for the board to render before asserting on the terminal panel.
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // The terminal tab strip should contain the isolated badge.
      const isolatedBadge = page.locator('[data-testid="terminal-tab-isolated-badge"]');
      await expect(isolatedBadge).toBeVisible({ timeout: 5000 });
      await expect(isolatedBadge).toContainText('Isolated');
    } finally {
      await browser.close();
    }
  });

  test('main-track session tab does NOT render the isolated badge', async () => {
    // A session with isolatedSwimlaneId=null must NOT show the badge.
    // The absence of the badge communicates "main session" to the user.
    const { browser, page } = await launchWithState(buildMainOnlyPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Intentional fixed wait - we cannot poll for non-occurrence.
      // 1000ms is enough for any async render to complete if a badge were shown.
      await page.waitForTimeout(1000);

      const isolatedBadge = page.locator('[data-testid="terminal-tab-isolated-badge"]');
      await expect(isolatedBadge).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('exactly one isolated badge when two sessions, one isolated and one main', async () => {
    // When both track types are present, only the isolated session gets the badge.
    // The count is 1 - not 0 (badge present), not 2 (no false positives on the
    // main-track tab).
    const { browser, page } = await launchWithState(buildTwoSessionPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const isolatedBadges = page.locator('[data-testid="terminal-tab-isolated-badge"]');
      await expect(isolatedBadges).toHaveCount(1, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
