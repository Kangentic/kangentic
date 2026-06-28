/**
 * UI tests for per-task detail-view layout persistence (Part A of the
 * persist-per-task-state work).
 *
 * Covers the two halves of the feature end to end through the headless mock:
 *  - HYDRATE: a task whose `detail_view_state` blob says the Changes panel was
 *    open restores that layout on open, with no user interaction.
 *  - PERSIST: toggling the Changes panel debounce-saves the blob through the
 *    task-scoped `setDetailViewState` IPC, carrying the interaction-time
 *    projectId (project-scoped-ipc rule).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-view-state';
const TASK_ID = 'task-view-state';
const SESSION_ID = 'sess-view-state';

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

/** A running-session task in Code Review, with an optional detail_view_state blob. */
function preConfig(detailViewState: string | null): string {
  return `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'View State Test', path: '/mock/view-state-test',
        github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: timestamp }));
      });
      state.sessions.push({
        id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999,
        status: 'running', shell: 'bash', cwd: '/mock/view-state-test', startedAt: timestamp, exitCode: null,
      });
      state.tasks.push({
        id: '${TASK_ID}', title: 'View State Task', description: 'Task for view-state persistence',
        swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
        worktree_path: '/mock/worktrees/view-state', branch_name: 'feature/view-state',
        pr_number: null, pr_url: null, base_branch: 'main', archived_at: null,
        detail_view_state: ${detailViewState === null ? 'null' : JSON.stringify(detailViewState)},
        created_at: timestamp, updated_at: timestamp,
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

test.describe('Task detail view-state persistence', () => {
  test('hydrates an open Changes panel from the persisted blob, with no interaction', async () => {
    const { browser, page } = await launchWithState(preConfig(JSON.stringify({ changesOpen: true })));
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-swimlane-name="Code Review"]').locator('text=View State Task').first().click();

      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // The blob said the Changes panel was open: its split-view "expand" control
      // must be present WITHOUT clicking the Changes pill (hydration restored it).
      await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible({ timeout: 10000 });
    } finally {
      await browser.close();
    }
  });

  test('persists a Changes-panel toggle via setDetailViewState with the stamped projectId', async () => {
    const { browser, page } = await launchWithState(preConfig(null));
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-swimlane-name="Code Review"]').locator('text=View State Task').first().click();

      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // Panel starts closed (no blob). Open it -> schedules a debounced save.
      await page.locator('[data-testid="changes-toggle"]').click();
      await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible({ timeout: 10000 });

      // The debounced save (~500ms) records a setDetailViewState call carrying
      // changesOpen and the interaction-time projectId.
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const calls = (window as unknown as {
                __mockDetailViewStateCalls?: Array<{ taskId: string; state: { changesOpen?: boolean } | null; projectId: string | null }>;
              }).__mockDetailViewStateCalls;
              if (!calls) return null;
              const match = calls.find((call) => call.taskId === 'task-view-state' && call.state?.changesOpen === true);
              return match ? match.projectId : null;
            }),
          { timeout: 5000 },
        )
        .toBe(PROJECT_ID);
    } finally {
      await browser.close();
    }
  });
});
