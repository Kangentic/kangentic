/**
 * A same-column respawn (model change, cross-agent handoff, effort-only
 * respawn, session-track switch) must not flash the "Resume session" button
 * or the "Paused" card chip during the suspend-to-respawn window.
 *
 * This is the second half of the fix for the flash bug on kangentic-mobile
 * #74: main now emits a spawn-progress label as the FIRST statement of
 * `suspendLiveSessionForRespawn` (task-move.ts), before the record is even
 * marked suspended. But `SessionManager.suspend()` pushes a `suspended`
 * session row to the renderer almost immediately afterward (well before its
 * own up-to-3s graceful PTY shutdown completes), and the renderer's
 * `upsertSession` used to clear `spawnProgress[taskId]` unconditionally on
 * ANY arriving row - including that suspended one. The label main had just
 * set was wiped within milliseconds of being written.
 *
 * This spec drives that exact real-time race through the actual `onStatus`
 * IPC push path (`window.__mockFireStatus`), not by writing the store
 * directly, so it exercises the real `upsertSession` reducer rather than
 * just the mock-friendly initial state. It is the companion to
 * restore-from-done-shows-progress.spec.ts (which exercises the SAME
 * predicate for a fully-parked, pre-existing suspended row) - here the label
 * is set FIRST and the suspend push arrives SECOND, mirroring the real
 * ordering inside suspendLiveSessionForRespawn.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-handoff-suspend';
const TASK_ID = 'task-handoff-suspend';
const TASK_TITLE = 'Handoff Suspend Probe';
const SESSION_ID = 'session-handoff-suspend';
const SPAWN_LABEL = 'Switching model...';

interface StoreWindow {
  __zustandStores: {
    session: {
      getState: () => {
        setDetailTaskId: (id: string) => void;
        spawnProgress: Record<string, string>;
      };
      setState: (partial: { spawnProgress: Record<string, string> }) => void;
    };
    window: { getState: () => { windows: Record<string, { id: string; anchor: string }> } };
  };
  __mockFireStatus: (sessionId: string, session: Record<string, unknown>) => void;
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Handoff Suspend Test',
        path: '/mock/handoff-suspend-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-'),
          position: i,
          created_at: ts,
        }));
      });
      // A live, RUNNING session on the task - the pre-suspend state a
      // same-column respawn starts from.
      state.tasks.push({
        id: '${TASK_ID}',
        title: '${TASK_TITLE}',
        description: 'Mid-respawn: model change in flight.',
        swimlane_id: 'lane-executing',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: '/mock/handoff-suspend-test/.kangentic/worktrees/handoff-suspend',
        branch_name: 'feature/handoff-suspend',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 4242,
        status: 'running',
        shell: 'pwsh',
        cwd: '/mock/handoff-suspend-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        agentSessionId: 'agent-handoff-suspend',
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/**
 * Main's two-step suspend-for-respawn, in the actual order
 * suspendLiveSessionForRespawn performs it: emit the phase label FIRST
 * (while the session still shows 'running', so the label is inert), then
 * push the suspended session row (exactly what SessionManager.suspend()
 * does almost immediately, well before its own graceful-shutdown await
 * resolves).
 *
 * Also overrides `sessions.reconcile` to return null (real main's contract
 * once a session is genuinely suspended: `reconcileTaskSessionRef` only
 * returns running/queued sessions - see session-store.ts:530-539). The task
 * detail window's own self-heal probe fires `reconcileSession` the instant
 * it observes a 'suspended' session, and the mock's internal session array
 * is never mutated by `__mockFireStatus` (it only invokes the listener), so
 * without this override the probe's *default* mock `reconcile` would
 * resurrect the pre-suspend 'running' snapshot and clear the label itself -
 * a test-harness artifact this override closes, not a claim about
 * production (where main's own session state IS the suspend).
 */
async function simulateSuspendForRespawn(page: Page): Promise<void> {
  await page.evaluate(({ taskId, sessionId, label }) => {
    const win = window as unknown as StoreWindow & {
      electronAPI: { sessions: { reconcile: (taskId: string) => Promise<unknown> } };
    };
    win.electronAPI.sessions.reconcile = async () => null;
    const store = win.__zustandStores.session;
    store.setState({ spawnProgress: { ...store.getState().spawnProgress, [taskId]: label } });
    win.__mockFireStatus(sessionId, {
      id: sessionId,
      taskId,
      projectId: '',
      pid: null,
      status: 'suspended',
      shell: 'pwsh',
      cwd: '/mock/handoff-suspend-test',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      agentSessionId: 'agent-handoff-suspend',
    });
  }, { taskId: TASK_ID, sessionId: SESSION_ID, label: SPAWN_LABEL });
}

test.describe('A same-column respawn keeps its label through the suspend push', () => {
  test('the card shows the respawn label through the suspend push, never Paused', async () => {
    const { browser, page } = await launch();
    try {
      const card = page.locator(`[data-task-id="${TASK_ID}"]`);
      await expect(card).toBeVisible({ timeout: 10000 });

      await simulateSuspendForRespawn(page);

      await expect(card).toContainText(SPAWN_LABEL, { timeout: 5000 });
      await expect(card).not.toContainText('Paused');
    } finally {
      await browser.close();
    }
  });

  test('the detail shows the launch overlay through the suspend push, never a Resume button', async () => {
    const { browser, page } = await launch();
    try {
      await page.evaluate((taskId) => {
        (window as unknown as StoreWindow).__zustandStores.session.getState().setDetailTaskId(taskId);
      }, TASK_ID);

      let windowId: string | null = null;
      await expect.poll(async () => {
        windowId = await page.evaluate((anchorId) => {
          const windows = (window as unknown as StoreWindow).__zustandStores.window.getState().windows;
          return Object.values(windows).find((candidate) => candidate.anchor === anchorId)?.id ?? null;
        }, TASK_ID);
        return windowId;
      }, { timeout: 5000 }).not.toBeNull();

      const frame = page.locator(`[data-testid="window-frame-${windowId}"]`);
      await frame.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });

      await simulateSuspendForRespawn(page);

      // The respawn is advertised as in flight throughout - never the Play
      // button main's own suspended-record push used to expose for the
      // whole unlocked Phase 2 gap.
      await expect(frame).toContainText(SPAWN_LABEL, { timeout: 5000 });
      await expect(frame.locator('button:has-text("Resume session")')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
