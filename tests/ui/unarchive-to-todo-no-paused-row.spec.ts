/**
 * Regression test for "a task restored from Done to To Do shows Paused".
 *
 * Mechanism:
 *   - Moving a task INTO Done deliberately suspends rather than destroys its
 *     session, so unarchiving into an auto-spawn column can `--resume` it.
 *     `SessionManager.suspend` mutates `status` in the registry and never
 *     deletes the entry, and `listSessions()` has no status filter, so
 *     SESSION_LIST keeps returning it.
 *   - Dragging OUT of Done routes to `unarchiveTask` / TASK_UNARCHIVE, not
 *     `moveTask` - so `task-slice`'s `role === 'todo'` session eviction never
 *     ran, and the handler early-returned for a non-auto-spawn lane without
 *     touching the session.
 *   - `TaskCard` resolves its session through `_sessionByTaskId`, NOT
 *     `task.session_id`, so nulling the task pointer does not hide it either.
 *   - `getTaskProgress` takes no task, lane, or archive input: a session with
 *     `status: 'suspended'` yields `{ kind: 'suspended' }` unconditionally, and
 *     TaskCard renders that as a "Paused" row.
 *
 * The card is invisible while in Done only because DoneSwimlane renders
 * archived cards `compact`, whose early-return skips the status switch. The row
 * appears the instant the task lands in To Do as a full card.
 *
 * A task sitting in To Do has not started and must show no status row at all -
 * which is already what a restart shows, because startup recovery refuses to
 * give a non-auto-spawn task a suspended placeholder.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-unarchive-paused';
const TASK_ID = 'task-unarchive-paused-probe';
// Deliberately does NOT contain the word this spec asserts against, or the
// title itself would satisfy the `toContainText('Paused')` check.
const TASK_TITLE = 'Unarchive Restore Probe';
const SESSION_ID = 'session-unarchive-paused';
const TODO_LANE_ID = 'lane-to-do';

interface BoardWindow {
  __zustandStores: {
    board: { getState: () => { unarchiveTask: (input: { id: string; targetSwimlaneId: string }) => Promise<void> } };
    session: { getState: () => { sessions: Array<{ id: string; taskId: string; status: string }> } };
  };
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Unarchive Paused Test',
        path: '/mock/unarchive-paused-test',
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
      // Archived (in Done), exactly as a completed task looks: the worktree was
      // deleted on the way in, session_id was nulled, but the session record
      // survives as 'suspended' so a restore into an auto-spawn column can
      // resume it.
      state.archivedTasks.push({
        id: '${TASK_ID}',
        title: '${TASK_TITLE}',
        description: 'Completed, then restored to To Do',
        swimlane_id: 'lane-done',
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: 'feature/unarchive-paused',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: ts,
        created_at: ts,
        updated_at: ts,
      });
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 4242,
        status: 'suspended',
        shell: 'bash',
        cwd: '/mock/unarchive-paused-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        agentSessionId: 'agent-session-unarchive-paused',
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

test.describe('Restore from Done to To Do - no stale Paused row', () => {
  test('a task restored into To Do drops its suspended session and shows no status row', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Precondition: the suspended session really is in the renderer store, so
      // a green result cannot come from the fixture simply never being wired up.
      await expect.poll(async () => page.evaluate((taskId) => {
        const state = (window as unknown as BoardWindow).__zustandStores.session.getState();
        return state.sessions.some((session) => session.taskId === taskId && session.status === 'suspended');
      }, TASK_ID), { timeout: 5000 }).toBe(true);

      // Restore into To Do, the same store action every restore path funnels
      // through (drag out of Done, card context menu, Completed dialog, task
      // detail action).
      await page.evaluate((args: { id: string; targetSwimlaneId: string }) => {
        return (window as unknown as BoardWindow).__zustandStores.board.getState().unarchiveTask(args);
      }, { id: TASK_ID, targetSwimlaneId: TODO_LANE_ID });

      const restoredCard = page.locator('[data-swimlane-name="To Do"]').locator(`[data-task-id="${TASK_ID}"]`);
      await expect(restoredCard).toBeVisible({ timeout: 5000 });

      // The actual bug: a "Paused" status row on a task that has not started.
      await expect(restoredCard).not.toContainText('Paused');
      await expect(restoredCard.locator('[data-testid="status-bar"]')).toHaveCount(0);
      await expect(restoredCard.locator('[data-testid="usage-bar"]')).toHaveCount(0);

      // ...because the session was dropped, not because the row was hidden.
      // Asserting the state as well as the pixels keeps a future "just don't
      // render it" patch from passing while the orphan session lingers and
      // resurfaces through some other consumer.
      await expect.poll(async () => page.evaluate((taskId) => {
        const state = (window as unknown as BoardWindow).__zustandStores.session.getState();
        return state.sessions.filter((session) => session.taskId === taskId).length;
      }, TASK_ID), { timeout: 3000 }).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
