const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { copyExternalScripts } = require('./copy-external-scripts');

const projectDir = path.resolve(__dirname, '..');

// `KANGENTIC_BUILD_DEV=1` keeps the devtools / inspection bridge tree in the
// produced bundle. Off by default so `npm run build` still produces a
// production-shaped artifact; on for E2E runs that exercise the dev-only
// inspection bridge endpoints (devtools-inspection.spec.ts) since the bridge
// must be physically present in the binary the test launches.
const keepDevtools = process.env.KANGENTIC_BUILD_DEV === '1';

/**
 * Fails the build unless the two heavy lazy-only vendors (recharts behind
 * LazyStatsDashboard, monaco behind the lazy ChangesPanel) stayed OUT of the
 * renderer entry's static import closure. Rolldown's chunking has silently
 * defeated both boundaries before (a manualChunks group absorbed react's CJS
 * interop and became a static import of the entry, parsing the whole vendor
 * at every cold start), so this is the build-time backstop. Invariants:
 *   1. A `recharts-*.js` chunk EXISTS in assets/ (proves the manualChunks
 *      name in vite.config.mts did not silently rot on a future upgrade).
 *   2. Walking the Vite manifest's static `imports` closure from the entry
 *      never reaches that chunk.
 *   3. No chunk in that static closure CONTAINS monaco (marker-string scan;
 *      monaco has no named chunk by design - see vite.config.mts), and some
 *      lazy chunk does (proving the markers still detect monaco at all).
 * Falls back to asserting index.html carries no reference to the recharts
 * chunk if the manifest is ever unavailable.
 */
function assertVendorChunksLazy(rendererOutDir) {
  const assetsDir = path.join(rendererOutDir, 'assets');
  const assetFiles = fs.readdirSync(assetsDir);
  const rechartsChunk = assetFiles.find((name) => name.startsWith('recharts-') && name.endsWith('.js'));
  if (!rechartsChunk) {
    throw new Error(
      '[build] No recharts-*.js chunk in the renderer output. Either recharts became statically '
      + 'bundled into another chunk (check the manualChunks entry in vite.config.mts) or the '
      + 'dependency layout changed; the lazy-stats bundle assertion cannot run.',
    );
  }

  const manifestPath = path.join(rendererOutDir, '.vite', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn('[build] No Vite manifest found; falling back to the index.html reference check');
    const indexHtml = fs.readFileSync(path.join(rendererOutDir, 'index.html'), 'utf8');
    if (indexHtml.includes(rechartsChunk)) {
      throw new Error(`[build] index.html references ${rechartsChunk} - recharts leaked into the startup path`);
    }
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entryKeys = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  if (entryKeys.length === 0) {
    throw new Error('[build] Vite manifest has no entry chunk; cannot verify the lazy vendor splits');
  }
  const staticallyReachable = new Set();
  const queue = [...entryKeys];
  while (queue.length > 0) {
    const key = queue.pop();
    if (staticallyReachable.has(key) || !manifest[key]) continue;
    staticallyReachable.add(key);
    for (const dependency of manifest[key].imports ?? []) queue.push(dependency);
  }
  const staticFiles = new Set([...staticallyReachable].map((key) => manifest[key].file));

  const rechartsFile = `assets/${rechartsChunk}`;
  if (staticFiles.has(rechartsFile)) {
    throw new Error(
      `[build] ${rechartsChunk} is in the entry's STATIC import closure. Something imports recharts `
      + '(or a stats module that pulls it) statically from the startup path - route it through the '
      + 'LazyStatsDashboard boundary instead.',
    );
  }

  // Monaco: marker-string scan. These literals appear in monaco's editor
  // sources and nowhere in first-party code; web workers are separate
  // entries loaded inside worker contexts, not part of the startup path.
  const MONACO_MARKERS = ['editorViewZones', 'monaco-editor'];
  const chunkFiles = assetFiles.filter((name) => name.endsWith('.js') && !name.includes('worker'));
  let monacoSeenSomewhere = false;
  for (const chunkFile of chunkFiles) {
    const source = fs.readFileSync(path.join(assetsDir, chunkFile), 'utf8');
    const containsMonaco = MONACO_MARKERS.some((marker) => source.includes(marker));
    if (!containsMonaco) continue;
    monacoSeenSomewhere = true;
    if (staticFiles.has(`assets/${chunkFile}`)) {
      throw new Error(
        `[build] ${chunkFile} is in the entry's STATIC import closure but contains monaco. `
        + 'Monaco must only be reachable through the lazy ChangesPanel boundary - do NOT give it a '
        + 'manualChunks group (see vite.config.mts), and check for a new static import of '
        + 'monaco-editor or @monaco-editor/react from the startup path.',
      );
    }
  }
  if (!monacoSeenSomewhere) {
    throw new Error(
      '[build] No chunk contains the monaco marker strings - the lazy-monaco assertion has gone '
      + 'blind (markers rotted on a monaco upgrade?). Update MONACO_MARKERS in scripts/build.js.',
    );
  }
  console.log(`[build] Verified ${rechartsChunk} and all monaco chunks are reachable only via dynamic import`);
}

const esbuildCommon = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'node-pty', 'sherpa-onnx-node', 'sqlite-vec', '@huggingface/transformers', 'font-list'],
  conditions: ['require'],
  define: {
    'MAIN_WINDOW_VITE_DEV_SERVER_URL': JSON.stringify(''),
    'MAIN_WINDOW_VITE_NAME': JSON.stringify('main_window'),
    // Build-time constant gating dev-only code. `false` in production drops
    // src/devtools/ entirely from the production main + preload bundles
    // via esbuild's dead-code elimination. See scripts/dev.js for the dev value.
    '__KANGENTIC_DEV__': keepDevtools ? 'true' : 'false',
  },
  sourcemap: false,
  minify: true,
};

