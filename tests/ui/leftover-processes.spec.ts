/**
 * The leftover-process toast and its Review list, driven over the mock bridge:
 * a report main pushes after a task ends becomes a counts-only toast, Review
 * opens the list, and a row's Stop walks Stop, Stopping, then Stopped, Ended
 * or a red failure in the same slot. A toast for a report that leaves something
 * running or could not be stopped stays until the user closes it (Review is the
 * only way into the list), while one for a report where every process was
 * stopped closes on its own like any other toast.
 *
 * Every test launches its own page (cross-platform-parity.md).
 *
 * Tier: UI (headless Chromium). No PTY, no Electron main process.
 */
import { test, expect, chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import path from 'node:path';
import { launchPage, waitForViteReady, gotoVite } from './helpers';
import type { LeftoverProcess, LeftoverProcessReport } from '../../src/shared/types';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');

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
      await expect(chrome).toContainText('Has an open window.');
      await chrome.getByRole('button', { name: 'Stop chrome' }).click();
      await expect(chrome).toHaveAttribute('data-state', 'stopped', { timeout: 5000 });
      await expect(chrome.locator('[data-testid="leftover-process-stop"]')).toHaveText('Stopped');
      // Stopped, it reads like any stopped row: the window it was kept for is gone.
      await expect(chrome).toContainText('Ran in the worktree.');
      await expect(chrome).not.toContainText('Has an open window.');
      // The row stayed in its section, in its place: state, not pixels.
      await expect(runningRows.nth(0)).toContainText('chrome');
      await expect(runningRows.nth(1)).toContainText('tmux');
      expect(await page.evaluate(() => window.__mockLeftoverStopCalls)).toEqual(['kept-chrome']);
    } finally {
      await browser.close();
    }
  });

  test('a row reads Stopping, with its button disabled, until main answers, then Stopped', async () => {
    const { browser, page } = await launchPage();
    try {
      // Hold main's answer open so the in-between state can be observed. The gate
      // is test-only: the mock awaits it only when set, so every other test and the
      // web demo get an immediate answer.
      await page.evaluate(() => {
        window.__mockLeftoverStopGate = new Promise<void>((resolve) => { window.__mockReleaseLeftoverStopGate = resolve; });
      });
      await fireReport(page, ONE_TASK);
      await openReview(page, '2 still running.');

      const chrome = row(page, 'chrome');
      const action = chrome.locator('[data-testid="leftover-process-stop"]');
      await expect(chrome).toHaveAttribute('data-state', 'running');

      await chrome.getByRole('button', { name: 'Stop chrome' }).click();

      // Stopping: a spinner in a disabled button, and no Stop button left to press twice.
      await expect(chrome).toHaveAttribute('data-state', 'stopping', { timeout: 5000 });
      await expect(action).toBeDisabled();
      await expect(action).toHaveText('Stopping');
      await expect(action.locator('svg.animate-spin')).toHaveCount(1);
      await expect(chrome.getByRole('button', { name: 'Stop chrome' })).toHaveCount(0);
      expect(await page.evaluate(() => window.__mockLeftoverStopCalls)).toEqual(['kept-chrome']);

      await page.evaluate(() => window.__mockReleaseLeftoverStopGate?.());

      await expect(chrome).toHaveAttribute('data-state', 'stopped', { timeout: 5000 });
      await expect(action).toHaveText('Stopped');
      await expect(action).toBeDisabled();
      await expect(action.locator('svg.animate-spin')).toHaveCount(0);
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

/**
 * `launchPage` with a short `notifications.toasts.durationSeconds`, so a timed
 * toast closes in a second or two instead of the mock's four.
 *
 * The override rides `window.__mockConfigOverrides`, which must be set BEFORE
 * the mock script reads it (the same order session-exit-intentional.spec.ts
 * uses), so the config main hands the renderer already carries it. Patching the
 * config store after load would race the boot-time `loadConfig`, which can land
 * later and put the default back. It replaces the whole `notifications` object
 * (a shallow merge), so the full shape is restated.
 */
async function launchPageWithToastSeconds(durationSeconds: number): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.addInitScript(`
      window.__mockConfigOverrides = {
        notifications: {
          desktop: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true, onSpawnStalled: true },
          toasts: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true, onSpawnStalled: true, durationSeconds: ${durationSeconds}, maxCount: 5 },
          cooldownSeconds: 10,
        },
      };
    `);
    await page.addInitScript({ path: MOCK_SCRIPT });
    await gotoVite(page);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });

    // A toast reads its lifetime from the store when it is raised. Wait for the
    // store to hold the override, so a toast fired next cannot get the default.
    await expect
      .poll(() => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { config: { getState: () => { config: { notifications: { toasts: { durationSeconds: number } } } } } };
        }).__zustandStores;
        return stores?.config.getState().config.notifications.toasts.durationSeconds ?? null;
      }), { timeout: 5000 })
      .toBe(durationSeconds);
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

