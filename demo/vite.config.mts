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
 * the order) and relocates the emitted HTML from `demo/index.html` to the outDir root.
 *
 * `base` defaults to `/demo/`; the GitHub Pages deploy passes `--base=/kangentic/` on the CLI.
 */
import { defineConfig, normalizePath, type ConfigEnv, type Plugin, type PluginOption, type UserConfig } from 'vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDemoPreConfig } from '../tests/captures/helpers/demo-dataset';
import { loadDemoChanges, loadDemoPeeks, loadDemoRecordings, loadDemoScrollback } from '../tests/captures/helpers/demo-scrollback';
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

/** The four classic scripts, in the order they must execute. */
const CLASSIC_SCRIPTS = ['demo-scenes.js', 'demo-boot.js', 'mock-electron-api.js', 'demo-seed.js'] as const;

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

/**
 * The recordings index the live frame fetches from: one JSON file per recording under
 * `recordings/`, holding the timed stream and the serialized final frame. The seed embeds only
 * each session's final frame (a still and a first paint need nothing more); the stream that
 * replays a session as it happened, the agent boots a drag starts, and the Command Terminal
 * boots are fetched when a terminal mounts.
 */
function buildRecordingsIndex(base: string): { script: string; files: Array<{ fileName: string; source: string }> } {
  const recordings = loadDemoRecordings();
  const files: Array<{ fileName: string; source: string }> = [];
  const nameOf = (entry: { file: string; serialized: string; stream: Array<{ t: number; data: string }>; peek: string[]; cols: number; rows: number }): string => {
    files.push({ fileName: `recordings/${entry.file}`, source: JSON.stringify({ serialized: entry.serialized, stream: entry.stream, peek: entry.peek, cols: entry.cols, rows: entry.rows }) });
    return entry.file;
  };
  const index = {
    base: `${base}recordings/`,
    sessions: Object.fromEntries(Object.entries(recordings.sessions).map(([id, entry]) => [id, nameOf(entry)])),
    spawns: Object.fromEntries(Object.entries(recordings.spawns).map(([key, entry]) => [key, nameOf(entry)])),
    terminals: Object.fromEntries(Object.entries(recordings.terminals).map(([id, entry]) => [id, nameOf(entry)])),
    geometry: recordings.geometry,
  };
  console.log(`[demo] recordings emitted: ${Object.keys(index.sessions).length} sessions, ${Object.keys(index.spawns).length} spawn boots, ${Object.keys(index.terminals).length} terminal boots`);
  return { script: `window.__demoRecordings = ${JSON.stringify(index)};\n`, files };
}

function buildScenesScript(version: string, recordingsScript: string): string {
  return `window.__demoScenes = ${JSON.stringify(SCENES)};\nwindow.__demoVersion = ${JSON.stringify(version)};\n${recordingsScript}`;
}

function buildSeedScript(version: string): string {
  const scrollback = loadDemoScrollback();
  const changes = loadDemoChanges();
  const peeks = loadDemoPeeks();
  console.log(`[demo] recorded terminal sessions embedded: ${Object.keys(scrollback).length}, with a working-tree diff: ${Object.keys(changes).length}`);
  return [
    '// Generated by demo/vite.config.mts from tests/captures/helpers/demo-dataset.ts and the',
    '// recordings in tests/captures/fixtures/demo/.',
    'window.__demoApplyFixture = function () {',
    buildDemoPreConfig({ scrollback, changes, peeks, appVersion: version }),
    '};',
    'window.__demoBoot.afterSeed();',
    '',
  ].join('\n');
}

function demoStaticSitePlugin(version: string): Plugin {
  let resolvedBase = DEMO_BASE;
  let emittedHtmlName = 'demo/index.html';
  return {
    name: 'kangentic:demo-static-site',
    enforce: 'post',
    configResolved(config) {
      resolvedBase = config.base;
      emittedHtmlName = normalizePath(path.relative(config.root, DEMO_HTML_INPUT));
    },
    transformIndexHtml: {
      order: 'pre',
      handler: () => CLASSIC_SCRIPTS.map((name) => ({
        tag: 'script',
        // Explicit: the default is head-prepend, ahead of <meta charset>.
        injectTo: 'head' as const,
        attrs: { src: `${resolvedBase}${name}`, 'vite-ignore': true },
      })),
    },
    generateBundle: {
      order: 'post',
      handler(_outputOptions, bundle) {
        const recordings = buildRecordingsIndex(resolvedBase);
        for (const file of recordings.files) this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source });
        this.emitFile({ type: 'asset', fileName: 'demo-scenes.js', source: buildScenesScript(version, recordings.script) });
        this.emitFile({ type: 'asset', fileName: 'demo-boot.js', source: readFileSync(BOOT_SCRIPT_PATH, 'utf8') });
        // The host the page hands over to when opened directly (demo/stage.html): the frame at
        // the site's 1600 by 1000, scaled to the window, so the recordings always fit.
        this.emitFile({ type: 'asset', fileName: 'stage.html', source: readFileSync(path.join(demoDir, 'stage.html'), 'utf8') });
        this.emitFile({ type: 'asset', fileName: 'mock-electron-api.js', source: readFileSync(MOCK_SCRIPT_PATH, 'utf8') });
        this.emitFile({ type: 'asset', fileName: 'demo-seed.js', source: buildSeedScript(version) });

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
