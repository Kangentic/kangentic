/**
 * UI coverage for LaunchOverlay's `variant="terminal"` (TerminalTab.tsx),
 * which paints the resolved terminal background/foreground
 * (useTerminal.ts's resolveTerminalBackground / resolveTerminalForeground)
 * instead of the theme-tracking `bg-surface`, so a cold terminal launch
 * shows one continuous surface color instead of a flash when the overlay
 * lifts and the settled xterm underneath is revealed.
 *
 * The session is deliberately left COLD (no markFirstOutput) so the launch
 * overlay stays mounted and inspectable, mirroring the cold-session setup
 * in terminal-replay-veil.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

interface SessionFixture {
  projectId: string;
  taskId: string;
  sessionId: string;
  taskTitle: string;
  laneIdPrefix: string;
}

/** Wraps electronAPI.config.get/getGlobal to inject a custom terminal
 *  background - the mock's config closure isn't exposed to __mockPreConfigure,
 *  so this intercepts at the API boundary instead (mirrors
 *  remember-active-task.spec.ts's configOverrides pattern). Must run BEFORE
 *  React mounts (addInitScript), same as the pre-configure call itself. */
function customTerminalBackgroundScript(background: string): string {
  return `
    (function () {
      function injectBackground(result) {
        result.terminal = Object.assign({}, result.terminal, {
          colors: Object.assign({}, result.terminal && result.terminal.colors, { background: '${background}' }),
        });
        return result;
      }
      var originalGet = window.electronAPI.config.get;
      window.electronAPI.config.get = async function () {
        return injectBackground(await originalGet());
      };
      var originalGetGlobal = window.electronAPI.config.getGlobal;
      window.electronAPI.config.getGlobal = async function () {
        return injectBackground(await originalGetGlobal());
      };
    })();
  `;
}

/** Same interception as customTerminalBackgroundScript, for the foreground slot -
 *  proves LaunchOverlay's terminal-variant label color is wired to
 *  resolveTerminalForeground (a live user override) rather than a hardcoded
 *  constant that happens to match the default. */
function customTerminalForegroundScript(foreground: string): string {
  return `
    (function () {
      function injectForeground(result) {
        result.terminal = Object.assign({}, result.terminal, {
          colors: Object.assign({}, result.terminal && result.terminal.colors, { foreground: '${foreground}' }),
        });
        return result;
      }
      var originalGet = window.electronAPI.config.get;
      window.electronAPI.config.get = async function () {
        return injectForeground(await originalGet());
      };
      var originalGetGlobal = window.electronAPI.config.getGlobal;
      window.electronAPI.config.getGlobal = async function () {
        return injectForeground(await originalGetGlobal());
      };
    })();
  `;
}

function basePreConfigScript(fixture: SessionFixture, extraConfig: string = ''): string {
  return `
    ${extraConfig}
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${fixture.projectId}',
        name: 'Launch Overlay Terminal Surface Test',
        path: '/mock/${fixture.projectId}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = '${fixture.laneIdPrefix}-' + i;
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      // A running session so TerminalTab mounts a real xterm (displayKind ===
      // 'running' inside TaskDetailBody), left cold (no markFirstOutput) so
      // the launch overlay stays showing.
      state.sessions.push({
        id: '${fixture.sessionId}',
        taskId: '${fixture.taskId}',
        projectId: '${fixture.projectId}',
        pid: 9999,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/${fixture.projectId}',
        startedAt: ts,
        exitCode: null,
      });

      state.tasks.push({
        id: '${fixture.taskId}',
        display_id: 1,
        title: '${fixture.taskTitle}',
        description: 'Task used for the launch overlay terminal surface test',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${fixture.sessionId}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${fixture.projectId}' };
    });
  `;
}

