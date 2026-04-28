/**
 * UI tests for the "remember last active task tab per project" feature.
 *
 * When the user clicks a session tab, the choice is persisted to
 * AppConfig.lastActiveTaskByProject. On project switch, the remembered
 * tab is restored as the active session. When the remembered task has
 * no running session the auto-select fallback takes over.
 *
 * These tests use the same twoProjectPreConfig + launchWithState scaffold
 * from project-session-scope.spec.ts. The restore logic runs in App.tsx
 * after syncSessions() resolves, driven by the headless mock.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Fixed IDs so we can reference them from pre-config and assertion alike.
const PROJECT_A_ID = 'proj-remember-a';
const PROJECT_B_ID = 'proj-remember-b';
const SESSION_A1_ID = 'sess-remember-a1';
const SESSION_A2_ID = 'sess-remember-a2';
const SESSION_B_ID = 'sess-remember-b';
const TASK_A1_ID = 'task-remember-a1';
const TASK_A2_ID = 'task-remember-a2';
const TASK_B_ID = 'task-remember-b';

/**
 * Build the pre-configure script for the two-project fixture.
 *
 * Project A has TWO running sessions: "Alpha Task One" and "Alpha Task Two".
 * Project B has ONE running session: "Beta Task".
 * Both projects start without any remembered tab (lastActiveTaskByProject = {})
 * unless `rememberedTaskForProjectA` is provided.
 *
 * Returns a script string injected via addInitScript() (which runs after
 * mock-electron-api.js so we can wrap config.get to inject extra fields).
 */
