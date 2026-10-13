/**
 * Regression spec: a bottom panel that is not on screen must not hold a WebGL slot.
 *
 * `useFocusedSessionsSync` resolves the panel's session from `panelShowsTerminal`, and
 * `planTerminalVisibility` gives that session the FIRST slot of the page's WebGL budget
 * (`WEBGL_ATTACH_BUDGET`, minus non-terminal reservations), ahead of every visible
 * window. `AppLayout` used to pass `useTerminalResize`'s `showContent` there, and that
 * stays true while the panel is not rendered at all: hidden in Settings, or the Backlog
 * view. So a slot went to a terminal that did not exist, and the least recent detail
 * window fell back to the DOM renderer, which measures a wider cell and so lays the
 * agent's frame out at fewer columns.
 *
 * The case: the panel hidden in Settings, two running sessions, a detail window open for
 * one of them, and the budget squeezed to a single slot through the same reservation
 * the Knowledge Graph's canvas uses. The window's terminal must hold that slot.
 *
 * The second case is the Backlog half of the same rule. The panel is visible in Settings and
 * expanded, with its terminal mounted on the board, and then the view moves to Backlog, which
 * renders no panel while `showContent` stays true. Board windows are parked there, so the
 * competitor for the slot is a Command Terminal window, which stays on screen over any view.
 *
 * Deliberately NO --disable-webgl: headless Chromium ships SwiftShader, and the budget
 * only bites when WebGL attaches (window-reveal-grid-width.spec.ts relies on the same).
 *
 * How to verify RED / GREEN: in `AppLayout.tsx`, pass `terminal.showContent` alone to
 * `useFocusedSessionsSync`. The window's terminal is budget-suspended onto the DOM renderer.
 * For the Backlog case, pass `terminal.showContent && config.terminalPanelVisible !== false`
 * instead (the render gate without the view term). The Command Terminal's renderer is
 * budget-suspended the same way.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT_ID = `proj-hidden-webgl-${RUN_ID}`;
const WINDOW_TASK_ID = `task-hidden-webgl-window-${RUN_ID}`;
const WINDOW_SESSION_ID = `sess-hidden-webgl-window-${RUN_ID}`;
const PANEL_TASK_ID = `task-hidden-webgl-panel-${RUN_ID}`;
const PANEL_SESSION_ID = `sess-hidden-webgl-panel-${RUN_ID}`;
const WINDOW_TASK_TITLE = `Window Task ${RUN_ID}`;

/** The budget is 8; holding 7 leaves the terminals one slot to share. */
const RESERVED_CONTEXTS = 7;

