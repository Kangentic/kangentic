/**
 * UI tests for the "spawn is parked / stalling" surfaces:
 *
 *  1. A task whose spawn-progress label is a git-queue wait (e.g. "Removing
 *     worktree (waiting 45s)") renders that distinct label on the card (not a
 *     static "Fetching latest..."). The
 *     label flows through getTaskProgress -> { kind: 'preparing', label } and
 *     the existing TaskCard 'preparing' case, so no card change is needed.
 *
 *  2. When a task sits in a preparing spawn-progress state past the stall
 *     threshold (8s), App.tsx raises a non-blocking toast with a Cancel action.
 *     Clicking Cancel calls window.electronAPI.tasks.cancelSpawn(taskId).
 *
 *  3. The toast is gated by notifications.toasts.onSpawnStalled - when off, no
 *     toast appears even after the threshold.
 *
 * UI-tier (headless Chromium + mock API): the behavior is entirely renderer
 * store + component, no real PTY/IPC. The stall timer is driven with Playwright's
 * clock so the 8s threshold is deterministic and instant.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-spawn-stall';
const TASK_ID = 'task-spawn-stall';
const STALL_THRESHOLD_MS = 8000;

/**
 * Launch a headless page with a project + a task in Planning that has no
 * active session (the in-flight-spawn state). When `useClock` is true, install
 * Playwright's fake clock BEFORE navigation so the 8s stall timer is driven
 * deterministically.
 */
async function launchWithState(useClock: boolean): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  if (useClock) await page.clock.install();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Spawn Stall Test',
        path: '/mock/spawn-stall-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-stall-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Stalling Task',
        description: 'Simulates a task whose spawn is parked in the git queue',
        swimlane_id: laneIds['Planning'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Push a spawn-progress label onto the session store (as the main process would). */
async function seedSpawnProgress(page: Page, taskId: string, label: string): Promise<void> {
  await page.evaluate(({ tid, lbl }) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setSpawnProgress: (id: string, label: string | null) => void } } };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    stores.session.getState().setSpawnProgress(tid, lbl);
  }, { tid: taskId, lbl: label });
}

/** Toggle notifications.toasts.onSpawnStalled in the renderer config store. */
async function setStallToastEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((on) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { config: unknown }; setState: (fn: (s: { config: Record<string, unknown> }) => unknown) => void } };
    }).__zustandStores;
    if (!stores?.config) throw new Error('config store not exposed on __zustandStores');
    stores.config.setState((s) => {
      const notifications = s.config.notifications as { toasts: Record<string, unknown> };
      return {
        config: {
          ...s.config,
          notifications: { ...notifications, toasts: { ...notifications.toasts, onSpawnStalled: on } },
        },
      };
    });
  }, enabled);
}

/** Remove a spawn-progress entry by setting it to null (simulates session arrival or abort). */
async function clearSpawnProgressEntry(page: Page, taskId: string): Promise<void> {
  await page.evaluate((tid) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setSpawnProgress: (id: string, label: string | null) => void } } };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    stores.session.getState().setSpawnProgress(tid, null);
  }, taskId);
}