test.describe('Leftover processes toast lifetime', () => {
  test('a toast that leaves a process running outlives the auto-dismiss time, so Review stays reachable', async () => {
    const { browser, page } = await launchPageWithToastSeconds(1);
    try {
      // ONE_TASK stopped one process and left two running, which makes the toast sticky.
      await fireReport(page, ONE_TASK);
      const toast = page.locator('[data-testid="toast"]', { hasText: '2 still running.' });
      await expect(toast).toBeVisible({ timeout: 5000 });

      // A timed toast would be gone after its 1 s, plus its exit (250 ms, or the
      // 1 s fallback in ToastItem when the transition never ends). Give it that
      // and 1 s more to leave. Leaving is polled for rather than slept through,
      // so a regression to a timed toast fails as soon as it leaves; the cost
      // of the passing case is the full budget, because "it never leaves" is a
      // non-occurrence that cannot be polled for. `toBeVisible` alone would not
      // do: a toast mid-exit sits at opacity 0 and still reads as visible.
      const leftOnItsOwn = await toast.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false);
      expect(leftOnItsOwn).toBe(false);

      // And it still does its job: Review opens the list well past the 1 s.
      await toast.getByRole('button', { name: 'Review' }).click();
      await expect(page.locator('[data-testid="leftover-processes-dialog"]')).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a waiting toast closes once its report is no longer kept for Review', async () => {
    // The store keeps 20 reports. A waiting toast outlives the timed toasts the
    // newer reports raise, so without this its Review link would open nothing.
    const { browser, page } = await launchPage();
    try {
      await fireReport(page, ONE_TASK);
      const waitingToast = page.locator('[data-testid="toast"]', { hasText: '2 still running.' });
      await expect(waitingToast).toBeVisible({ timeout: 5000 });

      const stoppedOnly = (index: number): LeftoverProcessReport => ({
        id: `report-stopped-${index}`,
        stoppingEnabled: true,
        processes: [leftover(`stopped-${index}`)],
      });
      // Nineteen newer reports fill the store to 20 and keep ONE_TASK's report.
      await page.evaluate((reports) => {
        for (const report of reports) window.__mockFireLeftoverReport?.(report);
      }, Array.from({ length: 19 }, (_unused, index) => stoppedOnly(index)));
      // Positive control: its toast still stands, and Review still opens the list.
      await expect(waitingToast).toBeVisible();
      await waitingToast.getByRole('button', { name: 'Review' }).click();
      await expect(page.locator('[data-testid="leftover-processes-dialog"]')).toContainText('Processes from "Fix login"');
      await page.locator('[data-testid="leftover-processes-close"]').click();

      // The twentieth evicts ONE_TASK's report, and its toast goes with it.
      await fireReport(page, stoppedOnly(19));
      await waitingToast.waitFor({ state: 'detached', timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a toast for a report where every process was stopped closes on its own', async () => {
    // 2 s rather than 1: this test has to SEE the toast before it can see it
    // leave, and a starved worker should not lose it in the gap between the
    // report firing and the first look.
    const { browser, page } = await launchPageWithToastSeconds(2);
    try {
      await fireReport(page, {
        id: 'report-all-stopped',
        stoppingEnabled: true,
        processes: [leftover('only-vite')],
      });
      const toast = page.locator('[data-testid="toast"]', { hasText: 'Stopped 1 leftover process from "Fix login".' });
      await expect(toast).toBeVisible({ timeout: 5000 });

      // Nothing is left to review, so the toast takes the configured 2 s, plus its
      // exit, plus slack for a loaded runner. Polled, so it passes as soon as it
      // leaves. A retrying zero-count assertion is avoided on purpose (see
      // toastCountRightNow in helpers.ts).
      await toast.waitFor({ state: 'detached', timeout: 6000 });
    } finally {
      await browser.close();
    }
  });
});
