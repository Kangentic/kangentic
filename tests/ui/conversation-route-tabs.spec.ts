/**
 * UI tests for the conversation window's Route tabs: All plus one tab per
 * column the task worked in, each tab its own slice of the conversation
 * (`route-slice.ts`), with dividers, a scoped search and Copy, an empty column,
 * the open-on-a-tab request a Route pill sends, and the tab row's fit.
 *
 * The route comes from `sessions.getTaskRoute`, which the mock answers from
 * `window.__mockTaskRoutes`. The window is opened through the same store signal
 * the app's entry points set. Every wait polls a condition; no pixel geometry.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, settleFrames } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-route-tabs';
const TASK_ID = 'task-route-tabs';
const SESSION_ID = 'sess-route-tabs';
const MINUTE = 60_000;
/** The first logged move; every timestamp below is minutes from it. */
const T0 = Date.parse('2026-10-20T17:51:00.000Z');
const iso = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

function routeColumn(swimlaneId: string, name: string, color: string, visitStarts: number[]) {
  return {
    swimlaneId, name, color, icon: null, role: null, totalMs: 0,
    visits: visitStarts.map((minutes) => ({ startedAt: iso(minutes), durationMs: 0 })),
  };
}

/** Executing twice (back after review), Code Review once, Merge with no turns. */
const ROUTE = [
  routeColumn('lane-executing', 'Executing', '#3b82f6', [0, 30]),
  routeColumn('lane-review', 'Code Review', '#f59e0b', [20]),
  routeColumn('lane-merge', 'Merge', '#f97316', [50]),
];

/**
 * Each of `isolatedSwimlaneIds` adds a session to the conversation, the one an
 * isolated column ran, the way the stitched transcript lists it.
 */
function preConfig(route: object[], isolatedSwimlaneIds: string[]): string {
  const isolatedSession = isolatedSwimlaneIds
    .map((isolatedSwimlaneId, index) => `, { sessionId: '${SESSION_ID}-isolated-${index}', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: '${isolatedSwimlaneId}', status: 'exited' }`)
    .join('');
  return `
    window.__mockTaskRoutes = { '${TASK_ID}': ${JSON.stringify(route)} };
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      var at = function (minutes) { return ${T0} + minutes * ${MINUTE}; };
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Route Tabs', path: '/mock/route-tabs',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        state.swimlanes.push(Object.assign({}, lane, { id: 'lane-route-tabs-' + index, position: index, created_at: ts }));
      });
      state.tasks.push({
        id: '${TASK_ID}', title: 'Keep animations running', description: '',
        swimlane_id: 'lane-route-tabs-0', position: 0, agent: null, session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });
      var transcript = {
        sessionId: '${SESSION_ID}', taskId: '${TASK_ID}', taskTitle: 'Keep animations running',
        agentName: 'Claude Code', startedAt: ts, sessionStatus: 'exited', source: 'live', sourcePath: '/mock/route-tabs.jsonl',
        entries: [
          { kind: 'user', uuid: 'turn-before-log', ts: at(-5), text: 'BEFORE_THE_LOG' },
          { kind: 'assistant', uuid: 'turn-exec-one', ts: at(1), model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'EXEC_ONE' }] },
          { kind: 'system', uuid: 'boundary-review', ts: at(21), subtype: 'session_boundary', text: 'New session' },
          { kind: 'assistant', uuid: 'turn-review-one', ts: at(21), model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'REVIEW_ONE' }] },
          { kind: 'assistant', uuid: 'turn-exec-two', ts: at(31), model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'EXEC_TWO' }] },
        ],
        degraded: false,
        sessions: [{ sessionId: '${SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: ts, isolatedSwimlaneId: null, status: 'exited' }${isolatedSession}],
      };
      var seeds = {};
      seeds['${SESSION_ID}'] = transcript;
      var sessionsByTask = {};
      sessionsByTask['${TASK_ID}'] = transcript.sessions;
      return { currentProjectId: '${PROJECT_ID}', transcriptSeeds: seeds, transcriptSessionsByTask: sessionsByTask };
    });
  `;
}

async function launch(
  route: object[] = ROUTE,
  options: { viewport?: { width: number; height: number }; permissions?: string[]; isolatedSwimlaneIds?: string[] } = {},
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1920, height: 1080 }, permissions: options.permissions });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(route, options.isolatedSwimlaneIds ?? []));
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/** Open (or re-aim) the conversation window the way the app's entry points do. */
async function openConversation(page: Page, tab: { swimlaneId: string | null; visitStartedAt?: string } | null = null): Promise<void> {
  await page.evaluate(({ sessionId, request }) => {
    const stores = (window as unknown as {
      __zustandStores: { session: { getState: () => { setConversationSessionId: (id: string, tab?: unknown) => void } } };
    }).__zustandStores;
    stores.session.getState().setConversationSessionId(sessionId, request);
  }, { sessionId: SESSION_ID, request: tab });
  await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 5000 });
}

