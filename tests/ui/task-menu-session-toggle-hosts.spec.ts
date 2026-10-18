/**
 * UI tests for the rest of the Pause session / Resume session surface that
 * task-menu-session-toggle.spec.ts leaves out: the third menu host (the
 * Workflows canvas card), the session writes the task detail sends for a task
 * of another project, and the two outcomes of a menu click the user can only
 * see afterwards (a refused pause, a resume that finds the agent still live).
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
 *
 * Assertions read state (the mock's call logs, data attributes, toast text),
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
  cardInLane,
  openMonitor,
  suspendCalls,
  resumeCalls,
  resetCalls,
  reconcileCalls,
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
 * Put the named seeded tasks in one running workflow homed on the open project.
 * A task tagged for the other project keeps its tag, so it stays on the other
 * board and the canvas draws it there, as main does for a cross-board workflow.
 */
function workflowAround(taskIds: string[]): string {
  return `
    window.__mockWorkflows = [{ workflow: { id: '${WORKFLOW_ID}', title: 'Session toggle', state: 'running', draft: null, color_slot: 5 } }];
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

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Failed to suspend session' });
      await expect(toast).toContainText('PTY refused to stop');

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

      await expect(page.locator('[data-testid="toast"]').filter({ hasText: 'Reconnected to running session' })).toHaveCount(1);
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
