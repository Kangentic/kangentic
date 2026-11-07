/**
 * The terminal find bar on the real browser bundle: xterm, its search addon, and the
 * key paths a mock cannot stand in for. Mod+F has to beat xterm's capture pass, and
 * Escape has to beat both xterm and a task window's close. Each is read off the mock's
 * `sessions.write` log, so a key that leaked to the agent shows up as bytes.
 */
import path from 'node:path';
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import {
  fireSessionData,
  gotoVite,
  launchWithTransientTerminal,
  openTransientCommandTerminal,
  TERMINAL_TEXT_LAUNCH_ARGS,
  waitForViteReady,
  writtenToSession,
} from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const RUN_ID = Math.random().toString(36).slice(2, 8);

const findBar = (page: Page) => page.getByTestId('terminal-find-bar');
const findInput = (page: Page | Locator) => page.getByTestId('terminal-find-input');
const findCount = (page: Page) => page.getByTestId('terminal-find-count');

async function isTerminalFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'));
}

/** Every grid sent to the session's PTY, oldest first. */
async function gridsSent(page: Page, sessionId: string): Promise<string[]> {
  return page.evaluate((targetSessionId) => {
    const calls = (window as unknown as {
      electronAPI: { sessions: { __resizeCalls: Array<{ sessionId: string; cols: number; rows: number }> } };
    }).electronAPI.sessions.__resizeCalls;
    return calls.filter((call) => call.sessionId === targetSessionId).map((call) => `${call.cols}x${call.rows}`);
  }, sessionId);
}

/** The grids sent so far, once a mount's own resizes have stopped arriving. */
async function settledGrids(page: Page, sessionId: string): Promise<string[]> {
  let grids: string[] = [];
  let previousCount = -1;
  await expect.poll(async () => {
    grids = await gridsSent(page, sessionId);
    const settled = grids.length === previousCount;
    previousCount = grids.length;
    return settled;
  }, { intervals: [500] }).toBe(true);
  return grids;
}

async function lastClipboardWrite(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const calls = (window as unknown as {
      electronAPI: { clipboard: { __writeTextCalls: string[] } };
    }).electronAPI.clipboard.__writeTextCalls;
    return calls[calls.length - 1];
  });
}

/** Each decorated color in the Command Terminal, with the text drawn in it. Needs the DOM
 *  renderer, which draws a decorated cell as its own span. */
async function decoratedTextByColor(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const textByColor: Record<string, string> = {};
    for (const span of document.querySelectorAll<HTMLElement>('[data-testid="command-terminal-window"] .xterm-rows span')) {
      const color = span.style.backgroundColor;
      if (color) textByColor[color] = (textByColor[color] ?? '') + span.textContent;
    }
    return textByColor;
  });
}

/** Erases the screen and the scrollback, and homes the cursor. */
const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';

/** A Command Terminal holding `output`, with its xterm focused. A chunk that lands during the
 *  mount replay is superseded by it, so a sentinel is fired in a poll until one lands live.
 *  `output` then goes once, on a cleared terminal. The poll reads the DOM renderer's rows. */
async function terminalWithOutput(sessionId: string, output: string): Promise<{ browser: Browser; page: Page }> {
  const { browser, page } = await launchWithTransientTerminal({
    projectId: `proj-find-${sessionId}`,
    projectName: 'Find Project',
    sessionId,
    launchArgs: TERMINAL_TEXT_LAUNCH_ARGS,
  });
  await openTransientCommandTerminal(page, sessionId);
  await expect.poll(() => isTerminalFocused(page), { timeout: 8000 }).toBe(true);
  const terminalText = page.getByTestId('command-terminal-window').locator('.xterm');
  await expect.poll(async () => {
    await fireSessionData(page, sessionId, 'replay-done\r\n');
    return terminalText.innerText();
  }, { timeout: 8000 }).toContain('replay-done');
  await fireSessionData(page, sessionId, CLEAR_TERMINAL + output);
  return { browser, page };
}

