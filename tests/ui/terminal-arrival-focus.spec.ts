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
 * mock-electron-api.js) pins that order so spec 1 tests the losing case every
 * run rather than half the time. Spec 3 (`launch({ delayFallbackReplay: false
 * })`) leaves it off: its claim is checked against the panel's OWN re-expand
 * arrival, which does not depend on which of the detail's or the panel's
 * initial mounts resolves first, and the delay would only spend wall clock
 * inside `claimArrivalFocus`'s fixed, non-retrying TTL window for no reason
 * that spec needs. Spec 2 leaves the default on; the delay is inert there too
 * (it never asserts on the fallback session), so there is nothing to gain by
 * touching it.
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

/**
 * @param delayFallbackReplay Force the losing order: the panel's fallback
 * terminal resolves its replay after the detail window's, which is the
 * arrangement that used to steal focus. Only spec 1 needs the ordering
 * exercised - spec 3's claim (`onToggleCollapse`) is checked against the
 * bottom panel's OWN re-expand arrival, which has nothing to do with which
 * of the detail's or the panel's initial mounts resolves first. There the
 * delay is pure dead time sitting inside `ARRIVAL_CLAIM_TTL_MS`'s fixed
 * 4000ms budget (the claim is set once, at the expand click, and the TTL
 * check has no retry - see terminal-arrival-focus.ts), so spec 3 passes
 * `false` to keep that budget's wall-clock distance as short as the real
 * causal chain requires.
 */