function buildPreConfig(options: { rememberedTaskForProjectA?: string } = {}): string {
  const remembered = options.rememberedTaskForProjectA ?? null;

  // Wrap config.get so it always injects lastActiveTaskByProject into the
  // returned config object. The mock closure does not expose `config` directly
  // so we intercept at the API boundary instead.
  const configOverrides = remembered
    ? `
    (function () {
      var originalGet = window.electronAPI.config.get;
      window.electronAPI.config.get = async function () {
        var result = await originalGet();
        if (!result.lastActiveTaskByProject) {
          result.lastActiveTaskByProject = {};
        }
        result.lastActiveTaskByProject['${PROJECT_A_ID}'] = '${remembered}';
        return result;
      };
      var originalGetGlobal = window.electronAPI.config.getGlobal;
      window.electronAPI.config.getGlobal = async function () {
        var result = await originalGetGlobal();
        if (!result.lastActiveTaskByProject) {
          result.lastActiveTaskByProject = {};
        }
        result.lastActiveTaskByProject['${PROJECT_A_ID}'] = '${remembered}';
        return result;
      };
    })();
    `
    : '';

  return `
    ${configOverrides}
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      // -- Project A --
      state.projects.push({
        id: '${PROJECT_A_ID}',
        name: 'Project Alpha',
        path: '/mock/project-alpha',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // -- Project B --
      state.projects.push({
        id: '${PROJECT_B_ID}',
        name: 'Project Beta',
        path: '/mock/project-beta',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // Swimlanes (shared for simplicity -- sufficient for tab-restore testing)
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, {
          id: 'lane-remember-' + index,
          position: index,
          created_at: ts,
        }));
      });

      // -- Task A1 with Session A1 --
      state.tasks.push({
        id: '${TASK_A1_ID}',
        title: 'Alpha Task One',
        description: '',
        swimlane_id: 'lane-remember-0',
        position: 0,
        agent: null,
        session_id: '${SESSION_A1_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.sessions.push({
        id: '${SESSION_A1_ID}',
        taskId: '${TASK_A1_ID}',
        projectId: '${PROJECT_A_ID}',
        pid: 2001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/project-alpha',
        startedAt: ts,
        exitCode: null,
      });

      // -- Task A2 with Session A2 --
      state.tasks.push({
        id: '${TASK_A2_ID}',
        title: 'Alpha Task Two',
        description: '',
        swimlane_id: 'lane-remember-0',
        position: 1,
        agent: null,
        session_id: '${SESSION_A2_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.sessions.push({
        id: '${SESSION_A2_ID}',
        taskId: '${TASK_A2_ID}',
        projectId: '${PROJECT_A_ID}',
        pid: 2002,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/project-alpha',
        startedAt: ts,
        exitCode: null,
      });

      // -- Task B with Session B --
      state.tasks.push({
        id: '${TASK_B_ID}',
        title: 'Beta Task',
        description: '',
        swimlane_id: 'lane-remember-0',
        position: 0,
        agent: null,
        session_id: '${SESSION_B_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.sessions.push({
        id: '${SESSION_B_ID}',
        taskId: '${TASK_B_ID}',
        projectId: '${PROJECT_B_ID}',
        pid: 2003,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/project-beta',
        startedAt: ts,
        exitCode: null,
      });

      return { currentProjectId: '${PROJECT_A_ID}' };
    });
  `;
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
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

/** Wait for the board swimlanes to be visible (project fully loaded). */
async function waitForBoard(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
}

/** Switch to a project via the sidebar and wait for the board to reload. */
async function switchToProject(page: Page, projectName: string): Promise<void> {
  await page.locator(`[role="button"]:has-text("${projectName}")`).click();
  await waitForBoard(page);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Remember Active Task Tab', () => {
  test('clicking a tab persists the choice via config.set', async () => {
    // Use the fixture without any pre-remembered tab, then click one.
    const { browser, page } = await launchWithState(buildPreConfig());
    try {
      await waitForBoard(page);

      // Both Project A sessions should be visible in the terminal panel.
      const tabA1 = page.locator('button:has-text("alpha-task-one")');
      const tabA2 = page.locator('button:has-text("alpha-task-two")');
      await expect(tabA1).toBeVisible();
      await expect(tabA2).toBeVisible();

      // Click the second tab.
      await tabA2.click();

      // config.set must have been called with the updated map.
      // The mock's config.set is async; poll until the stored value arrives.
      await expect.poll(async () => {
        return page.evaluate(() => {
          // Access config directly from the mock closure via the API
          return window.electronAPI.config.get();
        });
      }, { timeout: 3000 }).toMatchObject({
        lastActiveTaskByProject: { [PROJECT_A_ID]: TASK_A2_ID },
      });
    } finally {
      await browser.close();
    }
  });

  test('on project switch, remembered tab with running session is restored as active', async () => {
    // Pre-seed Project A's remembered tab as TASK_A2_ID.
    // After switching away from Project A and back, the alpha-task-two tab
    // should be highlighted (active), not alpha-task-one.
    const { browser, page } = await launchWithState(
      buildPreConfig({ rememberedTaskForProjectA: TASK_A2_ID }),
    );
    try {
      await waitForBoard(page);

      // Project A is open - both tabs visible. The restore logic runs on project
      // open, so alpha-task-two should already be active.
      const tabA1 = page.locator('button:has-text("alpha-task-one")');
      const tabA2 = page.locator('button:has-text("alpha-task-two")');
      await expect(tabA1).toBeVisible();
      await expect(tabA2).toBeVisible();

      // The active tab carries the bg-surface-raised class.
      // Poll because the restore fires asynchronously after syncSessions resolves.
      await expect.poll(async () => {
        return tabA2.evaluate((element) => element.classList.contains('bg-surface-raised'));
      }, { timeout: 5000 }).toBe(true);

      // Ensure tabA1 is not the active one.
      await expect.poll(async () => {
        return tabA1.evaluate((element) => element.classList.contains('bg-surface-raised'));
      }, { timeout: 2000 }).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('on project switch, remembered tab with running session restores after switching away and back', async () => {
    // Pre-seed Project A's remembered tab as TASK_A2_ID.
    // Switch to Project B (which auto-selects beta-task), then switch back to
    // Project A -- the restore must re-select alpha-task-two.
    const { browser, page } = await launchWithState(
      buildPreConfig({ rememberedTaskForProjectA: TASK_A2_ID }),
    );
    try {
      await waitForBoard(page);

      // Confirm both Project A tabs are visible before the switch.
      await expect(page.locator('button:has-text("alpha-task-one")')).toBeVisible();
      await expect(page.locator('button:has-text("alpha-task-two")')).toBeVisible();

      // Switch to Project B.
      await switchToProject(page, 'Project Beta');
      await expect(page.locator('button:has-text("beta-task")')).toBeVisible();
      await expect(page.locator('button:has-text("alpha-task-one")')).not.toBeVisible();

      // Switch back to Project A.
      await switchToProject(page, 'Project Alpha');
      await expect(page.locator('button:has-text("alpha-task-two")')).toBeVisible();

      // The remembered tab (Task A2) should be the active one.
      const tabA2 = page.locator('button:has-text("alpha-task-two")');
      await expect.poll(async () => {
        return tabA2.evaluate((element) => element.classList.contains('bg-surface-raised'));
      }, { timeout: 5000 }).toBe(true);

      // Task A1 should not be active.
      const tabA1 = page.locator('button:has-text("alpha-task-one")');
      await expect.poll(async () => {
        return tabA1.evaluate((element) => element.classList.contains('bg-surface-raised'));
      }, { timeout: 2000 }).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('when remembered task has no running session the fallback auto-select takes over', async () => {
    // Pre-seed a remembered task ID that does NOT match any session in the
    // mock state. The restore guard in App.tsx checks for a running session;
    // if none is found it falls through and TerminalPanel's auto-select picks
    // the first available session instead.
    const NON_EXISTENT_TASK_ID = 'task-does-not-exist';
    const { browser, page } = await launchWithState(
      buildPreConfig({ rememberedTaskForProjectA: NON_EXISTENT_TASK_ID }),
    );
    try {
      await waitForBoard(page);

      // Both Project A tabs should still be visible.
      await expect(page.locator('button:has-text("alpha-task-one")')).toBeVisible();
      await expect(page.locator('button:has-text("alpha-task-two")')).toBeVisible();

      // Exactly one of the two tabs should be active (auto-select chose it).
      // We don't mandate WHICH one - just that exactly one is highlighted.
      await expect.poll(async () => {
        const tabOneActive = await page
          .locator('button:has-text("alpha-task-one")')
          .evaluate((element) => element.classList.contains('bg-surface-raised'));
        const tabTwoActive = await page
          .locator('button:has-text("alpha-task-two")')
          .evaluate((element) => element.classList.contains('bg-surface-raised'));
        // XOR: exactly one must be true
        return (tabOneActive ? 1 : 0) + (tabTwoActive ? 1 : 0);
      }, { timeout: 5000 }).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('no remembered entry for new project -- does not set any session as active via restore', async () => {
    // Neither project has a remembered tab. The restore logic should be a no-op
    // (the configStore has no entry for PROJECT_A_ID), leaving auto-select to
    // handle the default choice. We verify the negative: config.set is NOT
    // called during initial load (because the no-op guard short-circuits).
    //
    // This is an intentional fixed wait for the non-occurrence of a side effect.
    // We cannot poll for "config.set NOT called", so we give the app a brief
    // budget to settle, then assert.
    const { browser, page } = await launchWithState(buildPreConfig());
    try {
      await waitForBoard(page);

      // Give the app time to complete any async restore calls.
      // Intentional fixed wait - we are asserting non-occurrence of a side effect.
      await page.waitForTimeout(500);

      // The mock config.set should NOT have been called by the restore logic
      // (only called when a real tab click triggers selectActiveSession).
      // We check this by verifying that lastActiveTaskByProject is still empty.
      const stored = await page.evaluate(() => window.electronAPI.config.get());
      expect((stored as Record<string, unknown>).lastActiveTaskByProject ?? {}).toEqual({});
    } finally {
      await browser.close();
    }
  });
});
