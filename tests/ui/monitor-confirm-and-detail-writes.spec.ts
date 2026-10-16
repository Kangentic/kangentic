/**
 * UI tests for the confirm branches of the Agent Monitor row menu, the writes a
 * task detail makes, and the "Open on board" hand-off.
 *
 * monitor-writes-reach-board.spec.ts pins the happy path of each row action. This
 * file pins what that spec leaves open:
 *
 * - The row menu's Delete and Backlog confirms: Don't ask again writes
 *   `skipDeleteConfirm` and the next Delete runs without a dialog, an already-set
 *   switch skips the Backlog question even for a task that holds a worktree, and
 *   Cancel runs nothing.
 * - A row write that rejects AFTER it committed still reaches the board: the
 *   monitor's resync runs in `.finally`, so a warning toast and the committed move
 *   both show.
 * - Send to Backlog from a task detail carries the project id of the task's OWN
 *   project, for a monitor-hosted detail of another project and for a board-hosted
 *   detail of the open one. A demote without it would resolve against whichever
 *   project the main process last opened (.claude/rules/project-scoped-ipc.md).
 * - Delete from a monitor-hosted detail removes the card from the board under the
 *   monitor, which only the host's own resync can do: its write bypasses the
 *   board store.
 * - "Open on board" from a row still hands keyboard focus to the opened detail's
 *   terminal, even though the new window's terminal arrives while the monitor
 *   overlay is still fading out (the arrival arbiter's tier 0 denies a covered
 *   terminal).
 *
 * Red cases. Each test below states the change that turns it red. Each was run by
 * serving the renderer module with that change applied (a request interception on
 * the dev server in a temporary harness), never by editing src/. The "Open on
 * board" test's comment says how far its red goes.
 *
 * Assertions read state (DOM membership, the mock's call logs, the config store),
 * never pixel geometry (.claude/rules/cross-platform-parity.md). Every test
 * launches its own browser, so there is no cross-test state.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  PROJECT_ID,
  OTHER_PROJECT_ID,
  sessionIdOf,
  launch,
  byTestId,
  boardCard,
  cardInLane,
  openMonitor,
  closeMonitor,
  openRowMenu,
  deleteCallCount,
  backlogTitles,
  moveProjectIds,
  demoteCalls,
} from './monitor-writes-seed';

test.describe.configure({ mode: 'parallel' });

/** The renderer's own copy of `skipDeleteConfirm`: what the NEXT menu click reads. */
async function storedSkipDeleteConfirm(page: Page): Promise<boolean | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config?: { getState: () => { config: { skipDeleteConfirm?: boolean } } } };
    }).__zustandStores;
    return stores?.config?.getState().config.skipDeleteConfirm ?? null;
  });
}

/** What reached the config write path (`config.getGlobal`), the persisted half. */
async function persistedSkipDeleteConfirm(page: Page): Promise<boolean | null> {
  return page.evaluate(async () => {
    const api = (window as unknown as {
      electronAPI: { config: { getGlobal: () => Promise<{ skipDeleteConfirm?: boolean }> } };
    }).electronAPI;
    return (await api.config.getGlobal()).skipDeleteConfirm ?? null;
  });
}

/** The monitor-hosted detail window for a row of the monitor's own layer. */
function monitorDetailFrame(page: Page): Locator {
  return page.locator('#monitor-detail-layer-root [data-testid^="window-frame-"]');
}

/** Open the detail for a row by its title, which the monitor hosts in its own layer. */
async function openMonitorDetail(page: Page, taskId: string): Promise<Locator> {
  await byTestId(page, 'monitor-page').locator(`[data-session-id="${sessionIdOf(taskId)}"] [data-testid="monitor-card-title"]`).click();
  const detail = monitorDetailFrame(page);
  await expect(detail).toHaveCount(1);
  return detail;
}

/** The Delete confirm of a task detail window: a bare ConfirmDialog with no test id. */
function detailDeleteDialog(page: Page): Locator {
  return page.locator('[data-base-dialog]').filter({ has: page.getByRole('heading', { name: 'Delete task' }) });
}

