/**
 * Regression spec: a background terminal must not steal keyboard focus from a
 * just-opened task detail.
 *
 * The bug. Opening a task detail claims that task's session, so the bottom panel
 * drops its tab and falls back to a DIFFERENT running session, mounting a fresh
 * terminal for it moments after the detail window mounts its own. Both then fetch
 * scrollback, which real main delays 150-400ms while the agent TUI's repaint
 * settles, and both used to end in an unconditional `xterm.focus()`. Whichever
 * replay resolved LAST won, so the user opened a task, started typing, and the
 * keystrokes went to whatever agent the panel happened to fall back to. The
 * reported case typed `/compact` into the wrong session.
 *
 * Why the ordering has to be forced. The defect only appears when the background
 * terminal's replay resolves AFTER the detail's, which in production is a genuine
 * race. `window.__mockScrollbackDelayMs` (see `getScrollback` in
 * mock-electron-api.js) pins that order so the spec tests the losing case every
 * run rather than half the time.
 *
 * Why the waits are causal, not timed. `TerminalTab` renders
 * `data-testid="terminal-replay-veil"` until its scrollback settles, so a pane's
 * veil disappearing IS that pane's replay resolving. `settleScrollback` runs one
 * frame before the focus call it guards, so waiting for the veil to clear lands
 * exactly where the steal used to happen. No `waitForTimeout` anywhere
 * (.claude/rules/cross-platform-parity.md).
 *
 * How to verify RED / GREEN:
 *  - Spec 1: drop either arrival gate - the `mayTakeArrivalFocusRef` check in
 *    `useTerminal.ts`'s mount-replay frame, or the `mayFocusOnArrival()` check in
 *    `TerminalTab.tsx`'s active effect - and the delayed panel replay takes focus,
 *    failing the final two assertions.
 *  - Spec 2: remove the `claimArrivalFocus` call from `selectActiveSession` in
 *    `session-store.ts` and the clicked tab's terminal never gets focus, because
 *    the arbiter resolves the still-focused detail window instead.
 *  - Spec 3: remove the `claimArrivalFocus` call from `onToggleCollapse` in
 *    `useTerminalResize.ts` and the re-expanded panel's terminal never gets focus,
 *    for the same reason. That claim looks redundant until you notice `showContent`
 *    gates whether the panel mounts a `TerminalTab` at all, so an expand IS an
 *    arrival.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT_ID = `proj-arrival-${RUN_ID}`;

/** The task whose detail is opened. Its session starts as the panel's selection,
 *  so opening it is what evicts the panel and forces the fallback mount. */
const TASK_DETAIL = `task-arrival-detail-${RUN_ID}`;
const SESSION_DETAIL = `sess-arrival-detail-${RUN_ID}`;
/** The session the panel falls back to. Delayed, so it replays LAST. */
const TASK_FALLBACK = `task-arrival-fallback-${RUN_ID}`;
const SESSION_FALLBACK = `sess-arrival-fallback-${RUN_ID}`;
/** A third session, so spec 2 has a tab to click that is not already selected. */
const TASK_OTHER = `task-arrival-other-${RUN_ID}`;
const SESSION_OTHER = `sess-arrival-other-${RUN_ID}`;

const FALLBACK_REPLAY_DELAY_MS = 250;

/**
 * Viewport and panel height are chosen together so a default-placed detail window
 * cannot cover the bottom panel's tab bar. A window occupies the middle 70% of the
 * overlay (`defaultWindowGeometry`), so its lower edge sits at 85% of the overlay
 * height; the panel needs to be shorter than the remaining 15% to stay clear.
 * At 1500px tall the overlay is ~1424px, so 15% is ~213px against this 150px
 * panel - about 60px of clearance.
 */
const VIEWPORT = { width: 1600, height: 1500 };
const PANEL_HEIGHT_PX = 150;

/** Comfortably under the tier's 15s per-test timeout, so a failing wait reports
 *  its own error instead of being swallowed by the test cap. */
const STEP_TIMEOUT_MS = 8000;

