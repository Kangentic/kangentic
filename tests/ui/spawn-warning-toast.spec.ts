/**
 * UI coverage for the `task:spawnWarning` push.
 *
 * Unlike `task:spawnBlocked`, the agent DID start; main composes the whole
 * message (which base branch, why the fetch failed) and cooldown-guards it,
 * so the renderer toasts it verbatim with no framing of its own. This spec
 * covers App.tsx's `tasks.onSpawnWarning` subscription: it toasts for the
 * current project and stays silent for a background one, mirroring the
 * `task:spawnBlocked` coverage in spawn-blocked-toast.spec.ts.
 *
 * Tier: UI (headless Chromium). No PTY, no Electron main process.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const CURRENT_PROJECT_ID = 'proj-warning-current';
const OTHER_PROJECT_ID = 'proj-warning-other';

const PRE_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${CURRENT_PROJECT_ID}',
      name: 'Warning Current',
      path: '/mock/warning-current',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.projects.push({
      id: '${OTHER_PROJECT_ID}',
      name: 'Warning Other',
      path: '/mock/warning-other',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, { id: 'warning-lane-' + i, position: i, created_at: ts }));
    });
    return { currentProjectId: '${CURRENT_PROJECT_ID}' };
  });
`;

const WARNING_MESSAGE =
  '"Task A": could not fetch latest \'main\' from origin (network unreachable). '
  + 'Starting from the last fetched state.';

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRE_CONFIG);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

function fireSpawnWarning(page: Page, projectId: string | undefined, message: string, taskId = 'task-warning') {
  return page.evaluate(
    ([id, msg, targetProjectId]) => {
      (window as unknown as {
        __mockFireTaskSpawnWarning: (taskId: string, message: string, projectId?: string) => void;
      }).__mockFireTaskSpawnWarning(id, msg, targetProjectId);
    },
    [taskId, message, projectId] as const,
  );
}

test.describe('task:spawnWarning push', () => {
  test('toasts the message verbatim for the current project', async () => {
    const { browser, page } = await launch();
    try {
      await fireSpawnWarning(page, CURRENT_PROJECT_ID, WARNING_MESSAGE);

      // Main composes the whole message with no renderer framing, unlike
      // onSpawnBlocked's "did not start its agent" wrapper - assert both that
      // the message appears AND that it was not routed through the blocked
      // handler's framing, so a future merge of the two channels reds here.
      const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'could not fetch latest' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast).toContainText(WARNING_MESSAGE);
      await expect(toast).not.toContainText('did not start its agent');
    } finally {
      await browser.close();
    }
  });

  test('stays silent for a background project', async () => {
    const { browser, page } = await launch();
    try {
      // Fire one for a background project, then one for the current project.
      // Both cross the same channel in order, so once the second has rendered
      // the first has definitively been handled and dropped - the ordering
      // trick from spawn-blocked-toast.spec.ts, not a fixed wait.
      await fireSpawnWarning(page, OTHER_PROJECT_ID, 'Background project warning message', 'task-background');
      await fireSpawnWarning(page, CURRENT_PROJECT_ID, 'Foreground project warning message', 'task-foreground');

      await expect(page.locator('text=/Foreground project warning message/'))
        .toBeVisible({ timeout: 5000 });

      await expect(page.locator('text=/Background project warning message/')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
