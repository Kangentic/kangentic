/**
 * A render throw in one surface of the main window costs that surface only.
 * Before each surface had its own boundary, a throw anywhere fell to the root
 * ErrorBoundary, which replaces the window and unmounts every terminal and
 * Browser pane guest with it.
 *
 * The throw is real: a search hit whose snippet is missing makes the search
 * palette's highlight read `.slice` of null while rendering. The board, the
 * sidebar and the status bar must still be there and still have their height,
 * and the root's error page must not be. The first run of this spec caught a
 * filling fallback that took the window's whole height and left the board
 * hidden, which is why an overlay's fallback floats.
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PRECONFIGURE = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: 'proj-boundary', name: 'Boundary Project', path: '/mock/boundary',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, { id: 'lane-boundary-' + i, position: i, created_at: ts }));
    });
    state.tasks.push({
      id: 'task-boundary-1', title: 'A card that stays', description: '',
      swimlane_id: 'lane-boundary-0', position: 0, agent: null, session_id: null,
      worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
      base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
    });
    return {
      currentProjectId: 'proj-boundary',
      searchHits: [{
        kind: 'task', projectId: 'proj-boundary', projectName: 'Boundary Project',
        taskId: 'task-boundary-1', displayId: 1, taskTitle: 'A card that stays', archived: false,
        snippetField: 'title', snippet: null, matchStart: 0, matchEnd: 4,
      }],
    };
  });
`;

test('a throw in the search palette leaves the board, sidebar and status bar mounted', async () => {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(PRECONFIGURE);
    await gotoVite(page, VITE_URL);
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

    await page.keyboard.press('Control+Shift+F');
    await page.getByTestId('search-palette-input').fill('card');

    await expect(page.getByTestId('panel-error-boundary')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('search-palette')).toHaveCount(0);
    await expect(page.getByTestId('root-error-retry')).toHaveCount(0);
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();
    await expect(page.getByText('A card that stays')).toBeVisible();
    await expect(page.getByTestId('sidebar-area')).toBeVisible();
    await expect(page.getByTestId('app-status-bar')).toBeVisible();

    // The palette's own Escape went with it, so the fallback carries a Close.
    await page.getByTestId('panel-error-dismiss').click();
    await expect(page.getByTestId('panel-error-boundary')).toHaveCount(0);
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();
  } finally {
    await browser.close();
  }
});
