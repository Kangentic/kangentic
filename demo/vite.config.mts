/**
 * The web build of the desktop renderer: `npm run build:demo`.
 *
 * A SECOND Vite invocation, never a second entry in the shared config: scripts/build.js's
 * assertVendorChunksLazy walks every entry chunk of the Electron build, and electron-builder
 * ships `.vite/build/**`, so this build lives in `dist/demo/` and reuses the base config as a
 * factory. Production semantics are forced whatever the CLI mode: `__KANGENTIC_DEV__` folds to
 * false (no dev badge, no DevtoolsBootstrap), the Sentry sourcemap plugins are dropped by name,
 * and sourcemaps are off.
 *
 * One plugin injects four classic scripts ahead of the module bundle (demo/index.html documents
 * the order), emits them and the recordings under content-hashed names, and relocates the
 * emitted HTML from `demo/index.html` to the outDir root.
 *
 * `base` defaults to `/demo/`; the GitHub Pages deploy passes `--base=/kangentic/` on the CLI.
 */
import { defineConfig, normalizePath, type ConfigEnv, type Plugin, type PluginOption, type UserConfig } from 'vite';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDemoPreConfig } from '../tests/captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoChanges, loadDemoEnds, loadDemoMessageTrails, loadDemoOpenFrames, loadDemoPeeks, loadDemoPeekTimelines, loadDemoRecordings, loadDemoScrollback, readLiveTailMs, type DemoRecordingEntry } from '../tests/captures/helpers/demo-scrollback';
// The cap main keeps per session, so a replayed trail slices exactly as a pushed one does.
import { MESSAGE_TRAIL_MAX_ENTRIES } from '../src/main/agent/message-trail-tracker';
import { SCENES } from '../tests/captures/scenes';

// Vite keeps an ambient NODE_ENV, and "development" from a shell or IDE ships React's development
// build plus every `import.meta.env.DEV` branch while the build still exits 0 (measured: the
// react-vendor chunk doubled to 383 KB). scripts/build-demo.js pins the value; a direct
// invocation from such a shell is refused rather than quietly shipping a dev bundle.
if (process.env.NODE_ENV !== 'production') {
  throw new Error(
    `[demo] Refusing to build: NODE_ENV is ${JSON.stringify(process.env.NODE_ENV)} rather than "production", `
    + 'so the bundle would carry development branches. Run "npm run build:demo" (scripts/build-demo.js pins it).',
  );
}

// The config bundler inlines ../vite.config.mts, whose module scope reads these. Cleared here
// as belt and braces; the plugin-name filter below is the load-bearing exclusion.
delete process.env.KANGENTIC_SENTRY_TOKEN;
delete process.env.SENTRY_AUTH_TOKEN;

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoDir, '..');
const DEMO_BASE = '/demo/';
const DEMO_HTML_INPUT = path.join(demoDir, 'index.html');
const MOCK_SCRIPT_PATH = path.join(repoRoot, 'tests', 'ui', 'mock-electron-api.js');
const BOOT_SCRIPT_PATH = path.join(demoDir, 'boot.js');


function readAppVersion(): string {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string' || packageJson.version === '') {
    throw new Error('[demo] package.json has no usable "version"; the web build stamps it into the frame.');
  }
  return packageJson.version;
}

async function flattenPlugins(option: PluginOption): Promise<Plugin[]> {
  const resolved = await option;
  if (!resolved) return [];
  if (Array.isArray(resolved)) {
    const nested = await Promise.all(resolved.map((entry) => flattenPlugins(entry)));
    return nested.flat();
  }
  return [resolved];
}

interface PlannedAsset { fileName: string; source: string }

/**
 * A content hash in the file name, as Vite gives its own chunks. GitHub Pages caches every file
 * for ten minutes, and a visitor mid-session across a release must never pair a new seed with an
 * old recording: a recording replays only into the grid its seed describes, and a stale one
 * lands two frames' text on one row. index.html and stage.html stay unhashed, as entry points.
 */
