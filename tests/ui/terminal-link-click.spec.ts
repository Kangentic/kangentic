/**
 * Ctrl or Cmd click opens a link, and the click never also reaches a TUI that holds
 * the mouse. Only a browser proves this: xterm's Linkifier and its mouse reporting are
 * DOM listeners on the terminal element, and the order they run in decides it.
 *
 * Claude Code opens a link itself on a Ctrl+click report, so a report that got through
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

async function launch(): Promise<Awaited<ReturnType<typeof launchWithTransientTerminal>>> {
  const launched = await launchWithTransientTerminal({
    projectId: 'proj-link-click',
    projectName: 'Link Click Project',
    sessionId: SESSION_ID,
  });
  await openTransientCommandTerminal(launched.page, SESSION_ID);
  return launched;
}

test('a Ctrl+click on a printed URL opens it once and sends the TUI nothing', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await ctrlClick(page);

    await expect.poll(() => page.evaluate(() => (window as unknown as { __openedExternalUrls?: string[] }).__openedExternalUrls ?? []))
      .toEqual([URL_TEXT]);
    expect(await writtenToSession(page, SESSION_ID)).not.toMatch(SGR_PRESS);
  } finally {
    await browser.close();
  }
});

test('a plain click on a printed URL opens nothing and still reaches the TUI', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await page.mouse.down();
    await page.mouse.up();

    await expect.poll(async () => writtenToSession(page, SESSION_ID)).toMatch(SGR_PRESS);
    expect(await page.evaluate(() => (window as unknown as { __openedExternalUrls?: string[] }).__openedExternalUrls ?? [])).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a Ctrl+click on an OSC 8 link opens it once and sends the TUI nothing', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, `\x1b]8;;${URL_TEXT}\x1b\\open the docs\x1b]8;;\x1b\\`);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    await ctrlClick(page);

    await expect.poll(() => page.evaluate(() => (window as unknown as { __openedExternalUrls?: string[] }).__openedExternalUrls ?? []))
      .toEqual([URL_TEXT]);
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
 * A link's tip says what a Ctrl or Cmd click on it does. It is drawn outside React, in
 * the page body, from xterm's own hover and leave, so only a browser shows it.
 */
test('hovering a URL shows what a Ctrl+click does, and the click closes the tip', async () => {
  const { browser, page } = await launch();
  try {
    await drawFirstRow(page, URL_TEXT);
    await pointAtFirstRow(page);
    await waitForLinkUnderPointer(page);

    const tip = page.getByTestId('terminal-link-tip');
    await expect(tip).toBeVisible({ timeout: 5000 });
    await expect(tip).toHaveText(/Open in browser/u);
    await expect(tip.locator('kbd')).toHaveText([/^(Ctrl|⌘)$/u, 'Click']);
    // It sits beside the row it points at, never over the pointer.
    const screen = (await terminalScreen(page).boundingBox())!;
    const tipBox = (await tip.boundingBox())!;
    const pointerY = screen.y + 6;
    expect(tipBox.y + tipBox.height <= pointerY || tipBox.y >= pointerY).toBe(true);

    await ctrlClick(page);

    await expect(tip).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __openedExternalUrls?: string[] }).__openedExternalUrls ?? []))
      .toEqual([URL_TEXT]);
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
