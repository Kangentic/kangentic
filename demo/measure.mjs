/**
 * Measure the web build the way a page that embeds it would feel it.
 *
 *   node demo/measure.mjs            build sizes, per-scene boot timings, the egress check, and
 *                                    the cost of hosting 1, 4, and 8 frames on one page
 *   node demo/measure.mjs --serve    only serve dist/demo and stay up for a manual look
 *   node demo/measure.mjs --geometry the grid each terminal surface fits at the 1600 by 1000
 *                                    frame, at device scale 1 and 2, against the capture
 *                                    matrix's manifest geometry; --check exits non-zero when
 *                                    the manifest disagrees with the launch it says it measured at
 *
 * Numbers go to stdout as one markdown block for demo/README.md. Nothing here is a test; the
 * `demo` Playwright tier asserts the invariants, this script reports the magnitudes.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from './static-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(demoDir, '..', 'dist', 'demo');
const manifestPath = path.resolve(demoDir, '..', 'tests', 'captures', 'fixtures', 'demo', 'manifest.json');
const SCENES = ['board', 'task', 'changes', 'monitor'];
const FRAME_COUNTS = [1, 4, 8];

/**
 * The surfaces the capture matrix records at, each opened the way a visitor or a scene opens it,
 * and the sessions whose terminal it mounts. Every recording is made at the grid its surface
 * fits (manifest geometry), and that grid moves with the device scale: the renderer rounds the
 * cell to device pixels, so the same window fits fewer columns at 2x than at 1x. The manifest
 * names the scale each surface was measured at, and --check compares against that one.
 */
const GEOMETRY_SCALES = [1, 2];
const FRAME_VIEWPORT = { width: 1600, height: 1000 };

/**
 * The window manager's DEFAULT rect (defaultWindowGeometry in
 * src/renderer/window-manager/store/geometry.ts: 0.58 of the frame, centred), which is the window
 * a session records at. The `task` and `command-terminal` scenes size their window to the
 * recording at the visitor's own cell instead, see FITTED_FLOATING_GEOMETRY in
 * tests/captures/scenes.ts, so they fit whatever the recording is and are not the surfaces here;
 * the two single surfaces are built from a state blob at the default rect instead.
 */
const DEFAULT_WINDOW_RECT = { x: 0.21, y: 0.15, w: 0.58, h: 0.7 };

function defaultTaskWindowState() {
  return {
    config: {
      workspaceByProject: {
        'proj-contoso-web': {
          version: 1,
          windows: [{
            taskId: 'task-cw-middleware', kind: 'task-detail', title: 'Extract auth middleware',
            geometry: DEFAULT_WINDOW_RECT, restoreGeometry: null, state: 'floating',
          }],
          tileTree: null,
          tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
          focusedTaskId: 'task-cw-middleware',
        },
      },
    },
  };
}

function defaultCommandTerminalState() {
  return {
    config: {
      commandTerminalWorkspace: {
        version: 1,
        windows: [{ taskId: 'slot-1', kind: 'command-terminal', title: 'Command Terminal 1', geometry: DEFAULT_WINDOW_RECT, restoreGeometry: null, state: 'floating' }],
        tileTree: null,
        tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
        focusedTaskId: 'slot-1',
      },
    },
    steps: [{ click: '[data-testid="quick-session-button"]', waitFor: '[data-testid="command-terminal-window"]' }],
  };
}

