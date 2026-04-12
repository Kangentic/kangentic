import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { type Resolution } from './resolutions';

const MOCK_SCRIPT = path.join(__dirname, '..', '..', 'ui', 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Poll the Vite dev server until it responds with HTTP 200.
 */
async function waitForViteReady(url: string = VITE_URL, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server not ready */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Vite dev server at ${url} not ready after ${timeoutMs}ms`);
}

export interface CaptureOptions {
  resolution: Resolution;
  theme: 'dark' | 'light';
  video?: boolean;
  /** Pre-configure script string (from marketing-fixture.ts) */
  preConfigScript: string;
  /** Hide the terminal panel to maximize board area (default: false) */
  hideTerminal?: boolean;
}

export interface CapturePage {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Launch a Chromium page pre-configured for marketing captures.
 * Sets viewport, device scale, theme, injects mock + fixture data,
 * disables animations, and waits for the board to render.
 */
export async function launchCapturePage(options: CaptureOptions): Promise<CapturePage> {
  await waitForViteReady();

  const browser = await chromium.launch({ headless: true });

  const contextOptions: Parameters<Browser['newContext']>[0] = {
    viewport: options.resolution.viewport,
    deviceScaleFactor: options.resolution.scale,
  };

  if (options.video) {
    contextOptions.recordVideo = {
      dir: path.join(__dirname, '..', '..', '..', 'captures', '_video-tmp'),
      size: options.resolution.viewport,
    };
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Inject config overrides before mock script loads.
  // Object.assign is shallow, so terminal must include all defaults.
  const configOverrides: Record<string, unknown> = {
    terminal: {
      shell: null,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 10,
      showPreview: false,
      panelHeight: 280,
      scrollbackLines: 5000,
      cursorStyle: 'block',
    },
    terminalPanelVisible: !options.hideTerminal,
  };
  if (options.theme === 'light') {
    configOverrides.theme = 'sand';
  }
  await page.addInitScript(`window.__mockConfigOverrides = ${JSON.stringify(configOverrides)};`);

  // Inject the mock Electron API
  await page.addInitScript({ path: MOCK_SCRIPT });

  // Inject the marketing fixture data
  await page.addInitScript(options.preConfigScript);

  // Navigate and wait for app shell
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  // Wait for board columns to render
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 5000 });

  // Disable CSS animations for screenshot stability
  if (!options.video) {
    await page.addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }`,
    });
  }

  // Wait for fonts to load
  await page.evaluate(() => document.fonts.ready);

  // Small settle time for scrollback to load and layout to settle
  await page.waitForTimeout(1000);

  await page.waitForTimeout(200);

  return { browser, context, page };
}

/**
 * Write marketing scrollback data directly to the currently visible
 * xterm terminal instance. Call this AFTER opening a task detail panel
 * and waiting for the terminal to mount.
 *
 * This bypasses the getScrollback scroll-to-bottom issue by writing
 * content as "live" data that appears in the visible viewport.
 */
export async function writeTerminalContent(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((sid) => {
    const data = (window as any).__marketingScrollback?.[sid];
    if (!data) return;

    // Find the xterm instance via the DOM — xterm attaches to .xterm elements
    const xtermElements = document.querySelectorAll('.xterm');
    // The task detail terminal is the last .xterm mounted
    const container = xtermElements[xtermElements.length - 1];
    if (!container) return;

    // Access xterm's Terminal instance via the screen element's internal ref.
    // Ink/xterm stores the instance on the parent; we traverse to find it.
    const screen = container.querySelector('.xterm-screen');
    if (!screen) return;

    // Use the textarea's input event to find the terminal, or write via
    // the global __mockTerminalWrite if available. Simplest: dispatch
    // the data through the onData callback mechanism.
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    if (textarea) {
      // The xterm instance is accessible via a closure in the React component.
      // We can trigger writes through the mock's onData by storing a writer.
      (window as any).__pendingTerminalWrite = { sessionId: sid, data };
    }
  }, sessionId);

  // Trigger the write via the mock API's onData
  await page.evaluate(() => {
    const pending = (window as any).__pendingTerminalWrite;
    if (!pending) return;

    // Fire all registered onData listeners with the session data
    const listeners = (window as any).__onDataListeners || [];
    listeners.forEach((cb: any) => cb(pending.sessionId, pending.data));
    delete (window as any).__pendingTerminalWrite;
  });

  // Let xterm render
  await page.waitForTimeout(500);
}
