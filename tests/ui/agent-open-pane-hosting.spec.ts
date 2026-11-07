/**
 * UI tests for how an agent's `open_pane` push is hosted, beyond the focus
 * arbitration in agent-open-pane-focus.spec.ts.
 *
 * `resolvePaneOpenAction` is unit-tested; these prove the renderer feeds it the
 * right facts and that the parked window it mounts has no side effect on the user:
 *
 * 1. A stale `detailTaskId` naming the task must not swallow the user's next
 *    click on its card. Red: remove `setDetailTaskId(null)` from
 *    `mountParkedDetailWindow`; the click is read as "no change" and the window
 *    stays parked.
 * 2. With the task's Browser popped out, or the in-app Agent Monitor showing its
 *    detail, the push mounts no board window. Red: report either fact as false in
 *    `hostPane` and a parked window appears.
 * 3. An agent's parked window does not tick the "user has opened a task"
 *    onboarding step; the user's own open does. Red: count dormant windows in
 *    AppLayout's `taskDetailWindowOpen`.
 *
 * Every test launches its own page, so nothing leaks between tests.
 */
import { test, expect, type Page } from '@playwright/test';
import { PROJECT_ID, launch, boardCard, openMonitor, sessionIdOf, byTestId } from './monitor-writes-seed';

test.describe.configure({ mode: 'parallel' });

const TASK_A = 'task-hosting-a';
const TASK_B = 'task-hosting-b';
const ONBOARDING_STEP = 'taskDetailOpened';

const SEED = {
  tasks: [
    { id: TASK_A, displayId: 71, title: 'Hosting Task A', lane: 'Executing', session: true },
    { id: TASK_B, displayId: 72, title: 'Hosting Task B', lane: 'Executing', session: true },
  ],
};

// The bridge does not check the per-project gate, but a pane that mounts in the
// parked window should find it enabled.
const BROWSER_ENABLED = `
  window.__mockPreConfigure(function (state) {
    state.projectConfigs['/mock/monitor-writes'] = { browser: { enabled: true } };
  });
`;

interface StoreHandles {
  __zustandStores: {
    session: { getState: () => { detailTaskId: string | null; browserOpenTasks: Set<string>; setDetailTaskId: (id: string | null) => void } };
    window: { getState: () => { windows: Record<string, { id: string; kind: string; anchor: string; parked?: true }> } };
    popOut: { getState: () => { setOpen: (keys: string[]) => void } };
    config: { getState: () => { onboardingStepsCompleted: Record<string, string[]> } };
  };
}

async function emitAgentOpen(page: Page, taskId: string): Promise<void> {
  await page.evaluate(
    ([projectId, target]) => { window.__mockBrowser?.emitPaneOpenRequest(projectId, target); },
    [PROJECT_ID, taskId],
  );
}

async function browserOpenFlag(page: Page, taskId: string): Promise<boolean> {
  return page.evaluate((target) => (window as unknown as StoreHandles).__zustandStores.session.getState().browserOpenTasks.has(target), taskId);
}

async function detailWindowsFor(page: Page, taskId: string): Promise<Array<{ id: string; parked: boolean }>> {
  return page.evaluate((target) => Object.values((window as unknown as StoreHandles).__zustandStores.window.getState().windows)
    .filter((candidate) => candidate.kind === 'task-detail' && candidate.anchor === target)
    .map((candidate) => ({ id: candidate.id, parked: candidate.parked === true })), taskId);
}

async function detailTaskId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as StoreHandles).__zustandStores.session.getState().detailTaskId);
}

async function onboardingSteps(page: Page): Promise<string[]> {
  return page.evaluate((projectId) => (window as unknown as StoreHandles).__zustandStores.config.getState().onboardingStepsCompleted[projectId] ?? [], PROJECT_ID);
}

/**
 * Record whether the board is ever asked to open a window for the task from now
 * on. A window the push wrongly mounted is dropped again at once by the
 * parked-window reaper (which runs inside the same store write), so reading the
 * store afterwards would miss it. Spies on `openWindow` instead.
 */
async function watchForDetailWindow(page: Page, taskId: string): Promise<void> {
  await page.evaluate((target) => {
    const stash = window as unknown as { __sawDetailWindow: boolean };
    stash.__sawDetailWindow = false;
    type OpenInput = { anchor: string };
    const store = (window as unknown as {
      __zustandStores: { window: {
        getState: () => { openWindow: (input: OpenInput) => string };
        setState: (partial: { openWindow: (input: OpenInput) => string }) => void;
      } };
    }).__zustandStores.window;
    const original = store.getState().openWindow;
    store.setState({
      openWindow: (input) => {
        if (input.anchor === target) stash.__sawDetailWindow = true;
        return original(input);
      },
    });
  }, taskId);
}

async function sawDetailWindow(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __sawDetailWindow: boolean }).__sawDetailWindow);
}

