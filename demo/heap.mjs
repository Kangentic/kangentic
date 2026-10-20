/**
 * The JS heap a page of demo frames holds after a forced GC, the number kangentic.com budgets its
 * figures by. Shared by demo/measure.mjs and the `demo` tier's heap guard
 * (tests/demo/heap-budget.spec.ts), so the report and the guard read the heap one way.
 *
 * The frames are same-origin iframes on one host page, as a docs page holds several, so they share
 * one renderer process and one V8 isolate, and the host page's read is the page's number. Never sum
 * frames.
 *
 * Nothing here goes through Playwright's selector engine. `waitForFunction`, `expect(locator)` and
 * `evaluateAll` each inject Playwright's InjectedScript into a world of the page, a 0.31 MB source
 * string the heap then holds, once per world, and that no visitor pays. Readiness is a host-side
 * message listener polled with `page.evaluate`, which loads only Playwright's small utility script.
 *
 * The GC is the page's own `gc()`, which needs the browser launched with HEAP_LAUNCH_ARGS, and not
 * CDP's `HeapProfiler.collectGarbage`. The CDP call runs a memory-reducing collection a visitor's tab
 * does not, and on a looping board frame it read 4.2 MB less V8 heap than `gc()` (14.7 against
 * 18.9 MB, the same build back to back); on a still frame the two agree. `gc()` is also what
 * kangentic.com's harness calls, so the numbers here and the site's line up.
 *
 *   // the browser launched with { args: HEAP_LAUNCH_ARGS }
 *   const cdp = await page.context().newCDPSession(page);
 *   const { heapMb, usedMb, backingMb } = await measureFramesHeap(page, cdp, server, { scene: 'board', mode: 'still', count: 1 });
 */

/** Chromium flags a heap read needs: `--expose-gc` puts the forced GC on the page as `gc()`. */
export const HEAP_LAUNCH_ARGS = ['--js-flags=--expose-gc'];

/** The size every scene is authored at, and the size the site lays each frame out at. */
export const SITE_FRAME = { width: 1600, height: 1000 };

/** The viewport a host page opens in: `framesPageHtml`'s two 800 by 500 cells side by side. */
export const HOST_VIEWPORT = { width: 1640, height: 1100 };

/** How long a `loop=1` frame plays after ready before its heap is read: the site's own wait. */
export const LOOP_DWELL_MS = 15_000;

/** A still frame's wait after ready, for the work that lands a beat after it (a panel's terminal). */
export const STILL_DWELL_MS = 1_000;

/** The pause between the second forced GC and the read, the site harness's own. */
const GC_SETTLE_MS = 800;

const MB = 1024 * 1024;

/**
 * @typedef {object} FrameSet
 * @property {string} scene A scene in scenes.json.
 * @property {'still' | 'loop'} mode `still=1` or `loop=1`.
 * @property {number} count How many frames the host page holds.
 * @property {number} [width] The frame's layout width; 1600 by default.
 * @property {number} [height] The frame's layout height; 1000 by default.
 */

/**
 * The host page: `count` frames in a two-column grid, each laid out at its own size and scaled to
 * fit an 800 by 500 cell, so every frame is on screen (a frame plays its choreography only while it
 * is) and the host viewport stays HOST_VIEWPORT whatever the frame size.
 *
 * @param {string} frameBaseUrl The build's URL, e.g. `http://127.0.0.1:1234/demo/`.
 * @param {FrameSet} frameSet
 * @returns {string}
 */
export function framesPageHtml(frameBaseUrl, frameSet) {
  const width = frameSet.width ?? SITE_FRAME.width;
  const height = frameSet.height ?? SITE_FRAME.height;
  const scale = Math.min(1, 800 / width, 500 / height);
  const modeParam = frameSet.mode === 'loop' ? 'loop=1' : 'still=1';
  const src = `${frameBaseUrl}?view=${encodeURIComponent(frameSet.scene)}&embed=1&${modeParam}`;
  const cells = Array.from({ length: frameSet.count }, (_unused, index) =>
    `<div style="width:800px;height:500px;overflow:hidden"><iframe id="f${index}" src="${src}" style="width:${width}px;height:${height}px;border:0;transform:scale(${scale});transform-origin:0 0"></iframe></div>`).join('\n');
  return `<!doctype html><html><body style="background:#111;margin:0;display:grid;grid-template-columns:repeat(2,800px);gap:8px">
${cells}
<script>
  window.__ready = 0; window.__errors = [];
  addEventListener('message', (event) => {
    if (!event.data) return;
    if (event.data.type === 'kangentic-demo-ready') window.__ready += 1;
    if (event.data.type === 'kangentic-demo-error') window.__errors.push(String(event.data.reason));
  });
</script></body></html>`;
}

