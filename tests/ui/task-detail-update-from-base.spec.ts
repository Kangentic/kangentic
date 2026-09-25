/**
 * UI test for the task-detail kebab "Update from base" action
 * (TaskDetailKebabItems.handleUpdateFromBase, TaskDetailHeader.tsx).
 *
 * Covers the three renderer-only decisions main cannot exercise:
 *   1. Visibility - the item renders only for a task with a worktree that is
 *      NOT archived; it is absent when either condition fails.
 *   2. Disablement - it is disabled while the task's session is active
 *      (isSessionActive, a superset of the handler's own running/queued
 *      guard), so a paused/suspended task keeps the item enabled.
 *   3. Toast mapping - each of the six TaskUpdateFromBaseResult statuses maps
 *      to its own toast message and tone, composed entirely in the renderer
 *      (main returns only the structured result).
 *
 * Steered via window.__mockUpdateFromBaseResult (tests/ui/mock-electron-api.js);
 * no mock extension needed - the hook already returns any
 * TaskUpdateFromBaseResult shape a test sets.
 *
 * Detail windows are opened by driving the session store's setDetailTaskId
 * directly (not by clicking a board card), mirroring
 * tests/ui/task-detail-archived-no-resume.spec.ts: this is the only way to
 * reach an archived task's window (no board card exists for it), and it
 * sidesteps TaskCard's own initialEdit heuristic - calling setDetailTaskId
 * with no options always opens the header view, never the edit form,
 * regardless of the task's session state.
 *
 * Tier: UI (headless Chromium). No PTY or real git needed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';
import type { TaskUpdateFromBaseResult } from '../../src/shared/types';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-update-from-base-${RUN_ID}`;

const WORKTREE_TASK_ID = `task-worktree-${RUN_ID}`;
const WORKTREE_TASK_TITLE = `Worktree Task ${RUN_ID}`;
const WORKTREE_SESSION_ID = `sess-worktree-${RUN_ID}`;

const RUNNING_TASK_ID = `task-running-${RUN_ID}`;
const RUNNING_TASK_TITLE = `Running Task ${RUN_ID}`;
const RUNNING_SESSION_ID = `sess-running-${RUN_ID}`;

const NO_WORKTREE_TASK_ID = `task-no-worktree-${RUN_ID}`;
const NO_WORKTREE_TASK_TITLE = `No Worktree Task ${RUN_ID}`;
const NO_WORKTREE_SESSION_ID = `sess-no-worktree-${RUN_ID}`;

const ARCHIVED_TASK_ID = `task-archived-worktree-${RUN_ID}`;
const ARCHIVED_TASK_TITLE = `Archived Worktree Task ${RUN_ID}`;
const ARCHIVED_SESSION_ID = `sess-archived-worktree-${RUN_ID}`;

interface StoreWindow {
  __zustandStores: {
    session: {
      getState: () => {
        setDetailTaskId: (id: string) => void;
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
        name: 'Update From Base Test ${RUN_ID}',
        path: '/mock/update-from-base-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-update-from-base-' + s.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}',
          position: i,
          created_at: ts,
        }));
      });
      function makeTask(overrides) {
        return Object.assign({
          description: 'Fixture task',
          position: 0,
          agent: 'claude',
          worktree_path: null,
          branch_name: 'feature/update-from-base',
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
          cwd: '/mock/update-from-base-${RUN_ID}',
          startedAt: ts,
          exitCode: null,
          resuming: false,
        }, overrides);
      }

      // Worktree task, session suspended (not active): item should be visible
      // and enabled.
      state.tasks.push(makeTask({
        id: '${WORKTREE_TASK_ID}',
        title: '${WORKTREE_TASK_TITLE}',
        swimlane_id: 'lane-update-from-base-executing-${RUN_ID}',
        session_id: '${WORKTREE_SESSION_ID}',
        worktree_path: '/mock/update-from-base-${RUN_ID}/.kangentic/worktrees/worktree-task',
      }));
      state.sessions.push(makeSession({
        id: '${WORKTREE_SESSION_ID}',
        taskId: '${WORKTREE_TASK_ID}',
      }));

      // Worktree task, session running (active): item should be visible but
      // disabled.
      state.tasks.push(makeTask({
        id: '${RUNNING_TASK_ID}',
        title: '${RUNNING_TASK_TITLE}',
        swimlane_id: 'lane-update-from-base-executing-${RUN_ID}',
        session_id: '${RUNNING_SESSION_ID}',
        worktree_path: '/mock/update-from-base-${RUN_ID}/.kangentic/worktrees/running-task',
      }));
      state.sessions.push(makeSession({
        id: '${RUNNING_SESSION_ID}',
        taskId: '${RUNNING_TASK_ID}',
        status: 'running',
      }));

      // No worktree, session suspended: item should be absent entirely.
      state.tasks.push(makeTask({
        id: '${NO_WORKTREE_TASK_ID}',
        title: '${NO_WORKTREE_TASK_TITLE}',
        swimlane_id: 'lane-update-from-base-executing-${RUN_ID}',
        session_id: '${NO_WORKTREE_SESSION_ID}',
        worktree_path: null,
      }));
      state.sessions.push(makeSession({
        id: '${NO_WORKTREE_SESSION_ID}',
        taskId: '${NO_WORKTREE_TASK_ID}',
      }));

      // Archived, but (unusually) still carrying a worktree_path: pins the
      // !isArchived half of the visibility guard independently of worktree
      // presence. No board card exists for an archived task, so this one is
      // only reachable via setDetailTaskId (see openDetailWindow below).
      state.archivedTasks.push(makeTask({
        id: '${ARCHIVED_TASK_ID}',
        title: '${ARCHIVED_TASK_TITLE}',
        swimlane_id: 'lane-update-from-base-done-${RUN_ID}',
        session_id: '${ARCHIVED_SESSION_ID}',
        worktree_path: '/mock/update-from-base-${RUN_ID}/.kangentic/worktrees/archived-task',
        archived_at: ts,
      }));
      state.sessions.push(makeSession({
        id: '${ARCHIVED_SESSION_ID}',
        taskId: '${ARCHIVED_TASK_ID}',
      }));

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/** Open a task-detail window by driving the store directly, bypassing card
 *  click ambiguity and reaching archived tasks (which have no board card). */
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
  // absent "Update from base" item below cannot just be a menu that never
  // appeared.
  await expect(page.locator('[data-testid="view-conversation-btn"]')).toBeVisible({ timeout: 5000 });
}