test('Mod+F opens the bar, sends nothing to the agent, and resizes nothing', async () => {
  const sessionId = `sess-find-keys-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle one\r\nneedle two\r\nneedle three\r\n');
  try {
    const gridsBefore = await settledGrids(page, sessionId);
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findBar(page)).toBeVisible();
    await expect(findInput(page)).toBeFocused();

    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 3');

    // Enter walks up through the output, Shift+Enter comes back.
    await page.keyboard.press('Enter');
    await expect(findCount(page)).toHaveText('2 of 3');
    await page.keyboard.press('Shift+Enter');
    await expect(findCount(page)).toHaveText('1 of 3');

    // The shortcut again selects the query, ready to type over.
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).toBeFocused();
    await expect.poll(() => findInput(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]))
      .toEqual([0, 'needle'.length]);

    await page.keyboard.press('Escape');
    await expect(findBar(page)).toHaveCount(0);
    await expect.poll(() => isTerminalFocused(page)).toBe(true);

    const written = await writtenToSession(page, sessionId);
    expect(written).not.toContain('\x06');
    expect(written).not.toContain('\x1b');
    expect(written).not.toContain('needle');
    const gridsSince = (await gridsSent(page, sessionId)).slice(gridsBefore.length);
    expect(gridsSince.filter((grid) => grid !== gridsBefore.at(-1))).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('closing clears the selected match, so the next Ctrl+C still interrupts', async () => {
  const sessionId = `sess-find-interrupt-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle\r\n');
  try {
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 1');
    await page.keyboard.press('Escape');
    await expect(findBar(page)).toHaveCount(0);

    await page.keyboard.press('Control+c');
    await expect.poll(() => writtenToSession(page, sessionId)).toContain('\x03');
  } finally {
    await browser.close();
  }
});

test('with focus back in the terminal, Escape closes the bar and never reaches the agent', async () => {
  const sessionId = `sess-find-escape-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle\r\n');
  try {
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await page.getByTestId('command-bar-terminal').click({ position: { x: 200, y: 200 } });
    await expect.poll(() => isTerminalFocused(page)).toBe(true);
    await expect(findBar(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(findBar(page)).toHaveCount(0);
    expect(await writtenToSession(page, sessionId)).not.toContain('\x1b');

    // With the bar gone, Escape is the agent's again.
    await page.keyboard.press('Escape');
    await expect.poll(() => writtenToSession(page, sessionId)).toContain('\x1b');
  } finally {
    await browser.close();
  }
});

test('the header icon opens and closes the bar and shows it pressed', async () => {
  const sessionId = `sess-find-icon-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle\r\n');
  try {
    const icon = page.getByTestId('command-bar-find-toggle');
    await icon.click();
    await expect(findInput(page)).toBeFocused();
    await icon.click();
    await expect(findBar(page)).toHaveCount(0);
    await expect.poll(() => isTerminalFocused(page)).toBe(true);
  } finally {
    await browser.close();
  }
});

test('the alternate screen says the search covers the screen', async () => {
  const sessionId = `sess-find-alternate-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'history-only\r\n');
  try {
    await fireSessionData(page, sessionId, '\x1b[?1049h\x1b[H\x1b[2Jneedle on screen\r\nneedle again\r\n');
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).toHaveAttribute('placeholder', 'Find on screen');

    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 2 on screen');

    await findInput(page).fill('history-only');
    await expect(page.getByTestId('terminal-find-no-matches')).toHaveText('No matches on screen');

    // Leaving it, the bar says so and the search reaches the history again.
    await fireSessionData(page, sessionId, '\x1b[?1049l');
    await expect(findInput(page)).toHaveAttribute('placeholder', 'Find');
    await expect(findCount(page)).toHaveText('1 of 1');
  } finally {
    await browser.close();
  }
});

test('nothing found names how many lines were searched', async () => {
  const sessionId = `sess-find-reach-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'one\r\ntwo\r\nthree\r\n');
  try {
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('absent');
    await expect(page.getByTestId('terminal-find-no-matches')).toHaveText(/^No matches in the last \d+ lines$/);
    await expect(page.getByTestId('terminal-find-older')).toBeDisabled();
  } finally {
    await browser.close();
  }
});

test('a common term stops at the highlight limit and says so', async () => {
  const sessionId = `sess-find-limit-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle\r\n'.repeat(1200));
  try {
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1000+');
  } finally {
    await browser.close();
  }
});

test('the count catches up once a stream of output pauses', async () => {
  const sessionId = `sess-find-stream-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle\r\n');
  try {
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 1');

    await fireSessionData(page, sessionId, 'needle\r\nneedle\r\n');
    await expect(findCount(page)).toHaveText(/ of 3$/, { timeout: 5000 });
  } finally {
    await browser.close();
  }
});

