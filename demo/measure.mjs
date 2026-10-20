/**
 * Measure the web build the way a page that embeds it would feel it.
 *
 *   node demo/measure.mjs            build sizes, per-scene boot timings, the egress check, and
 *                                    the cost of hosting 1, 4, and 8 frames on one page, with the
 *                                    JS heap read after a forced GC (demo/heap.mjs)
 *   node demo/measure.mjs --heap     the GC'd heap of the cases the site budgets (board still and
 *                                    looping, 1 and 4 frames, task-mcp, changes), the median of
 *                                    --runs=N fresh pages (3); --scenes=a,b keeps only those scenes,
 *                                    --dwell=ms overrides how long a looping frame plays first
 *   node demo/measure.mjs --heap-snapshot=board[,loop] [--out=dir]
 *                                    one frame's heap snapshot, written to --out, summarized by
 *                                    node type and constructor with the largest strings; with two
 *                                    builds, as the difference between them
 *   --dist=path[,label=path]         measure another build, or several (--heap and
 *                                    --heap-snapshot interleave them, so they run back to back);
 *                                    a build is labelled by its app version unless one is given
 *   node demo/measure.mjs --serve    only serve dist/demo and stay up for a manual look
 *   node demo/measure.mjs --geometry the grid each terminal surface fits at the 1600 by 1000
 *                                    frame, at device scale 1 and 2, against the capture
 *                                    matrix's manifest geometry; --check exits non-zero when
 *                                    the manifest disagrees with the launch it says it measured at
 *   node demo/measure.mjs --motion   how much of each scene's frame changes under loop=1: every
 *                                    scene in scenes.json at 1600 by 1000, sampled every 2 s for
 *                                    16 s, as moves, marks (spinning marks only), or still
 *                                    (demo/README.md, Choreography and timelines);
 *                                    --scenes=a,b measures only those
 *
 * Numbers go to stdout as one markdown block for demo/README.md. Nothing here is a test; the
 * `demo` Playwright tier asserts the invariants, this script reports the magnitudes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from './static-server.mjs';
import { HEAP_LAUNCH_ARGS, HOST_VIEWPORT, LOOP_DWELL_MS, SITE_FRAME, STILL_DWELL_MS, bootFrames, measureFramesHeap, readGcHeap } from './heap.mjs';
import { argValue as readArgValue, numberArg, parseBuildEntries } from './measure-args.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const demoDir = path.dirname(fileURLToPath(import.meta.url));

function argValue(name) {
  return readArgValue(process.argv, name);
}

/** The app version a build stamps into its scenes.json, which names it in a report. */
function readBuildVersion(dir) {
  try {
    return `v${JSON.parse(fs.readFileSync(path.join(dir, 'scenes.json'), 'utf8')).version}`;
  } catch {
    return path.basename(dir);
  }
}

/** `--dist=path[,label=path]`: the builds to measure, the default `dist/demo` when none is named. */
const BUILDS = parseBuildEntries(argValue('dist'), path.resolve(demoDir, '..', 'dist', 'demo'), readBuildVersion);
const distDir = BUILDS[0].dir;
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
 * time, so `spawned` stands for every session the sample install did not seed. The workflow
 * agent's session is minted when its pane opens, so its surface is a spawned one that decides
 * (`spawnedDecides`): the pane has no context bar, so the race that keeps a spawned Command
 * Terminal from deciding (below) does not reach it.
 */
