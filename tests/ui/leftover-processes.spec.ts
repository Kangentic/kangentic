/**
 * The leftover-process toast and its Review list, driven over the mock bridge:
 * a report main pushes after a task ends becomes a counts-only toast, Review
 * opens the list, and a row's Stop walks Stop, Stopping, then Stopped, Ended
 * or a red failure in the same slot.
 *
 * Every test launches its own page (cross-platform-parity.md).
 *
 * Tier: UI (headless Chromium). No PTY, no Electron main process.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchPage } from './helpers';
import type { LeftoverProcess, LeftoverProcessReport } from '../../src/shared/types';

test.describe.configure({ mode: 'parallel' });

function leftover(id: string, overrides: Partial<LeftoverProcess> = {}): LeftoverProcess {
  return {
    id,
    taskId: 'task-a',
    taskTitle: 'Fix login',
    pid: 48211,
    label: 'node (vite)',
    outcome: 'stopped',
    reason: null,
    place: 'worktree',
    ...overrides,
  };
}

const ONE_TASK: LeftoverProcessReport = {
  id: 'report-one-task',
  stoppingEnabled: true,
  processes: [
    leftover('stopped-vite'),
    leftover('kept-chrome', { pid: 51220, label: 'chrome', outcome: 'kept', reason: 'window' }),
    leftover('kept-tmux', { pid: 3304, label: 'tmux', outcome: 'kept', reason: 'multiplexer' }),
  ],
};

async function fireReport(page: Page, report: LeftoverProcessReport): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__mockFireLeftoverReport === 'function'), { timeout: 5000 })
    .toBe(true);
  await page.evaluate((payload) => window.__mockFireLeftoverReport?.(payload), report);
}

async function openReview(page: Page, message: string): Promise<void> {
  const toast = page.locator('[data-testid="toast"]', { hasText: message });
  await expect(toast).toBeVisible({ timeout: 5000 });
  await toast.getByRole('button', { name: 'Review' }).click();
  await expect(page.locator('[data-testid="leftover-processes-dialog"]')).toBeVisible({ timeout: 5000 });
}

function row(page: Page, text: string) {
  return page.locator('[data-testid="leftover-process-row"]', { hasText: text });
}

test.describe('Leftover processes', () => {
  test('a report becomes a counts-only toast, and Review lists still running first, then stopped', async () => {
    const { browser, page } = await launchPage();
    try {
      await fireReport(page, ONE_TASK);
      await openReview(page, 'Stopped 1 leftover process from "Fix login". 2 still running.');

      const dialog = page.locator('[data-testid="leftover-processes-dialog"]');
      await expect(dialog).toContainText('Processes from "Fix login"');
      await expect(page.locator('[data-testid="leftover-processes-running"] [data-testid="leftover-process-row"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="leftover-processes-stopped"] [data-testid="leftover-process-row"]')).toHaveCount(1);
      await expect(row(page, 'chrome')).toContainText('Has an open window.');
      await expect(row(page, 'tmux')).toContainText('A tmux server. Stopping it ends all your tmux sessions.');
      await expect(row(page, 'node')).toContainText('Ran in the worktree.');
      await expect(row(page, 'node')).toContainText('PID 48211');
      await expect(row(page, 'node').locator('[data-testid="leftover-process-stop"]')).toBeDisabled();
      await expect(row(page, 'node').locator('[data-testid="leftover-process-stop"]')).toHaveText('Stopped');
    } finally {
      await browser.close();
    }
  });

  test('Stop stops one row in place, by its report id', async () => {
    const { browser, page } = await launchPage();
    try {
      await fireReport(page, ONE_TASK);
      await openReview(page, '2 still running.');

      const chrome = row(page, 'chrome');
      const runningRows = page.locator('[data-testid="leftover-processes-running"] [data-testid="leftover-process-row"]');
      await chrome.getByRole('button', { name: 'Stop chrome' }).click();
      await expect(chrome).toHaveAttribute('data-state', 'stopped', { timeout: 5000 });
      await expect(chrome.locator('[data-testid="leftover-process-stop"]')).toHaveText('Stopped');
      // The row stayed in its section, in its place: state, not pixels.
      await expect(runningRows.nth(0)).toContainText('chrome');
      await expect(runningRows.nth(1)).toContainText('tmux');
      expect(await page.evaluate(() => window.__mockLeftoverStopCalls)).toEqual(['kept-chrome']);
    } finally {
      await browser.close();
    }
  });

  test('a stop that fails reads red and can be tried again; one already gone reads ended', async () => {
    const { browser, page } = await launchPage();
    try {
      await page.evaluate(() => { window.__mockLeftoverStopOutcomes = { 'kept-chrome': 'failed', 'kept-tmux': 'ended' }; });
      await fireReport(page, ONE_TASK);
      await openReview(page, '2 still running.');

      await row(page, 'chrome').getByRole('button', { name: 'Stop chrome' }).click();
      await expect(row(page, 'chrome')).toHaveAttribute('data-state', 'failed', { timeout: 5000 });
      await expect(row(page, 'chrome')).toContainText("Couldn't stop it. Try again, or close it yourself.");
      await expect(row(page, 'chrome').getByRole('button', { name: 'Stop chrome' })).toBeEnabled();

      await row(page, 'tmux').getByRole('button', { name: 'Stop tmux' }).click();
      await expect(row(page, 'tmux')).toHaveAttribute('data-state', 'ended', { timeout: 5000 });
      await expect(row(page, 'tmux')).toContainText('No longer running.');
      await expect(row(page, 'tmux').locator('[data-testid="leftover-process-stop"]')).toHaveText('Ended');
    } finally {
      await browser.close();
    }
  });

  test('a report that spans tasks is one toast, with the list grouped by task', async () => {
    const { browser, page } = await launchPage();
    try {
      await fireReport(page, {
        id: 'report-several',
        stoppingEnabled: true,
        processes: [
          leftover('a-vite'),
          leftover('b-jest', { taskId: 'task-b', taskTitle: 'Update deps', label: 'node (jest)', place: 'project' }),
          leftover('c-http', { taskId: 'task-c', taskTitle: 'Add search', label: 'python3 (http.server)' }),
          leftover('c-code', { taskId: 'task-c', taskTitle: 'Add search', label: 'Code', outcome: 'kept', reason: 'window' }),
        ],
      });
      await openReview(page, 'Stopped 3 leftover processes from 3 tasks. 1 still running.');
      await expect(page.locator('[data-testid="leftover-processes-dialog"]')).toContainText('Processes from 3 tasks');
      const stopped = page.locator('[data-testid="leftover-processes-stopped"]');
      await expect(stopped).toContainText('Fix login');
      await expect(stopped).toContainText('Update deps');
      await expect(row(page, 'jest')).toContainText('Ran in the project folder.');
    } finally {
      await browser.close();
    }
  });

  test('with stopping turned off, the list says so and links to the setting', async () => {
    const { browser, page } = await launchPage();
    try {
      await fireReport(page, {
        id: 'report-off',
        stoppingEnabled: false,
        processes: [leftover('off-vite', { outcome: 'kept' }), leftover('off-chrome', { label: 'chrome', outcome: 'kept', reason: 'window' })],
      });
      await openReview(page, '"Fix login" left 2 processes running.');
      await expect(page.locator('[data-testid="leftover-processes-stopping-off"]')).toContainText('Stopping leftover processes is off');
      await expect(row(page, 'node')).toContainText('Runs in the worktree.');
      await expect(row(page, 'node').getByRole('button', { name: 'Stop node (vite)' })).toBeEnabled();

      await page.getByRole('button', { name: 'Change in Settings' }).click();
      await expect(page.locator('[data-testid="leftover-processes-dialog"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="setting-row-stopLeftoverProcesses"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="setting-row-stopLeftoverProcesses"]')).toHaveAttribute('aria-checked', 'true');
    } finally {
      await browser.close();
    }
  });
});