test.describe('Agent Monitor row menu confirm branches', () => {
  // Red: `settleConfirm` stops writing `skipDeleteConfirm` when the box is ticked.
  // The config stays false, and the second Delete opens a dialog.
  test('ticking Don\'t ask again in the row\'s Delete dialog stops the question for the next Delete', async () => {
    const firstTaskId = 'task-mc-ask-first';
    const secondTaskId = 'task-mc-ask-second';
    const { browser, page } = await launch({
      tasks: [
        { id: firstTaskId, displayId: 61, title: 'Deleted with the box ticked', lane: 'Executing' },
        { id: secondTaskId, displayId: 62, title: 'Deleted without a question', lane: 'Executing' },
      ],
    });
    try {
      // The switch starts off, so the final state cannot be the seed's.
      expect(await storedSkipDeleteConfirm(page)).toBe(false);
      await openMonitor(page);

      await (await openRowMenu(page, firstTaskId)).getByTestId('context-delete-task').click();
      const dialog = byTestId(page, 'delete-task-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('checkbox', { name: 'Don\'t ask again' }).check();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => deleteCallCount(page, firstTaskId)).toBe(1);

      // The write reached the config path, and the renderer's copy (what the next
      // menu click reads) caught up. `updateConfig` refreshes the store only after
      // the write returns, so the second click waits on the store, not the write.
      await expect.poll(() => persistedSkipDeleteConfirm(page)).toBe(true);
      await expect.poll(() => storedSkipDeleteConfirm(page)).toBe(true);

      await (await openRowMenu(page, secondTaskId)).getByTestId('context-delete-task').click();
      await expect.poll(() => deleteCallCount(page, secondTaskId)).toBe(1);
      await expect(byTestId(page, 'delete-task-dialog')).toHaveCount(0);

      await closeMonitor(page);
      await expect(boardCard(page, secondTaskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // Red (two ways): `sendToBacklogAsksFirst` ignores the switch, so the dialog
  // opens for a task that holds a worktree and no demote is recorded until someone
  // answers it. Or the row's `backlog.demote` drops the project id, and the call is
  // stamped null instead of the open project's.
  test('Backlog on a task with a worktree runs without asking once Don\'t ask again is set', async () => {
    const taskId = 'task-mc-backlog-skip';
    const title = 'Worktree task sent without a question';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 63, title, lane: 'Executing', worktree: true }],
      skipDeleteConfirm: true,
    });
    try {
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      expect(await demoteCalls(page)).toEqual([]);
      await openMonitor(page);

      await (await openRowMenu(page, taskId)).getByTestId('context-send-to-backlog').click();
      await expect.poll(() => demoteCalls(page)).toEqual([{ taskId, projectId: PROJECT_ID }]);
      await expect(byTestId(page, 'send-to-backlog-dialog')).toHaveCount(0);
      await expect.poll(() => backlogTitles(page)).toContain(title);

      // The board under the overlay already dropped the card.
      await expect(boardCard(page, taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // Red: Cancel runs the write (`onCancel` settles with `sendToBacklog`), so a
  // demote is recorded and the card leaves the board.
  test('Cancel on the Backlog dialog sends nothing and keeps the card on the board', async () => {
    const taskId = 'task-mc-backlog-cancel';
    const title = 'Worktree task kept by Cancel';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 64, title, lane: 'Executing', worktree: true }],
    });
    try {
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      expect(await demoteCalls(page)).toEqual([]);
      await openMonitor(page);

      await (await openRowMenu(page, taskId)).getByTestId('context-send-to-backlog').click();
      const dialog = byTestId(page, 'send-to-backlog-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(byTestId(page, 'monitor-row-menu')).toHaveCount(0);

      // `settleConfirm` runs the write synchronously inside the click, so the log
      // is final as soon as the dialog is gone: one read is a valid negative check.
      expect(await demoteCalls(page)).toEqual([]);
      expect(await backlogTitles(page)).toEqual([]);

      await closeMonitor(page);
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // Red: the resync runs only on the success path, ahead of the `.catch`. The
  // rejection skips it, so the card stays in To Do on the board although main
  // already moved it. Swapping `.finally` for a plain `.then` after the `.catch`
  // is NOT a regression: that `.then` still runs once the `.catch` has handled the
  // rejection, and this test stays green.
  test('a Move to that rejects after it committed warns, and the board still shows the committed move', async () => {
    const taskId = 'task-mc-move-reject';
    const title = 'Moved, then failed';
    const failure = 'Agent failed to start after the move';
    const { browser, page } = await launch({ tasks: [{ id: taskId, displayId: 65, title, lane: 'To Do' }] });
    try {
      await expect(cardInLane(page, 'To Do', taskId)).toBeVisible();
      await openMonitor(page);

      const menu = await openRowMenu(page, taskId);
      await page.evaluate((message) => {
        (window as unknown as { __mockMoveRejectAfterCommit: string }).__mockMoveRejectAfterCommit = message;
      }, failure);
      await menu.locator('[data-testid="context-move-to"]').filter({ hasText: 'Executing' }).click();

      const toast = byTestId(page, 'toast').filter({ hasText: 'Failed to move' });
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(title);
      await expect(toast).toContainText(failure);
      expect(await moveProjectIds(page)).toEqual([PROJECT_ID]);

      // The board under the overlay learned the committed half.
      await expect(cardInLane(page, 'Executing', taskId)).toHaveCount(1);
      await expect(cardInLane(page, 'To Do', taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Writes from a task detail', () => {
  // Red: `MonitorTaskDetailHost.sendToBacklog` drops the project id (demote is
  // stamped null), which main would resolve against whichever project it last
  // opened instead of this task's own.
  test('Send to Backlog from a monitor-hosted detail of another project is stamped with that project', async () => {
    const taskId = 'task-mc-detail-backlog';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 66, title: 'Other project task sent from its detail',
        lane: 'Executing', session: true, worktree: true, otherProject: true,
      }],
    });
    try {
      expect(await demoteCalls(page)).toEqual([]);
      await openMonitor(page);
      const detail = await openMonitorDetail(page, taskId);

      await detail.getByRole('button', { name: 'Actions' }).click();
      await byTestId(page, 'send-to-backlog-btn').click();
      // The task holds a session and a worktree, so the detail asks first.
      const dialog = byTestId(page, 'send-to-backlog-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Send to Backlog' }).click();

      await expect.poll(() => demoteCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);
      await expect(detail).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // Red: `MonitorTaskDetailHost.deleteTask` stops resyncing the board. Its write
  // goes straight to the IPC, so the card stays on the board under the monitor.
  test('Delete from a monitor-hosted detail removes the card from the board', async () => {
    const taskId = 'task-mc-detail-delete';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 67, title: 'Deleted from a monitor detail', lane: 'Executing', session: true }],
    });
    try {
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      await openMonitor(page);
      const detail = await openMonitorDetail(page, taskId);

      await detail.getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('menu').getByText('Delete', { exact: true }).click();
      const dialog = detailDeleteDialog(page);
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

      await expect.poll(() => deleteCallCount(page, taskId)).toBe(1);
      await expect(detail).toHaveCount(0);
      // Under the overlay, before the monitor closes.
      await expect(boardCard(page, taskId)).toHaveCount(0);
      await closeMonitor(page);
      await expect(boardCard(page, taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // Red: `handleArchive` refreshes the host only after a move that succeeded (the
  // `finally` is replaced by a refresh on the success path). A move that commits
  // and then rejects skips it, so the card stays in its source lane on the board
  // under the monitor although main already archived it.
  test('Archive from a monitor-hosted detail whose move rejects after committing still reaches the board', async () => {
    const taskId = 'task-mc-detail-archive-reject';
    const failure = 'Cleanup failed after the archive committed';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 70, title: 'Archived, then failed', lane: 'Executing', session: true }],
    });
    try {
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      await openMonitor(page);
      const detail = await openMonitorDetail(page, taskId);

      await page.evaluate((message) => {
        (window as unknown as { __mockMoveRejectAfterCommit: string }).__mockMoveRejectAfterCommit = message;
      }, failure);
      await detail.getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('menu').getByText('Archive', { exact: true }).click();
      await expect(detail).toHaveCount(0);

      // The move ran, stamped with the open project, and then rejected.
      await expect.poll(() => moveProjectIds(page)).toEqual([PROJECT_ID]);
      // The failure is shown, not left to the global unhandled-rejection listener
      // (red: `handleArchive` without its catch shows no toast at all).
      const toast = byTestId(page, 'toast').filter({ hasText: 'Failed to archive' });
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(failure);
      // The board under the overlay shows the card in Done, before the monitor closes.
      await expect(cardInLane(page, 'Done', taskId)).toHaveCount(1);
      await expect(cardInLane(page, 'Executing', taskId)).toHaveCount(0);
      await closeMonitor(page);
      await expect(cardInLane(page, 'Done', taskId)).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // Red: the board host's `sendToBacklog` skips the backlog store and calls
  // `backlog.demote` with no project id, so the demote is stamped null. An
  // OMITTED argument to `demoteTask` is not caught here: the store falls back to
  // the open project's id (`backlog-store.ts`), which is the same id this asserts.
  test('Send to Backlog from a board-hosted detail is stamped with the open project and the card leaves the board', async () => {
    const taskId = 'task-mc-board-detail-backlog';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 68, title: 'Board task sent from its detail',
        lane: 'Executing', session: true, worktree: true,
      }],
    });
    try {
      const card = cardInLane(page, 'Executing', taskId);
      await expect(card).toBeVisible();
      expect(await demoteCalls(page)).toEqual([]);

      await card.click();
      const detail = page.locator('[data-testid^="window-frame-"]').filter({ hasText: 'Board task sent from its detail' });
      await expect(detail).toHaveCount(1);
      await detail.getByRole('button', { name: 'Actions' }).click();
      await byTestId(page, 'send-to-backlog-btn').click();

      const dialog = byTestId(page, 'send-to-backlog-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Send to Backlog' }).click();

      await expect.poll(() => demoteCalls(page)).toEqual([{ taskId, projectId: PROJECT_ID }]);
      await expect(boardCard(page, taskId)).toHaveCount(0);
      await expect(detail).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

/** One `arrival-focus` decision from the dev trace ring, with the page clock it was made at. */
interface ArrivalDecision {
  timestamp: number;
  site: string;
  allow: boolean;
  reason: string;
  terminalVisible: boolean;
}

/** The session's `arrival-focus` decisions made at or after `sinceTimestamp`. */
async function arrivalDecisionsSince(page: Page, sessionId: string, sinceTimestamp: number): Promise<ArrivalDecision[]> {
  return page.evaluate((query) => {
    const reader = (window as unknown as {
      __kangenticTerminalTrace?: () => Array<{
        ts: number; sessionId: string | null; event: string; detail?: Record<string, unknown>;
      }>;
    }).__kangenticTerminalTrace;
    return (reader ? reader() : [])
      .filter((entry) => entry.sessionId === query.sessionId && entry.event === 'arrival-focus' && entry.ts >= query.sinceTimestamp)
      .map((entry) => ({
        timestamp: entry.ts,
        site: String(entry.detail?.site ?? ''),
        allow: entry.detail?.allow === true,
        reason: String(entry.detail?.reason ?? ''),
        terminalVisible: entry.detail?.terminalVisible === true,
      }));
  }, { sessionId, sinceTimestamp });
}

test.describe('Open on board from an Agent Monitor row', () => {
  // Red: no decision grants the detail's terminal focus. The case this guards is
  // tier 0 denying the new terminal as `hidden` while the monitor overlay is still
  // fading, with nothing asking again once it is gone. That timing does not occur
  // in this harness: in every run the window's terminal was mounted (trace event
  // `mount`, surface `board-window`) 20 to 40ms AFTER the monitor left the DOM,
  // and its `tab-init` and `mount-replay` decisions followed within 25ms, allowed,
  // with the terminal visible. Why the mount waits is not established here. So the
  // red that was run is the outcome, not the timing: the
  // arbiter denying every arrival (served with `return false` in
  // `mayTakeArrivalFocus`) leaves focus outside the terminal and fails this test.
  // If the ordering ever flips, a denied decision fails the focus check below and
  // the message lists every decision with its offset from the click, the offset at
  // which the monitor left the DOM, and the mock's scrollback calls.
  test('keyboard focus lands in the opened detail\'s terminal', async () => {
    const taskId = 'task-mc-open-on-board';
    const sessionId = sessionIdOf(taskId);
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 69, title: 'Opened on the board from the monitor', lane: 'Executing', session: true }],
    });
    try {
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      // The launch overlay is already lifted, so the detail's terminal does not
      // also run an overlay-lift reload that would add its own decision.
      await page.evaluate((id) => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { getState: () => { markFirstOutput: (sessionKey: string) => void } } };
        }).__zustandStores;
        stores?.session?.getState().markFirstOutput(id);
      }, sessionId);

      await openMonitor(page);
      const menu = await openRowMenu(page, taskId);

      // When the monitor overlay left the DOM, on the page clock the trace uses.
      await page.evaluate(() => {
        const pageWindow = window as unknown as { __monitorDetachedAt?: number | null };
        pageWindow.__monitorDetachedAt = null;
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[data-testid="monitor-page"]')) {
            pageWindow.__monitorDetachedAt = Date.now();
            observer.disconnect();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      const clickedAt = await page.evaluate(() => Date.now());
      await menu.getByTestId('monitor-menu-open-on-board').click();

      // The detail window mounted in the board layer, with its terminal.
      const detailFrame = page.locator('[data-testid^="window-frame-"]').filter({ hasText: 'Opened on the board from the monitor' });
      await expect(detailFrame).toHaveCount(1);
      await expect(detailFrame.locator('.xterm').first()).toBeAttached();
      await expect(byTestId(page, 'monitor-page')).toHaveCount(0);

      // The mount replay's own decision, made after the click, then the frame that
      // would act on it.
      await expect.poll(
        async () => (await arrivalDecisionsSince(page, sessionId, clickedAt)).filter((decision) => decision.site === 'mount-replay').length,
        { timeout: 9000 },
      ).toBeGreaterThan(0);
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));

      const decisions = await arrivalDecisionsSince(page, sessionId, clickedAt);
      const focusState = await page.evaluate(() => {
        const active = document.activeElement;
        const frame = active?.closest('[data-testid^="window-frame-"]');
        return {
          activeIsInXterm: !!active?.closest('.xterm'),
          activeFrameId: frame?.getAttribute('data-testid') ?? null,
          monitorDetachedAt: (window as unknown as { __monitorDetachedAt?: number | null }).__monitorDetachedAt ?? null,
          scrollbackCalls: (window as unknown as { __mockScrollbackCalls?: unknown[] }).__mockScrollbackCalls ?? [],
        };
      });
      const detailFrameId = await detailFrame.getAttribute('data-testid');
      const diagnostics = JSON.stringify({
        clickedAt,
        decisionsRelativeToClick: decisions.map((decision) => ({ ...decision, timestamp: decision.timestamp - clickedAt })),
        monitorDetachedAfterClickMs: focusState.monitorDetachedAt === null ? null : focusState.monitorDetachedAt - clickedAt,
        scrollbackCalls: focusState.scrollbackCalls,
      });
      expect(
        focusState.activeIsInXterm && focusState.activeFrameId === detailFrameId,
        `focus is not in the opened detail's terminal. ${diagnostics}`,
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
