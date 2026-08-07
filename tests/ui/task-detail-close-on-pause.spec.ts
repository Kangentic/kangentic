/**
 * UI tests for closing a task detail window when the user PAUSES its session.
 *
 * Background:
 * Pausing is the user saying "I am done with this task for now". The window
 * used to stay open showing a Resume prompt the user had to dismiss with a
 * second click. It now closes itself.
 *
 * The subtle part is what it is wired to. "Suspended" is reached four ways and
 * only one of them is a user asking for it: the header pause button and its
 * kebab twin. A board move to a todo/done column, the Code Review column, and
 * an app restart with autoResumeSessionsOnRestart=false all reach the same
 * state without a gesture, and none of them may close a window. So the close
 * hangs off the `pausing` branch of `useTaskActions.handleToggle`, never off
 * `session-store.suspendSession` (which the kebab slash-command flow also
 * calls) and never off `displayState.kind === 'suspended'`.
 *
 * The close is eager: it fires as soon as the suspend is STARTED, not when it
 * resolves. Main tears the PTY down inside that call and can spend up to 3s
 * doing it, which would leave the window sitting there for the whole teardown.
 *
 * The tests below are one per wrong implementation, not one per requirement.
 * They are referenced by title rather than by position, so inserting a test
 * cannot silently invalidate this list: "a suspend through the store action
 * alone" fails if the close moves into the store action, "a session that
 * becomes suspended without a gesture" fails if it is keyed off the suspended
 * state, and "a failed suspend still closes the window" fails if a failed
 * suspend swallows its error.
 *
 * Tier: UI (headless Chromium). Everything under test is renderer state plus
 * the window store; no PTY and no real IPC are involved.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Every test launches its own browser: each one drives the window to a
// terminal state (closed, or a patched electronAPI), so a shared page would
// leak state into the next test.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-pause-close-${RUN_ID}`;
const TASK_ID = `task-pause-close-${RUN_ID}`;
const SESSION_ID = `sess-pause-close-${RUN_ID}`;
// A second running task, so the tiled-pane test has two panes to work with.
const SECOND_TASK_ID = `task-pause-close-2-${RUN_ID}`;
const SECOND_SESSION_ID = `sess-pause-close-2-${RUN_ID}`;
const SECOND_TITLE = `Second Pane Task ${RUN_ID}`;

/**
 * Launch a headless page with one task in the Executing lane carrying a
 * session whose initial status is `primarySessionStatus` (defaults to
 * `running`; a test that needs to open the detail window on an already
 * suspended session passes `suspended`). Executing (not To Do) because
 * `canToggle` is false in a todo-role lane, which is what renders the
 * pause/resume control at all. The second task's session (used only by the
 * tiled-pane test) always starts `running`, independent of this parameter.
 */
async function launchWithRunningTask(
  primarySessionStatus: 'running' | 'suspended' = 'running',
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Pause Close Test ${RUN_ID}',
        path: '/mock/pause-close-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-pc-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId,
          position: index,
          created_at: ts,
        }));
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 9999,
        status: '${primarySessionStatus}',
        shell: 'bash',
        cwd: '/mock/pause-close-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });
      state.activityCache['${SESSION_ID}'] = 'idle';

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Pause Close Task ${RUN_ID}',
        description: 'Tests that pausing closes the detail window',
        swimlane_id: executingLaneId,
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        labels: [],
        priority: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      state.sessions.push({
        id: '${SECOND_SESSION_ID}',
        taskId: '${SECOND_TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 9998,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/pause-close-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });
      state.activityCache['${SECOND_SESSION_ID}'] = 'idle';

      state.tasks.push({
        id: '${SECOND_TASK_ID}',
        title: '${SECOND_TITLE}',
        description: 'Second pane for the tiling test',
        swimlane_id: executingLaneId,
        position: 1,
        agent: 'claude',
        session_id: '${SECOND_SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        labels: [],
        priority: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

/** Open the task's detail window and wait for its pause control to render. */
async function openDetailWindow(page: Page) {
  const card = page.locator(`[data-task-id="${TASK_ID}"]`);
  await card.waitFor({ state: 'visible', timeout: 10000 });
  await card.click();

  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await expect(dialog.locator('button[title="Pause session"]')).toBeVisible({ timeout: 10000 });
  return dialog;
}

/**
 * Open the task's detail window for a session that already starts suspended,
 * and confirm the Resume prompt is showing before returning. Callers must
 * stub `sessions.reconcile` to a no-heal no-op BEFORE calling this: the
 * reconcile-on-mount probe in `useTaskSessionState` fires the instant the
 * dialog mounts and sees a 'suspended' session, which is synchronous with
 * this function's own click.
 */
async function openSuspendedDetailWindow(page: Page) {
  const card = page.locator(`[data-task-id="${TASK_ID}"]`);
  await card.waitFor({ state: 'visible', timeout: 10000 });
  await card.click();

  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await expect(dialog.locator('button:has-text("Resume session")')).toBeVisible({ timeout: 10000 });
  return dialog;
}

/** Record kill calls so a test can prove pause suspended rather than killed. */
async function recordKillCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { __killCalls: string[] };
    store.__killCalls = [];
    window.electronAPI.sessions.kill = async (sessionId: string) => {
      store.__killCalls.push(sessionId);
    };
  });
}

/** Read the renderer's cached status for the seeded session. */
async function readSessionStatus(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores: {
        session: { getState: () => { sessions: { taskId: string; status: string }[] } };
      };
    }).__zustandStores;
    const session = stores.session.getState().sessions.find((candidate) => candidate.taskId === id);
    return session ? session.status : null;
  }, taskId);
}

