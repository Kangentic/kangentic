/**
 * E2E test: click-outside (light-dismiss) does NOT kill the PTY session.
 *
 * When a task-detail window backed by a live PTY session is dismissed with a
 * clean empty-board click, only the dialog-session claim is released. The
 * underlying PTY keeps running; reopening the window reattaches the same
 * session and the scrollback is still present.
 *
 * This test is at the E2E tier because it exercises the real PTY lifecycle
 * (a real `node-pty` process spawned by the mock Claude CLI), real IPC, and
 * the real Electron window manager. A unit test or headless UI test cannot
 * prove this: both would use mock sessions with no real PTY.
 *
 * High-value invariant:
 *   - Open a task-detail window backed by a running session.
 *   - Light-dismiss the window (policy = 'single').
 *   - The session remains 'running' in sessions.list() after the dismiss.
 *   - Reopening the task reopens the window; the scrollback marker from the
 *     original spawn is still present (session was not killed).
 *
 * The `resolveLightDismissTargets` resolver and the React-layer detection are
 * unit/UI tested. This spec is ONLY concerned with "did the PTY die?" and
 * "does reopening reattach?".
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  closeApp,
  mockAgentPath,
  getTaskIdByTitle,
  moveTaskIpc,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'window-light-dismiss-pty-survival';
const runId = Date.now();
const PROJECT_NAME = `PTY Survival ${runId}`;

// ---------------------------------------------------------------------------
// Helpers shared across the single describe block
// ---------------------------------------------------------------------------

/** Pre-write config.json so the app uses the mock Claude CLI on startup. */
function writeTestConfig(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockAgentPath('claude'),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false,
      },
    }),
  );
}

/** Get the swimlane ID by name (generic lookup - extends getSwimlaneIds which is
 *  limited to planning+done). */
async function getSwimlaneByName(page: Page, name: string): Promise<string> {
  const swimlaneId = await page.evaluate(async (laneName) => {
    const swimlanes: Array<{ id: string; name: string }> =
      await window.electronAPI.swimlanes.list();
    return swimlanes.find((swimlane) => swimlane.name === laneName)?.id ?? null;
  }, name);
  if (!swimlaneId) throw new Error(`Swimlane "${name}" not found`);
  return swimlaneId;
}

/**
 * Poll the scrollback of a SPECIFIC task's running session until the given
 * marker appears. Keyed by taskId to avoid matching a different session's
 * scrollback (anti-flake pattern 3 from the test-builder guide).
 */
async function waitForTaskScrollback(
  page: Page,
  taskId: string,
  marker: string,
  timeoutMs = 15000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scrollback = await page.evaluate(async (tid) => {
      const sessions: Array<{ id: string; taskId: string; status: string }> =
        await window.electronAPI.sessions.list();
      const session = sessions.find(
        (sessionEntry) => sessionEntry.taskId === tid && sessionEntry.status === 'running',
      );
      if (!session) return '';
      return window.electronAPI.sessions.getScrollback(session.id);
    }, taskId);

    if (scrollback.includes(marker)) return scrollback;

    await page.waitForTimeout(400);
  }
  throw new Error(
    `Timed out (${timeoutMs}ms) waiting for task ${taskId.slice(0, 8)} scrollback: ${marker}`,
  );
}

/** Open a task-detail window by clicking the task's card on the board.
 *  Waits until `[data-testid="task-detail-dialog"]` is visible. */
async function openTaskWindow(page: Page, taskTitle: string): Promise<void> {
  const card = page.locator(`text=${taskTitle}`).first();
  await card.click();
  await page
    .locator('[data-testid="task-detail-dialog"]')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Dispatch a clean dead-board-area click via `dispatchEvent`. Targets a column
 * body (`[data-swimlane-name]`) directly so `event.target` is that element: dead
 * (non-action) space with a dnd-kit `role="button"` sortable-wrapper ancestor,
 * which is exactly the real-world empty-board click that `isDismissibleDeadArea`
 * must accept.
 *
 * See the corresponding UI-tier spec (window-click-outside-close.spec.ts) for a
 * full explanation of why `page.mouse` + viewport coordinates fails here.
 */
async function clickEmptyBoard(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name]').first().waitFor({ state: 'visible', timeout: 5000 });
  await page.evaluate(() => {
    const column = document.querySelector('[data-swimlane-name]');
    if (!column) throw new Error('no [data-swimlane-name] column found');
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      pointerId: 1,
      clientX: 300,
      clientY: 600,
    };
    column.dispatchEvent(new PointerEvent('pointerdown', init));
    column.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  });
}

