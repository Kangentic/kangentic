/**
 * UI tests for the Command Terminal feature.
 *
 * Tests the TitleBar button visibility, transient session filtering from
 * the terminal panel, and the Ctrl+Shift+P hotkey toggle behavior.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-cmd-term';
const PROJECT_A_ID = 'proj-cmd-a';
const PROJECT_B_ID = 'proj-cmd-b';
const TASK_SESSION_ID = 'sess-task-1';
const TASK_ID = 'task-1';
const TRANSIENT_SESSION_ID = 'sess-transient-1';

/**
 * Pre-configure mock state with a project, a task session, and a transient session.
 */
function preConfigWithTransientSession(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Test Project',
        path: '/mock/test-project',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-cmd-' + i,
          position: i,
          created_at: ts,
        }));
      });

      // Regular task session
      state.sessions.push({
        id: '${TASK_SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 2001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/test-project',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });

      // Transient session (command terminal)
      state.sessions.push({
        id: '${TRANSIENT_SESSION_ID}',
        taskId: 'ephemeral-uuid',
        projectId: '${PROJECT_ID}',
        pid: 2002,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/test-project',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        transient: true,
      });

      state.activityCache['${TASK_SESSION_ID}'] = 'idle';
      state.activityCache['${TRANSIENT_SESSION_ID}'] = 'idle';

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Regular Task',
        description: '',
        swimlane_id: 'lane-cmd-0',
        position: 0,
        agent: null,
        session_id: '${TASK_SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/**
 * Pre-configure mock state with two projects for cross-project transient session tests.
 * Starts with Project A active. No transient sessions pre-spawned - tests open them via hotkey.
 */
function twoProjectPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_A_ID}',
        name: 'Project Alpha',
        path: '/mock/project-alpha',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.projects.push({
        id: '${PROJECT_B_ID}',
        name: 'Project Beta',
        path: '/mock/project-beta',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-cmd-multi-' + i,
          position: i,
          created_at: ts,
        }));
      });

      return { currentProjectId: '${PROJECT_A_ID}' };
    });
  `;
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

test.describe('Command Terminal', () => {
  test.describe('TitleBar Button', () => {
    test('Command Terminal button is visible when a project is open', async () => {
      const { browser, page } = await launchWithState(preConfigWithTransientSession());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(page.getByTestId('quick-session-button')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('Command Terminal button is hidden when no project is open', async () => {
      await waitForViteReady();
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      await page.addInitScript({ path: MOCK_SCRIPT });
      await page.goto(VITE_URL);
      await page.waitForLoadState('load');
      await page.waitForSelector('text=Kangentic', { timeout: 15000 });

      try {
        // No project open - welcome screen visible, button should be hidden
        await expect(page.locator('[data-testid="welcome-open-project"]')).toBeVisible();
        await expect(page.getByTestId('quick-session-button')).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  test.describe('Terminal Panel Filtering', () => {
    test('transient sessions are excluded from the terminal panel tabs', async () => {
      const { browser, page } = await launchWithState(preConfigWithTransientSession());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // The regular task session tab should be visible
        const taskTab = page.locator('button:has-text("regular-task")');
        await expect(taskTab).toBeVisible();

        // The transient session should NOT appear as a tab
        const transientTab = page.locator('button:has-text("ephemeral-uuid")');
        await expect(transientTab).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  test.describe('Hotkey', () => {
    test('Ctrl+Shift+P opens the command bar overlay', async () => {
      const { browser, page } = await launchWithState(preConfigWithTransientSession());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Command bar should not be visible initially
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible();

        // Press Ctrl+Shift+P
        await page.keyboard.press('Control+Shift+P');

        // Command bar should appear
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();
        await expect(page.getByText('Command Terminal', { exact: true })).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('Ctrl+Shift+P toggles the command bar closed', async () => {
      const { browser, page } = await launchWithState(preConfigWithTransientSession());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        // Close
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible({ timeout: 5000 });
      } finally {
        await browser.close();
      }
    });
  });

  test.describe('Background Session Indicator', () => {
    test('pulsing indicator appears on TitleBar button when transient session is in background', async () => {
      const { browser, page } = await launchWithState(preConfigWithTransientSession());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Set transientSessionId in the session store to simulate a background session
        await page.evaluate(() => {
          const { useSessionStore } = require('./src/renderer/stores/session-store');
          useSessionStore.setState({ transientSessionId: 'sess-transient-1' });
        }).catch(() => {
          // Store not accessible via require in browser context - use addInitScript approach instead
        });

        // Use a pre-configured approach: inject transientSessionId via mock state
        // The mock spawnTransient sets transientSessionId when called, so open and close the overlay
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        // Close overlay - session should remain in background
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible({ timeout: 5000 });

        // The pulsing indicator should appear on the TitleBar button
        await expect(page.getByTestId('transient-session-indicator')).toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  test.describe('Overlay Header Controls', () => {
    test('close button (X) hides the overlay without killing session', async () => {
      const { browser, page } = await launchWithState(preConfigWithTransientSession());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open overlay
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        // Click the X close button
        await page.locator('[aria-label="Hide terminal"]').click();
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible({ timeout: 5000 });

        // Indicator should show - session still alive in background
        await expect(page.getByTestId('transient-session-indicator')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('stop button terminates the session and closes overlay', async () => {
      const { browser, page } = await launchWithState(preConfigWithTransientSession());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open overlay
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        // Click the stop button
        await page.getByTestId('command-bar-terminate-button').click();
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible({ timeout: 5000 });

        // No background indicator - session was killed
        await expect(page.getByTestId('transient-session-indicator')).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('kebab menu renders with expected items', async () => {
      const { browser, page } = await launchWithState(preConfigWithTransientSession());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open overlay
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        // Click the kebab menu button
        await page.locator('[title="Actions"]').click();

        // Verify menu items (use nth(1) for "Commands" to avoid matching the header pill)
        await expect(page.locator('button:has-text("Open folder")')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Commands' }).nth(1)).toBeVisible();
        await expect(page.getByTestId('command-bar-kebab-stop')).toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  test.describe('Cross-Project Transient Session Persistence', () => {
    test('transient session survives project switch and reattaches on return', async () => {
      const { browser, page } = await launchWithState(twoProjectPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open command terminal in Project A and close overlay (session stays in background)
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible({ timeout: 5000 });

        // Background indicator should be visible for Project A's transient session
        await expect(page.getByTestId('transient-session-indicator')).toBeVisible();

        // Switch to Project B
        await page.locator('[role="button"]:has-text("Project Beta")').click();
        await page.waitForTimeout(500);

        // No transient indicator for Project B (never opened command terminal there)
        await expect(page.getByTestId('transient-session-indicator')).not.toBeVisible();

        // Switch back to Project A
        await page.locator('[role="button"]:has-text("Project Alpha")').click();
        await page.waitForTimeout(500);

        // Background indicator should reappear - session was stashed, not killed
        await expect(page.getByTestId('transient-session-indicator')).toBeVisible();

        // Opening the command bar should reattach to the existing session (no new spawn)
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('command bar overlay closes automatically on project switch', async () => {
      const { browser, page } = await launchWithState(twoProjectPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open command terminal in Project A
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        // Trigger project switch programmatically (overlay backdrop blocks sidebar clicks)
        await page.evaluate(async () => {
          const store = (window as any).__zustandStores?.project;
          if (store) {
            await store.getState().openProject('proj-cmd-b');
          }
        });
        await page.waitForTimeout(500);

        // Overlay should close automatically via useCommandBar's currentProjectId effect
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible({ timeout: 5000 });
      } finally {
        await browser.close();
      }
    });

    test('each project gets its own independent transient session', async () => {
      const { browser, page } = await launchWithState(twoProjectPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open and close command terminal in Project A
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId('transient-session-indicator')).toBeVisible();

        // Switch to Project B
        await page.locator('[role="button"]:has-text("Project Beta")').click();
        await page.waitForTimeout(500);

        // No indicator yet for Project B
        await expect(page.getByTestId('transient-session-indicator')).not.toBeVisible();

        // Open and close command terminal in Project B (spawns a new session)
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId('transient-session-indicator')).toBeVisible();

        // Switch back to Project A - its indicator should still be there
        await page.locator('[role="button"]:has-text("Project Alpha")').click();
        await page.waitForTimeout(500);
        await expect(page.getByTestId('transient-session-indicator')).toBeVisible();

        // Switch to Project B - its indicator should also still be there
        await page.locator('[role="button"]:has-text("Project Beta")').click();
        await page.waitForTimeout(500);
        await expect(page.getByTestId('transient-session-indicator')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('deleting a project kills its transient session', async () => {
      const { browser, page } = await launchWithState(twoProjectPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open and close command terminal in Project A (creates a background transient)
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).not.toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId('transient-session-indicator')).toBeVisible();

        // Switch to Project B
        await page.locator('[role="button"]:has-text("Project Beta")').click();
        await page.waitForTimeout(500);

        // Delete Project A via context menu
        await page.locator('[role="button"]:has-text("Project Alpha")').click({ button: 'right' });
        await page.locator('button:has-text("Delete")').click();

        // Confirm deletion
        const confirmButton = page.locator('button:has-text("Delete"):not([disabled])');
        await confirmButton.last().click();
        await page.waitForTimeout(500);

        // Project A should be gone from sidebar
        await expect(page.locator('[role="button"]:has-text("Project Alpha")')).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  test.describe('ContextBar in overlay', () => {
    // These tests verify the two changes introduced by the branch:
    //
    // 1. CommandBarOverlay renders <ContextBar sessionId={sessionId} agentFallback={projectAgent} />
    //    only AFTER sessionId is set (i.e. after spawnTransient resolves).
    //    Before the session is spawned, no [data-testid="usage-bar"] should appear
    //    inside the overlay.
    //
    // 2. ContextBar receives agentFallback=projectAgent. Transient sessions have no
    //    task row in the board store, so the board-store lookup for session_id yields
    //    undefined. The nullish-coalesce (?? agentFallback) must then fall through to
    //    projectAgent, so the version pill shows the project's agent display name
    //    (e.g. "Claude Code") instead of the generic "Agent" string.

    test('ContextBar is absent while spawnTransient is pending', async () => {
      // Use a preconfig with NO pre-existing transient session so the overlay
      // has no transientSessionId to reattach to. Then intercept spawnTransient
      // with a promise that never resolves, keeping sessionId === null.
      // The ContextBar should not mount at all during this window.
      //
      // We use twoProjectPreConfig() as the base because it has no pre-injected
      // transient sessions in the session list, unlike preConfigWithTransientSession().
      const preConfigWithHangingSpawn = twoProjectPreConfig() + `
        window.electronAPI.sessions.spawnTransient = function () {
          // Never resolves - keeps the overlay in the pre-spawn phase indefinitely.
          return new Promise(function () {});
        };
      `;
      const { browser, page } = await launchWithState(preConfigWithHangingSpawn);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the overlay
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        // ContextBar should NOT be present - sessionId is still null.
        // Intentional fixed wait: we cannot poll for non-occurrence.
        // 800ms is enough for the microtask queue to flush if the spawn had resolved.
        await page.waitForTimeout(800);
        await expect(
          page.getByTestId('command-bar-overlay').locator('[data-testid="usage-bar"]')
        ).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('ContextBar mounts inside overlay once session is spawned', async () => {
      // The transient session ID is generated at runtime by spawnTransient.
      // We override spawnTransient to return a deterministic ID, then use
      // page.evaluate() to push usage data directly into the Zustand store
      // for that ID. This avoids the Proxy-spread problem (a Proxy is not
      // enumerable, so { ...proxy } produces an empty object and the store
      // never sees the usage) and avoids relying on the onUsage IPC event
      // (which the mock returns as noop and never fires).
      const TRANSIENT_ID = 'transient-overlay-test-1';
      const preConfigWithDeterministicSpawn = twoProjectPreConfig() + `
        window.electronAPI.sessions.spawnTransient = async function (input) {
          var session = {
            id: '${TRANSIENT_ID}',
            taskId: '${TRANSIENT_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/project',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          };
          return { session: session, branch: 'main' };
        };
      `;

      const { browser, page } = await launchWithState(preConfigWithDeterministicSpawn);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the overlay - spawnTransient fires immediately with our deterministic ID.
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        // ContextBar mounts (showing the spinner pill) once sessionId is set.
        const overlayContextBar = page.getByTestId('command-bar-overlay').locator('[data-testid="usage-bar"]');
        await expect(overlayContextBar).toBeVisible({ timeout: 5000 });

        // Push usage directly into the session store using the known session ID.
        // This simulates what the onUsage IPC event would do in production.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { updateUsage: (id: string, data: object) => void } } } }).__zustandStores;
          stores?.session?.getState().updateUsage(sessionId, {
            model: { id: 'claude-opus', displayName: 'Claude Opus' },
            contextWindow: {
              usedPercentage: 10,
              usedTokens: 500,
              cacheTokens: 0,
              totalInputTokens: 400,
              totalOutputTokens: 100,
              contextWindowSize: 200000,
            },
            cost: { totalCostUsd: 0.002, totalDurationMs: 1200 },
          });
        }, TRANSIENT_ID);

        // After usage lands the ContextBar should show the model name, not the spinner.
        await expect(overlayContextBar).toContainText('Claude Opus', { timeout: 3000 });
        await expect(overlayContextBar).not.toContainText('Starting agent...');
      } finally {
        await browser.close();
      }
    });

    test('ContextBar version pill shows project agent name via agentFallback', async () => {
      // The key regression this tests: transient sessions have no task row in the
      // board store. Before the agentFallback fix, the version pill showed "Agent"
      // because agentDisplayName(null) was called. After the fix it shows the
      // project's default_agent display name ("Claude Code" for agent="claude").
      //
      // The board store lookup:
      //   tasks.find(t => t.session_id === sessionId)?.agent
      // returns undefined for transient sessions (no task row in the board store).
      // The nullish coalesce (undefined ?? agentFallback) uses agentFallback = "claude".
      // agentDisplayName("claude") = "Claude Code".
      const TRANSIENT_ID = 'transient-overlay-test-2';
      const preConfigForFallback = twoProjectPreConfig() + `
        // Ensure Project Alpha's default_agent is "claude".
        window.__mockPreConfigure(function (state) {
          var project = state.projects.find(function (p) { return p.id === '${PROJECT_A_ID}'; });
          if (project) project.default_agent = 'claude';
        });

        window.electronAPI.sessions.spawnTransient = async function (input) {
          var session = {
            id: '${TRANSIENT_ID}',
            taskId: '${TRANSIENT_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/project',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          };
          return { session: session, branch: 'main' };
        };
      `;

      const { browser, page } = await launchWithState(preConfigForFallback);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        const overlayContextBar = page.getByTestId('command-bar-overlay').locator('[data-testid="usage-bar"]');
        await expect(overlayContextBar).toBeVisible({ timeout: 5000 });

        // Push usage so the version pill renders (it only shows when resolvedModelName is set).
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { updateUsage: (id: string, data: object) => void } } } }).__zustandStores;
          stores?.session?.getState().updateUsage(sessionId, {
            model: { id: 'claude-opus', displayName: 'Claude Opus' },
            contextWindow: {
              usedPercentage: 5,
              usedTokens: 200,
              cacheTokens: 0,
              totalInputTokens: 150,
              totalOutputTokens: 50,
              contextWindowSize: 200000,
            },
            cost: { totalCostUsd: 0.001, totalDurationMs: 500 },
          });
        }, TRANSIENT_ID);

        // The version pill shows agentDisplayName(taskAgent ?? agentFallback).
        // taskAgent: board store has no task with session_id === TRANSIENT_ID -> undefined.
        // agentFallback: projectAgent from useProjectStore = "claude".
        // agentDisplayName("claude") = "Claude Code".
        await expect(overlayContextBar).toContainText('Claude Code', { timeout: 3000 });
        await expect(overlayContextBar).not.toContainText('Starting agent...');
      } finally {
        await browser.close();
      }
    });

    test('version pill shows "Agent" when project has no default_agent set', async () => {
      // Baseline: if projectAgent is null, agentFallback is null, and the board
      // store finds no task row, then agentDisplayName(null) returns "Agent".
      // This confirms the test above is not a false positive - the component
      // actually reads agentFallback and uses it when the project agent is null.
      const TRANSIENT_ID = 'transient-overlay-test-3';
      const preConfigWithNullAgent = twoProjectPreConfig() + `
        window.__mockPreConfigure(function (state) {
          var project = state.projects.find(function (p) { return p.id === '${PROJECT_A_ID}'; });
          if (project) project.default_agent = null;
        });

        window.electronAPI.sessions.spawnTransient = async function (input) {
          var session = {
            id: '${TRANSIENT_ID}',
            taskId: '${TRANSIENT_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/project',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          };
          return { session: session, branch: 'main' };
        };
      `;

      const { browser, page } = await launchWithState(preConfigWithNullAgent);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

        const overlayContextBar = page.getByTestId('command-bar-overlay').locator('[data-testid="usage-bar"]');
        await expect(overlayContextBar).toBeVisible({ timeout: 5000 });

        // Push usage so the version pill renders.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { updateUsage: (id: string, data: object) => void } } } }).__zustandStores;
          stores?.session?.getState().updateUsage(sessionId, {
            model: { id: 'claude-opus', displayName: 'Claude Opus' },
            contextWindow: {
              usedPercentage: 5,
              usedTokens: 200,
              cacheTokens: 0,
              totalInputTokens: 150,
              totalOutputTokens: 50,
              contextWindowSize: 200000,
            },
            cost: { totalCostUsd: 0.001, totalDurationMs: 500 },
          });
        }, TRANSIENT_ID);

        // null agentFallback -> agentDisplayName(null) -> "Agent"
        await expect(overlayContextBar).toContainText('Agent', { timeout: 3000 });
      } finally {
        await browser.close();
      }
    });
  });
});