async function closeKebab(page: Page, windowId: string): Promise<void> {
  await page.locator(`[data-testid="window-frame-${windowId}"] button[title="Actions"]`).click();
  await expect(page.locator('[data-testid="view-conversation-btn"]')).toHaveCount(0);
}

/** Close the whole detail window (not just its kebab). Each visibility check
 *  opens its own window via setDetailTaskId, so without this every window
 *  from an earlier check stays tiled on screen: the next window's "Actions"
 *  button can then land under a sibling window's resize handle, and the
 *  click times out instead of opening the kebab. */
async function closeDetailWindow(page: Page, windowId: string): Promise<void> {
  await page.locator(`[data-testid="window-frame-${windowId}"] [data-testid="task-detail-close"]`).click();
  await expect(page.locator(`[data-testid="window-frame-${windowId}"]`)).toHaveCount(0, { timeout: 5000 });
}

test.describe('Task detail kebab: Update from base', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launch());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('shows the item only for a non-archived worktree task, disabled while its session is active', async () => {
    // Worktree + suspended session: visible and enabled.
    const worktreeWindowId = await openDetailWindow(page, WORKTREE_TASK_ID);
    await openKebab(page, worktreeWindowId);
    const worktreeItem = page.locator('[data-testid="update-from-base-btn"]');
    await expect(worktreeItem).toBeVisible();
    await expect(worktreeItem).toBeEnabled();
    await closeKebab(page, worktreeWindowId);
    await closeDetailWindow(page, worktreeWindowId);

    // Worktree + running session: visible but disabled.
    const runningWindowId = await openDetailWindow(page, RUNNING_TASK_ID);
    await openKebab(page, runningWindowId);
    const runningItem = page.locator('[data-testid="update-from-base-btn"]');
    await expect(runningItem).toBeVisible();
    await expect(runningItem).toBeDisabled();
    await closeKebab(page, runningWindowId);
    await closeDetailWindow(page, runningWindowId);

    // No worktree: item absent entirely, regardless of session state.
    const noWorktreeWindowId = await openDetailWindow(page, NO_WORKTREE_TASK_ID);
    await openKebab(page, noWorktreeWindowId);
    await expect(page.locator('[data-testid="update-from-base-btn"]')).toHaveCount(0);
    await closeKebab(page, noWorktreeWindowId);
    await closeDetailWindow(page, noWorktreeWindowId);

    // Archived, even with a worktree_path present: item absent.
    const archivedWindowId = await openDetailWindow(page, ARCHIVED_TASK_ID);
    await openKebab(page, archivedWindowId);
    await expect(page.locator('[data-testid="update-from-base-btn"]')).toHaveCount(0);
    await closeKebab(page, archivedWindowId);
    await closeDetailWindow(page, archivedWindowId);
  });

  test('maps each TaskUpdateFromBaseResult status to its own toast', async () => {
    const worktreeWindowId = await openDetailWindow(page, WORKTREE_TASK_ID);

    const cases: Array<{ name: string; result: TaskUpdateFromBaseResult; expectedText: string }> = [
      {
        name: 'updated, plural commit count',
        result: { status: 'updated', baseBranch: 'main', commitCount: 3 },
        expectedText: 'Updated from main: fast-forwarded 3 commits.',
      },
      {
        name: 'updated, singular commit count',
        result: { status: 'updated', baseBranch: 'main', commitCount: 1 },
        expectedText: 'Updated from main: fast-forwarded 1 commit.',
      },
      {
        name: 'already-up-to-date',
        result: { status: 'already-up-to-date', baseBranch: 'main' },
        expectedText: 'Already up to date with main.',
      },
      {
        name: 'cannot-ff',
        result: { status: 'cannot-ff', baseBranch: 'main', ahead: 2, behind: 5 },
        expectedText: 'Cannot fast-forward: this branch has its own commits (2 ahead, 5 behind main). Rebase or merge in the session instead.',
      },
      {
        name: 'dirty-tree',
        result: { status: 'dirty-tree', baseBranch: 'main' },
        expectedText: 'Cannot update: the worktree has uncommitted changes.',
      },
      {
        name: 'fetch-failed',
        result: { status: 'fetch-failed', baseBranch: 'main', reason: 'network unreachable\nverbose git trailer' },
        expectedText: 'Could not fetch main from origin. network unreachable',
      },
      {
        name: 'no-remote',
        result: { status: 'no-remote', baseBranch: 'main' },
        expectedText: 'No origin remote to fetch main from.',
      },
    ];

    for (const testCase of cases) {
      await page.evaluate((result) => {
        (window as unknown as { __mockUpdateFromBaseResult?: TaskUpdateFromBaseResult }).__mockUpdateFromBaseResult = result;
      }, testCase.result);

      await openKebab(page, worktreeWindowId);
      // The click closes the kebab itself (closeAll() fires before the async
      // handler), so no closeKebab call is needed here.
      await page.locator('[data-testid="update-from-base-btn"]').click();

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: testCase.expectedText });
      await expect(toast, `toast for ${testCase.name}`).toBeVisible({ timeout: 5000 });
    }
  });
});