async function build() {
  console.log('[build] Running tsc --noEmit type check...');
  execSync('npx tsc --noEmit', { cwd: projectDir, stdio: 'inherit' });
  console.log('[build] Type check passed');

  // Remove any stale `.vite/renderer/` dev-server cache left by `npm start`.
  // The runtime main-process loader prefers the esbuild layout
  // (`.vite/build/renderer/`) but falls back to `.vite/renderer/` when the
  // former is absent, so a lingering dev cache on a dogfooding machine
  // could still shadow a freshly-built bundle in edge cases. Clearing it
  // here guarantees the production layout is the only one the built app
  // can resolve.
  const staleDevRendererDir = path.join(projectDir, '.vite/renderer');
  if (fs.existsSync(staleDevRendererDir)) {
    fs.rmSync(staleDevRendererDir, { recursive: true, force: true });
    console.log('[build] Removed stale .vite/renderer/ dev cache');
  }

  console.log(
    `[build] Building renderer with Vite (main-process devtools ${keepDevtools ? 'INCLUDED' : 'tree-shaken'})...`,
  );
  const { build: viteBuild } = await import('vite');
  const rendererOutDir = path.join(projectDir, '.vite/build/renderer/main_window');
  await viteBuild({
    configFile: path.join(projectDir, 'vite.config.mts'),
    base: './',
    build: {
      outDir: rendererOutDir,
      emptyOutDir: true,
      // Emit .vite/manifest.json (a few KB, ships harmlessly inside the
      // build dir) so assertRechartsIsLazy can walk the entry's static
      // import closure.
      manifest: true,
    },
  });
  console.log('[build] Renderer built');
  assertVendorChunksLazy(rendererOutDir);

  console.log('[build] Building main + preload with esbuild...');
  await Promise.all([
    esbuild.build({
      ...esbuildCommon,
      entryPoints: [path.join(projectDir, 'src/main/index.ts')],
      outfile: path.join(projectDir, '.vite/build/index.js'),
    }),
    esbuild.build({
      ...esbuildCommon,
      entryPoints: [path.join(projectDir, 'src/preload/preload.ts')],
      outfile: path.join(projectDir, '.vite/build/preload.js'),
    }),
    // The conversation-memory embedding worker runs in an Electron
    // utilityProcess, so it is bundled as its own entry next to the main
    // bundle. `@huggingface/transformers` stays external (resolved from
    // node_modules at runtime) so its bundled onnxruntime-web wasm assets
    // resolve to real files.
    esbuild.build({
      ...esbuildCommon,
      entryPoints: [path.join(projectDir, 'src/main/retrieval/embedder/embed-worker.ts')],
      outfile: path.join(projectDir, '.vite/build/embed-worker.js'),
    }),
    // The untracked-file line-count worker also runs in an Electron
    // utilityProcess (see src/main/git/line-count/line-count-client.ts), so
    // it is bundled as its own entry next to the main bundle.
    esbuild.build({
      ...esbuildCommon,
      entryPoints: [path.join(projectDir, 'src/main/git/line-count/line-count-worker.ts')],
      outfile: path.join(projectDir, '.vite/build/line-count-worker.js'),
    }),
  ]);
  console.log('[build] Main + preload + embed worker + line-count worker built');

  // Copy external scripts (bridges + adapter plugins) that run outside the
  // esbuild bundle as raw .js/.mjs and must sit next to the bundle. The copy
  // list is the single source of truth in scripts/copy-external-scripts.js,
  // shared with scripts/dev.js so the two can never drift. See
  // .claude/rules/external-scripts-parity.md.
  copyExternalScripts(projectDir);
  console.log('[build] Copied external scripts (bridges + adapter plugins)');

  // The kangentic MCP server now runs in-process inside Electron main
  // (see src/main/agent/mcp-http-server.ts), so we no longer bundle a
  // standalone mcp-server.js for Claude Code to spawn as a child.

  console.log('[build] Done! Output in .vite/build/');
}

// Only run the build when this script is invoked directly (`node
// scripts/build.js`, which is what `npm run build` does) - never as a side
// effect of `require`ing the module. This lets tests/unit/*.test.ts pull in
// `assertVendorChunksLazy` for direct unit coverage without kicking off a
// real multi-minute tsc + Vite + esbuild build as an import side effect.
if (require.main === module) {
  build().catch((err) => {
    console.error('[build] Failed:', err);
    process.exit(1);
  });
}

module.exports = { assertVendorChunksLazy };
