/**
 * UI tests for the task-detail "View conversation" affordance's disabled state
 * (header pill + kebab item). A task with no session (live or historical) has
 * nothing for the button to open, so it renders muted/disabled instead of
 * clicking through to an empty viewer or a "no history" toast.
 *
 * Cross-platform: no pixel assertions, no bare waitForTimeout - every check
 * polls for a condition (data attribute / testid / text).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-conv-disabled';
const NO_HISTORY_TASK_ID = 'task-conv-disabled-none';
const HAS_HISTORY_TASK_ID = 'task-conv-disabled-history';
const HISTORICAL_SESSION_ID = 'sess-conv-disabled-historical';

const preConfigScript = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}', name: 'Conversation Disabled State', path: '/mock/conv-disabled',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-conv-disabled-' + index;
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
    });

    function pushTask(id, title, position) {
      state.tasks.push({
        id: id, title: title, description: '',
        swimlane_id: laneIds['Code Review'], position: position, agent: null, session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });
    }

    // No live session AND no transcriptSessionsByTask entry: nothing to view.
    pushTask('${NO_HISTORY_TASK_ID}', 'No history task', 0);

    // No live session, but a past (exited) session exists in the index.
    pushTask('${HAS_HISTORY_TASK_ID}', 'Has history task', 1);

    var transcriptSessionsByTask = {};
    transcriptSessionsByTask['${HAS_HISTORY_TASK_ID}'] = [
      { sessionId: '${HISTORICAL_SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' },
    ];

    return {
      currentProjectId: '${PROJECT_ID}',
      transcriptSessionsByTask: transcriptSessionsByTask,
    };
  });
`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page };
}

/**
 * Open the task-detail window directly via the store instead of clicking the
 * card. A card click auto-opens edit mode for a task with no session at all
 * (TaskCard's `initialEdit` heuristic) - a separate concern from what this
 * spec tests, so drive `setDetailTaskId` directly (its default `initialEdit`
 * is false) to reach the normal header regardless of session state.
 */
async function openTaskDetail(page: Page, taskId: string) {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setDetailTaskId: (taskId: string) => void } } };
    }).__zustandStores;
    stores?.session.getState().setDetailTaskId(id);
  }, taskId);
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('Conversation pill disabled state', () => {
  test('a task with no session (live or historical) shows the pill and kebab item disabled', async () => {
    const { browser, page } = await launch();
    try {
      await openTaskDetail(page, NO_HISTORY_TASK_ID);

      const pill = page.getByTestId('conversation-pill');
      await expect(pill).toBeVisible();
      await expect(pill).toBeDisabled();
      await expect(pill).toHaveAttribute('title', 'No conversation history for this task yet');

      await page.locator('[data-testid="task-detail-dialog"] [title="Actions"]').click();
      const kebabItem = page.getByTestId('view-conversation-btn');
      await expect(kebabItem).toBeVisible();
      await expect(kebabItem).toBeDisabled();
    } finally {
      await browser.close();
    }
  });

  test('a task with historical session history enables the pill once the check resolves', async () => {
    const { browser, page } = await launch();
    try {
      await openTaskDetail(page, HAS_HISTORY_TASK_ID);

      const pill = page.getByTestId('conversation-pill');
      await expect(pill).toBeVisible();
      await expect(pill).toBeEnabled();
      await expect(pill).toHaveAttribute('title', 'View conversation');
    } finally {
      await browser.close();
    }
  });
});