const GEOMETRY_SURFACES = [
  { key: 'taskWindow', params: { state: encodeState(defaultTaskWindowState()) }, sessions: ['sess-cw-middleware'] },
  { key: 'taskWindowTiled', params: { view: 'windows-tiled' }, sessions: ['sess-cw-middleware', 'sess-cw-api-client'] },
  { key: 'commandTerminal', params: { state: encodeState(defaultCommandTerminalState()) }, sessions: ['sess-cw-terminal-1'] },
  { key: 'commandTerminalTiled', params: { view: 'command-terminal-tiled' }, sessions: ['sess-cw-terminal-1', 'spawned'] },
  { key: 'workflowAgentPane', params: { view: 'workflow-draft' }, sessions: ['spawned'], spawnedDecides: true },
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
  const context = await browser.newContext({ viewport: HOST_VIEWPORT });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('Performance.enable');
  const frameSet = { scene: 'board', mode: /** @type {const} */ ('still'), count };
  const { readyMs } = await bootFrames(page, server, frameSet);
  const metrics = await client.send('Performance.getMetrics');
  const metric = (name) => metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
  // The heap is read after the same wait a still frame gets in --heap, so the two reports agree.
  await new Promise((resolve) => setTimeout(resolve, STILL_DWELL_MS));
  const { heapMb } = await readGcHeap(page, client);
  await context.close();
  return {
    frames: count,
    allReadyMs: readyMs,
    scriptMs: Math.round(metric('ScriptDuration') * 1000),
    layoutMs: Math.round(metric('LayoutDuration') * 1000),
    taskMs: Math.round(metric('TaskDuration') * 1000),
    jsHeapMb: heapMb,
  };
}

/**
 * The cases kangentic.com budgets: the board as the hero and most figures show it, still and
 * looping, alone and four to a page; the MCP scene a tour slot shows; and a Changes scene, the
 * heaviest docs figure. The two 800 by 500 rows line up with the numbers measured before this
 * harness existed (#848), which laid frames out at that size.
 */
const HEAP_CASES = [
  { scene: 'board', mode: 'still', count: 1 },
  { scene: 'board', mode: 'still', count: 4 },
  { scene: 'board', mode: 'still', count: 1, width: 800, height: 500 },
  { scene: 'board', mode: 'still', count: 4, width: 800, height: 500 },
  { scene: 'board', mode: 'loop', count: 1 },
  { scene: 'board', mode: 'loop', count: 4 },
  { scene: 'task-mcp', mode: 'loop', count: 1 },
  { scene: 'changes', mode: 'loop', count: 1 },
];

function heapCaseLabel(heapCase) {
  const size = heapCase.width ? `, ${heapCase.width}x${heapCase.height}` : '';
  return `${heapCase.scene} ${heapCase.mode} x${heapCase.count}${size}`;
}

