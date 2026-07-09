/**
 * UI tests for the conversation viewer's open-at-position behavior: with no
 * `scrollToTurnUuid` signal, the viewer opens already positioned at the
 * LATEST message (not the top, the historical default) - and an explicit
 * `scrollToTurnUuid` (the search-palette path) still wins over that default.
 *
 * The TUI-anchor-match path (pendingTuiAnchor -> a centered open) is covered
 * at the unit level by tui-anchor-match.test.ts; driving a real xterm
 * scrollback capture end-to-end is out of scope for this UI-tier spec.
 *
 * Cross-platform: no pixel assertions, no bare waitForTimeout - every check
 * polls for a condition (data attribute / testid / text) or uses Playwright's
 * built-in visibility auto-waiting.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-conv-openpos';
const TASK_ID = 'task-conv-openpos-1';
const SESSION_ID = 'sess-conv-openpos-a';
const ENTRY_COUNT = 60;

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      var nowMs = Date.now();

      state.projects.push({
        id: '${PROJECT_ID}', name: 'Open Position Project', path: '/mock/convopenpos',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-convopenpos-' + i, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${TASK_ID}', title: 'Open position fixture task', description: '',
        swimlane_id: 'lane-convopenpos-0', position: 0, agent: null, session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });

      var entries = [];
      for (var i = 0; i < ${ENTRY_COUNT}; i++) {
        entries.push({
          kind: i % 2 === 0 ? 'user' : 'assistant',
          uuid: 'turn-openpos-' + i,
          ts: nowMs + i,
          text: i % 2 === 0 ? undefined : undefined,
        });
        var entry = entries[entries.length - 1];
        if (i === 0) entry.text = 'FIRST_ENTRY_MARKER';
        else if (i === ${ENTRY_COUNT} - 1) {
          if (entry.kind === 'user') { entry.text = 'LAST_ENTRY_MARKER'; }
          else { entry.blocks = [{ type: 'text', text: 'LAST_ENTRY_MARKER' }]; delete entry.text; }
        } else if (entry.kind === 'user') {
          entry.text = 'filler user turn number ' + i;
        } else {
          entry.blocks = [{ type: 'text', text: 'filler assistant reply number ' + i }];
          delete entry.text;
        }
      }

      var transcriptSeeds = {};
      transcriptSeeds['${SESSION_ID}'] = {
        sessionId: '${SESSION_ID}', taskId: '${TASK_ID}', taskTitle: 'Open position fixture task',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'exited',
        source: 'live', sourcePath: '/mock/convopenpos.jsonl',
        entries: entries,
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

test.describe('Conversation Viewer - open-at-position', () => {
  test('opening with no scrollToTurnUuid shows the LATEST message immediately, not the top of the transcript', async () => {
    const { browser, page } = await launch();
    try {
      await page.evaluate((sid) => {
        const stores = (window as unknown as {
          __zustandStores?: { session: { getState: () => { setConversationSessionId: (id: string) => void } } };
        }).__zustandStores;
        stores?.session.getState().setConversationSessionId(sid);
      }, SESSION_ID);
      await expect(page.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });

      // The last message is visible right away, with no manual scroll.
      await expect(page.getByText('LAST_ENTRY_MARKER')).toBeVisible();
      // The first message is NOT in the initial viewport - it only exists
      // once the user scrolls up (still mounted-on-demand by the virtualizer).
      await expect(page.getByText('FIRST_ENTRY_MARKER')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('an explicit scrollToTurnUuid still wins over the default bottom-open position', async () => {
    const { browser, page } = await launch();
    try {
      await page.evaluate((sid) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            session: {
              getState: () => {
                setScrollToTurnUuid: (id: string) => void;
                setConversationSessionId: (id: string) => void;
              };
            };
          };
        }).__zustandStores;
        stores?.session.getState().setScrollToTurnUuid('turn-openpos-0');
        stores?.session.getState().setConversationSessionId(sid);
      }, SESSION_ID);
      await expect(page.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });

      // The FIRST entry (the explicit scroll target) is what's shown, not
      // the default bottom.
      await expect(page.getByText('FIRST_ENTRY_MARKER')).toBeVisible();
      await expect
        .poll(async () => page.locator('[data-turn-uuid="turn-openpos-0"] [data-highlighted="true"]').count())
        .toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});