function hashedName(name: string, source: string): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? `${name}-${hash}` : `${name.slice(0, dot)}-${hash}${name.slice(dot)}`;
}

/**
 * Everything the page fetches besides Vite's bundle, planned once so the HTML tags and the
 * emitted files agree on the hashed names: one JSON file per recording under `recordings/` (the
 * timed stream, the serialized final frame, its last lines, its grid, how the capture ended, and
 * the frame timeline a terminal on any other grid plays instead of the bytes),
 * then the four classic scripts in the order they must execute. The seed embeds only each
 * session's final frame (a still and a first paint need nothing more); the streams are fetched
 * when a terminal mounts.
 */
function planDemoAssets(version: string, base: string): { scripts: string[]; files: PlannedAsset[] } {
  const recordings = loadDemoRecordings();
  const files: PlannedAsset[] = [];
  // Each index entry carries the grid its recording was made at beside the file name, so the
  // seed can decide at a terminal's first resize, before any fetch, whether to hold the terminal
  // at that grid (demo-dataset.ts, the sessions.resize wrapper).
  const indexEntryOf = (entry: DemoRecordingEntry): { file: string; cols: number; rows: number } => {
    const source = JSON.stringify({ serialized: entry.serialized, stream: entry.stream, peek: entry.peek, cols: entry.cols, rows: entry.rows, stopReason: entry.stopReason, frameTimeline: entry.frameTimeline });
    const fileName = hashedName(`recordings/${entry.file}`, source);
    files.push({ fileName, source });
    return { file: fileName.slice('recordings/'.length), cols: entry.cols, rows: entry.rows };
  };
  const index = {
    base: `${base}recordings/`,
    sessions: Object.fromEntries(Object.entries(recordings.sessions).map(([id, entry]) => [id, indexEntryOf(entry)])),
    spawns: Object.fromEntries(Object.entries(recordings.spawns).map(([key, entry]) => [key, indexEntryOf(entry)])),
    terminals: Object.fromEntries(Object.entries(recordings.terminals).map(([id, entry]) => [id, indexEntryOf(entry)])),
    geometry: recordings.geometry,
  };
  console.log(`[demo] recordings emitted: ${Object.keys(index.sessions).length} sessions, ${Object.keys(index.spawns).length} spawn boots, ${Object.keys(index.terminals).length} terminal boots`);
  const scripts = [
    { name: 'demo-scenes.js', source: buildScenesScript(version, `window.__demoRecordings = ${JSON.stringify(index)};\n`) },
    { name: 'demo-boot.js', source: readFileSync(BOOT_SCRIPT_PATH, 'utf8') },
    { name: 'mock-electron-api.js', source: readFileSync(MOCK_SCRIPT_PATH, 'utf8') },
    { name: 'demo-seed.js', source: buildSeedScript(version) },
  ].map((script) => ({ fileName: hashedName(script.name, script.source), source: script.source }));
  files.push(...scripts);
  return { scripts: scripts.map((script) => script.fileName), files };
}

function buildScenesScript(version: string, recordingsScript: string): string {
  return `window.__demoScenes = ${JSON.stringify(SCENES)};\nwindow.__demoVersion = ${JSON.stringify(version)};\n${recordingsScript}`;
}

