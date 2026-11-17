/**
 * Sentry DESKTOP-32, pop-out half: a pop-out window is its own page with its
 * own copy of terminal-webgl.ts, so it needs the graphics status the main
 * window pulls in App.tsx. usePopOutBootstrap does the pull
 * (loadTerminalGraphicsSupport) and hands it to setTerminalGraphicsSupport.
 * tests/unit/pop-out-graphics-support.test.ts calls the loader directly, so
 * this is the one test that a real pop-out page makes the call.
 *
 * Boots the 'stats' pop-out through the `#stats` hash (the cheapest real
 * PopOutSurfaceRoot mount, see popout-window-frame-escape.spec.ts) with the
 * mock reporting WebGL off, then attaches a fake terminal through the page's
 * own terminal-webgl module. Deliberately no --disable-webgl: the fake addon
 * below would attach fine, so a DOM report can only come from the pulled status.
 *
 * How to verify RED / GREEN: delete the `loadTerminalGraphicsSupport();` call
 * in usePopOutBootstrap.ts and the poll below times out with 'webgl'.
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

test('a pop-out page keeps terminals on the DOM renderer with no retry when the status says WebGL is off', async () => {
  test.slow();
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(`
      window.__mockGpuWebglAvailable = false;
      window.__mockGpuWebglFeatureStatus = 'disabled_off';
    `);
    await gotoVite(page, `${VITE_URL}#stats`);
    await page.waitForLoadState('load');
    // Mount probe: the real pop-out frame (and so usePopOutBootstrap) mounted.
    // 'Usage Statistics' is POP_OUT_SURFACES.stats.title.
    await expect.poll(() => page.title(), { timeout: 15000 }).toBe('Usage Statistics');

    // Each poll attempt attaches a fresh fake terminal and disposes it. The
    // pull is async, so early attempts may still see WebGL available; the
    // answer settles once the status lands. With the pull missing it never
    // does and the fake addon attaches every time.
    await expect
      .poll(() => page.evaluate(() => {
        // The pop-out page's own copy of the module: App.tsx is evaluated in every window.
        const modules = window.__kangenticTestModules;
        if (!modules) throw new Error('window.__kangenticTestModules not exposed');
        const module = modules.terminalWebgl;
        let addonsCreated = 0;
        const fakeTerminal = { loadAddon: () => undefined } as unknown as Parameters<typeof module.attachWebglRenderer>[0];
        const key = `popout-webgl-off-${Math.random().toString(36).slice(2, 8)}`;
        const detach = module.attachWebglRenderer(fakeTerminal, key, {
          createAddon: () => {
            addonsCreated += 1;
            return { onContextLoss: () => ({ dispose: () => undefined }), dispose: () => undefined };
          },
        });
        const status = module.getTerminalRendererReport()[key];
        const result = { renderer: status.renderer, retryArmed: status.retryArmed, addonsCreated };
        detach();
        return result;
      }), { timeout: 10000 })
      .toEqual({ renderer: 'dom', retryArmed: false, addonsCreated: 0 });
  } finally {
    await browser.close();
  }
});
