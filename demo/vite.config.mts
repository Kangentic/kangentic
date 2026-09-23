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
 * One plugin injects five classic scripts ahead of the module bundle (demo/index.html documents
 * the order), emits them, the recordings, and the guest pages under content-hashed names, plus
 * the unhashed scenes.json, and relocates the emitted HTML from `demo/index.html` to the outDir
 * root.
 *
 * `base` defaults to `/demo/`; the GitHub Pages deploy passes `--base=/kangentic/` on the CLI.
 */
import { defineConfig, normalizePath, type ConfigEnv, type Plugin, type PluginOption, type UserConfig } from 'vite';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDemoPreConfig, DEMO_PROJECTS } from '../tests/captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoChanges, loadDemoEnds, loadDemoHistory, loadDemoMessageTrails, loadDemoOpenFrames, loadDemoPeeks, loadDemoPeekTimelines, loadDemoRecordings, loadDemoScrollback, loadDemoTiledFrames, loadDemoTranscripts, readLiveTailMs, type DemoRecordingEntry } from '../tests/captures/helpers/demo-scrollback';
// The cap main keeps per session, so a replayed trail slices exactly as a pushed one does.
import { MESSAGE_TRAIL_MAX_ENTRIES } from '../src/main/agent/message-trail-tracker';
import { SCENES } from '../tests/captures/scenes';
import { DEFAULT_CONFIG } from '../src/shared/types';

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
const WEBVIEW_SHIM_PATH = path.join(demoDir, 'webview-shim.js');


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
 * timed stream, the serialized final frame, its last lines, its grid, and how the capture ended),
 * then the four classic scripts in the order they must execute. The recording's frame timeline
 * stays in the fixture and is not shipped: a terminal on any other grid plays the stream through
 * the page's own emulator (demo/replay-emulator.ts), and the timeline was a third to half of
 * every file. The seed embeds only each
 * session's final frame (a still and a first paint need nothing more); the streams are fetched
 * when a terminal mounts.
 */
function planDemoAssets(version: string, base: string): { scripts: string[]; files: PlannedAsset[] } {
  const recordings = loadDemoRecordings();
  const files: PlannedAsset[] = [];
  // Each index entry carries the grid its recording was made at beside the file name, so the
  // seed can decide at a terminal's first resize, before any fetch, whether to hold the terminal
  // at that grid (demo-dataset.ts, the sessions.resize wrapper).
  interface IndexEntry { file: string; cols: number; rows: number; tiled?: IndexEntry }
  const emitRecording = (entry: DemoRecordingEntry): IndexEntry => {
    const source = JSON.stringify({ serialized: entry.serialized, stream: entry.stream, peek: entry.peek, cols: entry.cols, rows: entry.rows, stopReason: entry.stopReason });
    const fileName = hashedName(`recordings/${entry.file}`, source);
    files.push({ fileName, source });
    return { file: fileName.slice('recordings/'.length), cols: entry.cols, rows: entry.rows };
  };
  // A session's tiled sibling rides on its index entry, so the seed can pair the two layouts the
  // way it pairs a Command Terminal's two boots (demo-dataset.ts, layoutFor).
  const indexEntryOf = (entry: DemoRecordingEntry): IndexEntry => {
    const indexed = emitRecording(entry);
    return entry.tiled ? { ...indexed, tiled: emitRecording(entry.tiled) } : indexed;
  };
  // The agent transcripts the conversation viewer shows, one file per session the manifest
  // marks, under their own directory: a still frame fetches no recording, and a transcript is
  // fetched only when a viewer opens.
  const transcripts: Record<string, { file: string }> = {};
  for (const [sessionId, entries] of Object.entries(loadDemoTranscripts())) {
    const source = JSON.stringify({ entries });
    const fileName = hashedName(`transcripts/${sessionId}.json`, source);
    files.push({ fileName, source });
    transcripts[sessionId] = { file: fileName.slice('transcripts/'.length) };
  }
  const index = {
    base: `${base}recordings/`,
    sessions: Object.fromEntries(Object.entries(recordings.sessions).map(([id, entry]) => [id, indexEntryOf(entry)])),
    spawns: Object.fromEntries(Object.entries(recordings.spawns).map(([key, entry]) => [key, indexEntryOf(entry)])),
    terminals: Object.fromEntries(Object.entries(recordings.terminals).map(([id, entry]) => [id, indexEntryOf(entry)])),
    geometry: recordings.geometry,
    transcriptsBase: `${base}transcripts/`,
    transcripts,
  };
  const tiledCount = Object.values(index.sessions).filter((entry) => entry.tiled).length;
  console.log(`[demo] recordings emitted: ${Object.keys(index.sessions).length} sessions (${tiledCount} with a tiled sibling), ${Object.keys(index.spawns).length} spawn boots, ${Object.keys(index.terminals).length} terminal boots, ${Object.keys(transcripts).length} transcripts`);
  // The guest pages: what each project's dev URL shows, for the Browser pane's iframe
  // stand-in (demo/webview-shim.js). Keyed by the URL the pane shows, valued by the hashed file.
  const guestPages: Record<string, string> = {};
  for (const project of DEMO_PROJECTS) {
    if (!project.dev_url || !project.guest_page) continue;
    const source = readFileSync(path.join(demoDir, 'guest', project.guest_page), 'utf8');
    const fileName = hashedName(`guest/${project.guest_page}`, source);
    files.push({ fileName, source });
    guestPages[project.dev_url] = `${base}${fileName}`;
  }
  console.log(`[demo] guest pages emitted: ${Object.keys(guestPages).length}`);
  const scripts = [
    { name: 'demo-scenes.js', source: buildScenesScript(version, `window.__demoRecordings = ${JSON.stringify(index)};\nwindow.__demoGuestPages = ${JSON.stringify(guestPages)};\n`) },
    { name: 'demo-boot.js', source: readFileSync(BOOT_SCRIPT_PATH, 'utf8') },
    { name: 'demo-webview.js', source: readFileSync(WEBVIEW_SHIM_PATH, 'utf8') },
    { name: 'mock-electron-api.js', source: readFileSync(MOCK_SCRIPT_PATH, 'utf8') },
    { name: 'demo-seed.js', source: buildSeedScript(version) },
  ].map((script) => ({ fileName: hashedName(script.name, script.source), source: script.source }));
  files.push(...scripts);
  return { scripts: scripts.map((script) => script.fileName), files };
}