function buildSeedScript(version: string): string {
  const scrollback = loadDemoScrollback();
  const changes = loadDemoChanges();
  const peeks = loadDemoPeeks();
  const ends = loadDemoEnds();
  const openFrames = loadDemoOpenFrames();
  const messageTrails = loadDemoMessageTrails();
  console.log(`[demo] recorded terminal sessions embedded: ${Object.keys(scrollback).length}, with a working-tree diff: ${Object.keys(changes).length}, with an open frame: ${Object.keys(openFrames).length}, with an agent message trail: ${Object.keys(messageTrails).length}`);
  return [
    '// Generated by demo/vite.config.mts from tests/captures/helpers/demo-dataset.ts and the',
    '// recordings in tests/captures/fixtures/demo/.',
    'window.__demoApplyFixture = function () {',
    buildDemoPreConfig({
      scrollback, changes, peeks, ends, openFrames,
      peekTimelines: loadDemoPeekTimelines(),
      messageTrails,
      messageTrailMaxEntries: MESSAGE_TRAIL_MAX_ENTRIES,
      liveTailMs: readLiveTailMs(),
      appVersion: version,
      cellWidths: buildCellWidthTable(),
    }),
    '};',
    'window.__demoBoot.afterSeed();',
    '',
  ].join('\n');
}

function demoStaticSitePlugin(version: string): Plugin {
  let resolvedBase = DEMO_BASE;
  let emittedHtmlName = 'demo/index.html';
  let planned: ReturnType<typeof planDemoAssets> | null = null;
  const plan = (): ReturnType<typeof planDemoAssets> => planned ?? (planned = planDemoAssets(version, resolvedBase));
  return {
    name: 'kangentic:demo-static-site',
    enforce: 'post',
    configResolved(config) {
      resolvedBase = config.base;
      emittedHtmlName = normalizePath(path.relative(config.root, DEMO_HTML_INPUT));
    },
    transformIndexHtml: {
      order: 'pre',
      handler: () => plan().scripts.map((name) => ({
        tag: 'script',
        // Explicit: the default is head-prepend, ahead of <meta charset>.
        injectTo: 'head' as const,
        attrs: { src: `${resolvedBase}${name}`, 'vite-ignore': true },
      })),
    },
    generateBundle: {
      order: 'post',
      handler(_outputOptions, bundle) {
        for (const file of plan().files) this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source });
        // The host the page hands over to when opened directly (demo/stage.html): the frame at
        // the site's 1600 by 1000, scaled to the window, so the recordings always fit.
        this.emitFile({ type: 'asset', fileName: 'stage.html', source: readFileSync(path.join(demoDir, 'stage.html'), 'utf8') });

        const html = bundle[emittedHtmlName];
        if (html === undefined || html.type !== 'asset') {
          const htmlNames = Object.keys(bundle).filter((key) => key.endsWith('.html'));
          throw new Error(`[demo] vite:build-html did not emit "${emittedHtmlName}" (html files in the bundle: ${htmlNames.join(', ') || 'none'})`);
        }
        delete bundle[emittedHtmlName];
        this.emitFile({ type: 'asset', fileName: 'index.html', originalFileName: DEMO_HTML_INPUT, source: html.source });
      },
    },
  };
}

export default defineConfig(async ({ mode }: ConfigEnv): Promise<UserConfig> => {
  const baseConfigFactory = (await import('../vite.config.mts')).default;
  const baseConfig = baseConfigFactory({ mode: 'production', command: 'build', isSsrBuild: false, isPreview: false });
  const basePlugins = await flattenPlugins(baseConfig.plugins ?? []);
  const keptPlugins = basePlugins.filter((plugin) => !plugin.name.startsWith('sentry-'));
  const droppedCount = basePlugins.length - keptPlugins.length;
  console.log(`[demo] mode ${mode}: production semantics forced; Sentry plugins dropped: ${droppedCount}`);
  const version = readAppVersion();
  console.log(`[demo] app version stamped into the frame: ${version}`);

  return {
    ...baseConfig,
    mode: 'production',
    base: DEMO_BASE,
    define: { ...baseConfig.define, __KANGENTIC_DEV__: 'false' },
    plugins: [...keptPlugins, demoStaticSitePlugin(version)],
    build: {
      ...baseConfig.build,
      sourcemap: false,
      outDir: 'dist/demo',
      emptyOutDir: true,
      rolldownOptions: { ...baseConfig.build?.rolldownOptions, input: DEMO_HTML_INPUT },
    },
  };
});
