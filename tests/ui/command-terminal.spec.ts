/**
 * UI tests for the Command Terminal feature.
 *
 * Tests the TitleBar button visibility, transient session filtering from
 * the terminal panel, and the Ctrl+Shift+P hotkey toggle behavior.
 *
 * Performance note: tests that share the same pre-configured mock state are
 * grouped into a shared browser instance via beforeAll/afterAll. Each test
 * still gets a fresh page state via page.goto() in beforeEach, which re-runs
 * all registered addInitScript callbacks on the context. This avoids the
 * ~1-2 s overhead of chromium.launch() per test while still providing full
 * state isolation between tests.
 *
 * Tests with unique per-test spawnTransient overrides (ContextBar group) and
 * tests with different base pre-configs (TitleBar Button group) keep their
 * own per-test browser launches.
 *
 * Phase 2 change (Multiple terminals): the pulsing `transient-session-indicator`
 * dot was removed. Activity is now surfaced as the COLOR of the title-bar
 * terminal icon (`data-testid="quick-session-icon"`, `data-activity` attribute
 * of `'rest' | 'thinking' | 'idle'`). Tests that previously asserted the dot
 * now assert the icon's data-activity attribute instead:
 *   - "session alive in background" -> data-activity = 'idle' (or NOT 'rest')
 *   - "session killed / no background session" -> data-activity = 'rest'
 * The icon is visible whether the command bar is open OR closed (activity-based,
 * not existence-based).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
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
 * The transient session has activityCache set to 'idle', so the icon should show
 * data-activity="idle" once the store is hydrated.
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

/**
 * Launch a fresh browser+context with the given preconfig registered as an init
 * script. The returned browser and context are shared across multiple tests via
 * beforeAll/afterAll. Each test navigates to VITE_URL in beforeEach so the
 * init scripts re-run and state is fully fresh for every test.
 */
async function launchSharedBrowser(preConfigScript: string): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, context, page };
}

/**
 * Launch a one-off browser for a single test with a unique preconfig.
 * Used when the preconfig is test-specific (e.g. custom spawnTransient overrides)
 * or when sharing is not safe.
 */
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

const MULTI_PROJECT_ID = 'proj-multi-term';

/**
 * One project with a counter-based deterministic spawnTransient: each call
 * returns a unique session id, so spawning a 2nd/3rd terminal gets a distinct
 * session. Shared by the "Multiple terminals" and "Window layout parity" groups.
 */
function multiTerminalPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${MULTI_PROJECT_ID}',
        name: 'Multi Terminal Project',
        path: '/mock/multi-terminal',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-multi-' + i,
          position: i,
          created_at: ts,
        }));
      });
      return { currentProjectId: '${MULTI_PROJECT_ID}' };
    });

    // Counter-based deterministic spawn: each call returns a unique session id
    // so the second window gets a different session than the first.
    var spawnCounter = 0;
    window.electronAPI.sessions.spawnTransient = async function (input) {
      spawnCounter += 1;
      var id = 'multi-transient-' + spawnCounter;
      var session = {
        id: id,
        taskId: id,
        projectId: input.projectId,
        pid: null,
        status: 'running',
        shell: '/bin/bash',
        cwd: '/mock/multi-terminal',
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: false,
        transient: true,
        isolatedSwimlaneId: null,
        agentSessionId: null,
      };
      // Push into mock sessions list so sessions.list() and sessions.killTransient()
      // can find it.
      window.electronAPI.sessions.__mockSessions = window.electronAPI.sessions.__mockSessions || [];
      window.electronAPI.sessions.__mockSessions.push(session);
      return { session: session, branch: 'main' };
    };
  `;
}

test.describe('Command Terminal', () => {
  // ---------------------------------------------------------------------------
  // TitleBar Button - these two tests use different base preconfigs so each
  // gets its own browser launch.
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Shared browser: Terminal Panel Filtering + Hotkey + Background Session
  // Indicator + Overlay Header Controls - all use preConfigWithTransientSession()
  // and do not mutate state in ways that would affect sibling tests after a
  // full page navigation in beforeEach.
  // ---------------------------------------------------------------------------
  test.describe('Transient Session - shared browser group', () => {
    let sharedBrowser: Browser;
    let sharedPage: Page;

    test.beforeAll(async () => {
      ({ browser: sharedBrowser, page: sharedPage } = await launchSharedBrowser(
        preConfigWithTransientSession(),
      ));
    });

    test.afterAll(async () => {
      await sharedBrowser?.close();
    });

    test.beforeEach(async () => {
      await sharedPage.goto(VITE_URL);
      await sharedPage.waitForLoadState('load');
      await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
      await sharedPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test.describe('Terminal Panel Filtering', () => {
      test('transient sessions are excluded from the terminal panel tabs', async () => {
        // The regular task session tab should be visible
        const taskTab = sharedPage.locator('button:has-text("regular-task")');
        await expect(taskTab).toBeVisible();

        // The transient session should NOT appear as a tab
        const transientTab = sharedPage.locator('button:has-text("ephemeral-uuid")');
        await expect(transientTab).not.toBeVisible();
      });
    });

    test.describe('Hotkey', () => {
      test('Ctrl+Shift+P opens the command bar overlay', async () => {
        // Command bar should not be visible initially
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible();

        // Press Ctrl+Shift+P
        await sharedPage.keyboard.press('Control+Shift+P');

        // Command bar should appear
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();
        await expect(sharedPage.getByText('Command Terminal', { exact: true })).toBeVisible();
      });

      test('Ctrl+Shift+P toggles the command bar closed', async () => {
        // Open
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();

        // Close
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });
      });
    });

    test.describe('Background Session Indicator', () => {
      // Phase 2: the pulsing dot (`transient-session-indicator`) was removed.
      // Activity is now shown as the COLOR of the terminal icon (`quick-session-icon`),
      // via a `data-activity` attribute. The icon is ALWAYS visible when a project is
      // open (activity-based, not existence-based). When a transient session with
      // 'idle' activity is in the background, the icon gets data-activity="idle".
      // After all transient sessions are killed (no current-project entries in the map),
      // the icon falls back to data-activity="rest".
      //
      // preConfigWithTransientSession() pre-seeds activityCache[TRANSIENT_SESSION_ID]='idle',
      // so the icon should show idle as soon as the store is hydrated - REGARDLESS of
      // whether the bar is open or closed. This is the key semantic change from Phase 1.

      test('icon shows idle activity while transient session is alive (bar closed)', async () => {
        // The icon should be visible (project is open)
        const icon = sharedPage.getByTestId('quick-session-icon');
        await expect(icon).toBeVisible();

        // The preConfig seeds activityCache with 'idle' for the transient session.
        // The icon should reflect that, whether or not the bar is open.
        // Poll to allow the activity store to hydrate.
        await expect(icon).toHaveAttribute('data-activity', 'idle', { timeout: 5000 });

        // Open overlay and close it - session stays alive
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

        // Icon still reflects the alive background session
        await expect(icon).toHaveAttribute('data-activity', 'idle', { timeout: 3000 });
      });
    });

    test.describe('Overlay Header Controls', () => {
      // The command terminal has NO per-window X/hide button (removed to avoid the
      // "close this window" confusion with the task-detail X). Hiding the layer is
      // covered by the Ctrl+Shift+W and backdrop tests below; Stop destroys a terminal.

      test('stop button terminates the session and closes overlay', async () => {
        // Open overlay
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();

        // Click the stop button
        await sharedPage.getByTestId('command-bar-terminate-button').click();
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

        // Session was killed: icon should revert to 'rest' (no current-project transient sessions remain).
        // Poll because the store cleanup is async after killTransient resolves.
        const icon = sharedPage.getByTestId('quick-session-icon');
        await expect(icon).toHaveAttribute('data-activity', 'rest', { timeout: 5000 });
      });

      test('kebab menu renders with expected items', async () => {
        // Open overlay
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();

        // Click the kebab menu button
        await sharedPage.locator('[title="Actions"]').click();

        // Verify menu items (use nth(1) for "Commands" to avoid matching the header pill)
        await expect(sharedPage.locator('button:has-text("Open folder")')).toBeVisible();
        await expect(sharedPage.getByRole('button', { name: 'Commands' }).nth(1)).toBeVisible();
        await expect(sharedPage.getByTestId('command-bar-kebab-stop')).toBeVisible();
      });

      test('maximize button and Ctrl+Shift+M/W hotkeys toggle and hide the window', async () => {
        await sharedPage.keyboard.press('Control+Shift+P');
        const windowContent = sharedPage.getByTestId('command-terminal-window');
        await expect(windowContent).toBeVisible();

        // The window-manager engine owns geometry now; maximize is a window-store
        // toggle reflected by the button's title (Maximize <-> Restore).
        const maximizeButton = sharedPage.getByTestId('command-bar-maximize');
        await expect(maximizeButton).toBeVisible();
        await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);

        await maximizeButton.click();
        await expect(maximizeButton).toHaveAttribute('title', /^Restore/);

        // Ctrl+Shift+M restores (terminal-safe combo).
        await sharedPage.keyboard.press('Control+Shift+M');
        await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);

        // Ctrl+Shift+W hides the layer; the transient session stays alive.
        await sharedPage.keyboard.press('Control+Shift+W');
        await expect(windowContent).not.toBeVisible({ timeout: 5000 });

        // Session alive in background: icon should NOT be 'rest'.
        // (The preConfig seeds activity='idle', so the icon stays non-rest.)
        const icon = sharedPage.getByTestId('quick-session-icon');
        await expect(icon).not.toHaveAttribute('data-activity', 'rest', { timeout: 3000 });
      });

      test('a clean backdrop click hides the layer without killing the session', async () => {
        // The CommandBackdrop (data-testid="command-window-backdrop") uses a
        // press-then-release guard: onMouseDown records pressedOnSelf=true only when
        // both events target the backdrop directly (not a child). A clean click on
        // the empty region beside the window satisfies this and fires onHide().
        //
        // Mirrors the X-button and Ctrl+Shift+W behavior: the PTY stays alive and
        // the icon stays non-rest after the layer closes.
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();

        // Click the backdrop directly (not on the window frame). The backdrop is a
        // fixed full-screen div below the window frame; a top-left-corner point is
        // safely outside the window content (which is centered or near the center).
        const backdrop = sharedPage.getByTestId('command-window-backdrop');
        await expect(backdrop).toBeVisible();
        await backdrop.click({ position: { x: 5, y: 5 } });

        // Layer must hide (the window content is no longer visible)
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

        // Session stays alive: icon is non-rest.
        const icon = sharedPage.getByTestId('quick-session-icon');
        await expect(icon).not.toHaveAttribute('data-activity', 'rest', { timeout: 3000 });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-Project Transient Session Persistence - shared browser group.
  // All four tests use twoProjectPreConfig() and get fresh state via beforeEach.
  //
  // Phase 2 change: assertions replaced from transient-session-indicator to
  // icon data-activity. "Session alive in background" is now data-activity != 'rest';
  // "no session for this project" is data-activity = 'rest'.
  //
  // Note on timing: Unlike the old dot (which only appeared when the bar was
  // CLOSED), the new icon reflects activity even while the bar is OPEN. When we
  // spawn a transient session via Ctrl+Shift+P the store's transientSessions map
  // is updated, and if the mock's activityCache has a value for that session the
  // icon transitions immediately on store hydration. The mock's spawnTransient
  // pushes the new session into sessions[] but does NOT seed activityCache for it,
  // so freshly spawned sessions will be 'rest' until activity arrives. However,
  // the icon is still non-'rest' if a prior session with activity exists in the
  // map. Tests must therefore close the bar (hide, not stop) to assert "background
  // but alive" vs open the bar and assert something else.
  // ---------------------------------------------------------------------------
  test.describe('Cross-Project Transient Session Persistence', () => {
    let crossProjectBrowser: Browser;
    let crossProjectPage: Page;

    test.beforeAll(async () => {
      ({ browser: crossProjectBrowser, page: crossProjectPage } = await launchSharedBrowser(
        twoProjectPreConfig(),
      ));
    });

    test.afterAll(async () => {
      await crossProjectBrowser?.close();
    });

    test.beforeEach(async () => {
      await crossProjectPage.goto(VITE_URL);
      await crossProjectPage.waitForLoadState('load');
      await crossProjectPage.waitForSelector('text=Kangentic', { timeout: 15000 });
      await crossProjectPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test('transient session survives project switch and reattaches on return', async () => {
      // Open command terminal in Project A and close overlay (session stays in background).
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

      // Icon must show that Project A has a transient session.
      // After spawn the session is 'rest' (no activityCache entry from mock) so we
      // assert the session is present via Zustand store rather than icon color.
      // The transient map should have an entry for PROJECT_A_ID.
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch to Project B - Playwright's retry handles the settle wait
      await crossProjectPage.locator('[role="button"]:has-text("Project Beta")').click();

      // No transient session for Project B; icon should be 'rest'.
      const icon = crossProjectPage.getByTestId('quick-session-icon');
      await expect(icon).toHaveAttribute('data-activity', 'rest', { timeout: 5000 });

      // Switch back to Project A - the session is still in the map (stashed, not killed).
      await crossProjectPage.locator('[role="button"]:has-text("Project Alpha")').click();

      // Project A has a live transient entry; verify via store.
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Opening the command bar should reattach to the existing session (no new spawn)
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
    });

    test('command bar overlay closes automatically on project switch', async () => {
      // Open command terminal in Project A
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();

      // Trigger project switch programmatically (overlay backdrop blocks sidebar clicks)
      await crossProjectPage.evaluate(async () => {
        const store = (window as unknown as { __zustandStores?: { project?: { getState: () => { openProject: (id: string) => Promise<void> } } } }).__zustandStores?.project;
        if (store) {
          await store.getState().openProject('proj-cmd-b');
        }
      });

      // Overlay should close automatically via useCommandBar's currentProjectId effect
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });
    });

    test('each project gets its own independent transient session', async () => {
      // Open and close command terminal in Project A
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

      // Project A has a transient session in the store
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch to Project B - Playwright's retry handles the settle wait
      await crossProjectPage.locator('[role="button"]:has-text("Project Beta")').click();

      // No transient session for Project B yet; icon should be 'rest'.
      const icon = crossProjectPage.getByTestId('quick-session-icon');
      await expect(icon).toHaveAttribute('data-activity', 'rest', { timeout: 5000 });

      // Open and close command terminal in Project B (spawns a new session)
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

      // Project B now has a transient session
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_B_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch back to Project A - its session should still be in the map
      await crossProjectPage.locator('[role="button"]:has-text("Project Alpha")').click();
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch to Project B - its session should also still be in the map
      await crossProjectPage.locator('[role="button"]:has-text("Project Beta")').click();
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_B_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);
    });

    test('deleting a project kills its transient session', async () => {
      // Open and close command terminal in Project A (creates a background transient)
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

      // Project A has a transient session
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch to Project B - Playwright's retry handles the settle wait
      await crossProjectPage.locator('[role="button"]:has-text("Project Beta")').click();

      // Project B has no transient session; icon should be 'rest'
      const icon = crossProjectPage.getByTestId('quick-session-icon');
      await expect(icon).toHaveAttribute('data-activity', 'rest', { timeout: 5000 });

      // Delete Project A via context menu
      await crossProjectPage.locator('[role="button"]:has-text("Project Alpha")').click({ button: 'right' });
      await crossProjectPage.locator('button:has-text("Delete")').click();

      // Confirm deletion
      const confirmButton = crossProjectPage.locator('button:has-text("Delete"):not([disabled])');
      await confirmButton.last().click();

      // Project A should be gone from sidebar
      await expect(crossProjectPage.locator('[role="button"]:has-text("Project Alpha")')).not.toBeVisible();
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple terminals (Phase 2) - exercises the headline new behavior:
  // multiple Command Terminal windows per project, spawned via the + badge.
  //
  // Uses a per-test browser with a deterministic spawnTransient override
  // that returns a unique session id per call (counter incremented in closure),
  // since spawning a 2nd terminal calls spawnTransient again.
  // ---------------------------------------------------------------------------
  test.describe('Multiple terminals', () => {
    test('the centered + add affordance shows while the layer is open and below the cap', async () => {
      // The `+` lives IN the title-bar terminal glyph (data-plus on
      // quick-session-icon), not a corner badge. It appears only when the layer is
      // OPEN and another terminal can be spawned (below the cap).
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // The `+` is off before the layer is open (clicking would just open it).
        await expect(page.getByTestId('quick-session-icon')).toHaveAttribute('data-plus', 'false');

        // Open the layer
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        // Open and below the cap: the glyph shows the centered `+`.
        await expect(page.getByTestId('quick-session-icon')).toHaveAttribute('data-plus', 'true', { timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('clicking the title-bar button while open spawns a second terminal', async () => {
      // With the layer OPEN, clicking quick-session-button calls spawnAdditionalCommandTerminal
      // which opens a new window in the next free slot and tiles them columns.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the layer (creates first window)
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        // Wait for one window to be present
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);

        // Click the title-bar button to spawn a second terminal
        await page.getByTestId('quick-session-button').click();

        // Second window should appear; total count goes 1 -> 2
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        // Both windows are visible (tiled)
        const windows = page.getByTestId('command-terminal-window');
        await expect(windows.nth(0)).toBeVisible();
        await expect(windows.nth(1)).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('stopping one of two terminals leaves the other visible and the layer open', async () => {
      // Per-window Stop closes THAT window only. With two windows, stopping one
      // leaves count=1 and the layer stays open.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open and spawn two terminals
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await page.getByTestId('quick-session-button').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        // Click Stop on the FIRST window
        const firstWindow = page.getByTestId('command-terminal-window').first();
        await firstWindow.getByTestId('command-bar-terminate-button').click();

        // Count goes 2 -> 1; the layer stays open
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect(page.getByTestId('command-terminal-window').first()).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('stopping the last terminal hides the whole layer', async () => {
      // When the LAST command terminal window is stopped, the layer bridge fires
      // onHide and the overlay disappears entirely.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the layer (one window)
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });

        // Stop the only terminal
        await page.getByTestId('command-bar-terminate-button').click();

        // Whole layer hides
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
        // The backdrop should also be gone
        await expect(page.getByTestId('command-window-backdrop')).not.toBeVisible({ timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('the centered + add affordance disappears at the cap (MAX_COMMAND_TERMINALS = 4)', async () => {
      // When 4 windows are open (the cap), canSpawnMore=false and the glyph drops
      // the centered `+` (data-plus="false").
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the first window
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect(page.getByTestId('quick-session-icon')).toHaveAttribute('data-plus', 'true', { timeout: 3000 });

        // Spawn up to 4 windows total (3 more clicks)
        for (let iteration = 0; iteration < 3; iteration += 1) {
          await page.getByTestId('quick-session-button').click();
          await expect(page.getByTestId('command-terminal-window')).toHaveCount(iteration + 2, { timeout: 5000 });
        }

        // At cap (4 windows) - the centered `+` is gone.
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(4);
        await expect(page.getByTestId('quick-session-icon')).toHaveAttribute('data-plus', 'false', { timeout: 3000 });
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Window layout parity - the command terminal window has the same tile-layout
  // menu and pop-out (untile back to floating) as the task-detail window.
  // ---------------------------------------------------------------------------
  test.describe('Window layout parity', () => {
    test('the tile-layout menu lists snap and tiling presets', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        const layoutButton = page.getByTestId('window-tile-layout').first();
        await expect(layoutButton).toBeVisible();
        await layoutButton.click();

        // The menu surfaces the snap halves and the multi-window tilings.
        await expect(page.getByTestId('tile-preset-left-half')).toBeVisible({ timeout: 3000 });
        await expect(page.getByTestId('tile-preset-columns')).toBeVisible();
        await expect(page.getByTestId('tile-preset-grid')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('pop-out appears once a terminal is tiled and floats it back', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });

        // A single floating terminal is not tiled, so it has no pop-out control.
        await expect(page.getByTestId('command-bar-popout')).toHaveCount(0);

        // Spawning a second docks both into the first's footprint (tiled).
        await page.getByTestId('quick-session-button').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        // Tiled terminals expose the pop-out (untile) control.
        await expect(page.getByTestId('command-bar-popout').first()).toBeVisible({ timeout: 3000 });

        // Pop one out: both terminals remain, the popped one is just floating now.
        await page.getByTestId('command-bar-popout').first().click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2);
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // ContextBar in overlay - each test has a unique spawnTransient override
  // injected AFTER the init scripts run. These cannot share a browser context
  // (addInitScript is fixed at context creation; per-test overrides are added
  // inline in launchWithState). Each test uses its own browser instance.
  // ---------------------------------------------------------------------------
  test.describe('ContextBar in overlay', () => {
    // These tests verify the two changes introduced by the branch:
    //
    // 1. CommandTerminalWindow renders <ContextBar sessionId={sessionId} agentFallback={projectAgent} />
    //    only AFTER sessionId is set (i.e. after spawnTransient resolves).
    //    Before the session is spawned, no [data-testid="usage-bar"] should appear
    //    inside the window.
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
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        // ContextBar should NOT be present - sessionId is still null.
        // Intentional fixed wait: we cannot poll for non-occurrence.
        // 800ms is enough for the microtask queue to flush if the spawn had resolved.
        await page.waitForTimeout(800);
        await expect(
          page.getByTestId('command-terminal-window').locator('[data-testid="usage-bar"]')
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
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        // ContextBar mounts (showing the spinner pill) once sessionId is set.
        const overlayContextBar = page.getByTestId('command-terminal-window').locator('[data-testid="usage-bar"]');
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
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        const overlayContextBar = page.getByTestId('command-terminal-window').locator('[data-testid="usage-bar"]');
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
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        const overlayContextBar = page.getByTestId('command-terminal-window').locator('[data-testid="usage-bar"]');
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

    test('transient ContextBar picker injects model/effort via session-keyed IPC (no task override)', async () => {
      // Command Terminal sessions are transient (no task row). The ContextBar
      // renders the picker in session-inject mode: selecting a value calls
      // sessions.injectSettings (session-keyed, no DB persistence) rather than
      // the task-keyed tasks.setRuntimeOverride. This is the fix for the
      // reported "can't change model/effort from the Command Terminal".
      const TRANSIENT_ID = 'transient-overlay-picker-1';
      const preConfig = twoProjectPreConfig() + `
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

      const { browser, page } = await launchWithState(preConfig);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        const overlay = page.getByTestId('command-terminal-window');
        await expect(overlay.locator('[data-testid="usage-bar"]')).toBeVisible({ timeout: 5000 });

        // Push usage with a model + effort so both pills resolve to interactive triggers.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { updateUsage: (id: string, data: object) => void } } } }).__zustandStores;
          stores?.session?.getState().updateUsage(sessionId, {
            model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8 (1M context)', effort: 'xhigh' },
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

        // Both triggers render as interactive buttons inside the overlay.
        const modelTrigger = overlay.locator('[data-testid="context-bar-model-trigger"]');
        const effortTrigger = overlay.locator('[data-testid="context-bar-effort-trigger"]');
        await expect(modelTrigger).toBeVisible({ timeout: 5000 });
        await expect(effortTrigger).toBeVisible({ timeout: 5000 });

        // Pick a model -> session-keyed inject, not the task override path. The
        // popover body-portals (strategy: 'fixed') to escape the footer's compositing
        // layer, so the option lives at the page root, not inside the overlay element.
        await modelTrigger.click();
        await page.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();

        const injectCalls = await page.evaluate(() =>
          (window as unknown as { electronAPI: { sessions: { __injectSettingsCalls?: Array<Record<string, unknown>> } } }).electronAPI.sessions.__injectSettingsCalls,
        );
        expect(injectCalls?.length).toBe(1);
        expect(injectCalls?.[0]).toMatchObject({ sessionId: TRANSIENT_ID, agent: 'claude', model: 'sonnet' });

        // The task-keyed override path must NOT have been used for a transient session.
        const overrideCalls = await page.evaluate(() =>
          (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls,
        );
        expect(overrideCalls ?? []).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Maximize focus restore - tests the effect that restores keyboard focus to
  // the xterm terminal after a maximize/restore toggle (PR #33 bug fix).
  // Uses a per-test browser with a deterministic spawn so xterm actually mounts.
  // ---------------------------------------------------------------------------
  test.describe('Maximize focus restore', () => {
    // These tests require the terminal to be fully mounted (xterm.open() called).
    // We use the same deterministic-spawn + markFirstOutput pattern as
    // write-batcher-integration.spec.ts and terminal-ctrl-c-interrupt.spec.ts.

    const FOCUS_PROJECT_ID = 'proj-maximize-focus-test';
    const FOCUS_TRANSIENT_SESSION_ID = 'sess-maximize-focus-1';

    function basePreConfigForFocusTest(): string {
      return `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${FOCUS_PROJECT_ID}',
            name: 'Maximize Focus Test Project',
            path: '/mock/maximize-focus-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push(Object.assign({}, s, {
              id: 'lane-mf-' + i,
              position: i,
              created_at: ts,
            }));
          });
          return { currentProjectId: '${FOCUS_PROJECT_ID}' };
        });
      `;
    }

    const deterministicSpawnForFocusTest = `
      window.electronAPI.sessions.spawnTransient = async function (input) {
        return {
          session: {
            id: '${FOCUS_TRANSIENT_SESSION_ID}',
            taskId: '${FOCUS_TRANSIENT_SESSION_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/maximize-focus-test',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          },
          branch: 'main',
        };
      };
    `;

    /**
     * Open the command bar overlay and wait for xterm to mount.
     * Mirrors the openCommandBarWithTerminal helper used by
     * write-batcher-integration.spec.ts and terminal-ctrl-c-interrupt.spec.ts.
     */
    async function openCommandBarWithMountedTerminal(page: Page): Promise<void> {
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toBeVisible();

      // Inject sessionFirstOutput so terminalReady flips to true immediately,
      // lifting the shimmer overlay and allowing xterm.open() to run.
      await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            session?: { getState: () => { markFirstOutput: (id: string) => void } };
          };
        }).__zustandStores;
        stores?.session?.getState().markFirstOutput(sessionId);
      }, FOCUS_TRANSIENT_SESSION_ID);

      // Wait for xterm to open: .xterm-helper-textarea is the focusable element
      // xterm attaches immediately after terminal.open() completes.
      await expect(
        page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first()
      ).toBeAttached({ timeout: 8000 });
    }

    test('maximize then Ctrl+Shift+M restores focus to the xterm textarea', async () => {
      // This test pins the behavior fixed in PR #33: toggling maximize left DOM
      // focus on the maximize button, so the next keystroke hit the button instead
      // of the terminal. The fix is the useEffect in CommandTerminalWindow that
      // calls focus() whenever isMaximized changes (after initialization).
      //
      // Steps:
      //   1. Open the overlay and mount xterm.
      //   2. Click the maximize button (button takes DOM focus, leaving xterm unfocused).
      //   3. Use Ctrl+Shift+M (panel.maximize keybinding) to restore.
      //   4. Assert that .xterm-helper-textarea is focused.
      //
      // toBeFocused() has built-in retry via Playwright's actionability assertions,
      // which absorbs the requestAnimationFrame and useEffect timing.
      const { browser, page } = await launchWithState(
        basePreConfigForFocusTest() + deterministicSpawnForFocusTest
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await openCommandBarWithMountedTerminal(page);

        const maximizeButton = page.getByTestId('command-bar-maximize');
        await expect(maximizeButton).toBeVisible();
        await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);

        // Click maximize - button takes DOM focus (this is the pre-fix broken state:
        // without the effect the textarea would remain unfocused after this).
        await maximizeButton.click();
        await expect(maximizeButton).toHaveAttribute('title', /^Restore/);

        // Use Ctrl+Shift+M (panel.maximize keybinding) to restore. This exercises
        // the keybinding path (not just another button click) so the next toggle
        // does not land focus on the button at all.
        await page.keyboard.press('Control+Shift+M');
        await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);

        // The fix: the useEffect([isMaximized, focus]) must have called focus(),
        // returning DOM focus to the xterm textarea.
        // toBeFocused() retries internally, absorbing the effect tick.
        const xtermTextarea = page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first();
        await expect(xtermTextarea).toBeFocused({ timeout: 3000 });
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Stop activity ring - the Stop button in CommandTerminalWindow carries the
  // same ring affordance as the task-detail pause button, but with a stop square
  // instead of pause bars. Three ring states:
  //   thinking (isActive)          -> spinning emerald Circle + emerald stop-square
  //   idle/permission (requiresUI) -> static amber Circle + amber stop-square
  //   no session / not running     -> plain CircleStop, no stop-square
  //
  // Each test uses a deterministic spawnTransient override (known session id) so
  // page.evaluate can call updateActivity + markFirstOutput on that exact id
  // without racing against a randomly-generated uuid from the default mock.
  // ---------------------------------------------------------------------------
  test.describe('Stop activity ring', () => {
    const RING_PROJECT_ID = 'proj-ring-test';
    const RING_SESSION_ID = 'sess-ring-test-1';

    /** Base preconfig: one project, no pre-existing sessions (the overlay will spawn one). */
    function ringBasePreConfig(): string {
      return `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${RING_PROJECT_ID}',
            name: 'Ring Test Project',
            path: '/mock/ring-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push(Object.assign({}, s, {
              id: 'lane-ring-' + i,
              position: i,
              created_at: ts,
            }));
          });
          return { currentProjectId: '${RING_PROJECT_ID}' };
        });
      `;
    }

    /** Override spawnTransient to return a deterministic session id so we can
     *  push activity state into the store for that exact id. */
    const deterministicSpawn = `
      window.electronAPI.sessions.spawnTransient = async function (input) {
        return {
          session: {
            id: '${RING_SESSION_ID}',
            taskId: '${RING_SESSION_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/ring-test',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          },
          branch: 'main',
        };
      };
    `;

    /**
     * Open the command bar and flip terminalReady by calling markFirstOutput so
     * sessionRunning=true. Without this, isThinking and isIdle are always false
     * (the ring only shows for a live session), and the ring tests would pass
     * trivially against the wrong state.
     */
    async function openOverlayAndMarkSessionReady(page: Page): Promise<void> {
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toBeVisible();

      // markFirstOutput flips sessionFirstOutput[id] -> true, which sets
      // hasSessionStarted=true -> terminalReady=true via a useEffect.
      // This mirrors the pattern used by write-batcher-integration.spec.ts and
      // terminal-ctrl-c-interrupt.spec.ts for xterm tests.
      await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            session?: { getState: () => { markFirstOutput: (id: string) => void } };
          };
        }).__zustandStores;
        stores?.session?.getState().markFirstOutput(sessionId);
      }, RING_SESSION_ID);

      // Poll until terminalReady is reflected: the stop button must lose its
      // lucide-circle-stop class (the default rest-state icon) once the session
      // starts, confirming the sessionRunning gate is now true.
      // We assert the activity-specific state in each individual test instead.
    }

    test('thinking activity shows spinning emerald ring and emerald stop-square', async () => {
      // Derives expected behavior from the contract in CommandTerminalWindow.tsx:
      //   isThinking = sessionRunning && isActive(activity)
      //   -> spinning Circle with text-emerald-400 animate-spin, plus StopSquare bg-emerald-400
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await openOverlayAndMarkSessionReady(page);

        // Push 'thinking' activity into the store for the known session id.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores?: {
              session?: { getState: () => { updateActivity: (id: string, state: string) => void } };
            };
          }).__zustandStores;
          stores?.session?.getState().updateActivity(sessionId, 'thinking');
        }, RING_SESSION_ID);

        const stopButton = page.getByTestId('command-bar-terminate-button');

        // stop-square must be present (the StopSquare inner span inside the ring)
        await expect(stopButton.getByTestId('stop-square')).toBeVisible({ timeout: 3000 });

        // The stop-square inner span carries bg-emerald-400 for thinking
        const squareInner = stopButton.getByTestId('stop-square').locator('span');
        await expect(squareInner).toHaveClass(/bg-emerald-400/);

        // The animated emerald ring (Circle svg) must also be present
        // lucide-circle is the CSS class Lucide attaches to the Circle component
        await expect(stopButton.locator('.lucide-circle')).toBeVisible();
        const ringCircle = stopButton.locator('.lucide-circle');
        await expect(ringCircle).toHaveClass(/text-emerald-400/);
        await expect(ringCircle).toHaveClass(/animate-spin/);

        // The plain rest-state icon (CircleStop) must NOT be present when thinking
        await expect(stopButton.locator('.lucide-circle-stop')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('idle activity shows static amber ring and amber stop-square', async () => {
      // Derives expected behavior from the contract in CommandTerminalWindow.tsx:
      //   isIdle = sessionRunning && requiresUserInteraction(activity)
      //   requiresUserInteraction('idle') = true (ACTIVITY_DISPOSITION idle -> 'idle')
      //   -> static Circle with text-amber-400 (no animate-spin), plus StopSquare bg-amber-400
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await openOverlayAndMarkSessionReady(page);

        // Push 'idle' activity (requiresUserInteraction = true, isActive = false)
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores?: {
              session?: { getState: () => { updateActivity: (id: string, state: string) => void } };
            };
          }).__zustandStores;
          stores?.session?.getState().updateActivity(sessionId, 'idle');
        }, RING_SESSION_ID);

        const stopButton = page.getByTestId('command-bar-terminate-button');

        // stop-square must be present for idle state
        await expect(stopButton.getByTestId('stop-square')).toBeVisible({ timeout: 3000 });

        // The stop-square inner span carries bg-amber-400 for idle
        const squareInner = stopButton.getByTestId('stop-square').locator('span');
        await expect(squareInner).toHaveClass(/bg-amber-400/);

        // The static amber ring (Circle svg) must be present and NOT spinning
        await expect(stopButton.locator('.lucide-circle')).toBeVisible();
        const ringCircle = stopButton.locator('.lucide-circle');
        await expect(ringCircle).toHaveClass(/text-amber-400/);
        // Idle ring is static: no animate-spin class
        const ringClass = await ringCircle.getAttribute('class');
        expect(ringClass).not.toContain('animate-spin');

        // The plain rest-state icon (CircleStop) must NOT be present when idle
        await expect(stopButton.locator('.lucide-circle-stop')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('permission activity shows static amber ring (same as idle)', async () => {
      // requiresUserInteraction('permission') = true (ACTIVITY_DISPOSITION maps
      // 'permission' -> 'idle'). The ring is identical to the idle ring.
      // This pins the activity-state-classification contract in the UI layer:
      // 'permission' must be treated as "needs user" (amber) not "working" (emerald).
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await openOverlayAndMarkSessionReady(page);

        // Push 'permission' activity
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores?: {
              session?: { getState: () => { updateActivity: (id: string, state: string) => void } };
            };
          }).__zustandStores;
          stores?.session?.getState().updateActivity(sessionId, 'permission');
        }, RING_SESSION_ID);

        const stopButton = page.getByTestId('command-bar-terminate-button');

        // stop-square must be present for permission state
        await expect(stopButton.getByTestId('stop-square')).toBeVisible({ timeout: 3000 });

        // The stop-square inner span carries bg-amber-400 for permission (same as idle)
        const squareInner = stopButton.getByTestId('stop-square').locator('span');
        await expect(squareInner).toHaveClass(/bg-amber-400/);

        // Static amber ring (no spin) - permission maps to idle disposition
        await expect(stopButton.locator('.lucide-circle')).toBeVisible();
        const ringClass = await stopButton.locator('.lucide-circle').getAttribute('class');
        expect(ringClass).toContain('text-amber-400');
        expect(ringClass).not.toContain('animate-spin');

        // No plain CircleStop for permission state
        await expect(stopButton.locator('.lucide-circle-stop')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('no active session shows plain CircleStop (no stop-square, no ring)', async () => {
      // When the session has not yet started (terminalReady=false, so sessionRunning=false),
      // or activity is undefined, StopButtonIcon renders the rest-state <CircleStop>.
      // This test opens the overlay WITHOUT calling markFirstOutput, so terminalReady
      // stays false and the ring must not render.
      //
      // Intent: confirm the ring only appears for a live session. If the rest-state
      // icon were absent, every close-up would look like the ring was working even
      // when there is nothing to show.
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        // Do NOT call markFirstOutput -> terminalReady stays false -> sessionRunning=false
        // -> isThinking=false, isIdle=false -> StopButtonIcon returns <CircleStop>

        const stopButton = page.getByTestId('command-bar-terminate-button');

        // Plain rest-state icon must be present
        await expect(stopButton.locator('.lucide-circle-stop')).toBeVisible({ timeout: 3000 });

        // No ring (no stop-square, no spinning/static Circle ring)
        // Intentional fixed wait: we cannot poll for non-occurrence.
        // 800ms is enough for any pending microtask queue to flush.
        await page.waitForTimeout(800);
        await expect(stopButton.getByTestId('stop-square')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // setFocused IPC contract - shared browser group.
  // All three tests use preConfigWithOpenCommandBar() and get fresh state via
  // beforeEach page navigation.
  // ---------------------------------------------------------------------------
  test.describe('setFocused IPC contract', () => {
    /**
     * Pre-configure with one running task session and one pre-existing transient
     * session (command bar already open). This avoids the async spawnTransient
     * path and lets us directly observe setFocused calls for the steady state.
     */
    function preConfigWithOpenCommandBar(): string {
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
              id: 'lane-focused-' + i,
              position: i,
              created_at: ts,
            }));
          });

          // Regular task session
          state.sessions.push({
            id: '${TASK_SESSION_ID}',
            taskId: '${TASK_ID}',
            projectId: '${PROJECT_ID}',
            pid: 3001,
            status: 'running',
            shell: 'bash',
            cwd: '/mock/test-project',
            startedAt: ts,
            exitCode: null,
            resuming: false,
          });

          // Pre-existing transient session (command bar was already open)
          state.sessions.push({
            id: '${TRANSIENT_SESSION_ID}',
            taskId: '${TRANSIENT_SESSION_ID}',
            projectId: '${PROJECT_ID}',
            pid: 3002,
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
            swimlane_id: 'lane-focused-0',
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

    let focusedBrowser: Browser;
    let focusedPage: Page;

    test.beforeAll(async () => {
      ({ browser: focusedBrowser, page: focusedPage } = await launchSharedBrowser(
        preConfigWithOpenCommandBar(),
      ));
    });

    test.afterAll(async () => {
      await focusedBrowser?.close();
    });

    test.beforeEach(async () => {
      await focusedPage.goto(VITE_URL);
      await focusedPage.waitForLoadState('load');
      await focusedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
      await focusedPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test('transient session enters focused set when command bar opens from Backlog view', async () => {
      // This is the regression test for the bug fixed in this branch.
      // Before the fix: TerminalPanel was unmounted on Backlog, so the
      // setFocused effect never ran for the transient session, and PTY output
      // was silently dropped - the overlay appeared frozen.
      //
      // After the fix: useFocusedSessionsSync lives in AppLayout (always
      // mounted), so it fires setFocused even when the Backlog view is active.
      //
      // Phase 2: setFocused now receives ALL current-project transient session IDs
      // (transientSessionIds: string[]) instead of a single transientSessionId.
      // The assertion uses `callArgs.includes(TRANSIENT_SESSION_ID)` which works
      // for both Phase 1 (single id in array) and Phase 2 (multiple ids).

      // Clear any calls that fired during initial mount so we start fresh.
      await focusedPage.evaluate(() => {
        window.electronAPI.sessions.__setFocusedCalls.length = 0;
      });

      // Switch to Backlog view.
      await focusedPage.locator('[data-testid="view-toggle-backlog"]').click();
      await focusedPage.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 5000 });

      // Open the command bar overlay (Ctrl+Shift+P).
      await focusedPage.keyboard.press('Control+Shift+P');
      await expect(focusedPage.getByTestId('command-terminal-window')).toBeVisible();

      // Poll until setFocused is called with the transient session ID included.
      // useFocusedSessionsSync fires as a useEffect after each render, so there
      // may be a short async gap between state update and the IPC call.
      await expect.poll(
        async () => {
          const allCalls = await focusedPage.evaluate(
            (): string[][] => window.electronAPI.sessions.__setFocusedCalls,
          );
          return allCalls.some(
            (callArgs) => callArgs.includes(TRANSIENT_SESSION_ID),
          );
        },
        { timeout: 5000, intervals: [100, 100, 200, 200, 500] },
      ).toBe(true);
    });

    test('panel session leaves focused set when switching to Backlog with no dialog', async () => {
      // Reverse regression: switching from Board to Backlog must remove the panel
      // session from the focused set (no terminal is visible on Backlog without
      // the command bar open). The session manager should stop forwarding PTY
      // data for that session to avoid wasting IPC budget.

      // On Board view the panel session should be in the focused set.
      await expect.poll(
        async () => {
          const allCalls = await focusedPage.evaluate(
            (): string[][] => window.electronAPI.sessions.__setFocusedCalls,
          );
          return allCalls.some(
            (callArgs) => callArgs.includes(TASK_SESSION_ID),
          );
        },
        { timeout: 5000, intervals: [100, 100, 200, 200, 500] },
      ).toBe(true);

      // Clear the call log.
      await focusedPage.evaluate(() => {
        window.electronAPI.sessions.__setFocusedCalls.length = 0;
      });

      // Switch to Backlog. No command bar, no dialog.
      await focusedPage.locator('[data-testid="view-toggle-backlog"]').click();
      await focusedPage.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 5000 });

      // setFocused should be called without the panel session ID.
      // Poll until at least one call arrives, then assert the task session
      // was not included in the latest call.
      await expect.poll(
        async () => {
          const allCalls = await focusedPage.evaluate(
            (): string[][] => window.electronAPI.sessions.__setFocusedCalls,
          );
          return allCalls.length > 0;
        },
        { timeout: 5000, intervals: [100, 100, 200, 200, 500] },
      ).toBe(true);

      const lastCall = await focusedPage.evaluate((): string[] => {
        const allCalls = window.electronAPI.sessions.__setFocusedCalls;
        return allCalls[allCalls.length - 1] ?? [];
      });
      expect(lastCall).not.toContain(TASK_SESSION_ID);
    });

    test('panel session re-enters focused set when switching back to Board view', async () => {
      // Board -> Backlog -> Board round-trip: the panel session must be restored
      // to the focused set when the user returns to the Board view.

      // Switch to Backlog.
      await focusedPage.locator('[data-testid="view-toggle-backlog"]').click();
      await focusedPage.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 5000 });

      // Clear the log at the midpoint.
      await focusedPage.evaluate(() => {
        window.electronAPI.sessions.__setFocusedCalls.length = 0;
      });

      // Switch back to Board.
      await focusedPage.locator('[data-testid="view-toggle-board"]').click();
      await focusedPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 5000 });

      // Panel session must be back in the focused set.
      await expect.poll(
        async () => {
          const allCalls = await focusedPage.evaluate(
            (): string[][] => window.electronAPI.sessions.__setFocusedCalls,
          );
          return allCalls.some(
            (callArgs) => callArgs.includes(TASK_SESSION_ID),
          );
        },
        { timeout: 5000, intervals: [100, 100, 200, 200, 500] },
      ).toBe(true);
    });
  });
});
