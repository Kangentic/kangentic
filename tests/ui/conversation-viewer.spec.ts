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

      // A task's conversation is always its ENTIRE lifecycle: every session it
      // has ever accumulated, stitched into one timeline, regardless of which
      // of the task's sessions is requested. Session A's own entries exercise
      // every row kind; session B is a second (later) session for the SAME
      // task. The real backend (resolveTaskTranscript) returns the identical
      // combined response no matter which session id you ask for, so both
      // seeds below are the SAME object.
      var sessionBoundaryEntry = {
        kind: 'system', uuid: 'session-boundary-${SESSION_B}', ts: nowMs + 10,
        subtype: 'session_boundary', text: 'New session',
      };
      var transcriptUnified = {
        sessionId: '${SESSION_B}', taskId: '${TASK_ID}', taskTitle: 'Wire the auth flow',
        agentName: 'Claude Code', startedAt: ts, source: 'live', sourcePath: '/mock/b.jsonl',
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
          sessionBoundaryEntry,
          { kind: 'user', uuid: 'turn-user-b', ts: nowMs + 11, text: 'USER_QUESTION_BRAVO' },
        ],
        degraded: false,
        sessions: [
          { sessionId: '${SESSION_A}', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' },
          { sessionId: '${SESSION_B}', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'exited' },
        ],
      };

      // Degraded (index fallback) transcript.
      var transcriptDegraded = {
        sessionId: 'sess-degraded', taskId: null, taskTitle: 'Old session',
        agentName: 'Claude Code', startedAt: ts, source: 'index', sourcePath: null,
        entries: [{ kind: 'user', uuid: 'turn-deg', ts: nowMs, text: 'DEGRADED_TEXT' }],
        degraded: true,
        sessions: [{ sessionId: 'sess-degraded', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' }],
      };

      function emptyResp(sid, reason) {
        return {
          sessionId: sid, taskId: null, taskTitle: '', agentName: '', startedAt: ts,
          source: 'none', sourcePath: null, entries: [], degraded: false, unavailableReason: reason,
          sessions: [],
        };
      }

      // Two consecutive assistant turns (each a lone tool call), to verify the
      // role badge renders on EVERY assistant row - not just the first in a
      // same-speaker run (a prior "once per run" collapsing this session reversed).
      var transcriptConsecutive = {
        sessionId: 'sess-conv-consecutive', taskId: null, taskTitle: 'Consecutive tool calls',
        agentName: 'Claude Code', startedAt: ts, source: 'live', sourcePath: '/mock/consecutive.jsonl',
        entries: [
          { kind: 'assistant', uuid: 'turn-asst-consec-1', ts: nowMs, model: 'claude-opus-4-8',
            blocks: [{ type: 'tool_use', id: 'tool-consec-1', name: 'Glob', input: { pattern: '*.md' } }] },
          { kind: 'tool_result', uuid: 'turn-toolres-consec-1', ts: nowMs + 1, toolUseId: 'tool-consec-1', content: 'README.md', isError: false },
          { kind: 'assistant', uuid: 'turn-asst-consec-2', ts: nowMs + 2, model: 'claude-opus-4-8',
            blocks: [{ type: 'tool_use', id: 'tool-consec-2', name: 'Read', input: { file_path: 'README.md' } }] },
          { kind: 'tool_result', uuid: 'turn-toolres-consec-2', ts: nowMs + 3, toolUseId: 'tool-consec-2', content: 'CONSECUTIVE_RESULT_TEXT', isError: false },
        ],
        degraded: false,
        sessions: [{ sessionId: 'sess-conv-consecutive', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'running' }],
      };

      // A markdown heading + paragraph, to verify a multi-block text selection
      // copies trimmed - the browser's default plain-text serialization of a
      // selection spanning block elements (h2, p) leaves trailing blank lines.
      var transcriptMultiBlock = {
        sessionId: 'sess-conv-multiblock', taskId: null, taskTitle: 'Multi-block markdown',
        agentName: 'Claude Code', startedAt: ts, source: 'live', sourcePath: '/mock/multiblock.jsonl',
        entries: [
          { kind: 'assistant', uuid: 'turn-asst-multiblock', ts: nowMs, model: 'claude-opus-4-8',
            blocks: [{ type: 'text', text: '## HEADING_ALPHA\\n\\nPARAGRAPH_BODY_ALPHA.' }] },
        ],
        degraded: false,
        sessions: [{ sessionId: 'sess-conv-multiblock', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'running' }],
      };

      // Regression fixture: the window is anchored to a session that has
      // ALREADY gone 'suspended' by the time of its first fetch (an isolated
      // swimlane move suspended it), while a DIFFERENT, brand-new session for
      // the SAME task is live in the reactive session store. The live-poll
      // must keep running off that store signal, not just the anchor's own
      // (stale) sessionStatus.
      var transcriptLiveSwitchInitial = {
        sessionId: 'sess-conv-liveswitch-old', taskId: 'task-conv-liveswitch', taskTitle: 'Live session switch',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'suspended', source: 'live', sourcePath: '/mock/liveswitch-old.jsonl',
        entries: [{ kind: 'user', uuid: 'turn-liveswitch-1', ts: nowMs, text: 'LIVESWITCH_INITIAL_TEXT' }],
        degraded: false,
        sessions: [{ sessionId: 'sess-conv-liveswitch-old', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'suspended' }],
      };

      // Regression fixture: a response that (pathologically) carries a DUPLICATE
      // uuid across two entries. The backend dedups the stitched multi-session
      // timeline, but the viewer must ALSO guard against it - the uuid is the
      // React key and the virtualizer's measurement-cache key, so a duplicate
      // would otherwise pile up stale rows and stack them on top of each other.
      var transcriptDuplicateUuid = {
        sessionId: 'sess-conv-dupuuid', taskId: null, taskTitle: 'Duplicate uuid guard',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'exited', source: 'live', sourcePath: '/mock/dupuuid.jsonl',
        entries: [
          { kind: 'user', uuid: 'dup-uuid-shared', ts: nowMs, text: 'DUPUUID_FIRST' },
          { kind: 'assistant', uuid: 'dup-uuid-unique', ts: nowMs, model: 'claude-opus-4-8', blocks: [{ type: 'text', text: 'DUPUUID_MIDDLE' }] },
          // Same uuid as the first entry - must be dropped by the viewer.
          { kind: 'user', uuid: 'dup-uuid-shared', ts: nowMs, text: 'DUPUUID_REPLAY' },
        ],
        degraded: false,
        sessions: [{ sessionId: 'sess-conv-dupuuid', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' }],
      };

      // Regression fixture: a chunk that opens with a bare slash-command turn.
      // A conversation search hit anchors on the matched chunk's FIRST turn, so
      // it would land on "/code-review"; the viewer must advance the scroll to
      // the first substantive turn after it (what actually matched).
      var transcriptCommandAnchor = {
        sessionId: 'sess-conv-cmdanchor', taskId: null, taskTitle: 'Command anchor',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'exited', source: 'live', sourcePath: '/mock/cmdanchor.jsonl',
        entries: [
          { kind: 'user', uuid: 'turn-cmd', ts: nowMs, text: '/code-review' },
          { kind: 'user', uuid: 'turn-after-cmd', ts: nowMs + 1, text: 'CMDANCHOR_CONTENT' },
        ],
        degraded: false,
        sessions: [{ sessionId: 'sess-conv-cmdanchor', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' }],
      };

      // Regression fixture (Defect A): a markdown table with many columns, plus a
      // standalone long unbreakable word with no spaces or punctuation. The
      // table forces overflow via COLUMN COUNT (each column's padding + border
      // is a fixed floor no amount of text-wrapping can shrink away), not via
      // unbreakable cell text - overflow-wrap:anywhere (this fix's own
      // long-token wrap behavior) lets even a very long single-token cell wrap
      // to fit its column, so a handful of long-word columns alone would NOT
      // reliably reproduce table-level overflow. Many short columns' fixed
      // per-column chrome sums past a narrow docked panel regardless. The
      // table must be contained in its own horizontal-scroll wrapper (never
      // clip unreachably or push the panel wider); the lone word must wrap via
      // overflow-wrap instead of overflowing.
      // A generous column count (30) so the per-column padding+border floor
      // alone sums well past a narrow docked panel, with margin to spare.
      var wideColumnCount = 30;
      var wideColumnHeaders = [];
      var wideColumnCells = [];
      for (var wideColumnIndex = 1; wideColumnIndex <= wideColumnCount; wideColumnIndex += 1) {
        wideColumnHeaders.push('Col' + wideColumnIndex);
        wideColumnCells.push('Val' + wideColumnIndex);
      }
      var wideTableMarkdown = [
        '| ' + wideColumnHeaders.join(' | ') + ' |',
        '| ' + wideColumnHeaders.map(function () { return '---'; }).join(' | ') + ' |',
        '| ' + wideColumnCells.join(' | ') + ' |',
        '',
        'WidetableUnbreakableTokenThisIsADeliberatelyUnbreakableWordWithNoSpacesOrPunctuationWhatsoeverAndItKeepsGoingAndGoingUntilItIsFarWiderThanAnyReasonableDockedPanelWidthSoItMustWrapInsteadOfOverflowingThePanelBoundaryEndMarker',
      ].join('\\n');
      var transcriptWideTable = {
        sessionId: 'sess-conv-widetable', taskId: null, taskTitle: 'Wide table containment',
        agentName: 'Claude Code', startedAt: ts, source: 'live', sourcePath: '/mock/widetable.jsonl',
        entries: [
          { kind: 'assistant', uuid: 'turn-widetable', ts: nowMs, model: 'claude-opus-4-8',
            blocks: [{ type: 'text', text: wideTableMarkdown }] },
        ],
        degraded: false,
        sessions: [{ sessionId: 'sess-conv-widetable', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'running' }],
      };

      var transcriptSeeds = {};
      // Both of the task's session ids resolve to the SAME unified response -
      // the real backend always returns a task's full lifecycle regardless of
      // which of its sessions was asked for.
      transcriptSeeds['${SESSION_A}'] = transcriptUnified;
      transcriptSeeds['${SESSION_B}'] = transcriptUnified;
      transcriptSeeds['sess-conv-multiblock'] = transcriptMultiBlock;
      transcriptSeeds['sess-conv-widetable'] = transcriptWideTable;
      transcriptSeeds['sess-conv-cmdanchor'] = transcriptCommandAnchor;
      transcriptSeeds['sess-conv-dupuuid'] = transcriptDuplicateUuid;
      transcriptSeeds['sess-conv-liveswitch-old'] = transcriptLiveSwitchInitial;
      transcriptSeeds['sess-conv-consecutive'] = transcriptConsecutive;
      transcriptSeeds['sess-degraded'] = transcriptDegraded;
      transcriptSeeds['sess-empty-unsupported'] = emptyResp('sess-empty-unsupported', 'unsupported_agent');
      transcriptSeeds['sess-empty-nosession'] = emptyResp('sess-empty-nosession', 'no_agent_session_id');
      transcriptSeeds['sess-empty-missing'] = emptyResp('sess-empty-missing', 'file_missing');

      var transcriptSessionsByTask = {};
      transcriptSessionsByTask['${TASK_ID}'] = transcriptUnified.sessions;

      return {
        currentProjectId: '${PROJECT_ID}',
        searchHits: searchHits,
        transcriptSeeds: transcriptSeeds,
        transcriptSessionsByTask: transcriptSessionsByTask,
      };
    });
  `;
}

/**
 * A task + a 'running' session for it, isolated to its own init script rather
 * than folded into the shared `preConfig()` fixture: adding even a properly
 * matched extra task/session there was enough to break an unrelated test's
 * real-clipboard Ctrl+C assertion (some global app behavior reacts to board
 * composition). Kept minimal and opt-in per test via `launch()`'s
 * `extraPreConfig` param.
 */
function liveSessionPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.tasks.push({
        id: 'task-conv-liveswitch', title: 'Live session switch', description: '',
        swimlane_id: 'lane-conv-0', position: 1, agent: null, session_id: 'sess-conv-liveswitch-new',
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });
      state.sessions.push({
        id: 'sess-conv-liveswitch-new', taskId: 'task-conv-liveswitch', projectId: '${PROJECT_ID}',
        pid: 9999, status: 'running', shell: 'bash', cwd: '/mock/liveswitch-new',
        startedAt: ts, exitCode: null,
      });
      return {};
    });
  `;
}

async function launch(permissions?: string[], extraPreConfig?: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig());
  if (extraPreConfig) await page.addInitScript(extraPreConfig);
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
      // (Two user rows now: this task's unified view also includes session
      // B's own USER_QUESTION_BRAVO turn.)
      await expect(page.getByTestId('conversation-row-user').first()).toBeVisible();
      await expect(page.getByText('USER_QUESTION_ALPHA')).toBeVisible();
      await expect(page.getByTestId('conversation-row-assistant')).toBeVisible();
      await expect(page.getByText('ASSISTANT_TEXT_ALPHA')).toBeVisible();

      // The system divider and the orphan tool_result both render. (Two
      // system rows now: the compaction entry plus the session_boundary
      // divider marking the seam with session B.)
      await expect(page.getByTestId('conversation-row-system').first()).toBeVisible();
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

  test('the conversation always spans a task\'s entire lifecycle, regardless of which of its sessions is opened', async () => {
    const { browser, page } = await launch();
    try {
      // Opening the task's OLDER session (A) still shows the newer session
      // (B)'s content too - the response is never scoped to just one session.
      await openConversation(page, SESSION_A);
      await expect(page.getByText('USER_QUESTION_ALPHA')).toBeVisible();
      await expect(page.getByText('USER_QUESTION_BRAVO')).toBeVisible();

      // The session_boundary divider marks the seam between the two sessions,
      // and there is no picker to switch away from this view - which session
      // shows is not a setting.
      await expect(page.getByText('New session')).toBeVisible();
      await expect(page.getByTestId('conversation-session-picker')).toHaveCount(0);
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

  test('title-bar copy button copies the whole transcript as Markdown', async () => {
    const { browser, page } = await launch(['clipboard-read', 'clipboard-write']);
    try {
      await openConversation(page, SESSION_A);
      await expect(page.getByText('USER_QUESTION_ALPHA')).toBeVisible();

      await page.getByTestId('conversation-copy-markdown-button').click();
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toContain('USER_QUESTION_ALPHA');
      expect(clipboardText).toContain('ASSISTANT_TEXT_ALPHA');

      // Flips to a checkmark for brief confirmation, then reverts.
      await expect(page.getByTestId('conversation-copy-markdown-button').locator('.lucide-check')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('title-bar "Open task" button opens the task detail for the transcript\'s task', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, SESSION_A);
      await expect(page.getByText('USER_QUESTION_ALPHA')).toBeVisible();

      await page.getByTestId('conversation-open-task-button').click();
      await expect(page.getByTestId('task-detail-dialog')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('every assistant turn shows its own role badge, and a tool-only turn\'s message copy button includes the tool call', async () => {
    const { browser, page } = await launch(['clipboard-read', 'clipboard-write']);
    try {
      await openConversation(page, 'sess-conv-consecutive');

      // Two consecutive assistant turns (each a lone tool call, no text) both
      // show their own badge - not collapsed to "only the first in a run".
      const assistantRows = page.getByTestId('conversation-row-assistant');
      await expect(assistantRows).toHaveCount(2);
      await expect(assistantRows.getByText('Claude Code')).toHaveCount(2);

      // There is exactly one copy button per row (the message header's) - no
      // second, nested copy affordance inside the tool card itself.
      await expect(page.getByTestId('conversation-tool-copy')).toHaveCount(0);

      // The second turn is tool-only (no text block); its message-level copy
      // button must still copy something useful - the tool call itself.
      await assistantRows.nth(1).getByTestId('conversation-message-copy').click();
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toContain('**Tool:** `Read`');
      expect(clipboardText).toContain('README.md');
    } finally {
      await browser.close();
    }
  });

  test('hovering one message reveals only its own copy icon, not every message in the window', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, 'sess-conv-consecutive');

      const rows = page.getByTestId('conversation-row-assistant');
      await expect(rows).toHaveCount(2);
      const hoveredCopy = rows.nth(0).getByTestId('conversation-message-copy');
      const otherCopy = rows.nth(1).getByTestId('conversation-message-copy');

      // Regression: the conversation window's own chrome carries an unnamed
      // `.group` class (unrelated hover-reveal), which used to also satisfy an
      // unnamed `group-hover:opacity-100` on every message's copy icon - so
      // hovering ANYWHERE in the window revealed ALL of them. The fix scopes
      // the reveal to a named `group/message`, so only the hovered row's own
      // icon should show.
      await rows.nth(0).hover();
      await expect(hoveredCopy).toHaveCSS('opacity', '1');
      await expect(otherCopy).toHaveCSS('opacity', '0');
    } finally {
      await browser.close();
    }
  });

  test('selecting text across a heading and paragraph copies without trailing blank lines', async () => {
    const { browser, page } = await launch(['clipboard-read', 'clipboard-write']);
    try {
      await openConversation(page, 'sess-conv-multiblock');
      await expect(page.getByText('PARAGRAPH_BODY_ALPHA')).toBeVisible();

      // Select from the heading through the end of the paragraph - a selection
      // spanning block elements (h2, p), which is exactly what left trailing
      // blank lines before the custom copy handler trimmed them.
      await page.evaluate(() => {
        const view = document.querySelector('[data-testid="conversation-view"]');
        const heading = view?.querySelector('h2');
        const paragraph = view?.querySelector('p');
        if (!heading || !paragraph) throw new Error('heading/paragraph not found');
        const range = document.createRange();
        range.setStartBefore(heading);
        range.setEndAfter(paragraph);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await page.keyboard.press('Control+c');

      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toContain('HEADING_ALPHA');
      expect(clipboardText).toContain('PARAGRAPH_BODY_ALPHA.');
      // No run of 3+ newlines, and no trailing blank line at the very end.
      expect(clipboardText).not.toMatch(/\n{3,}/);
      expect(clipboardText).toBe(clipboardText.trim());
    } finally {
      await browser.close();
    }
  });

  test('a mousedown on conversation message text is excluded from the terminal-focus handler, but a task-detail window\'s chrome still gets it', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, SESSION_A);
      await expect(page.getByText('USER_QUESTION_ALPHA')).toBeVisible();

      // Regression: WindowFrame's onMouseDownCapture calls preventDefault() on
      // any mousedown outside .xterm/interactive controls, to focus a
      // task-detail window's terminal on background click. A conversation
      // window has no terminal - its body is read-only, selectable message
      // text - so the unconditional preventDefault was also suppressing the
      // browser's native text-selection drag before it could start.
      // `[data-testid="conversation-view"]` is now excluded the same way
      // `.xterm` is; a mousedown on its rendered text must NOT be prevented.
      const messagePrevented = await page.evaluate(() => {
        const view = document.querySelector('[data-testid="conversation-view"]');
        const paragraph = view?.querySelector('p');
        if (!paragraph) throw new Error('no <p> found inside conversation-view');
        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        paragraph.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(messagePrevented).toBe(false);

      // Scoping check: the SAME handler still prevents default elsewhere in a
      // window's chrome - a task-detail window's title bar (non-interactive,
      // non-terminal chrome, but NOT excluded like conversation-view is) -
      // proving this is a targeted exclusion, not a blanket removal of the
      // focus-terminal behavior.
      await page.getByTestId('conversation-open-task-button').click();
      await page.getByTestId('task-detail-dialog').waitFor({ state: 'visible', timeout: 3000 });
      const titlebarPrevented = await page.evaluate(() => {
        const titlebar = document.querySelector('[data-testid="task-detail-titlebar"]');
        if (!titlebar) throw new Error('task-detail-titlebar not found');
        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        titlebar.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(titlebarPrevented).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('normal-size icon-only header button renders the compact ~36x30 square; small-size renders the tighter ~26x22 variant', async () => {
    const { browser, page } = await launch();
    try {
      // "normal" (default, no `label`): the title-bar copy-as-Markdown button.
      await openConversation(page, SESSION_A);
      await expect(page.getByText('USER_QUESTION_ALPHA')).toBeVisible();
      const normalBox = await page.getByTestId('conversation-copy-markdown-button').boundingBox();
      expect(normalBox).not.toBeNull();
      // ~36x30, verified via devtools during development. Real layout, so a
      // generous tolerance rather than a pixel-exact check (cross-platform-
      // parity: font metrics/rounding differ across OSes) - no zero-tolerance
      // assertion.
      expect(normalBox!.width).toBeGreaterThan(30);
      expect(normalBox!.width).toBeLessThan(44);
      expect(normalBox!.height).toBeGreaterThan(24);
      expect(normalBox!.height).toBeLessThan(36);

      await page.getByTestId('conversation-close').click();
      await expect(page.getByTestId('conversation-window')).toHaveCount(0);

      // "small" (size="small", no `label`): a per-message copy button.
      await openConversation(page, 'sess-conv-consecutive');
      const smallBox = await page.getByTestId('conversation-message-copy').first().boundingBox();
      expect(smallBox).not.toBeNull();
      // ~26x22, same devtools-verified figure, same tolerance rationale.
      expect(smallBox!.width).toBeGreaterThan(20);
      expect(smallBox!.width).toBeLessThan(32);
      expect(smallBox!.height).toBeGreaterThan(16);
      expect(smallBox!.height).toBeLessThan(28);

      // The relative check matters more than either absolute range: "small"
      // must render visibly smaller than "normal" in both dimensions.
      expect(smallBox!.width).toBeLessThan(normalBox!.width);
      expect(smallBox!.height).toBeLessThan(normalBox!.height);
    } finally {
      await browser.close();
    }
  });

  test('live-polling continues past the anchor session going suspended, once a new session for the same task is live', async () => {
    const { browser, page } = await launch(undefined, liveSessionPreConfig());
    try {
      await openConversation(page, 'sess-conv-liveswitch-old');
      await expect(page.getByText('LIVESWITCH_INITIAL_TEXT')).toBeVisible();

      // From here on, transcripts.get returns a response with a NEW entry - the
      // same anchor session id, since the real backend always resolves by task
      // regardless of which session id was queried. The reactive session store
      // (seeded with a second, 'running' session for this task) is what should
      // keep the poll alive despite the anchor's own sessionStatus being
      // 'suspended' the whole time.
      await page.evaluate(() => {
        window.__mockTranscriptsGetOverride = (input) => {
          if (input.sessionId !== 'sess-conv-liveswitch-old') return undefined;
          return {
            sessionId: 'sess-conv-liveswitch-old',
            taskId: 'task-conv-liveswitch',
            taskTitle: 'Live session switch',
            agentName: 'Claude Code',
            startedAt: new Date().toISOString(),
            sessionStatus: 'suspended',
            source: 'live',
            sourcePath: '/mock/liveswitch-old.jsonl',
            entries: [
              { kind: 'user', uuid: 'turn-liveswitch-1', ts: Date.now(), text: 'LIVESWITCH_INITIAL_TEXT' },
              { kind: 'user', uuid: 'turn-liveswitch-2', ts: Date.now(), text: 'LIVESWITCH_NEW_SESSION_TEXT' },
            ],
            degraded: false,
            sessions: [
              { sessionId: 'sess-conv-liveswitch-old', agentName: 'Claude Code', startedAt: new Date().toISOString(), exitedAt: new Date().toISOString(), isolatedSwimlaneId: null, status: 'suspended' },
              { sessionId: 'sess-conv-liveswitch-new', agentName: 'Claude Code', startedAt: new Date().toISOString(), exitedAt: null, isolatedSwimlaneId: null, status: 'running' },
            ],
          };
        };
      });

      // The poll interval is 2500ms; a 10s timeout gives several ticks of margin.
      await expect(page.getByText('LIVESWITCH_NEW_SESSION_TEXT')).toBeVisible({ timeout: 10_000 });
    } finally {
      await browser.close();
    }
  });

  test('a live poll reporting { unchanged: true } (the IPC revision short-circuit) leaves the rendered content untouched across several ticks', async () => {
    const { browser, page } = await launch(undefined, liveSessionPreConfig());
    try {
      await openConversation(page, 'sess-conv-liveswitch-old');
      await expect(page.getByText('LIVESWITCH_INITIAL_TEXT')).toBeVisible();

      // First override call returns full content WITH an explicit revision;
      // every call after that reports unchanged for the SAME revision - the
      // shape `transcripts.get` returns once main's stitch-memo revision has
      // not moved since the caller's last-known revision.
      await page.evaluate(() => {
        (window as unknown as { __unchangedPollCallCount?: number }).__unchangedPollCallCount = 0;
        window.__mockTranscriptsGetOverride = (input) => {
          if (input.sessionId !== 'sess-conv-liveswitch-old') return undefined;
          const state = window as unknown as { __unchangedPollCallCount: number };
          state.__unchangedPollCallCount += 1;
          if (state.__unchangedPollCallCount === 1) {
            return {
              sessionId: 'sess-conv-liveswitch-old',
              taskId: 'task-conv-liveswitch',
              taskTitle: 'Live session switch',
              agentName: 'Claude Code',
              startedAt: new Date().toISOString(),
              sessionStatus: 'suspended',
              source: 'live',
              sourcePath: '/mock/liveswitch-old.jsonl',
              entries: [{ kind: 'user', uuid: 'turn-liveswitch-1', ts: Date.now(), text: 'LIVESWITCH_INITIAL_TEXT' }],
              degraded: false,
              sessions: [
                { sessionId: 'sess-conv-liveswitch-old', agentName: 'Claude Code', startedAt: new Date().toISOString(), exitedAt: new Date().toISOString(), isolatedSwimlaneId: null, status: 'suspended' },
                { sessionId: 'sess-conv-liveswitch-new', agentName: 'Claude Code', startedAt: new Date().toISOString(), exitedAt: null, isolatedSwimlaneId: null, status: 'running' },
              ],
              revision: 7,
            };
          }
          return { unchanged: true, revision: 7 };
        };
      });

      // Let several poll ticks (2500ms interval) land on the unchanged branch.
      await expect
        .poll(async () => page.evaluate(() => (window as unknown as { __unchangedPollCallCount: number }).__unchangedPollCallCount), { timeout: 12_000 })
        .toBeGreaterThanOrEqual(3);

      // The viewer never blanked, errored, or lost its content across those
      // unchanged ticks.
      await expect(page.getByText('LIVESWITCH_INITIAL_TEXT')).toBeVisible();
      await expect(page.getByTestId('conversation-view')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a duplicate uuid in the transcript is rendered once, not piled up as a stale overlapping row', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, 'sess-conv-dupuuid');
      await expect(page.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });
      // The unique middle turn confirms the view rendered.
      await expect(page.getByText('DUPUUID_MIDDLE')).toBeVisible();

      // The shared uuid appears on TWO entries in the response; the viewer must
      // render exactly one row for it (keeping the first). Without the dedup
      // guard, React would mount both under a colliding key, leaving two
      // [data-turn-uuid] nodes for the same id (the pile-up that stacks rows).
      await expect(page.locator('[data-turn-uuid="dup-uuid-shared"]')).toHaveCount(1);
      // First occurrence wins, so its text is the first one, not the replay.
      await expect(page.getByText('DUPUUID_FIRST')).toBeVisible();
      await expect(page.getByText('DUPUUID_REPLAY')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a search hit that anchors on a leading slash-command turn scrolls to the content after it, not the command', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, 'sess-conv-cmdanchor');
      await expect(page.getByText('CMDANCHOR_CONTENT')).toBeVisible();

      // Drive the scroll-to-turn signal at the COMMAND turn, as a conversation
      // search hit does when the matched chunk opens with "/code-review".
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { session: { getState: () => { setScrollToTurnUuid: (id: string) => void } } };
        }).__zustandStores;
        stores?.session.getState().setScrollToTurnUuid('turn-cmd');
      });

      // The highlight must land on the content turn AFTER the command, never on
      // the command turn itself.
      await expect
        .poll(async () => page.locator('[data-turn-uuid="turn-after-cmd"] [data-highlighted="true"]').count())
        .toBeGreaterThan(0);
      await expect(page.locator('[data-turn-uuid="turn-cmd"] [data-highlighted="true"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a wide markdown table is contained in its own scroll block, and a long unbreakable word wraps, instead of overflowing the panel', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, 'sess-conv-widetable');
      await expect(page.getByText('WidetableUnbreakableToken', { exact: false })).toBeVisible();

      // Narrow the docked window - mirrors the reported "docked next to the
      // terminal" width - so the wide table and long word would overflow
      // without containment.
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            window: {
              getState: () => {
                windows: Record<string, { id: string; kind: string }>;
                setGeometry: (id: string, geometry: { x: number; y: number; w: number; h: number }) => void;
              };
            };
          };
        }).__zustandStores;
        const windowState = stores?.window.getState();
        const conversationWindow = Object.values(windowState?.windows ?? {}).find((managedWindow) => managedWindow.kind === 'conversation');
        if (conversationWindow) {
          windowState?.setGeometry(conversationWindow.id, { x: 0.05, y: 0.05, w: 0.25, h: 0.8 });
        }
      });

      const conversationView = page.getByTestId('conversation-view');
      const wideRow = page.locator('[data-turn-uuid="turn-widetable"]');
      await expect(wideRow).toBeVisible();

      // The transcript surface itself never scrolls horizontally - wide content
      // is contained inside its own block, not the surface (a tolerance of a
      // couple pixels absorbs scrollbar/subpixel rounding, per the
      // cross-platform no-pixel-exact convention).
      await expect
        .poll(async () => conversationView.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeLessThanOrEqual(2);

      // The message row itself never grows wider than the panel (the long
      // unbreakable word wraps via overflow-wrap instead of pushing it out).
      await expect
        .poll(async () => wideRow.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeLessThanOrEqual(2);

      // The table's own wrapper is what actually contains the overflow: its
      // content is wider than its visible box, so IT is scrollable, not the panel.
      const tableScroll = page.locator('.md-table-scroll').first();
      await expect(tableScroll).toBeVisible();
      await expect
        .poll(async () => tableScroll.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

});