function listedScenes(dir) {
  return new Set(JSON.parse(fs.readFileSync(path.join(dir, 'scenes.json'), 'utf8')).scenes.map((scene) => scene.name));
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Every case on every build, `--runs` times, interleaved: run by run, case by case, build by build,
 * so a drift in the machine lands on every build alike. Each read is a fresh browser context, so no
 * frame inherits another's renderer process.
 */
async function measureHeap(builds) {
  const runs = numberArg(process.argv, 'runs', { fallback: 3, min: 1, integer: true });
  const loopDwellMs = numberArg(process.argv, 'dwell', { fallback: null, min: 0 });
  const sceneFilter = argValue('scenes');
  const cases = sceneFilter ? HEAP_CASES.filter((heapCase) => sceneFilter.split(',').includes(heapCase.scene)) : HEAP_CASES;
  const servers = await Promise.all(builds.map((build) => startDemoServer({ distDir: build.dir, port: 0 })));
  const scenesByBuild = builds.map((build) => listedScenes(build.dir));
  /** @type {Map<string, Map<string, Array<{ heapMb: number; usedMb: number; backingMb: number }>>>} */
  const results = new Map(cases.map((heapCase) => [heapCaseLabel(heapCase), new Map()]));
  const browser = await chromium.launch({ headless: true, args: HEAP_LAUNCH_ARGS });
  try {
    for (let run = 1; run <= runs; run++) {
      for (const heapCase of cases) {
        for (const [index, build] of builds.entries()) {
          if (!scenesByBuild[index].has(heapCase.scene)) continue;
          const context = await browser.newContext({ viewport: HOST_VIEWPORT });
          const page = await context.newPage();
          const client = await context.newCDPSession(page);
          try {
            const dwellMs = heapCase.mode === 'loop' && loopDwellMs !== null ? loopDwellMs : undefined;
            const { heapMb, usedMb, backingMb } = await measureFramesHeap(page, client, servers[index], heapCase, { dwellMs });
            const reads = results.get(heapCaseLabel(heapCase));
            reads.set(build.label, [...(reads.get(build.label) ?? []), { heapMb, usedMb, backingMb }]);
            console.error(`run ${run}/${runs}  ${build.label.padEnd(14)} ${heapCaseLabel(heapCase).padEnd(34)} ${heapMb.toFixed(1)} MB (${usedMb.toFixed(1)} heap + ${backingMb.toFixed(1)} buffers)`);
          } catch (error) {
            console.error(`run ${run}/${runs}  ${build.label.padEnd(14)} ${heapCaseLabel(heapCase).padEnd(34)} failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
    await Promise.all(servers.map((server) => server.close()));
  }
  return { cases, results, runs, loopDwellMs: loopDwellMs ?? LOOP_DWELL_MS };
}

function reportHeap(builds, { cases, results, runs, loopDwellMs }) {
  const lines = [];
  lines.push(`### JS heap after a forced GC, MB (median of ${runs}, range, then V8 heap + array buffers)`);
  lines.push('');
  lines.push(`Frames at ${SITE_FRAME.width}x${SITE_FRAME.height} unless named, same-origin on one page; a looping frame is read ${loopDwellMs} ms after ready.`);
  lines.push('');
  lines.push(`| Case | ${builds.map((build) => build.label).join(' | ')} |`);
  lines.push(`|---|${builds.map(() => '---').join('|')}|`);
  for (const heapCase of cases) {
    const reads = results.get(heapCaseLabel(heapCase));
    const cells = builds.map((build) => {
      const values = reads.get(build.label);
      if (!values || values.length === 0) return 'n/a';
      const totals = values.map((value) => value.heapMb);
      const parts = `${median(values.map((value) => value.usedMb)).toFixed(1)} + ${median(values.map((value) => value.backingMb)).toFixed(1)}`;
      return `${median(totals).toFixed(1)} (${Math.min(...totals).toFixed(1)} to ${Math.max(...totals).toFixed(1)}) = ${parts}`;
    });
    lines.push(`| ${heapCaseLabel(heapCase)} | ${cells.join(' | ')} |`);
  }
  console.log(lines.join('\n'));
}

/** Streams a heap snapshot over CDP into one string. */
async function takeHeapSnapshot(client) {
  const chunks = [];
  const onChunk = (event) => chunks.push(event.chunk);
  client.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await client.send('HeapProfiler.enable');
  await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  client.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  return chunks.join('');
}

/** Node types whose name is a value rather than a kind, so each is one group. */
const VALUE_NAMED_TYPES = new Set(['string', 'concatenated string', 'sliced string', 'number', 'bigint', 'regexp']);
const STRING_TYPES = new Set(['string', 'concatenated string', 'sliced string']);

/**
 * Self size by node type, and by type and name (an object's constructor, a closure's function, a
 * code object's kind), plus the largest strings. Self size, not retained: it says where the bytes
 * sit, and a candidate it names is confirmed by taking it out and reading the heap again.
 */
function summarizeHeapSnapshot(json) {
  const snapshot = JSON.parse(json);
  const fields = snapshot.snapshot.meta.node_fields;
  const typeNames = snapshot.snapshot.meta.node_types[0];
  const width = fields.length;
  const typeOffset = fields.indexOf('type');
  const nameOffset = fields.indexOf('name');
  const sizeOffset = fields.indexOf('self_size');
  const byType = new Map();
  const byGroup = new Map();
  const strings = [];
  for (let offset = 0; offset < snapshot.nodes.length; offset += width) {
    const type = typeNames[snapshot.nodes[offset + typeOffset]];
    const name = snapshot.strings[snapshot.nodes[offset + nameOffset]];
    const size = snapshot.nodes[offset + sizeOffset];
    byType.set(type, (byType.get(type) ?? 0) + size);
    const group = VALUE_NAMED_TYPES.has(type) ? type : `${type}: ${name.slice(0, 60)}`;
    const entry = byGroup.get(group) ?? { size: 0, count: 0 };
    entry.size += size;
    entry.count += 1;
    byGroup.set(group, entry);
    if (STRING_TYPES.has(type)) strings.push({ size, text: name.slice(0, 80).replace(/\s+/g, ' ') });
  }
  strings.sort((first, second) => second.size - first.size);
  return { byType, byGroup, strings: strings.slice(0, 15) };
}

function mbOf(bytes) {
  return (bytes / 1048576).toFixed(2);
}

async function heapSnapshots(builds) {
  const [scene, modeArgument] = argValue('heap-snapshot').split(',');
  const mode = modeArgument === 'loop' ? 'loop' : 'still';
  const outDir = path.resolve(argValue('out') ?? path.join(os.tmpdir(), 'kangentic-heap-snapshots'));
  fs.mkdirSync(outDir, { recursive: true });
  const summaries = [];
  const browser = await chromium.launch({ headless: true, args: HEAP_LAUNCH_ARGS });
  try {
    for (const [index, build] of builds.entries()) {
      const server = await startDemoServer({ distDir: build.dir, port: 0 });
      const context = await browser.newContext({ viewport: HOST_VIEWPORT });
      try {
        const page = await context.newPage();
        const client = await context.newCDPSession(page);
        const { heapMb, usedMb, backingMb } = await measureFramesHeap(page, client, server, { scene, mode, count: 1 });
        const json = await takeHeapSnapshot(client);
        // The position leads the name: two labels can sanitize to one, and the second would overwrite.
        const file = path.join(outDir, `${index + 1}-${build.label.replace(/[^\w.-]+/g, '_')}-${scene}-${mode}.heapsnapshot`);
        fs.writeFileSync(file, json);
        console.error(`${build.label}: ${heapMb.toFixed(1)} MB after GC (${usedMb.toFixed(1)} heap + ${backingMb.toFixed(1)} buffers), snapshot ${file}`);
        summaries.push({ build, heapMb, ...summarizeHeapSnapshot(json) });
      } finally {
        await context.close();
        await server.close();
      }
    }
  } finally {
    await browser.close();
  }
  const lines = [];
  lines.push(`### Heap snapshot of one ${scene} frame (${mode}), self size in MB`);
  lines.push('');
  lines.push(`| Node type | ${summaries.map((summary) => `${summary.build.label} (${summary.heapMb.toFixed(1)} MB used)`).join(' | ')} |`);
  lines.push(`|---|${summaries.map(() => '---').join('|')}|`);
  const types = [...new Set(summaries.flatMap((summary) => [...summary.byType.keys()]))]
    .sort((first, second) => (summaries[0].byType.get(second) ?? 0) - (summaries[0].byType.get(first) ?? 0));
  for (const type of types) lines.push(`| ${type} | ${summaries.map((summary) => mbOf(summary.byType.get(type) ?? 0)).join(' | ')} |`);
  lines.push('');
  // With two builds, the groups that moved most between the first and the last; with one, the largest.
  const first = summaries[0];
  const last = summaries[summaries.length - 1];
  const groups = [...new Set(summaries.flatMap((summary) => [...summary.byGroup.keys()]))];
  const weight = (group) => (summaries.length > 1
    ? Math.abs((last.byGroup.get(group)?.size ?? 0) - (first.byGroup.get(group)?.size ?? 0))
    : first.byGroup.get(group)?.size ?? 0);
  groups.sort((one, other) => weight(other) - weight(one));
  lines.push(`| Type: name (${summaries.length > 1 ? 'largest change' : 'largest'}) | ${summaries.map((summary) => `${summary.build.label} MB (count)`).join(' | ')} |`);
  lines.push(`|---|${summaries.map(() => '---').join('|')}|`);
  for (const group of groups.slice(0, 30)) {
    lines.push(`| ${group.replace(/\|/g, '/')} | ${summaries.map((summary) => {
      const entry = summary.byGroup.get(group);
      return entry ? `${mbOf(entry.size)} (${entry.count})` : '0';
    }).join(' | ')} |`);
  }
  for (const summary of summaries) {
    lines.push('');
    lines.push(`Largest strings, ${summary.build.label}:`);
    for (const entry of summary.strings) lines.push(`- ${mbOf(entry.size)} MB \`${entry.text.replace(/`/g, "'")}\``);
  }
  console.log(lines.join('\n'));
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
      if (sessionId === 'spawned' && !surface.spawnedDecides) continue;
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

/**
 * The motion audit's sampling: a shot every 2 s for 16 s after ready, each compared with the
 * first, so a choreography whose cycle starts after its opening rest is caught. A pixel counts as
 * changed when any channel moves by more than 24, on the frame scaled to 800 by 500.
 */
const MOTION_SAMPLE_MS = 2000;
const MOTION_SAMPLES = 8;
const MOTION_SETTLE_MS = 1500;
const MOTION_CONCURRENCY = 3;
const MOTION_CHANNEL_DELTA = 24;
/**
 * Calibrated on the v0.46.0 audit and this sampling: a scene with a terminal replaying changes 2
 * to 15 percent of the frame in 16 s, one with only spinning marks 0.08 to 0.3 percent, and a
 * dialog whose one change is a text field's blinking caret about 0.03 percent, which the audit
 * counted as still.
 */
const MOTION_VERDICTS = [{ verdict: 'moves', minPercent: 0.5 }, { verdict: 'marks', minPercent: 0.05 }];

/** The share of pixels that changed between two PNG shots, decoded and compared in a page's canvas. */
function framePercentChanged(differ, firstPng, secondPng) {
  return differ.evaluate(async ({ first, second, channelDelta }) => {
    const decode = async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(800, 500);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0, 800, 500);
      return context.getImageData(0, 0, 800, 500).data;
    };
    const firstPixels = await decode(first);
    const secondPixels = await decode(second);
    let changed = 0;
    for (let index = 0; index < firstPixels.length; index += 4) {
      const delta = Math.max(
        Math.abs(firstPixels[index] - secondPixels[index]),
        Math.abs(firstPixels[index + 1] - secondPixels[index + 1]),
        Math.abs(firstPixels[index + 2] - secondPixels[index + 2]),
      );
      if (delta > channelDelta) changed += 1;
    }
    return (100 * changed) / (800 * 500);
  }, { first: firstPng.toString('base64'), second: secondPng.toString('base64'), channelDelta: MOTION_CHANNEL_DELTA });
}

async function measureMotionOf(browser, differ, server, sceneName) {
  const context = await browser.newContext({ viewport: FRAME_VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.goto(`${server.url}?view=${encodeURIComponent(sceneName)}&theme=rust&embed=1&loop=1&stage=0`);
    await page.waitForSelector('html[data-demo-ready="1"]', { timeout: 45_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(MOTION_SETTLE_MS);
    const infinite = await page.evaluate(() => document.getAnimations()
      .filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations === Infinity).length);
    const first = await page.screenshot({ type: 'png' });
    let peak = 0;
    for (let sample = 0; sample < MOTION_SAMPLES; sample++) {
      await page.waitForTimeout(MOTION_SAMPLE_MS);
      peak = Math.max(peak, await framePercentChanged(differ, first, await page.screenshot({ type: 'png' })));
    }
    const verdict = MOTION_VERDICTS.find((band) => peak >= band.minPercent)?.verdict ?? 'still';
    return { scene: sceneName, verdict, peak, infinite, choreography: await page.evaluate(() => document.documentElement.getAttribute('data-demo-choreography')) };
  } catch (error) {
    return { scene: sceneName, verdict: 'error', peak: 0, infinite: 0, choreography: null, error: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  } finally {
    await context.close();
  }
}

async function measureMotion(server) {
  const listed = JSON.parse(fs.readFileSync(path.join(distDir, 'scenes.json'), 'utf8')).scenes;
  const filter = process.argv.find((argument) => argument.startsWith('--scenes='));
  const wanted = filter ? new Set(filter.slice('--scenes='.length).split(',')) : null;
  const scenes = wanted ? listed.filter((scene) => wanted.has(scene.name)) : listed;
  if (wanted && scenes.length !== wanted.size) {
    throw new Error(`--scenes names a scene the build does not list: ${[...wanted].filter((name) => !listed.some((scene) => scene.name === name)).join(', ')}`);
  }
  const browser = await chromium.launch({ headless: true });
  const differ = await (await browser.newContext()).newPage();
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < scenes.length) {
      const result = await measureMotionOf(browser, differ, server, scenes[next++].name);
      results.push(result);
      console.error(`${result.scene.padEnd(36)} ${result.verdict.padEnd(6)} ${result.peak.toFixed(3)}%${result.error ? ` ${result.error}` : ''}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: MOTION_CONCURRENCY }, worker));
  } finally {
    await browser.close();
  }
  return results.sort((first, second) => second.peak - first.peak);
}

function reportMotion(results) {
  const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
  const lines = [];
  lines.push(`### Motion under loop=1, ${results.length} scenes, headless Chromium`);
  lines.push('');
  lines.push(`${count('moves')} move, ${count('marks')} show only spinning marks, ${count('still')} are still${count('error') ? `, ${count('error')} failed to boot` : ''}.`);
  lines.push('');
  lines.push('| Scene | Verdict | Most of the frame changed in 16 s | Infinite animations | Choreography |');
  lines.push('|---|---|---|---|---|');
  for (const result of results) {
    lines.push(`| ${result.scene} | ${result.verdict} | ${result.peak.toFixed(3)}% | ${result.infinite} | ${result.choreography ?? ''} |`);
  }
  console.log(lines.join('\n'));
}

async function main() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`No web build at ${distDir}. Run "npm run build:demo" first.`);
  }
  if (process.argv.includes('--heap')) {
    reportHeap(BUILDS, await measureHeap(BUILDS));
    return;
  }
  if (argValue('heap-snapshot') !== null) {
    await heapSnapshots(BUILDS);
    return;
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
  if (process.argv.includes('--motion')) {
    let results;
    try {
      results = await measureMotion(server);
    } finally {
      await server.close();
    }
    reportMotion(results);
    return;
  }

  const eager = eagerAssets();
  const eagerGzip = eager.reduce((sum, asset) => sum + asset.gzip, 0);
  const everything = fs.readdirSync(path.join(distDir, 'assets')).map((name) => path.join(distDir, 'assets', name));
  const totalRaw = everything.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);

  const browser = await chromium.launch({ headless: true, args: HEAP_LAUNCH_ARGS });
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
  lines.push(`### Frames per page (board scene, still, ${SITE_FRAME.width}x${SITE_FRAME.height} frames)`);
  lines.push('');
  lines.push('| Frames | All ready | Script time | Layout time | Task time | JS heap after GC |');
  lines.push('|---|---|---|---|---|---|');
  for (const frame of frames) {
    lines.push(`| ${frame.frames} | ${frame.allReadyMs} ms | ${frame.scriptMs} ms | ${frame.layoutMs} ms | ${frame.taskMs} ms | ${frame.jsHeapMb.toFixed(1)} MB |`);
  }
  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
