/**
 * UI coverage for ConversationView's auto-follow gate (ConversationView.tsx,
 * the `isAtBottomRef` effect around line ~442-451): a live-poll transcript
 * append must NOT yank the user to the bottom when they have scrolled up to
 * read earlier context, but it MUST still follow the tail when the user is
 * already there. The two cases share one test on purpose - a fix that just
 * disables auto-follow entirely would pass the "must not yank" half but fail
 * the "still follows" half, and vice versa for a fix that ignores scroll
 * position.
 *
 * `autoFollowNewMessages` (ConversationWindow.tsx) is itself gated on
 * `!isFocused && !isHovering`, and a freshly opened window starts focused
 * (window-store.ts's `openWindow` sets `focusedWindowId` to the new window),
 * so the window is deliberately blurred via the exposed window-manager store
 * right after opening - otherwise the effect under test would never even
 * reach the `isAtBottomRef` gate. `isHovering` is plain component state that
 * only flips on a real mouse event, and this spec never moves the mouse over
 * the window, so it stays false throughout without any extra handling.
 *
 * The observable proxy for "did auto-follow fire" is the "Jump to latest"
 * pill (`conversation-jump-to-latest`, ConversationScrollbar.tsx), which
 * renders exactly when `!isScrolledToBottom(...)` - the identical predicate
 * (and identical epsilon) `isAtBottomRef` uses, per that file's own
 * "pill hides exactly when auto-follow would fire on the next append"
 * comment. That keeps the assertions independent of virtualizer overscan
 * (which row text happens to be painted), unlike asserting on the appended
 * row's text directly.
 *
 * Cross-platform: no bare waitForTimeout - every wait polls a real DOM/JS
 * condition. The two live-poll ticks (LIVE_REFRESH_MS = 2500ms in
 * ConversationWindow.tsx) push this past the UI project's default 15s
 * per-test timeout, so the test opts into `test.slow()` (see
 * changes-panel-lazy-retry.spec.ts for the same pattern/rationale).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-conv-autofollow';
const TASK_ID = 'task-conv-autofollow';
const SESSION_ID = 'sess-conv-autofollow-live';
const TASK_TITLE = 'Auto Follow Target Task';
// Comfortably past conversation-scrollbar.spec.ts's own precedent (60 filler
// rows overflow a 1920x1080 viewport) so the container is genuinely
// scrollable regardless of row-height estimation drift.
const SEED_ENTRY_COUNT = 70;

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      var nowMs = Date.now();

      state.projects.push({
        id: '${PROJECT_ID}', name: 'Auto Follow Project', path: '/mock/conv-autofollow',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-conv-autofollow-' + i, position: i, created_at: ts }));
      });

      // Filler seed content, exposed on window so the test's own poll
      // overrides can extend it without hand-duplicating 70 rows.
      var seedEntries = [];
      for (var i = 0; i < ${SEED_ENTRY_COUNT}; i++) {
        seedEntries.push({
          kind: 'user',
          uuid: 'turn-conv-autofollow-' + i,
          ts: nowMs + i,
          text: 'AUTO_FOLLOW_SEED_ROW_' + i + ' - filler text long enough to take real vertical space so the container genuinely overflows the viewport and the tail can be scrolled away from.',
        });
      }
      window.__autoFollowSeedEntries = seedEntries;

      var transcriptLive = {
        sessionId: '${SESSION_ID}', taskId: '${TASK_ID}', taskTitle: '${TASK_TITLE}',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'running',
        source: 'live', sourcePath: '/mock/conv-autofollow.jsonl',
        entries: seedEntries,
        degraded: false,
        sessions: [
          { sessionId: '${SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'running' },
        ],
      };

      var transcriptSeeds = {};
      transcriptSeeds['${SESSION_ID}'] = transcriptLive;

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
  return { browser, page };
}

/** Opens the viewer for a session via the same store signal the app's own
 *  discoverability entry points set, then blurs the window it opens - a
 *  fresh `openWindow` starts focused, and `autoFollowNewMessages` requires
 *  `!isFocused`. The blur MUST happen only after the window actually exists:
 *  `setConversationSessionId` only schedules the bridge effect that calls
 *  `openWindow` (which itself sets `focusedWindowId` to the new window),
 *  so blurring in the same tick as the open races that effect and gets
 *  silently clobbered back to focused the moment it runs. */
async function openConversationBlurred(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((sid) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setConversationSessionId: (id: string) => void } } };
    }).__zustandStores;
    stores?.session.getState().setConversationSessionId(sid);
  }, sessionId);
  await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 5000 });

  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { window: { setState: (partial: { focusedWindowId: string | null }) => void } };
    }).__zustandStores;
    stores?.window.setState({ focusedWindowId: null });
  });
}

