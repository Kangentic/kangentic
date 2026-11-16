/**
 * UI tests for how the task-detail "View conversation" pill follows a task's
 * registry row as it changes under an open window (GitHub #822):
 *
 * - A running row that flips to suspended keeps the pill enabled while the
 *   transcript listing for it is still pending (a running session stands as
 *   the answer until the listing replaces it), then settles to the listing.
 * - A suspended, unlisted row replaced by another non-running row re-checks
 *   the listing, so a row that now has a record enables the pill.
 *
 * The listing is driven at runtime through
 * `window.__mockTranscriptsListSessionsOverride`. No bare waitForTimeout:
 * every wait polls a condition.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-conv-flips';
const TASK_ID = 'task-conv-flips';
const FIRST_SESSION_ID = 'sess-conv-flips-first';
const SECOND_SESSION_ID = 'sess-conv-flips-second';

type SessionRow = { id: string; status: string; pid: number | null };

const preConfigScript = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Conversation Flips', path: '/mock/conv-flips',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-conv-flips-' + index;
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Flipping row task', description: '',
      swimlane_id: laneIds['Code Review'], position: 0, agent: null, session_id: null,
      worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
      base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page };
}

/** Replace the task's registry row, the way a session push does. */
async function setTaskRow(page: Page, row: SessionRow) {
  await page.evaluate(({ taskId, projectId, sessionRow }) => {
    const stores = (window as unknown as {
      __zustandStores: { session: { setState: (partial: unknown) => void } };
    }).__zustandStores;
    const session = {
      id: sessionRow.id, taskId, projectId, pid: sessionRow.pid, status: sessionRow.status,
      shell: '', cwd: '/mock/conv-flips', startedAt: new Date().toISOString(), exitCode: null, resuming: false,
    };
    stores.session.setState({ sessions: [session], _sessionByTaskId: new Map([[taskId, session]]) });
  }, { taskId: TASK_ID, projectId: PROJECT_ID, sessionRow: row });
}

/**
 * Serve the listing from the page: every call is recorded, and a call waits
 * on `hold` when one is set. `answer` is what the listing returns.
 */
async function installListing(page: Page, options: { hold: boolean }) {
  await page.evaluate((holdFirst) => {
    const scope = window as unknown as {
      __listCalls: number;
      __listAnswer: unknown[];
      __releaseListing: () => void;
      __mockTranscriptsListSessionsOverride: (taskId: string) => Promise<unknown[]>;
    };
    scope.__listCalls = 0;
    scope.__listAnswer = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    scope.__releaseListing = release;
    scope.__mockTranscriptsListSessionsOverride = () => {
      scope.__listCalls += 1;
      if (holdFirst) return gate.then(() => scope.__listAnswer.slice());
      return Promise.resolve(scope.__listAnswer.slice());
    };
  }, options.hold);
}

async function listingCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __listCalls: number }).__listCalls);
}

async function openTaskDetail(page: Page) {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setDetailTaskId: (taskId: string) => void } } };
    }).__zustandStores;
    stores?.session.getState().setDetailTaskId(id);
  }, TASK_ID);
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('Conversation pill follows the row', () => {
  test('a running row that pauses keeps the pill enabled while the listing is pending, then settles to it', async () => {
    const { browser, page } = await launch();
    try {
      await installListing(page, { hold: true });
      await setTaskRow(page, { id: FIRST_SESSION_ID, status: 'running', pid: 4242 });
      await openTaskDetail(page);

      const pill = page.getByTestId('conversation-pill');
      await expect(pill).toBeEnabled();
      expect(await listingCalls(page)).toBe(0);

      await setTaskRow(page, { id: FIRST_SESSION_ID, status: 'suspended', pid: null });
      // The effect has run for the suspended row, and its listing is held.
      await expect.poll(() => listingCalls(page)).toBeGreaterThanOrEqual(1);
      await expect(pill).toBeEnabled();

      // The listing answers empty: the pill settles to it.
      await page.evaluate(() => (window as unknown as { __releaseListing: () => void }).__releaseListing());
      await expect(pill).toBeDisabled();
    } finally {
      await browser.close();
    }
  });

  test('a suspended row replaced by another that has a record re-checks the listing and enables the pill', async () => {
    const { browser, page } = await launch();
    try {
      await installListing(page, { hold: false });
      await setTaskRow(page, { id: FIRST_SESSION_ID, status: 'suspended', pid: null });
      await openTaskDetail(page);

      const pill = page.getByTestId('conversation-pill');
      await expect.poll(() => listingCalls(page)).toBeGreaterThanOrEqual(1);
      await expect(pill).toBeDisabled();
      const callsBeforeReplacement = await listingCalls(page);

      await page.evaluate((sessionId) => {
        (window as unknown as { __listAnswer: unknown[] }).__listAnswer = [
          { sessionId, agentName: 'Claude Code', startedAt: new Date().toISOString(), exitedAt: null, isolatedSwimlaneId: null, status: 'exited' },
        ];
      }, SECOND_SESSION_ID);
      await setTaskRow(page, { id: SECOND_SESSION_ID, status: 'suspended', pid: null });

      await expect(pill).toBeEnabled();
      expect(await listingCalls(page)).toBeGreaterThan(callsBeforeReplacement);
    } finally {
      await browser.close();
    }
  });
});
