/**
 * The agents low memory paused: one push per agent from main
 * (`hostMemory:agentPaused`, src/main/diagnostics/idle-agent-pause.ts), fired
 * here through the mock's `__mockFireHostMemoryAgentPaused`.
 *
 * - The first push raises a persistent "Idle agent paused" toast with a
 *   Review button; later pushes update that same toast in place.
 * - Review opens the list: oldest wait first, the project named when the
 *   agents span projects, a Resume button per row.
 * - Resume brings the task back through the task's own Resume path and the
 *   row reads Running. A task that comes back by any other route reads Running
 *   too (the row watches the session store), and keeps reading Running if the
 *   agent stops later. A paused session the replica still lists as running does
 *   not read Running, and a task paused again gets a fresh row. A refused
 *   Resume toasts the card menu's own copy.
 * - The toast counts only the agents still paused and closes once every one
 *   is running again, by any route. With Review open the list stays, its rows
 *   reading Running, until the user closes it.
 * - Memory recovering leaves the paused toast up: the agents stay paused.
 *
 * Each case owns its page.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchPage } from './helpers';
import type { HostMemoryAgentPausedEvent } from '../../src/shared/types';

test.describe.configure({ mode: 'parallel' });

function pausedEvent(taskId: string, overrides: Partial<HostMemoryAgentPausedEvent> = {}): HostMemoryAgentPausedEvent {
  return {
    // A minute back, so a session a case starts now always starts after the
    // pause, which is what counts its agent as running again.
    pausedAt: new Date(Date.now() - 60_000).toISOString(),
    taskId,
    projectId: 'proj-1',
    taskTitle: `Task ${taskId}`,
    projectName: 'kangentic',
    waitedMs: 20 * 60_000,
    ...overrides,
  };
}

async function firePaused(page: Page, event: HostMemoryAgentPausedEvent): Promise<void> {
  // Guard the fire: the mock's fire hook silently no-ops with no subscriber,
  // so a missing App.tsx registration fails here, by name.
  const listenerCount = await page.evaluate(() => window.__mockHostMemoryAgentPausedListeners?.length ?? 0);
  expect(listenerCount, 'App.tsx is not subscribed to hostMemory.onAgentPaused').toBeGreaterThan(0);
  await page.evaluate((payload) => {
    if (!window.__mockFireHostMemoryAgentPaused) throw new Error('window.__mockFireHostMemoryAgentPaused is not installed');
    window.__mockFireHostMemoryAgentPaused(payload);
  }, event);
}

/**
 * A session for the task lands in the session store, as main's push puts it
 * there when the task comes back by a route other than the Review list (its
 * card, its window, a move). It starts now unless the case says otherwise.
 */
async function upsertSession(
  page: Page,
  session: { id: string; taskId: string; status: 'running' | 'suspended'; startedAt?: string },
): Promise<void> {
  await page.evaluate(({ id, taskId, status, startedAt }) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { upsertSession: (session: Record<string, unknown>) => void } } };
    }).__zustandStores;
    if (!stores) throw new Error('__zustandStores is not exposed');
    stores.session.getState().upsertSession({
      id,
      taskId,
      projectId: 'proj-9',
      pid: 4242,
      status,
      shell: 'bash',
      cwd: '/mock/paused-for-memory',
      startedAt: startedAt ?? new Date().toISOString(),
      exitCode: null,
    });
  }, session);
}

/**
 * Waits until the page has painted what the store holds: two animation frames
 * are enough for React to flush the updates the last call made. A case asserts
 * that a row or a toast did NOT change, which `toHaveAttribute` and
 * `toHaveText` would pass at once if they ran before the render.
 */
