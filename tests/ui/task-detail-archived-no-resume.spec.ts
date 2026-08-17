/**
 * A completed task in Done offers no Resume control.
 *
 * Moving a task to Done archives it, suspends its session, and deletes its
 * worktree. The task detail nevertheless kept offering Resume, and clicking it
 * recreated that worktree and spawned a live `--resume` agent on a task with no
 * board card: real quota burn with nothing on the board to notice it. Main now
 * refuses the resume outright (see tests/unit/session-resume-guard.test.ts), so
 * the three renderer surfaces must stop offering a control that throws:
 *
 *   1. the header Play button (TaskDetailHeader),
 *   2. the "Resume session" kebab item (TaskDetailKebabItems),
 *   3. the big centered Play button (TaskDetailBody).
 *
 * A suspended task in an ordinary column is checked in the same run as the
 * control group, so a green result cannot come from a fixture that never
 * rendered a toggle anywhere.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-archived-no-resume';

const ARCHIVED_TASK_ID = 'task-archived-no-resume';
const ARCHIVED_TASK_TITLE = 'Completed Release Probe';
const ARCHIVED_SESSION_ID = 'session-archived-no-resume';

const LIVE_TASK_ID = 'task-suspended-control';
const LIVE_TASK_TITLE = 'Suspended Control Probe';
const LIVE_SESSION_ID = 'session-suspended-control';

interface StoreWindow {
  __zustandStores: {
    session: {
      getState: () => {
        setDetailTaskId: (id: string) => void;
        sessions: Array<{ id: string; taskId: string; status: string }>;
      };
    };
    window: { getState: () => { windows: Record<string, { id: string; anchor: string }> } };
  };
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Archived No Resume Test',
        path: '/mock/archived-no-resume-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-'),
          position: i,
          created_at: ts,
        }));
      });
      function makeTask(overrides) {
        return Object.assign({
          description: 'Fixture task',
          position: 0,
          agent: 'claude',
          session_id: null,
          worktree_path: null,
          branch_name: 'feature/archived-no-resume',
          pr_number: null,
          pr_url: null,
          base_branch: 'main',
          use_worktree: 1,
          labels: [],
          priority: 0,
          attachment_count: 0,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        }, overrides);
      }
      function makeSession(overrides) {
        return Object.assign({
          projectId: '${PROJECT_ID}',
          pid: 4242,
          status: 'suspended',
          shell: 'bash',
          cwd: '/mock/archived-no-resume-test',
          startedAt: ts,
          exitCode: null,
          resuming: false,
        }, overrides);
      }
      // Exactly how a completed task looks after the move to Done: archived,
      // worktree deleted, session_id nulled, but the session record preserved
      // as 'suspended' so an unarchive into an auto-spawn column can resume it.
      state.archivedTasks.push(makeTask({
        id: '${ARCHIVED_TASK_ID}',
        title: '${ARCHIVED_TASK_TITLE}',
        swimlane_id: 'lane-done',
        archived_at: ts,
      }));
      state.sessions.push(makeSession({
        id: '${ARCHIVED_SESSION_ID}',
        taskId: '${ARCHIVED_TASK_ID}',
        agentSessionId: 'agent-session-archived',
      }));
      // Control group: same suspended session shape, ordinary column, not
      // archived. This one MUST still offer Resume.
      state.tasks.push(makeTask({
        id: '${LIVE_TASK_ID}',
        title: '${LIVE_TASK_TITLE}',
        swimlane_id: 'lane-executing',
        worktree_path: '/mock/archived-no-resume-test/.kangentic/worktrees/control',
      }));
      state.sessions.push(makeSession({
        id: '${LIVE_SESSION_ID}',
        taskId: '${LIVE_TASK_ID}',
        agentSessionId: 'agent-session-control',
      }));
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/** Open a task-detail window the way CompletedTasksDialog's "View Details" row
 *  action does. An archived task has no board card to click. */
