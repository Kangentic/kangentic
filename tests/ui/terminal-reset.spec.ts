/**
 * The Reset terminal hotkey in a real browser: a bound combo reaches the focused
 * terminal's reset ahead of xterm, so nothing is typed into the agent, and it
 * replays the session with focus left where it was. What the reset clears is
 * pinned at the unit tier (terminal-mode-reset.test.ts); this is the key's wiring.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { fireSessionData, launchWithTransientTerminal, openTransientCommandTerminal, writtenToSession } from './helpers';

test.describe.configure({ mode: 'parallel' });

const SESSION_ID = 'sess-terminal-reset';
const RESET_COMBO = 'Alt+Shift+R';

function launch(hotkeyOverrides?: Record<string, string>) {
  return launchWithTransientTerminal({
    projectId: 'proj-terminal-reset',
    projectName: 'Terminal Reset Project',
    sessionId: SESSION_ID,
    hotkeyOverrides,
  });
}

function resetCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as {
    electronAPI: { sessions: { __resetTerminalCalls: string[] } };
  }).electronAPI.sessions.__resetTerminalCalls);
}

function replayCount(page: Page): Promise<number> {
  return page.evaluate((sessionId) => (window as unknown as {
    __mockScrollbackCalls?: Array<{ sessionId: string }>;
  }).__mockScrollbackCalls?.filter((call) => call.sessionId === sessionId).length ?? 0, SESSION_ID);
}

function resizeCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as {
    electronAPI: { sessions: { __resizeCalls: unknown[] } };
  }).electronAPI.sessions.__resizeCalls.length);
}

/** Primary device attributes, which xterm always answers. */
const DEVICE_ATTRIBUTES_QUERY = '\x1b[c';
const DEVICE_ATTRIBUTES_REPLY = /\x1b\[\?[\d;]+c/gu;

/**
 * The mount replay has landed and the focus it hands the terminal has run. The
 * replay releases the live bytes it held, then schedules that focus on the next
 * animation frame (`focusOnArrival`), so a reply to a device-attributes query is
 * proof the replay is over, and one more frame runs the focus. Without this a blur
 * can land first, the frame hands focus back, and a press meant to do nothing
 * resets the terminal. The veil `TerminalTab` draws is not in a Command Terminal,
 * so waiting for it proves nothing here.
 */
async function settleMountFocus(page: Page): Promise<void> {
  // Re-fired inside the poll: a chunk that lands during the mount replay is
  // superseded by the replay's frame.
  await expect.poll(async () => {
    await fireSessionData(page, SESSION_ID, DEVICE_ATTRIBUTES_QUERY);
    return [...(await writtenToSession(page, SESSION_ID)).matchAll(DEVICE_ATTRIBUTES_REPLY)].length;
  }, { timeout: 10000, intervals: [250] }).toBeGreaterThan(0);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/**
 * The mount fit and the refit after the footer mounts have both reached the PTY.
 * Each is sent after a 200 ms debounce, so a count taken before they land moves
 * under the test. Settled is the count holding across one poll interval, the same
 * fence command-terminal.spec.ts uses before its resize assertions.
 */
async function settleMountResizes(page: Page): Promise<void> {
  let previousCount = -1;
  await expect.poll(async () => {
    const count = await resizeCount(page);
    const settled = count > 0 && count === previousCount;
    previousCount = count;
    return settled;
  }, { intervals: [500], timeout: 10000 }).toBe(true);
}

async function focusedTerminal(commandWindow: Locator): Promise<Locator> {
  const textarea = commandWindow.locator('.xterm-helper-textarea').first();
  await textarea.focus();
  await expect(textarea).toBeFocused();
  return textarea;
}

test('a bound combo resets the focused terminal, replays it, and types nothing', async () => {
  const { browser, page } = await launch({ 'terminal.reset': RESET_COMBO });
  try {
    const commandWindow = await openTransientCommandTerminal(page, SESSION_ID);
    const textarea = await focusedTerminal(commandWindow);
    // The mount replay and any corrective reload settle first, so the count
    // below moves only for the reset.
    await expect(page.getByTestId('terminal-replay-veil')).toHaveCount(0);
    const replaysBefore = await replayCount(page);
    const writtenBefore = await writtenToSession(page, SESSION_ID);

    await page.keyboard.press(RESET_COMBO);

    await expect.poll(() => resetCalls(page)).toEqual([SESSION_ID]);
    await expect.poll(() => replayCount(page)).toBeGreaterThan(replaysBefore);
    expect(await writtenToSession(page, SESSION_ID)).toBe(writtenBefore);
    await expect(textarea).toBeFocused();
  } finally {
    await browser.close();
  }
});

test('the combo does nothing while focus is outside the terminal', async () => {
  const { browser, page } = await launch({ 'terminal.reset': RESET_COMBO });
  try {
    const commandWindow = await openTransientCommandTerminal(page, SESSION_ID);
    await settleMountFocus(page);
    const textarea = await focusedTerminal(commandWindow);
    await textarea.blur();
    await expect(textarea).not.toBeFocused();

    await page.keyboard.press(RESET_COMBO);
    // The same press with focus back is the fence: one call, and it is this one.
    await focusedTerminal(commandWindow);
    await page.keyboard.press(RESET_COMBO);

    await expect.poll(() => resetCalls(page)).toEqual([SESSION_ID]);
  } finally {
    await browser.close();
  }
});

test('ships unbound, so the same keys go to the terminal', async () => {
  const { browser, page } = await launch();
  try {
    const commandWindow = await openTransientCommandTerminal(page, SESSION_ID);
    await focusedTerminal(commandWindow);

    await page.keyboard.press(RESET_COMBO);

    // Reaching the PTY is the control: the key was delivered and nothing took it.
    // The R alone, because xterm drops the Alt prefix on macOS.
    await expect.poll(() => writtenToSession(page, SESSION_ID)).toContain('R');
    expect(await resetCalls(page)).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a held key resets once and types nothing', async () => {
  const { browser, page } = await launch({ 'terminal.reset': RESET_COMBO });
  try {
    const commandWindow = await openTransientCommandTerminal(page, SESSION_ID);
    await focusedTerminal(commandWindow);
    await expect(page.getByTestId('terminal-replay-veil')).toHaveCount(0);
    const writtenBefore = await writtenToSession(page, SESSION_ID);

    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.keyboard.down('R');
    // The second down of a held key carries repeat: true.
    await page.keyboard.down('R');
    await page.keyboard.down('R');
    await page.keyboard.up('R');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');

    await expect.poll(() => resetCalls(page)).toEqual([SESSION_ID]);
    // The repeats must be consumed, not left for xterm to type into the PTY.
    expect(await writtenToSession(page, SESSION_ID)).toBe(writtenBefore);
    expect(await resetCalls(page)).toEqual([SESSION_ID]);
  } finally {
    await browser.close();
  }
});

test('a rejected reset is swallowed: no page error and no replay', async () => {
  const { browser, page } = await launch({ 'terminal.reset': RESET_COMBO });
  try {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const commandWindow = await openTransientCommandTerminal(page, SESSION_ID);
    await focusedTerminal(commandWindow);
    await expect(page.getByTestId('terminal-replay-veil')).toHaveCount(0);
    const replaysBefore = await replayCount(page);

    await page.evaluate(() => { (window as unknown as { __mockResetTerminalReject?: boolean }).__mockResetTerminalReject = true; });
    await page.keyboard.press(RESET_COMBO);
    await expect.poll(() => resetCalls(page)).toEqual([SESSION_ID]);

    // A press that succeeds is the fence: its replay is the only one, and the
    // rejected press ahead of it left none.
    await page.evaluate(() => { (window as unknown as { __mockResetTerminalReject?: boolean }).__mockResetTerminalReject = false; });
    await page.keyboard.press(RESET_COMBO);
    await expect.poll(() => resetCalls(page)).toEqual([SESSION_ID, SESSION_ID]);
    await expect.poll(() => replayCount(page)).toBeGreaterThan(replaysBefore);
    await expect(page.getByTestId('terminal-replay-veil')).toHaveCount(0);
    expect(await replayCount(page)).toBe(replaysBefore + 1);
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('the replay after a reset asks for no resize', async () => {
  const { browser, page } = await launch({ 'terminal.reset': RESET_COMBO });
  try {
    const commandWindow = await openTransientCommandTerminal(page, SESSION_ID);
    await focusedTerminal(commandWindow);
    await expect(page.getByTestId('terminal-replay-veil')).toHaveCount(0);
    await settleMountResizes(page);
    const replaysBefore = await replayCount(page);
    const resizesBefore = await resizeCount(page);

    await page.keyboard.press(RESET_COMBO);
    await expect.poll(() => replayCount(page)).toBeGreaterThan(replaysBefore);
    await expect(page.getByTestId('terminal-replay-veil')).toHaveCount(0);

    expect(await resizeCount(page)).toBe(resizesBefore);
  } finally {
    await browser.close();
  }
});
