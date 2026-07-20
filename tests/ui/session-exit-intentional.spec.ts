/**
 * UI test for the false "Session crashed" toast on move-to-Done.
 *
 * When Kangentic deliberately suspends a session (move-to-Done, To-Do reset,
 * isolated switch, etc.) it force-kills the PTY, which exits non-zero. The
 * SESSION_EXIT event can reach the renderer before the suspended SESSION_STATUS
 * updates the store, so a store-status check alone races and a false "Session
 * crashed" toast fires. The fix tags the exit event with `intentional`, and
 * App.tsx's handler gates on it.
 *
 * The equivalent desktop OS-notification decision now lives in main
 * (src/main/notifications/desktop-notifier.ts), which listens to
 * SessionManager's own 'exit' event and is not observable from this
 * renderer-only harness; its `intentional === true` suppression is covered by
 * tests/unit/desktop-notifier.test.ts instead.
 *
 * These tests reproduce the exact race: the store session status stays
 * 'running' (the suspended SESSION_STATUS has NOT arrived) while SESSION_EXIT
 * carries intentional=true. The gate must suppress the toast. A second exit
 * with intentional=false (a genuine crash) is fired in the same page so its
 * toast appearing proves the pipeline ran - making the absence of the
 * intentional toast a meaningful, non-racy assertion.
 *
 * Determinism notes:
 *   - Toasts are made effectively permanent (durationSeconds override) so the
 *     absence check is not satisfied merely by the default 4s auto-dismiss.
 *   - The intentional absence is read with a one-shot `.count()` snapshot, not
 *     the auto-retrying toHaveCount, so a present toast fails immediately
 *     instead of being waited out until it dismisses.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-exit-intentional';
const INTENTIONAL_SESSION_ID = 'sess-intentional';
const CRASH_SESSION_ID = 'sess-crash';
const EXIT_CODE = 1073807364; // Windows ConPTY hard-kill code (non-zero).

// Keep toasts on screen for the whole test so the absence assertion is not
// satisfied by the default 4s auto-dismiss. Shallow-merged over the mock's base
// config (the override replaces the whole `notifications` object), so the full
// shape is provided with onAgentCrash kept true.
const CONFIG_OVERRIDE_SCRIPT = `
  window.__mockConfigOverrides = {
    notifications: {
      desktop: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true, onSpawnStalled: true },
      toasts: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true, onSpawnStalled: true, durationSeconds: 99999, maxCount: 10 },
      cooldownSeconds: 10,
    },
  };
`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Order matters: the override must be set before the mock IIFE reads it.
  await page.addInitScript(CONFIG_OVERRIDE_SCRIPT);
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * Two RUNNING sessions/tasks. Status is intentionally 'running' (NOT
 * 'suspended') so the store reflects the pre-suspended-status race window.
 */
function makePreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Exit Intentional Test',
        path: '/mock/exit-intentional-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      function pushRunningTask(sessionId, taskId, title) {
        state.sessions.push({
          id: sessionId,
          taskId: taskId,
          projectId: '${PROJECT_ID}',
          pid: 9999,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/exit-intentional-test',
          startedAt: ts,
          exitCode: null,
        });
        state.tasks.push({
          id: taskId,
          title: title,
          description: '',
          swimlane_id: laneIds['Executing'],
          position: 0,
          agent: 'claude',
          session_id: sessionId,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });
      }

      pushRunningTask('${INTENTIONAL_SESSION_ID}', 'task-intentional', 'Intentional Suspend Task');
      pushRunningTask('${CRASH_SESSION_ID}', 'task-crash', 'Genuine Crash Task');

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

test.describe('SESSION_EXIT intentional-suspend gate', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithState(makePreConfig()));
    // The onExit subscription (and __mockFireExit) is registered on mount.
    await page.waitForFunction(() => typeof (window as unknown as { __mockFireExit?: unknown }).__mockFireExit === 'function');
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('intentional suspend exit fires no crash toast; a genuine crash still does', async () => {
    // Fire the intentional suspend exit FIRST (store status still 'running'),
    // then a genuine crash exit. Both are processed before the crash toast
    // renders, so the crash toast appearing proves the intentional handler
    // already ran and was suppressed.
    await page.evaluate(({ intentionalId, crashId, projectId, exitCode }) => {
      const fire = (window as unknown as {
        __mockFireExit: (sessionId: string, exitCode: number, projectId: string, intentional?: boolean) => void;
      }).__mockFireExit;
      fire(intentionalId, exitCode, projectId, true);
      fire(crashId, exitCode, projectId, false);
    }, { intentionalId: INTENTIONAL_SESSION_ID, crashId: CRASH_SESSION_ID, projectId: PROJECT_ID, exitCode: EXIT_CODE });

    // The genuine crash produces a warning toast. Waiting for it guarantees
    // both fired events have been processed and rendered.
    await expect(
      page.getByText(/Session ended for .*Genuine Crash Task.*\(exit/),
    ).toBeVisible({ timeout: 5000 });

    // The intentional suspend must NOT produce a "Session ended" toast. A
    // one-shot snapshot (not the auto-retrying toHaveCount) so a present toast
    // fails now instead of being waited out until it auto-dismisses.
    const intentionalToastCount = await page
      .getByText(/Session ended for .*Intentional Suspend Task/)
      .count();
    expect(intentionalToastCount).toBe(0);
  });
});