/**
 * Read the renderer-GLOBAL `dialogSessionIds` set: which sessions are
 * currently claimed by an open detail window (see `useTaskSessionState`'s
 * `claimDialogSession` / `releaseDialogSession`, one xterm per PTY). The
 * bottom terminal panel reads this set to decide whether it may mount its
 * own xterm for a session.
 */
async function readDialogSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { session: { getState: () => { dialogSessionIds: string[] } } };
    }).__zustandStores;
    return stores.session.getState().dialogSessionIds;
  });
}

// ---------------------------------------------------------------------------
// The gesture closes the window
// ---------------------------------------------------------------------------

test('pausing from the header button closes the detail window', async () => {
  const { browser, page } = await launchWithRunningTask();
  try {
    const dialog = await openDetailWindow(page);
    await recordKillCalls(page);

    await dialog.locator('button[title="Pause session"]').click();

    // The window animates out, so poll rather than asserting on the next tick.
    await expect(dialog).toBeHidden({ timeout: 10000 });

    // Paused, not killed: the session stays suspended and resumable. Read this
    // from the store, not the dialog - the dialog is gone by now.
    expect(await readSessionStatus(page, TASK_ID)).toBe('suspended');
    const killCalls = await page.evaluate(() => (window as unknown as { __killCalls: string[] }).__killCalls);
    expect(killCalls).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('pausing releases the terminal-ownership claim so the bottom panel can reclaim it', async () => {
  // Before this change, pausing left the window open on the Resume prompt,
  // so the claim on the now-suspended session's id stayed held for as long
  // as the window did - the bottom panel's tab for this task stayed hidden
  // even though nothing was running anymore. `useTaskSessionState` claims
  // and releases `dialogSessionIds` off the LIVE `session?.id` via a
  // `useLayoutEffect` cleanup that fires on unmount - a mechanism this
  // diff does not touch - but pausing is now the first gesture that makes
  // this window unmount on its own, so this is the first test to exercise
  // that release actually happens for THIS trigger. Matches the docs
  // promise: "the session stays paused and resumable from the board".
  const { browser, page } = await launchWithRunningTask();
  try {
    const dialog = await openDetailWindow(page);

    // Baseline: the open window holds the claim.
    await expect.poll(() => readDialogSessionIds(page), { timeout: 10000 }).toContain(SESSION_ID);

    await dialog.locator('button[title="Pause session"]').click();
    await expect(dialog).toBeHidden({ timeout: 10000 });

    // The claim is released once the window actually unmounts, a beat after
    // the dialog element itself goes hidden - poll rather than sampling once.
    await expect.poll(() => readDialogSessionIds(page), { timeout: 10000 }).not.toContain(SESSION_ID);
  } finally {
    await browser.close();
  }
});

test('the window closes without waiting for the suspend to resolve', async () => {
  // Main tears the PTY down inside sessions.suspend: gracefulPtyShutdown gives
  // the agent up to 1500ms to exit, then force-kills and waits up to 1500ms
  // more. Chaining the close to that promise leaves the window sitting there
  // for the whole teardown, which is what this test exists to prevent.
  const { browser, page } = await launchWithRunningTask();
  try {
    const dialog = await openDetailWindow(page);

    await page.evaluate(() => {
      window.electronAPI.sessions.suspend = async () => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
      };
    });

    await dialog.locator('button[title="Pause session"]').click();

    // Comfortably below the 2500ms suspend and well above the 150ms exit
    // animation, so this discriminates eager from chained without being tight.
    await expect(dialog).toBeHidden({ timeout: 1500 });
  } finally {
    await browser.close();
  }
});

test('the closing window never flashes the pause/resume prompt or blanks the terminal', async () => {
  // The window stays mounted for its 150ms fade. Pausing sets pendingAction and
  // flips the session to 'suspended' in the same tick, and TaskDetailBody
  // picks its branch in order: the active-terminal branch is gated on
  // `sessionId && displayKind !== 'queued' && displayKind !== 'suspended'`,
  // and the resume-prompt branch is gated on `(isSuspended || toggling)`. A
  // freeze that misses even one of the four fields those two gates read fails
  // BOTH of them at once, so the body falls through past the resume prompt
  // entirely into its description/empty-state branch: no terminal, no
  // "Resume session", no "Pausing agent" - a blank panel for the whole fade.
  // That fell-through state is invisible to a check that only looks for the
  // two prompt labels, so this also classifies every sampled frame by whether
  // the terminal itself (`.xterm`) is mounted, and asserts the terminal is
  // present on every frame the dialog is, with no gap between "showing the
  // terminal" and "gone".
  const { browser, page } = await launchWithRunningTask();
  try {
    const dialog = await openDetailWindow(page);
    // Terminal init is deferred one animation frame past mount (see
    // useDeferredTerminalInit), so wait for it explicitly rather than assume
    // it has already resolved by the time the pause button is visible - the
    // sampling loop below must start from a known "terminal is mounted"
    // baseline, not race the deferred init.
    await dialog.locator('.xterm').first().waitFor({ state: 'visible', timeout: 10000 });

    const result = await page.evaluate(async () => {
      const dialogNode = () => document.querySelector('[data-testid="task-detail-dialog"]');
      const promptLabels = ['Resume session', 'Pausing agent'];
      let flashedPrompt: string | null = null;
      const checkPrompt = () => {
        const node = dialogNode();
        if (!node || flashedPrompt) return;
        const text = node.textContent ?? '';
        const hit = promptLabels.find((label) => text.includes(label));
        if (hit) flashedPrompt = hit;
      };
      const observer = new MutationObserver(checkPrompt);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      // Classify each sampled frame by what the dialog contains, then keep
      // only the transitions (consecutive duplicates collapsed) - this reads
      // directly as the sequence the user would see fade out.
      const classifyTerminal = () => {
        const node = dialogNode();
        if (!node) return 'GONE';
        return node.querySelector('.xterm') ? 'TERMINAL' : 'NO_TERMINAL';
      };
      const terminalTransitions: string[] = [];
      const recordTerminal = () => {
        const current = classifyTerminal();
        if (terminalTransitions[terminalTransitions.length - 1] !== current) {
          terminalTransitions.push(current);
        }
      };

      recordTerminal();
      const button = dialogNode()?.querySelector('button[title="Pause session"]');
      (button as HTMLButtonElement).click();

      checkPrompt();
      recordTerminal();
      const start = performance.now();
      while (performance.now() - start < 2000) {
        checkPrompt();
        recordTerminal();
        if (!dialogNode()) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      observer.disconnect();
      return { flashedPrompt, terminalTransitions };
    });

    expect(result.flashedPrompt).toBeNull();
    // The dialog is never mounted without its terminal: every recorded
    // transition is either showing the terminal or already gone.
    expect(result.terminalTransitions).not.toContain('NO_TERMINAL');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeHidden({ timeout: 10000 });
  } finally {
    await browser.close();
  }
});

test('closing an already-suspended window keeps its Resume prompt, never a terminal or a blank panel', async () => {
  // `sessionViewRef` is seeded with a hardcoded all-empty default and then
  // overwritten by a live-state effect on every render until a close is
  // requested (see the comment above `sessionViewRef` in TaskDetailWindow).
  // Its own claim is that the snapshot taken at close time is the REAL
  // pre-gesture state, not that hardcoded default - "so that closing an
  // already suspended window keeps its Resume prompt instead of flashing a
  // terminal". Every other test in this file opens on a RUNNING session, so
  // the true pre-gesture snapshot always equals the hardcoded default there
  // and could never catch a regression that swapped one for the other. This
  // is the one scenario that discriminates them: open a window that is
  // ALREADY suspended (so the true snapshot is `{ isSuspended: true,
  // displayKind: 'suspended', ... }`, nothing like the empty default), close
  // it with a plain gesture (not pause, so `toggling` never turns true), and
  // watch every frame of the exit for the Resume prompt to hold.
  const { browser, page } = await launchWithRunningTask('suspended');
  try {
    // The reconcile-on-mount probe fires as soon as the dialog sees a
    // 'suspended' session, so the stub is in place before the dialog opens,
    // exactly like the "becomes suspended without a gesture" test below.
    await page.evaluate(() => {
      window.electronAPI.sessions.reconcile = async () => null;
    });

    const dialog = await openSuspendedDetailWindow(page);

    const result = await page.evaluate(async () => {
      const dialogNode = () => document.querySelector('[data-testid="task-detail-dialog"]');

      // Classify each sampled frame by what the dialog contains, then keep
      // only the transitions (consecutive duplicates collapsed).
      const classify = () => {
        const node = dialogNode();
        if (!node) return 'GONE';
        const text = node.textContent ?? '';
        if (text.includes('Resume session')) return 'RESUME_PROMPT';
        if (node.querySelector('.xterm')) return 'TERMINAL';
        return 'OTHER';
      };
      const transitions: string[] = [];
      const record = () => {
        const current = classify();
        if (transitions[transitions.length - 1] !== current) transitions.push(current);
      };

      record();
      const closeButton = dialogNode()?.querySelector('[data-testid="task-detail-close"]');
      (closeButton as HTMLButtonElement).click();

      record();
      const start = performance.now();
      while (performance.now() - start < 2000) {
        record();
        if (!dialogNode()) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return transitions;
    });

    // Every recorded transition is either the Resume prompt or the dialog
    // being gone - never a terminal, never the blank fell-through panel.
    expect(result).not.toContain('TERMINAL');
    expect(result).not.toContain('OTHER');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeHidden({ timeout: 10000 });
  } finally {
    await browser.close();
  }
});

test('pausing from the kebab menu closes the detail window', async () => {
  const { browser, page } = await launchWithRunningTask();
  try {
    const dialog = await openDetailWindow(page);
    await recordKillCalls(page);

    await dialog.locator('button[title="Actions"]').click();
    // The kebab popover portals to document.body, so it is not inside the
    // dialog: scope by its own testid rather than a page-global locator.
    const menuItem = page.locator('[data-testid="toggle-session-btn"]');
    await expect(menuItem).toBeVisible({ timeout: 5000 });
    await menuItem.click();

    await expect(dialog).toBeHidden({ timeout: 10000 });

    expect(await readSessionStatus(page, TASK_ID)).toBe('suspended');
    const killCalls = await page.evaluate(() => (window as unknown as { __killCalls: string[] }).__killCalls);
    expect(killCalls).toEqual([]);
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Tiled panes: pausing must reconcile the layout exactly like the X button
// ---------------------------------------------------------------------------

interface LayoutSnapshot {
  count: number;
  states: string[];
  hasTileTree: boolean;
  tileRect: { x: number; y: number; w: number; h: number };
}

async function snapshotLayout(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __zustandStores: {
        window: {
          getState: () => {
            windows: Record<string, { state: string }>;
            tileTree: unknown;
            tileTreeRect: { x: number; y: number; w: number; h: number };
          };
        };
      };
    }).__zustandStores.window.getState();
    return {
      count: Object.keys(store.windows).length,
      states: Object.values(store.windows).map((managed) => managed.state).sort(),
      hasTileTree: store.tileTree !== null,
      tileRect: store.tileTreeRect,
    };
  });
}

/**
 * Open both tasks, tile them into columns, then close one pane and finally the
 * last one - snapshotting the window store after each. Driving the identical
 * sequence with `pause` and with `x` lets the test assert they agree, instead of
 * hardcoding tiling semantics this change does not own.
 */
async function tileTwoThenClose(page: Page, how: 'pause' | 'x'): Promise<LayoutSnapshot[]> {
  await openDetailWindow(page);
  // The first window covers the board, so the second card cannot be clicked.
  // `setDetailTaskId` is the shared entry point every card click funnels into
  // (see useTaskDetailWindowBridge), so this opens through the same path.
  await page.evaluate((taskId) => {
    (window as unknown as {
      __zustandStores: { session: { getState: () => { setDetailTaskId: (id: string) => void } } };
    }).__zustandStores.session.getState().setDetailTaskId(taskId);
  }, SECOND_TASK_ID);
  const panes = page.locator('[data-testid="task-detail-dialog"]');
  await expect(panes).toHaveCount(2);

  await page.evaluate(() => {
    (window as unknown as {
      __zustandStores: { window: { getState: () => { applyTilePreset: (preset: string) => void } } };
    }).__zustandStores.window.getState().applyTilePreset('columns');
  });
  await expect
    .poll(async () => (await snapshotLayout(page)).states.filter((state) => state === 'tiled').length)
    .toBe(2);

  const closePane = async (pane: ReturnType<typeof page.locator>) => {
    if (how === 'pause') await pane.locator('button[title="Pause session"]').click();
    else await pane.locator('[data-testid="task-detail-close"]').click();
  };

  await closePane(panes.filter({ hasText: SECOND_TITLE }));
  await expect(panes).toHaveCount(1);
  const afterOne = await snapshotLayout(page);

  await closePane(panes);
  await expect(panes).toHaveCount(0);
  const afterLast = await snapshotLayout(page);

  return [afterOne, afterLast];
}

test('pausing a tiled pane reconciles the layout exactly like the X button', async () => {
  // Two full tile-and-close sequences, so it needs more than the project's 15s.
  test.setTimeout(45_000);
  const { browser, page } = await launchWithRunningTask();
  try {
    // Both sequences start from zero open windows, so running them on one page
    // keeps the comparison honest while paying for a single app boot.
    const viaX = await tileTwoThenClose(page, 'x');
    const viaPause = await tileTwoThenClose(page, 'pause');

    // Closing one of two panes, then the last one. Includes the last-window case
    // the task called out: it must land where a normal last-window close lands.
    expect(viaPause).toEqual(viaX);
    expect(viaPause[1].count).toBe(0);
    expect(viaPause[1].hasTileTree).toBe(false);
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Everything that is not the gesture leaves the window alone
// ---------------------------------------------------------------------------

test('a suspend through the store action alone does NOT close the window', async () => {
  // Guards against moving the close into `session-store.suspendSession`.
  // `handleCommandSelect` (the kebab Commands flyout) suspends through that
  // same action without ever entering `handleToggle`, so a close there would
  // close the window on every slash command.
  const { browser, page } = await launchWithRunningTask();
  try {
    const dialog = await openDetailWindow(page);

    await page.evaluate((id) => {
      const stores = (window as unknown as {
        __zustandStores: {
          session: { getState: () => { suspendSession: (taskId: string) => Promise<void> } };
        };
      }).__zustandStores;
      return stores.session.getState().suspendSession(id);
    }, TASK_ID);

    // The window stays put and simply shows its suspended face.
    await expect(dialog.locator('button:has-text("Resume session")')).toBeVisible({ timeout: 10000 });
    await expect(dialog).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a session that becomes suspended without a gesture does NOT close the window', async () => {
  // Guards against keying the close off `displayState.kind === 'suspended'`.
  // This is how a board move, the Code Review column, and a restart with
  // auto-resume off all present to the renderer: the state changed, nobody
  // clicked anything.
  const { browser, page } = await launchWithRunningTask();
  try {
    const dialog = await openDetailWindow(page);

    await page.evaluate((id) => {
      // The dialog's reconcile-on-mount probe would otherwise heal the state
      // straight back to running, since the mock's PTY registry still has it.
      window.electronAPI.sessions.reconcile = async () => null;
      type MockSession = { taskId: string; status: string };
      const stores = (window as unknown as {
        __zustandStores: {
          session: {
            getState: () => { sessions: MockSession[] };
            setState: (partial: {
              sessions: MockSession[];
              _sessionByTaskId: Map<string, MockSession>;
            }) => void;
          };
        };
      }).__zustandStores;
      const sessions = stores.session.getState().sessions.map((candidate) =>
        candidate.taskId === id ? { ...candidate, status: 'suspended' } : candidate,
      );
      // The store keeps a taskId -> Session index alongside the array and
      // rebuilds it on every mutation; writing the array alone leaves consumers
      // reading the stale entry.
      stores.session.setState({
        sessions,
        _sessionByTaskId: new Map(sessions.map((candidate) => [candidate.taskId, candidate])),
      });
    }, TASK_ID);

    await expect(dialog.locator('button:has-text("Resume session")')).toBeVisible({ timeout: 10000 });
    await expect(dialog).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a failed suspend still closes the window but surfaces the error', async () => {
  // The close is eager, so a rejection cannot hold the window open - it has
  // already gone by the time the promise settles. What must survive is the
  // error: a pause that silently did nothing is the failure mode that matters.
  const { browser, page } = await launchWithRunningTask();
  try {
    const dialog = await openDetailWindow(page);

    await page.evaluate(() => {
      window.electronAPI.sessions.suspend = async () => {
        throw new Error('PTY refused to stop');
      };
    });

    await dialog.locator('button[title="Pause session"]').click();

    const toast = page.locator('[data-testid="toast"]', { hasText: 'Failed to suspend session' });
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText('PTY refused to stop');
    await expect(dialog).toBeHidden({ timeout: 10000 });
  } finally {
    await browser.close();
  }
});
