/**
 * Regression test for a stale paused session row surviving a resume.
 *
 * The UI mock's sessions.resume (tests/ui/mock-electron-api.js) splices the task's suspended
 * session row out of its OWN registry, as main's real respawn (session-spawn-flow.ts) drops it
 * from main's, and then announces the removal (window.__mockFireRemoved, the session-removed
 * push) before handing back the new running session. That push is the mock's own: main drops the
 * row silently. The renderer's own resumeSession() store action ALSO filters by
 * taskId when it applies the new session optimistically, so the store already looks correct
 * immediately after a resume even if the mock never dropped the old row from its own registry.
 * The stale row only resurfaces on the NEXT re-sync (syncSessions(), which every HMR reload and
 * project switch triggers): syncSessions() takes the mock's own sessions.list() as ground truth,
 * and a row the mock never spliced comes back as a second, stale suspended row for the task the
 * moment that next sync runs.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { gotoVite, waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-session-resume-drops-paused';
const TASK_ID = 'task-session-resume-drops-paused-probe';
const TASK_TITLE = 'Session Resume Drops Paused Row Probe';
const PAUSED_SESSION_ID = 'session-resume-drops-paused-old';

interface SessionRow { id: string; taskId: string; status: string }
interface SessionWindow {
  __zustandStores: {
    session: {
      getState: () => {
        sessions: SessionRow[];
        resumeSession: (taskId: string) => Promise<SessionRow>;
        syncSessions: () => Promise<boolean>;
      };
    };
  };
  __mockFireRemoved?: (sessionId: string, session: unknown, projectId: string) => void;
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Session Resume Drops Paused Test',
        path: '/mock/session-resume-drops-paused-test',
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
      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: '${TASK_TITLE}',
        description: 'A task whose agent is paused, then resumed',
        swimlane_id: 'lane-executing',
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: 'feature/session-resume-drops-paused',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.sessions.push({
        id: '${PAUSED_SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 4343,
        status: 'suspended',
        shell: 'bash',
        cwd: '/mock/session-resume-drops-paused-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        agentSessionId: 'agent-session-resume-drops-paused',
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

test.describe('Resume drops the paused session row, even after a re-sync', () => {
  test('resuming a paused task leaves exactly one session row, before and after syncSessions', async () => {
    // launch() boots a full app instance inside the test body (Vite poll, chromium.launch,
    // goto+load, the app-shell wait) before the 15000ms board wait below starts, and that wait
    // alone equals the project's default per-test timeout. See task-detail-archived-no-resume.spec.ts.
    test.setTimeout(30_000);
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });

      // Precondition: the suspended session really is in the renderer store, so a green result
      // cannot come from the fixture simply never being wired up.
      await expect.poll(async () => page.evaluate((taskId) => {
        const state = (window as unknown as SessionWindow).__zustandStores.session.getState();
        return state.sessions.filter((session) => session.taskId === taskId).map((session) => session.id);
      }, TASK_ID), { timeout: 5000 }).toEqual([PAUSED_SESSION_ID]);

      // Resume through the real store action, the same one the task window's Resume button
      // calls, and spy on window.__mockFireRemoved rather than stubbing sessions.resume() itself.
      const fireRemovedCalls = await page.evaluate(async (taskId) => {
        const win = window as unknown as SessionWindow;
        const original = win.__mockFireRemoved;
        if (!original) throw new Error('__mockFireRemoved not installed before resume: App.tsx has not subscribed yet');
        const calls: string[] = [];
        win.__mockFireRemoved = (sessionId, session, projectId) => {
          calls.push(sessionId);
          original(sessionId, session, projectId);
        };
        await win.__zustandStores.session.getState().resumeSession(taskId);
        win.__mockFireRemoved = original;
        return calls;
      }, TASK_ID);
      expect(fireRemovedCalls).toEqual([PAUSED_SESSION_ID]);

      const rowsForTask = () => page.evaluate((taskId) => {
        const state = (window as unknown as SessionWindow).__zustandStores.session.getState();
        return state.sessions.filter((session) => session.taskId === taskId).map((session) => session.id);
      }, TASK_ID);

      const resumedRows = await rowsForTask();
      expect(resumedRows).toHaveLength(1);
      expect(resumedRows[0]).not.toBe(PAUSED_SESSION_ID);
      const resumedId = resumedRows[0];

      // The real bug surfaces on the NEXT re-sync, not on the resume itself: syncSessions()
      // (every HMR reload, every project switch) takes the mock's own sessions.list() as ground
      // truth, so a row the mock never spliced out of its own registry comes back here.
      await page.evaluate(() => (window as unknown as SessionWindow).__zustandStores.session.getState().syncSessions());
      expect(await rowsForTask()).toEqual([resumedId]);
    } finally {
      await browser.close();
    }
  });
});
