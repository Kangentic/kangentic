/**
 * The dev restart: how a long `npm start` session keeps up with a merge that
 * changed main, preload or worker code, which Vite's HMR cannot deliver.
 *
 * scripts/dev.js rebuilds those bundles in memory when their sources change and
 * tells the window over Vite's websocket. A page here has no dev.js behind it,
 * so the spec hands `reportMainStale` (utils/dev-restart.ts, the one function
 * that websocket event calls) the same list, imported from the dev server the
 * app itself runs from, so it is the app's own module instance.
 *
 * What the user loses if this breaks: the notice that a restart is needed, the
 * confirm that keeps a restart from cutting an agent's turn short unasked, or
 * the one way off the root error screen when renderer code is newer than the
 * running preload (Reload runs the same code against the same old preload).
 *
 * The restart itself is main's (`app.restart`); the mock counts its calls.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, toastCountRightNow } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT_ID = `proj-dev-restart-${RUN_ID}`;
const TASK_ID = `task-dev-restart-${RUN_ID}`;
const SESSION_ID = `sess-dev-restart-${RUN_ID}`;

/** A project with one running task, its agent `thinking` or `idle`. */
function preConfig(agentActivity: 'thinking' | 'idle'): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Dev Restart ${RUN_ID}',
        path: '/mock/dev-restart-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-dr-${RUN_ID}-' + index;
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, { id: laneId, position: index, created_at: ts }));
      });
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 7300,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/dev-restart-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });
      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: 'Dev Restart Task ${RUN_ID}',
        description: '',
        swimlane_id: executingLaneId,
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.activityCache['${SESSION_ID}'] = '${agentActivity}';
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/** Stands in for a preload from before the restart channel existed. */
const DROP_RESTART_SCRIPT = 'delete window.electronAPI.app.restart;';

interface DevRestartWindow {
  __mockAppRestartCalls?: number;
  __zustandStores: {
    board: { getState(): { swimlanes: unknown }; setState(partial: Record<string, unknown>): void };
    session: {
      getState(): { sessionActivity: Record<string, string> };
      setState(partial: Record<string, unknown>): void;
    };
  };
}

async function openBoard(browser: Browser, agentActivity: 'thinking' | 'idle', extraInitScripts: string[] = []): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(agentActivity));
  for (const script of extraInitScripts) await page.addInitScript(script);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
  await expect.poll(() => page.evaluate((sessionId) => (
    (window as unknown as DevRestartWindow).__zustandStores.session.getState().sessionActivity[sessionId]
  ), SESSION_ID), { timeout: 10000 }).toBe(agentActivity);
  return page;
}

/** What dev.js's `kangentic:main-stale` event hands the window. */
async function reportMainStale(page: Page, bundles: string[]): Promise<void> {
  await page.evaluate(async (staleBundles) => {
    const devRestart = await import('/src/renderer/utils/dev-restart.ts' as string) as {
      reportMainStale: (bundles: readonly string[]) => void;
    };
    devRestart.reportMainStale(staleBundles);
  }, bundles);
}

const restartCalls = (page: Page) => page.evaluate(() => (window as unknown as DevRestartWindow).__mockAppRestartCalls ?? 0);

const staleToast = (page: Page) => page.locator('[data-testid="toast"]', { hasText: 'Main process changed' });

