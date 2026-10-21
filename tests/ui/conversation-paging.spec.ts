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
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-convpaging-' + i, position: i, created_at: ts }));
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

async function openConversation(page: Page, sessionId: string, tab: { swimlaneId: string } | null = null): Promise<void> {
  await page.evaluate(({ sid, request }) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setConversationSessionId: (id: string, tab?: unknown) => void } } };
    }).__zustandStores;
    stores?.session.getState().setConversationSessionId(sid, request ?? undefined);
  }, { sid: sessionId, request: tab });
  await expect(page.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });
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
