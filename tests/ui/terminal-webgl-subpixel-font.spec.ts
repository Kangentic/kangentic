/**
 * A sub-pixel font size never reaches a WebGL terminal (Sentry DESKTOP-1J/1K).
 *
 * xterm's WebGL renderer floors the character width to whole device pixels, so
 * at a 1px font (what the Settings field committed on the "1" of "12") the cell
 * is 0 pixels wide. Its zero-size guard tests width AND height, and the height is
 * ceiled to at least 1, so it builds the glyph atlas at width 0 anyway. The first
 * `_` it rasterizes throws `IndexSizeError: ... getImageData ... The source width
 * is 0`, from the render frame (1J) and from the atlas warm-up's idle callback
 * (1K). A hidden or zero-width container is not a cause. xterm measures on an
 * OffscreenCanvas and keeps its previous size when a measurement reads 0.
 *
 * The config is written through the store, bypassing the Settings field, which
 * is what a hand-edited config.json does. The field's own guard is covered in
 * settings-panel.spec.ts. The UI tier runs WebGL on SwiftShader at device scale
 * factor 1, and the renderer report is the positive control that it attached.
 */
import { test, expect, type Page } from '@playwright/test';
import { collectPageErrors, launchWithTransientTerminal, openTransientCommandTerminal } from './helpers';

test.describe.configure({ mode: 'parallel' });

const TRANSIENT_SESSION_ID = 'sess-webgl-subpixel-font-1';

interface RendererStatusEntry { renderer: 'webgl' | 'dom' }
interface TerminalGridReport { sessionId: string | null; cols: number; nonEmptyLines: number }
interface TestWindow {
  __kangenticTerminalRenderers?: () => Record<string, RendererStatusEntry>;
  __kangenticTerminalGrids?: () => TerminalGridReport[];
  __mockFireSessionData: (id: string, data: string) => void;
  __zustandStores?: {
    config?: { getState: () => { updateConfig: (partial: { terminal: { fontSize: number } }) => Promise<void> } };
  };
}

function readRenderer(page: Page): Promise<string | null> {
  return page.evaluate((sessionId) => {
    const read = (window as unknown as TestWindow).__kangenticTerminalRenderers;
    return read ? read()[sessionId]?.renderer ?? null : null;
  }, TRANSIENT_SESSION_ID);
}

function readGrid(page: Page): Promise<TerminalGridReport | null> {
  return page.evaluate((sessionId) => {
    const read = (window as unknown as TestWindow).__kangenticTerminalGrids;
    return (read ? read() : []).find((grid) => grid.sessionId === sessionId) ?? null;
  }, TRANSIENT_SESSION_ID);
}

