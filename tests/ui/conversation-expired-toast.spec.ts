/**
 * UI coverage for the `task:conversationExpired` push.
 *
 * A resume that found the agent had deleted the task's conversation (Claude
 * Code removes transcripts older than its `cleanupPeriodDays`) starts a new one
 * from a recap. A task startup recovery resumes in the background would
 * otherwise start over with nobody told, so main pushes this and the renderer
 * shows an info toast. The spawn itself is covered in the unit tier; this spec
 * covers the push half.
 *
 * Tier: UI (headless Chromium). No PTY, no Electron main process.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const CURRENT_PROJECT_ID = 'proj-expired-current';
const OTHER_PROJECT_ID = 'proj-expired-other';

const PRE_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${CURRENT_PROJECT_ID}',
      name: 'Expired Current',
      path: '/mock/expired-current',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.projects.push({
      id: '${OTHER_PROJECT_ID}',
      name: 'Expired Other',
      path: '/mock/expired-other',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, { id: 'expired-lane-' + i, position: i, created_at: ts }));
    });
    return { currentProjectId: '${CURRENT_PROJECT_ID}' };
  });
`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRE_CONFIG);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

function fireConversationExpired(page: Page, notice: {
  projectId: string;
  taskTitle: string;
  lastActiveAt: string | null;
  messageDropped: boolean;
}) {
  return page.evaluate((payload) => {
    (window as unknown as {
      __mockFireConversationExpired: (notice: Record<string, unknown>) => void;
    }).__mockFireConversationExpired({ taskId: `task-${payload.taskTitle}`, ...payload });
  }, notice);
}

test.describe('task:conversationExpired push', () => {
  test('shows an info toast naming the task, and says when its message was not sent', async () => {
    const { browser, page } = await launch();
    try {
      await fireConversationExpired(page, {
        projectId: CURRENT_PROJECT_ID,
        taskTitle: 'Fix login redirect',
        lastActiveAt: '2026-08-16T14:00:00.000Z',
        messageDropped: true,
      });

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Fix login redirect' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast).toContainText('started a new conversation');
      await expect(toast).toContainText('had expired');
      await expect(toast).toContainText('Its pending message was not sent.');
    } finally {
      await browser.close();
    }
  });

  test('stays silent for a background project', async () => {
    const { browser, page } = await launch();
    try {
      await fireConversationExpired(page, {
        projectId: OTHER_PROJECT_ID, taskTitle: 'Background Task', lastActiveAt: null, messageDropped: false,
      });
      // Both pushes cross the same channel in order, so once the second has
      // rendered the first has definitively been handled and dropped.
      await fireConversationExpired(page, {
        projectId: CURRENT_PROJECT_ID, taskTitle: 'Foreground Task', lastActiveAt: null, messageDropped: false,
      });
      await expect(page.locator('[data-testid="toast"]').filter({ hasText: 'Foreground Task' }))
        .toBeVisible({ timeout: 5000 });
      await expect(page.locator('text=/Background Task/')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