const tabRow = (page: Page) => page.getByTestId('conversation-route-tabs');
const tab = (page: Page, id: string) => page.getByTestId(`conversation-route-tabs-${id}`);
const dividers = (page: Page) => page.getByTestId('conversation-row-route-divider');

/** From here on every `sessions.getTaskRoute` rejects, and each rejection is counted. */
async function failTaskRouteReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as {
      __failedRouteReads: number;
      electronAPI: { sessions: { getTaskRoute: () => Promise<never> } };
    };
    scope.__failedRouteReads = 0;
    scope.electronAPI.sessions.getTaskRoute = async () => {
      scope.__failedRouteReads += 1;
      throw new Error('mock route read failure');
    };
  });
}

const failedRouteReads = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __failedRouteReads: number }).__failedRouteReads);

/** Count every open of the conversation viewer: the bridge reports one each time it runs an open request. */
async function countViewerOpens(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as {
      __viewerOpens: number;
      electronAPI: { analytics: { trackFeatureUsed: (feature: string) => unknown } };
    };
    scope.__viewerOpens = 0;
    const analytics = scope.electronAPI.analytics;
    const original = analytics.trackFeatureUsed.bind(analytics);
    analytics.trackFeatureUsed = (feature) => {
      if (feature === 'conversation_viewer') scope.__viewerOpens += 1;
      return original(feature);
    };
  });
}

const viewerOpens = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __viewerOpens: number }).__viewerOpens);

/**
 * The width the row's tabs take, All included, in layout pixels (`offset*`), the
 * unit the tab row itself compares. A bounding box would be wrong: the window
 * frame is scaled while it animates in, which shrinks a box but not these widths.
 */
const tabsSpan = (page: Page): Promise<number> => page.evaluate(() => {
  const tabs = [...document.querySelectorAll<HTMLElement>('[data-testid="conversation-route-tabs"] [role="tab"]')];
  const first = tabs[0];
  const last = tabs[tabs.length - 1];
  return last.offsetLeft + last.offsetWidth - first.offsetLeft;
});

/**
 * Hands the page a way to set the tablist's own width through its row, so the
 * widths a test picks do not depend on how wide the window is. The row is first
 * given room (3000px) and the list's padding is read from layout pixels there.
 */
async function installListWidthSetter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as { __setListWidth: (width: number) => number };
    const row = document.querySelector<HTMLElement>('[data-testid="conversation-route-tabs"]')!;
    const tablist = row.querySelector<HTMLElement>('[role="tablist"]')!;
    row.style.width = '3000px';
    const padding = row.offsetWidth - tablist.clientWidth;
    scope.__setListWidth = (width) => {
      row.style.width = `${width + padding}px`;
      return tablist.clientWidth;
    };
  });
}

/** Sets the tablist's width and returns the width it ended up with. */
const setListWidth = (page: Page, width: number): Promise<number> =>
  page.evaluate((target) => (window as unknown as { __setListWidth: (value: number) => number }).__setListWidth(target), width);