/** What the selected match copies as. A selection on the wrong cells copies other text. */
async function copySelectedMatch(page: Page): Promise<string | undefined> {
  // A script focus, because a click into the terminal would clear the selection.
  await page.locator('[data-testid="command-terminal-window"] .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => lastClipboardWrite(page)).toBeTruthy();
  return lastClipboardWrite(page);
}

test('a match after wide characters selects its own cells', async () => {
  const sessionId = `sess-find-wide-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, '日本語 ✅ needle 🔥 end\r\n');
  try {
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 1');
    expect(await copySelectedMatch(page)).toBe('needle');
  } finally {
    await browser.close();
  }
});

test('a match split by autowrap is found across the two rows', async () => {
  const sessionId = `sess-find-wrap-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, '');
  try {
    const cols = await page.evaluate((id) => {
      const calls = (window as unknown as {
        electronAPI: { sessions: { __resizeCalls: Array<{ sessionId: string; cols: number }> } };
      }).electronAPI.sessions.__resizeCalls.filter((call) => call.sessionId === id);
      return calls[calls.length - 1].cols;
    }, sessionId);
    await fireSessionData(page, sessionId, `${'x'.repeat(cols - 3)}needle\r\n`);

    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 1');
    expect(await copySelectedMatch(page)).toBe('needle');
  } finally {
    await browser.close();
  }
});