function preConfig(): string {
  return `
    // Force the losing order: the panel's fallback terminal resolves its replay
    // after the detail window's, which is the arrangement that used to steal focus.
    window.__mockScrollbackDelayMs = { '${SESSION_FALLBACK}': ${FALLBACK_REPLAY_DELAY_MS} };

    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      // A detail window is always 70% of the overlay's height, centered, so with
      // the default 250px panel it lands on top of the panel's tab bar and the
      // tab click below can never reach it. Shrinking the panel puts the tab bar
      // clear of the window's lower edge at this spec's viewport height. See
      // PANEL_HEIGHT_PX / the viewport in launch().
      state.config.terminal.panelHeight = ${PANEL_HEIGHT_PX};
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Arrival Focus ${RUN_ID}',
        path: '/mock/arrival-focus-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-af-${RUN_ID}-' + index;
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId, position: index, created_at: ts,
        }));
      });

      function addTask(taskId, sessionId, title, pid, position) {
        state.sessions.push({
          id: sessionId,
          taskId: taskId,
          projectId: '${PROJECT_ID}',
          pid: pid,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/arrival-focus-${RUN_ID}',
          startedAt: ts,
          exitCode: null,
          resuming: false,
        });
        state.tasks.push({
          id: taskId,
          display_id: position + 1,
          title: title,
          description: '',
          swimlane_id: executingLaneId,
          position: position,
          agent: 'claude',
          session_id: sessionId,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });
      }

      // Pushed first, so it is the panel's initial selection: the only IDLE one
      // wins derivePanelSessionId's "prefer an idle visible session" rule.
      addTask('${TASK_DETAIL}', '${SESSION_DETAIL}', 'Arrival Detail ${RUN_ID}', 7200, 0);
      addTask('${TASK_FALLBACK}', '${SESSION_FALLBACK}', 'Arrival Fallback ${RUN_ID}', 7201, 1);
      addTask('${TASK_OTHER}', '${SESSION_OTHER}', 'Arrival Other ${RUN_ID}', 7202, 2);

      // Both remaining sessions are 'thinking', so once the detail's session is
      // evicted the fallback is the FIRST visible one - deterministic, rather than
      // depending on which of two idle candidates is picked.
      state.activityCache['${SESSION_DETAIL}'] = 'idle';
      state.activityCache['${SESSION_FALLBACK}'] = 'thinking';
      state.activityCache['${SESSION_OTHER}'] = 'thinking';

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig());
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 10000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page };
}

/**
 * Lift each session's launch overlay so `TerminalTab` mounts a real xterm.
 *
 * Called BEFORE the detail is opened, deliberately. Lifting the overlay on an
 * already-mounted terminal triggers a second, later arrival (the overlay-lift
 * reload), which would land after the mount replay this spec is timing against
 * and make the veil an unreliable marker for "the steal has now had its chance".
 * Marking first, as a long-running session would already be, leaves each freshly
 * mounted terminal with exactly one arrival.
 */
async function markFirstOutput(page: Page, sessionIds: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session?: { getState: () => { markFirstOutput: (id: string) => void } };
      };
    }).__zustandStores;
    for (const id of ids) stores?.session?.getState().markFirstOutput(id);
  }, sessionIds);
}

/**
 * Let the frame that a settled replay schedules its focus on actually run.
 *
 * `settleScrollback` (which clears the veil) and the `requestAnimationFrame` that
 * calls `focus()` are one beat apart, so observing the veil gone in the DOM does
 * not guarantee the focus call has happened yet. Asserting in that gap would let a
 * broken build pass. Two frames is a causal wait on the browser's own scheduler,
 * not a wall-clock sleep, so it stays within cross-platform-parity's ban on
 * `waitForTimeout`.
 */
async function settleFocusFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
  );
}

test('a delayed background replay does not steal focus from a just-opened task detail', async () => {
  const { browser, page } = await launch();
  try {
    // The panel starts on the detail task's session (the only idle one).
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await markFirstOutput(page, [SESSION_DETAIL, SESSION_FALLBACK]);

    // Open the detail. This claims its session, so the panel drops that tab and
    // mounts a fresh terminal for the fallback session.
    await page.locator(`text=Arrival Detail ${RUN_ID}`).first().click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

    const frame = page.locator('[data-testid^="window-frame-"]').filter({ has: dialog });
    const detailTextarea = frame.locator('.xterm-helper-textarea').first();
    // Addressed by session, not by the bare testid: the panel swaps its mounted
    // pane during the eviction, and the OUTGOING pane has already settled - so a
    // bare-testid wait would resolve before the fallback terminal even mounts,
    // long before the steal it is supposed to be timing against.
    const fallbackPane = page.locator(
      `[data-testid="terminal-session-pane"][data-session-id="${SESSION_FALLBACK}"]`,
    );
    const fallbackTextarea = fallbackPane.locator('.xterm-helper-textarea').first();
    const fallbackVeil = fallbackPane.locator('[data-testid="terminal-replay-veil"]');

    // The fallback terminal really did mount. Without this the whole spec could
    // pass simply because no competing terminal ever existed.
    await fallbackTextarea.waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });

    // ...and its replay is genuinely still IN FLIGHT. This is the spec's own
    // self-defense: `toHaveCount(0)` below is also satisfied by a veil that was
    // never there, so if the forced delay ever stopped applying (a mock-API
    // change, a renamed session id) the race would go unexercised while every
    // assertion still passed. Checked here, at the earliest moment the pane
    // exists and before any wait on the detail's own replay, so the delay window
    // is barely consumed.
    await fallbackVeil.waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });

    // The detail's replay settles first (the fallback's is delayed).
    await expect(frame.locator('[data-testid="terminal-replay-veil"]')).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });

    // Checkpoint BEFORE the delayed replay lands. Separates "the gate focused the
    // right terminal" from "the gate focused nothing", which the final assertion
    // alone cannot distinguish without burning its full retry budget.
    await expect(detailTextarea).toBeFocused({ timeout: STEP_TIMEOUT_MS });

    // Now let the delayed replay finish. This is the moment of the steal.
    await expect(fallbackVeil).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });
    await settleFocusFrames(page);

    await expect(detailTextarea).toBeFocused();
    await expect(fallbackTextarea).not.toBeFocused();
  } finally {
    await browser.close();
  }
});

test('clicking a bottom-panel tab still focuses its terminal while a detail window is open', async () => {
  const { browser, page } = await launch();
  try {
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

    await page.locator(`text=Arrival Detail ${RUN_ID}`).first().click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

    await markFirstOutput(page, [SESSION_DETAIL, SESSION_FALLBACK, SESSION_OTHER]);

    const frame = page.locator('[data-testid^="window-frame-"]').filter({ has: dialog });
    await expect(frame.locator('[data-testid="terminal-replay-veil"]')).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });

    // Click a tab the panel is NOT already showing, so its terminal genuinely
    // mounts and arrives. The detail window still holds window-layer focus, so
    // without the tab-click claim the arbiter would resolve to it and deny this.
    // The explicit timeout matters: if a geometry change ever puts the detail
    // window back over the tab bar, this reports "intercepts pointer events"
    // instead of silently hanging until the test cap.
    await page
      .locator(`[data-testid="terminal-session-tab"][data-session-id="${SESSION_OTHER}"]`)
      .click({ timeout: STEP_TIMEOUT_MS });

    // Scoped by session, so this cannot be satisfied by the outgoing pane.
    const otherPane = page.locator(
      `[data-testid="terminal-session-pane"][data-session-id="${SESSION_OTHER}"]`,
    );
    await expect(otherPane.locator('[data-testid="terminal-replay-veil"]')).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });

    await expect(otherPane.locator('.xterm-helper-textarea').first()).toBeFocused({ timeout: STEP_TIMEOUT_MS });
  } finally {
    await browser.close();
  }
});

test('re-expanding the bottom panel focuses its terminal while a detail window is open', async () => {
  const { browser, page } = await launch();
  try {
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await markFirstOutput(page, [SESSION_DETAIL, SESSION_FALLBACK]);

    await page.locator(`text=Arrival Detail ${RUN_ID}`).first().click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

    const frame = page.locator('[data-testid^="window-frame-"]').filter({ has: dialog });
    await expect(frame.locator('[data-testid="terminal-replay-veil"]')).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });
    await expect(frame.locator('.xterm-helper-textarea').first()).toBeFocused({ timeout: STEP_TIMEOUT_MS });

    // Collapsing UNMOUNTS the panel's TerminalTab (`showContent`), so expanding
    // mounts a fresh one - an arrival, competing with a detail window that still
    // holds window-layer focus.
    await page.locator('button[title^="Collapse terminal panel"]').click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });

    await page.locator('button[title^="Expand terminal panel"]').click({ timeout: STEP_TIMEOUT_MS });

    const fallbackPane = page.locator(
      `[data-testid="terminal-session-pane"][data-session-id="${SESSION_FALLBACK}"]`,
    );
    await expect(fallbackPane.locator('[data-testid="terminal-replay-veil"]')).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });

    await expect(fallbackPane.locator('.xterm-helper-textarea').first()).toBeFocused({ timeout: STEP_TIMEOUT_MS });
  } finally {
    await browser.close();
  }
});