test.describe('spawn stall: waiting label + notification', () => {
  test('renders the distinct git-queue waiting label on the card', async () => {
    const { browser, page } = await launchWithState(false);
    try {
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.locator('text=Stalling Task')).toBeVisible({ timeout: 5000 });

      await seedSpawnProgress(page, TASK_ID, 'Removing worktree (waiting 45s)');

      const statusBar = page.locator('[data-testid="status-bar"]', { hasText: 'Removing worktree' });
      await expect(statusBar).toBeVisible({ timeout: 5000 });
      await expect(statusBar).toContainText('(waiting 45s)');
    } finally {
      await browser.close();
    }
  });

  test('raises a Cancel toast after the stall threshold and cancels the spawn on click', async () => {
    const { browser, page } = await launchWithState(true);
    try {
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });

      // Enter the preparing state -> arms the 8s stall timer.
      await seedSpawnProgress(page, TASK_ID, 'Waiting...');

      // No toast before the threshold.
      await page.clock.fastForward(STALL_THRESHOLD_MS - 1000);
      await expect(page.getByTestId('toast')).toHaveCount(0);

      // Cross the threshold -> the stall toast fires.
      await page.clock.fastForward(1200);

      const toast = page.getByTestId('toast');
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast).toContainText('still preparing');

      await toast.getByRole('button', { name: 'Cancel' }).click();

      const cancelled: string[] = await page.evaluate(
        () => (window as unknown as { __mockCancelSpawnCalls?: string[] }).__mockCancelSpawnCalls ?? [],
      );
      expect(cancelled).toContain(TASK_ID);
    } finally {
      await browser.close();
    }
  });

  test('does not raise a toast when onSpawnStalled is disabled', async () => {
    const { browser, page } = await launchWithState(true);
    try {
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });

      await setStallToastEnabled(page, false);
      await seedSpawnProgress(page, TASK_ID, 'Waiting...');

      // Past the threshold: the gate is off, so no toast appears.
      await page.clock.fastForward(STALL_THRESHOLD_MS + 1000);
      await expect(page.getByTestId('toast')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // -------------------------------------------------------------------------
  // Gap 3: wrong-project gate - a task that is NOT in the current board's
  // task list (i.e. belongs to a background project) must never raise a toast
  // even after the 8s threshold. The `if (!task) return` early-return in
  // maybeNotifySpawnStall gates on the active board's task list.
  // -------------------------------------------------------------------------
  test('does not raise a toast for a task that belongs to a background project', async () => {
    const { browser, page } = await launchWithState(true);
    try {
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });

      // Seed progress for a taskId that is NOT in the current board's tasks.
      // The board only contains TASK_ID ('task-spawn-stall'); this unknown id
      // simulates a task from a different project that happened to emit progress.
      const backgroundTaskId = 'task-from-background-project-xyz';
      await seedSpawnProgress(page, backgroundTaskId, 'Waiting...');

      // Fast-forward well past the stall threshold.
      await page.clock.fastForward(STALL_THRESHOLD_MS + 2000);

      // No toast should appear: the wrong-project gate blocked it.
      // (Intentional fixed wait - we cannot poll for non-occurrence.)
      await expect(page.getByTestId('toast')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // -------------------------------------------------------------------------
  // Gap 4: dismiss-on-leave - when the stall toast is visible and the spawn
  // finishes (spawnProgress entry is cleared), the sticky toast must be
  // auto-dismissed so the stale Cancel button cannot abort a later move.
  // -------------------------------------------------------------------------
  test('auto-dismisses the stall toast when spawnProgress is cleared', async () => {
    const { browser, page } = await launchWithState(true);
    try {
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });

      // Arm the stall timer.
      await seedSpawnProgress(page, TASK_ID, 'Waiting...');

      // Cross the threshold to raise the toast.
      await page.clock.fastForward(STALL_THRESHOLD_MS + 500);

      const toast = page.getByTestId('toast');
      await expect(toast).toBeVisible({ timeout: 5000 });

      // Simulate the spawn completing: clear the progress entry.
      await clearSpawnProgressEntry(page, TASK_ID);

      // The sticky toast must be dismissed immediately (no timeout).
      await expect(toast).toHaveCount(0, { timeout: 3000 });
    } finally {
      await browser.close();
    }
  });

  // -------------------------------------------------------------------------
  // Gap 5: non-queue label wording - when the active progress label is
  // 'Fetching latest...' (not a queue-wait), the toast message must describe
  // the actual cause ('fetching latest') and NOT say 'waiting on the git queue'.
  // -------------------------------------------------------------------------
  test('toast message reflects the actual label, not always "waiting on the git queue"', async () => {
    const { browser, page } = await launchWithState(true);
    try {
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });

      // Seed a non-queue label. The trailing '...' is stripped and the result
      // is lowercased to form the toast detail string.
      await seedSpawnProgress(page, TASK_ID, 'Fetching latest...');

      // Cross the stall threshold.
      await page.clock.fastForward(STALL_THRESHOLD_MS + 500);

      const toast = page.getByTestId('toast');
      await expect(toast).toBeVisible({ timeout: 5000 });

      // Must contain the lowercased label with trailing '...' removed.
      await expect(toast).toContainText('fetching latest');
      // Must NOT claim a git-queue wait.
      await expect(toast).not.toContainText('waiting on the git queue');
    } finally {
      await browser.close();
    }
  });
});
