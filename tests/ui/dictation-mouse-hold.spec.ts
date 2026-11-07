/**
 * A push-to-talk hold on the back button with the left button used during it.
 *
 * Only a real input pipeline shows this. Playwright's `page.mouse` cannot press
 * Back, and a synthetic event carries none of Chromium's rules: a button that
 * changes with another held arrives as a `pointermove`, `pointerup` fires for the
 * last button up, and a canceled `pointerdown` suppresses every compat mouse event
 * until then. So these press through CDP's `Input.dispatchMouseEvent`.
 *
 * The user clicks and draws while holding Back, and the hold has to end exactly
 * once whichever button lifts first.
 */
import { test, expect, chromium, type Browser, type CDPSession, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, createProject, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const BACK = 8;
const LEFT = 1;

interface HoldTrace {
  phase: string;
  reason: string | null;
  heldMs: number | null;
  buttons: number | null;
  targetKind: string | null;
}

interface InputLogEntry { type: string; button: number; defaultPrevented: boolean }

interface DictationProbe {
  __startCalls: unknown[];
  __stopCalls: unknown[];
  __holdTraces: HoldTrace[];
  __blockStop: () => void;
  __releaseStop: () => void;
}

interface ProbeWindow {
  electronAPI: { dictation: DictationProbe };
  __zustandStores: { dictation: { getState: () => { status: string } } };
  __emitDictationPartial: (id: string, text: string) => void;
  __emitDictationWindowBlur: () => void;
  __probeEvents: string[];
  __inputLog: InputLogEntry[];
  __pageSawPointerUp: number[];
}

async function launch(hotkeyOverrides: Record<string, string> = {}): Promise<{ browser: Browser; page: Page; cdp: CDPSession }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone'],
  });
  const page = await context.newPage();
  await page.addInitScript((config: Record<string, unknown>) => {
    (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = config;
  }, {
    dictation: { enabled: true, autoSubmit: false, releaseBufferMs: 0 },
    hotkeyOverrides: { 'dictation.pushToTalk': 'Mouse:Back', ...hotkeyOverrides },
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await createProject(page, `Dictation Mouse Hold Test ${Date.now()}`);
  // A plain element over the board, so what reaches a click target is read
  // directly rather than through whatever the board does with it.
  await page.evaluate(() => {
    const probeWindow = window as unknown as ProbeWindow;
    probeWindow.__probeEvents = [];
    probeWindow.__pageSawPointerUp = [];
    probeWindow.__inputLog = [];
    // What a LATER listener on the window sees, in the capture phase: it runs after
    // the hook's own listeners on the same node, so it reads the state they left.
    for (const type of ['pointerdown', 'pointermove', 'keydown']) {
      window.addEventListener(type, (event) => {
        probeWindow.__inputLog.push({
          type,
          button: (event as MouseEvent).button ?? -1,
          defaultPrevented: event.defaultPrevented,
        });
      }, true);
    }
    // The page's own view of a lift, in the bubble phase.
    document.addEventListener('pointerup', (event) => {
      probeWindow.__pageSawPointerUp.push(event.button);
    });
    const element = document.createElement('button');
    element.id = 'hold-probe';
    element.style.cssText = 'position:fixed;left:600px;top:400px;width:200px;height:100px;z-index:2147483647';
    for (const type of ['mousedown', 'mouseup', 'click']) {
      element.addEventListener(type, (event) => {
        probeWindow.__probeEvents.push(`${type}:${(event as MouseEvent).button}`);
      });
    }
    document.body.appendChild(element);
  });
  const cdp = await context.newCDPSession(page);
  await page.locator('[data-testid="board-search"]').click();
  await mouseEvent(cdp, 'mouseMoved', 'none', 0);
  return { browser, page, cdp };
}

/** Run a body against a fresh page and always close its browser, so no test can forget. */
async function withHold(
  body: (hold: { page: Page; cdp: CDPSession }) => Promise<void>,
  hotkeyOverrides: Record<string, string> = {},
): Promise<void> {
  const { browser, page, cdp } = await launch(hotkeyOverrides);
  try {
    await body({ page, cdp });
  } finally {
    await browser.close();
  }
}

function mouseEvent(cdp: CDPSession, type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', button: 'none' | 'left' | 'middle' | 'back', buttons: number): Promise<unknown> {
  return cdp.send('Input.dispatchMouseEvent', {
    type, button, buttons, x: 700, y: 450, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
}

function status(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as ProbeWindow).__zustandStores.dictation.getState().status);
}

function probe(page: Page): Promise<{ starts: number; stops: number; ends: (string | null)[]; events: string[] }> {
  return page.evaluate(() => {
    const probeWindow = window as unknown as ProbeWindow;
    const dictation = probeWindow.electronAPI.dictation;
    return {
      starts: dictation.__startCalls.length,
      stops: dictation.__stopCalls.length,
      ends: dictation.__holdTraces.filter((trace) => trace.phase === 'end').map((trace) => trace.reason),
      events: probeWindow.__probeEvents,
    };
  });
}

function traces(page: Page): Promise<HoldTrace[]> {
  return page.evaluate(() => (window as unknown as ProbeWindow).electronAPI.dictation.__holdTraces);
}

function inputLog(page: Page): Promise<InputLogEntry[]> {
  return page.evaluate(() => (window as unknown as ProbeWindow).__inputLog);
}

/** One animation frame, so a handler that would have run has run. */
function settleFrame(page: Page): Promise<void> {
  return page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); }));
}

