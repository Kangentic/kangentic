/**
 * UI tests for PopOutWindowFrame's Escape-to-close guard chain
 * (src/renderer/pop-out/PopOutWindowFrame.tsx).
 *
 * The frame is shared chrome for every pop-out kind (stats / changes / browser
 * / monitor / changes-file), so its bubble-phase Escape handler is
 * byte-identical regardless of which surface is hosted. This spec boots the
 * 'stats' surface via the `#stats` URL-hash fallback in readPopOutDescriptor
 * (src/renderer/pop-out/read-descriptor.ts) - the cheapest way to mount a real
 * pop-out window in this tier, since it needs no `electronAPI.popOut.descriptor`
 * boot-seed payload and no Monaco chunk. The handler under test is the exact
 * one 'changes-file' windows also mount.
 *
 * The pop-out window itself never opens for real here (no OS window, no main
 * process) - assertions ride window.electronAPI.window.close()'s call log
 * (window.__mockWindowControls.getCalls()), mirroring changes-file-popout.spec.ts's
 * use of window.__mockPopOut.
 *
 * This pins the guard chain's SELECTOR CONTRACT (which DOM shapes suppress the
 * close), not real integration with a live dialog/menu/window-manager instance -
 * that is the correct scope for a guard whose whole job is "recognize these
 * shapes", and those real callers already carry their own coverage elsewhere
 * (BaseDialog's own Escape, window-layer-isolation.test.ts, etc.).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

let browser: Browser;
let page: Page;

async function resetWindowControls(): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mockWindowControls: { reset: () => void } }).__mockWindowControls.reset();
  });
}

async function getWindowControlCalls(): Promise<string[]> {
  return page.evaluate(() => {
    return (window as unknown as { __mockWindowControls: { getCalls: () => string[] } }).__mockWindowControls.getCalls();
  }) as Promise<string[]>;
}

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(`${VITE_URL}#stats`);
  await page.waitForLoadState('load');
  // Mount probe: PopOutWindowFrame's document.title effect ran, proving the
  // frame (and its bubble-phase Escape listener registered alongside it)
  // actually mounted rather than being swallowed by PopOutSurfaceRoot's outer
  // ErrorBoundary. 'Usage Statistics' is POP_OUT_SURFACES.stats.title.
  await expect.poll(() => page.title(), { timeout: 15000 }).toBe('Usage Statistics');
  await page.locator('[data-testid="popout-close"]').waitFor({ state: 'visible', timeout: 5000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('PopOutWindowFrame: Escape-to-close guard chain', () => {
  test.beforeEach(async () => {
    await resetWindowControls();
  });

  test('a bare Escape (no guard condition present) closes the window', async () => {
    await page.keyboard.press('Escape');
    await expect.poll(getWindowControlCalls).toEqual(['close']);
  });

  test('Escape is ignored while a text input is focused (in-progress edit owns it)', async () => {
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.setAttribute('data-testid', 'escape-guard-input');
      document.body.appendChild(input);
      input.focus();
    });
    await page.keyboard.press('Escape');
    // Negative assertion (anti-pattern 6): a fixed budget, not a poll - we are
    // proving window.close() is NEVER called, which cannot be polled for.
    await page.waitForTimeout(300);
    expect(await getWindowControlCalls()).toEqual([]);
    await page.evaluate(() => {
      document.querySelector('[data-testid="escape-guard-input"]')?.remove();
    });
  });

  test('Escape is ignored while a dismissable layer (dialog/menu/popover) is open', async () => {
    await page.evaluate(() => {
      const layer = document.createElement('div');
      layer.setAttribute('data-dismissable-layer', '');
      layer.setAttribute('data-testid', 'escape-guard-layer');
      document.body.appendChild(layer);
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await getWindowControlCalls()).toEqual([]);
    await page.evaluate(() => {
      document.querySelector('[data-testid="escape-guard-layer"]')?.remove();
    });
  });

  test('Escape is ignored while a window-layer-root host has a mounted DOM window', async () => {
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.setAttribute('data-window-layer-root', '');
      host.setAttribute('data-testid', 'escape-guard-host');
      host.appendChild(document.createElement('div'));
      document.body.appendChild(host);
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await getWindowControlCalls()).toEqual([]);
    await page.evaluate(() => {
      document.querySelector('[data-testid="escape-guard-host"]')?.remove();
    });
  });

  test('Escape still closes when a window-layer-root host is present but empty', async () => {
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.setAttribute('data-window-layer-root', '');
      host.setAttribute('data-testid', 'escape-guard-empty-host');
      document.body.appendChild(host);
    });
    await page.keyboard.press('Escape');
    await expect.poll(getWindowControlCalls).toEqual(['close']);
    await page.evaluate(() => {
      document.querySelector('[data-testid="escape-guard-empty-host"]')?.remove();
    });
  });

  test('Escape is ignored when it originates inside a Monaco find widget (.find-widget)', async () => {
    await page.evaluate(() => {
      const widget = document.createElement('div');
      widget.className = 'find-widget';
      widget.setAttribute('data-testid', 'escape-guard-find-widget');
      const inner = document.createElement('span');
      widget.appendChild(inner);
      document.body.appendChild(widget);
      // Dispatched directly (not via keyboard.press, which would target
      // document.body): this asserts the .closest('.find-widget') check on
      // event.target, which requires the event to actually originate inside
      // the widget.
      inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    expect(await getWindowControlCalls()).toEqual([]);
    await page.evaluate(() => {
      document.querySelector('[data-testid="escape-guard-find-widget"]')?.remove();
    });
  });

  test('Escape is ignored once a higher-priority capture-phase handler calls preventDefault', async () => {
    await page.evaluate(() => {
      const handler = (event: KeyboardEvent) => {
        if (event.key === 'Escape') event.preventDefault();
      };
      (window as unknown as { __escapeGuardHandler?: (event: KeyboardEvent) => void }).__escapeGuardHandler = handler;
      // Capture phase, mirroring the real callers this guard protects
      // (BrowserPane's Esc-cancels-Inspect, useWindowDrag's Esc-cancels-drag -
      // see keybindings-registry.md's structural-Escape shapes): they must beat
      // the frame's bubble-phase close to the event.
      window.addEventListener('keydown', handler, { capture: true });
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await getWindowControlCalls()).toEqual([]);
    await page.evaluate(() => {
      const win = window as unknown as { __escapeGuardHandler?: (event: KeyboardEvent) => void };
      if (win.__escapeGuardHandler) {
        window.removeEventListener('keydown', win.__escapeGuardHandler, { capture: true });
        delete win.__escapeGuardHandler;
      }
    });
  });
});
