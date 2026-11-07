/**
 * The Chromium in the Electron we ship still parses the font string
 * @xterm/addon-webgl builds for its glyph atlas.
 *
 * The addon writes `${style} ${weight} ${size}px ${family}` with an empty style for
 * upright text, so every string it hands `ctx.font` starts with a space. The Electron
 * 45.2.3 build carried a Chromium backport that rejects that. A rejected value leaves
 * `ctx.font` at its default, 10px sans-serif, so every WebGL terminal draws at 10px
 * and nothing throws (electron/electron#55616, xtermjs/xterm.js#6297).
 *
 * The wiring a mock cannot stand in for is the Electron build itself: UI specs run in
 * Playwright's own Chromium, so they would stay green through this, and no spec renders
 * WebGL. This reads the parse directly, which needs no GPU, so it runs in this tier's
 * `ELECTRON_DISABLE_GPU` launch. Any Electron bump goes through it. Passes on 45.1.0
 * and reads red on 45.2.3.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, getTestDataDir, cleanupTestDataDir, closeApp } from './helpers';

const TEST_NAME = 'webgl-atlas-font';
/** Past the 10px default, so a rejected value cannot read as a pass. */
const FONT_SIZE_PX = 30;

test.describe('WebGL atlas font string', () => {
  let app: ElectronApplication | undefined;
  let page: Page;

  test.beforeAll(async () => {
    const launched = await launchApp({ dataDir: getTestDataDir(TEST_NAME) });
    app = launched.app;
    page = launched.page;
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTestDataDir(TEST_NAME);
  });

  /** What each canvas kind reads back after `font` is assigned, as the addon assigns it. */
  function readBack(font: string): Promise<{ canvas: string; offscreen: string }> {
    return page.evaluate((assigned) => {
      const canvasContext = document.createElement('canvas').getContext('2d');
      const offscreenContext = new OffscreenCanvas(16, 16).getContext('2d');
      if (!canvasContext || !offscreenContext) throw new Error('no 2d context');
      canvasContext.font = assigned;
      offscreenContext.font = assigned;
      return { canvas: canvasContext.font, offscreen: offscreenContext.font };
    }, font);
  }

  test('a font string with no leading space parses, so the check below can fail for its own reason', async () => {
    const read = await readBack(`normal ${FONT_SIZE_PX}px monospace`);
    expect(read.canvas).toContain(`${FONT_SIZE_PX}px`);
    expect(read.offscreen).toContain(`${FONT_SIZE_PX}px`);
  });

  test('the addon\'s leading-space string parses at the requested size, on both canvas kinds', async () => {
    const read = await readBack(` normal ${FONT_SIZE_PX}px monospace`);
    expect(read.canvas).toContain(`${FONT_SIZE_PX}px`);
    expect(read.offscreen).toContain(`${FONT_SIZE_PX}px`);
  });
});