async function pressBack(page: Page, cdp: CDPSession, buttons = BACK): Promise<void> {
  await mouseEvent(cdp, 'mousePressed', 'back', buttons);
  await expect.poll(() => status(page), { timeout: 10000 }).toBe('recording');
}

test.describe('a push-to-talk hold with the left button in play', () => {
  test.setTimeout(45000);

  test('Back lifted before Left ends the hold once, and the click still lands', async () => {
    await withHold(async ({ page, cdp }) => {
      await pressBack(page, cdp);
      await mouseEvent(cdp, 'mousePressed', 'left', BACK | LEFT);
      expect(await status(page)).toBe('recording');

      // The reported gesture: this lift is a `pointermove`, and the `pointerup`
      // after it names the left button.
      await mouseEvent(cdp, 'mouseReleased', 'back', LEFT);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');
      await mouseEvent(cdp, 'mouseReleased', 'left', 0);

      const result = await probe(page);
      expect(result.ends).toEqual(['lifted-with-other-button']);
      expect(result.stops).toBe(1);
      expect(result.events).toEqual(['mousedown:0', 'mouseup:0']);
    });
  });

  test('Left lifted before Back keeps the hold, and the click lands', async () => {
    await withHold(async ({ page, cdp }) => {
      await pressBack(page, cdp);
      await mouseEvent(cdp, 'mousePressed', 'left', BACK | LEFT);
      await mouseEvent(cdp, 'mouseReleased', 'left', BACK);
      expect(await status(page)).toBe('recording');

      await mouseEvent(cdp, 'mouseReleased', 'back', 0);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');

      const result = await probe(page);
      expect(result.ends).toEqual(['released']);
      expect(result.stops).toBe(1);
      expect(result.events).toEqual(['mousedown:0', 'mouseup:0', 'click:0']);
    });
  });

  test('Back pressed with Left already down starts a hold', async () => {
    await withHold(async ({ page, cdp }) => {
      await mouseEvent(cdp, 'mousePressed', 'left', LEFT);
      await pressBack(page, cdp, BACK | LEFT);
      await mouseEvent(cdp, 'mouseReleased', 'left', BACK);
      expect(await status(page)).toBe('recording');

      await mouseEvent(cdp, 'mouseReleased', 'back', 0);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');

      const result = await probe(page);
      expect(result.starts).toBe(1);
      expect(result.ends).toEqual(['released']);
      expect(result.events).toEqual(['mousedown:0', 'mouseup:0', 'click:0']);
    });
  });

  test('the next pointer event ends a hold whose release was never seen', async () => {
    await withHold(async ({ page, cdp }) => {
      await pressBack(page, cdp);
      // A release no pointer event reported, as over another window.
      await mouseEvent(cdp, 'mouseMoved', 'none', 0);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');
      expect((await probe(page)).ends).toEqual(['missed-release']);
    });
  });

  test('a press during finalize is refused, and the refined text still replaces the preview', async () => {
    await withHold(async ({ page, cdp }) => {
      await page.evaluate(() => (window as unknown as ProbeWindow).electronAPI.dictation.__blockStop());
      await pressBack(page, cdp);
      await page.evaluate(() => (window as unknown as ProbeWindow).__emitDictationPartial('mock-dictation-1', 'live words'));
      const search = page.locator('[data-testid="board-search"]');
      await expect(search).toHaveValue('live words');

      await mouseEvent(cdp, 'mouseReleased', 'back', 0);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('finalizing');

      await mouseEvent(cdp, 'mousePressed', 'back', BACK);
      await mouseEvent(cdp, 'mouseReleased', 'back', 0);
      expect((await probe(page)).starts).toBe(1);
      // The refused press is logged as such, not as a press: it started nothing.
      const logged = await traces(page);
      expect(logged.map((trace) => trace.phase)).toEqual(['press', 'end', 'refused']);
      expect(logged[0]).toMatchObject({ reason: null, buttons: BACK, targetKind: null });
      // The end names where the words were going, which the other two cannot know.
      expect(logged[1]).toMatchObject({ reason: 'released', targetKind: 'input' });
      expect(logged[2]).toMatchObject({ reason: null, buttons: BACK, targetKind: null });

      await page.evaluate(() => (window as unknown as ProbeWindow).electronAPI.dictation.__releaseStop());
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');
      // A press that started dropped the sink, so the preview stayed in the field.
      await expect(search).toHaveValue('This is a test of dictation.');
    });
  });

  test('main reporting an OS blur ends the hold, and a DOM blur does not', async () => {
    await withHold(async ({ page, cdp }) => {
      await pressBack(page, cdp);
      // What a click into a Browser pane guest fires on the host.
      await page.evaluate(() => { window.dispatchEvent(new Event('blur')); });
      expect(await status(page)).toBe('recording');

      await page.evaluate(() => (window as unknown as ProbeWindow).__emitDictationWindowBlur());
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');
      expect((await probe(page)).ends).toEqual(['window-blur']);
    });
  });

  test('Back keeps its own mouse events off the page, and focus where it was', async () => {
    await withHold(async ({ page, cdp }) => {
      await pressBack(page, cdp);
      await mouseEvent(cdp, 'mouseReleased', 'back', 0);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');
      expect((await probe(page)).events).toEqual([]);
      await expect(page.locator('[data-testid="board-search"]')).toBeFocused();
    });
  });
  test('a second Back press with no release between ends the hold once, and starts nothing', async () => {
    await withHold(async ({ page, cdp }) => {
      await pressBack(page, cdp);
      await mouseEvent(cdp, 'mousePressed', 'back', BACK);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');

      const result = await probe(page);
      expect(result.starts).toBe(1);
      expect(result.stops).toBe(1);
      expect(result.ends).toEqual(['second-press']);
      expect((await traces(page)).map((trace) => trace.phase)).toEqual(['press', 'end']);
    });
  });

  test('only the lift of the bound button is kept from the page', async () => {
    await withHold(async ({ page, cdp }) => {
      const pageSaw = (): Promise<number[]> => page.evaluate(() => (window as unknown as ProbeWindow).__pageSawPointerUp);

      // The launch click on the search field left its own lift in the log.
      await page.evaluate(() => { (window as unknown as ProbeWindow).__pageSawPointerUp.length = 0; });

      // Back lifting ends the hold and is consumed.
      await pressBack(page, cdp);
      await mouseEvent(cdp, 'mouseReleased', 'back', 0);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');
      expect(await pageSaw()).toEqual([]);

      // Left lifting with Back's release never seen also ends a hold, but it is
      // the user's own click, so it reaches the page.
      await pressBack(page, cdp);
      await mouseEvent(cdp, 'mousePressed', 'left', BACK | LEFT);
      await mouseEvent(cdp, 'mouseReleased', 'left', 0);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');
      expect((await probe(page)).ends).toEqual(['released', 'missed-release']);
      expect(await pageSaw()).toEqual([0]);
    });
  });

  test('a one-shot mouse binding does not fire on a chorded press, and a chorded Back press is left uncanceled', async () => {
    await withHold(async ({ page, cdp }) => {
      // The sidebar toggle stands in for any one-shot action bound to a mouse button.
      const sidebar = page.locator('[data-testid="sidebar-area"]');
      await expect(sidebar).toHaveAttribute('data-open', 'true');

      // A plain move with a button held, and no press, starts no hold.
      await mouseEvent(cdp, 'mouseMoved', 'none', BACK);
      await settleFrame(page);
      expect((await probe(page)).starts).toBe(0);
      await mouseEvent(cdp, 'mouseMoved', 'none', 0);

      // Middle pressed with Left down arrives as a pointermove. A one-shot action
      // must not fire in the middle of a stroke.
      await mouseEvent(cdp, 'mousePressed', 'left', LEFT);
      await mouseEvent(cdp, 'mousePressed', 'middle', LEFT | 4);
      await settleFrame(page);
      await expect(sidebar).toHaveAttribute('data-open', 'true');
      await mouseEvent(cdp, 'mouseReleased', 'middle', LEFT);

      // Back pressed with Left down is the chord that does start a hold, and its
      // move reaches the page whole: the stroke needs it.
      const logLength = (await inputLog(page)).length;
      await mouseEvent(cdp, 'mousePressed', 'back', LEFT | BACK);
      await expect.poll(() => status(page), { timeout: 10000 }).toBe('recording');
      const chordMoves = (await inputLog(page)).slice(logLength).filter((entry) => entry.type === 'pointermove' && entry.button === 3);
      expect(chordMoves).toEqual([{ type: 'pointermove', button: 3, defaultPrevented: false }]);
      await mouseEvent(cdp, 'mouseReleased', 'back', LEFT);
      await mouseEvent(cdp, 'mouseReleased', 'left', 0);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');

      // Control: the same binding does fire on a plain press, so the check above
      // is not passing on a dead binding.
      await mouseEvent(cdp, 'mousePressed', 'middle', 4);
      await mouseEvent(cdp, 'mouseReleased', 'middle', 0);
      await expect(sidebar).toHaveAttribute('data-open', 'false');
    }, { 'view.toggleSidebar': 'Mouse:Middle' });
  });

  test('a Back press is left uncanceled, so the page still sees it', async () => {
    await withHold(async ({ page, cdp }) => {
      await pressBack(page, cdp);
      const mouseDown = (await inputLog(page)).filter((entry) => entry.type === 'pointerdown' && entry.button === 3);
      expect(mouseDown).toEqual([{ type: 'pointerdown', button: 3, defaultPrevented: false }]);
      await mouseEvent(cdp, 'mouseReleased', 'back', 0);
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');
    });
  });

  test('a keyboard-bound hold has its keydown canceled', async () => {
    await withHold(async ({ page }) => {
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await page.keyboard.down('Q');
      await expect.poll(() => status(page), { timeout: 10000 }).toBe('recording');
      const keyDowns = (await inputLog(page)).filter((entry) => entry.type === 'keydown');
      expect(keyDowns.at(-1)).toMatchObject({ type: 'keydown', defaultPrevented: true });
      await page.keyboard.up('Q');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
      await expect.poll(() => status(page), { timeout: 5000 }).toBe('idle');
    }, { 'dictation.pushToTalk': 'Alt+Shift+Q' });
  });
});
