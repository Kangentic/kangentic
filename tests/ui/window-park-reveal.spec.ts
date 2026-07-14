/**
 * UI test for parked-terminal PTY write gating with scrollback catch-up on
 * reveal (the windowed-terminals scaling defense).
 *
 * A task-detail window parked on the Backlog view must: (1) drop out of the
 * focused-session set pushed to main (main stops emitting its PTY data), (2)
 * ack-and-discard any live bytes that still reach its incoming write queue
 * (never parse them into the hidden xterm), and (3) on reveal (switching back
 * to Board), repaint the terminal from scrollback exactly once - correct
 * content, no blank terminal, no duplicated frames.
 *
 * The WebGL LRU budget is unit-tested in tests/unit/terminal-webgl.test.ts;
 * this spec launches with WebGL disabled (see launchWithState) so xterm uses
 * its DOM renderer and terminal content is assertable as text. It asserts
 * content, store state, and the setFocused IPC log - never pixels.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-window-park-reveal';
const TASK_ID = 'task-window-park-reveal';
const SESSION_ID = 'sess-window-park-reveal';

const INITIAL_CONTENT = 'INITIAL-SCROLLBACK-FRAME';
const CAUGHT_UP_CONTENT = 'CAUGHT-UP-WHILE-PARKED';
const LIVE_WHILE_PARKED = 'LIVE-BYTES-WHILE-PARKED';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Window Park Reveal Test',
      path: '/mock/window-park-reveal-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so the task-detail window opens with a live terminal.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/window-park-reveal-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'Park Reveal Task',
      description: 'Task used to verify park -> reveal scrollback catch-up',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/window-park-reveal',
      branch_name: 'feature/window-park-reveal',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

interface TestWindow {
  __scrollbackValue?: string;
  __mockFireSessionData?: (sessionId: string, data: string) => void;
  __zustandStores?: {
    session?: {
      getState: () => {
        markFirstOutput: (id: string) => void;
        resumeSession: (taskId: string) => Promise<{ id: string }>;
      };
    };
    window?: {
      getState: () => { windows: Record<string, { anchor: string; sessionId: string | null }> };
    };
  };
  electronAPI?: {
    sessions: {
      getScrollback: (sessionId: string) => Promise<string>;
      __setFocusedCalls: string[][];
    };
  };
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  // Disable WebGL so xterm renders through its DOM renderer (`.xterm-rows`
  // text nodes) and terminal CONTENT is assertable as text. With WebGL
  // available (headless Chromium ships SwiftShader), xterm paints to a canvas
  // and innerText is empty. The WebGL budget itself is unit-tested in
  // tests/unit/terminal-webgl.test.ts; this spec is about park/reveal content.
  const browser = await chromium.launch({ headless: true, args: ['--disable-webgl', '--disable-webgl2'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

test.describe('Parked window: PTY drop while parked, scrollback catch-up on reveal', () => {
  test('backlog-parked terminal drops live bytes and repaints from scrollback on reveal', async () => {
    const { browser, page } = await launchWithState(preConfig);
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

      // Flip terminalReady (lifts the startup overlay so xterm mounts
      // unsuppressed) and point getScrollback at a mutable value the test
      // updates to model main's ring buffer accumulating while parked.
      await page.evaluate(
        ({ sessionId, initialContent }) => {
          const testWindow = window as unknown as TestWindow;
          testWindow.__zustandStores?.session?.getState().markFirstOutput(sessionId);
          testWindow.__scrollbackValue = `${initialContent}\r\n`;
          if (testWindow.electronAPI) {
            testWindow.electronAPI.sessions.getScrollback = async () =>
              (window as unknown as TestWindow).__scrollbackValue ?? '';
          }
        },
        { sessionId: SESSION_ID, initialContent: INITIAL_CONTENT },
      );

      // Open the task-detail window; the mount-time replay paints the initial frame.
      await page
        .locator('[data-swimlane-name="Code Review"]')
        .locator('text=Park Reveal Task')
        .first()
        .click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await dialog.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 10000 });
      await expect
        .poll(async () => dialog.locator('.xterm').first().innerText(), { timeout: 10000 })
        .toContain(INITIAL_CONTENT);

      // Park: switch to Backlog. The window stays attached (PTY alive) but the
      // session must leave the focused set (main stops emitting its data).
      await page.locator('[data-testid="view-toggle-backlog"]').click();
      await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();
      await expect(dialog).toBeAttached();
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const calls = (window as unknown as TestWindow).electronAPI?.sessions.__setFocusedCalls ?? [];
              return calls.length > 0 ? calls[calls.length - 1] : null;
            }),
          { timeout: 5000 },
        )
        .not.toContain(SESSION_ID);

      // Live bytes still reaching the renderer while parked (the mock has no
      // focus gate, which conveniently exercises the renderer's own drop gate):
      // the parked queue must ack-and-discard them, never write them to xterm.
      // Model main's ring accumulating by extending the scrollback the reveal
      // will fetch.
      await page.evaluate(
        ({ sessionId, liveData, initialContent, caughtUpContent }) => {
          const testWindow = window as unknown as TestWindow;
          testWindow.__mockFireSessionData?.(sessionId, `${liveData}\r\n`);
          testWindow.__scrollbackValue = `${initialContent}\r\n${caughtUpContent}\r\n`;
        },
        {
          sessionId: SESSION_ID,
          liveData: LIVE_WHILE_PARKED,
          initialContent: INITIAL_CONTENT,
          caughtUpContent: CAUGHT_UP_CONTENT,
        },
      );

      // Reveal: switch back to Board. The reveal-edge reloadScrollback must
      // repaint from the (updated) scrollback: catch-up content present, the
      // initial frame exactly once (xterm.reset() before replay - no
      // duplicated frames), and the dropped live bytes absent (superseded by
      // the drained scrollback).
      await page.locator('[data-testid="view-toggle-board"]').click();
      await expect(dialog).toBeVisible();
      await expect
        .poll(async () => dialog.locator('.xterm').first().innerText(), { timeout: 10000 })
        .toContain(CAUGHT_UP_CONTENT);

      const revealedText = await dialog.locator('.xterm').first().innerText();
      expect(revealedText).not.toContain(LIVE_WHILE_PARKED);
      const initialOccurrences = revealedText.split(INITIAL_CONTENT).length - 1;
      expect(initialOccurrences).toBe(1);

      // The session is focused again (main resumes emitting for it).
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const calls = (window as unknown as TestWindow).electronAPI?.sessions.__setFocusedCalls ?? [];
              return calls.length > 0 ? calls[calls.length - 1] : null;
            }),
          { timeout: 5000 },
        )
        .toContain(SESSION_ID);
    } finally {
      await browser.close();
    }
  });
});

/**
 * Coordinator regression coverage: `useFocusedSessionsSync` resolves a board
 * task-detail window's LIVE session by anchor (the taskId) from the CURRENT
 * session list, not from the window store's `sessionId` field - that field is
 * captured once at `openWindow` time and never updated (see window-store.ts's
 * `OpenWindowInput`), so it goes stale the moment the task's session respawns
 * (an isolated-swimlane switch, or a suspend/resume) while the window stays
 * open. A regression back to keying the visibility plan off the stale field
 * would silently keep parking/focusing the OLD (superseded) session id
 * instead of the new live one.
 *
 * `dialogSessionIds` (which gates the setFocused IPC directly) is resolved
 * correctly by a SEPARATE hook (`useWindowSessionClaims`), so a plain "is the
 * new session focused" check would pass even with the coordinator bug - the
 * bug only shows up in the PARK gate: `deriveFocusedSessionIds` excludes a
 * dialogSessionIds entry from the focused set only when the coordinator's OWN
 * resolution placed that same session id in `parkedSessionIds`. So the
 * discriminating assertion is "the respawned session drops out of the focused
 * set once its window is parked" - with the stale-field bug, the OLD
 * (superseded) session id gets parked instead, and the new live session never
 * leaves the focused set.
 */