function preConfig(delayFallbackReplay: boolean): string {
  return `
    ${delayFallbackReplay ? `
    window.__mockScrollbackDelayMs = { '${SESSION_FALLBACK}': ${FALLBACK_REPLAY_DELAY_MS} };
    ` : ''}
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

async function launch(options: { delayFallbackReplay?: boolean } = {}): Promise<{ browser: Browser; page: Page }> {
  const { delayFallbackReplay = true } = options;
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(delayFallbackReplay));
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

/**
 * On a focus-assertion failure for an arriving terminal, print the arrival-focus
 * arbiter's dev-only trace ring (exposed as `window.__kangenticTerminalTrace` by
 * `DevtoolsBootstrap`, mounted unconditionally under Vite dev) plus the actual
 * focused element's identity, via `console.log` so it lands directly in CI's
 * `list`-reporter job log - the UI shard job uploads no report/trace artifact, so
 * a `testInfo.attach()` would be invisible there.
 *
 * Diagnostic only: changes no wait and weakens no assertion.
 *
 * It earned its keep. The failure it was added for turned out to be an arrival
 * whose decision was never made at all: the scrollback watchdog pre-empted the
 * replay, which cancelled the decision (a generation bump) and lifted the veil (a
 * settle) in the same breath, so the terminal read as fully arrived and merely
 * unfocusable. Two rounds of reading the tier ladder found nothing because the
 * arbiter was never consulted - the ABSENCE of an `arrival-focus` entry was the
 * whole signal, and nothing was printing it. Spec 4 now covers that path.
 *
 * So what to read here, in order: no `arrival-focus` entry for the session means
 * nothing asked (look for `replay-watchdog` / `replay-abort` just before it); an
 * `{allow: false, reason}` entry is a product-side denial, and the claim and
 * fingerprint fields on it separate "no claim was live" from "a claim was live
 * and its fingerprint had moved"; `{allow: true}` with focus elsewhere means it
 * was granted and then stolen, which is a different bug.
 */
async function logArrivalFocusFailure(page: Page, sessionId: string): Promise<void> {
  const diagnostics = await page.evaluate((sid) => {
    const traceReader = (window as unknown as { __kangenticTerminalTrace?: () => unknown[] }).__kangenticTerminalTrace;
    // An absent bridge and an empty ring both used to read as `[]`, which are very
    // different diagnoses - one means the dev tooling did not mount, the other
    // means the app genuinely decided nothing.
    const traceInstalled = typeof traceReader === 'function';
    const trace = (traceReader ? traceReader() : []) as Array<{ sessionId: string | null; event: string }>;
    // Every `arrival-` event, not just `arrival-focus`: a CLAIM for a different
    // session is exactly what a `claim-mismatch` needs explaining, and filtering
    // on this session alone would drop it.
    const matching = trace.filter((entry) => entry.sessionId === sid || entry.event.startsWith('arrival-'));
    // The TAIL, because the diagnosis is always the last few events before the
    // failure and the CI job log truncates a long dump - which is what happened to
    // the first version of this helper, mid-entry at ~1.8KB.
    const TAIL = 24;
    const relevant = matching.slice(-TAIL);
    const active = document.activeElement;
    return {
      traceInstalled,
      // TRACE_RING_SIZE is 300, shared across every session and event kind, so a
      // busy spec can evict the early entries. Report occupancy rather than
      // letting a truncated ring read as "it never happened".
      ringEntries: trace.length,
      matchingEntries: matching.length,
      relevantTrace: relevant,
      activeElement: active && active !== document.body ? {
        tag: active.tagName,
        className: (active as HTMLElement).className ?? null,
        paneSessionId: active.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null,
        testId: active.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      } : null,
    };
  }, sessionId);
  console.log(`[arrival-focus-diagnostics] session=${sessionId}`, JSON.stringify(diagnostics, null, 2));
}

/**
 * Read the dev-only trace ring (`window.__kangenticTerminalTrace`, installed by
 * `DevtoolsBootstrap` under Vite dev), filtered to one session and one event kind.
 * Returns each entry's `detail`, so a spec can assert on WHICH path produced a
 * decision rather than only that some decision happened.
 */
async function readTraceDetails(
  page: Page,
  sessionId: string,
  event: string,
): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(([targetSessionId, targetEvent]) => {
    const traceReader = (window as unknown as { __kangenticTerminalTrace?: () => unknown[] }).__kangenticTerminalTrace;
    const trace = (traceReader ? traceReader() : []) as Array<{
      sessionId: string | null;
      event: string;
      detail?: Record<string, unknown>;
    }>;
    return trace
      .filter((entry) => entry.sessionId === targetSessionId && entry.event === targetEvent)
      .map((entry) => entry.detail ?? {});
  }, [sessionId, event]);
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

    // Anti-vacuity, checked from the mock's own call log rather than by racing
    // the transient replay veil. Every assertion above still passes if the
    // forced delay silently stops applying (a renamed session id, a changed
    // mock), which would leave the losing order unexercised and this spec green
    // for the wrong reason. The log proves the fallback's replay really did take
    // the delayed path, so it really did resolve after the detail's.
    const delayedCalls = await page.evaluate((sessionId) => {
      const calls = (window as unknown as {
        __mockScrollbackCalls?: { sessionId: string; delay: number }[];
      }).__mockScrollbackCalls ?? [];
      return calls.filter((call) => call.sessionId === sessionId).map((call) => call.delay);
    }, SESSION_FALLBACK);
    expect(delayedCalls.length).toBeGreaterThan(0);
    expect(Math.max(...delayedCalls)).toBe(FALLBACK_REPLAY_DELAY_MS);
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
  // No forced fallback-replay delay here (see preConfig's doc comment): this
  // spec's claim is `onToggleCollapse`'s, checked against the panel's OWN
  // re-expand arrival, which does not depend on which of the detail's or the
  // panel's initial mounts resolves first. Delaying it would only burn wall
  // clock inside `claimArrivalFocus`'s fixed, non-retrying TTL window for no
  // reason this spec needs.
  const { browser, page } = await launch({ delayFallbackReplay: false });
  try {
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await markFirstOutput(page, [SESSION_DETAIL, SESSION_FALLBACK]);

    await page.locator(`text=Arrival Detail ${RUN_ID}`).first().click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

    const frame = page.locator('[data-testid^="window-frame-"]').filter({ has: dialog });
    await expect(frame.locator('[data-testid="terminal-replay-veil"]')).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });
    await expect(frame.locator('.xterm-helper-textarea').first()).toBeFocused({ timeout: STEP_TIMEOUT_MS });

    const fallbackPane = page.locator(
      `[data-testid="terminal-session-pane"][data-session-id="${SESSION_FALLBACK}"]`,
    );
    // Opening the detail evicted the panel's selection onto the fallback
    // session, mounting its OWN arrival (the race spec 1 exercises) at the
    // same moment. Let it fully settle before collapsing: collapsing while
    // it is still in flight unmounts it mid-replay, so the re-expand below
    // would start from a churning pane instead of a quiescent one - unrelated
    // noise this spec does not need, since its own claim/arrival pair is the
    // thing under test.
    await fallbackPane.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await expect(fallbackPane.locator('[data-testid="terminal-replay-veil"]')).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });

    // Collapsing UNMOUNTS the panel's TerminalTab (`showContent`), so expanding
    // mounts a fresh one - an arrival, competing with a detail window that still
    // holds window-layer focus.
    await page.locator('button[title^="Collapse terminal panel"]').click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });

    await page.locator('button[title^="Expand terminal panel"]').click({ timeout: STEP_TIMEOUT_MS });

    // The pane does not exist until the 200ms collapse/expand height
    // transition ends and `showContent` flips true (`resolveContentAction`'s
    // 'reveal-on-transition-end' branch, useTerminalResize.ts) - so checking
    // the veil's count before the pane has mounted matches zero descendants
    // under zero ancestors and passes on the very first poll, proving
    // nothing about the replay. Gate on the pane actually mounting first.
    await fallbackPane.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await expect(fallbackPane.locator('[data-testid="terminal-replay-veil"]')).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });

    try {
      await expect(fallbackPane.locator('.xterm-helper-textarea').first()).toBeFocused({ timeout: STEP_TIMEOUT_MS });
    } catch (error) {
      await logArrivalFocusFailure(page, SESSION_FALLBACK);
      throw error;
    }
  } finally {
    await browser.close();
  }
});

/**
 * Spec 4: an arrival whose replay is PRE-EMPTED still gets its focus decision.
 *
 * `useTerminal`'s scrollback watchdog (SCROLLBACK_WATCHDOG_MS, 5s) is a backstop
 * for a replay that never completes. When it fires it bumps the replay
 * generation, which makes that replay's own `afterWrite` return ABOVE the frame
 * which asks the arbiter - so the arrival-focus decision is cancelled - and it
 * clears `scrollbackPendingRef`, which lifts the replay veil. To everything
 * downstream the terminal has finished arriving. In fact nothing ever asked
 * whether it may take focus, and nothing asks again, so that terminal is
 * unfocusable for the rest of its life.
 *
 * Why this drives the RELOAD path rather than a fresh mount. On a solo mount
 * `TerminalTab`'s own init frame (the `mayFocusOnArrival('tab-init')` call in its
 * `active` effect) runs one frame after the init queue constructs the terminal,
 * and focuses it long before the watchdog - so a mount-based version of this spec
 * would pass with the fix reverted, i.e. vacuously. Lifting the launch overlay on
 * an ALREADY-INITIALIZED terminal produces an arrival with no `tab-init` frame at
 * all (`TerminalTab`'s `terminalReady` false -> true effect calls
 * `reloadScrollback()` with no `skipFocus`), so the pre-empted decision is the
 * only one there is. That is what makes this red-green.
 *
 * The tab click before the delay is what puts a live claim in place. Without it
 * the still-focused detail window wins tier 2 and the terminal is denied for a
 * legitimate reason, which would also pass vacuously.
 *
 * How to verify RED / GREEN: drop the `focusOnArrival('replay-watchdog')` call
 * from `armScrollbackWatchdog` in `useTerminal.ts` and this fails with the
 * production symptom - pane mounted, veil gone, textarea never focused.
 */
test('a terminal whose replay the watchdog pre-empts still takes arrival focus', async () => {
  // The watchdog is a real 5s wall-clock timer and the replay behind it is
  // delayed past that deliberately, so this one case needs more than the tier's
  // default per-test budget. 90s rather than 60s because the four STEP_TIMEOUT_MS
  // waits ahead of the delay sum to 32s on their own, and 32 + 5.5 + the 20s
  // watchdog poll + a final 8s focus wait already reaches 60 before anything has
  // gone wrong. A loaded CI shard would then fail this on the budget rather than
  // on the behaviour under test.
  test.setTimeout(90_000);
  const { browser, page } = await launch({ delayFallbackReplay: false });
  try {
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    // DETAIL only. The fallback session keeps its launch overlay, so lifting that
    // overlay later is what produces the arrival under test.
    await markFirstOutput(page, [SESSION_DETAIL]);

    await page.locator(`text=Arrival Detail ${RUN_ID}`).first().click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

    const fallbackPane = page.locator(
      `[data-testid="terminal-session-pane"][data-session-id="${SESSION_FALLBACK}"]`,
    );
    await fallbackPane.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

    // A tab click claims arrival focus for this session (selectActiveSession ->
    // claimArrivalFocus). The session is already the panel's selection, so this
    // moves no tab and remounts nothing - it only puts the claim in place, which
    // is what lets tier 1 grant while the detail window still holds window focus.
    await page.locator(`[data-testid="terminal-session-tab"][data-session-id="${SESSION_FALLBACK}"]`)
      .click({ timeout: STEP_TIMEOUT_MS });

    // Past SCROLLBACK_WATCHDOG_MS (5000), so the reload below is guaranteed to be
    // pre-empted rather than completing. Armed here rather than at launch so the
    // earlier mounts stay fast and keep their own recovery budget intact.
    await page.evaluate((sessionId) => {
      (window as unknown as { __mockScrollbackDelayMs?: Record<string, number> })
        .__mockScrollbackDelayMs = { [sessionId]: 5500 };
    }, SESSION_FALLBACK);

    // Lift the launch overlay: terminalReady false -> true makes TerminalTab call
    // reloadScrollback() with no skipFocus, i.e. an arrival.
    await markFirstOutput(page, [SESSION_FALLBACK]);

    // Wait for the watchdog's own trace event rather than for the veil. The
    // watchdog clears the veil and then its recovery replay (delayed again by the
    // same mock entry) raises it, so the veil is not a stable marker here - and
    // asserting the watchdog actually fired is what stops this spec passing
    // vacuously if the delay ever stops applying, the same argument the mock's
    // getScrollback makes for __mockScrollbackCalls.
    await expect.poll(
      async () => (await readTraceDetails(page, SESSION_FALLBACK, 'replay-watchdog')).length,
      { timeout: 20_000 },
    ).toBeGreaterThan(0);

    // The production symptom first, so a regression reports as "the terminal was
    // never focused" rather than as a trace-shape mismatch.
    try {
      await expect(fallbackPane.locator('.xterm-helper-textarea').first()).toBeFocused({ timeout: STEP_TIMEOUT_MS });
    } catch (error) {
      await logArrivalFocusFailure(page, SESSION_FALLBACK);
      throw error;
    }

    // Then the non-vacuity guard: the decision has to have come from the
    // watchdog's discharge. A green produced by some other focus path would not
    // be the thing under test, and this spec is built so no other path can run -
    // if one appears, this is what says so instead of quietly passing.
    expect(
      (await readTraceDetails(page, SESSION_FALLBACK, 'arrival-focus'))
        .filter((detail) => detail.site === 'replay-watchdog' && detail.allow === true),
    ).toHaveLength(1);
  } finally {
    await browser.close();
  }
});
