/**
 * UI tests proving a docked conversation window persists across a project switch, like a
 * task-detail window (Defect B: previously conversation windows were excluded from
 * `serializeWorkspace` and closed whenever `conversationSessionId` was nulled by a switch, so a
 * docked panel vanished and never came back).
 *
 * The feature under test:
 *   - `serializeWorkspace` no longer filters out `kind === 'conversation'` windows.
 *   - `useProjectSwitchEffect` closes the OUTGOING project's conversation windows explicitly
 *     (after persisting them), so a carried-over window never ghosts onto the next project.
 *   - `restoreWorkspaceForProject` -> `applyWorkspace` -> `deserializeWorkspace` restores a
 *     conversation window at its saved geometry, with a kind-aware `isKnownAnchor` that always
 *     treats a conversation leaf's session-id anchor as known (never checked against the board),
 *     so it survives restore - and a tile tree it shares with a task-detail window is never
 *     dropped.
 *   - A restored window whose session no longer exists shows the viewer's own empty state
 *     (`ConversationView` renders `source === 'none'`) rather than lingering wrongly or dropping
 *     the surrounding layout.
 *   - Restored windows still paint flat (`skipEnterAnimation: true`, no `overlay-content-in`),
 *     mirroring `window-no-entrance-animation-on-restore.spec.ts`.
 *
 * Determinism (per .claude/rules/cross-platform-parity.md): every assertion reads programmatic
 * store state (the window list, its `kind`/`geometry`/`skipEnterAnimation`) or a stable
 * data-testid/class, never sub-frame pixels or animation timing.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'proj-convrestore-a';
const PROJECT_B_ID = 'proj-convrestore-b';
const SESSION_ID_A = 'sess-convrestore-a';

const PROJECT_GUARD_ID = 'proj-convrestore-guard';
const TASK_ID_GUARD = 'task-convrestore-guard';
const GONE_SESSION_ID = 'sess-convrestore-gone';

/** A REPOSITIONED geometry distinct from any default cascade placement, so restoring it back
 *  (rather than a coincidental fresh re-open) is unambiguous. */
const REPOSITIONED_GEOMETRY = { x: 0.22, y: 0.18, w: 0.31, h: 0.42 };

/** A persisted workspace for the guard project: a task-detail window tiled with a conversation
 *  window whose session id ('sess-convrestore-gone') has no live board task and no transcript -
 *  it must still survive restore (kind-aware isKnownAnchor) and render its own empty state,
 *  without dropping the task-detail sibling sharing the tile tree. */
const GUARD_WORKSPACE = {
  version: 1,
  windows: [
    {
      taskId: TASK_ID_GUARD,
      kind: 'task-detail',
      title: 'Guard Task',
      geometry: { x: 0, y: 0, w: 0.5, h: 1 },
      restoreGeometry: null,
      state: 'tiled',
    },
    {
      taskId: GONE_SESSION_ID,
      kind: 'conversation',
      title: 'Conversation',
      geometry: { x: 0.5, y: 0, w: 0.5, h: 1 },
      restoreGeometry: null,
      state: 'tiled',
    },
  ],
  tileTree: {
    kind: 'split',
    direction: 'horizontal',
    children: [
      { kind: 'leaf', taskId: TASK_ID_GUARD },
      { kind: 'leaf', taskId: GONE_SESSION_ID },
    ],
    sizes: [0.5, 0.5],
  },
  tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
  focusedTaskId: null,
};

const CONFIG_OVERRIDES = JSON.stringify({
  workspaceByProject: {
    [PROJECT_GUARD_ID]: GUARD_WORKSPACE,
  },
});