test.describe('dev restart', () => {
  let browser: Browser;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
  });

  test.afterAll(async () => {
    await browser.close();
  });

  test('a stale main build raises the notice, its Restart restarts, and a fresh build takes it down', async () => {
    const page = await openBoard(browser, 'idle');

    await reportMainStale(page, ['main', 'preload']);
    await expect(staleToast(page)).toBeVisible({ timeout: 10000 });

    await staleToast(page).locator('[data-testid="toast-action"]').click();
    // No agent is mid-turn, so nothing is asked.
    await expect(page.locator('[data-testid="dev-restart-confirm"]')).toHaveCount(0);
    await expect.poll(() => restartCalls(page), { timeout: 5000 }).toBe(1);

    await reportMainStale(page, []);
    await expect(staleToast(page)).toHaveCount(0, { timeout: 5000 });
    await page.context().close();
  });

  test('a restart asks first while an agent is mid-turn, and Cancel restarts nothing', async () => {
    const page = await openBoard(browser, 'thinking');

    await page.locator('body').click({ position: { x: 5, y: 500 } });
    await page.keyboard.press('ControlOrMeta+Shift+F5');
    const confirm = page.locator('[data-testid="dev-restart-confirm"]');
    await expect(confirm).toBeVisible({ timeout: 5000 });
    await expect(confirm).toContainText('1 agent is working');

    await page.locator('[data-testid="dev-restart-confirm-cancel"]').click();
    await expect(confirm).toHaveCount(0);
    expect(await restartCalls(page)).toBe(0);

    await page.keyboard.press('ControlOrMeta+Shift+F5');
    await page.locator('[data-testid="dev-restart-confirm-confirm"]').click();
    await expect.poll(() => restartCalls(page), { timeout: 5000 }).toBe(1);
    await page.context().close();
  });

  // The user's Ctrl+R in #1052 went to the focused terminal, where the agent read
  // it as history search. The restart hotkey must win over xterm, which turns an
  // F-key combo into an escape sequence and stops the event in the bubble phase.
  test('the restart hotkey works with a terminal focused, and sends the agent nothing', async () => {
    const page = await openBoard(browser, 'thinking');
    const terminalInput = page.locator('[data-testid="terminal-session-pane"] .xterm-helper-textarea').first();
    await expect(terminalInput).toBeAttached({ timeout: 10000 });
    await terminalInput.focus();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
    const writesBefore = await page.evaluate(() => (
      window as unknown as { electronAPI: { sessions: { __writeCalls: unknown[] } } }
    ).electronAPI.sessions.__writeCalls.length);

    await page.keyboard.press('ControlOrMeta+Shift+F5');

    await expect(page.locator('[data-testid="dev-restart-confirm"]')).toBeVisible({ timeout: 5000 });
    const writesAfter = await page.evaluate(() => (
      window as unknown as { electronAPI: { sessions: { __writeCalls: unknown[] } } }
    ).electronAPI.sessions.__writeCalls.length);
    expect(writesAfter, 'the hotkey must not reach the agent as input').toBe(writesBefore);
    await page.context().close();
  });

  /** A real render throw under the root boundary, as root-boundary-releases-focus.spec.ts does it. */
  async function breakTheWindow(page: Page): Promise<void> {
    await page.evaluate(() => {
      const board = (window as unknown as DevRestartWindow).__zustandStores.board;
      try {
        board.setState({ swimlanes: null });
      } catch {
        // A subscriber outside React threw; React still re-renders and throws.
      }
    });
    await expect(page.locator('h1', { hasText: 'Something went wrong' })).toBeVisible({ timeout: 10000 });
  }

  test('the root error screen offers Restart, and it restarts', async () => {
    const page = await openBoard(browser, 'thinking');
    await breakTheWindow(page);

    await page.locator('[data-testid="root-error-restart"]').click();
    await expect.poll(() => restartCalls(page), { timeout: 5000 }).toBe(1);
    await page.context().close();
  });

  test('the root error screen hides Restart when the running preload has no restart call', async () => {
    const page = await openBoard(browser, 'idle', [DROP_RESTART_SCRIPT]);
    await breakTheWindow(page);

    await expect(page.locator('[data-testid="root-error-reload"]')).toBeVisible();
    await expect(page.locator('[data-testid="root-error-restart"]')).toHaveCount(0);
    await page.context().close();
  });

  test('a closed notice stays closed for the same stale set in any order, and returns for a new set or after a fresh build', async () => {
    const page = await openBoard(browser, 'idle');
    const closeToast = async () => {
      await staleToast(page).locator('[data-testid="toast-dismiss"]').click();
      await expect(staleToast(page)).toHaveCount(0, { timeout: 5000 });
    };

    await reportMainStale(page, ['main']);
    await expect(staleToast(page)).toBeVisible({ timeout: 10000 });
    await closeToast();

    // The same list again: the user already said no to it.
    await reportMainStale(page, ['main']);
    // Negative assertion: nothing to poll for, so give a latent toast a budget.
    await page.waitForTimeout(500);
    expect(await toastCountRightNow(page, 'Main process changed')).toBe(0);

    // A different set raises it again.
    await reportMainStale(page, ['main', 'preload']);
    await expect(staleToast(page)).toBeVisible({ timeout: 5000 });
    await closeToast();

    // The same set in another order is the same signature.
    await reportMainStale(page, ['preload', 'main']);
    await page.waitForTimeout(500);
    expect(await toastCountRightNow(page, 'Main process changed')).toBe(0);

    // A fresh build clears the memory, so the next stale report shows again.
    await reportMainStale(page, []);
    await reportMainStale(page, ['main']);
    await expect(staleToast(page)).toBeVisible({ timeout: 5000 });
    expect(await restartCalls(page)).toBe(0);
    await page.context().close();
  });

  const REJECT_RESTART_SCRIPT = `
    window.electronAPI.app.restart = async function () { throw new Error('Disk is full'); };
  `;

  test('a restart that fails raises an error notice', async () => {
    const page = await openBoard(browser, 'idle', [REJECT_RESTART_SCRIPT]);

    await reportMainStale(page, ['main']);
    await expect(staleToast(page)).toBeVisible({ timeout: 10000 });
    await staleToast(page).locator('[data-testid="toast-action"]').click();

    const failureToast = page.locator('[data-testid="toast"]', { hasText: "Couldn't restart Kangentic" });
    await expect(failureToast).toBeVisible({ timeout: 5000 });
    await expect(failureToast).toContainText('Disk is full');
    await page.context().close();
  });

  test('the root error screen shows why a restart failed', async () => {
    const page = await openBoard(browser, 'idle', [REJECT_RESTART_SCRIPT]);
    await breakTheWindow(page);

    await page.locator('[data-testid="root-error-restart"]').click();
    const failure = page.locator('[data-testid="root-error-restart-failure"]');
    await expect(failure).toBeVisible({ timeout: 5000 });
    await expect(failure).toContainText('Disk is full');
    await page.context().close();
  });

  test('a second restart press waits on the open confirm instead of restarting past it', async () => {
    const page = await openBoard(browser, 'thinking');
    const confirm = page.locator('[data-testid="dev-restart-confirm"]');

    await page.locator('body').click({ position: { x: 5, y: 500 } });
    await page.keyboard.press('ControlOrMeta+Shift+F5');
    await expect(confirm).toBeVisible({ timeout: 5000 });

    // The agent finishes its turn while the confirm is up. Without the guard the
    // next press would count zero working agents and restart straight past it.
    await page.evaluate((sessionId) => {
      (window as unknown as DevRestartWindow).__zustandStores.session.setState({ sessionActivity: { [sessionId]: 'idle' } });
    }, SESSION_ID);
    await expect.poll(() => page.evaluate((sessionId) => (
      (window as unknown as DevRestartWindow).__zustandStores.session.getState().sessionActivity[sessionId]
    ), SESSION_ID)).toBe('idle');

    await page.keyboard.press('ControlOrMeta+Shift+F5');
    // Negative assertion: a wrongly started restart has no signal to poll for.
    await page.waitForTimeout(500);
    expect(await restartCalls(page)).toBe(0);
    await expect(confirm).toBeVisible();

    await page.locator('[data-testid="dev-restart-confirm-confirm"]').click();
    await expect.poll(() => restartCalls(page), { timeout: 5000 }).toBe(1);
    await expect(confirm).toHaveCount(0);
    await page.context().close();
  });
});
