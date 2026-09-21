/**
 * UI tests for the global search palette (Ctrl+Shift+F / Ctrl+F).
 *
 * Verifies the overlay opens via both keybinds and the title bar icon,
 * results render grouped by kind with mocked hits, keyboard navigation
 * works, and per-kind navigation actions are invoked correctly.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors, toastCountRightNow } from './helpers';
import { PROJECT_NOT_FOUND_PREFIX } from '../../src/shared/ipc-channels';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-search';
const OTHER_PROJECT_ID = 'proj-other';
const TASK_ID = 'task-search-1';
const SESSION_ID = 'sess-search-1';

function preConfigWithSearchHits(
  conversationSessionActive = false,
  conversationMatchKind: 'lexical' | 'semantic' | 'hybrid' = 'lexical',
): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Primary Project',
        path: '/mock/primary',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.projects.push({
        id: '${OTHER_PROJECT_ID}',
        name: 'Other Project',
        path: '/mock/other',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-search-' + i,
          position: i,
          created_at: ts,
        }));
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Task with auth in title',
        description: '',
        swimlane_id: 'lane-search-0',
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      var hits = [
        {
          kind: 'project',
          projectId: '${OTHER_PROJECT_ID}',
          projectName: 'Other Project',
          projectPath: '/mock/other',
          snippet: 'Other Project',
          matchStart: 0,
          matchEnd: 5,
        },
        {
          kind: 'task',
          projectId: '${PROJECT_ID}',
          projectName: 'Primary Project',
          taskId: '${TASK_ID}',
          displayId: 7,
          taskTitle: 'Task with auth in title',
          archived: false,
          snippetField: 'title',
          snippet: 'Task with auth in title',
          matchStart: 10,
          matchEnd: 14,
        },
        {
          kind: 'backlog',
          projectId: '${PROJECT_ID}',
          projectName: 'Primary Project',
          backlogId: 'backlog-1',
          backlogTitle: 'Investigate auth flow',
          snippetField: 'title',
          snippet: 'Investigate auth flow',
          matchStart: 12,
          matchEnd: 16,
        },
        {
          kind: 'session_event',
          projectId: '${PROJECT_ID}',
          projectName: 'Primary Project',
          taskId: '${TASK_ID}',
          taskTitle: 'Task with auth in title',
          sessionId: '${SESSION_ID}',
          agentName: 'Claude Code',
          eventTs: Date.now(),
          eventKey: '${SESSION_ID}-' + Date.now(),
          eventType: 'tool_start',
          snippet: 'Read: src/auth/login.ts',
          matchStart: 10,
          matchEnd: 14,
        },
        {
          kind: 'conversation',
          projectId: '${PROJECT_ID}',
          projectName: 'Primary Project',
          taskId: '${TASK_ID}',
          taskTitle: 'Task with auth in title',
          sessionId: '${SESSION_ID}',
          agentName: 'Claude Code',
          chunkId: 42,
          turnUuid: 'turn-uuid-abc',
          turnKind: 'assistant',
          turnTs: Date.now(),
          score: 0.9,
          matchKind: '${conversationMatchKind}',
          snippet: 'We reworked the auth flow to refresh tokens',
          matchStart: 20,
          matchEnd: 24,
          sessionActive: ${conversationSessionActive},
        },
      ];

      return {
        currentProjectId: '${PROJECT_ID}',
        searchHits: hits,
        // Semantic layer off, so Smart mode shows the "off" degraded notice
        // while still returning the seeded (lexical) hits.
        memoryStatus: { indexingEnabled: true, semantic: 'disabled' },
      };
    });
  `;
}

/** Isolated fixture: one project, one task with a live (running) session, so
 *  clicking its card opens the normal task-detail header (not the auto-edit
 *  form a session-less task's card click opens into - see TaskCard.tsx's
 *  `initialEdit` heuristic). Kept separate from `preConfigWithSearchHits` so
 *  it never touches the other tests reusing that shared fixture. */
