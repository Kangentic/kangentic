/**
 * UI tests for the warm project-switch cache.
 *
 * Acceptance criteria for the perf(project-switch) change:
 *  - Round-tripping A -> B -> A within the same process lifetime fires
 *    zero board / backlog / config / sessions IPC traffic on the second
 *    visit to A. All slices restore from the in-memory snapshot.
 *  - Per-project view state survives the round-trip: detailTaskId set
 *    in A is restored when the user returns to A, and the dialog
 *    re-renders bound to the live session (no Resume button).
 *
 * The first switch to a project (cold) is allowed to fire the normal
 * fan-out. Only the warm re-entry must be zero-IPC.
 *
 * Coverage gap before this spec: project-session-scope.spec.ts asserts
 * that the sidebar / status bar update on switch, but never asserts
 * IPC traffic counts or detail-dialog persistence. Both of those are
 * the user-visible signatures of the cache layer landing correctly.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'proj-warm-a';
const PROJECT_B_ID = 'proj-warm-b';
const SESSION_A_ID = 'sess-warm-a';
const SESSION_B_ID = 'sess-warm-b';
const TASK_A_ID = 'task-warm-a';
const TASK_B_ID = 'task-warm-b';

/**
 * Two projects, each with one running session. Project A starts active.
 * Kept separate from twoProjectPreConfig in project-session-scope.spec.ts
 * because that fixture is in a different test file's closure; duplicating
 * here keeps the spec self-contained.
 */
