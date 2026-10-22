/**
 * The leftover-process toast and its Review list, driven over the mock bridge:
 * a report main pushes after a task ends becomes a counts-only toast that opens
 * the list, and a row's Stop walks Stop, Stopping, then Stopped, Ended or a red
 * failure in the same slot. A toast for a report that leaves something running
 * or could not be stopped stays until the user closes it and opens the list
 * with its Review button, leads with what is still running, and shows how long
 * ago the report came, as does the list's header, and both labels keep ticking
 * while they stay on screen. One that closes on its own (every process stopped,
 * or stopping turned off) has no button: a click on its card opens the list,
 * and it shows no age.
 *
 * Every test launches its own page (cross-platform-parity.md).
 *
 * Tier: UI (headless Chromium). No PTY, no Electron main process.
 */
import { test, expect, chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import path from 'node:path';
import { launchPage, waitForViteReady, gotoVite } from './helpers';
import { LEFTOVER_RECHECK_FAST_MS } from '../../src/renderer/lib/leftover-processes';
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

/** A report as a test writes it: `fireReport` stamps the time main would. */
type TestReport = Omit<LeftoverProcessReport, 'reportedAt'> & { reportedAt?: string };

const ONE_TASK: TestReport = {
  id: 'report-one-task',
  stoppingEnabled: true,
  processes: [
    leftover('stopped-vite'),
    leftover('kept-chrome', { pid: 51220, label: 'chrome', outcome: 'kept', reason: 'window' }),
    leftover('kept-tmux', { pid: 3304, label: 'tmux', outcome: 'kept', reason: 'multiplexer' }),
  ],
};

/**
 * Ten seconds past 37 minutes before the push, so the age reads "37 minutes
 * ago" (whole minutes, rounded down) for the next 49 seconds of the test.
 */
const REPORT_AGE_MS = 37 * 60_000 + 10_000;

async function fireReport(page: Page, report: TestReport): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__mockFireLeftoverReport === 'function'), { timeout: 5000 })
    .toBe(true);
  const stamped: LeftoverProcessReport = { reportedAt: new Date(Date.now() - REPORT_AGE_MS).toISOString(), ...report };
  await page.evaluate((payload) => window.__mockFireLeftoverReport?.(payload), stamped);
}

/** Open the list with the Review button of a toast that stays up. */
async function openReview(page: Page, message: string): Promise<void> {
  const toast = page.locator('[data-testid="toast"]', { hasText: message });
  await expect(toast).toBeVisible({ timeout: 5000 });
  await expect(toast).toHaveAttribute('data-persistent', 'true');
  await toast.getByRole('button', { name: 'Review' }).click();
  await expect(page.locator('[data-testid="leftover-processes-dialog"]')).toBeVisible({ timeout: 5000 });
}

/** Open the list from a timed toast, which has no button: its card opens the list. */
async function openListFromCard(page: Page, message: string): Promise<void> {
  const toast = page.locator('[data-testid="toast"]', { hasText: message });
  await expect(toast).toBeVisible({ timeout: 5000 });
  await expect(toast).toHaveAttribute('data-persistent', 'false');
  expect(await toast.getByTestId('toast-action').count()).toBe(0);
  await toast.getByTestId('toast-body').click();
  await expect(page.locator('[data-testid="leftover-processes-dialog"]')).toBeVisible({ timeout: 5000 });
}

function row(page: Page, text: string) {
  return page.locator('[data-testid="leftover-process-row"]', { hasText: text });
}

