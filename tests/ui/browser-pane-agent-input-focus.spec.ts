/**
 * UI tests for the Browser pane's agent-input focus guard and the keystroke
 * routing that rides on the same signal.
 *
 * A CDP drive hands the guest REAL focus, so two things have to happen for the
 * user not to lose their sentence: their focus comes back when the drive ends,
 * and anything they type meanwhile is intercepted before the page sees it and
 * delivered to the terminal instead. Main owns the interception (it is the only
 * side that can tell agent input from user input); this tier owns the renderer
 * half - which element gets focus back, and where the intercepted bytes go.
 *
 * Headless notes: `<webview>` is an unknown HTMLElement here, so it is made
 * focusable with `tabIndex` to stand in for a guest taking focus. That is a
 * faithful model of what the renderer SEES (activeElement becomes the webview)
 * even though no real guest exists. The Chromium-level steal itself has no
 * representation at this tier and is covered by the live probe in the rule.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-guard';
const PROJECT_PATH = '/mock/guard-test';
const TASK_ID = 'task-guard';
const SESSION_ID = 'sess-guard';
const SEEDED_URL = 'http://localhost:5173/';
const GUEST_ID = 4242;

// A SECOND task+session, used only by the "divergent focused-window session"
// test below. It stands in for the terminal the user is actually typing in
// while a DIFFERENT session's window (TASK_ID/SESSION_ID above) is the one an
// agent's open_pane made `focusedWindowId`. See the test for why a second
// session is the only way to catch the misroute this guard fixes.
const TASK_ID_VICTIM = 'task-guard-victim';
const SESSION_ID_VICTIM = 'sess-guard-victim';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}', name: 'Guard Test', path: '${PROJECT_PATH}',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-g-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}',
      pid: 9100, status: 'running', shell: 'bash',
      cwd: '${PROJECT_PATH}', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Guard Task', description: 'Focus guard fixture',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude',
      session_id: '${SESSION_ID}', worktree_path: null, branch_name: null,
      pr_number: null, pr_url: null, base_branch: 'main',
      archived_at: null, created_at: ts, updated_at: ts,
    });

    state.sessions.push({
      id: '${SESSION_ID_VICTIM}', taskId: '${TASK_ID_VICTIM}', projectId: '${PROJECT_ID}',
      pid: 9101, status: 'running', shell: 'bash',
      cwd: '${PROJECT_PATH}', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID_VICTIM}', title: 'Victim Task', description: 'Second session for the divergent-focus fixture',
      swimlane_id: laneIds['Code Review'], position: 1, agent: 'claude',
      session_id: '${SESSION_ID_VICTIM}', worktree_path: null, branch_name: null,
      pr_number: null, pr_url: null, base_branch: 'main',
      archived_at: null, created_at: ts, updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let sharedBrowser: Browser;
let sharedPage: Page;

async function loadApp(page: Page): Promise<void> {
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate((url) => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl('task-guard', url);
  }, SEEDED_URL);
}

/**
 * Open the pane and register a synthetic guest, so the guard's id filter has
 * something to match. Mirrors browser-pane-registration.spec.ts's injection.
 */
async function openPaneWithGuest(page: Page): Promise<void> {
  await page.evaluate(
    ([projectId, taskId]) => window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId),
    [PROJECT_ID, TASK_ID],
  );
  await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate((guestId) => {
    const webview = document.querySelector('[data-testid="browser-webview"]') as HTMLElement | null;
    if (!webview) throw new Error('no webview stub');
    (webview as unknown as { getWebContentsId: () => number }).getWebContentsId = () => guestId;
    // Focusable stand-in for a guest that can take focus.
    webview.tabIndex = -1;
    webview.dispatchEvent(new Event('dom-ready'));
  }, GUEST_ID);
}

/** A host typing surface OUTSIDE the pane, standing in for the user's terminal. */
async function installVictimInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector('#guard-victim')?.remove();
    const input = document.createElement('input');
    input.id = 'guard-victim';
    input.className = 'xterm-helper-textarea';
    document.body.appendChild(input);
    input.focus();
  });
}