/** Installs a `transcripts.get` override that returns the seed entries plus
 *  `extraMarkers` appended, for the given session only. Each call replaces
 *  the previous override outright (matches the live poll's own behavior of
 *  always re-fetching current state). */
async function appendLiveEntries(page: Page, sessionId: string, taskId: string, taskTitle: string, extraMarkers: string[]): Promise<void> {
  await page.evaluate(
    (params) => {
      const state = window as unknown as {
        __autoFollowSeedEntries: Array<{ kind: string; uuid: string; ts: number; text: string }>;
        __mockTranscriptsGetOverride: (input: { sessionId: string }) => unknown;
      };
      state.__mockTranscriptsGetOverride = (input) => {
        if (input.sessionId !== params.sessionId) return undefined;
        const appended = params.extraMarkers.map((marker, index) => ({
          kind: 'user',
          uuid: `turn-conv-autofollow-append-${index}-${marker}`,
          ts: Date.now() + index,
          text: marker,
        }));
        return {
          sessionId: params.sessionId,
          taskId: params.taskId,
          taskTitle: params.taskTitle,
          agentName: 'Claude Code',
          startedAt: new Date().toISOString(),
          sessionStatus: 'running',
          source: 'live',
          sourcePath: '/mock/conv-autofollow.jsonl',
          entries: state.__autoFollowSeedEntries.concat(appended),
          degraded: false,
          sessions: [
            { sessionId: params.sessionId, agentName: 'Claude Code', startedAt: new Date().toISOString(), exitedAt: null, isolatedSwimlaneId: null, status: 'running' },
          ],
        };
      };
    },
    { sessionId, taskId, taskTitle, extraMarkers },
  );
}

test.describe('Conversation auto-follow gate', () => {
  test('a live append follows the tail when at the bottom, but leaves scroll position alone when scrolled away from it', async () => {
    // Two live-poll ticks (2500ms each) push this past the UI project's
    // default 15s timeout; see the file header comment.
    test.slow();
    const { browser, page } = await launch();
    try {
      await openConversationBlurred(page, SESSION_ID);
      const targetWindow = page.getByTestId('conversation-window').filter({ hasText: TASK_TITLE });
      await expect(targetWindow.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });
      const scrollContainer = targetWindow.getByTestId('conversation-scroll-container');
      const jumpToLatestPill = targetWindow.getByTestId('conversation-jump-to-latest');

      // Mount-time settle lands the view at the tail - no pill yet. Also
      // confirms the fixture genuinely overflows (a rail-less/too-short
      // fixture would trivially satisfy "at bottom" and hide every
      // scroll-position bug this test exists to catch).
      await expect(jumpToLatestPill).toHaveCount(0);
      const scrollHeightBeforeFirstAppend = await scrollContainer.evaluate((el) => el.scrollHeight);
      const clientHeight = await scrollContainer.evaluate((el) => el.clientHeight);
      expect(scrollHeightBeforeFirstAppend).toBeGreaterThan(clientHeight);

      // --- Positive case: still at the tail, a live append must follow. ---
      await appendLiveEntries(page, SESSION_ID, TASK_ID, TASK_TITLE, ['LIVE_APPEND_MARKER_ONE']);
      await expect
        .poll(async () => scrollContainer.evaluate((el) => el.scrollHeight), { timeout: 10_000 })
        .toBeGreaterThan(scrollHeightBeforeFirstAppend);
      // Auto-follow kept the view pinned to the (new) tail - the pill never
      // appears. A guard broken by "always skip the scroll" would leave the
      // pill showing here.
      await expect(jumpToLatestPill).toHaveCount(0);

      // --- Negative case (the hole under test): scroll away from the tail,
      // then a live append must NOT yank the view back down. dispatchEvent
      // for 'scroll' runs the isAtBottomRef listener synchronously, so this
      // is deterministic - no wait needed for the ref update itself. ---
      const scrollHeightBeforeScrollAway = await scrollContainer.evaluate((el) => el.scrollHeight);
      await scrollContainer.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll'));
      });
      await expect(jumpToLatestPill).toBeVisible();

      await appendLiveEntries(page, SESSION_ID, TASK_ID, TASK_TITLE, ['LIVE_APPEND_MARKER_ONE', 'LIVE_APPEND_MARKER_TWO']);
      await expect
        .poll(async () => scrollContainer.evaluate((el) => el.scrollHeight), { timeout: 10_000 })
        .toBeGreaterThan(scrollHeightBeforeScrollAway);
      // The append landed (scrollHeight grew), but the user's scroll
      // position must be untouched - the pill must still be showing. A
      // deleted `isAtBottomRef` gate would auto-scroll to the new tail here
      // and hide the pill.
      await expect(jumpToLatestPill).toBeVisible();
      await expect(scrollContainer).toHaveJSProperty('scrollTop', 0);
    } finally {
      await browser.close();
    }
  });
});
