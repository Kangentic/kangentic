/**
 * Measure the web build the way a page that embeds it would feel it.
 *
 *   node demo/measure.mjs            build sizes, per-scene boot timings, the egress check, and
 *                                    the cost of hosting 1, 4, and 8 frames on one page
 *   node demo/measure.mjs --serve    only serve dist/demo and stay up for a manual look
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
const SCENES = ['board', 'task', 'changes', 'monitor'];
const FRAME_COUNTS = [1, 4, 8];

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

async function main() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`No web build at ${distDir}. Run "npm run build:demo" first.`);
  }
  const server = await startDemoServer({ distDir, port: 0 });
  if (process.argv.includes('--serve')) {
    console.log(`Serving ${server.url}?view=board&embed=1&still=1 (Ctrl+C to stop)`);
    await new Promise(() => {});
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