/** Return the number of visible task-detail windows. */
async function windowCount(page: Page): Promise<number> {
  return page.locator('[data-testid="task-detail-dialog"]').count();
}

/** Set the `windowLightDismiss` policy via the config IPC (real Electron app). */
async function setLightDismissPolicy(
  page: Page,
  policy: 'off' | 'single' | 'focused' | 'all',
): Promise<void> {
  await page.evaluate(async (pol) => {
    await window.electronAPI.config.set({ windowLightDismiss: pol });
  }, policy);
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

test.describe('Window light-dismiss - PTY survival after dismiss and reopen', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    writeTestConfig(dataDir);

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('light-dismiss releases the dialog claim without killing the PTY; reopening reattaches', async () => {
    // Allow extra time: session spawn (~5s) + scrollback wait (~5s) + reopen (~2s).
    test.slow();

    const taskTitle = `PTY Survival Task ${runId}`;
    await createTask(page, taskTitle, 'Verify PTY is not killed by light-dismiss');

    // Move the task into an auto-spawn column (Executing) to start a session.
    const executingId = await getSwimlaneByName(page, 'Executing');
    const taskId = await getTaskIdByTitle(page, taskTitle);
    await moveTaskIpc(page, taskId, executingId);

    // Wait for the real PTY session to start.
    await expect
      .poll(
        async () => {
          return page.evaluate(async (tid) => {
            const sessions: Array<{ taskId: string; status: string }> =
              await window.electronAPI.sessions.list();
            return sessions.some(
              (sessionEntry) => sessionEntry.taskId === tid && sessionEntry.status === 'running',
            );
          }, taskId);
        },
        { timeout: 15000, intervals: [300, 500] },
      )
      .toBe(true);

    // Wait for the mock Claude CLI to print its SESSION marker in the scrollback.
    // This confirms the PTY is fully running (not just 'running' in the DB).
    const scrollbackBeforeDismiss = await waitForTaskScrollback(
      page,
      taskId,
      'MOCK_CLAUDE_SESSION:',
    );
    expect(scrollbackBeforeDismiss).toContain('MOCK_CLAUDE_SESSION:');

    // Set policy to 'single' so that one floating window is dismissed.
    await setLightDismissPolicy(page, 'single');

    // Open the task-detail window by clicking the card.
    await openTaskWindow(page, taskTitle);
    expect(await windowCount(page)).toBe(1);

    // Light-dismiss: clean click on the empty board.
    await clickEmptyBoard(page);

    // The window should close.
    await expect
      .poll(() => windowCount(page), { timeout: 3000, intervals: [100, 200] })
      .toBe(0);

    // CRITICAL: the session must still be 'running'. The light-dismiss only
    // releases the dialog-session claim; it must NOT suspend or kill the PTY.
    const sessionStillRunning = await page.evaluate(async (tid) => {
      const sessions: Array<{ taskId: string; status: string }> =
        await window.electronAPI.sessions.list();
      return sessions.some(
        (sessionEntry) => sessionEntry.taskId === tid && sessionEntry.status === 'running',
      );
    }, taskId);
    expect(sessionStillRunning).toBe(true);

    // Reopen the window by clicking the card again.
    await openTaskWindow(page, taskTitle);
    expect(await windowCount(page)).toBe(1);

    // The scrollback from the original spawn must still be present.
    // This proves the window reattached to the EXISTING session (not a new spawn).
    const scrollbackAfterReopen = await waitForTaskScrollback(
      page,
      taskId,
      'MOCK_CLAUDE_SESSION:',
    );
    expect(scrollbackAfterReopen).toContain('MOCK_CLAUDE_SESSION:');
  });
});