function encodeState(state) {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

/**
 * Only the surface's OWN terminals are read: the board's bottom panel mounts one too (15 rows,
 * no surface of the matrix), and a Command Terminal the scene spawns has an id minted at spawn
 * time, so `spawned` stands for every session the sample install did not seed.
 */
const GEOMETRY_SURFACES = [
  { key: 'taskWindow', params: { state: encodeState(defaultTaskWindowState()) }, sessions: ['sess-cw-middleware'] },
  { key: 'taskWindowTiled', params: { view: 'windows-tiled' }, sessions: ['sess-cw-middleware', 'sess-cw-api-client'] },
  { key: 'commandTerminal', params: { state: encodeState(defaultCommandTerminalState()) }, sessions: ['sess-cw-terminal-1'] },
  { key: 'commandTerminalTiled', params: { view: 'command-terminal-tiled' }, sessions: ['sess-cw-terminal-1', 'spawned'] },
];

function isSeededSession(sessionId) {
  return sessionId.startsWith('sess-');
}

function gzipSize(filePath) {
  return zlib.gzipSync(fs.readFileSync(filePath), { level: 9 }).length;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Every file the build names carries a content hash, and the README table must not churn one
 *  on each rebuild: report the stable stem instead. */
function stableName(name) {
  // Exactly eight characters before the extension: both Vite's hashes and the demo plugin's are
  // that long, and an open-ended run would eat the name itself ("demo-scenes-f6273e74.js").
  return name.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/, '$1');
}

/** What the browser downloads before the board paints, by reading the built index.html. */
function eagerAssets() {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const names = [...html.matchAll(/(?:src|href)="[^"]*\/([^/"]+\.(?:js|css))"/g)].map((match) => match[1]);
  return names.map((name) => {
    const filePath = fs.existsSync(path.join(distDir, name)) ? path.join(distDir, name) : path.join(distDir, 'assets', name);
    return { name: stableName(name), raw: fs.statSync(filePath).size, gzip: gzipSize(filePath) };
  });
}

function framesPage(origin, base, count, scene) {
  const frames = Array.from({ length: count }, (_, index) =>
    `<iframe id="f${index}" src="${base}?view=${scene}&embed=1&still=1" style="width:800px;height:500px;border:1px solid #444"></iframe>`).join('\n');
  return `<!doctype html><html><body style="background:#111;margin:0;display:grid;grid-template-columns:repeat(2,800px);gap:8px">
    ${frames}
    <script>
      window.__ready = []; window.__readyAt = {};
      addEventListener('message', (event) => {
        if (event.data && event.data.type === 'kangentic-demo-ready') { window.__ready.push(event.source); window.__readyAt[window.__ready.length] = performance.now(); }
      });
    </script></body></html>`;
}

async function measureScene(browser, server, scene) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  const started = Date.now();
  await page.goto(`${server.url}?view=${scene}&embed=1&still=1`);
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-demo-ready'), null, { timeout: 30000 });
  const readyMs = Date.now() - started;
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, Math.round(entry.startTime)]));
    return {
      domContentLoaded: Math.round(navigation.domContentLoadedEventEnd),
      load: Math.round(navigation.loadEventEnd),
      firstPaint: paints['first-paint'] ?? null,
      firstContentfulPaint: paints['first-contentful-paint'] ?? null,
      transferBytes: performance.getEntriesByType('resource').reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
    };
  });
  const offOrigin = requests.filter((url) => !url.startsWith(server.origin));
  await page.close();
  return { scene, readyMs, requests: requests.length, offOrigin, ...timing };
}

async function measureFrames(browser, server, count) {
  const route = `/bench-${count}.html`;
  server.routes[route] = { body: framesPage(server.origin, server.base, count, 'board') };
  const page = await browser.newPage({ viewport: { width: 1640, height: 1100 } });
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  const started = Date.now();
  await page.goto(`${server.origin}${route}`);
  await page.waitForFunction((expected) => window.__ready.length >= expected, count, { timeout: 60000 });
  const allReadyMs = Date.now() - started;
  const metrics = await client.send('Performance.getMetrics');
  const metric = (name) => metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
  const result = {
    frames: count,
    allReadyMs,
    scriptMs: Math.round(metric('ScriptDuration') * 1000),
    layoutMs: Math.round(metric('LayoutDuration') * 1000),
    taskMs: Math.round(metric('TaskDuration') * 1000),
    jsHeapMb: Math.round(metric('JSHeapUsedSize') / 1048576),
  };
  await page.close();
  return result;
}

/**
 * The natural grid each of the surface's terminals reported, once the reports have stopped
 * changing. The seed exposes them as window.__demoNaturalGeometry (the last non-echo resize per
 * session). A terminal reports once at a transitional size before its window's layout lands,
 * and a spawned session's context bar wraps to a second row only when its usage lands, a beat
 * after its first output, which is why four identical reads a second apart are required.
 */
