/**
 * UI tests for archive lazy-loading (the board hydrates a cheap preview, the
 * full archive loads only while a viewer is mounted).
 *
 * Contract:
 *   1. On board load the archive is fetched via `tasks.listArchivedPreview`
 *      (newest 15 + total count), NEVER the full `tasks.listArchived`.
 *   2. The Done column shows the true total count ("Completed (20)") and renders
 *      exactly the newest 15 preview cards.
 *   3. Opening the Completed dialog triggers exactly one full `tasks.listArchived`
 *      and shows the full total.
 *   4. An agent-driven reload while the dialog is open does NOT shrink the loaded
 *      full list back to the preview.
 *   5. After the dialog closes, the next agent-driven reload downgrades back to
 *      the preview: no further full `tasks.listArchived`, only the preview fetch.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own page (separate context / goto reset), so the file
// can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-archived-lazy-load';
const ARCHIVED_COUNT = 20;
const PREVIEW_LIMIT = 15;

async function launchWithArchivedTasks(): Promise<{ browser: Browser; page: Page }> {
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
        name: 'Archived Lazy Load Test',
        path: '/mock/archived-lazy-load-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-all-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });

      // Seed ${ARCHIVED_COUNT} archived tasks with strictly-descending archived_at
      // so the newest-first preview order is deterministic.
      for (var i = 0; i < ${ARCHIVED_COUNT}; i += 1) {
        var archivedAt = new Date(Date.now() - i * 1000).toISOString();
        state.archivedTasks.push({
          id: 'arch-' + i,
          title: 'Archived Task ' + i,
          description: 'Completed task ' + i,
          swimlane_id: laneIds['Done'],
          position: 0,
          agent: 'claude',
          session_id: null,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: 'main',
          use_worktree: 0,
          labels: [],
          priority: 0,
          attachment_count: 0,
          archived_at: archivedAt,
          created_at: ts,
          updated_at: ts,
        });
      }

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  // The Done column is always visible once the board hydrates.
  await page.waitForSelector('[data-swimlane-name="Done"]', { timeout: 15000 });

  return { browser, page };
}

function readCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() =>
    (window as unknown as { __getIpcCallCounts: () => Record<string, number> }).__getIpcCallCounts(),
  );
}

function resetCounts(page: Page): Promise<void> {
  return page.evaluate(() =>
    (window as unknown as { __resetIpcCallCounts: () => void }).__resetIpcCallCounts(),
  );
}

test.describe('archive lazy-load', () => {
  test('board hydrates the preview, not the full archive', async () => {
    const { browser, page } = await launchWithArchivedTasks();
    try {
      const doneColumn = page.locator('[data-swimlane-name="Done"]');

      // The header shows the true total from the preview payload.
      await expect(doneColumn.getByText(`Completed (${ARCHIVED_COUNT})`)).toBeVisible({ timeout: 5000 });

      // Exactly the newest 15 preview cards are rendered inline.
      const previewCards = doneColumn.locator('[data-testid="compact-title"]');
      await expect(previewCards).toHaveCount(PREVIEW_LIMIT, { timeout: 5000 });

      // The preview endpoint was used; the full archive was never fetched.
      const counts = await readCounts(page);
      expect(counts['tasks.listArchivedPreview'] ?? 0).toBeGreaterThan(0);
      expect(counts['tasks.listArchived'] ?? 0).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('opening the Completed dialog loads the full archive exactly once', async () => {
    const { browser, page } = await launchWithArchivedTasks();
    try {
      await resetCounts(page);

      await page.locator('[data-testid="expand-completed-btn"]').click();

      const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog.getByText(`Completed Tasks (${ARCHIVED_COUNT})`)).toBeVisible();

      // The footer count is derived from the loaded rows (not virtualized DOM),
      // so it reaches the full total only after the lazy full-load resolves.
      await expect(dialog.getByText(`${ARCHIVED_COUNT} tasks`)).toBeVisible({ timeout: 5000 });

      await expect
        .poll(async () => (await readCounts(page))['tasks.listArchived'] ?? 0, { timeout: 5000 })
        .toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('agent-driven reload with the dialog open does not shrink the full list', async () => {
    const { browser, page } = await launchWithArchivedTasks();
    try {
      await page.locator('[data-testid="expand-completed-btn"]').click();
      const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog.getByText(`${ARCHIVED_COUNT} tasks`)).toBeVisible({ timeout: 5000 });

      // Fire a current-project agent update; this schedules the 250ms-debounced
      // loadBoard. With a viewer mounted it must keep the full list.
      await page.evaluate((projectId) => {
        (window as unknown as { __mockFireTaskUpdatedByAgent: (taskId: string, title: string, projectId: string) => void })
          .__mockFireTaskUpdatedByAgent('arch-0', 'Archived Task 0', projectId);
      }, PROJECT_ID);

      // Give the debounce + reload time to run.
      await page.waitForTimeout(600);

      // The full list is still shown; it did NOT downgrade to the 15-row preview.
      await expect(dialog.getByText(`${ARCHIVED_COUNT} tasks`)).toBeVisible();
      await expect(dialog.getByText(`${PREVIEW_LIMIT} tasks`)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('closing the dialog downgrades back to the preview on the next reload', async () => {
    const { browser, page } = await launchWithArchivedTasks();
    try {
      // Open then close the dialog so the full archive was loaded and released.
      await page.locator('[data-testid="expand-completed-btn"]').click();
      const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog.getByText(`${ARCHIVED_COUNT} tasks`)).toBeVisible({ timeout: 5000 });

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5000 });

      await resetCounts(page);

      // A current-project agent reload after the viewer is gone should refetch
      // only the cheap preview, never the full archive again.
      await page.evaluate((projectId) => {
        (window as unknown as { __mockFireTaskUpdatedByAgent: (taskId: string, title: string, projectId: string) => void })
          .__mockFireTaskUpdatedByAgent('arch-0', 'Archived Task 0', projectId);
      }, PROJECT_ID);

      await expect
        .poll(async () => (await readCounts(page))['tasks.listArchivedPreview'] ?? 0, { timeout: 5000 })
        .toBeGreaterThan(0);

      const counts = await readCounts(page);
      expect(counts['tasks.listArchived'] ?? 0).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
