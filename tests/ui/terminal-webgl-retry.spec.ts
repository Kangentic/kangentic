/**
 * UI test for the WebGL re-acquisition schedule in
 * `src/renderer/utils/terminal-webgl.ts`, driven through a REAL
 * `terminal.loadAddon(new WebglAddon())` failure rather than a fake factory.
 *
 * Launched with WebGL disabled, so xterm's WebglAddon throws from `activate()`
 * (inside `loadAddon`, not the constructor) on every attempt. On the old code
 * that single throw latched the terminal onto the DOM renderer for good
 * (`permanentDomFallback: true`, no timer armed). Now the initial failure arms
 * the same schedule a context loss uses, so the report must show a second
 * attempt within a few seconds. The unit tier pins the schedule's shape; this
 * spec pins that the production failure path actually enters it.
 *
 * The renderer report is read off `window.__kangenticTerminalRenderers`
 * (installed by `DevtoolsBootstrap` under the Vite dev server), the same way
 * the sibling specs read `window.__kangenticTerminalTrace`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-webgl-retry';
const TASK_ID = 'task-webgl-retry';
const SESSION_ID = 'sess-webgl-retry';
const TASK_TITLE = 'WebGL Retry Task';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'WebGL Retry Test',
      path: '/mock/webgl-retry-test',
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

    // Running session so the task-detail window opens with a live terminal.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/webgl-retry-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: '${TASK_TITLE}',
      description: 'Task used to verify the WebGL retry schedule on a real loadAddon failure',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/webgl-retry',
      branch_name: 'feature/webgl-retry',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

interface RendererStatusEntry {
  renderer: string;
  contextLossCount: number;
  failedAttempts: number;
  retryArmed: boolean;
  suspendedByBudget: boolean;
  permanentDomFallback?: boolean;
}

interface TestWindow {
  __kangenticTerminalRenderers?: () => Record<string, RendererStatusEntry>;
  __zustandStores?: {
    session?: { getState: () => { markFirstOutput: (id: string) => void } };
  };
  electronAPI?: { sessions: { getScrollback: (sessionId: string) => Promise<string> } };
}

async function launchWithoutWebgl(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  // With WebGL disabled, WebglAddon.activate() throws 'WebGL2 not supported'
  // from inside terminal.loadAddon(), which is the production failure path
  // for a blocked or unavailable GPU.
  const browser = await chromium.launch({ headless: true, args: ['--disable-webgl', '--disable-webgl2'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function readRendererStatus(page: Page): Promise<RendererStatusEntry | null> {
  return page.evaluate((sessionId) => {
    const read = (window as unknown as TestWindow).__kangenticTerminalRenderers;
    if (typeof read !== 'function') return null;
    return read()[sessionId] ?? null;
  }, SESSION_ID);
}

test.describe('WebGL retry schedule on a real attach failure', () => {
  test('a terminal whose WebGL attach throws keeps a retry armed and attempts again', async () => {
    // Triples the ui project's 15s budget: a renderer boot, a task-detail
    // open, an xterm mount, and one 2s retry slot land near 5s unloaded, and
    // the margin is for a loaded CI shard (as terminal-init-timing-trace does).
    test.slow();
    const { browser, page } = await launchWithoutWebgl(preConfig);
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

      // Lift the startup overlay so xterm mounts unsuppressed, and give the
      // mount replay something to write.
      await page.evaluate((sessionId) => {
        const testWindow = window as unknown as TestWindow;
        testWindow.__zustandStores?.session?.getState().markFirstOutput(sessionId);
        if (testWindow.electronAPI) {
          testWindow.electronAPI.sessions.getScrollback = async () => 'WEBGL-RETRY-FRAME\r\n';
        }
      }, SESSION_ID);

      await page
        .locator('[data-swimlane-name="Code Review"]')
        .locator(`text=${TASK_TITLE}`)
        .first()
        .click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await dialog.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 10000 });

      // The first attach failed at mount (failedAttempts 1) and armed the 2s
      // slot; the second attempt fails too and re-arms. Reading
      // `failedAttempts >= 2` is what proves the schedule is live: the old
      // code reported permanentDomFallback and never attempted again.
      await expect
        .poll(async () => {
          const status = await readRendererStatus(page);
          return status ? { renderer: status.renderer, retryArmed: status.retryArmed, attempted: status.failedAttempts >= 2 } : null;
        }, { timeout: 10000 })
        .toEqual({ renderer: 'dom', retryArmed: true, attempted: true });

      const status = await readRendererStatus(page);
      expect(status).not.toBeNull();
      expect(status?.suspendedByBudget).toBe(false);
      expect(status?.contextLossCount).toBe(0);
      expect(status?.permanentDomFallback).toBeUndefined();
    } finally {
      await browser.close();
    }
  });
});
