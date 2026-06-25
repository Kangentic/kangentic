/**
 * UI tests proving that a task-detail window rebuilt by a workspace restore (project switch)
 * paints flat with NO entrance animation, while a freshly user-opened window is left to play
 * the normal entrance animation.
 *
 * The feature under test:
 *   - `deserializeWorkspace` stamps `skipEnterAnimation: true` on every rebuilt window.
 *   - `WindowFrame` passes `skipEnter: managedWindow.skipEnterAnimation ?? false` to
 *     `useOverlayPhase`, which initialises phase to 'visible' (no enter class) instead of
 *     'entering' (which carries the class `overlay-content-in`).
 *   - `openWindow` (the fresh user-open path) leaves `skipEnterAnimation` unset, so its window
 *     keeps the default entrance.
 *
 * Determinism (per .claude/rules/cross-platform-parity.md - assert programmatic state, never
 * sub-frame pixels or animation timing):
 *   - The load-bearing assertion is the programmatic `skipEnterAnimation` flag on the rebuilt
 *     `ManagedWindow`, read straight from the window store. It has no timing dependence at all.
 *   - The restore test additionally asserts the rendered frame never carries `overlay-content-in`.
 *     Absence is stable: a restored window starts in phase='visible' on its very first render, so
 *     the class is never applied (unlike a fresh open, where it appears then disappears after the
 *     ~200ms animation - which is exactly the race this test avoids asserting on).
 *
 * Restore mechanics: the test calls `useWindowStore.getState().applyWorkspace(...)` directly -
 * the same function the real project-switch path (`restore-workspace.ts`) calls, with the same
 * `isKnownAnchor` (board contains the task) and `resolveSession` (null in UI tests) semantics.
 * `applyWorkspace` -> `deserializeWorkspace` is what stamps the flag.
 *
 * App.tsx change: `useWindowStore` is added to the dev-only `window.__zustandStores` block so the
 * test can drive `applyWorkspace` and read the window list without module-path gymnastics.
 */

import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Fixed IDs - no personal info, no machine paths.
const PROJECT_ID = 'proj-win-anim-test';
const TASK_ID = 'task-win-anim-test';
const TASK_TITLE = 'Animation Test Task';

/** A valid v1 workspace blob with a single floating detail window for our task. */
const WORKSPACE_BLOB = {
  version: 1,
  windows: [
    {
      taskId: TASK_ID,
      title: TASK_TITLE,
      geometry: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      restoreGeometry: null,
      state: 'floating',
    },
  ],
  tileTree: null,
  tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
  focusedTaskId: TASK_ID,
};

/** Pre-configure the mock: one project, board open, one task in the first swimlane. */
const PRE_CONFIGURE_SCRIPT = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Animation Test Project',
      path: '/mock/${PROJECT_ID}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.DEFAULT_SWIMLANES.forEach(function (lane, i) {
      state.swimlanes.push(Object.assign({}, lane, {
        id: 'lane-anim-' + i,
        position: i,
        created_at: ts,
      }));
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
  await page.addInitScript(PRE_CONFIGURE_SCRIPT);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

type ZustandStores = {
  board: {
    getState: () => { tasks: Array<{ id: string }> };
    setState: (partial: object) => void;
  };
  session: {
    getState: () => { setDetailTaskId: (id: string | null, options?: { initialEdit?: boolean }) => void };
  };
  window: {
    getState: () => {
      applyWorkspace: (
        workspace: unknown,
        resolveSession: (anchor: string) => string | null,
        isKnownAnchor: (anchor: string) => boolean,
      ) => void;
      windows: Record<string, { skipEnterAnimation?: boolean }>;
    };
  };
};

/** Seed the board store so `isKnownAnchor` returns true for TASK_ID during restore and so the
 *  detail bridge can find the task on open. Idempotent. */
