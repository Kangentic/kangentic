/**
 * Regression spec for the PreSpawnContextBar layout fix in TaskDetailBody.
 *
 * Bug: during the transient pre-spawn window (hasSessionContext === true,
 * session.id === null), the old code had a fall-through that rendered
 * <PreSpawnContextBar /> as the ONLY child of TaskDetailBody. Because the
 * bar has no flex siblings in that branch, it floated to the top of the
 * dialog body instead of being pinned to the bottom.
 *
 * Fix: collapse the two adjacent returns into one that always renders a
 * flex-1 spacer ABOVE the bar, keeping it pinned regardless of whether
 * descriptionBar is truthy.
 *
 * What this test asserts:
 *   When spawnProgress[taskId] is set (triggering displayState.kind ===
 *   'preparing') but no session record exists for the task, the dialog body
 *   must render [data-testid="prespawn-context-bar"] as the LAST flex
 *   child, preceded by a div.flex-1 spacer. The CSS adjacency selector
 *   `div.flex-1 + [data-testid="prespawn-context-bar"]` captures this
 *   requirement: it only matches when the spacer immediately precedes the bar.
 *
 * Tier: UI (headless Chromium). The fixed code path is entirely in the
 * renderer. spawnProgress is injected directly into the session store via
 * __zustandStores.session.setState - no PTY, no real IPC, no Electron.
 *
 * How to verify RED / GREEN:
 *   Remove the `<div className="flex-1" />` line from the final return block
 *   in TaskDetailBody.tsx. The adjacency-selector assertion will fail because
 *   the spacer no longer precedes the bar. Restore the line -> GREEN.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-prespawn-layout-${RUN_ID}`;
const TASK_ID = `task-prespawn-layout-${RUN_ID}`;

/**
 * Launch a headless page pre-configured with:
 *   - One project with default swimlanes.
 *   - One task in Planning lane, description set, session_id null.
 *     Planning has auto_spawn=true, so dragging there sets spawnProgress.
 *     Here we skip the drag and inject spawnProgress directly into the store
 *     after React mounts, making the test fast and deterministic.
 */
async function launchWithPrespawnTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'PreSpawn Layout Test ${RUN_ID}',
        path: '/mock/prespawn-layout-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var planningLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-psl-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        if (template.name === 'Planning') planningLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId,
          position: index,
          created_at: ts,
        }));
      });

      // Task with a description, no session. Placed in Planning so the
      // descriptionBar is suppressed (hasSessionContext will be true once we
      // inject spawnProgress, so the !hasSessionContext guard in descriptionBar
      // prevents it rendering). This isolates the fixed branch.
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'PreSpawn Layout Task ${RUN_ID}',
        description: 'Regression guard for prespawn context bar pinning',
        swimlane_id: planningLaneId,
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        labels: [],
        priority: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  ({ browser, page } = await launchWithPrespawnTask());
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('TaskDetailBody: PreSpawnContextBar pinned to bottom during pre-spawn window', () => {
  test('flex-1 spacer precedes prespawn-context-bar when spawnProgress is set but no session exists', async () => {
    // Inject spawnProgress into the session store to simulate the transient
    // window between task-move and PTY attach (displayState.kind === 'preparing',
    // hasSessionContext === true, session.id === null).
    //
    // __zustandStores.session is the useSessionStore instance exposed in DEV
    // mode by App.tsx. setState merges into the existing store state via
    // Zustand's default shallow merge.
    await page.evaluate((taskId) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: {
            setState: (partial: { spawnProgress: Record<string, string> }) => void;
          };
        };
      }).__zustandStores;
      if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
      stores.session.setState({ spawnProgress: { [taskId]: 'Initializing...' } });
    }, TASK_ID);

    // Open the task detail dialog by clicking the task card.
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    await card.waitFor({ state: 'visible', timeout: 5000 });
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // 1. The bar must be visible.
    const bar = dialog.locator('[data-testid="prespawn-context-bar"]');
    await expect(bar).toBeVisible();

    // 2. A flex-1 spacer must immediately precede the bar in the DOM.
    //    This adjacency-selector assertion is the direct regression guard:
    //    removing the <div className="flex-1" /> from the fix's return block
    //    breaks this assertion because the spacer would no longer be adjacent.
    //    The selector reads: "a div with class flex-1 whose next sibling is
    //    [data-testid=prespawn-context-bar]".
    const spacerBeforeBar = dialog.locator('div.flex-1 + [data-testid="prespawn-context-bar"]');
    await expect(spacerBeforeBar).toBeVisible();

    // Close the dialog cleanly before the test ends. The dialog has no xterm
    // instance in this state (no session), so a keyboard Escape is safe here.
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 3000 });
  });
});
