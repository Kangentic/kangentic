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
});