/** Two animation frames: React has committed and flushed the effects of whatever just changed. */
async function flushRenderEffects(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test.describe('an agent open_pane push, hosting and its side effects', () => {
  test('a stale detail signal on the task does not swallow the click that shows its parked window', async () => {
    const { browser, page } = await launch(SEED, BROWSER_ENABLED);
    try {
      // Reach the stale signal: the signal names B, but the ownership request never
      // answers, so no window mounts for it (a request main has not resolved yet).
      await page.evaluate((target) => {
        const ownership = window.electronAPI.taskDetailOwnership as unknown as { requestOpen: unknown };
        const stash = window as unknown as { __realRequestOpen: unknown };
        stash.__realRequestOpen = ownership.requestOpen;
        ownership.requestOpen = () => new Promise(() => undefined);
        (window as unknown as StoreHandles).__zustandStores.session.getState().setDetailTaskId(target);
      }, TASK_B);
      expect(await detailTaskId(page)).toBe(TASK_B);
      expect(await detailWindowsFor(page, TASK_B)).toEqual([]);
      await page.evaluate(() => {
        const ownership = window.electronAPI.taskDetailOwnership as unknown as { requestOpen: unknown };
        ownership.requestOpen = (window as unknown as { __realRequestOpen: unknown }).__realRequestOpen;
      });

      await emitAgentOpen(page, TASK_B);
      await expect.poll(() => detailWindowsFor(page, TASK_B), { timeout: 10000 }).toEqual([expect.objectContaining({ parked: true })]);
      const parked = (await detailWindowsFor(page, TASK_B))[0];
      // The signal is let go of, which is what lets the next click register.
      await expect.poll(() => detailTaskId(page), { timeout: 5000 }).toBeNull();

      await boardCard(page, TASK_B).click();
      await expect.poll(() => detailWindowsFor(page, TASK_B), { timeout: 10000 })
        .toEqual([{ id: parked.id, parked: false }]);
    } finally {
      await browser.close();
    }
  });

  test('a push mounts no window while the task\'s Browser pop-out is open', async () => {
    const { browser, page } = await launch(SEED, BROWSER_ENABLED);
    try {
      await page.evaluate(([projectId, target]) => {
        (window as unknown as StoreHandles).__zustandStores.popOut.getState().setOpen([`browser:${projectId}:${target}`]);
      }, [PROJECT_ID, TASK_A]);
      await watchForDetailWindow(page, TASK_A);

      await emitAgentOpen(page, TASK_A);
      // The flag is set before the host is resolved, so once it shows the host decision has run.
      await expect.poll(() => browserOpenFlag(page, TASK_A), { timeout: 5000 }).toBe(true);
      await flushRenderEffects(page);
      expect(await detailWindowsFor(page, TASK_A)).toEqual([]);
      expect(await sawDetailWindow(page)).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('a push mounts no board window while the Agent Monitor shows the task\'s detail', async () => {
    const { browser, page } = await launch(SEED, BROWSER_ENABLED);
    try {
      await openMonitor(page);
      await byTestId(page, 'monitor-page').locator(`[data-session-id="${sessionIdOf(TASK_A)}"] [data-testid="monitor-card-title"]`).click();
      await expect(page.locator('#monitor-detail-layer-root [data-testid^="window-frame-"]')).toHaveCount(1);
      await watchForDetailWindow(page, TASK_A);

      await emitAgentOpen(page, TASK_A);
      await expect.poll(() => browserOpenFlag(page, TASK_A), { timeout: 5000 }).toBe(true);
      await flushRenderEffects(page);
      expect(await detailWindowsFor(page, TASK_A)).toEqual([]);
      expect(await sawDetailWindow(page)).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('an agent\'s parked window does not mark the user as having opened a task', async () => {
    const { browser, page } = await launch(SEED, BROWSER_ENABLED);
    try {
      expect(await onboardingSteps(page)).not.toContain(ONBOARDING_STEP);

      await emitAgentOpen(page, TASK_A);
      await expect.poll(() => detailWindowsFor(page, TASK_A), { timeout: 10000 }).toEqual([expect.objectContaining({ parked: true })]);
      // The step is stamped by an effect on the window set, which has run by now.
      await flushRenderEffects(page);
      expect(await onboardingSteps(page)).not.toContain(ONBOARDING_STEP);
    } finally {
      await browser.close();
    }
  });

  test('the user\'s own open of a task marks the onboarding step', async () => {
    const { browser, page } = await launch(SEED, BROWSER_ENABLED);
    try {
      expect(await onboardingSteps(page)).not.toContain(ONBOARDING_STEP);

      await boardCard(page, TASK_A).click();
      await expect.poll(() => detailWindowsFor(page, TASK_A), { timeout: 10000 }).toEqual([expect.objectContaining({ parked: false })]);
      await expect.poll(() => onboardingSteps(page), { timeout: 5000 }).toContain(ONBOARDING_STEP);
    } finally {
      await browser.close();
    }
  });
});
