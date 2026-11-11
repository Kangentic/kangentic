/**
 * A click on a link opens the browser the "Click opens links in" setting names, Ctrl or
 * Cmd click opens the other, and the click never also reaches a TUI that holds the
 * mouse. A drag across a link, and the click that only brought the terminal forward,
 * open nothing. Only a browser proves this: xterm's Linkifier and its mouse reporting
 * are DOM listeners on the terminal element, and the order they run in decides it.
 *
 * Claude Code opens a link itself on a click report, so a report that got through
 * would open a second browser tab. See src/renderer/utils/terminal-links/link-gesture.ts.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  fireSessionData,
  launchWithTransientTerminal,
  openTransientCommandTerminal,
  writtenToSession,
} from './helpers';

test.describe.configure({ mode: 'parallel' });

const SESSION_ID = 'sess-link-click-1';
const URL_TEXT = 'https://example.com/docs';
const PATH_TEXT = 'src/app.ts:42';
/** VT200 mouse tracking in SGR encoding, what a fullscreen TUI turns on. */
const TRACK_MOUSE = '\x1b[?1000h\x1b[?1006h';
const CLEAR_TO_FIRST_ROW = '\x1b[2J\x1b[1;1H';
const SGR_PRESS = /\x1b\[<\d+;\d+;\d+M/u;
/** Primary device attributes, which xterm always answers. */
const DEVICE_ATTRIBUTES_QUERY = '\x1b[c';
const DEVICE_ATTRIBUTES_REPLY = /\x1b\[\?[\d;]+c/gu;

function terminalScreen(page: Page): Locator {
  return page.getByTestId('command-terminal-window').locator('.xterm-screen').first();
}

async function pointAtFirstRow(page: Page): Promise<void> {
  const screen = await terminalScreen(page).boundingBox();
  expect(screen).not.toBeNull();
  // A few pixels in lands on the first cells of the first row at any font size.
  await page.mouse.move(screen!.x + 40, screen!.y + 6);
  await page.mouse.move(screen!.x + 42, screen!.y + 6);
}

/** xterm's Linkifier sets this on the screen element while a link is under the pointer. */
async function waitForLinkUnderPointer(page: Page): Promise<void> {
  await expect(terminalScreen(page)).toHaveClass(/xterm-cursor-pointer/u, { timeout: 5000 });
}

function countFences(written: string): number {
  return [...written.matchAll(DEVICE_ATTRIBUTES_REPLY)].length;
}

async function drawFirstRow(page: Page, text: string): Promise<void> {
  // Re-fired inside the poll: a chunk that lands during the mount replay is
  // superseded by the replay's frame. A reply says the parser is live, and the
  // draw after it is fenced by its own reply, since the terminal paints to a canvas
  // and no text reaches the DOM.
  await expect.poll(async () => {
    await fireSessionData(page, SESSION_ID, DEVICE_ATTRIBUTES_QUERY);
    return countFences(await writtenToSession(page, SESSION_ID));
  }, { timeout: 10000, intervals: [250] }).toBeGreaterThan(0);
  const fencesBefore = countFences(await writtenToSession(page, SESSION_ID));
  await fireSessionData(page, SESSION_ID, `${TRACK_MOUSE}${CLEAR_TO_FIRST_ROW}${text}${DEVICE_ATTRIBUTES_QUERY}`);
  await expect.poll(async () => countFences(await writtenToSession(page, SESSION_ID)), { timeout: 5000 })
    .toBeGreaterThan(fencesBefore);
}

async function ctrlClick(page: Page): Promise<void> {
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Control');
}

async function shiftClick(page: Page): Promise<void> {
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Shift');
}

/** Puts the keyboard in the terminal, as a user who has already clicked into it. */
async function focusTerminal(page: Page): Promise<void> {
  await page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first().focus();
}

/** Takes the keyboard out of the terminal, so the next press is the one that brings it forward. */
async function blurTerminal(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first()).not.toBeFocused();
}

function openedExternally(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __openedExternalUrls?: string[] }).__openedExternalUrls ?? []);
}

