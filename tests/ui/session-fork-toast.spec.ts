/**
 * UI tests for the mid-session conversation-fork toast.
 *
 * When a running session's agentSessionId flips from one non-null value to a
 * DIFFERENT non-null value on a SESSION_STATUS push, the live conversation
 * forked (Claude /clear moves the conversation to a brand-new session id and
 * the status-file reconcile re-reports it). App.tsx's onStatus handler shows
 * one info toast so the fork is never silent.
 *
 * The null -> id flip (first capture after spawn) must stay quiet: every
 * session starts with agentSessionId null on the wire and captures its id
 * from the first status.json parse.
 *
 * Two further gates on the toast are covered below: a fork on a session
 * belonging to a NON-current project stays quiet (the toast only fires for
 * `session.projectId === currentProject?.id`), and a fork on a TRANSIENT
 * (Command Terminal) session stays quiet (`!session.transient`).
 *
 * Tier: UI (headless Chromium). The logic lives entirely in App.tsx's
 * onStatus handler + toast store; the push is driven via the mock's
 * window.__mockFireStatus.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Unique run suffix so parallel workers don't collide on shared mock state.
const RUN_ID = Date.now();
const PROJECT_ID = `proj-fork-toast-${RUN_ID}`;
const TASK_ID = `task-fork-toast-${RUN_ID}`;
const SESSION_ID = `sess-fork-toast-${RUN_ID}`;

const FORK_TOAST_TEXT = 'moved to a new session';

/**
 * Launch a headless page pre-configured with a project, a task in the
 * Executing lane, and a RUNNING session for it whose agentSessionId is
 * caller-controlled (null = pre-capture, a string = captured).
 */
async function launchWithRunningSession(agentSessionId: string | null): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Fork Toast Test ${RUN_ID}',
        path: '/mock/fork-toast-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-ft-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId,
          position: index,
          created_at: ts,
        }));
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 4242,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/fork-toast-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        agentSessionId: ${agentSessionId === null ? 'null' : `'${agentSessionId}'`},
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Fork Toast Task ${RUN_ID}',
        description: 'Tests the /clear conversation-fork toast',
        swimlane_id: executingLaneId,
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        labels: [],
        priority: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

/** Fire a SESSION_STATUS push for the seeded session with the given agent id. */
async function fireStatusPush(page: Page, agentSessionId: string | null): Promise<void> {
  await page.evaluate(
    ({ sessionId, taskId, projectId, pushedAgentSessionId }) => {
      const fireStatus = (window as unknown as {
        __mockFireStatus?: (sessionId: string, session: unknown) => void;
      }).__mockFireStatus;
      if (!fireStatus) throw new Error('__mockFireStatus not installed (no onStatus subscriber?)');
      fireStatus(sessionId, {
        id: sessionId,
        taskId,
        projectId,
        pid: 4242,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/fork-toast',
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: false,
        agentSessionId: pushedAgentSessionId,
      });
    },
    { sessionId: SESSION_ID, taskId: TASK_ID, projectId: PROJECT_ID, pushedAgentSessionId: agentSessionId },
  );
}

/**
 * Read a session's captured agentSessionId straight from the renderer's
 * session store (not the mock's IPC layer), via the dev-only
 * `window.__zustandStores` handle App.tsx installs under `import.meta.env.DEV`.
 * Used below to prove a push actually reached the onStatus -> upsertSession
 * pipeline, rather than inferring it indirectly from "no toast appeared".
 */
async function getStoreAgentSessionId(page: Page, sessionId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: { getState: () => { sessions: Array<{ id: string; agentSessionId: string | null }> } };
      };
    }).__zustandStores;
    const session = stores?.session.getState().sessions.find((candidate) => candidate.id === id);
    return session?.agentSessionId ?? null;
  }, sessionId);
}

/**
 * Fire a SESSION_STATUS push for an arbitrary session (unlike `fireStatusPush`
 * above, which is hardcoded to the module-level SESSION_ID/TASK_ID/PROJECT_ID).
 * Used by the project-gate and transient-gate describe blocks below, each of
 * which seeds its own session under its own project/transient shape.
 */
async function fireStatusPushFor(
  page: Page,
  params: {
    sessionId: string;
    taskId: string;
    projectId: string;
    agentSessionId: string | null;
    transient?: boolean;
    status?: string;
  },
): Promise<void> {
  await page.evaluate(
    ({ sessionId, taskId, projectId, agentSessionId, transient, status }) => {
      const fireStatus = (window as unknown as {
        __mockFireStatus?: (sessionId: string, session: unknown) => void;
      }).__mockFireStatus;
      if (!fireStatus) throw new Error('__mockFireStatus not installed (no onStatus subscriber?)');
      fireStatus(sessionId, {
        id: sessionId,
        taskId,
        projectId,
        pid: 4242,
        status: status ?? 'running',
        shell: 'bash',
        cwd: '/mock/fork-toast',
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: false,
        transient: transient ?? false,
        agentSessionId,
      });
    },
    params,
  );
}

