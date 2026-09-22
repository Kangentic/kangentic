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

  test('restores focus to the pane\'s NOTE INPUT after the drive ends', async () => {
    // The note input lives INSIDE the pane, and the guard's "focus was already
    // in the pane, so this is not a steal" rule used to cover it - so it never
    // armed for the note input at all, and a drive left the user's cursor in the
    // guest with no way back. `activeIsTextTarget` is the narrow exception.
    // This also proves the arming half of the keystroke routing below: if the
    // guard did not arm, `restoreTarget` would be null and neither would work.
    await openPaneWithGuest(sharedPage);
    const noteInput = sharedPage.locator('[data-testid="browser-note-input"]');
    await noteInput.click();

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus();
    }, GUEST_ID);
    expect(await activeId(sharedPage)).toBe('WEBVIEW');

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, false), GUEST_ID);

    await expect
      .poll(
        () => sharedPage.evaluate(() =>
          document.activeElement?.getAttribute('data-testid') ?? null),
        { timeout: 5000 },
      )
      .toBe('browser-note-input');
  });

  test('routes an intercepted keystroke into the pane\'s NOTE INPUT when that is where the user was', async () => {
    // This case used to be DROPPED. The only delivery mechanism was PTY bytes,
    // and someone's prose arriving in a live shell as commands is worse than a
    // lost keystroke - so the guard bailed out unless the user was in a
    // terminal. Writing into a React-controlled input is a different mechanism
    // (`utils/text-target.ts`), and it is the same one dictation into this field
    // uses.
    await openPaneWithGuest(sharedPage);
    const noteInput = sharedPage.locator('[data-testid="browser-note-input"]');
    await noteInput.click();
    await noteInput.fill('fix ');

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus();
      window.__mockBrowser?.emitUserKeyDuringDrive(guestId, 't');
      window.__mockBrowser?.emitUserKeyDuringDrive(guestId, 'h');
      window.__mockBrowser?.emitUserKeyDuringDrive(guestId, 'i');
      window.__mockBrowser?.emitUserKeyDuringDrive(guestId, 's');
    }, GUEST_ID);

    // The value assertion is what proves the native-setter write reached REACT
    // and not just the DOM node: `note` is controlled, so a plain `.value`
    // assignment would be reverted by the next render.
    await expect(noteInput).toHaveValue('fix this');

    // And nothing was written to a PTY, which is the failure this replaces.
    const payloads = await sharedPage.evaluate(() =>
      (window.electronAPI.sessions as unknown as { __writeCalls: { payload: string }[] })
        .__writeCalls.map((entry) => entry.payload));
    expect(payloads).not.toContain('t');
  });

  test('an intercepted Backspace deletes in the note input, and Enter is still dropped', async () => {
    // The decoder is deliberately as small as `encodeTerminalKey`: printable
    // characters and Backspace, nothing else. Enter in this field SENDS the
    // capture and the note to the agent, and firing that off a keystroke the
    // user aimed at a web page would post a half-written note with a screenshot
    // and no way to take it back.
    await openPaneWithGuest(sharedPage);
    const noteInput = sharedPage.locator('[data-testid="browser-note-input"]');
    await noteInput.click();
    await noteInput.fill('typo!');

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus();
      window.__mockBrowser?.emitUserKeyDuringDrive(guestId, '\x7f');
    }, GUEST_ID);
    await expect(noteInput).toHaveValue('typo');

    await sharedPage.evaluate((guestId) => {
      window.__mockBrowser?.emitUserKeyDuringDrive(guestId, '\r');
    }, GUEST_ID);

    // A fixed budget, not a poll: this asserts a NON-occurrence, and a poll
    // returns on its first success. `handleSend` fails at this tier (no real
    // guest to capture) and reports it in the error strip, so the strip staying
    // absent is what proves Send never ran.
    await sharedPage.waitForTimeout(500);
    await expect(sharedPage.locator('[data-testid="browser-send-error"]')).not.toBeVisible();
    await expect(noteInput).toHaveValue('typo');
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
 * keyboard focus, so the focus move cannot be designed away. It is SHOWN
 * instead - but on the PAGE, not on the terminal. Main intercepts every keyDown
 * at the guest and writes it to the terminal, so the terminal is the surface
 * that still works and the page is the one that cannot take a keystroke. The
 * veil, the accent border and the label all mark the page.
 *
 * Every assertion here has to wait out `AGENT_DRIVE_VEIL_GRACE_MS`: the raw
 * router signal is up for about half a second on a single click, and the cue
 * deliberately paints nothing for a drive that short.
 */