const PRE_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_A_ID}',
      name: 'Project Alpha',
      path: '/mock/project-alpha',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.projects.push({
      id: '${PROJECT_B_ID}',
      name: 'Project Beta',
      path: '/mock/project-beta',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, {
        id: 'lane-warm-' + i,
        position: i,
        created_at: ts,
      }));
    });

    state.sessions.push({
      id: '${SESSION_A_ID}',
      taskId: '${TASK_A_ID}',
      projectId: '${PROJECT_A_ID}',
      pid: 2001,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/project-alpha',
      startedAt: ts,
      exitCode: null,
    });
    state.sessions.push({
      id: '${SESSION_B_ID}',
      taskId: '${TASK_B_ID}',
      projectId: '${PROJECT_B_ID}',
      pid: 2002,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/project-beta',
      startedAt: ts,
      exitCode: null,
    });

    state.activityCache['${SESSION_A_ID}'] = 'idle';
    state.activityCache['${SESSION_B_ID}'] = 'idle';

    state.tasks.push({
      id: '${TASK_A_ID}',
      projectId: '${PROJECT_A_ID}',
      title: 'Alpha Task',
      description: '',
      swimlane_id: 'lane-warm-0',
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
      projectId: '${PROJECT_B_ID}',
      title: 'Beta Task',
      description: '',
      swimlane_id: 'lane-warm-0',
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
`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRE_CONFIG);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

test.describe('Project switch warm cache', () => {
  test('A -> B -> A round-trip does zero board/backlog/config IPC on return', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Visit Beta once to warm its cache too, then return to Alpha so
      // both projects are seen and Alpha is the most recent. After this
      // priming, every further switch should be a warm hit.
      await page.locator('[role="button"]:has-text("Project Beta")').click();
      await expect(page.locator('button:has-text("beta-task")')).toBeVisible({ timeout: 3000 });

      await page.locator('[role="button"]:has-text("Project Alpha")').click();
      await expect(page.locator('button:has-text("alpha-task")')).toBeVisible({ timeout: 3000 });

      // Reset counter AFTER both projects have been warmed. From here
      // onward, switching should not refetch anything the cache covers.
      await page.evaluate(() => (window as unknown as { __resetIpcCallCounts: () => void }).__resetIpcCallCounts());

      await page.locator('[role="button"]:has-text("Project Beta")').click();
      await expect(page.locator('button:has-text("beta-task")')).toBeVisible({ timeout: 3000 });

      await page.locator('[role="button"]:has-text("Project Alpha")').click();
      await expect(page.locator('button:has-text("alpha-task")')).toBeVisible({ timeout: 3000 });

      // Drain microtasks so any IPC dispatched from child useEffects
      // that mount after the visible-element assertion (TerminalPanel
      // re-render, dialog mount/unmount) is captured in the counter
      // before we read it. The warm path itself has no deferred work,
      // but downstream effects do trigger their own incremental fetches.
      await page.waitForTimeout(250);

      const counts = await page.evaluate(() =>
        (window as unknown as { __getIpcCallCounts: () => Record<string, number> }).__getIpcCallCounts(),
      );

      // Board, backlog, and config slices should be pure cache hits.
      expect(counts['tasks.list'] ?? 0).toBe(0);
      expect(counts['tasks.listArchived'] ?? 0).toBe(0);
      expect(counts['swimlanes.list'] ?? 0).toBe(0);
      expect(counts['backlog.list'] ?? 0).toBe(0);
      expect(counts['config.get'] ?? 0).toBe(0);
      expect(counts['config.getGlobal'] ?? 0).toBe(0);

      // syncSessions is also skipped on warm switch. The in-memory
      // sessions list and activity cache are kept fresh by incremental
      // pushes, so a warm round-trip should not refetch them either.
      expect(counts['sessions.list'] ?? 0).toBe(0);
      expect(counts['sessions.getUsage'] ?? 0).toBe(0);
      expect(counts['sessions.getActivity'] ?? 0).toBe(0);
      expect(counts['sessions.getActivityReasons'] ?? 0).toBe(0);
      expect(counts['sessions.getEventsCache'] ?? 0).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('detail dialog open in A survives a switch to B and back', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Open the detail dialog for Alpha Task. Cards expose a stable
      // `data-task-id` attribute, which is safer than matching on
      // title text (title text has no unique guarantees across layouts).
      const card = page.locator(`[data-task-id="${TASK_A_ID}"]`).first();
      await card.waitFor({ state: 'visible', timeout: 5000 });
      await card.click();

      // Detail dialog is rooted by data-testid in TaskDetailDialog.
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // Switch projects via the programmatic auto-open path. We can't use
      // a sidebar click here because the dialog's fullscreen backdrop
      // intercepts clicks (and would fire onClose, wiping detailTaskId
      // before the switch even runs). In practice this path is exercised
      // by notification clicks (App.tsx sessions.onActivity handler) and
      // by the --cwd CLI auto-open, both of which set currentProject
      // directly without dismissing an open dialog.
      await page.evaluate((id) => {
        (window as unknown as { __mockFireProjectAutoOpened: (id: string) => void })
          .__mockFireProjectAutoOpened(id);
      }, PROJECT_B_ID);

      // Beta is now current. Alpha's dialog must be unmounted: the
      // detailTaskId selector reads from the current project's slice,
      // and Beta's snapshot has no open dialog.
      await expect(page.locator('button:has-text("beta-task")')).toBeVisible({ timeout: 3000 });
      await expect(dialog).not.toBeVisible({ timeout: 3000 });

      // Return to Alpha via the same path. The cached snapshot includes
      // the open dialog, so it must come back without any user action.
      await page.evaluate((id) => {
        (window as unknown as { __mockFireProjectAutoOpened: (id: string) => void })
          .__mockFireProjectAutoOpened(id);
      }, PROJECT_A_ID);

      await expect(dialog).toBeVisible({ timeout: 3000 });

      // The dialog should be bound to the still-running session, not
      // showing a Resume button. (The Resume button only renders when
      // the session is suspended, and our mock keeps it running across
      // the switch.) The button is labeled "Resume session" in
      // TaskDetailBody.tsx; assert no such button exists inside the dialog.
      await expect(dialog.locator('button:has-text("Resume session")')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