/**
 * The field names each POPULATED nested block of `AppConfig` carries, so `demo/boot.js` can refuse
 * a `state=` blob that names only some of them.
 *
 * A config override is merged with a shallow `Object.assign`, twice (boot.js into
 * `__mockConfigOverrides`, then the mock into its own defaults), so a nested block REPLACES the
 * default rather than merging into it. Naming one field of `monitor` therefore leaves the other
 * six undefined, on settings nothing in the frame shows. The scene registry's own test catches
 * that for `SCENES`; a hand-written `state=` URL has no such check, and that is the audience the
 * README points at this escape hatch. Emitted rather than restated in boot.js, which is a classic
 * script and cannot import the type.
 *
 * Empty and non-object defaults are skipped: they have no shape to match, and a map keyed by
 * project id (`workspaceByProject`) is meant to carry only the entries a scene names.
 */
function nestedConfigShape(): Record<string, string[]> {
  const shape: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(DEFAULT_CONFIG as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const fields = Object.keys(value);
    if (fields.length === 0) continue;
    shape[key] = fields;
  }
  return shape;
}

function buildScenesScript(version: string, recordingsScript: string): string {
  return `window.__demoScenes = ${JSON.stringify(SCENES)};\nwindow.__demoVersion = ${JSON.stringify(version)};\nwindow.__demoConfigShape = ${JSON.stringify(nestedConfigShape())};\n${recordingsScript}`;
}

/** The frame every scene is authored at: the site's 1600 by 1000 (demo/stage.html). */
const SCENE_FRAME = { width: 1600, height: 1000 };

/**
 * The hand-off to the site: which scenes this deployment serves, what each shows (the alt text a
 * docs figure carries), which a page may embed (`reach`, so a rig-only scene is refused by name
 * rather than rendering the error card inside a captioned figure), and which app version they
 * belong to. Emitted UNHASHED beside index.html so the site's build can fetch it by a stable URL;
 * generated from the same SCENES the page boots, so the two cannot drift. No timestamp: the build
 * stays reproducible, and the version is the only freshness that matters.
 */
function buildScenesManifest(version: string): string {
  const scenes = Object.values(SCENES).map((scene) => ({
    name: scene.name,
    reach: scene.reach,
    alt: scene.alt,
    description: scene.description,
  }));
  return `${JSON.stringify({ version, frame: SCENE_FRAME, scenes }, null, 2)}\n`;
}

function buildSeedScript(version: string): string {
  const scrollback = loadDemoScrollback();
  const changes = loadDemoChanges();
  const peeks = loadDemoPeeks();
  const ends = loadDemoEnds();
  const openFrames = loadDemoOpenFrames();
  const tiledFrames = loadDemoTiledFrames();
  const messageTrails = loadDemoMessageTrails();
  console.log(`[demo] recorded terminal sessions embedded: ${Object.keys(scrollback).length}, with a working-tree diff: ${Object.keys(changes).length}, with an open frame: ${Object.keys(openFrames).length}, with tiled frames: ${Object.keys(tiledFrames).length}, with an agent message trail: ${Object.keys(messageTrails).length}`);
  return [
    '// Generated by demo/vite.config.mts from tests/captures/helpers/demo-dataset.ts and the',
    '// recordings in tests/captures/fixtures/demo/.',
    'window.__demoApplyFixture = function () {',
    buildDemoPreConfig({
      scrollback, changes, peeks, ends, openFrames, tiledFrames,
      peekTimelines: loadDemoPeekTimelines(),
      messageTrails,
      messageTrailMaxEntries: MESSAGE_TRAIL_MAX_ENTRIES,
      liveTailMs: readLiveTailMs(),
      appVersion: version,
      cellWidths: buildCellWidthTable(),
      history: loadDemoHistory(),
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
        // The scene list the site reads at build time; unhashed, like the two entry pages.
        this.emitFile({ type: 'asset', fileName: 'scenes.json', source: buildScenesManifest(version) });
        console.log(`[demo] scenes.json emitted: ${Object.keys(SCENES).length} scenes`);

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
