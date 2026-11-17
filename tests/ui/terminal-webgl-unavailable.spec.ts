/**
 * Sentry DESKTOP-32: a launch whose Chromium reports WebGL off must leave every
 * terminal on the DOM renderer with no retry armed. App.tsx pulls the status
 * from `gpuHealth.readStatus()` and hands it to `setTerminalGraphicsSupport`;
 * this is the one test of that wiring. The unit tier owns the module's own
 * behavior.
 *
 * Deliberately NO --disable-webgl: headless Chromium ships SwiftShader, so
 * without the status a terminal here attaches WebGL (terminal-panel-hidden-webgl
 * relies on that). The DOM renderer below can only come from the pulled status.
 *
 * How to verify RED / GREEN: delete the `setTerminalGraphicsSupport(status)`
 * call in App.tsx and the terminal reports 'webgl'.
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT_ID = `proj-webgl-off-${RUN_ID}`;
const TASK_ID = `task-webgl-off-${RUN_ID}`;
const SESSION_ID = `sess-webgl-off-${RUN_ID}`;

test('a terminal mounts on the DOM renderer with no retry when the status says WebGL is off', async () => {
  test.slow();
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(`
      window.__mockGpuWebglAvailable = false;
      window.__mockGpuWebglFeatureStatus = 'disabled_off';
      window.__mockPreConfigure(function (state) {
        var timestamp = new Date().toISOString();
        state.config.terminalPanelVisible = true;
        state.projects.push({
          id: '${PROJECT_ID}',
          name: 'WebGL Off ${RUN_ID}',
          path: '/mock/webgl-off-${RUN_ID}',
          github_url: null,
          default_agent: 'claude',
          last_opened: timestamp,
          created_at: timestamp,
        });
        var executingLaneId = null;
        state.DEFAULT_SWIMLANES.forEach(function (template, index) {
          var laneId = 'lane-wo-${RUN_ID}-' + index;
          if (template.name === 'Executing') executingLaneId = laneId;
          state.swimlanes.push(Object.assign({}, template, {
            id: laneId, position: index, created_at: timestamp,
          }));
        });
        state.sessions.push({
          id: '${SESSION_ID}',
          taskId: '${TASK_ID}',
          projectId: '${PROJECT_ID}',
          pid: 7401,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/webgl-off-${RUN_ID}',
          startedAt: timestamp,
          exitCode: null,
          resuming: false,
        });
        state.tasks.push({
          id: '${TASK_ID}',
          display_id: 1,
          title: 'WebGL Off Task ${RUN_ID}',
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
          created_at: timestamp,
          updated_at: timestamp,
        });
        state.activityCache['${SESSION_ID}'] = 'thinking';
        return { currentProjectId: '${PROJECT_ID}' };
      });
    `);
    await gotoVite(page, VITE_URL);
    await page.waitForLoadState('load');

    const panelPane = page.locator('[data-testid="terminal-session-pane"]');
    await panelPane.waitFor({ state: 'visible', timeout: 15000 });
    await panelPane.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 10000 });
    const sessionId = await panelPane.getAttribute('data-session-id');
    expect(sessionId).not.toBeNull();

    // Polled for the terminal's entry; the renderer is DOM from its first report.
    await expect
      .poll(() => page.evaluate((key) => {
        const modules = window.__kangenticTestModules;
        if (!modules) throw new Error('window.__kangenticTestModules not exposed');
        const status = modules.terminalWebgl.getTerminalRendererReport()[key];
        return status ? { renderer: status.renderer, retryArmed: status.retryArmed } : null;
      }, sessionId as string), { timeout: 10000 })
      .toEqual({ renderer: 'dom', retryArmed: false });
  } finally {
    await browser.close();
  }
});