/**
 * Open the VICTIM task's detail window the way a real user does: a click. This
 * mounts a REAL xterm terminal and, per `agent-open-pane-focus.spec.ts`'s proof
 * of the same path, focuses it - which is what actually fires `noteTerminalFocus`
 * via `useTerminal.ts`'s textarea `focus` listener.
 *
 * `installVictimInput`'s hand-rolled `<input class="xterm-helper-textarea">` is
 * NOT a substitute here: nothing wires its `focus` event to `noteTerminalFocus`,
 * so it cannot populate the arm-time snapshot the fix reads. Only a real
 * terminal focus does that, which is the whole reason this second task and this
 * helper exist.
 */
async function openVictimTaskByClick(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Victim Task').first().click();
  await page.locator('[data-testid="task-detail-dialog"]')
    .filter({ hasText: 'Victim Task' })
    .first()
    .waitFor({ state: 'visible', timeout: 10000 });
}

/** True while `document.activeElement` is the victim task's own terminal
 *  textarea - the real DOM focus the arm-time snapshot depends on, and the
 *  precondition the misroute needed (a focused WINDOW that is a different
 *  session from where the user's keyboard focus actually is). */
async function activeElementIsVictimTerminal(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || !active.classList.contains('xterm-helper-textarea')) return false;
    const dialog = active.closest('[data-testid="task-detail-dialog"]');
    if (!dialog) return false;
    return dialog.querySelector('[data-testid="task-detail-titlebar"]')?.textContent?.includes('Victim Task') ?? false;
  });
}

/** The focused element's id, falling back to its tag. `||` not `??`: an element
 *  with no id reports `''`, which `??` would happily return. */
const activeId = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return null;
    return active.id || active.tagName;
  });

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({ headless: true });
  const context = await sharedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  sharedPage = await context.newPage();
  await sharedPage.addInitScript({ path: MOCK_SCRIPT });
  await sharedPage.addInitScript(preConfig);
  await loadApp(sharedPage);
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

test.beforeEach(async () => {
  await loadApp(sharedPage);
});