function preConfigScript(startProjectId: string): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      ['${PROJECT_A_ID}', '${PROJECT_B_ID}', '${PROJECT_GUARD_ID}'].forEach(function (id) {
        state.projects.push({
          id: id, name: 'Conversation Restore ' + id, path: '/mock/' + id,
          github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
        });
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-convrestore-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${TASK_ID_GUARD}', title: 'Guard Task', description: '',
        swimlane_id: 'lane-convrestore-to-do', position: 0, agent: null, session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
        projectId: '${PROJECT_GUARD_ID}',
      });

      return { currentProjectId: '${startProjectId}' };
    });
  `;
}

async function launch(startProjectId: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Seed config.workspaceByProject BEFORE the mock module evaluates.
  await page.addInitScript(`window.__mockConfigOverrides = ${CONFIG_OVERRIDES};`);
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript(startProjectId));
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

type ManagedWindowLike = {
  id: string;
  kind: string;
  anchor: string;
  geometry: { x: number; y: number; w: number; h: number };
  skipEnterAnimation?: boolean;
};

type ZustandStores = {
  project: {
    getState: () => {
      projects: Array<{ id: string }>;
      openProject: (id: string) => Promise<void>;
    };
  };
  session: {
    getState: () => { setConversationSessionId: (id: string | null) => void };
  };
  window: {
    getState: () => {
      windows: Record<string, ManagedWindowLike>;
      setGeometry: (id: string, geometry: { x: number; y: number; w: number; h: number }) => void;
    };
  };
};

/** Switch the active project via the real `openProject` action (mirrors a sidebar click) rather
 *  than a raw `setState` on `currentProject`: `openProject` calls `electronAPI.projects.open(id)`
 *  first, which is what updates the mock's ambient current-project id that `tasks.list()` filters
 *  by - a raw `setState` bypass would leave the board store's `tasks` scoped to whichever project
 *  was active at boot, breaking the guard test's task-detail `isKnownAnchor` check below. */
async function switchToProject(page: Page, projectId: string): Promise<void> {
  await page.evaluate(async (targetId) => {
    const stores = (window as unknown as { __zustandStores?: ZustandStores }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    await stores.project.getState().openProject(targetId);
  }, projectId);
}

async function openConversationLive(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((sessionIdArg) => {
    const stores = (window as unknown as { __zustandStores?: ZustandStores }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    stores.session.getState().setConversationSessionId(sessionIdArg);
  }, sessionId);
  await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 5000 });
}

async function findConversationWindow(page: Page): Promise<ManagedWindowLike | undefined> {
  return page.evaluate(() => {
    const stores = (window as unknown as { __zustandStores?: ZustandStores }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    return Object.values(stores.window.getState().windows).find((managedWindow) => managedWindow.kind === 'conversation');
  });
}

async function setConversationGeometry(
  page: Page,
  windowId: string,
  geometry: { x: number; y: number; w: number; h: number },
): Promise<void> {
  await page.evaluate(
    ({ windowId: id, geometry: rect }) => {
      const stores = (window as unknown as { __zustandStores?: ZustandStores }).__zustandStores;
      if (!stores) throw new Error('window.__zustandStores not exposed');
      stores.window.getState().setGeometry(id, rect);
    },
    { windowId, geometry },
  );
}

test.describe('conversation window persistence across a project switch', () => {
  test('a conversation window opened live in project A closes on switch-away (no ghost on B), and restores at its saved geometry on switch-back', async () => {
    const { browser, page } = await launch(PROJECT_A_ID);
    try {
      // Open the conversation live in project A, then move it to a distinctive geometry so the
      // eventual restore is provably the SAVED layout, not a coincidental fresh re-open.
      await openConversationLive(page, SESSION_ID_A);
      const opened = await findConversationWindow(page);
      expect(opened).toBeDefined();
      await setConversationGeometry(page, opened!.id, REPOSITIONED_GEOMETRY);

      // Switch away to B (which has NO persisted workspace at all): the outgoing window must be
      // captured into A's blob and then closed - it must never appear on B.
      await switchToProject(page, PROJECT_B_ID);
      await expect
        .poll(async () => (await findConversationWindow(page)) === undefined, { timeout: 5000 })
        .toBe(true);
      await expect(page.getByTestId('conversation-window')).toHaveCount(0);

      // Switch back to A: the conversation window must restore, docked at the geometry it had
      // when we left, painting flat (no entrance replay).
      await switchToProject(page, PROJECT_A_ID);
      await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 5000 });

      await expect
        .poll(async () => (await findConversationWindow(page))?.geometry, { timeout: 5000 })
        .toEqual(REPOSITIONED_GEOMETRY);

      const restored = await findConversationWindow(page);
      expect(restored?.skipEnterAnimation).toBe(true);
      expect(restored?.anchor).toBe(SESSION_ID_A);

      const restoredFrame = page.locator(`[data-testid="window-frame-${restored!.id}"]`);
      await expect(restoredFrame).not.toHaveClass(/overlay-content-in/);
    } finally {
      await browser.close();
    }
  });

  test('clearing the conversation signal directly (no project switch) leaves the window open', async () => {
    // Pins the bridge's current contract (useConversationWindowBridge.ts header comment): the
    // signal means "open/focus this conversation now", not "this window should exist" - existence
    // is owned by the workspace blob. So a direct `setConversationSessionId(null)`, with NO project
    // switch involved, must NOT close the window; only `useProjectSwitchEffect`'s explicit close
    // loop (exercised by the switch-away test above) does that. Reverting the bridge to its old
    // closeWindow-on-clear behavior must turn this red: today the only other test that nulls the
    // signal does so via a project switch, where the explicit close loop closes the window first,
    // so a bridge regression there produces zero observable difference in the existing suite.
    const { browser, page } = await launch(PROJECT_A_ID);
    try {
      await openConversationLive(page, SESSION_ID_A);
      const opened = await findConversationWindow(page);
      expect(opened).toBeDefined();

      await page.evaluate(() => {
        const stores = (window as unknown as { __zustandStores?: ZustandStores }).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        stores.session.getState().setConversationSessionId(null);
      });

      // Intentional fixed wait, not a poll: this pins an ABSENCE (the bridge no longer closes the
      // window on a null signal). There is no observable condition to poll for "no close
      // happened", so give any latent close effect a budget before asserting the window survived.
      await page.waitForTimeout(500);

      await expect(page.getByTestId('conversation-window')).toBeVisible();
      const stillOpen = await findConversationWindow(page);
      expect(stillOpen?.id).toBe(opened!.id);
    } finally {
      await browser.close();
    }
  });

  test('a restored conversation window whose session no longer exists shows the empty state without dropping its tiled task-detail sibling', async () => {
    const { browser, page } = await launch(PROJECT_A_ID);
    try {
      // Cold switch into the guard project: its persisted workspace tiles a task-detail window
      // with a conversation window anchored on a session id that is not a board task and has no
      // transcript at all.
      await switchToProject(page, PROJECT_GUARD_ID);

      await expect(page.getByTestId('conversation-window')).toBeVisible({ timeout: 8000 });
      // The whole tile tree survives: both windows are present, not just the conversation one.
      await expect(page.locator('[data-testid^="window-frame-"]')).toHaveCount(2, { timeout: 8000 });

      // The gone session shows the viewer's own empty/unavailable state - it does not linger
      // showing a loading spinner forever, nor does it vanish and drop the tile tree.
      await expect(page.getByTestId('conversation-empty')).toBeVisible({ timeout: 8000 });

      const restored = await findConversationWindow(page);
      expect(restored?.anchor).toBe(GONE_SESSION_ID);
      expect(restored?.skipEnterAnimation).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