async function launch(options: { browserEnabled?: boolean; linkClickTarget?: 'default' | 'kangentic' } = {}): Promise<Awaited<ReturnType<typeof launchWithTransientTerminal>>> {
  const launched = await launchWithTransientTerminal({
    projectId: 'proj-link-click',
    projectName: 'Link Click Project',
    sessionId: SESSION_ID,
    browserEnabled: options.browserEnabled,
    linkClickTarget: options.linkClickTarget,
  });
  await openTransientCommandTerminal(launched.page, SESSION_ID);
  return launched;
}

test('a Ctrl+click on a printed URL opens the other browser, the Kangentic one by default, and sends the TUI nothing', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await ctrlClick(page);

    await expect(page.getByTestId('browser-url-input')).toHaveValue(URL_TEXT, { timeout: 10000 });
    expect(await openedExternally(page)).toEqual([]);
    expect(await writtenToSession(page, SESSION_ID)).not.toMatch(SGR_PRESS);
  } finally {
    await browser.close();
  }
});

test('a plain click on a printed URL in a focused terminal opens the default browser and sends the TUI nothing', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await focusTerminal(page);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await page.mouse.down();
    await page.mouse.up();

    await expect.poll(() => openedExternally(page)).toEqual([URL_TEXT]);
    expect(await writtenToSession(page, SESSION_ID)).not.toMatch(SGR_PRESS);
  } finally {
    await browser.close();
  }
});

test('a drag that starts on a printed URL opens nothing and the TUI gets the press', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await focusTerminal(page);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    // Along the link and well past the few pixels that make a click a drag, ending still on the URL.
    const screen = (await terminalScreen(page).boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(screen.x + 90, screen.y + 6, { steps: 8 });
    await page.mouse.up();

    // The held press goes out once the press turns into a drag.
    await expect.poll(async () => writtenToSession(page, SESSION_ID)).toMatch(SGR_PRESS);
    expect(await openedExternally(page)).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a click on a printed URL in a terminal that does not hold the keyboard opens nothing', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await blurTerminal(page);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await page.mouse.down();
    await page.mouse.up();

    // Not claimed, so the click is the TUI's: its report is the sign the press was handled.
    await expect.poll(async () => writtenToSession(page, SESSION_ID)).toMatch(SGR_PRESS);
    expect(await openedExternally(page)).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a Shift click on a printed URL opens nothing, and a Ctrl+click after it opens it once', async () => {
  // No Kangentic browser, so every click that opens a link goes to the default browser and shows in one list.
  const { browser, page } = await launch({ browserEnabled: false });
  try {
    await drawFirstRow(page, URL_TEXT);
    await focusTerminal(page);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await shiftClick(page);
    await ctrlClick(page);

    await expect.poll(() => openedExternally(page)).toEqual([URL_TEXT]);
  } finally {
    await browser.close();
  }
});

test('a Ctrl+click on an OSC 8 link opens the other browser once and sends the TUI nothing', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, `\x1b]8;;${URL_TEXT}\x1b\\open the docs\x1b]8;;\x1b\\`);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await ctrlClick(page);

    await expect(page.getByTestId('browser-url-input')).toHaveValue(URL_TEXT, { timeout: 10000 });
    expect(await openedExternally(page)).toEqual([]);
    expect(await writtenToSession(page, SESSION_ID)).not.toMatch(SGR_PRESS);
  } finally {
    await browser.close();
  }
});

test('a printed path links only when it exists, and a Ctrl+click reveals the printed path', async () => {
  const { browser, page } = await launch();
  try {
    await page.evaluate(() => { (window as unknown as { __mockLinkPaths: string[] }).__mockLinkPaths = ['src/app.ts']; });
    await drawFirstRow(page, PATH_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await ctrlClick(page);

    await expect.poll(() => page.evaluate(() => (window as unknown as { __mockRevealedLinkPaths?: unknown[] }).__mockRevealedLinkPaths ?? []))
      .toEqual([{ sessionId: SESSION_ID, printedPath: 'src/app.ts' }]);
  } finally {
    await browser.close();
  }
});

/**
 * A link's tip says what a click and a Ctrl click do with it. It is drawn outside React, in
 * the page body, from xterm's own hover and leave, so only a browser shows it.
 */
test('hovering a URL shows both clicks, the plain click first, and the click closes the tip', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in default browser', 'Open in Kangentic browser']);
    await expect(tip.locator('kbd')).toHaveText(['Click', /^(Ctrl|⌘)$/u, 'Click']);
    // It sits beside the row it points at, never over the pointer.
    const screen = (await terminalScreen(page).boundingBox())!;
    const tipBox = (await tip.boundingBox())!;
    const pointerY = screen.y + 6;
    expect(tipBox.y + tipBox.height <= pointerY || tipBox.y >= pointerY).toBe(true);

    await ctrlClick(page);

    await expect(tip).toBeHidden();
    await expect(page.getByTestId('browser-url-input')).toHaveValue(URL_TEXT, { timeout: 10000 });
  } finally {
    await browser.close();
  }
});