async function launchWithState(extraScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(extraScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function openTaskDialog(page: Page, laneName: string, taskTitle: string): Promise<ReturnType<Page['locator']>> {
  await page.locator(`[data-swimlane-name="${laneName}"]`).waitFor({ state: 'visible', timeout: 15000 });
  const card = page.locator(`[data-swimlane-name="${laneName}"]`).locator(`text=${taskTitle}`).first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  return dialog;
}

test.describe('LaunchOverlay terminal-variant surface', () => {
  test('matches the resolved default terminal background, not the theme surface', async () => {
    const fixture: SessionFixture = {
      projectId: 'proj-overlay-terminal-default',
      taskId: 'task-overlay-terminal-default',
      sessionId: 'sess-overlay-terminal-default',
      taskTitle: 'Overlay Terminal Default Task',
      laneIdPrefix: 'lane-lots-default',
    };
    const { browser, page } = await launchWithState(basePreConfigScript(fixture));
    try {
      const dialog = await openTaskDialog(page, 'Code Review', fixture.taskTitle);
      const overlay = dialog.locator('[data-testid="launch-overlay"]');
      await expect(overlay).toBeVisible();

      // Resolved default (#0c0c0c), not the theme-tracking bg-surface color -
      // this is the property that goes red if variant="terminal" is dropped.
      const overlayBackground = await overlay.evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(overlayBackground).toBe('rgb(12, 12, 12)');

      // The overlay must match the host container it sits on top of, so
      // there is no seam/flash the instant the overlay unmounts.
      const container = dialog.locator('[data-testid="terminal-tab-container"]');
      const containerBackground = await container.evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(overlayBackground).toBe(containerBackground);

      // The label's resolved default foreground (#e4e4e7), not the theme-tracking
      // text-fg-muted color - this is the property that goes red if the span's
      // inline style is reverted to the surface variant's Tailwind class.
      const label = overlay.locator('span');
      const labelColor = await label.evaluate((element) => getComputedStyle(element).color);
      expect(labelColor).toBe('rgb(228, 228, 231)');

      // The terminal variant dims the label via inline opacity (no muted token
      // in the terminal palette) - pins TERMINAL_LABEL_MUTED_OPACITY.
      const labelOpacity = await label.evaluate((element) => getComputedStyle(element).opacity);
      expect(labelOpacity).toBe('0.7');
    } finally {
      await browser.close();
    }
  });

  test('tracks a custom terminal foreground override', async () => {
    const fixture: SessionFixture = {
      projectId: 'proj-overlay-terminal-fg-custom',
      taskId: 'task-overlay-terminal-fg-custom',
      sessionId: 'sess-overlay-terminal-fg-custom',
      taskTitle: 'Overlay Terminal Foreground Custom Task',
      laneIdPrefix: 'lane-lots-fg-custom',
    };
    const { browser, page } = await launchWithState(
      basePreConfigScript(fixture, customTerminalForegroundScript('#00ff00')),
    );
    try {
      const dialog = await openTaskDialog(page, 'Code Review', fixture.taskTitle);
      const overlay = dialog.locator('[data-testid="launch-overlay"]');
      await expect(overlay).toBeVisible();

      const label = overlay.locator('span');
      const labelColor = await label.evaluate((element) => getComputedStyle(element).color);
      expect(labelColor).toBe('rgb(0, 255, 0)');
    } finally {
      await browser.close();
    }
  });

  test('tracks a custom terminal background override', async () => {
    const fixture: SessionFixture = {
      projectId: 'proj-overlay-terminal-custom',
      taskId: 'task-overlay-terminal-custom',
      sessionId: 'sess-overlay-terminal-custom',
      taskTitle: 'Overlay Terminal Custom Task',
      laneIdPrefix: 'lane-lots-custom',
    };
    const { browser, page } = await launchWithState(
      basePreConfigScript(fixture, customTerminalBackgroundScript('#ff00ff')),
    );
    try {
      const dialog = await openTaskDialog(page, 'Code Review', fixture.taskTitle);
      const overlay = dialog.locator('[data-testid="launch-overlay"]');
      await expect(overlay).toBeVisible();

      const overlayBackground = await overlay.evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(overlayBackground).toBe('rgb(255, 0, 255)');
    } finally {
      await browser.close();
    }
  });
});
