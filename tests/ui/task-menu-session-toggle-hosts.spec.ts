/**
 * UI tests for the rest of the Pause session / Resume session surface that
 * task-menu-session-toggle.spec.ts leaves out: the third menu host (the
 * Workflows canvas card), the session writes the task detail sends for a task
 * of another project, and the two outcomes of a menu click the user can only
 * see afterwards (a refused pause, a resume that finds the agent still live).
 * Also the canvas menu's Move to on a card of another board, which shares this
 * file's two-project canvas setup.
 *
 * Intent:
 * - A workflow task's canvas menu offers the same row, and the click pauses the
 *   task with the TASK's project, not the open board's. A card of another board
 *   is the case that tells the two apart (.claude/rules/project-scoped-ipc.md).
 * - A task detail hosted by the Agent Monitor for another project's task sends
 *   that project on every session write it makes: the mount-time reconcile
 *   probe, the header Resume, and Reset session. Each used to send the open
 *   board's project, and main looked for the task in the wrong database.
 * - A pause main refuses does not leave the card claiming a pause that never
 *   happened: the store asks main for the live session before the failure toast.
 * - A resume that hands back the session the card already showed says so, and
 *   an ordinary resume does not.
 * - The canvas row's pause brings the task's own board up to date, decided when
 *   the pause lands, so a board the user switched to or away from meanwhile is
 *   reloaded or dropped from the warm cache, not left holding the old session.
 * - That resync runs however the pause settles. Main clears the task's session
 *   pointer before it stops the agent, and the stop can still fail, so a pause
 *   that toasts a failure has already changed the task row. The task's own board
 *   must still drop its warm snapshot.
 * - Move to on a canvas card of another board brings that board up to date. Main
 *   sends no push for a move from the main window, and a warm switch only reads
 *   the snapshot taken when the user left that board, so without the resync the
 *   card showed in its old column.
 *
 * Assertions read state (the mock's call logs, data attributes, toast text),
 * never pixel geometry (.claude/rules/cross-platform-parity.md). Every test
 * launches its own browser, so there is no cross-test state.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  PROJECT_ID,
  PROJECT_NAME,
  OTHER_PROJECT_ID,
  OTHER_PROJECT_NAME,
  sessionIdOf,
  launch,
  byTestId,
  boardCard,
  cardInLane,
  openMonitor,
  moveProjectIds,
  suspendCalls,
  resumeCalls,
  resetCalls,
  reconcileCalls,
  failSuspendAfterCommit,
  holdNextSuspend,
  suspendHeld,
  releaseSuspend,
  resetIpcCallCounts,
  tasksListCalls,
  switchToProject,
  visitOtherBoardAndBack,
} from './monitor-writes-seed';

test.describe.configure({ mode: 'parallel' });

const WORKFLOW_ID = 'wf-session-toggle';

/** Right-click a board card and wait for its menu. */
async function openCardMenu(page: Page, lane: string, taskId: string): Promise<Locator> {
  await cardInLane(page, lane, taskId).click({ button: 'right' });
  const menu = byTestId(page, 'task-context-menu');
  await menu.waitFor({ state: 'visible', timeout: 10000 });
  return menu;
}

/**
 * Put the named seeded tasks in one workflow homed on the open project, running
 * unless `state` says otherwise. A task tagged for the other project keeps its
 * tag, so it stays on the other board and the canvas draws it there, as main does
 * for a cross-board workflow. The home is pinned, so a spec that switches
 * projects does not rehome it on the mock's current project.
 */
function workflowAround(taskIds: string[], state: 'running' | 'paused' = 'running'): string {
  return `
    window.__mockWorkflows = [{
      projectId: '${PROJECT_ID}',
      workflow: { id: '${WORKFLOW_ID}', title: 'Session toggle', state: '${state}', draft: null, color_slot: 5 },
    }];
    window.__mockPreConfigure(function (state) {
      var inWorkflow = ${JSON.stringify(taskIds)};
      state.tasks.forEach(function (task) {
        if (inWorkflow.indexOf(task.id) === -1) return;
        task.workflow_id = '${WORKFLOW_ID}';
        task.workflow_project_id = '${PROJECT_ID}';
      });
    });
  `;
}

