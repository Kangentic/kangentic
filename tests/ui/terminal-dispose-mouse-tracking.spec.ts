/**
 * A terminal disposed while xterm's document mouse listeners are pending leaves
 * nothing behind (Sentry DESKTOP-1G).
 *
 * With mouse reporting on (Claude Code's fullscreen TUI sends ?1000h ?1002h ?1003h
 * ?1006h), a mousedown on the terminal parks a `mouseup` and a drag `mousemove`
 * listener on `document`, and xterm removes them only from inside the mouseup
 * handler or on a protocol change. Disposed in between, the next mouseup or held
 * mousemove anywhere threw `Cannot read properties of undefined (reading
 * 'dimensions')`, and kept throwing on every click for the life of the page.
 *
 * The test arms the listeners with a real press, unmounts the terminal while the
 * button is held, then moves, releases and clicks elsewhere. The unmount goes
 * through the store inside page.evaluate rather than a keystroke during the hold,
 * so it is deterministic. The CDP listener count is both the positive control
 * (the press really armed the document) and the proof that nothing outlives the
 * terminal. The release itself is unit-tested in tests/unit/terminal-dispose.test.ts.
 */
import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { collectPageErrors, launchWithTransientTerminal, openTransientCommandTerminal } from './helpers';

test.describe.configure({ mode: 'parallel' });

const TRANSIENT_SESSION_ID = 'sess-dispose-mouse-tracking-1';
/** What Claude Code's fullscreen TUI sends: click, drag, any-motion, SGR encoding. */
const CLAUDE_MOUSE_MODES = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';

/**
 * Turn mouse reporting on the way the agent TUI does. Re-fired inside the poll:
 * a chunk that lands during the mount replay is superseded by the replay's
 * frame, and the DECSETs are idempotent. xterm marks `.xterm` with
 * `enable-mouse-events` once a protocol with events is active.
 */
async function enableMouseReporting(page: Page): Promise<void> {
  const terminal = page.getByTestId('command-terminal-window').locator('.xterm').first();
  await expect.poll(async () => {
    await page.evaluate(({ sessionId, modes }) => {
      (window as unknown as { __mockFireSessionData: (id: string, data: string) => void })
        .__mockFireSessionData(sessionId, modes);
    }, { sessionId: TRANSIENT_SESSION_ID, modes: CLAUDE_MOUSE_MODES });
    return terminal.evaluate((element) => element.classList.contains('enable-mouse-events'));
  }, { timeout: 10000, intervals: [250] }).toBe(true);
}

/** How many `mouseup` and `mousemove` listeners sit on `document` right now. */
async function countDocumentMouseListeners(client: CDPSession): Promise<number> {
  const { result } = await client.send('Runtime.evaluate', { expression: 'document', objectGroup: 'mouse-listeners' });
  if (!result.objectId) throw new Error('no remote object for document');
  const { listeners } = await client.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  await client.send('Runtime.releaseObjectGroup', { objectGroup: 'mouse-listeners' });
  return listeners.filter((listener) => listener.type === 'mouseup' || listener.type === 'mousemove').length;
}

test('disposing a terminal mid-press leaves no document mouse listener to throw on later clicks', async () => {
  const { browser, page } = await launchWithTransientTerminal({
    projectId: 'proj-dispose-mouse-tracking',
    projectName: 'Dispose Mouse Tracking Project',
    sessionId: TRANSIENT_SESSION_ID,
  });
  try {
    const pageErrors = collectPageErrors(page);
    const client = await page.context().newCDPSession(page);

    await openTransientCommandTerminal(page, TRANSIENT_SESSION_ID);
    await enableMouseReporting(page);

    const screen = page.getByTestId('command-terminal-window').locator('.xterm-screen').first();
    const box = await screen.boundingBox();
    if (!box || box.width === 0 || box.height === 0) throw new Error('terminal screen has no box');
    const pressX = box.x + box.width / 2;
    const pressY = box.y + box.height / 2;

    const baseline = await countDocumentMouseListeners(client);
    await page.mouse.move(pressX, pressY);
    await page.mouse.down();
    // Positive control: the press armed xterm's document listeners (mouseup,
    // plus the drag mousemove under ?1002h), so the case below is not vacuous.
    expect(await countDocumentMouseListeners(client)).toBeGreaterThan(baseline);

    // Hide the Command Terminal layer while the button is still held, which
    // unmounts the window and disposes its xterm.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { session?: { getState: () => { setCommandBarVisible: (visible: boolean) => void } } };
      }).__zustandStores;
      stores?.session?.getState().setCommandBarVisible(false);
    });
    await expect(page.getByTestId('command-terminal-window')).toHaveCount(0);
    await expect(page.locator('.xterm')).toHaveCount(0);

    // Nothing the dead terminal parked may still be listening. Soft, so a
    // failure still drives the clicks below and reports what they throw.
    expect.soft(await countDocumentMouseListeners(client)).toBe(baseline);

    // A held move (the drag listener), the release (the mouseup listener), then
    // ordinary clicks elsewhere, which is where the field reports kept firing.
    await page.mouse.move(pressX + 40, pressY + 20);
    await page.mouse.up();
    await page.mouse.click(pressX - 60, pressY);
    await page.mouse.click(pressX + 60, pressY + 40);

    expect(pageErrors()).toEqual([]);
  } finally {
    await browser.close();
  }
});
