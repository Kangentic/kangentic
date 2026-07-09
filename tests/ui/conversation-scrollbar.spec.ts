/**
 * UI tests for the conversation viewer's custom scrollbar rail's overflow
 * detection and the row padding it drives (ConversationScrollbar.tsx's
 * `onShowRailChange` callback, consumed by ConversationView.tsx as
 * `hasScrollbar` to size each row's right padding).
 *
 * When content fits the viewport there is no rail to clear, so rows reclaim
 * the extra right-side clearance back down to the plain left-matching inset
 * (ROW_LEFT_INSET_PX). When content overflows, the rail shows and rows widen
 * their right padding to CONTENT_RIGHT_CLEARANCE_PX so the message border
 * stays evenly inset from the thumb. Both constants are exported from
 * ConversationScrollbar.tsx; the values below (12 / 23) mirror them
 * (RAIL_WIDTH_PX 14 - THUMB_MARGIN_PX 3 + ROW_LEFT_INSET_PX 12 = 23) - not a
 * pixel-exact LAYOUT assertion (font metrics, scrollbar width), since these
 * are explicit inline-style px values this component sets itself, not
 * anything the browser/OS derives from rendering.
 *
 * Cross-platform: no bare waitForTimeout - every check polls for a condition
 * (data-testid presence/count) or uses Playwright's built-in auto-waiting.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-conv-scrollbar';
const TASK_ID = 'task-conv-scrollbar-1';
const SHORT_SESSION_ID = 'sess-conv-scrollbar-short';
const LONG_SESSION_ID = 'sess-conv-scrollbar-long';
const LONG_ENTRY_COUNT = 60;

// Mirrors ConversationScrollbar.tsx's exported constants.
const ROW_LEFT_INSET_PX = 12;
const CONTENT_RIGHT_CLEARANCE_PX = 23;

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      var nowMs = Date.now();

      state.projects.push({
        id: '${PROJECT_ID}', name: 'Scrollbar Project', path: '/mock/convscrollbar',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-convscrollbar-' + i, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${TASK_ID}', title: 'Scrollbar fixture task', description: '',
        swimlane_id: 'lane-convscrollbar-0', position: 0, agent: null, session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });

      // A single short turn - well under the viewport height, so the rail
      // never shows.
      var transcriptShort = {
        sessionId: '${SHORT_SESSION_ID}', taskId: '${TASK_ID}', taskTitle: 'Scrollbar fixture task',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'exited',
        source: 'live', sourcePath: '/mock/convscrollbar-short.jsonl',
        entries: [
          { kind: 'user', uuid: 'turn-scrollbar-short', ts: nowMs, text: 'SHORT_CONTENT_MARKER' },
        ],
        degraded: false,
        sessions: [
          { sessionId: '${SHORT_SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' },
        ],
      };

      // Many short turns - well past the viewport height, so the rail shows.
      var longEntries = [];
      for (var i = 0; i < ${LONG_ENTRY_COUNT}; i++) {
        longEntries.push({
          kind: i % 2 === 0 ? 'user' : 'assistant',
          uuid: 'turn-scrollbar-long-' + i,
          ts: nowMs + i,
        });
        var entry = longEntries[longEntries.length - 1];
        if (entry.kind === 'user') {
          entry.text = 'LONG_CONTENT_MARKER filler user turn number ' + i;
        } else {
          entry.blocks = [{ type: 'text', text: 'LONG_CONTENT_MARKER filler assistant reply number ' + i }];
        }
      }
      var transcriptLong = {
        sessionId: '${LONG_SESSION_ID}', taskId: '${TASK_ID}', taskTitle: 'Scrollbar fixture task',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'exited',
        source: 'live', sourcePath: '/mock/convscrollbar-long.jsonl',
        entries: longEntries,
        degraded: false,
        sessions: [
          { sessionId: '${LONG_SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' },
        ],
      };

      var transcriptSeeds = {};
      transcriptSeeds['${SHORT_SESSION_ID}'] = transcriptShort;
      transcriptSeeds['${LONG_SESSION_ID}'] = transcriptLong;

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

async function openConversation(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((sid) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setConversationSessionId: (id: string) => void } } };
    }).__zustandStores;
    stores?.session.getState().setConversationSessionId(sid);
  }, sessionId);
  await expect(page.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });
}

test.describe('Conversation Viewer - scrollbar rail and row padding reclaim', () => {
  test('content that fits the viewport hides the rail and rows use the plain left-matching right padding', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, SHORT_SESSION_ID);
      await expect(page.getByText('SHORT_CONTENT_MARKER')).toBeVisible();

      // No rail: onShowRailChange(false) - the rendered content is far
      // shorter than the viewport.
      await expect(page.getByTestId('conversation-scrollbar-rail')).toHaveCount(0);

      // hasScrollbar stays false, so the row's right padding is reclaimed
      // back to match the left inset - not the wider scrollbar clearance.
      await expect
        .poll(async () =>
          page.getByTestId('conversation-row-gap').first().evaluate((el) => (el as HTMLElement).style.paddingRight),
        )
        .toBe(`${ROW_LEFT_INSET_PX}px`);
    } finally {
      await browser.close();
    }
  });

  test('content taller than the viewport shows the rail and rows widen their right padding to clear it', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, LONG_SESSION_ID);
      await expect(page.getByText('LONG_CONTENT_MARKER', { exact: false }).first()).toBeVisible();

      // Rail shows: onShowRailChange(true) - 60 turns overflow the viewport.
      await expect(page.getByTestId('conversation-scrollbar-rail')).toBeVisible();

      // hasScrollbar flips true, so rows widen their right padding to clear
      // the rail/thumb instead of the plain left-matching inset.
      await expect
        .poll(async () =>
          page.getByTestId('conversation-row-gap').first().evaluate((el) => (el as HTMLElement).style.paddingRight),
        )
        .toBe(`${CONTENT_RIGHT_CLEARANCE_PX}px`);
    } finally {
      await browser.close();
    }
  });
});