test.describe('Conversation-fork toast (agentSessionId flip on a running session)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithRunningSession(`agent-a-${RUN_ID}`));
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('shows exactly one info toast when the agent id flips to a different non-null value', async () => {
    await fireStatusPush(page, `agent-b-${RUN_ID}`);

    const forkToast = page.locator('[data-testid="toast"]').filter({ hasText: FORK_TOAST_TEXT });
    await expect(forkToast).toBeVisible({ timeout: 5000 });
    // The label resolves the task title from the board store.
    await expect(forkToast).toContainText(`Fork Toast Task ${RUN_ID}`);

    // A repeat push with the SAME (already-reconciled) id must not re-toast:
    // after the first upsert the store already holds agent-b.
    await fireStatusPush(page, `agent-b-${RUN_ID}`);
    // Intentional fixed wait: cannot poll for non-occurrence. 800ms is above
    // the React render cycle and below the toast auto-dismiss window.
    await page.waitForTimeout(800);
    expect(await page.locator('[data-testid="toast"]').filter({ hasText: FORK_TOAST_TEXT }).count()).toBe(1);
  });
});

test.describe('First id capture stays quiet (null -> id)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithRunningSession(null));
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('does not toast when a session captures its first agent id', async () => {
    await fireStatusPush(page, `agent-first-${RUN_ID}`);

    // Intentional fixed wait: cannot poll for non-occurrence (see above).
    await page.waitForTimeout(800);
    expect(await page.locator('[data-testid="toast"]').filter({ hasText: FORK_TOAST_TEXT }).count()).toBe(0);
  });
});

