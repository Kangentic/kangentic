/**
 * A terminal the user cannot see never takes keyboard focus on arrival.
 *
 * The bug. The bottom panel's terminal arrives more than once: its mount replay,
 * then the reload that runs when the launch overlay lifts. With no window focused
 * and focus on a <button> (not a typing surface), the arbiter's tier 3 granted
 * that reload even when the panel was covered: by a Delete confirm the user had
 * just opened, or by the Agent Monitor overlay. Focus moved into a terminal the
 * user could not see, so their next key (Escape to cancel the dialog or close the
 * monitor) went to the agent's TUI instead.
 *
 * The fix is tier 0 in `resolveArrivalFocus`: the host's terminal is probed with
 * hit tests, and a covered one is denied as `hidden` whatever a lower tier says.
 *
 * Why the order is causal. The panel terminal's reload is held by a GATE
 * (`__mockScrollbackGate`, a promise the spec resolves), not by a timer. An earlier
 * version held it with a fixed 2500ms `__mockScrollbackDelayMs` and raced that
 * against opening the cover: on a loaded runner the reload landed before the cover
 * was up, the arbiter saw a visible terminal and allowed it, and the spec failed
 * with a misleading focus assertion. Now the spec waits until the reload's
 * scrollback read is logged as held, opens the cover, confirms the cover is up and
 * that no reload decision exists yet, and only then releases the gate. Each test
 * then waits for the reload's own `arrival-focus` decision in the dev trace ring
 * before it reads focus, and lets the focus frame run (two animation frames). No
 * `waitForTimeout` (.claude/rules/cross-platform-parity.md).
 *
 * The one clock left is the replay watchdog (SCROLLBACK_WATCHDOG_MS, 5000ms in
 * useTerminal.ts), armed when the reload starts. A gate held past it would settle
 * the decision under site `replay-watchdog` instead of `reload`, so the spec also
 * asserts no watchdog event fired before the release. Cover-open-to-release is a
 * handful of Playwright round trips, far inside it.
 *
 * Red-green: make `isArrivingTerminalVisible` return true and both tests fail with
 * focus in the panel's xterm and the reload decided `unclaimed`. Release the gate
 * BEFORE opening the cover (the old race, made deterministic) and both tests fail
 * at the pre-release read: a `reload` decision already exists, with the terminal
 * visible, before the cover could have been checked.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-arrival-hidden';
const SESSION_ID = 'sess-arrival-hidden';
const RUNNING_TASK_ID = 'task-arrival-hidden-running';
const PLAIN_TASK_ID = 'task-arrival-hidden-plain';
const STEP_TIMEOUT_MS = 9000;

function preConfig(): string {
  return `
    // Every replay for the panel's session waits on this one promise, which the
    // spec resolves through __releaseScrollbackGate once the cover is open. One
    // promise, never replaced: after the release, later replays pass straight
    // through.
    window.__mockScrollbackGate = {
      '${SESSION_ID}': new Promise(function (resolve) { window.__releaseScrollbackGate = resolve; }),
    };
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Arrival Hidden', path: '/mock/arrival-hidden',
        github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
      });
      var executingLaneId = null;
      var todoLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-ah-' + index;
        if (template.name === 'Executing') executingLaneId = laneId;
        if (template.name === 'To Do') todoLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, { id: laneId, position: index, created_at: timestamp }));
      });
      state.sessions.push({
        id: '${SESSION_ID}', taskId: '${RUNNING_TASK_ID}', projectId: '${PROJECT_ID}', pid: 7300,
        status: 'running', shell: 'bash', cwd: '/mock/arrival-hidden', startedAt: timestamp,
        exitCode: null, resuming: false,
      });
      function task(id, displayId, title, laneId, sessionId) {
        return {
          id: id, display_id: displayId, title: title, description: '', swimlane_id: laneId, position: 0,
          agent: sessionId ? 'claude' : null, session_id: sessionId, worktree_path: null, branch_name: null,
          pr_number: null, pr_url: null, base_branch: null, archived_at: null, created_at: timestamp, updated_at: timestamp,
        };
      }
      state.tasks.push(task('${RUNNING_TASK_ID}', 1, 'Agent in the panel', executingLaneId, '${SESSION_ID}'));
      state.tasks.push(task('${PLAIN_TASK_ID}', 2, 'Card with a Delete confirm', todoLaneId, null));
      state.activityCache['${SESSION_ID}'] = 'idle';
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(preConfig());
    await gotoVite(page, VITE_URL);
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    // The terminal is opened, which means initTerminal ran to its end and the
    // deferred-init flag is set in the same task. The overlay-lift reload below
    // needs that (TerminalTab skips the reload on an uninitialized terminal). The
    // mount replay itself reads no scrollback while the launch overlay is up (its
    // data is suppressed), so it is not what the gate holds.
    await page.locator('[data-testid="terminal-session-pane"] .xterm').first().waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    const heldBeforeLift = await heldReplayCount(page);
    // Lift the launch overlay, which starts the arrival under test: the
    // overlay-lift reload. Its scrollback read is held by the gate, and waiting
    // for that read to be logged proves the reload started and is parked.
    await page.evaluate((sessionId) => {
      const stores = (window as unknown as {
        __zustandStores?: { session?: { getState: () => { markFirstOutput: (id: string) => void } } };
      }).__zustandStores;
      stores?.session?.getState().markFirstOutput(sessionId);
    }, SESSION_ID);
    await expect.poll(() => heldReplayCount(page), { timeout: STEP_TIMEOUT_MS }).toBeGreaterThan(heldBeforeLift);    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** Replays the mock has been asked for the panel's session that it held on the gate. */
