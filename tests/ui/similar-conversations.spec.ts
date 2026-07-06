/**
 * UI tests for the proactive "Similar conversations" section on the task detail
 * (Phase 3). Verifies that seeded matches render as rows, that clicking a row
 * opens the conversation viewer (session-store nav signals + the window), and
 * that no section renders when there are no matches.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-similar';
const TASK_ID = 'task-similar-1';

/** Two conversation-kind hits the memory index would return for the task. */
const SIMILAR_HITS = [
  {
    kind: 'conversation',
    projectId: PROJECT_ID,
    projectName: 'Similar Test',
    taskId: 'other-task-1',
    taskTitle: 'Earlier auth refactor',
    sessionId: 'sess-similar-1',
    agentName: 'Claude Code',
    chunkId: 1,
    turnUuid: 'turn-similar-1',
    turnKind: 'assistant',
    turnTs: Date.now(),
    score: 0.88,
    matchKind: 'semantic',
    snippet: 'We refactored the auth token refresh flow',
    matchStart: 0,
    matchEnd: 0,
  },
  {
    kind: 'conversation',
    projectId: PROJECT_ID,
    projectName: 'Similar Test',
    taskId: 'other-task-2',
    taskTitle: 'Login page cleanup',
    sessionId: 'sess-similar-2',
    agentName: 'Claude Code',
    chunkId: 2,
    turnUuid: 'turn-similar-2',
    turnKind: 'assistant',
    turnTs: Date.now(),
    score: 0.71,
    matchKind: 'semantic',
    snippet: 'Simplified the login form validation',
    matchStart: 0,
    matchEnd: 0,
  },
];

/** Pre-configure script: one archived (Done) task whose detail hosts the section. */
function makePreConfig(similar: unknown[]): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Similar Test',
        path: '/mock/similar-test',
        github_url: null,
        default_agent: 'claude',
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        state.swimlanes.push(Object.assign({}, template, {
          id: state.uuid(),
          position: index,
          created_at: ts,
        }));
      });

      var doneLane = state.swimlanes.find(function (lane) { return lane.role === 'done'; });

      state.archivedTasks.push({
        id: '${TASK_ID}',
        title: 'Completed Test Task',
        description: 'A task that has been completed',
        swimlane_id: doneLane.id,
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: null,
        attachment_count: 0,
        archived_at: ts,
        created_at: ts,
        updated_at: ts,
      });

      return {
        currentProjectId: '${PROJECT_ID}',
        similarConversations: ${JSON.stringify(similar)},
      };
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

test.describe('Similar Conversations', () => {
  test('renders one row per seeded match on the task detail', async () => {
    const { browser, page } = await launchWithState(makePreConfig(SIMILAR_HITS));
    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('text=Completed Test Task').click();

      const section = page.getByTestId('similar-conversations');
      await expect(section).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="similar-conversation-row"]')).toHaveCount(2);
      await expect(section).toContainText('Earlier auth refactor');
      await expect(section).toContainText('Login page cleanup');
    } finally {
      await browser.close();
    }
  });

  test('clicking a row arms the nav signals and opens the conversation viewer', async () => {
    const { browser, page } = await launchWithState(makePreConfig(SIMILAR_HITS));
    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('text=Completed Test Task').click();

      await page.locator('[data-testid="similar-conversation-row"]').first().click();

      // Clicking sets the nav signal and opens the viewer for the first hit's
      // session. (setScrollToTurnUuid is armed on the same click, but the viewer
      // consumes that one-shot on mount - its scroll behavior is covered in
      // conversation-viewer.spec.ts - so we assert the durable session signal.)
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const stores = (window as unknown as {
              __zustandStores?: {
                session: { getState: () => { conversationSessionId: string | null } };
              };
            }).__zustandStores;
            return stores?.session.getState().conversationSessionId ?? null;
          }),
        )
        .toBe('sess-similar-1');

      await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('renders nothing when there are no similar conversations', async () => {
    const { browser, page } = await launchWithState(makePreConfig([]));
    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('text=Completed Test Task').click();

      // The session summary still renders (empty state), but the similar section
      // is absent - no empty box when there are no matches.
      await expect(page.getByTestId('session-summary')).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('similar-conversations')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