function preConfigWithLiveSessionTask(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: 'proj-search-escape', name: 'Escape Stacking Project', path: '/mock/escape-stacking',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-escape-' + i, position: i, created_at: ts }));
      });

      state.sessions.push({
        id: 'sess-escape-1', taskId: 'task-escape-1', projectId: 'proj-search-escape',
        pid: 9999, status: 'running', shell: 'bash', cwd: '/mock/escape-stacking',
        startedAt: ts, exitCode: null,
      });

      state.tasks.push({
        id: 'task-escape-1', title: 'Escape stacking task', description: '',
        swimlane_id: 'lane-escape-0', position: 0, agent: 'claude', session_id: 'sess-escape-1',
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });

      return { currentProjectId: 'proj-search-escape' };
    });
  `;
}

/**
 * Isolated fixture for the cross-project navigation failure path: a single
 * task hit whose `projectId` differs from `currentProjectId`, so activating
 * it must route through `switchProjectIfNeeded` -> `projectStore.openProject`.
 * Kept separate from `preConfigWithSearchHits` (whose task hit stays in the
 * current project) so this test's `projects.open` monkey-patch cannot bleed
 * into any other test reusing that shared fixture.
 */
const CROSS_PROJECT_CURRENT_ID = 'proj-cross-current';
const CROSS_PROJECT_TARGET_ID = 'proj-cross-target';
const CROSS_PROJECT_TASK_ID = 'task-cross-1';

function preConfigCrossProjectTaskHit(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${CROSS_PROJECT_CURRENT_ID}', name: 'Current Project', path: '/mock/cross-current',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.projects.push({
        id: '${CROSS_PROJECT_TARGET_ID}', name: 'Target Project', path: '/mock/cross-target',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-cross-' + i, position: i, created_at: ts }));
      });

      var hits = [
        {
          kind: 'task',
          projectId: '${CROSS_PROJECT_TARGET_ID}',
          projectName: 'Target Project',
          taskId: '${CROSS_PROJECT_TASK_ID}',
          displayId: 3,
          taskTitle: 'Cross-project task hit',
          archived: false,
          snippetField: 'title',
          snippet: 'Cross-project task hit',
          matchStart: 0,
          matchEnd: 5,
        },
      ];

      return { currentProjectId: '${CROSS_PROJECT_CURRENT_ID}', searchHits: hits };
    });
  `;
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
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