test('the DOM renderer draws the highlights too', async () => {
  const sessionId = `sess-find-dom-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'plain needle plain\r\nplain needle plain\r\n');
  try {
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 2');
    // A color's cells read back as the match's letters: the other match, then the
    // active one, each on exactly its own cells, in the default theme's blend.
    await expect.poll(() => decoratedTextByColor(page), { timeout: 5000 })
      .toEqual({ 'rgb(84, 72, 30)': 'needle', 'rgb(125, 107, 40)': 'needle' });
  } finally {
    await browser.close();
  }
});

function taskSetup(suffix: string): string {
  return `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: 'proj-find-${suffix}', name: 'Find ${suffix}', path: '/mock/find-${suffix}',
        github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
      });
      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-find-${suffix}-' + index;
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, { id: laneId, position: index, created_at: timestamp }));
      });
      state.sessions.push({
        id: 'sess-${suffix}', taskId: 'task-${suffix}', projectId: 'proj-find-${suffix}', pid: 6100,
        status: 'running', shell: 'bash', cwd: '/mock/find-${suffix}', startedAt: timestamp,
        exitCode: null, resuming: false,
      });
      state.tasks.push({
        id: 'task-${suffix}', display_id: 1, title: 'Find task', description: '',
        swimlane_id: executingLaneId, position: 0, agent: 'claude', session_id: 'sess-${suffix}',
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null, base_branch: null,
        archived_at: null, created_at: timestamp, updated_at: timestamp,
      });
      state.activityCache['sess-${suffix}'] = 'thinking';
      var transcriptSeeds = {};
      transcriptSeeds['sess-${suffix}'] = {
        sessionId: 'sess-${suffix}', taskId: 'task-${suffix}', taskTitle: 'Find task', agentName: 'Claude Code',
        startedAt: timestamp, sessionStatus: 'running', source: 'live', sourcePath: '/mock/find-${suffix}.jsonl',
        entries: [{ kind: 'user', uuid: 'turn-${suffix}', ts: Date.now(), text: 'A message in the conversation' }],
        degraded: false,
        sessions: [{ sessionId: 'sess-${suffix}', agentName: 'Claude Code', startedAt: timestamp, exitedAt: null, isolatedSwimlaneId: null, status: 'running' }],
      };
      return { currentProjectId: 'proj-find-${suffix}', transcriptSeeds: transcriptSeeds };
    });
  `;
}

async function launchWithTask(suffix: string, extraInit?: string): Promise<{ browser: Browser; page: Page; sessionId: string }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(taskSetup(suffix));
  if (extraInit) await page.addInitScript(extraInit);
  await gotoVite(page);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
  const sessionId = `sess-${suffix}`;
  await page.evaluate((id) => {
    (window as unknown as { __mockFireFirstOutput?: (session: string) => void }).__mockFireFirstOutput?.(id);
  }, sessionId);
  return { browser, page, sessionId };
}

async function openTaskWindow(page: Page, suffix: string): Promise<void> {
  await page.locator(`[data-task-id="task-${suffix}"]`).click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  await expect(dialog.locator('.xterm-helper-textarea').first()).toBeAttached({ timeout: 8000 });
  await expect.poll(() => isTerminalFocused(page), { timeout: 8000 }).toBe(true);
}

test('in a task window, Escape closes the bar and leaves the window open', async () => {
  const suffix = `window-${RUN_ID}`;
  const { browser, page, sessionId } = await launchWithTask(suffix);
  try {
    await openTaskWindow(page, suffix);
    await page.getByTestId('terminal-find-toggle').click();
    await expect(findInput(page)).toBeFocused();
    await expect(page.getByTestId('terminal-find-toggle')).toHaveClass(/text-accent-fg/);

    // The pointer is on the header, outside the terminal, which is where the
    // terminal hands Escape to the window.
    await page.keyboard.press('Escape');
    await expect(findBar(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeVisible();
    expect(await writtenToSession(page, sessionId)).not.toContain('\x1b');

    // With the bar closed, the same Escape closes the window, as it always has.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('a click on the bar\'s dead space keeps the keyboard in the find field', async () => {
  const suffix = `dead-space-${RUN_ID}`;
  const { browser, page, sessionId } = await launchWithTask(suffix);
  try {
    await openTaskWindow(page, suffix);
    await fireSessionData(page, sessionId, 'needle\r\n');
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 1');

    await findCount(page).click();
    await expect(findInput(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(findBar(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('with a conversation window focused, Ctrl+F from a terminal opens only the find bar', async () => {
  const suffix = `conversation-${RUN_ID}`;
  const { browser, page, sessionId } = await launchWithTask(suffix);
  try {
    await page.evaluate((id) => {
      (window as unknown as {
        __zustandStores: { session: { getState: () => { setConversationSessionId: (session: string) => void } } };
      }).__zustandStores.session.getState().setConversationSessionId(id);
    }, sessionId);
    const conversationSearch = page.getByTestId('conversation-search-input');
    await expect(conversationSearch).toBeVisible({ timeout: 10000 });

    const panelTerminal = page.locator('[data-testid="terminal-tab-container"]').first();
    await expect(panelTerminal.locator('.xterm-helper-textarea')).toBeAttached({ timeout: 10000 });
    await panelTerminal.click({ position: { x: 100, y: 60 } });
    await expect.poll(() => isTerminalFocused(page)).toBe(true);

    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).toBeFocused();
    await page.keyboard.type('needle');
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).toBeFocused();
    await expect(findInput(page)).toHaveValue('needle');
  } finally {
    await browser.close();
  }
});

test('a replay landing while typing leaves the keyboard in the find field', async () => {
  const suffix = `reload-${RUN_ID}`;
  const { browser, page, sessionId } = await launchWithTask(suffix);
  try {
    // Holds the mount replay open past the search, so its arrival focus lands
    // while the field has the keyboard. The window's own terminal is allowed to
    // take that focus, which is what the find field has to survive.
    await page.evaluate((id) => {
      (window as unknown as { __mockScrollbackDelayMs?: Record<string, number> })
        .__mockScrollbackDelayMs = { [id]: 1500 };
    }, sessionId);
    await openTaskWindow(page, suffix);
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');

    await expect(page.getByTestId('terminal-replay-veil')).toHaveCount(0, { timeout: 8000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(findInput(page)).toBeFocused();
    await expect(findBar(page)).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('the bottom panel has no icon, and Ctrl+F still opens its bar', async () => {
  const suffix = `panel-${RUN_ID}`;
  const { browser, page } = await launchWithTask(suffix);
  try {
    const panelTerminal = page.locator('[data-testid="terminal-tab-container"]').first();
    await expect(panelTerminal.locator('.xterm-helper-textarea')).toBeAttached({ timeout: 10000 });
    await panelTerminal.click({ position: { x: 100, y: 60 } });
    await expect.poll(() => isTerminalFocused(page)).toBe(true);

    await expect(page.getByTestId('terminal-find-toggle')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).toBeFocused();
  } finally {
    await browser.close();
  }
});

test('Ctrl+F away from a terminal stays the board search', async () => {
  const suffix = `board-${RUN_ID}`;
  const { browser, page } = await launchWithTask(suffix);
  try {
    await page.locator('[data-swimlane-name="Executing"]').click({ position: { x: 20, y: 200 } });
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findBar(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="board-search"]')).toBeFocused();
  } finally {
    await browser.close();
  }
});

test('Ctrl+Shift+F from a terminal still opens Quick Find', async () => {
  const sessionId = `sess-find-quick-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle\r\n');
  try {
    await page.keyboard.press('ControlOrMeta+Shift+F');
    await expect(page.getByTestId('search-palette')).toBeVisible();
    await expect(findBar(page)).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

const commandWindow = (page: Page) => page.getByTestId('command-terminal-window');
const commandKebab = (page: Page) => commandWindow(page).getByRole('button', { name: 'Actions' });

test('the bar\'s own buttons step through matches and close it, and an IME Escape leaves it open', async () => {
  const sessionId = `sess-find-buttons-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle one\r\nneedle two\r\nneedle three\r\n');
  try {
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 3');

    await page.getByTestId('terminal-find-older').click();
    await expect(findCount(page)).toHaveText('2 of 3');
    await page.getByTestId('terminal-find-newer').click();
    await expect(findCount(page)).toHaveText('1 of 3');

    // A key that confirms an IME composition is not the user's Escape. The
    // dispatched event has to bubble to the capture listener on document.
    await findInput(page).evaluate((input) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    });
    // The close is synchronous with the dispatch, so the bar is already gone if it was going to be.
    await expect(findBar(page)).toBeVisible();
    await expect(findInput(page)).toHaveValue('needle');

    await page.getByTestId('terminal-find-close').click();
    await expect(findBar(page)).toHaveCount(0);
    await expect.poll(() => isTerminalFocused(page)).toBe(true);
  } finally {
    await browser.close();
  }
});

test('the kebab opens and closes the bar and its label follows, and Escape in the bar leaves an open menu to close first', async () => {
  const sessionId = `sess-find-kebab-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle\r\n');
  try {
    await commandKebab(page).click();
    await expect(page.getByTestId('command-bar-kebab-find')).toHaveText('Find in terminal');
    await page.getByTestId('command-bar-kebab-find').click();
    await expect(findInput(page)).toBeFocused();

    await commandKebab(page).click();
    await expect(page.getByTestId('command-bar-kebab-find')).toHaveText('Close find');

    // Focus back in the bar's field with the menu still open: the key is the bar's
    // by pane, and the menu's by layer. One press undoes one thing, the menu.
    await findInput(page).evaluate((input: HTMLInputElement) => input.focus());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-bar-kebab-find')).toHaveCount(0);
    await expect(findBar(page)).toBeVisible();

    await commandKebab(page).click();
    await page.getByTestId('command-bar-kebab-find').click();
    await expect(findBar(page)).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('a bar closed and opened again searches, highlights and steps as the first did', async () => {
  const sessionId = `sess-find-reopen-${RUN_ID}`;
  const { browser, page } = await terminalWithOutput(sessionId, 'plain needle plain\r\nplain needle plain\r\n');
  try {
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 2');
    await expect.poll(() => decoratedTextByColor(page), { timeout: 5000 }).not.toEqual({});
    await page.keyboard.press('Escape');
    await expect(findBar(page)).toHaveCount(0);
    await expect.poll(() => decoratedTextByColor(page), { timeout: 5000 }).toEqual({});

    // Closing replaces the search addon. The new one has to reach the same listeners.
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('needle');
    await expect(findCount(page)).toHaveText('1 of 2');
    await page.getByTestId('terminal-find-older').click();
    await expect(findCount(page)).toHaveText('2 of 2');
    await page.getByTestId('terminal-find-newer').click();
    await expect(findCount(page)).toHaveText('1 of 2');

    await expect.poll(() => decoratedTextByColor(page), { timeout: 5000 })
      .toEqual({ 'rgb(84, 72, 30)': 'needle', 'rgb(125, 107, 40)': 'needle' });
  } finally {
    await browser.close();
  }
});

test('with two terminals on screen, the shortcut and Escape act only on the focused pane\'s bar', async () => {
  const sessionId = `sess-find-two-${RUN_ID}`;
  const secondSessionId = `${sessionId}-b`;
  const { browser, page } = await terminalWithOutput(sessionId, 'needle\r\n');
  try {
    // The mock hands every Command Terminal the same session id, so the second one gets its own.
    await page.evaluate((nextSessionId) => {
      const sessions = (window as unknown as {
        electronAPI: { sessions: { spawnTransient: (input: unknown) => Promise<{ session: Record<string, unknown> }> } };
      }).electronAPI.sessions;
      const original = sessions.spawnTransient;
      sessions.spawnTransient = async (input) => {
        const result = await original(input);
        return { ...result, session: { ...result.session, id: nextSessionId, taskId: nextSessionId } };
      };
    }, secondSessionId);
    await page.getByTestId('command-terminal-new').click();
    const windows = commandWindow(page);
    await expect(windows).toHaveCount(2);
    await page.evaluate((id) => {
      (window as unknown as {
        __zustandStores: { session: { getState: () => { markFirstOutput: (session: string) => void } } };
      }).__zustandStores.session.getState().markFirstOutput(id);
    }, secondSessionId);
    await expect(windows.nth(1).locator('.xterm-helper-textarea')).toBeAttached({ timeout: 8000 });
    const first = windows.nth(0);
    const second = windows.nth(1);

    // The new window holds window-layer focus, so its terminal takes keyboard focus every time
    // one of its arrivals lands (deferred init, mount replay, the reload after the tiling
    // refit). A script focus on the first pane does not move window-layer focus, so an arrival
    // between that focus and the key sends the shortcut to the second pane. A click is the
    // user's own gesture and moves window-layer focus, so the arbiter denies the other
    // window's arrivals from then on (terminal-arrival-focus.md, tier 2).
    await first.locator('.xterm').click();
    await expect(first.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(first.getByTestId('terminal-find-bar')).toBeVisible();
    await expect(findBar(page)).toHaveCount(1);

    await second.locator('.xterm').click();
    await expect(second.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(second.getByTestId('terminal-find-bar')).toBeVisible();
    await expect(findBar(page)).toHaveCount(2);

    // Escape from the second pane's field closes its bar, and the first's stays.
    await expect(findInput(second)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(second.getByTestId('terminal-find-bar')).toHaveCount(0);
    await expect(first.getByTestId('terminal-find-bar')).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('in a task window, the kebab opens the bar and its label follows', async () => {
  const suffix = `task-kebab-${RUN_ID}`;
  const { browser, page } = await launchWithTask(suffix);
  try {
    await openTaskWindow(page, suffix);
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    const menuItem = page.getByTestId('terminal-find-menu-item');

    await dialog.getByRole('button', { name: 'Actions' }).click();
    await expect(menuItem).toHaveText('Find in terminal');
    await menuItem.click();
    await expect(findInput(page)).toBeFocused();

    await dialog.getByRole('button', { name: 'Actions' }).click();
    await expect(menuItem).toHaveText('Close find');
    await menuItem.click();
    await expect(findBar(page)).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

// The init queue builds a terminal on an animation frame. Holding that one callback
// keeps the xterm from existing while the window's header toggle is already there.
const HOLD_TERMINAL_INIT = `
  (function () {
    var realFrame = window.requestAnimationFrame.bind(window);
    var held = [];
    var holding = true;
    window.requestAnimationFrame = function (callback) {
      if (holding && callback && callback.name === 'pumpInitQueue') {
        held.push(callback);
        return 0;
      }
      return realFrame(callback);
    };
    window.__releaseTerminalInit = function () {
      holding = false;
      held.splice(0).forEach(function (callback) { realFrame(callback); });
    };
  })();
`;

test('a bar opened before its terminal exists still shows the count once the terminal arrives', async () => {
  const suffix = `early-${RUN_ID}`;
  const { browser, page, sessionId } = await launchWithTask(suffix, HOLD_TERMINAL_INIT);
  try {
    await page.locator(`[data-task-id="task-${suffix}"]`).click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('terminal-find-toggle').click();
    await expect(findInput(page)).toBeFocused();
    // The premise: the bar is open and no xterm has been built behind it.
    await expect(dialog.locator('.xterm-helper-textarea')).toHaveCount(0);

    await page.evaluate(() => (window as unknown as { __releaseTerminalInit: () => void }).__releaseTerminalInit());
    await expect(dialog.locator('.xterm-helper-textarea').first()).toBeAttached({ timeout: 8000 });
    await expect(page.getByTestId('terminal-replay-veil')).toHaveCount(0, { timeout: 8000 });
    await fireSessionData(page, sessionId, 'needle one\r\nneedle two\r\n');

    await findInput(page).fill('needle');
    await expect(findCount(page)).toHaveText('1 of 2');
  } finally {
    await browser.close();
  }
});