const RESPAWN_PROJECT_ID = 'proj-window-park-respawn';
const RESPAWN_TASK_ID = 'task-window-park-respawn';
const RESPAWN_SESSION_ID_INITIAL = 'sess-window-park-respawn-initial';
const RESPAWN_TASK_TITLE = 'Respawn Anchor Task';

const respawnPreConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${RESPAWN_PROJECT_ID}',
      name: 'Window Park Respawn Test',
      path: '/mock/window-park-respawn-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so the task-detail window opens with a live terminal.
    state.sessions.push({
      id: '${RESPAWN_SESSION_ID_INITIAL}',
      taskId: '${RESPAWN_TASK_ID}',
      projectId: '${RESPAWN_PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/window-park-respawn-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${RESPAWN_TASK_ID}',
      display_id: 1,
      title: '${RESPAWN_TASK_TITLE}',
      description: 'Task used to verify the coordinator resolves the live session by anchor',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${RESPAWN_SESSION_ID_INITIAL}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${RESPAWN_PROJECT_ID}' };
  });
`;

test.describe('Parked window: board session resolved by anchor, not the stale window field', () => {
  test('a respawned session parks/focuses by its live id, ignoring the window store\'s stale captured sessionId', async () => {
    const { browser, page } = await launchWithState(respawnPreConfig);
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

      // Open the task-detail window; it captures the INITIAL live session id
      // into the window store's `sessionId` field (never updated again).
      await page
        .locator('[data-swimlane-name="Code Review"]')
        .locator(`text=${RESPAWN_TASK_TITLE}`)
        .first()
        .click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      const lastSetFocusedCall = async (): Promise<string[] | null> =>
        page.evaluate(() => {
          const calls = (window as unknown as TestWindow).electronAPI?.sessions.__setFocusedCalls ?? [];
          return calls.length > 0 ? calls[calls.length - 1] : null;
        });

      // Baseline: the initial session is focused before any respawn.
      await expect.poll(lastSetFocusedCall, { timeout: 5000 }).toContain(RESPAWN_SESSION_ID_INITIAL);

      // Respawn: drive the same store action a real Resume click fires. This
      // replaces the task's live session with a brand-new id (mirrors an
      // isolated-swimlane switch or a suspend/resume while the window is open).
      const respawnedSessionId = await page.evaluate(async (taskId) => {
        const sessionStore = (window as unknown as TestWindow).__zustandStores?.session;
        if (!sessionStore) throw new Error('session store not exposed for testing');
        const newSession = await sessionStore.getState().resumeSession(taskId);
        return newSession.id;
      }, RESPAWN_TASK_ID);
      expect(respawnedSessionId).not.toBe(RESPAWN_SESSION_ID_INITIAL);

      // The new live session becomes focused (dialogSessionIds is resolved by
      // anchor in a separate hook, useWindowSessionClaims, so this much would
      // pass even with the coordinator bug this test targets).
      await expect.poll(lastSetFocusedCall, { timeout: 5000 }).toContain(respawnedSessionId);

      // Sanity check on the premise: the window store's OWN `sessionId` field
      // is still the OLD id - proving this scenario actually exercises the
      // anchor-resolution code path rather than coincidentally matching.
      const staleWindowSessionId = await page.evaluate((taskId) => {
        const windowStore = (window as unknown as TestWindow).__zustandStores?.window;
        const windows = windowStore?.getState().windows ?? {};
        const match = Object.values(windows).find((candidate) => candidate.anchor === taskId);
        return match ? match.sessionId : undefined;
      }, RESPAWN_TASK_ID);
      expect(staleWindowSessionId).toBe(RESPAWN_SESSION_ID_INITIAL);

      // Park: switch to Backlog. The coordinator must resolve the window's
      // LIVE session (the respawned id) - not the stale captured field - so
      // the RESPAWNED session is the one that leaves the focused set.
      await page.locator('[data-testid="view-toggle-backlog"]').click();
      await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();
      await expect(dialog).toBeAttached();
      await expect.poll(lastSetFocusedCall, { timeout: 5000 }).not.toContain(respawnedSessionId);

      // Reveal: switch back to Board. The respawned session is focused again.
      await page.locator('[data-testid="view-toggle-board"]').click();
      await expect(dialog).toBeVisible();
      await expect.poll(lastSetFocusedCall, { timeout: 5000 }).toContain(respawnedSessionId);
    } finally {
      await browser.close();
    }
  });
});