/**
 * Serves the host page from the demo server, opens it, and waits for every frame's ready message.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ origin: string; url: string; routes: Record<string, { body: string; contentType?: string }> }} server
 * @param {FrameSet} frameSet
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ readyMs: number }>}
 */
export async function bootFrames(page, server, frameSet, { timeoutMs = 60_000 } = {}) {
  const route = `/heap-${frameSet.scene}-${frameSet.mode}-${frameSet.count}-${frameSet.width ?? SITE_FRAME.width}.html`;
  server.routes[route] = { body: framesPageHtml(server.url, frameSet) };
  const started = Date.now();
  await page.goto(`${server.origin}${route}`);
  for (;;) {
    const state = await page.evaluate(() => ({ ready: window.__ready, errors: window.__errors }));
    if (state.errors.length > 0) throw new Error(`a ${frameSet.scene} frame failed to boot: ${state.errors.join('; ')}`);
    if (state.ready >= frameSet.count) return { readyMs: Date.now() - started };
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${state.ready} of ${frameSet.count} ${frameSet.scene} frames were ready after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * @typedef {object} HeapRead
 * @property {number} heapMb What the page's `performance.memory.usedJSHeapSize` reads (with
 *   `--enable-precise-memory-info`), the number kangentic.com budgets: `usedMb` plus `backingMb`.
 * @property {number} usedMb The V8 heap's own objects, code and strings, which CDP's
 *   `Performance.getMetrics` `JSHeapUsedSize` reports alone.
 * @property {number} backingMb ArrayBuffer backing stores (xterm's buffer lines, a WebGL glyph
 *   atlas, typed arrays), held outside the V8 heap but counted in `usedJSHeapSize`.
 */

/**
 * Two forced GCs from the page, a short settle, then the isolate's heap usage. Read through
 * `Runtime.getHeapUsage` rather than `performance.memory` so the two parts stay apart:
 * `JSHeapUsedSize` alone misses the backing stores, which are a quarter of a board frame and a third
 * of a frame with a large terminal. Their sum is what `performance.memory.usedJSHeapSize` reads
 * with `--enable-precise-memory-info`.
 *
 * @param {import('@playwright/test').Page} page The host page.
 * @param {import('@playwright/test').CDPSession} cdpSession A session on the host page.
 * @returns {Promise<HeapRead>} MB, to one decimal.
 */
export async function readGcHeap(page, cdpSession) {
  const collected = await page.evaluate(() => {
    const forceGc = /** @type {{ gc?: () => void }} */ (globalThis).gc;
    if (typeof forceGc !== 'function') return false;
    forceGc();
    forceGc();
    return true;
  });
  if (!collected) throw new Error('The page has no gc(); launch Chromium with HEAP_LAUNCH_ARGS (demo/heap.mjs).');
  await new Promise((resolve) => setTimeout(resolve, GC_SETTLE_MS));
  const usage = await cdpSession.send('Runtime.getHeapUsage');
  if (typeof usage.backingStorageSize !== 'number') {
    throw new Error('Runtime.getHeapUsage reported no backingStorageSize; this Chromium is too old to read the heap the site reads');
  }
  const toMb = (bytes) => Math.round((bytes / MB) * 10) / 10;
  return {
    heapMb: toMb(usage.usedSize + usage.backingStorageSize),
    usedMb: toMb(usage.usedSize),
    backingMb: toMb(usage.backingStorageSize),
  };
}

/**
 * Boots a host page of frames, lets it run for `STILL_DWELL_MS` (or `LOOP_DWELL_MS` when it loops),
 * and reads the GC'd heap.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').CDPSession} cdpSession
 * @param {{ origin: string; url: string; routes: Record<string, { body: string; contentType?: string }> }} server
 * @param {FrameSet} frameSet
 * @param {{ dwellMs?: number }} [options] Overrides the wait after ready.
 * @returns {Promise<HeapRead & { readyMs: number }>}
 */
export async function measureFramesHeap(page, cdpSession, server, frameSet, { dwellMs } = {}) {
  const { readyMs } = await bootFrames(page, server, frameSet);
  const wait = dwellMs ?? (frameSet.mode === 'loop' ? LOOP_DWELL_MS : STILL_DWELL_MS);
  await new Promise((resolve) => setTimeout(resolve, wait));
  return { readyMs, ...(await readGcHeap(page, cdpSession)) };
}