/**
 * The Kangentic browser beside the terminal: a Ctrl+click shows it and loads the
 * link, the default browser opens nothing, and the click never reaches the TUI.
 */
test('a Ctrl+click opens the link in this terminal\'s Kangentic browser and sends the TUI nothing', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await ctrlClick(page);

    await expect(page.getByTestId('browser-url-input')).toHaveValue(URL_TEXT, { timeout: 10000 });
    await expect(page.getByTestId('browser-webview')).toHaveAttribute('src', URL_TEXT);
    expect(await openedExternally(page)).toEqual([]);
    expect(await writtenToSession(page, SESSION_ID)).not.toMatch(SGR_PRESS);
  } finally {
    await browser.close();
  }
});

test('a click into a Kangentic browser already showing a page loads the link through the page, not a new one', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);
    await ctrlClick(page);
    const webview = page.getByTestId('browser-webview');
    await expect(webview).toHaveAttribute('src', URL_TEXT, { timeout: 10000 });

    // The guest attaches: a <webview> is an unknown element here, so stub what the pane calls.
    await page.evaluate(() => {
      const element = document.querySelector('[data-testid="browser-webview"]') as HTMLElement & Record<string, unknown>;
      const loaded: string[] = [];
      (window as unknown as { __webviewLoads: string[] }).__webviewLoads = loaded;
      element.getWebContentsId = () => 5151;
      element.getURL = () => 'https://example.com/docs';
      element.loadURL = (url: string) => { loaded.push(url); return Promise.resolve(); };
      element.dispatchEvent(new Event('dom-ready'));
    });

    const second = 'https://example.com/second';
    await drawFirstRow(page, second);
    // Off the link and back: xterm looks for a link only when the pointer enters a new cell.
    const screen = (await terminalScreen(page).boundingBox())!;
    await page.mouse.move(screen.x + 20, screen.y + screen.height - 10);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);
    await ctrlClick(page);

    await expect.poll(() => page.evaluate(() => (window as unknown as { __webviewLoads: string[] }).__webviewLoads))
      .toEqual([second]);
    await expect(webview).toHaveCount(1);
    await expect(webview).toHaveAttribute('src', URL_TEXT);
  } finally {
    await browser.close();
  }
});

test('a plain Shift+click on text that is not a link still extends the selection', async () => {
  const { browser, page } = await launch();
  try {
    await expect.poll(async () => {
      await fireSessionData(page, SESSION_ID, DEVICE_ATTRIBUTES_QUERY);
      return countFences(await writtenToSession(page, SESSION_ID));
    }, { timeout: 10000, intervals: [250] }).toBeGreaterThan(0);
    // No mouse tracking: a plain shell, where Shift+click extends a selection.
    await fireSessionData(page, SESSION_ID, `${CLEAR_TO_FIRST_ROW}alpha beta gamma`);
    const screen = (await terminalScreen(page).boundingBox())!;
    await page.mouse.dblclick(screen.x + 12, screen.y + 6);
    await page.keyboard.press('Control+Shift+C');
    const copied = (): Promise<string[]> => page.evaluate(() => (window.electronAPI.clipboard as unknown as { __writeTextCalls: string[] }).__writeTextCalls.slice());
    await expect.poll(copied).toEqual(['alpha']);

    // Further along the same row, well inside the text at any font size.
    await page.mouse.move(screen.x + 100, screen.y + 6);
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Shift');

    await page.keyboard.press('Control+Shift+C');
    await expect.poll(async () => (await copied()).at(-1)).toMatch(/^alpha beta/u);
  } finally {
    await browser.close();
  }
});

