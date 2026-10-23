/**
 * UI coverage for the Conversation viewer's history paging
 * (`use-conversation-paging.ts`, `conversation-paging.ts`): a transcript
 * larger than the tail the window polls loads its earlier history as the
 * reader scrolls up, keeps the reader's place while a page lands, says so when
 * a page fails, and jumps to the start, to the latest message, and to a far
 * scrollbar position.
 *
 * The fixture is one conversation of 200 turns, each 100 bytes and a minute
 * apart; the tail holds turns 150 to 199 behind a pageable notice. The mock's
 * page override answers like the worker: 40 turns before a cursor, after one,
 * or around a position. A conversation with no extents (every other spec's
 * fixture) never pages, which the last test pins.
 *
 * Cross-platform: no bare waitForTimeout; every wait polls a DOM or mock
 * condition, and the one geometry check carries a 6px tolerance (see it).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-conv-paging';
const TASK_ID = 'task-conv-paging-1';
const PAGED_SESSION_ID = 'sess-conv-paging';
const WHOLE_SESSION_ID = 'sess-conv-whole';
const CONVERSATION_ID = 'agent-conv-paging';

interface PageCall {
  conversationId: string;
  direction: 'before' | 'after' | 'around';
  cursor?: string;
  position?: number;
}

const BASE = Date.UTC(2026, 9, 1, 9, 0, 0);
const MINUTE = 60_000;
/** The first turn the tail holds; every turn before it is in a page. */
const TAIL_FROM_TURN = 150;

/** Executing from turn 5 and again from turn 160, Code Review from turn 20 in between. */
function routeColumn(swimlaneId: string, name: string, visitTurns: number[]) {
  return {
    swimlaneId, name, color: '#3b82f6', icon: null, role: null, totalMs: 0,
    visits: visitTurns.map((turn) => ({ startedAt: new Date(BASE + turn * MINUTE).toISOString(), durationMs: 0 })),
  };
}
const ROUTE = [
  routeColumn('lane-paging-executing', 'Executing', [5, 160]),
  routeColumn('lane-paging-review', 'Code Review', [20]),
];

function preConfig(): string {
  return `
    window.__mockTaskRoutes = { '${TASK_ID}': ${JSON.stringify(ROUTE)} };
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      var BASE = Date.UTC(2026, 9, 1, 9, 0, 0);
      var TURNS = 200;
      var TAIL_FROM = 150;

      state.projects.push({
        id: '${PROJECT_ID}', name: 'Paging Project', path: '/mock/convpaging',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-convpaging-' + index, position: index, created_at: ts }));
      });
      state.tasks.push({
        id: '${TASK_ID}', title: 'Paging fixture task', description: '',
        swimlane_id: 'lane-convpaging-0', position: 0, agent: null, session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });

      function turn(index) {
        return {
          kind: 'user', uuid: 'paged-turn-' + index, ts: BASE + index * 60000,
          text: 'PAGED_TURN_' + index + ' with enough words to give the row a little height',
          origin: { conversationId: '${CONVERSATION_ID}', position: index * 100 },
        };
      }
      function pageOf(from, to) {
        from = Math.max(0, from);
        to = Math.min(to, TAIL_FROM);
        var entries = [];
        for (var index = from; index < to; index++) entries.push(turn(index));
        return {
          status: 'ok', conversationId: '${CONVERSATION_ID}', sourceToken: 'jsonl:fixture',
          startCursor: 'j:' + from * 100, endCursor: 'j:' + to * 100,
          startPosition: from * 100, endPosition: to * 100, totalPosition: TURNS * 100,
          reachedStart: from === 0, reachedEnd: to >= TAIL_FROM, entries: entries,
        };
      }
      // The worker's answers: 40 turns before a cursor, after one, or around a position.
      window.__pagingAnswer = function (input) {
        if (input.conversationId !== '${CONVERSATION_ID}') return undefined;
        if (input.direction === 'before') {
          var end = Number(String(input.cursor).slice(2)) / 100;
          return pageOf(end - 40, end);
        }
        if (input.direction === 'after') {
          var start = Number(String(input.cursor).slice(2)) / 100;
          return pageOf(start, start + 40);
        }
        var at = Math.round((input.position || 0) / 100);
        var from = Math.max(0, Math.min(at - 20, TAIL_FROM - 40));
        return pageOf(from, from + 40);
      };
      window.__mockTranscriptsPageOverride = function (input) { return window.__pagingAnswer(input); };
      window.__mockTranscriptsTimelineOverride = function (input) {
        var samples = [];
        for (var index = 0; index < TURNS; index += 10) samples.push({ position: index * 100, ts: BASE + index * 60000 });
        return { status: 'ok', conversationId: input.conversationId, samples: samples };
      };

      var tail = [{
        kind: 'system', uuid: 'kangentic-truncated:${CONVERSATION_ID}:' + TAIL_FROM * 100, ts: BASE + TAIL_FROM * 60000,
        subtype: 'truncated', text: 'Earlier 14.6 KB of this conversation are not shown (the transcript is 19.5 KB).',
        earlierHistory: { conversationId: '${CONVERSATION_ID}', cursor: 'j:' + TAIL_FROM * 100, position: TAIL_FROM * 100 },
      }];
      for (var index = TAIL_FROM; index < TURNS; index++) tail.push(turn(index));

      var meta = { sessionId: '${PAGED_SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' };
      var transcriptSeeds = {};
      transcriptSeeds['${PAGED_SESSION_ID}'] = {
        sessionId: '${PAGED_SESSION_ID}', taskId: '${TASK_ID}', taskTitle: 'Paging fixture task',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'exited',
        source: 'live', sourcePath: '/mock/convpaging.jsonl', entries: tail, degraded: false, sessions: [meta],
        conversations: [{
          conversationId: '${CONVERSATION_ID}', totalPosition: TURNS * 100, tailStartPosition: TAIL_FROM * 100,
          pageable: true, hasTimestamps: true,
        }],
      };
      transcriptSeeds['${WHOLE_SESSION_ID}'] = {
        sessionId: '${WHOLE_SESSION_ID}', taskId: '${TASK_ID}', taskTitle: 'Paging fixture task',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'exited',
        source: 'live', sourcePath: '/mock/convwhole.jsonl',
        entries: [turn(0), turn(1), turn(2)], degraded: false, sessions: [meta],
      };
      return { currentProjectId: '${PROJECT_ID}', transcriptSeeds: transcriptSeeds };
    });
  `;
}