test.describe('agent input focus guard', () => {
  test('restores the user\'s focus after the drive ends', async () => {
    await openPaneWithGuest(sharedPage);
    await installVictimInput(sharedPage);

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus();
    }, GUEST_ID);
    expect(await activeId(sharedPage)).toBe('WEBVIEW');

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, false), GUEST_ID);

    await expect.poll(() => activeId(sharedPage), { timeout: 5000 }).toBe('guard-victim');
  });

  test('does NOT restore mid-drive, which would break the running tool', async () => {
    // Measured on a live guest: taking focus back between a click and its char
    // events makes every character land nowhere. The steal stands until the
    // drive is over.
    await openPaneWithGuest(sharedPage);
    await installVictimInput(sharedPage);

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus();
    }, GUEST_ID);

    await sharedPage.waitForTimeout(600);

    expect(await activeId(sharedPage)).toBe('WEBVIEW');
  });

  test('ignores a signal for a different guest in the same window', async () => {
    await openPaneWithGuest(sharedPage);
    await installVictimInput(sharedPage);

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId + 1, true);
      (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus();
      window.__mockBrowser?.emitAgentInput(guestId + 1, false);
    }, GUEST_ID);

    await sharedPage.waitForTimeout(400);
    expect(await activeId(sharedPage)).toBe('WEBVIEW');
  });

  test('leaves focus alone when it never entered the pane', async () => {
    await openPaneWithGuest(sharedPage);
    await installVictimInput(sharedPage);

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      window.__mockBrowser?.emitAgentInput(guestId, false);
    }, GUEST_ID);

    await sharedPage.waitForTimeout(400);
    expect(await activeId(sharedPage)).toBe('guard-victim');
  });

  test('routes an intercepted keystroke to the terminal the user was in', async () => {
    // Main blocks the key from the page and sends it here already encoded; the
    // pane writes it to the session. Asserting on the recorded IPC write is the
    // renderer-observable end of that path.
    await openPaneWithGuest(sharedPage);
    await installVictimInput(sharedPage);

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus();
      window.__mockBrowser?.emitUserKeyDuringDrive(guestId, 'q');
    }, GUEST_ID);

    await expect
      .poll(
        () => sharedPage.evaluate(() =>
          (window.electronAPI.sessions as unknown as { __writeCalls: { sessionId: string; payload: string }[] })
            .__writeCalls.map((entry) => entry.payload)),
        { timeout: 5000 },
      )
      .toContain('q');
  });

  test('routes to the terminal the user was in, NOT the agent-opened window\'s own session', async () => {
    // Reproduces the bug this file's other routing test could not catch. The
    // old delivery path resolved its destination at DELIVERY time via
    // `resolveDictationTarget()`, whose tier 1 is the FOCUSED WINDOW's session.
    // `kangentic_browser_open_pane` deliberately makes its window
    // `focusedWindowId` WITHOUT taking DOM focus (`openedByAgent`), so that
    // ambient lookup named the agent's OWN session while the user kept typing
    // in a different one - misrouting the keystroke (and an Enter) into
    // another agent's live shell. The sibling test above has only one session
    // in its fixture, so the ambient answer and the correct answer happen to
    // coincide there and the misroute is invisible. This test constructs the
    // divergence: a victim terminal the user is really focused in (session
    // VICTIM), and a SEPARATE session (SESSION_ID, task-guard) whose window
    // becomes focusedWindowId via the agent's open_pane.
    await openVictimTaskByClick(sharedPage);
    await expect.poll(() => activeElementIsVictimTerminal(sharedPage), { timeout: 10000 }).toBe(true);

    // Opens task-guard's window AND its Browser pane, agent-initiated - this
    // makes ITS window focusedWindowId without moving DOM focus off the
    // victim's terminal (agent-driven-focus.md, agent-open-pane-focus.spec.ts).
    await openPaneWithGuest(sharedPage);

    // Intentional fixed wait, not a poll: `expect.poll` returns on its FIRST
    // successful check, so it cannot prove "nothing steals focus later" - focus
    // is already on the victim terminal right now, so a poll for that would
    // return immediately and observe nothing about what happens after
    // task-guard's window (and its own terminal, mounting in the split behind
    // it) finishes settling. Per anti-pattern 6, a non-occurrence needs a fixed
    // budget: give any latent steal time to land BEFORE the drive arms. If one
    // did, arming would capture the WRONG element as `restoreTarget` and the
    // WRONG session as `armedSessionId`, which the write-destination
    // assertions below would then catch (wrong-session write, or the correct
    // one never arriving) - but only because this wait ran first.
    await sharedPage.waitForTimeout(400);
    expect(await activeElementIsVictimTerminal(sharedPage)).toBe(true);

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus();
      window.__mockBrowser?.emitUserKeyDuringDrive(guestId, 'q');
    }, GUEST_ID);

    await expect
      .poll(
        () => sharedPage.evaluate(() =>
          (window.electronAPI.sessions as unknown as { __writeCalls: { sessionId: string; payload: string }[] })
            .__writeCalls),
        { timeout: 5000 },
      )
      .toContainEqual({ sessionId: SESSION_ID_VICTIM, payload: 'q' });

    // The misroute target: the agent-opened window's OWN session must never
    // receive the user's keystroke, no matter how the write above landed.
    const writeCalls = await sharedPage.evaluate(() =>
      (window.electronAPI.sessions as unknown as { __writeCalls: { sessionId: string; payload: string }[] })
        .__writeCalls);
    expect(writeCalls.some((entry) => entry.sessionId === SESSION_ID)).toBe(false);
  });

  test('does not route a keystroke for a different guest', async () => {
    await openPaneWithGuest(sharedPage);
    await installVictimInput(sharedPage);

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus();
      window.__mockBrowser?.emitUserKeyDuringDrive(guestId + 1, 'z');
    }, GUEST_ID);

    await sharedPage.waitForTimeout(400);
    const payloads = await sharedPage.evaluate(() =>
      (window.electronAPI.sessions as unknown as { __writeCalls: { payload: string }[] })
        .__writeCalls.map((entry) => entry.payload));
    expect(payloads).not.toContain('z');
  });
});

/**
 * The VISIBLE signal, which is the actual answer to "the agent stole my focus".
 *
 * Interacting with a page means clicking it, and a click gives the guest real
 * keyboard focus - so the focus move cannot be designed away, and every attempt
 * to hide it put keystrokes on the wrong side. It is SHOWN instead: the terminal
 * dims and the pane is marked, so the user can see where their typing will land
 * rather than discovering it afterwards. The routing above stays as the safety
 * net for anyone who types anyway.
 */
