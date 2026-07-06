/**
 * UI tests for the conversation viewer (a window-manager window, kind
 * 'conversation'). Seeds structured transcripts through the mock
 * `transcripts.get` / `transcripts.listSessions` bridge and verifies rendering,
 * scroll-to-turn highlight, session switching, the degraded banner, and each
 * empty state.
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

const PROJECT_ID = 'proj-conv';
const TASK_ID = 'task-conv-1';
const SESSION_A = 'sess-conv-a';
const SESSION_B = 'sess-conv-b';
const SCROLL_TARGET_UUID = 'turn-assistant-1';

/** Injected before the app mounts: a project + task, a conversation search hit,
 *  and the transcript fixtures the viewer fetches. */
function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      var nowMs = Date.now();

      state.projects.push({
        id: '${PROJECT_ID}', name: 'Conversation Project', path: '/mock/conv',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-conv-' + i, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${TASK_ID}', title: 'Wire the auth flow', description: '',
        swimlane_id: 'lane-conv-0', position: 0, agent: null, session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });

      var searchHits = [{
        kind: 'conversation', projectId: '${PROJECT_ID}', projectName: 'Conversation Project',
        taskId: '${TASK_ID}', taskTitle: 'Wire the auth flow', sessionId: '${SESSION_A}',
        agentName: 'Claude Code', chunkId: 1, turnUuid: '${SCROLL_TARGET_UUID}',
        turnKind: 'assistant', turnTs: nowMs, score: 0.95, matchKind: 'lexical',
        snippet: 'We reworked the auth flow', matchStart: 15, matchEnd: 19,
      }];

      // Session A: a full transcript exercising every row kind.
      var transcriptA = {
        sessionId: '${SESSION_A}', taskId: '${TASK_ID}', taskTitle: 'Wire the auth flow',
        agentName: 'Claude Code', startedAt: ts, source: 'live', sourcePath: '/mock/a.jsonl',
        entries: [
          { kind: 'user', uuid: 'turn-user-1', ts: nowMs, text: 'USER_QUESTION_ALPHA' },
          { kind: 'assistant', uuid: '${SCROLL_TARGET_UUID}', ts: nowMs + 1, model: 'claude-opus-4',
            blocks: [
              { type: 'text', text: 'ASSISTANT_TEXT_ALPHA' },
              { type: 'thinking', text: 'INNER_THOUGHT_ALPHA' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'auth.ts' } },
              { type: 'tool_use', id: 'tool-edit-1', name: 'Edit',
                input: { file_path: '/mock/greet.ts', old_string: 'const value = 1;', new_string: 'const value = 2;' } },
            ] },
          { kind: 'tool_result', uuid: 'turn-toolres-1', ts: nowMs + 2, toolUseId: 'tool-1',
            content: 'TOOL_RESULT_BODY_ALPHA', isError: false },
          { kind: 'system', uuid: 'turn-system-1', ts: nowMs + 3, subtype: 'compaction', text: 'compacted' },
          { kind: 'tool_result', uuid: 'turn-orphan-1', ts: nowMs + 4, toolUseId: 'tool-orphan',
            content: 'ORPHAN_RESULT_ALPHA', isError: true },
        ],
        degraded: false,
      };

      // Session B: a distinct transcript, to prove the session picker switches.
      var transcriptB = {
        sessionId: '${SESSION_B}', taskId: '${TASK_ID}', taskTitle: 'Wire the auth flow',
        agentName: 'Claude Code', startedAt: ts, source: 'live', sourcePath: '/mock/b.jsonl',
        entries: [
          { kind: 'user', uuid: 'turn-user-b', ts: nowMs, text: 'USER_QUESTION_BRAVO' },
        ],
        degraded: false,
      };

      // Degraded (index fallback) transcript.
      var transcriptDegraded = {
        sessionId: 'sess-degraded', taskId: null, taskTitle: 'Old session',
        agentName: 'Claude Code', startedAt: ts, source: 'index', sourcePath: null,
        entries: [{ kind: 'user', uuid: 'turn-deg', ts: nowMs, text: 'DEGRADED_TEXT' }],
        degraded: true,
      };

      function emptyResp(sid, reason) {
        return {
          sessionId: sid, taskId: null, taskTitle: '', agentName: '', startedAt: ts,
          source: 'none', sourcePath: null, entries: [], degraded: false, unavailableReason: reason,
        };
      }

      var transcriptSeeds = {};
      transcriptSeeds['${SESSION_A}'] = transcriptA;
      transcriptSeeds['${SESSION_B}'] = transcriptB;
      transcriptSeeds['sess-degraded'] = transcriptDegraded;
      transcriptSeeds['sess-empty-unsupported'] = emptyResp('sess-empty-unsupported', 'unsupported_agent');
      transcriptSeeds['sess-empty-nosession'] = emptyResp('sess-empty-nosession', 'no_agent_session_id');
      transcriptSeeds['sess-empty-missing'] = emptyResp('sess-empty-missing', 'file_missing');

      var transcriptSessionsByTask = {};
      transcriptSessionsByTask['${TASK_ID}'] = [
        { sessionId: '${SESSION_A}', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'exited' },
        { sessionId: '${SESSION_B}', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'exited' },
      ];

      return {
        currentProjectId: '${PROJECT_ID}',
        searchHits: searchHits,
        transcriptSeeds: transcriptSeeds,
        transcriptSessionsByTask: transcriptSessionsByTask,
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

/** Open the viewer for a session by setting the same store signal the
 *  discoverability buttons (session summary, task-detail kebab) set. */
async function openConversation(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((sid) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setConversationSessionId: (id: string) => void } } };
    }).__zustandStores;
    stores?.session.getState().setConversationSessionId(sid);
  }, sessionId);
  await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 5000 });
}