test.describe('Leftover processes', () => {
  test('a report becomes a counts-only toast with its age, and Review lists still running first, then stopped', async () => {
    const { browser, page } = await launchPage();
    try {
      await fireReport(page, ONE_TASK);
      const toast = page.locator('[data-testid="toast"]', { hasText: '2 processes from "Fix login" are still running.' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast.getByTestId('toast-title')).toHaveText('Processes still running');
      await expect(toast.getByTestId('toast-body')).toHaveText('2 processes from "Fix login" are still running.');
      // What stopped is in the list, not the toast.
      await expect(toast).not.toContainText('Stopped');
      await expect(toast.locator('[data-testid="toast-age"]')).toHaveText('37 minutes ago');
      await openReview(page, 'are still running.');

      const dialog = page.locator('[data-testid="leftover-processes-dialog"]');
      await expect(dialog).toContainText('Processes from "Fix login"');
      const age = dialog.locator('[data-testid="leftover-processes-age"]');
      await expect(age).toHaveText('37 minutes ago');
      // The exact time is on hover, outside the heading, so the dialog's name stays its title.
      await expect(age).toHaveAccessibleDescription(/\d/);
      await expect(dialog.getByRole('heading')).toHaveText('Processes from "Fix login"');
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
      await openReview(page, 'are still running.');

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
      await openReview(page, 'are still running.');

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
      await openReview(page, 'are still running.');

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

  test('a stop that read failed because main stopped waiting corrects itself when the host finishes it', async () => {
    // Main answers `failed` when a Stop runs past its budget, but the host still
    // finishes it and main pushes the real outcome (`onStopSettled`).
    const { browser, page } = await launchPage();
    try {
      await page.evaluate(() => { window.__mockLeftoverStopOutcomes = { 'kept-chrome': 'failed' }; });
      await fireReport(page, ONE_TASK);
      await openReview(page, 'are still running.');

      await row(page, 'chrome').getByRole('button', { name: 'Stop chrome' }).click();
      await expect(row(page, 'chrome')).toHaveAttribute('data-state', 'failed', { timeout: 5000 });

      await expect
        .poll(() => page.evaluate(() => typeof window.__mockFireLeftoverStopSettled === 'function'), { timeout: 5000 })
        .toBe(true);
      await page.evaluate(() => window.__mockFireLeftoverStopSettled?.({ processId: 'kept-chrome', outcome: 'stopped' }));

      await expect(row(page, 'chrome')).toHaveAttribute('data-state', 'stopped', { timeout: 5000 });
      await expect(row(page, 'chrome').locator('[data-testid="leftover-process-stop"]')).toHaveText('Stopped');
      // The push named one row: the other running row is untouched.
      await expect(row(page, 'tmux')).toHaveAttribute('data-state', 'running');
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
      await openReview(page, '1 process from 3 tasks is still running.');
      await expect(page.locator('[data-testid="leftover-processes-dialog"]')).toContainText('Processes from 3 tasks');
      const stopped = page.locator('[data-testid="leftover-processes-stopped"]');
      await expect(stopped).toContainText('Fix login');
      await expect(stopped).toContainText('Update deps');
      await expect(row(page, 'jest')).toContainText('Ran in the project folder.');
    } finally {
      await browser.close();
    }
  });

  test('with stopping turned off, the timed toast\'s card opens the list, which says so and links to the setting', async () => {
    const { browser, page } = await launchPage();
    try {
      await fireReport(page, {
        id: 'report-off',
        stoppingEnabled: false,
        processes: [leftover('off-vite', { outcome: 'kept' }), leftover('off-chrome', { label: 'chrome', outcome: 'kept', reason: 'window' })],
      });
      const toast = page.locator('[data-testid="toast"]', { hasText: '"Fix login" left 2 processes running.' });
      await expect(toast.getByTestId('toast-title')).toHaveText('Leftover processes', { timeout: 5000 });
      await openListFromCard(page, '"Fix login" left 2 processes running.');
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

/**
 * `launchPage` with Playwright's fake clock installed before the app boots, so a
 * test can move page time with `page.clock.runFor`. The clock is installed
 * before navigation (the same order spawn-stall-toast.spec.ts uses) because it
 * can only fake timers the page creates after it. Without `pauseAt`, page time
 * still flows with real time, so the app boots and animates as it normally does.
 */
async function launchPageWithClock(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.clock.install();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await gotoVite(page);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

test.describe('Leftover processes age label', () => {
  test('the toast and the open list both keep their age current as time passes', async () => {
    const { browser, page } = await launchPageWithClock();
    try {
      // Stamp the report from the PAGE's clock, which the fake clock owns, not
      // the test process's: the two only agree by accident.
      const pageNow = await page.evaluate(() => Date.now());
      await fireReport(page, { ...ONE_TASK, reportedAt: new Date(pageNow - REPORT_AGE_MS).toISOString() });
      const toast = page.locator('[data-testid="toast"]', { hasText: 'are still running.' });
      const toastAge = toast.locator('[data-testid="toast-age"]');
      await expect(toastAge).toHaveText('37 minutes ago', { timeout: 5000 });

      // The list has to be open BEFORE time moves. A list opened afterwards
      // reads the new time when it mounts and would pass with no interval at all.
      await openReview(page, 'are still running.');
      const listAge = page.locator('[data-testid="leftover-processes-dialog"] [data-testid="leftover-processes-age"]');
      await expect(listAge).toHaveText('37 minutes ago');

      // 37m10s plus a minute is 38m10s: past the next minute boundary, short of 39.
      // Both labels re-read the clock on a 30 s tick, so the jump covers two ticks.
      await page.clock.runFor(60_000);

      // The toast stays up behind the list (Review does not dismiss it), so both
      // labels are on screen the whole time.
      await expect(listAge).toHaveText('38 minutes ago', { timeout: 5000 });
      await expect(toastAge).toHaveText('38 minutes ago', { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});

test.describe('Leftover processes toast lifetime', () => {
  test('a toast that leaves a process running outlives the auto-dismiss time, so Review stays reachable', async () => {
    const { browser, page } = await launchPageWithToastSeconds(1);
    try {
      // ONE_TASK stopped one process and left two running, which makes the toast sticky.
      await fireReport(page, ONE_TASK);
      const toast = page.locator('[data-testid="toast"]', { hasText: 'are still running.' });
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
      const waitingToast = page.locator('[data-testid="toast"]', { hasText: 'are still running.' });
      await expect(waitingToast).toBeVisible({ timeout: 5000 });

      const stoppedOnly = (index: number): LeftoverProcessReport => ({
        reportedAt: new Date().toISOString(),
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
      await expect(toast.getByTestId('toast-title')).toHaveText('Leftover processes stopped');
      await expect(toast).toHaveAttribute('data-persistent', 'false');
      // It closes on its own within seconds, so it shows no age.
      expect(await toast.locator('[data-testid="toast-age"]').count()).toBe(0);

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

/** Page time, as the page's own (fake) clock reads it. A report is stamped from this, never from the test process's clock. */
async function pageNowMs(page: Page): Promise<number> {
  return page.evaluate(() => Date.now());
}

/**
 * Hold page time still: from here only `page.clock.runFor` moves it, so a
 * recheck timer fires when the test says and not when a starved worker gets
 * round to it. The page's timers are Playwright's, which is why this needs
 * `launchPageWithClock`. A toast's exit animation is among the timers it holds,
 * so a test that waits for a toast to leave `page.clock.resume()`s first.
 */
async function freezePageTime(page: Page): Promise<void> {
  await page.clock.pauseAt(new Date((await pageNowMs(page)) + 1000));
}

/** A report from this instant of page time: the youngest possible, so its recheck is on the fast pace. */
async function fireFreshReport(page: Page, report: TestReport): Promise<void> {
  await fireReport(page, { ...report, reportedAt: new Date(await pageNowMs(page)).toISOString() });
}

async function checkCalls(page: Page): Promise<string[][]> {
  return page.evaluate(() => window.__mockLeftoverCheckCalls ?? []);
}

/**
 * An unrelated toast, raised and dismissed in one task: two toast-store changes
 * (the hook subscribes to that store) that change nothing it watches.
 */
async function churnToastStore(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { toast: { getState: () => { addToast: (input: { title: string; message: string; durationMs: number }) => string; dismissToast: (id: string) => void } } };
    }).__zustandStores;
    const toastId = stores.toast.getState().addToast({ title: 'Unrelated', message: 'An unrelated toast.', durationMs: 60_000 });
    stores.toast.getState().dismissToast(toastId);
  });
}

/**
 * A process the reap kept can exit on its own: the case that surfaced it was a `/preview`'s
 * shell, still quitting when the reap scanned, that was gone a moment later
 * while the list said "still running" for as long as the app ran. The list
 * rechecks the rows that claim a live process, by report id, while they are
 * on screen; a row whose process ended reads Ended, and a toast with nothing
 * left running closes.
 *
 * The tests that depend on a recheck TICK move page time with the fake clock
 * (`page.clock.runFor`) instead of waiting out real seconds, which on a starved
 * runner is a race with the tick. The ones that count calls also freeze page
 * time first, so no tick happens that the test did not ask for.
 */
test.describe('Leftover processes: a kept process that exits on its own', () => {
  const KEPT_SHELL: TestReport = {
    id: 'report-kept-shell',
    stoppingEnabled: true,
    processes: [
      leftover('stopped-vite'),
      leftover('kept-cmd', { pid: 63776, label: 'cmd', outcome: 'kept', reason: 'shared' }),
    ],
  };
  const TOAST_TEXT = '1 process from "Fix login" is still running.';

  test('opening the list rechecks at once: the row reads Ended, and its toast closes', async () => {
    const { browser, page } = await launchPage();
    try {
      await fireReport(page, KEPT_SHELL);
      const toast = page.locator('[data-testid="toast"]', { hasText: TOAST_TEXT });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await page.evaluate(() => { window.__mockLeftoverEndedIds = ['kept-cmd']; });

      await openReview(page, TOAST_TEXT);

      const shell = row(page, 'cmd');
      await expect(shell).toHaveAttribute('data-state', 'ended', { timeout: 5000 });
      await expect(shell).toContainText('No longer running.');
      await expect(shell.locator('[data-testid="leftover-process-stop"]')).toHaveText('Ended');
      await expect(shell.locator('[data-testid="leftover-process-stop"]')).toBeDisabled();
      // The row stays in its section while the list is open.
      await expect(page.locator('[data-testid="leftover-processes-running"]')).toContainText('cmd');
      // Nothing it named is running now, so the toast no longer says anything true.
      await toast.waitFor({ state: 'detached', timeout: 5000 });
      // Only the row that claimed a live process was asked about, by its report id.
      const calls = await page.evaluate(() => window.__mockLeftoverCheckCalls ?? []);
      expect(calls.flat()).toContain('kept-cmd');
      expect(calls.flat()).not.toContain('stopped-vite');
    } finally {
      await browser.close();
    }
  });

  test('a row whose process still runs keeps reading Still running, and its toast stays', async () => {
    const { browser, page } = await launchPage();
    try {
      await fireReport(page, KEPT_SHELL);
      await openReview(page, TOAST_TEXT);

      await expect.poll(() => page.evaluate(() => (window.__mockLeftoverCheckCalls ?? []).length), { timeout: 5000 }).toBeGreaterThan(0);
      await expect(row(page, 'cmd')).toHaveAttribute('data-state', 'running');
      await expect(row(page, 'cmd')).toContainText('Other work uses it too.');
      await page.locator('[data-testid="leftover-processes-close"]').click();
      await expect(page.locator('[data-testid="toast"]', { hasText: TOAST_TEXT })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a new report rechecks on its own, and its toast closes once the kept process ends', async () => {
    const { browser, page } = await launchPageWithClock();
    try {
      // A report from just now is on the fast recheck pace (every 5 s).
      await fireFreshReport(page, KEPT_SHELL);
      const toast = page.locator('[data-testid="toast"]', { hasText: TOAST_TEXT });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await page.evaluate(() => { window.__mockLeftoverEndedIds = ['kept-cmd']; });

      // No Review click: the recheck runs while the toast is up. One fast tick of
      // page time, not five real seconds: the toast's exit then plays in real time.
      await page.clock.runFor(LEFTOVER_RECHECK_FAST_MS);
      await toast.waitFor({ state: 'detached', timeout: 10_000 });
      expect((await checkCalls(page)).flat()).toContain('kept-cmd');
    } finally {
      await browser.close();
    }
  });

  test('a new report is rechecked at the fast pace even while an old one\'s slow recheck is waiting', async () => {
    const { browser, page } = await launchPageWithClock();
    try {
      // 37 minutes old: its recheck is armed on the 30 s pace.
      await fireReport(page, KEPT_SHELL);
      await expect(page.locator('[data-testid="toast"]', { hasText: TOAST_TEXT })).toBeVisible({ timeout: 5000 });
      const fresh: TestReport = {
        id: 'report-fresh',
        stoppingEnabled: true,
        processes: [leftover('kept-node', { pid: 70001, taskId: 'task-b', taskTitle: 'Update deps', label: 'node', outcome: 'kept', reason: 'shared' })],
      };
      await fireFreshReport(page, fresh);
      const freshToast = page.locator('[data-testid="toast"]', { hasText: '1 process from "Update deps" is still running.' });
      await expect(freshToast).toBeVisible({ timeout: 5000 });
      await page.evaluate(() => { window.__mockLeftoverEndedIds = ['kept-node']; });

      // One fast tick of page time, far short of the old report's 30 s: the fresh
      // one brought the timer forward, or this tick would find nothing due.
      await page.clock.runFor(LEFTOVER_RECHECK_FAST_MS);
      await freshToast.waitFor({ state: 'detached', timeout: 10_000 });
      // Positive control: the old report's process still runs, so its toast stays.
      await expect(page.locator('[data-testid="toast"]', { hasText: TOAST_TEXT })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a recheck in flight starts no second one, whatever changes meanwhile; the next comes a tick after it answers', async () => {
    const { browser, page } = await launchPageWithClock();
    try {
      // Hold every answer open, so the first recheck stays in flight.
      await page.evaluate(() => {
        window.__mockLeftoverCheckGate = new Promise<void>((resolve) => { window.__mockReleaseLeftoverCheckGate = resolve; });
      });
      await freezePageTime(page);
      await fireFreshReport(page, KEPT_SHELL);
      await expect(page.locator('[data-testid="toast"]', { hasText: TOAST_TEXT })).toBeVisible({ timeout: 5000 });
      expect(await checkCalls(page)).toEqual([]);

      // The tick: one recheck goes out and stays outstanding.
      await page.clock.runFor(LEFTOVER_RECHECK_FAST_MS);
      await expect.poll(() => checkCalls(page), { timeout: 5000 }).toEqual([['kept-cmd']]);

      // While it is outstanding, a toast-store change, then a leftover-store change
      // (a report that names nothing running, and the toast it raises). Each would
      // arm a fresh timer if nothing held the next recheck back until this one answers.
      await churnToastStore(page);
      await fireFreshReport(page, { id: 'report-unrelated-stopped', stoppingEnabled: true, processes: [leftover('unrelated-vite')] });
      await churnToastStore(page);
      // Three fast ticks of page time: any timer armed above would have fired.
      await page.clock.runFor(3 * LEFTOVER_RECHECK_FAST_MS);
      expect(await checkCalls(page)).toEqual([['kept-cmd']]);

      // It answers. The next recheck is a tick away from the answer, not due at once.
      await page.evaluate(() => window.__mockReleaseLeftoverCheckGate?.());
      await page.clock.runFor(LEFTOVER_RECHECK_FAST_MS - 1000);
      expect(await checkCalls(page)).toEqual([['kept-cmd']]);
      await page.clock.runFor(1000);
      await expect.poll(() => checkCalls(page), { timeout: 5000 }).toEqual([['kept-cmd'], ['kept-cmd']]);
    } finally {
      await browser.close();
    }
  });

  test('changes elsewhere never push an armed recheck back: it lands on its tick, and on the next', async () => {
    const { browser, page } = await launchPageWithClock();
    try {
      await freezePageTime(page);
      await fireFreshReport(page, KEPT_SHELL);
      await expect(page.locator('[data-testid="toast"]', { hasText: TOAST_TEXT })).toBeVisible({ timeout: 5000 });

      // Quarter-tick steps, so each tick boundary is landed on exactly. After every
      // step an unrelated toast is raised and dismissed. A timer that restarted on
      // each change would be due a whole tick after the LAST one, and so never
      // fire while the changes keep coming at under a tick apart.
      const quarterTick = LEFTOVER_RECHECK_FAST_MS / 4;
      for (const callsAfterTick of [1, 2]) {
        for (let quarter = 1; quarter <= 4; quarter += 1) {
          await page.clock.runFor(quarterTick);
          if (quarter < 4) {
            expect((await checkCalls(page)).length).toBe(callsAfterTick - 1);
            await churnToastStore(page);
          }
        }
        await expect.poll(async () => (await checkCalls(page)).length, { timeout: 5000 }).toBe(callsAfterTick);
        await churnToastStore(page);
      }
    } finally {
      await browser.close();
    }
  });

  test('the user\'s own Stop settles a report: the row reads Stopped, its toast closes, and the list stays open', async () => {
    const { browser, page } = await launchPage();
    try {
      // One kept row, and `check` never answers that it ended: only the Stop can settle it.
      await fireReport(page, KEPT_SHELL);
      const toast = page.locator('[data-testid="toast"]', { hasText: TOAST_TEXT });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await openReview(page, TOAST_TEXT);

      const shell = row(page, 'cmd');
      // Positive control: the list's own recheck ran, found the process running, and left the toast up.
      await expect.poll(async () => (await checkCalls(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
      await expect(shell).toHaveAttribute('data-state', 'running');
      await expect(toast).toBeVisible();

      await shell.getByRole('button', { name: 'Stop cmd' }).click();
      await expect(shell).toHaveAttribute('data-state', 'stopped', { timeout: 5000 });
      await expect(shell.locator('[data-testid="leftover-process-stop"]')).toHaveText('Stopped');
      // Nothing it named is running now, so the toast no longer says anything true.
      await toast.waitFor({ state: 'detached', timeout: 10_000 });
      // Closing the toast does not close the list the user is working in.
      await expect(page.locator('[data-testid="leftover-processes-dialog"]')).toBeVisible();
      await expect(shell).toBeVisible();
      expect(await page.evaluate(() => window.__mockLeftoverStopCalls)).toEqual(['kept-cmd']);
    } finally {
      await browser.close();
    }
  });
});