async function settleRender(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test.describe('Agents paused for low memory', () => {
  test('the first pause raises one persistent toast, and later ones update it in place', async () => {
    const { browser, page } = await launchPage();
    try {
      await firePaused(page, pausedEvent('task-1'));
      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('Idle agent paused');
      await expect(toast.getByTestId('toast-body')).toHaveText('Kangentic paused it to free memory.');
      await expect(toast).toHaveAttribute('data-persistent', 'true');
      await expect(toast.getByTestId('toast-action')).toHaveText('Review');

      await firePaused(page, pausedEvent('task-2'));
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('2 idle agents paused');
      await expect(toast.getByTestId('toast-body')).toHaveText('Kangentic paused them to free memory.');
    } finally {
      await browser.close();
    }
  });

  test('Review lists the agents oldest wait first, naming the project when they span projects', async () => {
    const { browser, page } = await launchPage();
    try {
      await firePaused(page, pausedEvent('task-short', { taskTitle: 'Update pricing page copy', waitedMs: 18 * 60_000, projectId: 'proj-2', projectName: 'kangentic.com' }));
      await firePaused(page, pausedEvent('task-long', { taskTitle: 'Fix login redirect', waitedMs: 3 * 60 * 60_000 }));
      await firePaused(page, pausedEvent('task-mid', { taskTitle: 'Add board search', waitedMs: 52 * 60_000 }));

      await page.getByTestId('toast-action').click();
      const dialog = page.getByTestId('paused-for-memory-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('3 agents paused to free memory');
      await expect(dialog).toContainText('They stay paused until you resume them.');

      const rows = dialog.getByTestId('paused-for-memory-row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText('Fix login redirect');
      await expect(rows.nth(0)).toContainText('kangentic, waited 3 hours');
      await expect(rows.nth(1)).toContainText('Add board search');
      await expect(rows.nth(2)).toContainText('kangentic.com, waited 18 minutes');
      await expect(dialog.getByTestId('paused-for-memory-resume')).toHaveCount(3);
    } finally {
      await browser.close();
    }
  });

  test('Resume brings the agent back and its row reads Running', async () => {
    const { browser, page } = await launchPage();
    try {
      // The mock's sessions.resume answers with a session; record the call.
      await page.evaluate(() => {
        const sessions = window.electronAPI.sessions as unknown as {
          resume: (taskId: string, resumePrompt?: string, projectId?: string | null) => Promise<unknown>;
        };
        (window as unknown as { __resumeCalls: unknown[][] }).__resumeCalls = [];
        sessions.resume = async (taskId, resumePrompt, projectId) => {
          (window as unknown as { __resumeCalls: unknown[][] }).__resumeCalls.push([taskId, resumePrompt, projectId]);
          return { id: 'sess-resumed', taskId, projectId, status: 'running' };
        };
      });
      await firePaused(page, pausedEvent('task-1', { projectId: 'proj-9' }));
      await page.getByTestId('toast-action').click();

      const row = page.getByTestId('paused-for-memory-row');
      await row.getByTestId('paused-for-memory-resume').click();

      await expect(row).toHaveAttribute('data-state', 'running');
      await expect(row.getByTestId('paused-for-memory-running')).toHaveText('Running');
      const calls = await page.evaluate(() => (window as unknown as { __resumeCalls: unknown[][] }).__resumeCalls);
      // The task's own project, not whichever one is on screen.
      expect(calls).toEqual([['task-1', undefined, 'proj-9']]);
    } finally {
      await browser.close();
    }
  });

  test('a row reads Running when its task comes back by any route, not only its own Resume button', async () => {
    const { browser, page } = await launchPage();
    try {
      // Record Resume calls: none may happen, so the state below can only have
      // come from the session store and not from this row's own button.
      await page.evaluate(() => {
        const sessions = window.electronAPI.sessions as unknown as {
          resume: (taskId: string, resumePrompt?: string, projectId?: string | null) => Promise<unknown>;
        };
        (window as unknown as { __resumeCalls: unknown[][] }).__resumeCalls = [];
        sessions.resume = async (taskId, resumePrompt, projectId) => {
          (window as unknown as { __resumeCalls: unknown[][] }).__resumeCalls.push([taskId, resumePrompt, projectId]);
          return null;
        };
      });
      await firePaused(page, pausedEvent('task-1', { projectId: 'proj-9' }));
      await firePaused(page, pausedEvent('task-2', { projectId: 'proj-9', waitedMs: 5 * 60_000 }));
      await page.getByTestId('toast-action').click();

      const row = page.locator('[data-testid="paused-for-memory-row"][data-task-id="task-1"]');
      const otherRow = page.locator('[data-testid="paused-for-memory-row"][data-task-id="task-2"]');
      await expect(row).toHaveAttribute('data-state', 'paused');

      // Back through some other route (its card, its window, a move): the store
      // gains a session for the task. A PAUSED session is not Running...
      await upsertSession(page, { id: 'sess-elsewhere', taskId: 'task-1', status: 'suspended' });
      await expect(row).toHaveAttribute('data-state', 'paused');

      // ...and the same session going live is.
      await upsertSession(page, { id: 'sess-elsewhere', taskId: 'task-1', status: 'running' });
      await expect(row).toHaveAttribute('data-state', 'running');
      await expect(row.getByTestId('paused-for-memory-running')).toHaveText('Running');
      // The row of a task that did not come back is untouched.
      await expect(otherRow).toHaveAttribute('data-state', 'paused');

      const calls = await page.evaluate(() => (window as unknown as { __resumeCalls: unknown[][] }).__resumeCalls);
      expect(calls).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('a task paused again gets a fresh row, so the earlier Resume click does not keep it Running', async () => {
    const { browser, page } = await launchPage();
    try {
      // Resume resolves with a session but pushes nothing into the session
      // store, so the only thing that can read Running is this row's own click.
      await page.evaluate(() => {
        const sessions = window.electronAPI.sessions as unknown as {
          resume: (taskId: string, resumePrompt?: string, projectId?: string | null) => Promise<unknown>;
        };
        sessions.resume = async (taskId, _resumePrompt, projectId) => ({ id: 'sess-resumed', taskId, projectId, status: 'running' });
      });
      await firePaused(page, pausedEvent('task-1', { projectId: 'proj-9' }));
      await page.getByTestId('toast-action').click();

      const row = page.locator('[data-testid="paused-for-memory-row"][data-task-id="task-1"]');
      await row.getByTestId('paused-for-memory-resume').click();
      await expect(row).toHaveAttribute('data-state', 'running');

      // The same task is paused again, later than the first pause. The Review
      // list is still open, and rows are keyed by task and pause time.
      await firePaused(page, pausedEvent('task-1', { projectId: 'proj-9', pausedAt: new Date().toISOString() }));

      await expect(row).toHaveAttribute('data-state', 'paused');
      await expect(row.getByTestId('paused-for-memory-resume')).toBeVisible();
      await expect(row.getByTestId('paused-for-memory-running')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a paused session still listed as running does not read Running', async () => {
    const { browser, page } = await launchPage();
    try {
      // The replica lists the paused session as running when the pause lands:
      // it started two minutes back, before the pause the event stamps a
      // minute back.
      await upsertSession(page, {
        id: 'sess-paused',
        taskId: 'task-1',
        status: 'running',
        startedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });
      await firePaused(page, pausedEvent('task-1'));

      const toast = page.getByTestId('toast');
      await expect(toast.getByTestId('toast-title')).toHaveText('Idle agent paused');
      await toast.getByTestId('toast-action').click();

      const row = page.locator('[data-testid="paused-for-memory-row"][data-task-id="task-1"]');
      await expect(row).toHaveAttribute('data-state', 'paused');
      await expect(row.getByTestId('paused-for-memory-resume')).toBeVisible();
      await expect(row.getByTestId('paused-for-memory-running')).toHaveCount(0);
      // Opening the list took nothing down.
      await expect(toast.getByTestId('toast-title')).toHaveText('Idle agent paused');
    } finally {
      await browser.close();
    }
  });

  test('a row keeps reading Running after its agent comes back and then stops', async () => {
    const { browser, page } = await launchPage();
    try {
      await firePaused(page, pausedEvent('task-1', { projectId: 'proj-9' }));
      await firePaused(page, pausedEvent('task-2', { projectId: 'proj-9', waitedMs: 5 * 60_000 }));
      const toast = page.getByTestId('toast');
      await expect(toast.getByTestId('toast-title')).toHaveText('2 idle agents paused');
      await toast.getByTestId('toast-action').click();

      const row = page.locator('[data-testid="paused-for-memory-row"][data-task-id="task-1"]');
      const otherRow = page.locator('[data-testid="paused-for-memory-row"][data-task-id="task-2"]');
      await expect(row).toHaveAttribute('data-state', 'paused');

      // Back through some route other than the Review list.
      await upsertSession(page, { id: 'sess-elsewhere', taskId: 'task-1', status: 'running' });
      await expect(row).toHaveAttribute('data-state', 'running');
      await expect(toast.getByTestId('toast-title')).toHaveText('Idle agent paused');

      // The same session stops. Wait for the store to hold it and the page to
      // paint, so the assertions below read the state after the stop.
      await upsertSession(page, { id: 'sess-elsewhere', taskId: 'task-1', status: 'suspended' });
      await expect.poll(() => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { session: { getState: () => { sessions: Array<{ id: string; status: string }> } } };
        }).__zustandStores;
        return stores?.session.getState().sessions.find((session) => session.id === 'sess-elsewhere')?.status;
      })).toBe('suspended');
      await settleRender(page);

      // It came back once, so it is neither paused again nor counted again.
      await expect(row).toHaveAttribute('data-state', 'running');
      await expect(row.getByTestId('paused-for-memory-running')).toHaveText('Running');
      await expect(toast.getByTestId('toast-title')).toHaveText('Idle agent paused');
      // The other task is still paused.
      await expect(otherRow).toHaveAttribute('data-state', 'paused');
    } finally {
      await browser.close();
    }
  });

  test('the toast counts down as agents come back by any route, and closes once none is paused', async () => {
    const { browser, page } = await launchPage();
    try {
      await firePaused(page, pausedEvent('task-1', { projectId: 'proj-9' }));
      await firePaused(page, pausedEvent('task-2', { projectId: 'proj-9' }));
      const toast = page.getByTestId('toast');
      await expect(toast.getByTestId('toast-title')).toHaveText('2 idle agents paused');

      // Back through some route other than the Review list (its card, its
      // window, a move): the store gains a running session for the task.
      const upsertRunning = (taskId: string) => upsertSession(page, { id: `sess-${taskId}`, taskId, status: 'running' });

      await upsertRunning('task-1');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('Idle agent paused');
      await expect(toast.getByTestId('toast-body')).toHaveText('Kangentic paused it to free memory.');

      await upsertRunning('task-2');
      await expect(toast).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('with Review open, Resume on the last row takes the toast down and the list stays, reading Running', async () => {
    const { browser, page } = await launchPage();
    try {
      // Resume answers as main does: its session-changed push for the new
      // session reaches the store, then the call resolves with that session.
      await page.evaluate(() => {
        const sessions = window.electronAPI.sessions as unknown as {
          resume: (taskId: string, resumePrompt?: string, projectId?: string | null) => Promise<unknown>;
        };
        sessions.resume = async (taskId, _resumePrompt, projectId) => {
          const session = {
            id: 'sess-resumed',
            taskId,
            projectId,
            pid: 4242,
            status: 'running',
            shell: 'bash',
            cwd: '/mock/paused-for-memory',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: true,
            agentSessionId: null,
          };
          const fireStatus = (window as unknown as { __mockFireStatus?: (sessionId: string, payload: unknown) => void }).__mockFireStatus;
          if (!fireStatus) throw new Error('__mockFireStatus not installed (no onStatus subscriber?)');
          fireStatus(session.id, session);
          return session;
        };
      });
      await firePaused(page, pausedEvent('task-1', { projectId: 'proj-9' }));
      await page.getByTestId('toast-action').click();

      const dialog = page.getByTestId('paused-for-memory-dialog');
      const row = dialog.getByTestId('paused-for-memory-row');
      await row.getByTestId('paused-for-memory-resume').click();

      await expect(page.getByTestId('toast')).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(row).toHaveAttribute('data-state', 'running');
      await expect(row.getByTestId('paused-for-memory-running')).toHaveText('Running');

      await dialog.getByTestId('paused-for-memory-close').click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a refused Resume toasts the card menu\'s one-sentence reason and leaves the row paused', async () => {
    const { browser, page } = await launchPage();
    try {
      // Main throws the refusal's two-sentence guidance, and Electron decorates
      // it with the channel and the class, as a real rejection arrives.
      await page.evaluate(() => {
        const sessions = window.electronAPI.sessions as unknown as { resume: () => Promise<unknown> };
        sessions.resume = async () => {
          throw new Error("Error invoking remote method 'session:resume': Error: This task is complete. Move it out of Done to continue working on it.");
        };
      });
      await firePaused(page, pausedEvent('task-1'));
      await page.getByTestId('toast-action').click();

      const row = page.getByTestId('paused-for-memory-row');
      await row.getByTestId('paused-for-memory-resume').click();

      const refusal = page.getByTestId('toast').filter({ has: page.getByTestId('toast-title').getByText("Couldn't resume session", { exact: true }) });
      await expect(refusal.getByTestId('toast-body')).toHaveText('The task is in Done.');
      await expect(refusal).toHaveAttribute('data-variant', 'warning');
      await expect(row).toHaveAttribute('data-state', 'paused');
    } finally {
      await browser.close();
    }
  });

  test('memory recovering leaves the paused toast up, since the agents stay paused', async () => {
    const { browser, page } = await launchPage();
    try {
      await firePaused(page, pausedEvent('task-1'));
      await expect(page.getByTestId('toast')).toHaveCount(1);

      await page.evaluate(() => {
        window.__mockFireHostMemoryRecovery?.({
          sample: {
            ts: new Date().toISOString(),
            platform: 'win32',
            commitLimitBytes: 64 * 1024 * 1024 * 1024,
            commitRemainingBytes: 32 * 1024 * 1024 * 1024,
            physicalTotalBytes: 32 * 1024 * 1024 * 1024,
            physicalFreeBytes: 8 * 1024 * 1024 * 1024,
            physicalAvailableBytes: null,
          },
        });
      });

      // A fixed wait: what is asserted is that nothing takes the toast down.
      await page.waitForTimeout(500);
      await expect(page.getByTestId('toast-title')).toHaveText('Idle agent paused');
    } finally {
      await browser.close();
    }
  });
});