test.describe('Fork on a background (non-current) project stays quiet (project gate)', () => {
  let browser: Browser;
  let page: Page;

  const CURRENT_PROJECT_ID = `proj-fork-toast-current-${RUN_ID}`;
  const BACKGROUND_PROJECT_ID = `proj-fork-toast-bg-${RUN_ID}`;
  const BACKGROUND_TASK_ID = `task-fork-toast-bg-${RUN_ID}`;
  const BACKGROUND_SESSION_ID = `sess-fork-toast-bg-${RUN_ID}`;
  const INITIAL_AGENT_SESSION_ID = `agent-bg-a-${RUN_ID}`;
  const FORKED_AGENT_SESSION_ID = `agent-bg-b-${RUN_ID}`;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();

    await page.addInitScript({ path: MOCK_SCRIPT });

    // Two projects: CURRENT_PROJECT_ID is the one the app actually opens
    // (preConfigure's returned currentProjectId below). BACKGROUND_PROJECT_ID
    // is never opened, yet its running session must still land in the
    // renderer's session store: sessions.list() is deliberately unscoped
    // (session-store.ts notes the sidebar needs cross-project data). Only
    // the toast's explicit `session.projectId === currentProject?.id` check
    // should suppress it.
    await page.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();

        state.projects.push({
          id: '${CURRENT_PROJECT_ID}',
          name: 'Fork Toast Current ${RUN_ID}',
          path: '/mock/fork-toast-current-${RUN_ID}',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });
        state.projects.push({
          id: '${BACKGROUND_PROJECT_ID}',
          name: 'Fork Toast Background ${RUN_ID}',
          path: '/mock/fork-toast-bg-${RUN_ID}',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });

        var executingLaneId = null;
        state.DEFAULT_SWIMLANES.forEach(function (template, index) {
          var laneId = 'lane-ft-bg-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
          if (template.name === 'Executing') executingLaneId = laneId;
          state.swimlanes.push(Object.assign({}, template, {
            id: laneId,
            position: index,
            created_at: ts,
          }));
        });

        // Background project's running session, seeded with an already-
        // captured agent id so every OTHER fork conjunct is already true.
        state.sessions.push({
          id: '${BACKGROUND_SESSION_ID}',
          taskId: '${BACKGROUND_TASK_ID}',
          projectId: '${BACKGROUND_PROJECT_ID}',
          pid: 5252,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/fork-toast-bg-${RUN_ID}',
          startedAt: ts,
          exitCode: null,
          resuming: false,
          agentSessionId: '${INITIAL_AGENT_SESSION_ID}',
        });

        state.tasks.push({
          id: '${BACKGROUND_TASK_ID}',
          title: 'Fork Toast Background Task ${RUN_ID}',
          description: 'Background-project task for the project-gate test',
          swimlane_id: executingLaneId,
          projectId: '${BACKGROUND_PROJECT_ID}',
          position: 0,
          agent: 'claude',
          session_id: '${BACKGROUND_SESSION_ID}',
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          labels: [],
          priority: 0,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });

        return { currentProjectId: '${CURRENT_PROJECT_ID}' };
      });
    `);

    await gotoVite(page, VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('does not toast when the forked session belongs to a non-current project', async () => {
    // Confirm the background session actually landed in the renderer's store
    // before firing the fork push. Without this, a suppressed toast could
    // just mean the previousSession lookup missed (a vacuous pass), not that
    // the project gate fired.
    await expect
      .poll(() => getStoreAgentSessionId(page, BACKGROUND_SESSION_ID), { timeout: 5000 })
      .toBe(INITIAL_AGENT_SESSION_ID);

    await fireStatusPushFor(page, {
      sessionId: BACKGROUND_SESSION_ID,
      taskId: BACKGROUND_TASK_ID,
      projectId: BACKGROUND_PROJECT_ID,
      agentSessionId: FORKED_AGENT_SESSION_ID,
    });

    // Confirm the push actually reached the onStatus handler (upsertSession
    // ran unconditionally, before the project-gated toast check). Without
    // this, "no toast" could just mean the push never landed at all.
    await expect
      .poll(() => getStoreAgentSessionId(page, BACKGROUND_SESSION_ID), { timeout: 5000 })
      .toBe(FORKED_AGENT_SESSION_ID);

    // Intentional fixed wait: cannot poll for non-occurrence. 800ms is above
    // the React render cycle and below the toast auto-dismiss window.
    await page.waitForTimeout(800);
    expect(await page.locator('[data-testid="toast"]').filter({ hasText: FORK_TOAST_TEXT }).count()).toBe(0);
  });
});

test.describe('Transient session (Command Terminal) fork stays quiet (transient gate)', () => {
  let browser: Browser;
  let page: Page;

  const PROJECT_ID_TRANSIENT = `proj-fork-toast-transient-${RUN_ID}`;
  const TRANSIENT_SESSION_ID = `sess-fork-toast-transient-${RUN_ID}`;
  // Transient (Command Terminal) sessions have no DB-backed task; this is a
  // synthetic id, mirroring the real spawn path (see App.tsx's
  // COMMAND_TERMINAL_NOTIFICATION_TASK_ID usage for transient sessions).
  const TRANSIENT_TASK_ID = `task-fork-toast-transient-${RUN_ID}`;
  const INITIAL_AGENT_SESSION_ID = `agent-transient-a-${RUN_ID}`;
  const FORKED_AGENT_SESSION_ID = `agent-transient-b-${RUN_ID}`;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();

    await page.addInitScript({ path: MOCK_SCRIPT });

    await page.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();

        state.projects.push({
          id: '${PROJECT_ID_TRANSIENT}',
          name: 'Fork Toast Transient ${RUN_ID}',
          path: '/mock/fork-toast-transient-${RUN_ID}',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });

        state.DEFAULT_SWIMLANES.forEach(function (template, index) {
          state.swimlanes.push(Object.assign({}, template, {
            id: 'lane-ft-transient-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}',
            position: index,
            created_at: ts,
          }));
        });

        // A running, transient (Command Terminal) session with an already-
        // captured agent id, so every OTHER fork conjunct is already true.
        state.sessions.push({
          id: '${TRANSIENT_SESSION_ID}',
          taskId: '${TRANSIENT_TASK_ID}',
          projectId: '${PROJECT_ID_TRANSIENT}',
          pid: 6161,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/fork-toast-transient-${RUN_ID}',
          startedAt: ts,
          exitCode: null,
          resuming: false,
          transient: true,
          agentSessionId: '${INITIAL_AGENT_SESSION_ID}',
        });

        return { currentProjectId: '${PROJECT_ID_TRANSIENT}' };
      });
    `);

    await gotoVite(page, VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('does not toast when a transient (Command Terminal) session forks', async () => {
    // Confirm the transient session landed in the renderer's store before
    // firing the fork push, so a suppressed toast is attributable to the
    // transient gate rather than a missed previousSession lookup.
    await expect
      .poll(() => getStoreAgentSessionId(page, TRANSIENT_SESSION_ID), { timeout: 5000 })
      .toBe(INITIAL_AGENT_SESSION_ID);

    await fireStatusPushFor(page, {
      sessionId: TRANSIENT_SESSION_ID,
      taskId: TRANSIENT_TASK_ID,
      projectId: PROJECT_ID_TRANSIENT,
      agentSessionId: FORKED_AGENT_SESSION_ID,
      transient: true,
    });

    // Confirm the push actually reached the onStatus handler (upsertSession
    // ran unconditionally, before the transient-gated toast check).
    await expect
      .poll(() => getStoreAgentSessionId(page, TRANSIENT_SESSION_ID), { timeout: 5000 })
      .toBe(FORKED_AGENT_SESSION_ID);

    // Intentional fixed wait: cannot poll for non-occurrence. 800ms is above
    // the React render cycle and below the toast auto-dismiss window.
    await page.waitForTimeout(800);
    expect(await page.locator('[data-testid="toast"]').filter({ hasText: FORK_TOAST_TEXT }).count()).toBe(0);
  });
});

