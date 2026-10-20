/**
 * The web demo's per-frame heap stays inside a budget.
 *
 * kangentic.com budgets every figure and landing stage by the JS heap a page holds after a forced
 * GC (`performance.memory.usedJSHeapSize`), and caps figures per page by it. Nothing in this repo
 * watched that number, so a change could double it with every test green. This spec boots one board
 * frame on a host page, the way the site embeds it, reads the heap through demo/heap.mjs (the same
 * read `node demo/measure.mjs --heap` reports), and fails past a stated budget.
 *
 * Playwright's headless Chromium has WebGL, as a visitor's browser does, so the frame's terminal
 * draws through xterm's WebGL renderer and the read counts its buffers. Each test asserts that after
 * the read: a runner without WebGL would fall back to the DOM renderer and measure a frame no
 * visitor's tab runs.
 *
 * Recalibrating: run `npm run build:demo` and then this spec. Each test logs what it read on every
 * run, CI's included (the `demo` job's log), so take the ubuntu-24.04 runner's value, add 15
 * percent, and round up. Change the README's sentence that states the two budgets
 * (demo/README.md, "JS heap after a forced GC") with them. Raise a budget only with the cause named
 * there; a budget raised to fit whatever the build now reads guards nothing. The floor fails a read
 * that came back empty or from a frame that never booted.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { startDemoServer } from '../../demo/static-server.mjs';
import { HEAP_LAUNCH_ARGS, HOST_VIEWPORT, measureFramesHeap } from '../../demo/heap.mjs';

const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist', 'demo');

/**
 * MB after a forced GC, V8 heap plus array buffers, about 15 percent over what the build read on
 * 2026-10-20: 18.3 MB still and 24.5 MB looping on Windows, 18.2 and 23.9 to 24.4 on Ubuntu 24.04
 * with the same Chromium (demo/README.md, "JS heap after a forced GC"). Repeated reads agree to
 * 0.1 MB still and 0.6 MB looping, so the headroom is for creep, not noise.
 */
const BOARD_STILL_BUDGET_MB = 21;
const BOARD_LOOP_BUDGET_MB = 29;
/** Below this the read is broken, not light: a blank page reads about 0.5 MB. */
const FLOOR_MB = 5;

type DemoServer = Awaited<ReturnType<typeof startDemoServer>>;

let server: DemoServer;

// `--expose-gc` puts the forced GC on the page as the site's harness calls it (demo/heap.mjs). The
// host page lays the frame out at the site's 1600 by 1000 inside an 800 by 500 cell.
test.use({ launchOptions: { args: HEAP_LAUNCH_ARGS }, viewport: HOST_VIEWPORT });

test.beforeAll(async () => {
  server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
});

test.afterAll(async () => {
  if (server) await server.close();
});

for (const { mode, budgetMb } of [
  { mode: 'still' as const, budgetMb: BOARD_STILL_BUDGET_MB },
  { mode: 'loop' as const, budgetMb: BOARD_LOOP_BUDGET_MB },
]) {
  test(`one board frame (${mode}) holds under ${budgetMb} MB after a forced GC`, async ({ page }, testInfo) => {
    // A looping frame is read after LOOP_DWELL_MS, the site's own dwell, on top of the boot.
    test.setTimeout(60_000);
    const cdp = await page.context().newCDPSession(page);
    const read = await measureFramesHeap(page, cdp, server, { scene: 'board', mode, count: 1 });
    const line = `board ${mode}: ${read.heapMb} MB (${read.usedMb} V8 heap + ${read.backingMb} array buffers), budget ${budgetMb} MB`;
    console.log(line);
    testInfo.annotations.push({ type: 'heap', description: line });
    expect(read.heapMb, line).toBeGreaterThan(FLOOR_MB);
    expect(read.heapMb, line).toBeLessThan(budgetMb);

    // Checked after the read, since evaluating in the frame adds Playwright's own script to it.
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (!frame) throw new Error('the host page holds no demo frame');
    const renderer = await frame.evaluate(() => ({
      canvases: document.querySelectorAll('.xterm canvas').length,
      domRows: document.querySelectorAll('.xterm-rows').length,
    }));
    const webglMessage = 'the board panel\'s terminal draws through WebGL, as in a visitor\'s browser';
    expect(renderer.domRows, webglMessage).toBe(0);
    expect(renderer.canvases, webglMessage).toBeGreaterThan(0);
  });
}