test.describe('an agent drive is visible', () => {
  test('marks the pane, and un-marks it when the drive ends', async () => {
    await openPaneWithGuest(sharedPage);
    await expect(sharedPage.locator('[data-testid="browser-agent-driving"]')).toHaveCount(0);

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);
    await expect(sharedPage.locator('[data-testid="browser-agent-driving"]')).toBeVisible();

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, false), GUEST_ID);
    await expect(sharedPage.locator('[data-testid="browser-agent-driving"]')).toHaveCount(0);
  });

  test('says it in words, not colour alone', async () => {
    // "Why has my typing stopped appearing" is exactly the moment a colour cue is
    // not enough, and colour alone is not readable by everyone.
    await openPaneWithGuest(sharedPage);
    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);

    await expect(sharedPage.locator('[data-testid="browser-agent-driving"]'))
      .toContainText('Agent typing here');
  });

  test('a drive for a DIFFERENT guest never marks this pane', async () => {
    // One window can host several panes; marking the wrong one sends the user
    // looking for a problem that is not theirs.
    await openPaneWithGuest(sharedPage);

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId + 1, true), GUEST_ID);

    await sharedPage.waitForTimeout(300);
    await expect(sharedPage.locator('[data-testid="browser-agent-driving"]')).toHaveCount(0);
  });
});

/**
 * The OTHER half of "the focus move is SHOWN, not hidden": the terminal side
 * of the split, in TaskDetailBody. The badge above lives inside BrowserPane
 * and is asserted there; this is the sibling assertion for the dimmed
 * terminal wrapper and the accented right-panel border that ride the same
 * `agentDrivingBrowser` flag one level up the tree.
 */
test.describe('an agent drive dims the terminal side of the split', () => {
  // Scoped to THIS task's own dialog, not a bare page-wide query: this file's
  // other describe block opens a second task-detail window (Victim Task) with
  // its own running session, which renders its own identically-testid'd dim
  // wrapper and right-panel border. A page-wide locator would be a strict-mode
  // violation (or silently match the wrong window) the moment two of these
  // dialogs are open at once - the project's `.fixed.inset-0` anti-pattern,
  // one level down. Mirrors this file's own `openVictimTaskByClick` /
  // `activeElementIsVictimTerminal` scoping idiom.
  function guardDialog(page: Page) {
    return page.locator('[data-testid="task-detail-dialog"]').filter({ hasText: 'Guard Task' }).first();
  }

  test('dims the terminal wrapper and accents the right-panel border while driving, then reverts', async () => {
    await openPaneWithGuest(sharedPage);

    const terminalDim = guardDialog(sharedPage).locator('[data-testid="task-detail-terminal-dim"]');
    const rightPanel = guardDialog(sharedPage).locator('[data-testid="task-detail-right-panel"]');
    await expect(terminalDim).toHaveClass(/opacity-100/);
    await expect(rightPanel).toHaveClass(/border-edge/);

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);
    await expect(terminalDim).toHaveClass(/opacity-40/);
    await expect(rightPanel).toHaveClass(/border-accent/);

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, false), GUEST_ID);
    await expect(terminalDim).toHaveClass(/opacity-100/);
    await expect(rightPanel).toHaveClass(/border-edge/);
  });

  test('a drive for a DIFFERENT guest never dims this task\'s terminal', async () => {
    await openPaneWithGuest(sharedPage);

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId + 1, true), GUEST_ID);

    // Intentional fixed wait, not a poll: cannot poll for non-occurrence (the
    // wrapper already reads opacity-100 before any signal fires, so a poll for
    // that value would return immediately and prove nothing about a delayed
    // dim). 300ms mirrors the sibling "different guest" checks above in this
    // file.
    await sharedPage.waitForTimeout(300);
    await expect(guardDialog(sharedPage).locator('[data-testid="task-detail-terminal-dim"]'))
      .toHaveClass(/opacity-100/);
    await expect(guardDialog(sharedPage).locator('[data-testid="task-detail-right-panel"]'))
      .toHaveClass(/border-edge/);
  });
});