/** Open the Workflows view and right-click a task's canvas card; resolves with its menu. */
async function openCanvasCardMenu(page: Page, taskId: string): Promise<Locator> {
  await byTestId(page, 'view-toggle-workflows').click();
  await byTestId(page, 'workflows-view').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${taskId}"]`).click({ button: 'right' });
  const menu = byTestId(page, 'workflow-card-menu');
  await menu.waitFor({ state: 'visible', timeout: 10000 });
  return menu;
}

/** Open the Agent Monitor's task window for a row and resolve with the window frame. */
async function openMonitorDetail(page: Page, taskId: string): Promise<Locator> {
  await openMonitor(page);
  await byTestId(page, 'monitor-page')
    .locator(`[data-session-id="${sessionIdOf(taskId)}"] [data-testid="monitor-card-title"]`)
    .click();
  const detail = page.locator('#monitor-detail-layer-root [data-testid^="window-frame-"]');
  await expect(detail).toHaveCount(1);
  return detail;
}

test.describe('Task menu session row on the Workflows canvas', () => {
  // Red: `WorkflowCardMenu` stops passing `sessionToggle` to `TaskContextMenu`,
  // so the canvas menu has no session row at all.
  test('Pause session on a card of this board pauses the task with the open project', async () => {
    const taskId = 'task-hosts-wf-board';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 81, title: 'Workflow task on this board', lane: 'Executing', session: true }],
    }, workflowAround([taskId]));
    try {
      const menu = await openCanvasCardMenu(page, taskId);
      const row = menu.getByTestId('context-toggle-session');
      await expect(row).toHaveText('Pause session');
      await expect(row).toHaveAttribute('data-session-state', 'active');

      await row.click();
      await expect(byTestId(page, 'workflow-card-menu')).toHaveCount(0);
      await expect.poll(() => suspendCalls(page)).toEqual([{ taskId, projectId: PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });

  // Red: `WorkflowCardMenu` passes the open project instead of
  // `viewTask.projectId`, so a card of another board pauses against the wrong
  // database. The test above cannot see it, because there the two are one id.
  test('Pause session on a card of another board is stamped with that board\'s project', async () => {
    const taskId = 'task-hosts-wf-other';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 82, title: 'Workflow task on another board', lane: 'Executing',
        session: true, otherProject: true,
      }],
    }, workflowAround([taskId]));
    try {
      const menu = await openCanvasCardMenu(page, taskId);
      const row = menu.getByTestId('context-toggle-session');
      await expect(row).toHaveText('Pause session');

      await row.click();
      await expect(byTestId(page, 'workflow-card-menu')).toHaveCount(0);
      await expect.poll(() => suspendCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });

  // Red: the row's `onSucceeded` goes back to a bare `invalidateProject`. The
  // user switches to the task's board while the pause is in flight, so the warm
  // restore lands first, and marking the board that is already open as stale
  // reloads nothing. It keeps the session pointer main just cleared.
  test('Pause session on a card of another board reloads that board when it is open by the time the pause lands', async () => {
    const taskId = 'task-hosts-wf-pause-switch-to';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 93, title: 'Paused while its board opens', lane: 'Executing',
        session: true, otherProject: true,
      }],
    }, workflowAround([taskId]));
    try {
      await warmOtherBoard(page, taskId);
      await holdNextSuspend(page);
      const menu = await openCanvasCardMenu(page, taskId);
      await menu.getByTestId('context-toggle-session').click();
      await expect.poll(() => suspendHeld(page)).toBe(true);

      await showOtherBoard(page);
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      await resetIpcCallCounts(page);
      await releaseSuspend(page);
      await expect.poll(() => suspendCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);
      await expect.poll(() => tasksListCalls(page)).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  // Red: the row's `onSucceeded` goes back to `loadBoard()` for a card of this
  // board. The user switches away while the pause is in flight, so that reload
  // reads the other project, and this board's warm snapshot keeps the session
  // pointer main just cleared. Coming back restores it with no read.
  test('Pause session on a card of this board drops its snapshot when the user left the board before the pause lands', async () => {
    const taskId = 'task-hosts-wf-pause-switch-away';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 94, title: 'Paused while the user moves on', lane: 'Executing', session: true }],
    }, workflowAround([taskId]));
    try {
      await visitOtherBoardAndBack(page);
      await holdNextSuspend(page);
      const menu = await openCanvasCardMenu(page, taskId);
      await menu.getByTestId('context-toggle-session').click();
      await expect.poll(() => suspendHeld(page)).toBe(true);

      // The title, not the card: the mock lists an untagged task on every board.
      await showOtherBoard(page);
      await expect(byTestId(page, 'titlebar-project-name')).toHaveText(OTHER_PROJECT_NAME);
      await releaseSuspend(page);
      await expect.poll(() => suspendCalls(page)).toEqual([{ taskId, projectId: PROJECT_ID }]);

      await resetIpcCallCounts(page);
      await switchToProject(page, PROJECT_ID);
      await expect(byTestId(page, 'titlebar-project-name')).toHaveText(PROJECT_NAME);
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      await expect.poll(() => tasksListCalls(page)).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  // Red: the row goes back to `onSucceeded: () => resyncBoardAfterMonitorWrite(...)`.
  // `runSessionToggle` returns without calling it when the pause rejects, but
  // main clears the session pointer before it stops the agent, so a pause can
  // commit and then fail. The task's board keeps its warm snapshot, and the next
  // switch to it restores the pointer main just cleared with no read.
  test('Pause session on a card of another board that commits and then fails still drops that board snapshot', async () => {
    const taskId = 'task-hosts-wf-pause-commit-fail';
    const failureReason = 'PTY did not stop after the pause committed';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 95, title: 'Paused then the stop failed', lane: 'Executing',
        session: true, otherProject: true,
      }],
    }, workflowAround([taskId]));
    try {
      await warmOtherBoard(page, taskId);
      await failSuspendAfterCommit(page, failureReason);
      const menu = await openCanvasCardMenu(page, taskId);
      await menu.getByTestId('context-toggle-session').click();

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: "Couldn't pause session" });
      await expect(toast.getByTestId('toast-body')).toHaveText(`${failureReason}.`);
      // The pause reached the mock before it threw, so the write did commit.
      expect(await suspendCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);

      // Leave the Workflows view before the counter resets: that switch is not
      // what the test measures, and the other board's cold load is.
      await byTestId(page, 'view-toggle-board').click();
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await resetIpcCallCounts(page);
      await switchToProject(page, OTHER_PROJECT_ID);
      await expect(byTestId(page, 'titlebar-project-name')).toHaveText(OTHER_PROJECT_NAME);
      await expect.poll(() => tasksListCalls(page)).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});