test('with the Kangentic browser off, an OSC 8 link whose text is not its URL stacks its destination over one row', async () => {
  const { browser, page } = await launch({ browserEnabled: false });
  try {
    await drawFirstRow(page, `\x1b]8;;${URL_TEXT}\x1b\\canvas\x1b]8;;\x1b\\`);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip).toHaveAttribute('data-shape', 'stack');
    await expect(tip.locator('[data-tooltip-part="destination"]')).toHaveText(URL_TEXT);
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in default browser']);
  } finally {
    await browser.close();
  }
});

test('with the terminal\'s Kangentic browser popped out, the tip has one row and Ctrl+click opens the default browser', async () => {
  const { browser, page } = await launch();
  try {
    await page.evaluate((key) => (window as unknown as { __mockFirePopOutChanged: (keys: string[]) => void }).__mockFirePopOutChanged([key]),
      'browser:proj-link-click:command-terminal::proj-link-click::slot-1');
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in default browser']);

    await ctrlClick(page);

    await expect.poll(() => openedExternally(page)).toEqual([URL_TEXT]);
    await expect(page.getByTestId('browser-webview')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('an OSC 8 link whose text is not its URL shows the URL above its clicks', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, `\x1b]8;;${URL_TEXT}\x1b\\canvas\x1b]8;;\x1b\\`);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip.locator('[data-tooltip-part="destination"]')).toHaveText(URL_TEXT);
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in default browser', 'Open in Kangentic browser']);
  } finally {
    await browser.close();
  }
});

test('with the Kangentic browser off, the tip has one row and Ctrl+click opens the default browser too', async () => {
  const { browser, page } = await launch({ browserEnabled: false });
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in default browser']);

    await ctrlClick(page);

    await expect.poll(() => openedExternally(page)).toEqual([URL_TEXT]);
    await expect(page.getByTestId('browser-webview')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

/**
 * The setting swaps the two clicks. Where the setting names the Kangentic browser, a
 * click loads it there and Ctrl+click goes to the default browser.
 */
test('with the setting on the Kangentic browser, a click loads it there and the tip lists it first', async () => {
  const { browser, page } = await launch({ linkClickTarget: 'kangentic' });
  try {
    await drawFirstRow(page, URL_TEXT);
    await focusTerminal(page);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip.locator('[data-link-target]')).toHaveText(['Open in Kangentic browser', 'Open in default browser']);

    await page.mouse.down();
    await page.mouse.up();

    await expect(page.getByTestId('browser-url-input')).toHaveValue(URL_TEXT, { timeout: 10000 });
    expect(await openedExternally(page)).toEqual([]);
    expect(await writtenToSession(page, SESSION_ID)).not.toMatch(SGR_PRESS);
  } finally {
    await browser.close();
  }
});

test('with the setting on the Kangentic browser, a Ctrl+click opens the default browser', async () => {
  const { browser, page } = await launch({ linkClickTarget: 'kangentic' });
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await ctrlClick(page);

    await expect.poll(() => openedExternally(page)).toEqual([URL_TEXT]);
    await expect(page.getByTestId('browser-webview')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('a plain click on an OSC 8 link in a focused terminal opens it once and sends the TUI nothing', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, `\x1b]8;;${URL_TEXT}\x1b\\open the docs\x1b]8;;\x1b\\`);
    await focusTerminal(page);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await page.mouse.down();
    await page.mouse.up();

    await expect.poll(() => openedExternally(page)).toEqual([URL_TEXT]);
    expect(await writtenToSession(page, SESSION_ID)).not.toMatch(SGR_PRESS);
  } finally {
    await browser.close();
  }
});

test('a plain click on a printed path that exists reveals nothing and reaches the TUI', async () => {
  const { browser, page } = await launch();
  try {
    await page.evaluate(() => { (window as unknown as { __mockLinkPaths: string[] }).__mockLinkPaths = ['src/app.ts']; });
    await drawFirstRow(page, PATH_TEXT);
    await focusTerminal(page);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await page.mouse.down();
    await page.mouse.up();

    await expect.poll(async () => writtenToSession(page, SESSION_ID)).toMatch(SGR_PRESS);
    expect(await page.evaluate(() => (window as unknown as { __mockRevealedLinkPaths?: unknown[] }).__mockRevealedLinkPaths ?? [])).toEqual([]);
  } finally {
    await browser.close();
  }
});

/**
 * A busy agent repaints its screen many times a second. Each repaint over the link's
 * row makes xterm's Linkifier leave the link and hover it again in the same tick, so a
 * tip that restarts its dwell on every hover would never show while the agent works.
 */
test('a link\'s tip still shows while the agent keeps repainting its row', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await page.evaluate(({ sessionId, row }) => {
      const fire = (window as unknown as { __mockFireSessionData: (id: string, data: string) => void }).__mockFireSessionData;
      (window as unknown as { __repaintTimer: number }).__repaintTimer = window.setInterval(() => fire(sessionId, row), 100);
    }, { sessionId: SESSION_ID, row: `\x1b[1;1H${URL_TEXT}` });
    try {
      await expect(page.getByTestId('terminal-link-tip')).toBeVisible({ timeout: 3000 });
    } finally {
      await page.evaluate(() => window.clearInterval((window as unknown as { __repaintTimer: number }).__repaintTimer));
    }
  } finally {
    await browser.close();
  }
});