async function settledGeometry(page, sessions) {
  const deadline = Date.now() + 30000;
  let previous = null;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const all = await page.evaluate(() => window.__demoNaturalGeometry || {});
    const picked = {};
    for (const wanted of sessions) {
      if (wanted === 'spawned') {
        for (const [sessionId, grid] of Object.entries(all)) if (!isSeededSession(sessionId)) picked[sessionId] = grid;
      } else if (all[wanted]) {
        picked[wanted] = all[wanted];
      }
    }
    const current = JSON.stringify(picked);
    stableReads = current === previous ? stableReads + 1 : 0;
    if (stableReads >= 3 && Object.keys(picked).length >= sessions.length) return picked;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`the page mounted fewer than ${sessions.length} terminal(s) or their grids kept changing: ${previous}`);
}

async function measureGeometry(server) {
  const measured = {};
  for (const scale of GEOMETRY_SCALES) {
    // The scale is forced on the browser, not only emulated on the context, for the reason
    // tests/captures/helpers/capture-page.ts gives: an emulated scale leaves xterm's canvas at 1x.
    const browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${scale}`] });
    measured[scale] = {};
    // A surface whose grids never settle throws (settledGeometry's deadline); the browser still
    // closes on the way out rather than waiting for the process exit to reap it.
    try {
      const context = await browser.newContext({ viewport: FRAME_VIEWPORT, deviceScaleFactor: scale });
      for (const surface of GEOMETRY_SURFACES) {
        const page = await context.newPage();
        const url = new URL(server.url);
        url.searchParams.set('embed', '1');
        url.searchParams.set('still', '1');
        url.searchParams.set('stage', '0');
        for (const [key, value] of Object.entries(surface.params)) url.searchParams.set(key, value);
        await page.goto(url.toString());
        await page.waitForFunction(() => document.documentElement.hasAttribute('data-demo-ready'), null, { timeout: 30000 });
        measured[scale][surface.key] = await settledGeometry(page, surface.sessions);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  return measured;
}

function reportGeometry(measured, check) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lines = [];
  lines.push('### Terminal grids at the 1600 by 1000 frame, by device scale (cols x rows)');
  lines.push('');
  lines.push(`| Surface | Session | ${GEOMETRY_SCALES.map((scale) => `${scale}x`).join(' | ')} | Manifest |`);
  lines.push(`|---|---|${GEOMETRY_SCALES.map(() => '---').join('|')}|---|`);
  const mismatches = [];
  for (const surface of GEOMETRY_SURFACES) {
    const recorded = manifest.geometry[surface.key];
    // A spawned Command Terminal has a different id on every page, so its rows are matched by
    // position: the seeded sessions first, in the surface's order, then whatever was spawned.
    const rowsByScale = GEOMETRY_SCALES.map((scale) => {
      const grids = measured[scale][surface.key];
      const seeded = surface.sessions.filter((sessionId) => sessionId !== 'spawned').map((sessionId) => [sessionId, grids[sessionId]]);
      const spawned = Object.entries(grids).filter(([sessionId]) => !isSeededSession(sessionId)).map(([, grid]) => ['spawned', grid]);
      return [...seeded, ...spawned];
    });
    for (const [index, [sessionId]] of rowsByScale[0].entries()) {
      const cells = GEOMETRY_SCALES.map((_scale, scaleIndex) => {
        const grid = rowsByScale[scaleIndex][index]?.[1];
        return grid ? `${grid.cols} x ${grid.rows}` : 'not mounted';
      });
      const manifestCell = recorded ? `${recorded.cols} x ${recorded.rows} at ${recorded.scale ?? '?'}x` : 'none';
      lines.push(`| ${surface.key} | ${sessionId} | ${cells.join(' | ')} | ${manifestCell} |`);
      if (!recorded) {
        mismatches.push(`${surface.key}: the manifest has no geometry for it`);
        continue;
      }
      if (!GEOMETRY_SCALES.includes(recorded.scale)) {
        mismatches.push(`${surface.key}: the manifest names no measured scale (add "scale": 1 or 2)`);
        continue;
      }
      // A spawned terminal is reported but never decides: its context bar wraps to a second row
      // only once its usage lands, a beat after its first output, and whether the settle catches
      // that is a race (measured both 37 and 39 rows on the same build). The seeded session in
      // the same layout is the stable measure of the pane, and the rows follow the agent anyway.
      if (sessionId === 'spawned') continue;
      const grid = rowsByScale[GEOMETRY_SCALES.indexOf(recorded.scale)][index]?.[1];
      // The rows in the manifest are the Claude rows; every surface here mounts a Claude session.
      if (!grid || grid.cols !== recorded.cols || grid.rows !== recorded.rows) {
        mismatches.push(`${surface.key} (${sessionId}): manifest says ${recorded.cols} x ${recorded.rows} at ${recorded.scale}x, measured ${grid ? `${grid.cols} x ${grid.rows}` : 'nothing'}`);
      }
    }
  }
  lines.push('');
  if (mismatches.length === 0) lines.push('The manifest geometry matches the launch it says it measured at.');
  else lines.push(...mismatches.map((line) => `MISMATCH: ${line}`));
  console.log(lines.join('\n'));
  if (check && mismatches.length > 0) process.exit(1);
}

async function main() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`No web build at ${distDir}. Run "npm run build:demo" first.`);
  }
  const server = await startDemoServer({ distDir, port: 0 });
  if (process.argv.includes('--serve')) {
    console.log(`Serving ${server.url}?view=board&embed=1&still=1 (Ctrl+C to stop)`);
    await new Promise(() => {});
  }
  if (process.argv.includes('--geometry')) {
    let measured;
    try {
      measured = await measureGeometry(server);
    } finally {
      await server.close();
    }
    reportGeometry(measured, process.argv.includes('--check'));
    return;
  }

  const eager = eagerAssets();
  const eagerGzip = eager.reduce((sum, asset) => sum + asset.gzip, 0);
  const everything = fs.readdirSync(path.join(distDir, 'assets')).map((name) => path.join(distDir, 'assets', name));
  const totalRaw = everything.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);

  const browser = await chromium.launch({ headless: true });
  const scenes = [];
  for (const scene of SCENES) scenes.push(await measureScene(browser, server, scene));
  const frames = [];
  for (const count of FRAME_COUNTS) frames.push(await measureFrames(browser, server, count));
  await browser.close();
  await server.close();

  const lines = [];
  lines.push('### What the page ships before first paint (gzipped)');
  lines.push('');
  lines.push('| File | Raw | Gzip |');
  lines.push('|---|---|---|');
  for (const asset of eager) lines.push(`| ${asset.name} | ${kb(asset.raw)} | ${kb(asset.gzip)} |`);
  lines.push(`| **Eager total** | | **${kb(eagerGzip)}** |`);
  lines.push(`| Whole dist/demo/assets (lazy chunks included, raw) | ${kb(totalRaw)} | |`);
  lines.push('');
  lines.push('### Cold boot per scene, plain static server, headless Chromium');
  lines.push('');
  lines.push('| Scene | Requests | Off-origin | First paint | First contentful paint | Load | Ready |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const scene of scenes) {
    lines.push(`| ${scene.scene} | ${scene.requests} | ${scene.offOrigin.length} | ${scene.firstPaint} ms | ${scene.firstContentfulPaint} ms | ${scene.load} ms | ${scene.readyMs} ms |`);
  }
  lines.push('');
  lines.push('### Frames per page (board scene, 800x500 iframes)');
  lines.push('');
  lines.push('| Frames | All ready | Script time | Layout time | Task time | JS heap |');
  lines.push('|---|---|---|---|---|---|');
  for (const frame of frames) {
    lines.push(`| ${frame.frames} | ${frame.allReadyMs} ms | ${frame.scriptMs} ms | ${frame.layoutMs} ms | ${frame.taskMs} ms | ${frame.jsHeapMb} MB |`);
  }
  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
