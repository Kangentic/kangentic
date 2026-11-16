/**
 * UI tests for the task-detail "View conversation" affordance's disabled state
 * (header pill + kebab item). A task with no session (live or historical) has
 * nothing for the button to open, so it renders muted/disabled instead of
 * clicking through to an empty viewer or a "no history" toast. A paused row
 * with no session record behind it (the placeholder recovery registers at
 * launch, GitHub #822) is not history either, so it leaves the pill disabled.
 *
 * Cross-platform: no pixel assertions, no bare waitForTimeout - every check
 * polls for a condition (data attribute / testid / text).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-conv-disabled';
const NO_HISTORY_TASK_ID = 'task-conv-disabled-none';
const HAS_HISTORY_TASK_ID = 'task-conv-disabled-history';
const HISTORICAL_SESSION_ID = 'sess-conv-disabled-historical';
const PLACEHOLDER_TASK_ID = 'task-conv-disabled-placeholder';
const PLACEHOLDER_SESSION_ID = 'sess-conv-disabled-placeholder';
const RUNNING_TASK_ID = 'task-conv-disabled-running';
const RUNNING_SESSION_ID = 'sess-conv-disabled-running';
const SUSPENDED_RECORD_TASK_ID = 'task-conv-disabled-suspended-record';
const SUSPENDED_RECORD_SESSION_ID = 'sess-conv-disabled-suspended-record';

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

    // A suspended registry row with no session record behind it: the
    // placeholder recovery registers for a paused task at launch, here for a
    // first start that was refused, so the task has no history (GitHub #822).
    pushTask('${PLACEHOLDER_TASK_ID}', 'Paused placeholder task', 2);
    state.sessions.push({
      id: '${PLACEHOLDER_SESSION_ID}', taskId: '${PLACEHOLDER_TASK_ID}', projectId: '${PROJECT_ID}',
      pid: null, status: 'suspended', shell: '', cwd: '/mock/conv-disabled',
      startedAt: ts, exitCode: null, resuming: false,
    });

    // A running session whose id has no entry in the transcript listing: a live
    // session is proof enough, the listing is not consulted.
    pushTask('${RUNNING_TASK_ID}', 'Running session task', 3);
    state.sessions.push({
      id: '${RUNNING_SESSION_ID}', taskId: '${RUNNING_TASK_ID}', projectId: '${PROJECT_ID}',
      pid: 4242, status: 'running', shell: 'bash', cwd: '/mock/conv-disabled',
      startedAt: ts, exitCode: null, resuming: false,
    });

    // A suspended row that IS a real record: the listing holds it, so the
    // pill enables once the check resolves.
    pushTask('${SUSPENDED_RECORD_TASK_ID}', 'Suspended with record task', 4);
    state.sessions.push({
      id: '${SUSPENDED_RECORD_SESSION_ID}', taskId: '${SUSPENDED_RECORD_TASK_ID}', projectId: '${PROJECT_ID}',
      pid: null, status: 'suspended', shell: '', cwd: '/mock/conv-disabled',
      startedAt: ts, exitCode: null, resuming: false,
    });

    var transcriptSessionsByTask = {};
    transcriptSessionsByTask['${HAS_HISTORY_TASK_ID}'] = [
      { sessionId: '${HISTORICAL_SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' },
    ];
    transcriptSessionsByTask['${SUSPENDED_RECORD_TASK_ID}'] = [
      { sessionId: '${SUSPENDED_RECORD_SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'exited' },
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
  await gotoVite(page, VITE_URL);
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
      await expect(pill).toHaveAccessibleName('View conversation');
      await expect(pill).toHaveAccessibleDescription('No conversation history for this task yet');

      await page.locator('[data-testid="task-detail-dialog"] [aria-label="Actions"]').click();
      const kebabItem = page.getByTestId('view-conversation-btn');
      await expect(kebabItem).toBeVisible();
      await expect(kebabItem).toBeDisabled();
    } finally {
      await browser.close();
    }
  });

  test('a paused row with no session record behind it does not enable the pill', async () => {
    const { browser, page } = await launch();
    try {
      await openTaskDetail(page, PLACEHOLDER_TASK_ID);

      const pill = page.getByTestId('conversation-pill');
      await expect(pill).toBeVisible();
      await expect(pill).toBeDisabled();
    } finally {
      await browser.close();
    }
  });

  test('a running session enables the pill without any entry in the transcript listing', async () => {
    const { browser, page } = await launch();
    try {
      await openTaskDetail(page, RUNNING_TASK_ID);

      const pill = page.getByTestId('conversation-pill');
      await expect(pill).toBeVisible();
      await expect(pill).toBeEnabled();
    } finally {
      await browser.close();
    }
  });

  test('a suspended row that has a session record enables the pill once the listing resolves', async () => {
    const { browser, page } = await launch();
    try {
      await openTaskDetail(page, SUSPENDED_RECORD_TASK_ID);

      const pill = page.getByTestId('conversation-pill');
      await expect(pill).toBeVisible();
      await expect(pill).toBeEnabled();
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
      await expect(pill).toHaveAccessibleName('View conversation');
      await expect(pill).toHaveAccessibleDescription('');
    } finally {
      await browser.close();
    }
  });
});