test.describe('an agent drive is visible', () => {
  const veil = (page: Page) => page.locator('[data-testid="browser-agent-driving"]');

  /**
   * Put the veil back to rest before a test that needs a false baseline.
   *
   * The run closes `AGENT_DRIVE_VEIL_LINK_MS` (5s) after the last burst, which
   * is correct for the product and long enough to leak across tests sharing
   * one page. The timeout has to clear that window, so it is explicit rather
   * than Playwright's 5s default, which would race it.
   */
  async function settleIdle(page: Page) {
    await page
      .evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, false), GUEST_ID)
      .catch(() => {});
    if (await veil(page).count()) {
      await expect(veil(page)).toHaveAttribute('data-driving', 'false', { timeout: 8000 });
    }
  }

  /** End a test without leaving the run open for the next one. */
  const releaseDrive = (page: Page) =>
    page.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, false), GUEST_ID);

  /** One agent call: the guest is held briefly, then released. */
  async function oneCall(page: Page) {
    await page.evaluate((guestId) => {
      window.__mockBrowser?.emitAgentInput(guestId, true);
      setTimeout(() => window.__mockBrowser?.emitAgentInput(guestId, false), 120);
    }, GUEST_ID);
    await page.waitForTimeout(220);
  }

  test('marks the pane on the FIRST call, with no threshold to cross', async () => {
    // Show as soon as possible is a requirement in its own right, not a
    // nicety: the pointer block engages on this same call, and a page that
    // stops accepting clicks with nothing on screen explaining it is worse
    // than a brief mark.
    //
    // An earlier cut waited for the second burst and so trailed the agent by
    // a whole inter-call gap (median 1.6s). It was solving the wrong problem:
    // the reported flicker was one cue strobing 27 times across a single
    // piece of work, which the link window cures, not a cue appearing once.
    await openPaneWithGuest(sharedPage);
    await settleIdle(sharedPage);

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);

    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true');
    await expect(veil(sharedPage)).toBeVisible();
    await releaseDrive(sharedPage);
  });

  test('stays up across the gap between calls, instead of blinking per call', async () => {
    // The failure this replaces: at the router's cadence a 27-call run painted
    // 27 times. Gaps between calls are model latency, around 1.1 to 4.4s, and
    // the veil must ride straight over them.
    await openPaneWithGuest(sharedPage);
    await settleIdle(sharedPage);
    await oneCall(sharedPage);
    await oneCall(sharedPage);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true');

    const wentDown = await sharedPage.evaluate(() => {
      const element = document.querySelector('[data-testid="browser-agent-driving"]');
      if (!element) throw new Error('veil element not found');
      return new Promise<boolean>((resolve) => {
        let dropped = false;
        const observer = new MutationObserver(() => {
          if (element.getAttribute('data-driving') === 'false') dropped = true;
        });
        observer.observe(element, { attributes: true, attributeFilter: ['data-driving'] });
        setTimeout(() => { observer.disconnect(); resolve(dropped); }, 1800);
      });
    });

    expect(wentDown).toBe(false);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true');
    await releaseDrive(sharedPage);
  });

  test('a run of calls produces exactly ONE on and ONE off, never a strobe', async () => {
    // This is the anti-flicker invariant now that there is no open threshold.
    // The reported annoyance was one cue strobing across a single piece of
    // work - a 27-call verification flashing 27 times - so what has to be
    // guarded is the COUNT of transitions, not whether a brief appearance can
    // happen at all.
    //
    // Counted with an observer rather than sampled, because a strobe and a
    // steady hold look identical at the end: both finish `true`.
    await openPaneWithGuest(sharedPage);
    await settleIdle(sharedPage);

    const transitions = await sharedPage.evaluate((guestId) => {
      const element = document.querySelector('[data-testid="browser-agent-driving"]');
      if (!element) throw new Error('veil element not found');
      const seen: string[] = [];
      const observer = new MutationObserver(() => {
        const now = element.getAttribute('data-driving') ?? '';
        if (seen[seen.length - 1] !== now) seen.push(now);
      });
      observer.observe(element, { attributes: true, attributeFilter: ['data-driving'] });

      // Six calls with gaps well inside the link window, which is how a real
      // verification arrives: ~300ms of work then ~1.6s of model latency.
      let call = 0;
      const fire = () => {
        window.__mockBrowser?.emitAgentInput(guestId, true);
        setTimeout(() => window.__mockBrowser?.emitAgentInput(guestId, false), 120);
        if (++call < 6) setTimeout(fire, 700);
      };
      fire();

      return new Promise<string[]>((resolve) => {
        setTimeout(() => { observer.disconnect(); resolve(seen); }, 5200);
      });
    }, GUEST_ID);

    // Up once at the first call, and still up at the end: the gaps were
    // bridged rather than blinked through.
    expect(transitions).toEqual(['true']);
    await releaseDrive(sharedPage);
  });

  test('says it in words, not colour alone', async () => {
    // A veil on its own reads as loading, disabled or stale, and this is none
    // of those. Colour alone is also not readable by everyone.
    await openPaneWithGuest(sharedPage);
    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);

    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true', { timeout: 4000 });
    await expect(veil(sharedPage)).toContainText('Agent is driving');
    await releaseDrive(sharedPage);
  });

  test('the ring actually breathes, because the veil alone has no baseline', async () => {
    // Reported from a live drive: "on a white background the dim isn't coming
    // through". The veil WAS applied - a viewer cannot tell a veiled white page
    // from a page that is simply grey, because they never see the two side by
    // side. A tint needs a baseline; motion does not, so the motion is the
    // primary cue and its absence is a real regression rather than a cosmetic
    // one.
    //
    // Asserts the computed animation rather than the class, so a keyframe that
    // is deleted, renamed or lost to the cascade fails here. The activity marks
    // have been bitten by exactly that: an un-important override silently won
    // and an indicator stopped moving for months.
    await openPaneWithGuest(sharedPage);
    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true', { timeout: 4000 });

    const motion = await veil(sharedPage).evaluate((element) => {
      const ring = element.querySelector('.kng-drive-pulse');
      if (!ring) return null;
      const style = getComputedStyle(ring);
      return {
        name: style.animationName,
        durationMs: Math.round(parseFloat(style.animationDuration) * 1000),
        iteration: style.animationIterationCount,
      };
    });

    expect(motion).not.toBeNull();
    expect(motion?.name).not.toBe('none');
    expect(motion?.iteration).toBe('infinite');
    // The activity marks' shared period: a driving pane must breathe in
    // lockstep with every other "working" indicator rather than add a cadence.
    expect(motion?.durationMs).toBe(1400);

    // And it STOPS when the run does. An infinite opacity animation is ticked
    // and composited even at `opacity: 0`, and this subtree lives for as long
    // as the pane does in every open task window, so leaving it running would
    // be a permanent background cost for a cue nobody is looking at.
    await releaseDrive(sharedPage);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'false', { timeout: 8000 });
    const atRest = await veil(sharedPage).evaluate(
      (element) => element.querySelectorAll('.kng-drive-pulse').length,
    );
    expect(atRest).toBe(0);
  });

  test('blocks AND marks on the FIRST call, then releases the block with the agent', async () => {
    // Both halves engage on the very first call. Neither may lag it: a click
    // in that window races the agent for the page, and a page that stops
    // accepting clicks with nothing on screen explaining it is worse than a
    // brief mark. An earlier cut had both waiting for the second burst, which
    // left a whole inter-call gap (median 1.6s) unguarded and unexplained.
    //
    // They share one envelope, which is a correction. The block briefly
    // followed the RAW signal instead, on the reasoning that it should be
    // exact while the mark could linger. Measured cadence killed that: a call
    // holds the guest ~300ms out of every ~2s, so the raw signal is down for
    // ~85% of a run and the page was clickable through every gap while the
    // veil said otherwise. The gaps are the agent thinking about the page it
    // is working on, so a click there races the next call just as much.
    await openPaneWithGuest(sharedPage);
    await settleIdle(sharedPage);
    const guest = sharedPage.locator('[data-testid="browser-webview"]');
    const block = sharedPage.locator('[data-testid="browser-agent-blocking"]');

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);

    await expect(block).toHaveAttribute('data-blocking', 'true');
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true');
    expect(await guest.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');

    // The gap between calls: the burst has ended but the run has not. BOTH
    // stay engaged, because the agent is thinking about this page and will
    // call again. This is the assertion that was red against the raw-signal
    // version, and it is the reported bug.
    await releaseDrive(sharedPage);
    await sharedPage.waitForTimeout(900);
    await expect(block).toHaveAttribute('data-blocking', 'true');
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true');
    expect(await guest.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  });

  test('swallows the pointer while driving, and gives it back afterwards', async () => {
    // Blocking the mouse is a correctness fix, not just honesty about the
    // veil. A click into the page is a gesture away from the guarded element,
    // so the focus guard disarms and `restoreTarget` goes null - while main is
    // still unconditionally preventDefaulting every keyDown at the guest. The
    // user's typing then reached neither the page nor the terminal and was
    // dropped in silence. With the pointer swallowed that state is
    // unreachable.
    //
    // Both halves are asserted: the guest's OWN event capture has to go too,
    // because a `<webview>` does not reliably honour CSS stacking and a scrim
    // on top of it is not enough on its own.
    //
    // And the ANNOUNCEMENT layer must never take the pointer. It sits above
    // the blocking layer, so if it ever captured, it would keep swallowing
    // clicks through its 500ms fade after the block had already let go.
    await openPaneWithGuest(sharedPage);
    await settleIdle(sharedPage);
    const guest = sharedPage.locator('[data-testid="browser-webview"]');
    const block = sharedPage.locator('[data-testid="browser-agent-blocking"]');
    expect(await guest.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true', { timeout: 4000 });

    expect(await block.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
    expect(await veil(sharedPage).evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
    expect(await guest.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');

    // And it is given back: a pane left inert after the run would be a far
    // worse bug than the one this fixes.
    await releaseDrive(sharedPage);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'false', { timeout: 8000 });
    expect(await guest.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
    expect(await block.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  });

  test('releases immediately when the user interrupts the agent', async () => {
    // Reported from live use: cancelling mid-drive left the cue up. Waiting
    // out the link window is always wrong here - it exists to bridge the model
    // THINKING between two calls, and an interrupted agent is not thinking.
    // With the pointer swallowed it also means the user is locked out of their
    // own browser for seconds after pressing stop.
    await openPaneWithGuest(sharedPage);
    await settleIdle(sharedPage);
    await oneCall(sharedPage);
    await oneCall(sharedPage);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true');

    // The interrupt: the agent stops and the TUI waits on the user. No
    // `emitAgentInput(false)` here on purpose - main's own 400ms debounce has
    // not even run yet, which is exactly the window being closed.
    const releasedWithin = await sharedPage.evaluate((sessionId) => {
      const element = document.querySelector('[data-testid="browser-agent-driving"]');
      if (!element) throw new Error('veil element not found');
      const startedAt = performance.now();
      return new Promise<number>((resolve) => {
        const observer = new MutationObserver(() => {
          if (element.getAttribute('data-driving') === 'false') {
            observer.disconnect();
            resolve(performance.now() - startedAt);
          }
        });
        observer.observe(element, { attributes: true, attributeFilter: ['data-driving'] });
        setTimeout(() => { observer.disconnect(); resolve(Number.POSITIVE_INFINITY); }, 3000);
        window.__mockFireActivity?.(sessionId, 'idle', null);
      });
    }, SESSION_ID);

    // Generous against CI scheduling, and still an order of magnitude under
    // the 5s link window this is bypassing.
    expect(releasedWithin).toBeLessThan(600);
    expect(await sharedPage.locator('[data-testid="browser-webview"]')
      .evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');

    // And the FADE is short too, which is a separate thing from the state
    // flip and is what "it still feels like it releases slowly" turned out to
    // be: the pointer was already back while the veil spent half a second
    // telling the user not to touch a page they could touch.
    const fadeMs = await veil(sharedPage).evaluate(
      (element) => parseFloat(getComputedStyle(element).transitionDuration) * 1000,
    );
    expect(fadeMs).toBeLessThanOrEqual(150);

    await releaseDrive(sharedPage);
  });

  test('a run that winds down on its own keeps the slow fade', async () => {
    // The converse, and the reason the exit is asymmetric rather than just
    // faster. Nobody pressed anything here: the link window expired. A snap
    // would read as the veil being abruptly gone rather than as an ending.
    await openPaneWithGuest(sharedPage);
    await settleIdle(sharedPage);
    await oneCall(sharedPage);
    await oneCall(sharedPage);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'true');

    await releaseDrive(sharedPage);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'false', { timeout: 8000 });

    const fadeMs = await veil(sharedPage).evaluate(
      (element) => parseFloat(getComputedStyle(element).transitionDuration) * 1000,
    );
    expect(fadeMs).toBe(500);
  });

  test('a drive for a DIFFERENT guest never marks this pane', async () => {
    // One window can host several panes; marking the wrong one sends the user
    // looking for a problem that is not theirs.
    await openPaneWithGuest(sharedPage);
    await settleIdle(sharedPage);

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId + 1, true), GUEST_ID);

    // Past the sustained threshold, so a leaked signal would have painted.
    await sharedPage.waitForTimeout(1900);
    await expect(veil(sharedPage)).toHaveAttribute('data-driving', 'false');
  });
});

/**
 * The split row's own half of the signal, in TaskDetailBody: the accent border
 * on the pane, and the terminal that must NOT be touched.
 *
 * The terminal used to fade to 40% for the length of a drive. That was pointed
 * at the wrong pane: main reroutes every keystroke back into this terminal, so
 * it is the half that still works, and fading it while the inert half stayed
 * bright said the opposite. The border rides the same shaped envelope as the
 * pane's veil, so the two cannot drift apart.
 */
test.describe('an agent drive marks the pane, not the terminal', () => {
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

  test('accents the right-panel border while driving, then reverts', async () => {
    await openPaneWithGuest(sharedPage);

    const rightPanel = guardDialog(sharedPage).locator('[data-testid="task-detail-right-panel"]');
    await expect(rightPanel).toHaveClass(/border-edge/, { timeout: 8000 });

    // A single held burst, so it opens on the sustained threshold rather than
    // on a second call.
    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);
    await expect(rightPanel).toHaveClass(/border-accent/, { timeout: 4000 });

    // The run closes `AGENT_DRIVE_VEIL_LINK_MS` (5s) after the burst ends, so
    // this has to outlast Playwright's 5s default or it races the product.
    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, false), GUEST_ID);
    await expect(rightPanel).toHaveClass(/border-edge/, { timeout: 8000 });
  });

  test('leaves the terminal at full opacity throughout', async () => {
    // Red-green against the old treatment: this reads opacity-40 the moment
    // the dim comes back. The terminal keeps receiving the user's keystrokes
    // during a drive, so fading it is describing the wrong half of the split.
    await openPaneWithGuest(sharedPage);
    await sharedPage
      .evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, false), GUEST_ID)
      .catch(() => {});
    const terminal = guardDialog(sharedPage).locator('[data-testid="task-detail-terminal-dim"]');

    const before = await terminal.evaluate((element) => getComputedStyle(element).opacity);
    expect(before).toBe('1');

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, true), GUEST_ID);
    await expect(guardDialog(sharedPage).locator('[data-testid="task-detail-right-panel"]'))
      .toHaveClass(/border-accent/, { timeout: 4000 });

    const during = await terminal.evaluate((element) => getComputedStyle(element).opacity);
    expect(during).toBe('1');
    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId, false), GUEST_ID);
  });

  test('a drive for a DIFFERENT guest never accents this task\'s border', async () => {
    await openPaneWithGuest(sharedPage);

    await sharedPage.evaluate((guestId) => window.__mockBrowser?.emitAgentInput(guestId + 1, true), GUEST_ID);

    // Intentional fixed wait, not a poll: cannot poll for non-occurrence (the
    // border already reads border-edge before any signal fires, so a poll for
    // that value would return immediately and prove nothing about a delayed
    // accent). Past the sustained threshold, so a leaked signal would have
    // painted by now.
    await sharedPage.waitForTimeout(1900);
    await expect(guardDialog(sharedPage).locator('[data-testid="task-detail-right-panel"]'))
      .toHaveClass(/border-edge/);
  });
});