test.describe('Search Palette', () => {
  test('Ctrl+Shift+F opens the palette', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.getByTestId('search-palette')).not.toBeVisible();
      await page.keyboard.press('Control+Shift+F');
      await expect(page.getByTestId('search-palette')).toBeVisible();
      await expect(page.getByTestId('search-palette-input')).toBeFocused();
    } finally {
      await browser.close();
    }
  });

  test('Ctrl+F focuses the board search on the board view', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      // Focus a non-editable element so the keybind guard doesn't suppress the event
      await page.locator('body').click();
      await page.keyboard.press('Control+f');
      // On the board view Ctrl+F routes to the board search input, not the global palette
      await expect(page.getByTestId('board-search')).toBeFocused();
      await expect(page.getByTestId('search-palette')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Ctrl+F opens the palette on the backlog view', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      // Switch to backlog - no board-search input exists there
      await page.getByTestId('view-toggle-backlog').click();
      // Focus a non-editable element so the keybind guard doesn't suppress the event
      await page.locator('body').click();
      await page.keyboard.press('Control+f');
      // On non-board views Ctrl+F falls through to the global search palette
      await expect(page.getByTestId('search-palette')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('title bar Search button opens the palette', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.getByTestId('open-search-button')).toBeVisible();
      await page.getByTestId('open-search-button').click();
      await expect(page.getByTestId('search-palette')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Escape closes the palette', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await expect(page.getByTestId('search-palette')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('search-palette')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Escape with a task detail open underneath closes only the palette, not the task detail', async () => {
    const { browser, page } = await launchWithState(preConfigWithLiveSessionTask());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('text=Escape stacking task').first().click();
      await expect(page.getByTestId('task-detail-dialog')).toBeVisible();

      await page.keyboard.press('Control+Shift+F');
      await expect(page.getByTestId('search-palette')).toBeVisible();

      // One Escape must close only the palette (the topmost layer) - the
      // task detail window underneath must still be open. Regression test:
      // the palette's Escape handler previously did not stop propagation,
      // so the same keypress also closed the task detail's own document-level
      // Escape listener in one go.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('search-palette')).not.toBeVisible();
      await expect(page.getByTestId('task-detail-dialog')).toBeVisible();

      // A second Escape now closes the task detail normally.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('task-detail-dialog')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('typing returns mocked hits across all kinds', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('auth');
      // Wait past the 200ms debounce
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });

      const results = page.locator('[data-testid="search-palette-result"]');
      await expect(results).toHaveCount(5);
      // Per-kind data attribute should reflect each hit's kind
      await expect(page.locator('[data-result-kind="project"]')).toHaveCount(1);
      await expect(page.locator('[data-result-kind="task"]')).toHaveCount(1);
      await expect(page.locator('[data-result-kind="backlog"]')).toHaveCount(1);
      await expect(page.locator('[data-result-kind="conversation"]')).toHaveCount(1);
      await expect(page.locator('[data-result-kind="session_event"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('forwards a raw #<number> ticket query through IPC unchanged', async () => {
    // The palette only trims the query; the "#" must survive so the backend
    // (runSearchEverything) can run its ticket-number match. This guards
    // against a future change that sanitizes special characters out.
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('#42');
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              (window as unknown as { __mockLastSearchRequest?: { query?: string } })
                .__mockLastSearchRequest?.query,
          ),
        )
        .toBe('#42');
    } finally {
      await browser.close();
    }
  });

  test('conversation hit renders in its own group and Enter opens the viewer', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('auth');
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });

      // The Conversations group heading renders (its list-item also carries the
      // group count, so match the heading row rather than an exact text node).
      await expect(
        page.locator('[data-testid="search-palette-results"] > li', { hasText: 'Conversations' }),
      ).toBeVisible();

      // The conversation row shows the task title.
      const conversationRow = page.locator('[data-result-kind="conversation"]');
      await expect(conversationRow).toContainText('Task with auth in title');

      // The row is deliberately decluttered: no agent name ("Claude Code" - the
      // task title identifies the conversation and the agent shows once opened),
      // no "matched by meaning" sparkle on a keyword hit (it has a highlighted
      // term), and no redundant agent-turn badge (the snippet's "Assistant:"
      // prefix already conveys it).
      await expect(conversationRow).not.toContainText('Claude Code');
      await expect(conversationRow.locator('[aria-label="Matched by meaning"]')).toHaveCount(0);
      await expect(conversationRow).not.toContainText('Agent');

      // Clicking the conversation hit sets the nav signal and opens the viewer.
      // (The one-shot scrollToTurnUuid is set here too, but the viewer consumes it
      // on mount - its scroll-to behavior is covered in conversation-viewer.spec.ts.)
      await conversationRow.click();
      await expect(page.getByTestId('search-palette')).not.toBeVisible();

      await expect
        .poll(async () =>
          page.evaluate(() => {
            const stores = (window as unknown as {
              __zustandStores?: { session: { getState: () => { conversationSessionId: string | null } } };
            }).__zustandStores;
            return stores?.session.getState().conversationSessionId ?? null;
          }),
        )
        .toBe(SESSION_ID);

      await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a pure-semantic conversation hit shows the "matched by meaning" sparkle', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits(false, 'semantic'));
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('auth');
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });

      // Semantic-only hits match by meaning with no highlighted term, so the row
      // flags why it surfaced with the sparkle indicator.
      const conversationRow = page.locator('[data-result-kind="conversation"]');
      await expect(conversationRow.locator('[aria-label="Matched by meaning"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('active conversation hit is badged Terminal and opens the task, not the viewer', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits(true));
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('auth');
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });

      // A live session is badged "Terminal" (not "History") so the user knows
      // selecting it opens the active terminal rather than the read-only history.
      const conversationRow = page.locator('[data-result-kind="conversation"]');
      await expect(conversationRow).toContainText('Terminal');
      await expect(conversationRow).not.toContainText('History');

      // Clicking opens the task detail (the live terminal), NOT the viewer.
      await conversationRow.click();
      await expect(page.getByTestId('search-palette')).not.toBeVisible();

      await expect
        .poll(async () =>
          page.evaluate(() => {
            const stores = (window as unknown as {
              __zustandStores?: {
                session: { getState: () => { detailTaskId: string | null; conversationSessionId: string | null } };
              };
            }).__zustandStores;
            const sessionState = stores?.session.getState();
            return {
              detailTaskId: sessionState?.detailTaskId ?? null,
              conversationSessionId: sessionState?.conversationSessionId ?? null,
            };
          }),
        )
        .toEqual({ detailTaskId: TASK_ID, conversationSessionId: null });

      await expect(page.getByTestId('conversation-window')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Enter on a task hit closes palette and opens detail dialog', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('auth');
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });

      // First result is the project hit; arrow down once to land on the task hit
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');

      // Palette closes
      await expect(page.getByTestId('search-palette')).not.toBeVisible();
      // Task detail dialog opens (its container has data-testid="task-detail-dialog" if present;
      // fall back to checking for the dialog title text)
      await expect(page.locator('text=Task with auth in title').first()).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  // ---------- Mode follows the Memory setting (no per-search toggle) -------

  test('has no per-search mode toggle', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await expect(page.getByTestId('search-palette')).toBeVisible();
      // The Keyword/Smart pill pair is gone; search auto-selects the mode.
      await expect(page.getByTestId('search-mode-toggle')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('with semantic search off, the query runs in keyword mode with no degraded notice', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('auth');
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });

      // Semantic search is off by default, so the search is keyword-only: no
      // degraded notice, and the IPC request carries mode:'keyword'.
      await expect(page.getByTestId('search-degraded-notice')).toHaveCount(0);
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const request = (window as unknown as { __mockLastSearchRequest?: { mode?: string } })
              .__mockLastSearchRequest;
            return request?.mode ?? null;
          }),
        )
        .toBe('keyword');
    } finally {
      await browser.close();
    }
  });

  // ---------- Gap 7: boardSearchFocusNonce dedup guard --------------------

  test('view toggle board->backlog->board does NOT re-steal board-search focus without new Ctrl+F', async () => {
    // This test guards the `lastHandledFocusNonce` ref in ViewToggle.tsx (~lines 70-81).
    // Without the guard, switching backlog->board would fire the useEffect with a stale
    // nonce (still > 0) and re-focus board-search even though the user did not press Ctrl+F.
    // The guard ensures focus is only stolen when the nonce itself ADVANCES.
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Step 1: Ctrl+F on board view - nonce advances from 0 to 1, board-search gets focus
      await page.locator('body').click();
      await page.keyboard.press('Control+f');
      await expect(page.getByTestId('board-search')).toBeFocused();

      // Step 2: Blur the search input (click somewhere neutral)
      await page.locator('body').click();
      await expect(page.getByTestId('board-search')).not.toBeFocused();

      // Step 3: Switch to backlog via the view-toggle button
      await page.getByTestId('view-toggle-backlog').click();
      await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();

      // Step 4: Switch back to board WITHOUT a new Ctrl+F
      await page.getByTestId('view-toggle-board').click();
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 5000 });

      // Intentional fixed wait (negative assertion budget): give React one render
      // cycle (and any pending useEffect) time to fire before we assert non-focus.
      // We cannot poll for "not focused" - the poll would pass immediately if focus
      // has not yet been stolen, hiding a race where it is stolen a tick later.
      await page.waitForTimeout(300);

      // board-search must NOT be focused: the nonce did not advance, so the guard
      // suppressed the focus steal.
      await expect(page.getByTestId('board-search')).not.toBeFocused();

      // Step 5: A fresh Ctrl+F DOES advance the nonce and SHOULD focus board-search
      await page.locator('body').click();
      await page.keyboard.press('Control+f');
      await expect(page.getByTestId('board-search')).toBeFocused();
    } finally {
      await browser.close();
    }
  });

  // ---------- Cross-project navigation: openProject outcome branching -----

  test('a failed cross-project switch leaves the palette open, clears the pending task id, and never leaks the sentinel', async () => {
    // `switchProjectIfNeeded` used to wrap `openProject` in its own try/catch
    // and author its own toast on failure. `openProject` now never throws and
    // reports its own failure; the palette just branches on the returned
    // outcome. This exercises that branch specifically: a cross-project TASK
    // hit whose target project can no longer be opened.
    const { browser, page } = await launchWithState(preConfigCrossProjectTaskHit());
    try {
      const getPageErrors = collectPageErrors(page);

      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await page.evaluate(({ prefix, currentId }) => {
        window.electronAPI.projects.open = async function (id: string) {
          throw new Error(`Error invoking remote method 'project:open': Error: ${prefix}${id}`);
        };
        // The store's not-found branch refetches the list; keep the target
        // project OUT of the refetched list so the toast reads "no longer
        // available" rather than "out of sync" - either copy is a pass below,
        // but pinning the fixture avoids an incidental double-match on the
        // "Could not open" fallback string.
        window.electronAPI.projects.list = async function () {
          return [{
            id: currentId,
            name: 'Current Project',
            path: '/mock/cross-current',
            github_url: null,
            default_agent: 'claude',
            default_model: null,
            default_effort: null,
            group_id: null,
            position: 0,
            last_opened: new Date().toISOString(),
            created_at: new Date().toISOString(),
          }];
        };
      }, { prefix: PROJECT_NOT_FOUND_PREFIX, currentId: CROSS_PROJECT_CURRENT_ID });

      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('cross');
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });

      const taskRow = page.locator('[data-result-kind="task"]');
      await expect(taskRow).toBeVisible();
      await taskRow.click();

      // The toast carries the store's own copy, never the raw IPC error text -
      // pre-fix, the palette's own catch interpolated `error.message`, which
      // would have leaked the PROJECT_NOT_FOUND: sentinel straight into the UI.
      const toast = page.locator('[data-testid="toast"]').filter({ hasText: /no longer available|out of sync/ });
      await expect(toast).toBeVisible({ timeout: 5000 });
      // One-shot count, not toHaveCount(0) - see toastCountRightNow. The visible
      // assertion above is the positive signal that the failure path ran at all.
      expect(await toastCountRightNow(page, PROJECT_NOT_FOUND_PREFIX)).toBe(0);

      // The palette itself: `activate`'s task branch only reaches
      // `requestClose()` when `switchProjectIfNeeded()` resolves true, so a
      // failed switch must leave the overlay open rather than closing over a
      // navigation that never happened. Non-occurrence claim - poll would
      // pass instantly if the close simply has not landed yet, so give it a
      // fixed budget instead.
      await page.waitForTimeout(300);
      await expect(page.getByTestId('search-palette')).toBeVisible();

      // The one-shot pending-open signal, armed before the switch attempt,
      // must be cleared on failure - otherwise a LATER successful open of the
      // same project would jump straight to this stale task id.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const stores = (window as unknown as {
              __zustandStores?: { session: { getState: () => { _pendingOpenTaskId: string | null } } };
            }).__zustandStores;
            return stores?.session.getState()._pendingOpenTaskId ?? null;
          }),
        )
        .toBe(null);

      expect(getPageErrors()).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });
});