async function launch(viewport = { width: 1920, height: 1080 }): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig());
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/** Ask for the Conversation window without waiting for its view: a jump still out shows a skeleton in its place. */
async function requestConversation(page: Page, sessionId: string, tab: { swimlaneId: string } | null = null): Promise<void> {
  await page.evaluate(({ sid, request }) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setConversationSessionId: (id: string, tab?: unknown) => void } } };
    }).__zustandStores;
    stores?.session.getState().setConversationSessionId(sid, request ?? undefined);
  }, { sid: sessionId, request: tab });
  await expect(page.getByTestId('conversation-titlebar')).toBeVisible({ timeout: 5000 });
}

async function openConversation(page: Page, sessionId: string, tab: { swimlaneId: string } | null = null): Promise<void> {
  await requestConversation(page, sessionId, tab);
  await expect(page.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });
  // The window animates in, and the scrollbar moves with it: in a 2160px window the
  // settled rail sits about 9px right of where it is drawn mid-entrance. A drag measured
  // during the entrance and pressed after it (a slow worker) lands on the messages and
  // drags nothing, so wait the entrance out before any test reads the rail.
  await page.getByTestId('conversation-view').evaluate(async (element) => {
    const frame = element.closest('[data-testid^="window-frame-"]');
    await Promise.all((frame?.getAnimations() ?? []).map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** Hold every page read until the test releases it. */
async function holdPages(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as {
      __pagingAnswer: (input: unknown) => unknown;
      __mockTranscriptsPageOverride: (input: unknown) => unknown;
      __releasePage?: () => void;
    };
    host.__mockTranscriptsPageOverride = (input) => new Promise((resolve) => {
      host.__releasePage = () => resolve(host.__pagingAnswer(input));
    });
  });
}

async function pageCalls(page: Page): Promise<PageCall[]> {
  return page.evaluate(() => (window as unknown as { __mockTranscriptPageCalls?: PageCall[] }).__mockTranscriptPageCalls ?? []);
}

/** Scroll to the top as a reader would: a wheel first, which stops the
 *  opening's settle loop from putting the view back at the bottom. */
async function scrollToTop(page: Page): Promise<void> {
  await page.getByTestId('conversation-scroll-container').evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    element.scrollTop = 0;
  });
}

/** Stop the opening's settle loop the way a reader's wheel does. */
async function takeOver(page: Page): Promise<void> {
  await page.getByTestId('conversation-scroll-container').evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 0 }));
  });
}

/** The recorded page reads in one direction. */
async function pageCallsIn(page: Page, direction: PageCall['direction']): Promise<PageCall[]> {
  return (await pageCalls(page)).filter((call) => call.direction === direction);
}

async function locateCallCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __mockTranscriptLocateCalls?: unknown[] }).__mockTranscriptLocateCalls?.length ?? 0);
}

/** Open the titlebar's Actions menu and take Jump to start. */
async function jumpToStartFromMenu(page: Page): Promise<void> {
  await page.getByTestId('conversation-titlebar').getByRole('button', { name: 'Actions' }).click();
  await page.getByTestId('conversation-jump-to-start').click();
}

