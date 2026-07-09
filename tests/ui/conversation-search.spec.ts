/**
 * UI tests for the conversation viewer's in-viewer search bar
 * (ConversationSearchBar.tsx): always visible by default (no header toggle
 * button), Mod+F focuses it, navigating to a result by click and via
 * prev/next, the match count, a hit inside a folded tool card auto-expanding
 * it, Escape blurring the input without closing the window (a second Escape
 * then closes it), and that the board's own Mod+F does not also fire.
 *
 * Cross-platform: no pixel assertions, no bare waitForTimeout - every check
 * polls for a condition (data attribute / testid / text).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-conv-search';
const TASK_ID = 'task-conv-search-1';
const SESSION_ID = 'sess-conv-search-a';

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      var nowMs = Date.now();

      state.projects.push({
        id: '${PROJECT_ID}', name: 'Conversation Search Project', path: '/mock/convsearch',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-convsearch-' + i, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${TASK_ID}', title: 'Search fixture task', description: '',
        swimlane_id: 'lane-convsearch-0', position: 0, agent: null, session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });

      var transcriptSeeds = {};
      transcriptSeeds['${SESSION_ID}'] = {
        sessionId: '${SESSION_ID}', taskId: '${TASK_ID}', taskTitle: 'Search fixture task',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'exited',
        source: 'live', sourcePath: '/mock/convsearch.jsonl',
        entries: [
          { kind: 'user', uuid: 'turn-1', ts: nowMs, text: 'Please look at the retry backoff logic' },
          { kind: 'assistant', uuid: 'turn-2', ts: nowMs + 1, model: 'claude-opus-4-8',
            blocks: [{ type: 'text', text: 'I looked at the retry backoff logic and found the bug' }] },
          { kind: 'user', uuid: 'turn-3', ts: nowMs + 2, text: 'Thanks, what about the worktree cleanup path' },
          { kind: 'assistant', uuid: 'turn-4', ts: nowMs + 3, model: 'claude-opus-4-8',
            blocks: [
              { type: 'text', text: 'Checking the worktree cleanup path now' },
              { type: 'tool_use', id: 'tool-search-1', name: 'Bash', input: { command: 'git worktree list' } },
            ] },
          { kind: 'tool_result', uuid: 'turn-5', ts: nowMs + 4, toolUseId: 'tool-search-1',
            content: 'FOLDED_RESULT_MARKER worktree list output here', isError: false },
          { kind: 'user', uuid: 'turn-6', ts: nowMs + 5, text: 'One more unrelated turn with no matches at all' },
        ],
        degraded: false,
        sessions: [
          { sessionId: '${SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' },
        ],
      };

      return {
        currentProjectId: '${PROJECT_ID}',
        transcriptSeeds: transcriptSeeds,
      };
    });
  `;
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig());
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

async function openConversation(page: Page): Promise<void> {
  await page.evaluate((sid) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setConversationSessionId: (id: string) => void } } };
    }).__zustandStores;
    stores?.session.getState().setConversationSessionId(sid);
  }, SESSION_ID);
  await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });
}

/** The conversation window must be FOCUSED for its Mod+F binding to win over
 *  the board's global one - click its title bar to focus it. */
async function focusConversationWindow(page: Page): Promise<void> {
  await page.getByTestId('conversation-titlebar').click({ position: { x: 200, y: 10 } });
}

test.describe('Conversation Viewer - in-viewer search', () => {
  test('the search bar is visible by default, with no header toggle button', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);
      await expect(page.getByTestId('conversation-search-bar')).toBeVisible();
      await expect(page.getByTestId('conversation-search-input')).toBeVisible();
      await expect(page.getByTestId('conversation-search-button')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Mod+F focuses the search input while the conversation window is focused, without also triggering board find', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);
      await focusConversationWindow(page);

      await page.keyboard.press('ControlOrMeta+F');
      await expect(page.getByTestId('conversation-search-input')).toBeFocused();
      // The board's own find/search palette must not also have opened.
      await expect(page.getByTestId('search-palette-input')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('typing a query lists matching turns with a count, and clicking a result navigates and flashes it', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);

      await page.getByTestId('conversation-search-input').fill('retry backoff');
      await expect(page.getByTestId('conversation-search-results')).toBeVisible();
      const results = page.getByTestId('conversation-search-result');
      // Both turn-1 (user) and turn-2 (assistant) mention "retry backoff".
      await expect(results).toHaveCount(2);

      await results.first().click();
      await expect
        .poll(async () => page.locator('[data-highlighted="true"]').count())
        .toBeGreaterThan(0);
      await expect(page.getByTestId('conversation-search-count')).toHaveText('1 of 2');
    } finally {
      await browser.close();
    }
  });

  test('prev/next navigation cycles through matches and wraps, updating the count', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);
      await page.getByTestId('conversation-search-input').fill('retry backoff');
      await expect(page.getByTestId('conversation-search-results')).toBeVisible();

      await page.getByTestId('conversation-search-next').click();
      await expect(page.getByTestId('conversation-search-count')).toHaveText('1 of 2');
      await page.getByTestId('conversation-search-next').click();
      await expect(page.getByTestId('conversation-search-count')).toHaveText('2 of 2');
      // Wraps back to the first match.
      await page.getByTestId('conversation-search-next').click();
      await expect(page.getByTestId('conversation-search-count')).toHaveText('1 of 2');

      // Enter/Shift+Enter drive the same navigation from the input.
      await page.getByTestId('conversation-search-input').press('Shift+Enter');
      await expect(page.getByTestId('conversation-search-count')).toHaveText('2 of 2');
    } finally {
      await browser.close();
    }
  });

  test('a hit inside a folded tool result auto-expands the owning tool card on navigate', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);

      await page.getByTestId('conversation-search-input').fill('FOLDED_RESULT_MARKER');
      const result = page.getByTestId('conversation-search-result').first();
      await expect(result).toBeVisible();
      await result.click();

      // The tool card the result folded into must expand and show the
      // matched text, which is otherwise hidden until toggled open.
      await expect(page.getByText('FOLDED_RESULT_MARKER', { exact: false })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Escape blurs the search input without closing the window; a second Escape then closes it', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);
      await focusConversationWindow(page);
      const input = page.getByTestId('conversation-search-input');
      await input.click();
      await expect(input).toBeFocused();

      await input.press('Escape');
      await expect(input).not.toBeFocused();
      // The bar itself has no closed state - it stays mounted and visible.
      await expect(page.getByTestId('conversation-search-bar')).toBeVisible();
      await expect(page.getByTestId('conversation-window')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('conversation-window')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a query with no matches shows "No results" and disables prev/next', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);

      await page.getByTestId('conversation-search-input').fill('nothing matches this string anywhere');
      await expect(page.getByTestId('conversation-search-count')).toHaveText('No results');
      await expect(page.getByTestId('conversation-search-next')).toBeDisabled();
      await expect(page.getByTestId('conversation-search-previous')).toBeDisabled();
      await expect(page.getByTestId('conversation-search-results')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