test('a path link\'s tip says it shows the file, and moving off the link closes it', async () => {
  const { browser, page } = await launch();
  try {
    await page.evaluate(() => { (window as unknown as { __mockLinkPaths: string[] }).__mockLinkPaths = ['src/app.ts']; });
    await drawFirstRow(page, PATH_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip).toHaveText(/Show in folder/u);

    const screen = (await terminalScreen(page).boundingBox())!;
    await page.mouse.move(screen.x + 300, screen.y + 100);

    await expect(tip).toBeHidden();
  } finally {
    await browser.close();
  }
});

/**
 * Only the press and release of a claimed click are swallowed. Whatever else the
 * terminal reports or types while the button is held still has to reach the TUI.
 */
const WHEEL_REPORT = /\x1b\[<(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]);\d+;\d+M/u;
const MOTION_REPORT = /\x1b\[<(?:3[2-9]|[45]\d|6[0-3]);\d+;\d+M/u;
const MOTION_TRACKING = '\x1b[?1003h';

/** Presses on the link with Ctrl held, then lets go of Ctrl, leaving the claimed press still down. */
async function holdClaimedPress(page: Page): Promise<void> {
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.keyboard.up('Control');
}

test('a wheel report during a claimed click still reaches the TUI', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);
    await holdClaimedPress(page);

    await page.mouse.wheel(0, 100);

    await expect.poll(async () => writtenToSession(page, SESSION_ID)).toMatch(WHEEL_REPORT);
    await page.mouse.up();
  } finally {
    await browser.close();
  }
});

test('a motion report during a claimed click still reaches the TUI', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await fireSessionData(page, SESSION_ID, MOTION_TRACKING);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);
    await holdClaimedPress(page);

    // The moves that put the pointer on the link already produced motion reports,
    // so only what is written after the press can show the claim let one through.
    const writtenBeforeMove = (await writtenToSession(page, SESSION_ID)).length;
    const screen = (await terminalScreen(page).boundingBox())!;
    await page.mouse.move(screen.x + 140, screen.y + 40, { steps: 8 });

    await expect.poll(async () => (await writtenToSession(page, SESSION_ID)).slice(writtenBeforeMove)).toMatch(MOTION_REPORT);
    await page.mouse.up();
  } finally {
    await browser.close();
  }
});

test('a keystroke during a claimed click still reaches the TUI', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);
    await holdClaimedPress(page);

    await page.keyboard.type('q');

    await expect.poll(async () => writtenToSession(page, SESSION_ID)).toContain('q');
    await page.mouse.up();
  } finally {
    await browser.close();
  }
});

test('a Ctrl+click on a path that does not exist reaches the TUI, which may handle it itself', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, 'src/missing.ts');
    await pointAtFirstRow(page);

    await ctrlClick(page);

    await expect.poll(async () => writtenToSession(page, SESSION_ID)).toMatch(SGR_PRESS);
  } finally {
    await browser.close();
  }
});