function preConfig(panelVisible: boolean): string {
  return `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.config.terminalPanelVisible = ${panelVisible};
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Hidden Panel WebGL ${RUN_ID}',
        path: '/mock/hidden-webgl-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: timestamp,
        created_at: timestamp,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-hw-${RUN_ID}-' + index;
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId, position: index, created_at: timestamp,
        }));
      });

      [
        { taskId: '${WINDOW_TASK_ID}', sessionId: '${WINDOW_SESSION_ID}', title: '${WINDOW_TASK_TITLE}', position: 0, pid: 7301 },
        { taskId: '${PANEL_TASK_ID}', sessionId: '${PANEL_SESSION_ID}', title: 'Panel Task ${RUN_ID}', position: 1, pid: 7302 },
      ].forEach(function (seed) {
        state.sessions.push({
          id: seed.sessionId,
          taskId: seed.taskId,
          projectId: '${PROJECT_ID}',
          pid: seed.pid,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/hidden-webgl-${RUN_ID}',
          startedAt: timestamp,
          exitCode: null,
          resuming: false,
        });
        state.tasks.push({
          id: seed.taskId,
          display_id: seed.position + 1,
          title: seed.title,
          description: '',
          swimlane_id: executingLaneId,
          position: seed.position,
          agent: 'claude',
          session_id: seed.sessionId,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          archived_at: null,
          created_at: timestamp,
          updated_at: timestamp,
        });
        state.activityCache[seed.sessionId] = 'thinking';
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(panelVisible: boolean): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(panelVisible));
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

interface RendererStatus {
  renderer: string;
  suspendedByBudget: boolean;
}

/** The renderer status of one terminal, read from the same module instance the app uses. */
async function readRendererStatus(page: Page, sessionId: string): Promise<RendererStatus | null> {
  return page.evaluate(async (key) => {
    const module = await import('/src/renderer/utils/terminal-webgl.ts');
    const status = module.getTerminalRendererReport()[key];
    return status ? { renderer: status.renderer, suspendedByBudget: status.suspendedByBudget } : null;
  }, sessionId);
}

/** Squeeze the page's WebGL budget to one slot, through the reservation the Knowledge Graph uses. */
async function squeezeBudgetToOneSlot(page: Page): Promise<void> {
  await page.evaluate(async (count) => {
    const module = await import('/src/renderer/utils/terminal-webgl.ts');
    for (let index = 0; index < count; index += 1) module.reserveWebglContext(`hidden-panel-spec-${index}`);
  }, RESERVED_CONTEXTS);
}

test('a hidden bottom panel leaves its WebGL slot to the open detail window', async () => {
  // SwiftShader init on top of the ui project's 15s budget, as in window-reveal-grid-width.
  test.slow();
  const { browser, page } = await launch(false);
  try {
    // The panel is hidden in Settings, so its container is never rendered.
    await expect(page.locator('[data-testid="terminal-panel-container"]')).toHaveCount(0);

    await squeezeBudgetToOneSlot(page);

    await page.locator('[data-swimlane-name="Executing"]').locator(`text=${WINDOW_TASK_TITLE}`).first().click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 10000 });

    // The window's terminal is the only terminal on screen, so it holds the one slot.
    // Polled because the coordinator re-applies its plan after the terminal mounts.
    await expect
      .poll(() => readRendererStatus(page, WINDOW_SESSION_ID), { timeout: 10000 })
      .toEqual({ renderer: 'webgl', suspendedByBudget: false });
    // And the panel's session has no terminal at all to spend a slot on.
    expect(await readRendererStatus(page, PANEL_SESSION_ID)).toBeNull();
  } finally {
    await browser.close();
  }
});

test('a bottom panel on the Backlog view leaves its WebGL slot to the open Command Terminal', async () => {
  test.slow();
  const { browser, page } = await launch(true);
  try {
    // The panel is visible in Settings and expanded, with its terminal mounted on the board.
    // That is the precondition: `showContent` holds, and nothing on Backlog changes it.
    const panelPane = page.locator('[data-testid="terminal-session-pane"]');
    await panelPane.waitFor({ state: 'visible', timeout: 10000 });
    const panelSessionId = await panelPane.getAttribute('data-session-id');
    expect(panelSessionId).not.toBeNull();

    // Backlog renders no panel, and parks the board windows. The budget is squeezed and the
    // Command Terminal opened only after that, so the coordinator plans the contested budget
    // from the Command Terminal's own mount rather than inheriting an earlier plan.
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await expect(page.locator('[data-testid="terminal-panel-container"]')).toHaveCount(0);
    await squeezeBudgetToOneSlot(page);

    await page.locator('[data-testid="quick-session-button"]').click();
    await expect(page.getByTestId('command-terminal-window')).toBeVisible();

    // The window's xterm opens only once the session has produced output, and the mock's
    // spawn produces none. So find the session the renderer paired to the window, as the
    // other Command Terminal specs do, and mark its first output.
    const commandSessionIdHandle = await page.waitForFunction(() => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: { getState: () => { transientSessions: Record<string, { sessionId: string }> } };
        };
      }).__zustandStores;
      const entries = Object.values(stores?.session.getState().transientSessions ?? {});
      return entries.length > 0 ? entries[0].sessionId : null;
    }, undefined, { timeout: 10000 });
    const commandSessionId = (await commandSessionIdHandle.jsonValue()) as string;
    expect(commandSessionId).not.toBe(panelSessionId);
    await page.evaluate((sessionId) => {
      const stores = (window as unknown as {
        __zustandStores?: { session: { getState: () => { markFirstOutput: (sessionId: string) => void } } };
      }).__zustandStores;
      if (!stores) throw new Error('window.__zustandStores not exposed');
      stores.session.getState().markFirstOutput(sessionId);
    }, commandSessionId);
    await page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first()
      .waitFor({ state: 'attached', timeout: 10000 });

    // The Command Terminal is the only terminal on screen, so it holds the one slot. The
    // panel's session has no terminal in Backlog to spend it on. Polled because the
    // coordinator re-applies its plan after the terminal mounts.
    await expect
      .poll(() => readRendererStatus(page, commandSessionId), { timeout: 10000 })
      .toEqual({ renderer: 'webgl', suspendedByBudget: false });
  } finally {
    await browser.close();
  }
});