test('a 1px terminal font is held at the floor and never builds a zero-width WebGL atlas', async () => {
  const { browser, page } = await launchWithTransientTerminal({
    projectId: 'proj-webgl-subpixel-font',
    projectName: 'WebGL Subpixel Font Project',
    sessionId: TRANSIENT_SESSION_ID,
    // The bug needs the cell to floor to 0 device pixels, which 1px reaches at scale 1.
    contextOptions: { deviceScaleFactor: 1 },
  });
  try {
    const pageErrors = collectPageErrors(page);

    await openTransientCommandTerminal(page, TRANSIENT_SESSION_ID);

    // Positive control: the terminal is on WebGL, the renderer the bug lives in.
    await expect.poll(() => readRenderer(page), { timeout: 10000 }).toBe('webgl');

    // Underscores on screen, the glyph the atlas throws on. Re-fired until it
    // lands, since a chunk during the mount replay is superseded by its frame.
    await expect.poll(async () => {
      await page.evaluate((sessionId) => {
        (window as unknown as TestWindow).__mockFireSessionData(sessionId, 'snake_case_name __init__\r\n');
      }, TRANSIENT_SESSION_ID);
      return (await readGrid(page))?.nonEmptyLines ?? 0;
    }, { timeout: 10000, intervals: [250] }).toBeGreaterThan(0);
    const colsAtDefaultFont = (await readGrid(page))?.cols ?? 0;
    expect(colsAtDefaultFont).toBeGreaterThan(0);

    await page.evaluate(async () => {
      await (window as unknown as TestWindow).__zustandStores?.config?.getState().updateConfig({ terminal: { fontSize: 1 } });
    });

    // Fresh text through the new atlas, then time for the idle-callback warm-up,
    // which is where 1K threw. A fixed wait, because this is a non-occurrence.
    await page.evaluate((sessionId) => {
      (window as unknown as TestWindow).__mockFireSessionData(sessionId, 'after_resize_underscores ___\r\n');
    }, TRANSIENT_SESSION_ID);
    await page.waitForTimeout(1500);

    // The change did reach the terminal, so the clean run below is not vacuous.
    // The 8px floor fits 14/8 = 1.75x the default's columns. An unfloored 1px has
    // a zero-width cell, so the fit has nothing to divide by and the columns stay
    // at the default's count (measured: 132 at 14px, 231 at the floor, 132 unfloored).
    // The lower bound is what goes red on a missing floor. The upper bound pins
    // that the size landed near 8px and not at some much smaller one.
    await expect.poll(async () => (await readGrid(page))?.cols ?? 0, { timeout: 10000 }).toBeGreaterThan(colsAtDefaultFont);
    const colsAtFlooredFont = (await readGrid(page))?.cols ?? 0;
    expect(colsAtFlooredFont).toBeLessThan(colsAtDefaultFont * 2.5);

    expect(pageErrors().filter((message) => /getImageData|source width is 0/u.test(message))).toEqual([]);
    expect(pageErrors()).toEqual([]);
    expect(await readRenderer(page)).toBe('webgl');
  } finally {
    await browser.close();
  }
});

test('a terminal constructed with a 1px configured font is held at the floor from its first frame', async () => {
  // The test above changes the size on a live terminal. This one seeds the
  // config BEFORE the terminal mounts, which is the constructor path
  // (`fontSize: configuredFontSize` in useTerminal), the one a hand-edited
  // config.json takes on every launch.
  const { browser, page } = await launchWithTransientTerminal({
    projectId: 'proj-webgl-subpixel-font-mount',
    projectName: 'WebGL Subpixel Font Mount Project',
    sessionId: TRANSIENT_SESSION_ID,
    contextOptions: { deviceScaleFactor: 1 },
    terminalFontSize: 1,
  });
  try {
    const pageErrors = collectPageErrors(page);

    await openTransientCommandTerminal(page, TRANSIENT_SESSION_ID);
    await expect.poll(() => readRenderer(page), { timeout: 10000 }).toBe('webgl');

    // Underscores on screen, re-fired until one lands over the mount replay.
    await expect.poll(async () => {
      await page.evaluate((sessionId) => {
        (window as unknown as TestWindow).__mockFireSessionData(sessionId, 'snake_case_name __init__ ___\r\n');
      }, TRANSIENT_SESSION_ID);
      return (await readGrid(page))?.nonEmptyLines ?? 0;
    }, { timeout: 10000, intervals: [250] }).toBeGreaterThan(0);
    const colsAtMount = (await readGrid(page))?.cols ?? 0;

    // Time for the atlas warm-up's idle callback, which is where 1K threw. A
    // fixed wait, because this is a non-occurrence.
    await page.waitForTimeout(1500);
    expect(pageErrors()).toEqual([]);
    expect(await readRenderer(page)).toBe('webgl');

    // A known 14px baseline from the same terminal. The mount ran at the 8px
    // floor, so it fits 14/8 = 1.75x the columns. A terminal that kept the 1px
    // never gets a cell to divide by, so its columns are not that count at all.
    await page.evaluate(async () => {
      await (window as unknown as TestWindow).__zustandStores?.config?.getState().updateConfig({ terminal: { fontSize: 14 } });
    });
    await expect.poll(async () => (await readGrid(page))?.cols ?? 0, { timeout: 10000 }).toBeLessThan(colsAtMount);
    const colsAtDefaultFont = (await readGrid(page))?.cols ?? 0;
    expect(colsAtDefaultFont).toBeGreaterThan(0);
    expect(colsAtMount).toBeGreaterThan(colsAtDefaultFont * 1.4);
    expect(colsAtMount).toBeLessThan(colsAtDefaultFont * 2.5);
  } finally {
    await browser.close();
  }
});