async function seedBoardStoreTask(page: Page): Promise<void> {
  await page.evaluate(
    ({ taskId, taskTitle, projectId }) => {
      const stores = (window as unknown as { __zustandStores?: ZustandStores }).__zustandStores;
      if (!stores) throw new Error('window.__zustandStores not exposed');
      const existing = stores.board.getState().tasks;
      if (existing.some((task) => task.id === taskId)) return;
      const now = new Date().toISOString();
      stores.board.setState({
        tasks: [
          ...existing,
          {
            id: taskId,
            display_id: 1,
            title: taskTitle,
            description: '',
            swimlane_id: 'lane-anim-0',
            position: 0,
            agent: null,
            session_id: null,
            worktree_path: null,
            branch_name: null,
            pr_number: null,
            pr_url: null,
            pr_state: null,
            base_branch: null,
            use_worktree: null,
            labels: [],
            priority: 0,
            model_override: null,
            effort_override: null,
            agent_override: null,
            attachment_count: 0,
            archived_at: null,
            created_at: now,
            updated_at: now,
            projectId,
          },
        ],
        hydrated: true,
        loading: false,
      });
    },
    { taskId: TASK_ID, taskTitle: TASK_TITLE, projectId: PROJECT_ID },
  );
}

/** Run the real restore entry point with the workspace blob (mirrors restore-workspace.ts). */
async function applyWorkspaceRestore(page: Page): Promise<void> {
  await page.evaluate((workspace) => {
    const stores = (window as unknown as { __zustandStores?: ZustandStores }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const boardTasks = stores.board.getState().tasks;
    stores.window.getState().applyWorkspace(
      workspace,
      () => null, // resolveSession: no live PTY in UI tests; the window still mounts.
      (anchor: string) => boardTasks.some((task) => task.id === anchor), // isKnownAnchor
    );
  }, WORKSPACE_BLOB);
}

/** Read each managed window's skip-enter flag, normalised to a strict boolean (undefined -> false,
 *  which is how it travels over the CDP bridge anyway). */
async function readSkipEnterFlags(page: Page): Promise<boolean[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as { __zustandStores?: ZustandStores }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    return Object.values(stores.window.getState().windows).map((managed) => managed.skipEnterAnimation === true);
  });
}

test.describe('task-detail window entrance animation suppression on restore', () => {
  test('a restored window carries the skip-enter flag and paints flat (no overlay-content-in)', async () => {
    const { browser, page } = await launch();
    try {
      await seedBoardStoreTask(page);
      await applyWorkspaceRestore(page);

      const restoredFrame = page.locator('[data-testid^="window-frame-"]').first();
      await restoredFrame.waitFor({ state: 'attached', timeout: 5000 });

      // Programmatic state: deserializeWorkspace stamped the flag on the rebuilt window.
      await expect.poll(() => readSkipEnterFlags(page), { timeout: 5000 }).toEqual([true]);

      // Rendered effect: phase started 'visible', so the frame never gets the entrance class.
      await expect(restoredFrame).not.toHaveClass(/overlay-content-in/);
    } finally {
      await browser.close();
    }
  });

  test('a freshly opened window is left without the skip-enter flag (keeps its entrance)', async () => {
    const { browser, page } = await launch();
    try {
      await seedBoardStoreTask(page);

      // Card-click path: setDetailTaskId -> useTaskDetailWindowBridge -> openWindow, which does
      // NOT set skipEnterAnimation.
      await page.evaluate((taskId) => {
        const stores = (window as unknown as { __zustandStores?: ZustandStores }).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        stores.session.getState().setDetailTaskId(taskId);
      }, TASK_ID);

      const freshFrame = page.locator('[data-testid^="window-frame-"]').first();
      await freshFrame.waitFor({ state: 'attached', timeout: 5000 });

      // Programmatic state: the open path leaves the flag unset, so the window animates in
      // (the suppression is scoped to restored windows only).
      await expect.poll(() => readSkipEnterFlags(page), { timeout: 5000 }).toEqual([false]);
    } finally {
      await browser.close();
    }
  });
});