test.describe('Conversation Viewer', () => {
  test('renders every row kind and scrolls to the matched turn via the palette', async () => {
    const { browser, page } = await launch();
    try {
      // Open through the real search path so the conversation hit sets both
      // conversationSessionId AND the one-shot scrollToTurnUuid.
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('auth');
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });
      await page.locator('[data-result-kind="conversation"]').click();

      await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });

      // Scroll-to-turn highlight lands on the matched assistant turn. Assert this
      // FIRST: the highlight is a 1.5s transient, so check it before slower work.
      await expect
        .poll(async () =>
          page.locator(`[data-turn-uuid="${SCROLL_TARGET_UUID}"] [data-highlighted="true"]`).count(),
        )
        .toBeGreaterThan(0);

      // Title reflects the fetched task title.
      await expect(page.getByTestId('conversation-title')).toContainText('Wire the auth flow');

      // User + assistant rows render; the folded tool_result is inside the card.
      await expect(page.getByTestId('conversation-row-user')).toBeVisible();
      await expect(page.getByText('USER_QUESTION_ALPHA')).toBeVisible();
      await expect(page.getByTestId('conversation-row-assistant')).toBeVisible();
      await expect(page.getByText('ASSISTANT_TEXT_ALPHA')).toBeVisible();

      // The system divider and the orphan tool_result both render.
      await expect(page.getByTestId('conversation-row-system')).toBeVisible();
      await expect(page.getByTestId('conversation-row-tool-result')).toBeVisible();

      // Thinking is collapsed by default; its body appears only after toggling.
      await expect(page.getByText('INNER_THOUGHT_ALPHA')).toHaveCount(0);
      await page.getByTestId('conversation-thinking-toggle').first().click();
      await expect(page.getByText('INNER_THOUGHT_ALPHA')).toBeVisible();

      // Tool card is collapsed by default; expanding reveals input + result body.
      await expect(page.getByText('TOOL_RESULT_BODY_ALPHA')).toHaveCount(0);
      await page.getByTestId('conversation-tool-toggle').first().click();
      await expect(page.getByText('TOOL_RESULT_BODY_ALPHA')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a file-edit tool renders a colorized diff of old vs new', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, SESSION_A);

      // The Edit card summarizes with the file basename; expanding shows the diff.
      const editCard = page
        .locator('[data-testid="conversation-tool-card"]')
        .filter({ hasText: 'greet.ts' });
      await expect(editCard).toBeVisible();
      await editCard.getByTestId('conversation-tool-toggle').click();

      const diff = editCard.getByTestId('conversation-diff');
      await expect(diff).toBeVisible();
      // Both the removed and added lines render (lossless from old/new strings).
      await expect(diff).toContainText('const value = 1;');
      await expect(diff).toContainText('const value = 2;');
    } finally {
      await browser.close();
    }
  });

  test('session picker switches the shown transcript', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, SESSION_A);
      await expect(page.getByText('USER_QUESTION_ALPHA')).toBeVisible();

      // The task has two sessions, so the picker is shown; switch to session B.
      const picker = page.getByTestId('conversation-session-picker');
      await expect(picker).toBeVisible();
      await picker.selectOption(SESSION_B);

      await expect(page.getByText('USER_QUESTION_BRAVO')).toBeVisible();
      await expect(page.getByText('USER_QUESTION_ALPHA')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('degraded banner shows when content comes from the index fallback', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, 'sess-degraded');
      await expect(page.getByTestId('conversation-degraded-banner')).toBeVisible();
      await expect(page.getByText('DEGRADED_TEXT')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('empty states explain each unavailable reason', async () => {
    const { browser, page } = await launch();
    try {
      // Each session anchors its own window, so close the current one before
      // opening the next to keep a single conversation window on screen.
      const cases: Array<[string, string]> = [
        ['sess-empty-unsupported', "Structured transcripts aren't available for this agent."],
        ['sess-empty-nosession', "This session's history hasn't been written yet."],
        ['sess-empty-missing', 'The transcript file no longer exists.'],
      ];
      for (const [sessionId, expectedText] of cases) {
        await openConversation(page, sessionId);
        await expect(page.getByTestId('conversation-empty')).toContainText(expectedText);
        await page.getByTestId('conversation-close').click();
        await expect(page.getByTestId('conversation-window')).toHaveCount(0);
      }
    } finally {
      await browser.close();
    }
  });
});