/** Mark the scroll container, so a remount (a new element, which a jump makes) shows. */
async function markScrollContainer(page: Page): Promise<void> {
  await page.getByTestId('conversation-scroll-container').evaluate((element) => {
    (element as HTMLElement & { __pagingMark?: boolean }).__pagingMark = true;
  });
}

/** Whether the scroll container on screen is the one `markScrollContainer` marked. */
async function scrollContainerIsMarked(page: Page): Promise<boolean> {
  return page.getByTestId('conversation-scroll-container').evaluate((element) =>
    (element as HTMLElement & { __pagingMark?: boolean }).__pagingMark === true);
}

/** The viewport top of one turn's message box, what the reader sees, or null when it is not rendered. */
async function rowTop(page: Page, index: number): Promise<number | null> {
  const row = page.locator(`[data-turn-uuid="paged-turn-${index}"]`);
  if (await row.count() === 0) return null;
  return row.evaluate((element) => (element.firstElementChild?.firstElementChild ?? element).getBoundingClientRect().top);
}

test.describe('Conversation Viewer - history paging', () => {
  test('loads one page above the tail as the reader reaches the top, and keeps the reader\'s row in place', async () => {
    const { browser, page } = await launch();
    try {
      await holdPages(page);
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await expect(page.getByPlaceholder('Search loaded messages')).toBeVisible();
      expect(await pageCalls(page)).toHaveLength(0);

      await scrollToTop(page);
      await expect(page.getByTestId('conversation-edge-top')).toContainText('Loading earlier messages');
      await expect.poll(async () => (await pageCalls(page)).length).toBe(1);
      expect((await pageCalls(page))[0]).toMatchObject({ conversationId: CONVERSATION_ID, direction: 'before', cursor: 'j:15000' });

      const before = await rowTop(page, 150);
      expect(before).not.toBeNull();
      await page.evaluate(() => (window as unknown as { __releasePage: () => void }).__releasePage());
      await expect(page.locator('[data-turn-uuid="paged-turn-149"]')).toHaveCount(1);
      // Unanchored, the row would move by the whole page (about 3,600px here).
      // Anchored, it moves by the rounding of the corrections TanStack Virtual
      // makes as it first measures each row above it: scrollTop is a whole
      // pixel at device scale 1, so up to half a pixel each for the 8 overscan
      // rows. Measured 0 to 3.75px.
      await expect.poll(async () => Math.abs(((await rowTop(page, 150)) ?? Infinity) - before!)).toBeLessThanOrEqual(6);
      // The reader is far from the new top, so no second page is asked for.
      expect(await pageCalls(page)).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  test('asks for no second page while one is still being read', async () => {
    const { browser, page } = await launch();
    try {
      await holdPages(page);
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await scrollToTop(page);
      await expect.poll(async () => (await pageCalls(page)).length).toBe(1);
      // Away from the top and back again while the first read is out.
      await page.getByTestId('conversation-scroll-container').evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
        element.scrollTop = element.scrollHeight;
      });
      await scrollToTop(page);
      await expect(page.getByTestId('conversation-edge-top')).toContainText('Loading earlier messages');
      expect(await pageCalls(page)).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  test('a search hit in unloaded history loads its page and highlights it, with one lookup', async () => {
    const { browser, page } = await launch();
    try {
      await page.evaluate(() => {
        const host = window as unknown as {
          __pagingAnswer: (input: unknown) => { status: string } & Record<string, unknown>;
          __mockTranscriptsLocateOverride: (input: { turnUuid: string }) => unknown;
        };
        host.__mockTranscriptsLocateOverride = () => {
          const { status: _status, ...found } = host.__pagingAnswer({ conversationId: 'agent-conv-paging', direction: 'around', position: 3000 });
          return { status: 'found', page: found };
        };
        const stores = (window as unknown as {
          __zustandStores: { session: { getState: () => { setScrollToTurnUuid: (uuid: string | null) => void } } };
        }).__zustandStores;
        stores.session.getState().setScrollToTurnUuid('paged-turn-30');
      });
      await openConversation(page, PAGED_SESSION_ID);
      await expect.poll(async () => page.locator('[data-turn-uuid="paged-turn-30"] [data-highlighted="true"]').count())
        .toBeGreaterThan(0);
      const locateCalls = await page.evaluate(() => (window as unknown as { __mockTranscriptLocateCalls?: unknown[] }).__mockTranscriptLocateCalls ?? []);
      expect(locateCalls).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  test('a column tab whose first stay is not loaded loads it and opens there, reading around the stay once', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, PAGED_SESSION_ID, { swimlaneId: 'lane-paging-executing' });
      await expect(page.getByText('PAGED_TURN_5 ', { exact: false })).toBeVisible();
      await expect(page.getByTestId('conversation-row-route-divider').first()).toBeVisible();
      // The time between the stays is another column's, so nothing more is read.
      await expect(page.getByTestId('conversation-edge-top')).toHaveCount(0);
      const calls = await pageCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ direction: 'around' });
      expect(calls[0].position).toBeLessThan(1500);
    } finally {
      await browser.close();
    }
  });

  test('a column tab whose timeline the worker could not answer yet asks again soon and still opens at its stay', async () => {
    const { browser, page } = await launch();
    try {
      // The first timeline call finds the worker restarting; the next one answers.
      await page.evaluate(() => {
        const host = window as unknown as {
          __mockTranscriptsTimelineOverride: (input: unknown) => unknown;
          __timelineCalls?: number;
        };
        const answer = host.__mockTranscriptsTimelineOverride;
        host.__timelineCalls = 0;
        host.__mockTranscriptsTimelineOverride = (input) => {
          host.__timelineCalls = (host.__timelineCalls ?? 0) + 1;
          return host.__timelineCalls === 1 ? { status: 'unavailable', reason: 'worker_unavailable' } : answer(input);
        };
      });
      await openConversation(page, PAGED_SESSION_ID, { swimlaneId: 'lane-paging-executing' });
      await expect(page.getByText('PAGED_TURN_5 ', { exact: false })).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __timelineCalls?: number }).__timelineCalls)).toBe(2);
      const calls = await pageCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0].position).toBeLessThan(1500);
    } finally {
      await browser.close();
    }
  });

  test('says when a page failed, and Retry loads it', async () => {
    const { browser, page } = await launch();
    try {
      await page.evaluate(() => {
        (window as unknown as { __mockTranscriptsPageOverride: () => unknown }).__mockTranscriptsPageOverride = () => ({
          status: 'unavailable', reason: 'read_failed',
        });
      });
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await scrollToTop(page);
      await expect(page.getByTestId('conversation-edge-top')).toContainText("Couldn't load earlier messages");

      await page.evaluate(() => {
        const host = window as unknown as { __pagingAnswer: (input: unknown) => unknown; __mockTranscriptsPageOverride: (input: unknown) => unknown };
        host.__mockTranscriptsPageOverride = (input) => host.__pagingAnswer(input);
      });
      await page.getByTestId('conversation-edge-top-retry').click();
      await expect(page.locator('[data-turn-uuid="paged-turn-149"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('an edge read the worker was too busy for is asked again after a wait, and shows no failure meanwhile', async () => {
    // Two busy answers cost two BUSY_RETRY_MS waits (1s each) of the product's own timer.
    test.slow();
    const { browser, page } = await launch();
    try {
      // The first two reads above the tail find the worker's queue full; the third is held.
      await page.evaluate(() => {
        const host = window as unknown as {
          __pagingAnswer: (input: unknown) => unknown;
          __mockTranscriptsPageOverride: (input: { direction: string }) => unknown;
          __releasePage?: () => void;
        };
        let readsAbove = 0;
        host.__mockTranscriptsPageOverride = (input) => {
          if (input.direction !== 'before') return host.__pagingAnswer(input);
          readsAbove += 1;
          if (readsAbove <= 2) return { status: 'busy' };
          return new Promise((resolve) => {
            host.__releasePage = () => resolve(host.__pagingAnswer(input));
          });
        };
      });
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await scrollToTop(page);

      // The third read going out means the first two busy answers were waited out and asked again.
      await expect.poll(async () => page.evaluate(() => typeof (window as unknown as { __releasePage?: () => void }).__releasePage),
        { timeout: 10_000 }).toBe('function');
      expect((await pageCallsIn(page, 'before')).length).toBeGreaterThanOrEqual(3);
      // It is still a read in progress, not a failure to retry by hand.
      await expect(page.getByTestId('conversation-edge-top')).toContainText('Loading earlier messages');
      await expect(page.getByTestId('conversation-edge-top-retry')).toHaveCount(0);

      await page.evaluate(() => (window as unknown as { __releasePage: () => void }).__releasePage());
      await expect(page.locator('[data-turn-uuid="paged-turn-149"]')).toHaveCount(1);
      await expect(page.getByTestId('conversation-edge-top-retry')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('an edge read answered reset, the source rewritten, drops the loaded pages and returns to the tail', async () => {
    const { browser, page } = await launch();
    try {
      // The first read above the tail lands a page; the second finds the source rewritten.
      await page.evaluate(() => {
        const host = window as unknown as {
          __pagingAnswer: (input: unknown) => unknown;
          __mockTranscriptsPageOverride: (input: { direction: string }) => unknown;
        };
        let readsAbove = 0;
        host.__mockTranscriptsPageOverride = (input) => {
          if (input.direction !== 'before') return host.__pagingAnswer(input);
          readsAbove += 1;
          return readsAbove === 2 ? { status: 'reset', conversationId: 'agent-conv-paging' } : host.__pagingAnswer(input);
        };
      });
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await scrollToTop(page);
      await expect(page.locator('[data-turn-uuid="paged-turn-149"]')).toHaveCount(1);
      await markScrollContainer(page);

      // Back at the top of what is loaded now, the next read is the one answered reset.
      await scrollToTop(page);
      await expect.poll(async () => (await pageCallsIn(page, 'before')).length).toBe(2);
      expect((await pageCallsIn(page, 'before'))[1].cursor).toBe('j:11000');
      // The view is a new one, open at the tail. (Not "turn 149 is gone": a
      // virtualized list holds no row far from the reader whatever it loaded.)
      await expect.poll(async () => scrollContainerIsMarked(page)).toBe(false);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeInViewport();
      // A reset is not a failure: no error row, and the usual loading row above the tail is back.
      await expect(page.getByTestId('conversation-edge-top-retry')).toHaveCount(0);
      await expect(page.getByTestId('conversation-edge-top')).toContainText('Loading earlier messages');

      // The loaded page went with the reset: reaching the top again reads from the tail's cursor, not the dropped page's.
      await scrollToTop(page);
      await expect.poll(async () => (await pageCallsIn(page, 'before')).length).toBe(3);
      expect((await pageCallsIn(page, 'before'))[2].cursor).toBe('j:15000');
    } finally {
      await browser.close();
    }
  });

  test('Jump to start opens at the first turn, and Jump to latest goes back to the tail', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();

      await page.getByTestId('conversation-titlebar').getByRole('button', { name: 'Actions' }).click();
      await page.getByTestId('conversation-jump-to-start').click();
      await expect(page.getByText('PAGED_TURN_0 ', { exact: false })).toBeVisible();
      expect(await pageCalls(page)).toContainEqual(expect.objectContaining({ direction: 'around', position: 0 }));
      await expect(page.getByTestId('conversation-edge-top')).toHaveCount(0);
      await expect(page.getByTestId('conversation-edge-bottom')).toHaveCount(1);

      // The window stops short of the newest message, so Jump to latest shows.
      await page.getByTestId('conversation-jump-to-latest').click();
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await expect(page.getByTestId('conversation-edge-bottom')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a Jump to start taken while a search hit is still being looked up settles the lookup, so the skeleton goes', async () => {
    const { browser, page } = await launch();
    try {
      // A hit in history that neither the start page (turns 0 to 39) nor the
      // tail holds, with its lookup held until the test lets it answer.
      await page.evaluate(() => {
        const host = window as unknown as {
          __pagingAnswer: (input: unknown) => { status: string } & Record<string, unknown>;
          __mockTranscriptsLocateOverride: (input: unknown) => unknown;
          __releaseLocate?: () => void;
        };
        host.__mockTranscriptsLocateOverride = () => new Promise((resolve) => {
          host.__releaseLocate = () => {
            const { status: _status, ...found } = host.__pagingAnswer({ conversationId: 'agent-conv-paging', direction: 'around', position: 10000 });
            resolve({ status: 'found', page: found });
          };
        });
        const stores = (window as unknown as {
          __zustandStores: { session: { getState: () => { setScrollToTurnUuid: (uuid: string | null) => void } } };
        }).__zustandStores;
        stores.session.getState().setScrollToTurnUuid('paged-turn-100');
      });
      await requestConversation(page, PAGED_SESSION_ID);
      await expect(page.getByTestId('conversation-skeleton')).toBeVisible();
      await expect.poll(async () => locateCallCount(page)).toBe(1);
      // The skeleton stands in for the whole view, and the Jump to latest pill lives in the view.
      await expect(page.getByTestId('conversation-jump-to-latest')).toHaveCount(0);

      await jumpToStartFromMenu(page);
      // The lookup is still out: the jump alone settles it.
      await expect(page.getByText('PAGED_TURN_0 ', { exact: false })).toBeVisible();
      await expect(page.getByTestId('conversation-skeleton')).toHaveCount(0);

      // The lookup answers late and changes nothing. A new view would be a new
      // element, and it cannot be polled for: this is an intentional point read.
      await markScrollContainer(page);
      await page.evaluate(() => (window as unknown as { __releaseLocate?: () => void }).__releaseLocate?.());
      await expect(page.getByText('PAGED_TURN_0 ', { exact: false })).toBeVisible();
      expect(await scrollContainerIsMarked(page)).toBe(true);
      expect(await locateCallCount(page)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('a Jump to start with the start already loaded settles a lookup the same way, with no new read', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      // The first jump loads the start (turns 0 to 39), so position 0 is held from here on.
      await jumpToStartFromMenu(page);
      await expect(page.getByText('PAGED_TURN_0 ', { exact: false })).toBeVisible();

      // A hit in history neither the start page nor the tail holds: its lookup is held.
      await page.evaluate(() => {
        const host = window as unknown as {
          __pagingAnswer: (input: unknown) => { status: string } & Record<string, unknown>;
          __mockTranscriptsLocateOverride: (input: unknown) => unknown;
          __releaseLocate?: () => void;
        };
        host.__mockTranscriptsLocateOverride = () => new Promise((resolve) => {
          host.__releaseLocate = () => {
            const { status: _status, ...found } = host.__pagingAnswer({ conversationId: 'agent-conv-paging', direction: 'around', position: 10000 });
            resolve({ status: 'found', page: found });
          };
        });
        const stores = (window as unknown as {
          __zustandStores: { session: { getState: () => { setScrollToTurnUuid: (uuid: string | null) => void } } };
        }).__zustandStores;
        stores.session.getState().setScrollToTurnUuid('paged-turn-100');
      });
      await expect(page.getByTestId('conversation-skeleton')).toBeVisible();
      await expect.poll(async () => locateCallCount(page)).toBe(1);

      // Position 0 is held, so there is nothing to read: the jump re-opens the start on what is loaded.
      const aroundBefore = (await pageCallsIn(page, 'around')).length;
      await jumpToStartFromMenu(page);
      await expect(page.getByText('PAGED_TURN_0 ', { exact: false })).toBeVisible();
      await expect(page.getByTestId('conversation-skeleton')).toHaveCount(0);
      expect((await pageCallsIn(page, 'around')).length).toBe(aroundBefore);

      // Let the held lookup go, so nothing is left pending when the page closes.
      await page.evaluate(() => (window as unknown as { __releaseLocate?: () => void }).__releaseLocate?.());
    } finally {
      await browser.close();
    }
  });

  test('a Jump to start taken while a column tab still owes its opening stay settles it, so the skeleton goes', async () => {
    const { browser, page } = await launch();
    try {
      // The read around the tab's first stay is held; every read after it answers.
      await page.evaluate(() => {
        const host = window as unknown as {
          __pagingAnswer: (input: unknown) => unknown;
          __mockTranscriptsPageOverride: (input: unknown) => unknown;
          __releaseOwedRead?: () => void;
        };
        let holdFirstRead = true;
        host.__mockTranscriptsPageOverride = (input) => {
          if (!holdFirstRead) return host.__pagingAnswer(input);
          holdFirstRead = false;
          return new Promise((resolve) => {
            host.__releaseOwedRead = () => resolve(host.__pagingAnswer(input));
          });
        };
      });
      await requestConversation(page, PAGED_SESSION_ID, { swimlaneId: 'lane-paging-executing' });
      await expect.poll(async () => (await pageCalls(page)).length).toBe(1);
      await expect(page.getByTestId('conversation-skeleton')).toBeVisible();

      await jumpToStartFromMenu(page);
      // The stay's read is still out: the jump alone settles what it owed.
      await expect(page.getByText('PAGED_TURN_5 ', { exact: false })).toBeVisible();
      await expect(page.getByTestId('conversation-skeleton')).toHaveCount(0);

      // The held read answers late: its page is not wanted, so the view is the one already on screen.
      await markScrollContainer(page);
      await page.evaluate(() => (window as unknown as { __releaseOwedRead?: () => void }).__releaseOwedRead?.());
      await expect(page.getByText('PAGED_TURN_5 ', { exact: false })).toBeVisible();
      await expect(page.getByTestId('conversation-skeleton')).toHaveCount(0);
      expect(await scrollContainerIsMarked(page)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('a far scrollbar drag that rests loads the page there under the held pointer, with the view still mounted', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await takeOver(page);
      // The thumb covers the whole transcript: the tail is a quarter of it.
      const rail = page.getByTestId('conversation-scrollbar-rail');
      await expect(rail).toBeVisible();
      const thumbBox = await page.getByTestId('conversation-scrollbar-thumb').boundingBox();
      const railBox = await rail.boundingBox();
      expect(thumbBox && railBox).toBeTruthy();
      expect(thumbBox!.y - railBox!.y).toBeGreaterThan(railBox!.height * 0.5);
      // Marks the scroll container, so a remount (a new element) shows.
      await page.getByTestId('conversation-scroll-container').evaluate((element) => {
        (element as HTMLElement & { __pagingMark?: boolean }).__pagingMark = true;
      });

      const startX = thumbBox!.x + thumbBox!.width / 2;
      await page.mouse.move(startX, thumbBox!.y + thumbBox!.height / 2);
      await page.mouse.down();
      // One move to a quarter of the way down the rail: turn 50 or so, far
      // from the tail. (A slow drag through these small pages keeps the
      // loaded rows up with the thumb, which is a near drag.)
      await page.mouse.move(startX, railBox!.y + railBox!.height * 0.25);
      await expect(page.getByTestId('conversation-skeleton')).toBeVisible();
      await expect(page.getByTestId('conversation-scrollbar-bubble')).toBeVisible();

      // The pointer rests and stays down: the page is read and its rows show.
      await expect.poll(async () => (await pageCalls(page)).filter((call) => call.direction === 'around').length).toBe(1);
      const around = (await pageCalls(page)).find((call) => call.direction === 'around');
      expect(around!.position).toBeGreaterThan(2000);
      expect(around!.position).toBeLessThan(10000);
      await expect(page.getByTestId('conversation-skeleton')).toHaveCount(0);
      const shownTurns = await page.locator('[data-turn-uuid^="paged-turn-"]').evaluateAll((rows) => rows
        .map((row) => Number(row.getAttribute('data-turn-uuid')!.slice('paged-turn-'.length))));
      expect(shownTurns.length).toBeGreaterThan(0);
      expect(Math.min(...shownTurns)).toBeLessThan(TAIL_FROM_TURN);
      expect(await page.getByTestId('conversation-scroll-container').evaluate((element) =>
        (element as HTMLElement & { __pagingMark?: boolean }).__pagingMark === true)).toBe(true);

      await page.mouse.up();
      expect((await pageCalls(page)).filter((call) => call.direction === 'around')).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  test('a far drag whose read failed asks once more while the pointer rests', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await takeOver(page);
      // The first read around a position fails; every read after it answers.
      await page.evaluate(() => {
        const host = window as unknown as {
          __pagingAnswer: (input: { direction: string }) => unknown;
          __mockTranscriptsPageOverride: (input: { direction: string }) => unknown;
        };
        let failedOnce = false;
        host.__mockTranscriptsPageOverride = (input) => {
          if (input.direction === 'around' && !failedOnce) {
            failedOnce = true;
            return { status: 'unavailable', reason: 'read_failed' };
          }
          return host.__pagingAnswer(input);
        };
      });
      const rail = page.getByTestId('conversation-scrollbar-rail');
      const thumbBox = await page.getByTestId('conversation-scrollbar-thumb').boundingBox();
      const railBox = await rail.boundingBox();
      expect(thumbBox && railBox).toBeTruthy();
      const startX = thumbBox!.x + thumbBox!.width / 2;
      await page.mouse.move(startX, thumbBox!.y + thumbBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(startX, railBox!.y + railBox!.height * 0.25);

      // No move after the failure: the drag asks again by itself and the rows show.
      await expect.poll(async () => (await pageCalls(page)).filter((call) => call.direction === 'around').length).toBe(2);
      await expect(page.getByTestId('conversation-skeleton')).toHaveCount(0);
      const shownTurns = await page.locator('[data-turn-uuid^="paged-turn-"]').evaluateAll((rows) => rows
        .map((row) => Number(row.getAttribute('data-turn-uuid')!.slice('paged-turn-'.length))));
      expect(Math.min(...shownTurns)).toBeLessThan(TAIL_FROM_TURN);
      await page.mouse.up();
      expect((await pageCalls(page)).filter((call) => call.direction === 'around')).toHaveLength(2);
    } finally {
      await browser.close();
    }
  });

  test('each far drag gets its own retry for a read that keeps failing, not just the first drag', async () => {
    // Each held drag waits out FAR_RETRY_MS (1s) of the product's own timer for its retry.
    test.slow();
    const { browser, page } = await launch();
    try {
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await takeOver(page);
      // Every read around a position fails, so a drag that asks again is seen asking.
      await page.evaluate(() => {
        const host = window as unknown as {
          __pagingAnswer: (input: { direction: string }) => unknown;
          __mockTranscriptsPageOverride: (input: { direction: string }) => unknown;
        };
        host.__mockTranscriptsPageOverride = (input) => input.direction === 'around'
          ? { status: 'unavailable', reason: 'read_failed' }
          : host.__pagingAnswer(input);
      });
      const rail = page.getByTestId('conversation-scrollbar-rail');
      const thumb = page.getByTestId('conversation-scrollbar-thumb');
      const skeleton = page.getByTestId('conversation-skeleton');

      /** Press the thumb and hold past the rail's top end: the same logical position every drag. */
      async function pressAtTrackTop(): Promise<void> {
        const thumbBox = await thumb.boundingBox();
        const railBox = await rail.boundingBox();
        expect(thumbBox && railBox).toBeTruthy();
        const startX = thumbBox!.x + thumbBox!.width / 2;
        await page.mouse.move(startX, thumbBox!.y + thumbBox!.height / 2);
        await page.mouse.down();
        await page.mouse.move(startX, railBox!.y - 10);
      }

      // First drag: the rest asks, the failure is asked again once, then the release asks.
      await pressAtTrackTop();
      await expect.poll(async () => (await pageCallsIn(page, 'around')).length, { timeout: 8000 }).toBe(2);
      await page.mouse.up();
      await expect.poll(async () => (await pageCallsIn(page, 'around')).length, { timeout: 8000 }).toBe(3);
      // The failed release lets the placeholders go, and the thumb is back where the rows are.
      await expect(skeleton).toHaveCount(0);

      // Second drag to the same end of the track: its read fails again, and it gets its own retry.
      const callsBefore = (await pageCallsIn(page, 'around')).length;
      await pressAtTrackTop();
      await expect.poll(async () => (await pageCallsIn(page, 'around')).length, { timeout: 8000 }).toBe(callsBefore + 2);
      // Same position every time, so the retry is not a matter of two drags landing on different ones.
      const positions = (await pageCallsIn(page, 'around')).map((call) => call.position);
      expect(new Set(positions).size).toBe(1);
      await page.mouse.up();
    } finally {
      await browser.close();
    }
  });

  test('a far drag let go before its page lands holds the placeholders until it does', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await takeOver(page);
      await holdPages(page);
      const rail = page.getByTestId('conversation-scrollbar-rail');
      const thumbBox = await page.getByTestId('conversation-scrollbar-thumb').boundingBox();
      const railBox = await rail.boundingBox();
      expect(thumbBox && railBox).toBeTruthy();
      const startX = thumbBox!.x + thumbBox!.width / 2;
      await page.mouse.move(startX, thumbBox!.y + thumbBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(startX, railBox!.y + railBox!.height * 0.25);
      await page.mouse.up();

      // The page is still on its way: the placeholders stay up, not the old rows.
      await expect.poll(async () => (await pageCalls(page)).filter((call) => call.direction === 'around').length).toBe(1);
      await expect(page.getByTestId('conversation-skeleton')).toBeVisible();
      await page.evaluate(() => (window as unknown as { __releasePage?: () => void }).__releasePage?.());
      await expect(page.getByTestId('conversation-skeleton')).toHaveCount(0);
      const shownTurns = await page.locator('[data-turn-uuid^="paged-turn-"]').evaluateAll((rows) => rows
        .map((row) => Number(row.getAttribute('data-turn-uuid')!.slice('paged-turn-'.length))));
      expect(Math.min(...shownTurns)).toBeLessThan(TAIL_FROM_TURN);
      expect((await pageCalls(page)).filter((call) => call.direction === 'around')).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  test('the placeholders under a far drag fill a tall window to its bottom', async () => {
    const { browser, page } = await launch({ width: 1920, height: 2160 });
    try {
      await openConversation(page, PAGED_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_199', { exact: false })).toBeVisible();
      await takeOver(page);
      await holdPages(page);
      const rail = page.getByTestId('conversation-scrollbar-rail');
      const thumbBox = await page.getByTestId('conversation-scrollbar-thumb').boundingBox();
      const railBox = await rail.boundingBox();
      expect(thumbBox && railBox).toBeTruthy();
      const startX = thumbBox!.x + thumbBox!.width / 2;
      await page.mouse.move(startX, thumbBox!.y + thumbBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(startX, railBox!.y + railBox!.height * 0.25);
      const skeleton = page.getByTestId('conversation-skeleton');
      await expect(skeleton).toBeVisible();
      const fill = await skeleton.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const last = element.lastElementChild!.getBoundingClientRect();
        return { height: box.height, gapBelow: box.bottom - last.bottom };
      });
      // Taller than the fixed set of seven boxes the skeleton used to draw, so
      // the check below is not met by a short window.
      expect(fill.height).toBeGreaterThan(900);
      expect(fill.gapBelow).toBeLessThanOrEqual(0);
      await page.mouse.up();
    } finally {
      await browser.close();
    }
  });

  test('a conversation the tail holds whole never pages', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, WHOLE_SESSION_ID);
      await expect(page.getByText('PAGED_TURN_2', { exact: false })).toBeVisible();
      await expect(page.getByTestId('conversation-edge-top')).toHaveCount(0);
      await expect(page.getByPlaceholder('Search this conversation')).toBeVisible();
      await scrollToTop(page);
      expect(await pageCalls(page)).toHaveLength(0);
      await page.getByTestId('conversation-titlebar').getByRole('button', { name: 'Actions' }).click();
      await expect(page.getByTestId('conversation-jump-to-start')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
