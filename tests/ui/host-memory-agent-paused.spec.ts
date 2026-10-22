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
 *   row reads Running. A refused Resume toasts the card menu's own copy.
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
    pausedAt: new Date().toISOString(),
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