/**
 * Visit the other board and come back, so it holds a warm snapshot with the card
 * in Executing. Without this the last switch in each test is a cold load, which
 * reads the moved card from the mock whatever the menu did.
 */
async function warmOtherBoard(page: Page, taskId: string): Promise<void> {
  await switchToProject(page, OTHER_PROJECT_ID);
  await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
  await switchToProject(page, PROJECT_ID);
  await expect(boardCard(page, taskId)).toHaveCount(0);
}

/** Right-click a task's canvas card and pick a column from Move to. */
async function moveFromCanvas(page: Page, taskId: string, laneName: string): Promise<void> {
  const menu = await openCanvasCardMenu(page, taskId);
  await menu.locator('[data-testid="context-move-to"]').filter({ hasText: laneName }).click();
}

/**
 * Leave the Workflows view, then switch to the other project. The board view
 * first, because Workflows folds the sidebar to its icon strip, which covers the
 * project rows, and `activeView` survives the switch.
 */
async function showOtherBoard(page: Page): Promise<void> {
  await byTestId(page, 'view-toggle-board').click();
  await switchToProject(page, OTHER_PROJECT_ID);
}

test.describe('Move to on a Workflows canvas card of another board', () => {
  // A paused workflow, because a running one locks every by-hand move but the
  // human gate's. The target is Code Review: Done would archive the card, and
  // To Do is refused.
  const launchMoveCase = (taskId: string, displayId: number) => launch({
    tasks: [{ id: taskId, displayId, title: 'Workflow task moved from the canvas', lane: 'Executing', otherProject: true }],
  }, workflowAround([taskId], 'paused'));

  // Red: `moveTo`'s other-board branch drops the `.finally` that calls
  // `resyncBoardAfterMonitorWrite`, so the warm switch restores the old column.
  test('switching to that board afterwards shows the card in its new column', async () => {
    const taskId = 'task-hosts-move-then-switch';
    const { browser, page } = await launchMoveCase(taskId, 90);
    try {
      await warmOtherBoard(page, taskId);
      await moveFromCanvas(page, taskId, 'Code Review');
      await expect.poll(() => moveProjectIds(page)).toEqual([OTHER_PROJECT_ID]);
      // The move settles while the open board is still this one.
      const movedToast = page.locator('[data-testid="toast"]')
        .filter({ hasText: '"Workflow task moved from the canvas" is now in Code Review.' });
      await expect(movedToast).toHaveCount(1);
      await expect(movedToast.getByTestId('toast-title')).toHaveText('Task moved');

      await showOtherBoard(page);
      await expect(cardInLane(page, 'Code Review', taskId)).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // Red: the resync runs in `.then` instead of `.finally`. Main can write the
  // move and then reject (the destination column's agent fails to start), and
  // the card is in its new column all the same.
  test('a move that lands and then fails still reaches that board', async () => {
    const taskId = 'task-hosts-move-commit-reject';
    const { browser, page } = await launchMoveCase(taskId, 91);
    try {
      await warmOtherBoard(page, taskId);
      await page.evaluate(() => { window.__mockMoveRejectAfterCommit = 'Agent failed to start'; });
      await moveFromCanvas(page, taskId, 'Code Review');
      const moveFailure = page.locator('[data-testid="toast"]').filter({ hasText: "Couldn't move task" });
      await expect(moveFailure.getByTestId('toast-body'))
        .toHaveText('"Workflow task moved from the canvas": Agent failed to start.');

      await showOtherBoard(page);
      await expect(cardInLane(page, 'Code Review', taskId)).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // Red: a bare `invalidateProject` in place of the resync helper. The user
  // switches to the task's board while the move is still in flight, so the warm
  // restore lands first, and marking the board that is already open as stale
  // reloads nothing.
  test('switching to that board while the move is in flight reloads it when the move lands', async () => {
    const taskId = 'task-hosts-move-in-flight';
    const { browser, page } = await launchMoveCase(taskId, 92);
    try {
      await warmOtherBoard(page, taskId);
      await page.evaluate(() => { window.__mockTaskMoveDeferred = true; });
      await moveFromCanvas(page, taskId, 'Code Review');
      await expect.poll(() => moveProjectIds(page)).toEqual([OTHER_PROJECT_ID]);

      await showOtherBoard(page);
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();

      await page.evaluate(() => {
        if (!window.__mockTaskMoveResolve) throw new Error('the mock is not holding a move');
        window.__mockTaskMoveResolve();
      });
      await expect(cardInLane(page, 'Code Review', taskId)).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

test.describe('Task detail session writes in the Agent Monitor for a task of another project', () => {
  // The task is paused, which is what makes the detail probe main on mount
  // (useTaskSessionState reconciles only a view that reads 'suspended').

  // Red: `useTaskSessionState` stops passing the host's project to
  // `reconcileSession`, so the store stamps the open board's project.
  test('the mount-time reconcile probe carries the task\'s project', async () => {
    const taskId = 'task-hosts-probe';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 83, title: 'Paused task of another project', lane: 'Executing',
        session: true, sessionStatus: 'suspended', otherProject: true,
      }],
    });
    try {
      await openMonitorDetail(page, taskId);
      // The projects the task's probes were stamped with, not the call count: the
      // probe is once per session per mount, and the count is not the contract.
      await expect.poll(async () => {
        const probes = (await reconcileCalls(page)).filter((call) => call.taskId === taskId);
        return [...new Set(probes.map((call) => call.projectId))];
      }).toEqual([OTHER_PROJECT_ID]);
    } finally {
      await browser.close();
    }
  });

  // Red: `useTaskActions` stops passing `taskProjectId` to `resumeSession`.
  test('the header Resume is stamped with the task\'s project', async () => {
    const taskId = 'task-hosts-resume';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 84, title: 'Paused task resumed from its detail', lane: 'Executing',
        session: true, sessionStatus: 'suspended', otherProject: true,
      }],
    });
    try {
      const detail = await openMonitorDetail(page, taskId);
      const toggle = detail.getByTestId('header-toggle-session-btn');
      await expect(toggle).toHaveAttribute('data-session-state', 'suspended');

      await toggle.click();
      await expect.poll(() => resumeCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });

  // Red: `handleCommandSelect` in `useTaskActions` stops passing `taskProjectId`
  // to its `suspendSession` and `resumeSession` calls. Picking a command from the
  // kebab restarts the agent as a pause and a resume with the command as the
  // prompt, and it is the one session write the detail makes that does not go
  // through `handleToggle`. The running task is the other project's, so a stamp
  // that falls back to the open board's project is visible.
  test('picking a command from the kebab pauses and resumes with the task\'s project', async () => {
    const taskId = 'task-hosts-command';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 89, title: 'Running task of another project', lane: 'Executing',
        session: true, otherProject: true,
      }],
    });
    try {
      const detail = await openMonitorDetail(page, taskId);
      await page.evaluate(() => {
        const recorder = window as unknown as { __mockResumePrompts: Array<string | undefined> };
        recorder.__mockResumePrompts = [];
        // One command, so the pick is unambiguous.
        window.electronAPI.agent.listCommands = async () => [{
          name: 'hosts-check', displayName: '/hosts-check', description: 'Run from the detail kebab',
          argumentHint: '', source: 'command' as const,
        }];
        // The mock's resume records only the project; keep the prompt too, around it.
        const resumeWithRecordedPrompt = window.electronAPI.sessions.resume;
        window.electronAPI.sessions.resume = async (resumedTaskId, resumePrompt, projectId) => {
          recorder.__mockResumePrompts.push(resumePrompt);
          return resumeWithRecordedPrompt(resumedTaskId, resumePrompt, projectId);
        };
      });

      await detail.locator('button[aria-label="Actions"]').click();
      // Hover opens the flyout (a click would toggle it shut again after the
      // pointer's own enter opened it). The popover portals to document.body, so
      // the controls are located on the page, not inside the window.
      await byTestId(page, 'kebab-commands-button').hover();
      await page.locator('[data-command-item]').filter({ hasText: '/hosts-check' }).click();

      await expect.poll(() => suspendCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);
      await expect.poll(() => resumeCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);
      expect(await page.evaluate(() => (window as unknown as { __mockResumePrompts: Array<string | undefined> }).__mockResumePrompts))
        .toEqual(['/hosts-check']);
    } finally {
      await browser.close();
    }
  });

  // Red: `useTaskActions` stops passing `taskProjectId` to `resetSession`. Reset
  // session only appears after a resume fails, so the resume is made to fail.
  test('Reset session after a failed resume is stamped with the task\'s project', async () => {
    const taskId = 'task-hosts-reset';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 85, title: 'Paused task whose resume fails', lane: 'Executing',
        session: true, sessionStatus: 'suspended', otherProject: true,
      }],
    });
    try {
      const detail = await openMonitorDetail(page, taskId);
      await page.evaluate(() => {
        window.electronAPI.sessions.resume = async () => { throw new Error('Session could not be revived'); };
      });

      await detail.getByTestId('header-toggle-session-btn').click();
      const reset = detail.getByRole('button', { name: 'Reset session' });
      await reset.click();
      await expect.poll(() => resetCalls(page)).toEqual([{ taskId, projectId: OTHER_PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Task menu session row outcomes on the board', () => {
  // Red: the reconcile-on-rejection block in `suspendSession` (session-store.ts)
  // is removed. The optimistic write marked the session paused before main
  // answered, and nothing else puts it back: the detail window that would run
  // its reconcile probe is already closed, and the card menu never had one.
  test('a pause main refuses toasts the reason and leaves the card reading as running', async () => {
    const taskId = 'task-hosts-refused';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 86, title: 'Pause refused by main', lane: 'Executing', session: true }],
    });
    try {
      await page.evaluate(() => {
        window.electronAPI.sessions.suspend = async () => { throw new Error('PTY refused to stop'); };
      });

      const menu = await openCardMenu(page, 'Executing', taskId);
      await menu.getByTestId('context-toggle-session').click();
      await expect(byTestId(page, 'task-context-menu')).toHaveCount(0);

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: "Couldn't pause session" });
      await expect(toast.getByTestId('toast-body')).toHaveText('PTY refused to stop.');

      // The toast follows the heal, so the next open reads the healed row.
      const reopened = await openCardMenu(page, 'Executing', taskId);
      const row = reopened.getByTestId('context-toggle-session');
      await expect(row).toHaveText('Pause session');
      await expect(row).toHaveAttribute('data-session-state', 'active');

      // The heal is the store asking main for the live session, for the card's own project.
      expect(await reconcileCalls(page)).toEqual([{ taskId, projectId: PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });

  // Red: `runSessionToggle` stops calling `toastIfReconnectedResume`. The store
  // row is paused (main reported it suspended at boot) and main's resume hands
  // back the SAME session, running: it found the agent live and started none.
  test('a resume that hands back the session the card already showed says it reconnected', async () => {
    const taskId = 'task-hosts-reconnect';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 87, title: 'Agent was running all along', lane: 'Executing',
        session: true, sessionStatus: 'suspended',
      }],
    });
    try {
      await page.evaluate(({ sessionId, resumedTaskId, projectId }) => {
        window.electronAPI.sessions.resume = async () => ({
          id: sessionId, taskId: resumedTaskId, projectId, pid: 9001, status: 'running' as const,
          shell: 'bash', cwd: '/mock/monitor-writes', startedAt: new Date().toISOString(),
          exitCode: null, resuming: false,
        });
      }, { sessionId: sessionIdOf(taskId), resumedTaskId: taskId, projectId: PROJECT_ID });

      const menu = await openCardMenu(page, 'Executing', taskId);
      const row = menu.getByTestId('context-toggle-session');
      await expect(row).toHaveText('Resume session');
      await row.click();

      const reconnectToast = page.locator('[data-testid="toast"]').filter({ hasText: 'Reconnected' });
      await expect(reconnectToast).toHaveCount(1);
      await expect(reconnectToast.getByTestId('toast-title')).toHaveText('Reconnected');
      await expect(reconnectToast.getByTestId('toast-body')).toHaveText('The session was already running.');
    } finally {
      await browser.close();
    }
  });

  // The other side of the one above: a resume that starts an agent says nothing
  // about reconnecting.
  test('a resume that starts a new session does not say it reconnected', async () => {
    const taskId = 'task-hosts-fresh-resume';
    const { browser, page } = await launch({
      tasks: [{
        id: taskId, displayId: 88, title: 'Agent really was paused', lane: 'Executing',
        session: true, sessionStatus: 'suspended',
      }],
    });
    try {
      const menu = await openCardMenu(page, 'Executing', taskId);
      await menu.getByTestId('context-toggle-session').click();
      await expect.poll(() => resumeCalls(page)).toEqual([{ taskId, projectId: PROJECT_ID }]);

      // The store took the new session, so the next open offers Pause. The toast
      // would have been raised before this, in the same turn the store was written.
      const reopened = await openCardMenu(page, 'Executing', taskId);
      await expect(reopened.getByTestId('context-toggle-session')).toHaveText('Pause session');
      // One read, not toHaveCount(0): that assertion polls until the count BECOMES
      // 0, and a toast closes on its own, so it would pass once a wrongly raised
      // toast timed out. Nothing to poll for here (anti-pattern: asserting
      // non-occurrence); the ordering above is what makes a single read sound.
      const reconnectToasts = await page.locator('[data-testid="toast"]').filter({ hasText: 'Reconnected' }).count();
      expect(reconnectToasts).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