async function heldReplayCount(page: Page): Promise<number> {
  return page.evaluate((sessionId) => {
    const calls = (window as unknown as {
      __mockScrollbackCalls?: Array<{ sessionId: string; gated: boolean }>;
    }).__mockScrollbackCalls ?? [];
    return calls.filter((call) => call.sessionId === sessionId && call.gated).length;
  }, SESSION_ID);
}

/** Let the held replays resolve. Call it only once the cover is confirmed open. */
async function releaseReplays(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __releaseScrollbackGate: () => void }).__releaseScrollbackGate();
  });
}

/** Trace entries of one event kind for the panel's session, from the dev trace ring. */
async function traceEventCount(page: Page, eventName: string): Promise<number> {
  return page.evaluate(([sessionId, wantedEvent]) => {
    const reader = (window as unknown as {
      __kangenticTerminalTrace?: () => Array<{ sessionId: string | null; event: string }>;
    }).__kangenticTerminalTrace;
    return (reader ? reader() : [])
      .filter((entry) => entry.sessionId === sessionId && entry.event === wantedEvent).length;
  }, [SESSION_ID, eventName]);
}

/**
 * With the cover open and the replays still held: no reload has been decided yet
 * (so the decision the assertions below read is guaranteed to come after the
 * cover), and the replay watchdog has not fired (so it cannot be the one that
 * settles the arrival under another site). Then release.
 */
async function releaseOnceCoverIsUp(page: Page): Promise<void> {
  expect(await reloadDecisions(page)).toEqual([]);
  expect(await traceEventCount(page, 'replay-watchdog')).toBe(0);
  await releaseReplays(page);
}

/** The panel terminal's arrival decisions from the reload, read from the dev trace ring. */
async function reloadDecisions(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((sessionId) => {
    const reader = (window as unknown as {
      __kangenticTerminalTrace?: () => Array<{ sessionId: string | null; event: string; detail?: Record<string, unknown> }>;
    }).__kangenticTerminalTrace;
    return (reader ? reader() : [])
      .filter((entry) => entry.sessionId === sessionId && entry.event === 'arrival-focus' && entry.detail?.site === 'reload')
      .map((entry) => entry.detail ?? {});
  }, SESSION_ID);
}

/** Wait for the reload's arrival decision, then let the frame that would focus run. */
async function waitForReloadArrival(page: Page): Promise<Array<Record<string, unknown>>> {
  await expect.poll(async () => (await reloadDecisions(page)).length, { timeout: STEP_TIMEOUT_MS }).toBeGreaterThan(0);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  return reloadDecisions(page);
}

async function focusIsInAnXterm(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.activeElement?.closest('.xterm'));
}

test('a panel terminal arriving under an open Delete confirm leaves focus in the dialog', async () => {
  const { browser, page } = await launch();
  try {
    await page.locator(`[data-board-lanes] [data-task-id="${PLAIN_TASK_ID}"]`).click({ button: 'right' });
    await page.locator('[data-testid="context-delete-task"]').click();
    const dialog = page.locator('[data-testid="delete-task-dialog"]');
    await expect(dialog).toBeVisible();

    await releaseOnceCoverIsUp(page);
    const decisions = await waitForReloadArrival(page);
    expect(decisions.at(-1)).toMatchObject({ allow: false, reason: 'hidden', terminalVisible: false });
    expect(await focusIsInAnXterm(page)).toBe(false);
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="delete-task-dialog"]'))).toBe(true);
  } finally {
    await browser.close();
  }
});

test('a panel terminal arriving under the open Agent Monitor does not take focus', async () => {
  const { browser, page } = await launch();
  try {
    await page.locator('[data-testid="agent-monitor-button"]').click();
    await page.locator('[data-testid="monitor-page"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

    await releaseOnceCoverIsUp(page);
    const decisions = await waitForReloadArrival(page);
    expect(decisions.at(-1)).toMatchObject({ allow: false, reason: 'hidden', terminalVisible: false });
    expect(await focusIsInAnXterm(page)).toBe(false);
  } finally {
    await browser.close();
  }
});
