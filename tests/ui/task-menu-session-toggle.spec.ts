/**
 * UI tests for the Pause session / Resume session row in the task card menu.
 *
 * Intent:
 * - A running task's menu offers Pause session, a paused one Resume session, in
 *   the top group. The click needs no task window: the row flips on the next
 *   open because the store marked the session paused (or took the resumed one).
 * - A paused task in Done, or an archived one, keeps the row in place but
 *   disabled, with the refusal main would send as its tooltip, and a click
 *   sends nothing. A task with no session (To Do) gets no row at all.
 * - Every write carries the task's OWN project. A Monitor row of another
 *   project pauses that project's task, and so does the header Pause of a
 *   Monitor-hosted detail, which used to send the open board's project and
 *   made main look for the task in the wrong database
 *   (.claude/rules/project-scoped-ipc.md).
 *
 * Assertions read state (the mock's call logs, data attributes, the accessible
 * description), never pixel geometry (.claude/rules/cross-platform-parity.md).
 * Every test launches its own browser, so there is no cross-test state.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  PROJECT_ID,
  OTHER_PROJECT_ID,
  sessionIdOf,
  launch,
  byTestId,
  cardInLane,
  openMonitor,
  openRowMenu,
  suspendCalls,
  resumeCalls,
} from './monitor-writes-seed';

test.describe.configure({ mode: 'parallel' });

const DONE_REFUSAL = 'This task is complete. Move it out of Done to continue working on it.';

/** Right-click a board card and wait for its menu. */
async function openCardMenu(page: Page, lane: string, taskId: string): Promise<Locator> {
  await cardInLane(page, lane, taskId).click({ button: 'right' });
  const menu = byTestId(page, 'task-context-menu');
  await menu.waitFor({ state: 'visible', timeout: 10000 });
  return menu;
}

test.describe('Task menu session row on the board', () => {
  test('Pause session on a running task pauses it with the open project', async () => {
    const taskId = 'task-st-pause';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 71, title: 'Paused from the card menu', lane: 'Executing', session: true }],
    });
    try {
      const menu = await openCardMenu(page, 'Executing', taskId);
      const row = menu.getByTestId('context-toggle-session');
      await expect(row).toHaveText('Pause session');
      await expect(row).toHaveAttribute('data-session-state', 'active');

      await row.click();
      await expect(byTestId(page, 'task-context-menu')).toHaveCount(0);
      await expect.poll(() => suspendCalls(page)).toEqual([{ taskId, projectId: PROJECT_ID }]);

      // The store already holds the session as paused, so the next open offers Resume.
      const reopened = await openCardMenu(page, 'Executing', taskId);
      await expect(reopened.getByTestId('context-toggle-session')).toHaveText('Resume session');
      await expect(reopened.getByTestId('context-toggle-session')).toHaveAttribute('data-session-state', 'suspended');
    } finally {
      await browser.close();
    }
  });

  test('Resume session on a paused task resumes it with the open project', async () => {
    const taskId = 'task-st-resume';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 72, title: 'Resumed from the card menu', lane: 'Executing',
        session: true, sessionStatus: 'suspended',
      }],
    });
    try {
      const menu = await openCardMenu(page, 'Executing', taskId);
      const row = menu.getByTestId('context-toggle-session');
      await expect(row).toHaveText('Resume session');
      await expect(row).not.toHaveAttribute('aria-disabled', 'true');

      await row.click();
      await expect(byTestId(page, 'task-context-menu')).toHaveCount(0);
      await expect.poll(() => resumeCalls(page)).toEqual([{ taskId, projectId: PROJECT_ID }]);

      const reopened = await openCardMenu(page, 'Executing', taskId);
      await expect(reopened.getByTestId('context-toggle-session')).toHaveText('Pause session');
    } finally {
      await browser.close();
    }
  });

  test('a paused task in Done shows Resume disabled, with the refusal as its tooltip', async () => {
    const taskId = 'task-st-done';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 73, title: 'Paused in Done', lane: 'Done',
        session: true, sessionStatus: 'suspended',
      }],
    });
    try {
      const menu = await openCardMenu(page, 'Done', taskId);
      const row = menu.getByTestId('context-toggle-session');
      await expect(row).toHaveText('Resume session');
      await expect(row).toHaveAttribute('aria-disabled', 'true');
      await expect(row).toHaveAccessibleDescription(DONE_REFUSAL);

      // A refused row stays put and sends nothing. Forced, because Playwright
      // will not click an aria-disabled element on its own.
      await row.click({ force: true });
      await expect(byTestId(page, 'task-context-menu')).toBeVisible();
      expect(await resumeCalls(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('a To Do task with no session gets no session row', async () => {
    const taskId = 'task-st-todo';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 74, title: 'Not started yet', lane: 'To Do' }],
    });
    try {
      const menu = await openCardMenu(page, 'To Do', taskId);
      await expect(menu.getByTestId('context-edit-task')).toBeVisible();
      await expect(menu.getByTestId('context-toggle-session')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Task menu session row in the Agent Monitor', () => {
  test('Pause session on a row of another project is stamped with that project', async () => {
    const taskId = 'task-st-monitor-other';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 75, title: 'Other project task paused from its row', lane: 'Executing',
        session: true, otherProject: true,
      }],
    });
    try {
      await openMonitor(page);
      const menu = await openRowMenu(page, taskId);
      await menu.getByTestId('context-toggle-session').click();
      await expect(byTestId(page, 'monitor-row-menu')).toHaveCount(0);
      await expect.poll(() => suspendCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });

  test('a paused archived task shows Resume disabled, with the refusal as its tooltip', async () => {
    const taskId = 'task-st-monitor-archived';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 76, title: 'Completed and paused', lane: 'Done',
        session: true, sessionStatus: 'suspended', archived: true,
      }],
    });
    try {
      await openMonitor(page);
      const menu = await openRowMenu(page, taskId);
      const row = menu.getByTestId('context-toggle-session');
      await expect(row).toHaveAttribute('aria-disabled', 'true');
      await expect(row).toHaveAccessibleDescription(DONE_REFUSAL);
      await row.click({ force: true });
      await expect(byTestId(page, 'monitor-row-menu')).toBeVisible();
      expect(await resumeCalls(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  // Red: `useTaskActions` stops passing `host.projectId` to `suspendSession`, so
  // the store stamps the open board's project and main cannot find the task.
  test('header Pause in a monitor-hosted detail of another project is stamped with that project', async () => {
    const taskId = 'task-st-monitor-detail';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 77, title: 'Other project task paused from its detail', lane: 'Executing',
        session: true, otherProject: true,
      }],
    });
    try {
      await openMonitor(page);
      await byTestId(page, 'monitor-page')
        .locator(`[data-session-id="${sessionIdOf(taskId)}"] [data-testid="monitor-card-title"]`)
        .click();
      const detail = page.locator('#monitor-detail-layer-root [data-testid^="window-frame-"]');
      await expect(detail).toHaveCount(1);

      await detail.getByTestId('header-toggle-session-btn').click();
      await expect.poll(() => suspendCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });
});