async function openDetailWindow(page: Page, taskId: string): Promise<string> {
  await page.evaluate((detailTaskId) => {
    (window as unknown as StoreWindow).__zustandStores.session.getState().setDetailTaskId(detailTaskId);
  }, taskId);

  let resolvedWindowId: string | null = null;
  await expect.poll(async () => {
    resolvedWindowId = await page.evaluate((anchorId) => {
      const windows = (window as unknown as StoreWindow).__zustandStores.window.getState().windows;
      return Object.values(windows).find((candidate) => candidate.anchor === anchorId)?.id ?? null;
    }, taskId);
    return resolvedWindowId;
  }, { timeout: 5000 }).not.toBeNull();
  return resolvedWindowId as string;
}

/** The kebab popover is portaled to document.body, so its items are located on
 *  the page, not inside the window frame. */
async function openKebab(page: Page, windowId: string): Promise<void> {
  await page.locator(`[data-testid="window-frame-${windowId}"] button[title="Actions"]`).click();
  // The menu really opened: an item that is rendered unconditionally, so an
  // absent toggle below cannot just be a menu that never appeared.
  await expect(page.locator('[data-testid="view-conversation-btn"]')).toBeVisible({ timeout: 5000 });
}

/** Close via the trigger, not Escape or an outside click: KebabMenu dismisses on
 *  outside mousedown only, and an outside click would also light-dismiss the
 *  window. Leaving a menu open would put two portaled copies on the page. */
async function closeKebab(page: Page, windowId: string): Promise<void> {
  await page.locator(`[data-testid="window-frame-${windowId}"] button[title="Actions"]`).click();
  await expect(page.locator('[data-testid="view-conversation-btn"]')).toHaveCount(0);
}

test.describe('Task detail for an archived Done task', () => {
  test('offers no pause/resume toggle, while a suspended task in an ordinary column still does', async () => {
    const { browser, page } = await launch();
    const getPageErrors = collectPageErrors(page);

    try {
      // Precondition: both suspended sessions really are in the renderer store,
      // so an absent toggle cannot be an unwired fixture.
      await expect.poll(async () => page.evaluate(() => {
        const sessions = (window as unknown as StoreWindow).__zustandStores.session.getState().sessions;
        return sessions.filter((session) => session.status === 'suspended').length;
      }), { timeout: 5000 }).toBe(2);

      // --- The archived task in Done: no resume surface anywhere ---
      const archivedWindowId = await openDetailWindow(page, ARCHIVED_TASK_ID);
      const archivedFrame = page.locator(`[data-testid="window-frame-${archivedWindowId}"]`);
      await archivedFrame.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      await expect(archivedFrame.locator('[data-testid="task-title-text"]')).toHaveText(ARCHIVED_TASK_TITLE);

      await expect(archivedFrame.locator('[data-testid="header-toggle-session-btn"]')).toHaveCount(0);
      await expect(archivedFrame.locator('button:has-text("Resume session")')).toHaveCount(0);

      await openKebab(page, archivedWindowId);
      await expect(page.locator('[data-testid="toggle-session-btn"]')).toHaveCount(0);
      await closeKebab(page, archivedWindowId);

      // --- Control: a suspended task in an ordinary column keeps its toggle ---
      const liveWindowId = await openDetailWindow(page, LIVE_TASK_ID);
      const liveFrame = page.locator(`[data-testid="window-frame-${liveWindowId}"]`);
      await liveFrame.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      await expect(liveFrame.locator('[data-testid="task-title-text"]')).toHaveText(LIVE_TASK_TITLE);

      await expect(liveFrame.locator('[data-testid="header-toggle-session-btn"]')).toBeVisible();
      await expect(liveFrame.locator('button:has-text("Resume session")')).toBeVisible();

      await openKebab(page, liveWindowId);
      await expect(page.locator('[data-testid="toggle-session-btn"]')).toHaveCount(1);
      await closeKebab(page, liveWindowId);

      expect(getPageErrors()).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });
});