test.describe('Conversation window Route tabs', () => {
  test('a Route of two or more columns shows All and then each column, in route order', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);
      await expect(tabRow(page).getByRole('tab')).toHaveText(['All', 'Executing', 'Code Review', 'Merge']);
      await expect(tab(page, 'all')).toHaveAttribute('aria-selected', 'true');
    } finally {
      await browser.close();
    }
  });

  test('All draws the column name where each stay begins and folds the new session at a move', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);
      await expect(dividers(page)).toHaveText(['Executing', 'Code Review', 'Executing']);
      await expect(page.getByText('BEFORE_THE_LOG')).toBeVisible();
      // The session that began with the move to Code Review adds no line of its own.
      await expect(page.getByTestId('conversation-row-system')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a column tab keeps only that column\'s stays, each opened by its date, and search names the column', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);
      await tab(page, 'lane-executing').click();
      await expect(tab(page, 'lane-executing')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('EXEC_ONE')).toBeVisible();
      await expect(page.getByText('EXEC_TWO')).toBeVisible();
      await expect(page.getByText('REVIEW_ONE')).toHaveCount(0);
      await expect(page.getByText('BEFORE_THE_LOG')).toHaveCount(0);
      await expect(dividers(page)).toHaveCount(2);
      await expect(page.getByTestId('conversation-search-input')).toHaveAttribute('placeholder', 'Search Executing');
    } finally {
      await browser.close();
    }
  });

  test('a column the agent never worked in keeps its tab and says why it is empty', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page);
      await tab(page, 'lane-merge').click();
      await expect(page.getByTestId('conversation-route-empty')).toContainText('No conversation in Merge');
      await expect(page.getByTestId('conversation-route-empty')).toContainText('The agent did not run while the task was in Merge.');
    } finally {
      await browser.close();
    }
  });

  test('Copy copies the tab on screen, its stays as headings', async () => {
    const { browser, page } = await launch(ROUTE, { permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      await openConversation(page, { swimlaneId: 'lane-review' });
      await expect(page.getByText('REVIEW_ONE')).toBeVisible();
      await page.getByTestId('conversation-copy-markdown-button').click();
      await expect(page.getByTestId('conversation-copy-markdown-button').locator('.lucide-check')).toBeVisible();
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toContain('REVIEW_ONE');
      expect(clipboardText).not.toContain('EXEC_ONE');
      expect(clipboardText).toContain('## ');
    } finally {
      await browser.close();
    }
  });

  test('a Route of one column shows no tab row, the window as it always was', async () => {
    const { browser, page } = await launch([routeColumn('lane-executing', 'Executing', '#3b82f6', [0])]);
    try {
      await openConversation(page);
      await expect(page.getByText('EXEC_ONE')).toBeVisible();
      await expect(tabRow(page)).toHaveCount(0);
      await expect(dividers(page)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('an open asking for a column switches the window that is already open, never a second one', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, { swimlaneId: 'lane-review' });
      await expect(tab(page, 'lane-review')).toHaveAttribute('aria-selected', 'true');
      await openConversation(page, { swimlaneId: 'lane-executing' });
      await expect(tab(page, 'lane-executing')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('conversation-window')).toHaveCount(1);
      // Asking again for the column already showing, after a manual switch, still switches.
      await tab(page, 'all').click();
      await openConversation(page, { swimlaneId: 'lane-executing' });
      await expect(tab(page, 'lane-executing')).toHaveAttribute('aria-selected', 'true');
    } finally {
      await browser.close();
    }
  });

  test('an open request reads the route again, so a column added by a move that wrote no turn gets its tab', async () => {
    // The window opens while the task has worked in one column, and the
    // conversation is finished, so no new revision will ever re-read the route.
    const { browser, page } = await launch([routeColumn('lane-executing', 'Executing', '#3b82f6', [0])]);
    try {
      await openConversation(page);
      await expect(page.getByText('EXEC_ONE')).toBeVisible();
      await expect(tabRow(page)).toHaveCount(0);
      // The task moves on without a turn (into Code Review, then Done).
      await page.evaluate(({ taskId, route }) => {
        (window as unknown as { __mockTaskRoutes: Record<string, unknown> }).__mockTaskRoutes[taskId] = route;
      }, { taskId: TASK_ID, route: ROUTE });
      // A Route pill asks for the column the window never heard of.
      await openConversation(page, { swimlaneId: 'lane-review' });
      await expect(tab(page, 'lane-review')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('REVIEW_ONE')).toBeVisible();
      await expect(page.getByTestId('conversation-window')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a running task\'s window gains a tab when the task moves and its next turn lands, with no open request', async () => {
    const { browser, page } = await launch([routeColumn('lane-executing', 'Executing', '#3b82f6', [0])]);
    try {
      // A live conversation: the poll answers revision 1 until the task moves,
      // then revision 2 with the first Code Review turn.
      await page.evaluate(({ taskId, sessionId, firstMoveMs, minute }) => {
        const scope = window as unknown as {
          __taskMoved: boolean;
          __mockTranscriptsGetOverride: (input: { sessionId: string }) => unknown;
        };
        scope.__taskMoved = false;
        const started = new Date(firstMoveMs).toISOString();
        const meta = {
          sessionId, taskId, taskTitle: 'Keep animations running', agentName: 'Claude Code', startedAt: started,
          sessionStatus: 'running', source: 'live', sourcePath: '/mock/route-tabs.jsonl', degraded: false,
          sessions: [{ sessionId, agentName: 'Claude Code', startedAt: started, exitedAt: null, isolatedSwimlaneId: null, status: 'running' }],
        };
        const say = (uuid: string, minutes: number, text: string) => ({
          kind: 'assistant', uuid, ts: firstMoveMs + minutes * minute, model: 'claude-opus-5-5', blocks: [{ type: 'text', text }],
        });
        scope.__mockTranscriptsGetOverride = (input) => {
          if (input.sessionId !== sessionId) return undefined;
          return scope.__taskMoved
            ? { ...meta, revision: 2, entries: [say('turn-exec-one', 1, 'EXEC_ONE'), say('turn-review-one', 21, 'REVIEW_ONE')] }
            : { ...meta, revision: 1, entries: [say('turn-exec-one', 1, 'EXEC_ONE')] };
        };
      }, { taskId: TASK_ID, sessionId: SESSION_ID, firstMoveMs: T0, minute: MINUTE });
      await openConversation(page);
      await expect(page.getByText('EXEC_ONE')).toBeVisible();
      await expect(tabRow(page)).toHaveCount(0);

      await page.evaluate(({ taskId, route }) => {
        const scope = window as unknown as { __taskMoved: boolean; __mockTaskRoutes: Record<string, unknown> };
        scope.__mockTaskRoutes[taskId] = route;
        scope.__taskMoved = true;
      }, { taskId: TASK_ID, route: [ROUTE[0], ROUTE[1]] });
      // The next poll (every 2.5 s) carries the new revision, which re-reads the route.
      await expect(tab(page, 'lane-review')).toBeVisible({ timeout: 8000 });
      await expect(tab(page, 'all')).toHaveAttribute('aria-selected', 'true');
      await expect(dividers(page)).toHaveText(['Executing', 'Code Review']);
    } finally {
      await browser.close();
    }
  });

  test('a column the window has not read yet switches straight to it, never through All', async () => {
    const twoColumns = [ROUTE[0], ROUTE[1]];
    const { browser, page } = await launch(twoColumns);
    try {
      await openConversation(page, { swimlaneId: 'lane-executing' });
      await expect(tab(page, 'lane-executing')).toHaveAttribute('aria-selected', 'true');
      // The task moves on to Merge, and the re-read takes a moment to answer.
      await page.evaluate(({ taskId, route }) => {
        const scope = window as unknown as {
          __mockTaskRoutes: Record<string, unknown>;
          __selectedTabs: string[];
          electronAPI: { sessions: { getTaskRoute: (projectId: string, taskId: string) => Promise<unknown> } };
        };
        scope.__mockTaskRoutes[taskId] = route;
        const sessions = scope.electronAPI.sessions;
        const read = sessions.getTaskRoute.bind(sessions);
        sessions.getTaskRoute = async (projectId, requestedTaskId) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return read(projectId, requestedTaskId);
        };
        // Every tab that is ever selected, frame by frame: the end state alone
        // cannot show a pass through All, since it is gone a moment later.
        scope.__selectedTabs = [];
        const note = () => {
          const selected = document.querySelector('[data-testid^="conversation-route-tabs-"][aria-selected="true"]');
          const id = selected?.getAttribute('data-testid') ?? 'none';
          if (scope.__selectedTabs[scope.__selectedTabs.length - 1] !== id) scope.__selectedTabs.push(id);
        };
        note();
        new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] });
      }, { taskId: TASK_ID, route: ROUTE });
      await openConversation(page, { swimlaneId: 'lane-merge' });
      await expect(tab(page, 'lane-merge')).toHaveAttribute('aria-selected', 'true');
      const selectedTabs = await page.evaluate(() => (window as unknown as { __selectedTabs: string[] }).__selectedTabs);
      expect(selectedTabs).toEqual(['conversation-route-tabs-lane-executing', 'conversation-route-tabs-lane-merge']);
    } finally {
      await browser.close();
    }
  });

  test('a scroll-to-turn request (a search hit) shows All, where every turn is', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, { swimlaneId: 'lane-executing' });
      // The Executing tab is showing (so REVIEW_ONE's absence means something)
      // before the scroll request arrives.
      await expect(tab(page, 'lane-executing')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('EXEC_ONE')).toBeVisible();
      await expect(page.getByText('REVIEW_ONE')).toHaveCount(0);
      await page.evaluate(({ sessionId }) => {
        const stores = (window as unknown as {
          __zustandStores: { session: { getState: () => { setScrollToTurnUuid: (uuid: string) => void; setConversationSessionId: (id: string) => void } } };
        }).__zustandStores;
        stores.session.getState().setScrollToTurnUuid('turn-review-one');
        stores.session.getState().setConversationSessionId(sessionId);
      }, { sessionId: SESSION_ID });
      await expect(tab(page, 'all')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('REVIEW_ONE')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('when the names do not fit, every tab but the selected one shows its icon, named on hover; more room brings the names back', async () => {
    const names = ['Planning', 'Design Review', 'Executing', 'Code Review', 'Security Review', 'Testing', 'Staging Deploy', 'Merge Train'];
    const wideRoute = names.map((name, index) => routeColumn(`lane-wide-${index}`, name, '#3b82f6', [index * 5]));
    const { browser, page } = await launch(wideRoute, { viewport: { width: 1280, height: 800 } });
    try {
      await openConversation(page, { swimlaneId: 'lane-wide-3' });
      const list = tabRow(page).getByRole('tablist');
      await expect(list).toHaveAttribute('data-fit-icons-only', 'true');
      // The selected tab keeps its name; another tab is its icon, named for assistive tech.
      await expect(tab(page, 'lane-wide-3')).toHaveText('Code Review');
      await expect(tab(page, 'lane-wide-6')).toHaveText('');
      await expect(tab(page, 'lane-wide-6')).toHaveAccessibleName('Staging Deploy');
      // Maximizing gives the row room for every name again.
      await page.locator('[data-testid^="conversation-maximize-"]').click();
      await expect(list).toHaveAttribute('data-fit-icons-only', 'false');
      await expect(tab(page, 'lane-wide-6')).toHaveText('Staging Deploy');
    } finally {
      await browser.close();
    }
  });

  test('a column an isolated session ran in ends in the Split icon on its tab and its divider in All', async () => {
    const { browser, page } = await launch(ROUTE, { isolatedSwimlaneIds: ['lane-review'] });
    try {
      await openConversation(page);
      const reviewIcon = tab(page, 'lane-review').getByTestId('isolated-icon');
      await expect(reviewIcon).toHaveCount(1);
      await expect(reviewIcon).toHaveAccessibleName('Isolated session');
      for (const id of ['all', 'lane-executing', 'lane-merge']) {
        await expect(tab(page, id).getByTestId('isolated-icon')).toHaveCount(0);
      }
      // The icon adds no text, so the tab and the divider still read as the name.
      await expect(tabRow(page).getByRole('tab')).toHaveText(['All', 'Executing', 'Code Review', 'Merge']);
      await expect(dividers(page)).toHaveText(['Executing', 'Code Review', 'Executing']);
      await expect(dividers(page).nth(1).getByTestId('isolated-icon')).toHaveCount(1);
      await expect(dividers(page).nth(0).getByTestId('isolated-icon')).toHaveCount(0);
      await expect(dividers(page).nth(2).getByTestId('isolated-icon')).toHaveCount(0);

      // A column tab's dividers are dates under a tab that already carries the icon.
      await tab(page, 'lane-review').click();
      await expect(dividers(page)).toHaveCount(1);
      await expect(dividers(page).getByTestId('isolated-icon')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('the Split icon goes with the name when a tab shrinks to its icon', async () => {
    const names = ['Planning', 'Design Review', 'Executing', 'Code Review', 'Security Review', 'Testing', 'Staging Deploy', 'Merge Train'];
    const wideRoute = names.map((name, index) => routeColumn(`lane-wide-${index}`, name, '#3b82f6', [index * 5]));
    const { browser, page } = await launch(wideRoute, { viewport: { width: 1280, height: 800 }, isolatedSwimlaneIds: ['lane-wide-3'] });
    try {
      await openConversation(page, { swimlaneId: 'lane-wide-0' });
      await expect(tabRow(page).getByRole('tablist')).toHaveAttribute('data-fit-icons-only', 'true');
      await expect(tab(page, 'lane-wide-3')).toHaveText('');
      await expect(tab(page, 'lane-wide-3').getByTestId('isolated-icon')).toHaveCount(0);
      // Selected, the tab keeps its name, and the icon comes back with it.
      await openConversation(page, { swimlaneId: 'lane-wide-3' });
      await expect(tab(page, 'lane-wide-3')).toHaveText('Code Review');
      await expect(tab(page, 'lane-wide-3').getByTestId('isolated-icon')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('Split icons that arrive after the row was measured to fit widen the names, so the row re-measures and falls back to icons', async () => {
    // The window shows no tab row until its first transcript is in, and the row
    // needs that transcript's task, so on an open the icons and the names are
    // measured together. The real late path is a live poll: a running task moves
    // into isolated columns, and the next revision lists the sessions they run
    // along with their first turn (main bumps a revision only when turns change).
    // That poll runs every 2.5 s, which comes on top of a launch, so the 15 s
    // default leaves a loaded worker too little headroom to fail on an assertion.
    test.setTimeout(30_000);
    const names = ['Planning', 'Design Review', 'Executing', 'Code Review', 'Security Review', 'Testing', 'Staging Deploy', 'Merge Train'];
    const wideRoute = names.map((name, index) => routeColumn(`lane-wide-${index}`, name, '#3b82f6', [index * 5]));
    // Four columns end up isolated, so the icons add a wide margin to the names.
    const isolatedLanes = ['lane-wide-1', 'lane-wide-3', 'lane-wide-5', 'lane-wide-6'];
    const { browser, page } = await launch(wideRoute, { viewport: { width: 1280, height: 800 }, isolatedSwimlaneIds: isolatedLanes });
    try {
      await page.evaluate(async ({ sessionId }) => {
        interface SeededTranscript {
          sessions: Array<{ isolatedSwimlaneId: string | null }>;
          entries: Array<{ ts: number }>;
          [field: string]: unknown;
        }
        const scope = window as unknown as {
          __isolatedArrived: boolean;
          __mockTranscriptsGetOverride: (input: { sessionId: string }) => unknown;
          electronAPI: { transcripts: { get: (input: { sessionId: string; projectId: string | null }) => Promise<SeededTranscript> } };
        };
        // The seeded transcript lists the isolated sessions. The later revision is
        // that transcript plus the first isolated turn; the earlier one lacks both.
        const seeded = await scope.electronAPI.transcripts.get({ sessionId, projectId: null });
        const early = {
          ...seeded,
          sessionStatus: 'running',
          revision: 1,
          sessions: seeded.sessions.filter((session) => session.isolatedSwimlaneId === null),
        };
        const lastTurn = seeded.entries[seeded.entries.length - 1];
        const isolatedTurn = { kind: 'assistant', uuid: 'turn-isolated-late', ts: lastTurn.ts + 1000, model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'ISOLATED_LATE' }] };
        const late = { ...seeded, sessionStatus: 'running', revision: 2, entries: [...seeded.entries, isolatedTurn] };
        scope.__isolatedArrived = false;
        scope.__mockTranscriptsGetOverride = (input) => {
          if (input.sessionId !== sessionId) return undefined;
          return scope.__isolatedArrived ? late : early;
        };
      }, { sessionId: SESSION_ID });

      await openConversation(page, { swimlaneId: 'lane-wide-3' });
      const list = tabRow(page).getByRole('tablist');
      const selectedIcon = tab(page, 'lane-wide-3').getByTestId('isolated-icon');
      await expect(tab(page, 'lane-wide-3')).toHaveAttribute('aria-selected', 'true');
      await expect(selectedIcon).toHaveCount(0);

      // Give the row room, take the width the names alone need, then narrow it
      // to just past that: the names fit, with little to spare. Measured here
      // rather than hardcoded, since font metrics differ between machines.
      await installListWidthSetter(page);
      await expect(list).toHaveAttribute('data-fit-icons-only', 'false');
      const namesWidth = await tabsSpan(page);
      const narrowedWidth = await setListWidth(page, namesWidth + 4);
      expect(narrowedWidth).toBeGreaterThanOrEqual(namesWidth);
      await settleFrames(page, 6);
      await expect(list).toHaveAttribute('data-fit-icons-only', 'false');

      // The next poll finds the isolated sessions. The row's own box does not
      // change from here on, so only a changed tab set can make it re-measure.
      await page.evaluate(() => { (window as unknown as { __isolatedArrived: boolean }).__isolatedArrived = true; });
      // The selected tab keeps its name and its icon in either fit, so the icon
      // showing means the poll landed, and a fit that never changed is the row's fault.
      await expect(selectedIcon).toHaveCount(1, { timeout: 8000 });
      await expect(list).toHaveAttribute('data-fit-icons-only', 'true');
      await expect(tab(page, 'lane-wide-6')).toHaveText('');

      // The width really sat between the two: given room, the names now carry
      // their icons and need well over what the row had.
      await setListWidth(page, 3000);
      await expect(list).toHaveAttribute('data-fit-icons-only', 'false');
      expect(await tabsSpan(page)).toBeGreaterThan(narrowedWidth + 40);
    } finally {
      await browser.close();
    }
  });

  test('a first route read that fails shows the whole conversation with no tab row', async () => {
    const { browser, page } = await launch();
    try {
      await failTaskRouteReads(page);
      await openConversation(page);
      // The read was asked for and refused, so the window below is the answer to a failure.
      await expect.poll(() => failedRouteReads(page)).toBeGreaterThan(0);
      for (const turn of ['BEFORE_THE_LOG', 'EXEC_ONE', 'REVIEW_ONE', 'EXEC_TWO']) {
        await expect(page.getByText(turn)).toBeVisible();
      }
      await expect(page.getByTestId('conversation-window').locator('.animate-spin')).toHaveCount(0);
      await expect(tabRow(page)).toHaveCount(0);
      await expect(dividers(page)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a later route read that fails keeps the tab row and the tab on screen', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, { swimlaneId: 'lane-review' });
      await expect(tabRow(page).getByRole('tab')).toHaveText(['All', 'Executing', 'Code Review', 'Merge']);
      await expect(tab(page, 'lane-review')).toHaveAttribute('aria-selected', 'true');

      await failTaskRouteReads(page);
      // An open request reads the route again, and this read is refused.
      await openConversation(page, { swimlaneId: 'lane-executing' });
      await expect.poll(() => failedRouteReads(page)).toBeGreaterThan(0);
      // The refusal has been handled and drawn by the time the frames have run.
      await settleFrames(page);
      await expect(tabRow(page).getByRole('tab')).toHaveText(['All', 'Executing', 'Code Review', 'Merge']);
      await expect(tab(page, 'lane-executing')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('EXEC_ONE')).toBeVisible();
      await expect(page.getByText('REVIEW_ONE')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a scroll target set on the window itself (a Knowledge Graph source row) switches it to All', async () => {
    const { browser, page } = await launch();
    try {
      await openConversation(page, { swimlaneId: 'lane-executing' });
      await expect(tab(page, 'lane-executing')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('REVIEW_ONE')).toHaveCount(0);
      // The per-window target, not the session store's one-shot: the store's
      // `scrollToTurnUuid` stays null throughout.
      await page.evaluate(({ sessionId }) => {
        const stores = (window as unknown as {
          __zustandStores: { window: { getState: () => { openWindow: (input: object) => string } } };
        }).__zustandStores;
        stores.window.getState().openWindow({
          kind: 'conversation', anchor: sessionId, sessionId, title: 'Conversation', scrollToTurnUuid: 'turn-review-one',
        });
      }, { sessionId: SESSION_ID });
      await expect(tab(page, 'all')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('REVIEW_ONE')).toBeVisible();
      await expect(page.getByTestId('conversation-window')).toHaveCount(1);
      const sessionStoreTarget = await page.evaluate(() => (window as unknown as {
        __zustandStores: { session: { getState: () => { scrollToTurnUuid: string | null } } };
      }).__zustandStores.session.getState().scrollToTurnUuid);
      expect(sessionStoreTarget).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('an open request that names no tab leaves the window on the tab it shows', async () => {
    const { browser, page } = await launch();
    try {
      await countViewerOpens(page);
      await openConversation(page, { swimlaneId: 'lane-review' });
      await expect(tab(page, 'lane-review')).toHaveAttribute('aria-selected', 'true');
      await expect.poll(() => viewerOpens(page)).toBeGreaterThan(0);
      const opensBefore = await viewerOpens(page);

      await openConversation(page, null);
      // The bridge ran the request: it reports each open it handles.
      await expect.poll(() => viewerOpens(page)).toBeGreaterThan(opensBefore);
      await settleFrames(page);
      await expect(tab(page, 'lane-review')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('REVIEW_ONE')).toBeVisible();
      await expect(page.getByText('EXEC_ONE')).toHaveCount(0);
      await expect(page.getByTestId('conversation-window')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a running task\'s first move adds the tab row without remounting the conversation', async () => {
    const { browser, page } = await launch([routeColumn('lane-executing', 'Executing', '#3b82f6', [0])]);
    try {
      await page.evaluate(({ taskId, sessionId, firstMoveMs, minute }) => {
        const scope = window as unknown as {
          __taskMoved: boolean;
          __mockTranscriptsGetOverride: (input: { sessionId: string }) => unknown;
        };
        scope.__taskMoved = false;
        const started = new Date(firstMoveMs).toISOString();
        const meta = {
          sessionId, taskId, taskTitle: 'Keep animations running', agentName: 'Claude Code', startedAt: started,
          sessionStatus: 'running', source: 'live', sourcePath: '/mock/route-tabs.jsonl', degraded: false,
          sessions: [{ sessionId, agentName: 'Claude Code', startedAt: started, exitedAt: null, isolatedSwimlaneId: null, status: 'running' }],
        };
        const say = (uuid: string, minutes: number, text: string) => ({
          kind: 'assistant', uuid, ts: firstMoveMs + minutes * minute, model: 'claude-opus-5-5', blocks: [{ type: 'text', text }],
        });
        scope.__mockTranscriptsGetOverride = (input) => {
          if (input.sessionId !== sessionId) return undefined;
          return scope.__taskMoved
            ? { ...meta, revision: 2, entries: [say('turn-exec-one', 1, 'EXEC_ONE'), say('turn-review-one', 21, 'REVIEW_ONE')] }
            : { ...meta, revision: 1, entries: [say('turn-exec-one', 1, 'EXEC_ONE')] };
        };
      }, { taskId: TASK_ID, sessionId: SESSION_ID, firstMoveMs: T0, minute: MINUTE });
      await openConversation(page);
      await expect(page.getByText('EXEC_ONE')).toBeVisible();
      await expect(tabRow(page)).toHaveCount(0);

      // A query typed into the view's own search bar lives in the view, so it
      // is gone if the view is rebuilt when the tab row appears above it.
      const search = page.getByTestId('conversation-search-input');
      await search.fill('EXEC');
      await expect(search).toHaveValue('EXEC');

      await page.evaluate(({ taskId, route }) => {
        const scope = window as unknown as { __taskMoved: boolean; __mockTaskRoutes: Record<string, unknown> };
        scope.__mockTaskRoutes[taskId] = route;
        scope.__taskMoved = true;
      }, { taskId: TASK_ID, route: [ROUTE[0], ROUTE[1]] });
      await expect(tab(page, 'lane-review')).toBeVisible({ timeout: 8000 });
      await expect(tab(page, 'all')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('REVIEW_ONE')).toBeVisible();
      await expect(search).toHaveValue('EXEC');
    } finally {
      await browser.close();
    }
  });

  test('a tab chosen from a long route is scrolled into the row when even the icons overflow it', async () => {
    const longRoute = Array.from({ length: 14 }, (_, index) => (
      routeColumn(`lane-long-${index}`, `Stage ${String(index + 1).padStart(2, '0')}`, '#3b82f6', [index * 5])
    ));
    const { browser, page } = await launch(longRoute, { viewport: { width: 1280, height: 800 } });
    try {
      await openConversation(page, { swimlaneId: 'lane-long-0' });
      const list = tabRow(page).getByRole('tablist');
      // Narrow the row to a width the 14 icons cannot fit, whatever the window's own width.
      await tabRow(page).evaluate((element) => { element.style.width = '360px'; });
      await expect(list).toHaveAttribute('data-fit-icons-only', 'true');
      await expect.poll(() => list.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

      // An open request moves the selection with no click or focus, either of
      // which would scroll the tab into view on its own: only the row can.
      await openConversation(page, { swimlaneId: 'lane-long-13' });
      await expect(tab(page, 'lane-long-13')).toHaveAttribute('aria-selected', 'true');
      await expect(list).toHaveAttribute('data-fit-icons-only', 'true');
      const overhang = () => page.evaluate(() => {
        const listBox = document.querySelector('[data-testid="conversation-route-tabs"] [role="tablist"]')!.getBoundingClientRect();
        const tabBox = document.querySelector('[data-testid="conversation-route-tabs-lane-long-13"]')!.getBoundingClientRect();
        return Math.max(listBox.left - tabBox.left, tabBox.right - listBox.right);
      });
      // A tolerance for sub-pixel rounding; a tab left unscrolled sits far past the edge.
      await expect.poll(overhang).toBeLessThanOrEqual(2);
    } finally {
      await browser.close();
    }
  });

  test('once the row is icons only, a width between the icons and the names keeps it so, and the names return only with room for them all', async () => {
    const names = ['Planning', 'Design Review', 'Executing', 'Code Review', 'Security Review', 'Testing', 'Staging Deploy', 'Merge Train'];
    const wideRoute = names.map((name, index) => routeColumn(`lane-wide-${index}`, name, '#3b82f6', [index * 5]));
    const { browser, page } = await launch(wideRoute, { viewport: { width: 1280, height: 800 } });
    try {
      await openConversation(page, { swimlaneId: 'lane-wide-3' });
      const list = tabRow(page).getByRole('tablist');
      // The page sets the tablist's own width through its row, so the widths
      // below do not depend on the window's. `setListWidth` returns the width
      // the list ended up with.
      await installListWidthSetter(page);
      await expect(list).toHaveAttribute('data-fit-icons-only', 'false');
      const namesWidth = await tabsSpan(page);

      // Every value the row reports from here on is recorded. A row that went
      // back to names as soon as the icons fit would overflow, fall back to
      // icons, and settle to the same attribute a frame later, which the end
      // state alone cannot tell from a row that never moved.
      await page.evaluate(() => {
        const scope = window as unknown as { __fitValues: string[] };
        const tablist = document.querySelector('[data-testid="conversation-route-tabs"] [role="tablist"]')!;
        scope.__fitValues = [tablist.getAttribute('data-fit-icons-only') ?? 'none'];
        new MutationObserver(() => {
          scope.__fitValues.push(tablist.getAttribute('data-fit-icons-only') ?? 'none');
        }).observe(tablist, { attributes: true, attributeFilter: ['data-fit-icons-only'] });
      });
      const fitValues = () => page.evaluate(() => (window as unknown as { __fitValues: string[] }).__fitValues);

      // Narrower than the names: the row falls back to icons, once.
      await setListWidth(page, namesWidth - 40);
      await expect(list).toHaveAttribute('data-fit-icons-only', 'true');
      await settleFrames(page, 6);
      expect(await fitValues()).toEqual(['false', 'true']);
      const iconsWidth = await tabsSpan(page);
      // The next step means something only when the icons are well short of the names.
      expect(namesWidth - iconsWidth).toBeGreaterThan(80);

      // Between the two: wide enough for the icons, not for the names. The row stays as it is.
      const between = Math.round((namesWidth + iconsWidth) / 2);
      const listWidth = await setListWidth(page, between);
      expect(listWidth).toBeGreaterThan(iconsWidth + 20);
      expect(listWidth).toBeLessThan(namesWidth - 20);
      await settleFrames(page, 6);
      await expect(list).toHaveAttribute('data-fit-icons-only', 'true');
      expect(await fitValues()).toEqual(['false', 'true']);

      // Room for every name again: the names come back. A few pixels over the
      // names' width absorbs the rounding between this measure and the row's own.
      await setListWidth(page, namesWidth + 4);
      await expect(list).toHaveAttribute('data-fit-icons-only', 'false');
    } finally {
      await browser.close();
    }
  });

  test('Copy on All copies every turn, each column move written as a heading', async () => {
    const { browser, page } = await launch(ROUTE, { permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      await openConversation(page);
      await expect(tab(page, 'all')).toHaveAttribute('aria-selected', 'true');
      await expect(dividers(page)).toHaveText(['Executing', 'Code Review', 'Executing']);
      await page.getByTestId('conversation-copy-markdown-button').click();
      await expect(page.getByTestId('conversation-copy-markdown-button').locator('.lucide-check')).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());

      // The whole conversation, from before the first logged move on, in order,
      // with a heading where each stay begins (the Executing stay twice).
      const firstExecuting = copied.indexOf('## Executing');
      const codeReview = copied.indexOf('## Code Review');
      const secondExecuting = copied.indexOf('## Executing', firstExecuting + 1);
      expect(copied.indexOf('BEFORE_THE_LOG')).toBeGreaterThanOrEqual(0);
      expect(copied.indexOf('BEFORE_THE_LOG')).toBeLessThan(firstExecuting);
      expect(firstExecuting).toBeLessThan(copied.indexOf('EXEC_ONE'));
      expect(copied.indexOf('EXEC_ONE')).toBeLessThan(codeReview);
      expect(codeReview).toBeLessThan(copied.indexOf('REVIEW_ONE'));
      expect(copied.indexOf('REVIEW_ONE')).toBeLessThan(secondExecuting);
      expect(secondExecuting).toBeLessThan(copied.indexOf('EXEC_TWO'));
      expect(copied.split('## Executing')).toHaveLength(3);
      // The move that started a session adds no heading of its own, and Merge, with no turns, none at all.
      expect(copied).not.toContain('## New session');
      expect(copied).not.toContain('## Merge');
    } finally {
      await browser.close();
    }
  });
});