test.describe('Fork on a non-running session stays quiet (status gate)', () => {
  let browser: Browser;
  let page: Page;

  const PROJECT_ID_STATUS = `proj-fork-toast-status-${RUN_ID}`;
  const STATUS_SESSION_ID = `sess-fork-toast-status-${RUN_ID}`;
  const STATUS_TASK_ID = `task-fork-toast-status-${RUN_ID}`;
  const INITIAL_AGENT_SESSION_ID = `agent-status-a-${RUN_ID}`;
  const FORKED_AGENT_SESSION_ID = `agent-status-b-${RUN_ID}`;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();

    await page.addInitScript({ path: MOCK_SCRIPT });

    await page.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();

        state.projects.push({
          id: '${PROJECT_ID_STATUS}',
          name: 'Fork Toast Status ${RUN_ID}',
          path: '/mock/fork-toast-status-${RUN_ID}',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });

        var executingLaneId = null;
        state.DEFAULT_SWIMLANES.forEach(function (template, index) {
          var laneId = 'lane-ft-status-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
          if (template.name === 'Executing') executingLaneId = laneId;
          state.swimlanes.push(Object.assign({}, template, {
            id: laneId,
            position: index,
            created_at: ts,
          }));
        });

        // A RUNNING session with an already-captured agent id, so every OTHER
        // fork conjunct (current project, non-transient, non-null previous id)
        // is already true. The push below flips the id while ALSO flipping
        // status away from 'running', isolating the status conjunct.
        state.sessions.push({
          id: '${STATUS_SESSION_ID}',
          taskId: '${STATUS_TASK_ID}',
          projectId: '${PROJECT_ID_STATUS}',
          pid: 7171,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/fork-toast-status-${RUN_ID}',
          startedAt: ts,
          exitCode: null,
          resuming: false,
          agentSessionId: '${INITIAL_AGENT_SESSION_ID}',
        });

        state.tasks.push({
          id: '${STATUS_TASK_ID}',
          title: 'Fork Toast Status Task ${RUN_ID}',
          description: 'Tests the status-gate on the /clear conversation-fork toast',
          swimlane_id: executingLaneId,
          projectId: '${PROJECT_ID_STATUS}',
          position: 0,
          agent: 'claude',
          session_id: '${STATUS_SESSION_ID}',
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          labels: [],
          priority: 0,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });

        return { currentProjectId: '${PROJECT_ID_STATUS}' };
      });
    `);

    await gotoVite(page, VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('does not toast when the id-flip push also reports a non-running status', async () => {
    // Confirm the session landed in the renderer's store before firing the
    // fork push, so a suppressed toast is attributable to the status gate
    // rather than a missed previousSession lookup.
    await expect
      .poll(() => getStoreAgentSessionId(page, STATUS_SESSION_ID), { timeout: 5000 })
      .toBe(INITIAL_AGENT_SESSION_ID);

    // Red: removing `session.status === 'running' &&` from App.tsx's
    // forkedConversation predicate makes this toast fire, since every other
    // conjunct (current project, non-transient, differing non-null ids) holds.
    await fireStatusPushFor(page, {
      sessionId: STATUS_SESSION_ID,
      taskId: STATUS_TASK_ID,
      projectId: PROJECT_ID_STATUS,
      agentSessionId: FORKED_AGENT_SESSION_ID,
      status: 'exited',
    });

    // Confirm the push actually reached the onStatus handler (upsertSession
    // ran unconditionally, before the status-gated toast check). Without
    // this, "no toast" could just mean the push never landed at all.
    await expect
      .poll(() => getStoreAgentSessionId(page, STATUS_SESSION_ID), { timeout: 5000 })
      .toBe(FORKED_AGENT_SESSION_ID);

    // Intentional fixed wait: cannot poll for non-occurrence. 800ms is above
    // the React render cycle and below the toast auto-dismiss window.
    await page.waitForTimeout(800);
    expect(await page.locator('[data-testid="toast"]').filter({ hasText: FORK_TOAST_TEXT }).count()).toBe(0);
  });
});
