const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { copyExternalScripts } = require('./copy-external-scripts');

const projectDir = path.resolve(__dirname, '..');

// Set BEFORE anything imports vite or the Sentry bundler plugins.
//
// Both Sentry plugins share createSentryBuildPluginManager, which computes
// `isDevMode = process.env.NODE_ENV === 'development'` ONCE, at plugin
// CONSTRUCTION time, and then silently skips the upload: it logs "Running in
// development mode. Will not upload sourcemaps." at debug level only, deletes
// the maps anyway in its finally block, and lets the build exit 0. Nothing in a
// normal build log records that it happened.
//
// Left to itself NODE_ENV is 'development' by the time the config factory runs,
// so this is not a hypothetical: measured against this worktree, a build with a
// valid token uploaded ZERO sourcemap bundles, and the same build with
// NODE_ENV=production uploaded them. The missing CI secret was only the first of
// two independent reasons no release has ever had readable renderer stacks;
// this was the second, and it would have outlived fixing the secret.
//
// Setting it is also just correct: this script only ever produces a production
// bundle. The dev server does not run through here, and the E2E devtools build
// keeps its own KANGENTIC_BUILD_DEV flag.
process.env.NODE_ENV = 'production';

// `KANGENTIC_BUILD_DEV=1` keeps the devtools / inspection bridge tree in the
// produced bundle. Off by default so `npm run build` still produces a
// production-shaped artifact; on for E2E runs that exercise the dev-only
// inspection bridge endpoints (devtools-inspection.spec.ts) since the bridge
// must be physically present in the binary the test launches.
const keepDevtools = process.env.KANGENTIC_BUILD_DEV === '1';

// Sentry sourcemap upload for the main + preload bundles, release-only: it
// activates only when an upload token is present (a CI/release secret; the
// renderer half lives in vite.config.mts behind the same gate).
// KANGENTIC_SENTRY_TOKEN is the scoped name; SENTRY_AUTH_TOKEN stays accepted
// as the conventional CI fallback. Maps are generated as separate files
// (esbuild 'external' = no sourceMappingURL comment), uploaded with debug
// IDs, then deleted, so nothing ships.
/**
 * Pick the upload token from the environment.
 *
 * Trimmed truthiness, NOT `??`. GitHub Actions still injects an `env:` key whose
 * `${{ secrets.X }}` expression came back empty, so an unset secret arrives as
 * the empty string rather than as undefined. `??` only falls through on
 * null/undefined, so `KANGENTIC_SENTRY_TOKEN ?? SENTRY_AUTH_TOKEN` returned ''
 * and the documented CI fallback could never fire. Returns undefined when
 * neither is usable, so `Boolean()` below reads the same either way.
 *
 * Exported for test: both call sites read process.env at module scope, so the
 * pick cannot be exercised through the gate itself.
 */
function resolveSentryAuthToken(env) {
  for (const name of ['KANGENTIC_SENTRY_TOKEN', 'SENTRY_AUTH_TOKEN']) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

const sentryAuthToken = resolveSentryAuthToken(process.env);
const uploadSourcemaps = Boolean(sentryAuthToken);
// One Sentry project receives both the sourcemaps and the native debug files.
const SENTRY_ORG = 'kangentic';
const SENTRY_PROJECT = 'desktop';
/**
 * Events report `Kangentic@<version>` (the @sentry/electron default, built from
 * productName and app version), so the artifacts must be filed under the same
 * name. Left unset, the bundler plugin falls back to GITHUB_SHA and the release
 * carries maps its own Releases page cannot show. Symbolication itself rides on
 * debug ids either way.
 *
 * Read lazily, matching resolveSentryReleaseName in vite.config.mts, so merely
 * requiring this module for one of its exported helpers does no file IO.
 */
function resolveSentryReleaseName() {
  const { version } = require('../package.json');
  // Fail rather than file the maps under `Kangentic@undefined`, which uploads
  // cleanly, reports success, and matches no event ever emitted. Mirrors the
  // same guard in vite.config.mts.
  if (typeof version !== 'string' || version === '') {
    throw new Error(
      '[build] Refusing to build: package.json has no usable "version", so the Sentry release '
      + 'name would be "Kangentic@undefined" and no event would ever match the uploaded symbols.',
    );
  }
  return `Kangentic@${version}`;
}

/**
 * Refuse to construct an upload plugin that we know will decline to upload.
 *
 * Asserts NODE_ENV IS 'production', deliberately, rather than that it is not
 * 'development'. The negative form would be dead code here: this module pins
 * NODE_ENV to 'production' at load, so nothing between that line and this call
 * can make the negative test fail. The positive form still fails if someone
 * deletes that assignment, or if a future entry point builds these plugins
 * without going through this script. That is the shape the original bug had -
 * not a wrong value, but nobody setting the right one.
 *
 * The plugins treat NODE_ENV === 'development' as "skip, quietly": debug-level
 * log, maps deleted anyway, exit 0. That is indistinguishable from success in a
 * release log, which is how two releases shipped unreadable. A token was
 * supplied, so an upload was intended; stop rather than produce a green build
 * with nothing uploaded. vite.config.mts carries the same guard for the
 * renderer half.
 */
function assertUploadCanActuallyRun() {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error(
      '[build] Refusing to build: a Sentry upload token is set, but NODE_ENV is '
      + `${JSON.stringify(process.env.NODE_ENV)} rather than "production". The Sentry bundler `
      + 'plugins skip their upload unless it is set, logging only at debug level and deleting the '
      + 'sourcemaps anyway, so the release would ship with unreadable stacks and a green build '
      + 'log. scripts/build.js pins it at module load; something has removed or overwritten that.',
    );
  }
}

/**
 * Say which way the gate went, on every build. Printing nothing when the token
 * is absent is what let v0.38.0 and v0.37.0 ship with no symbols at all and no
 * trace of it in the release logs, so silence is the bug being fixed here.
 */
function announceSentryUploadMode() {
  console.log(uploadSourcemaps
    ? `[build] Sentry symbol upload: enabled (release ${resolveSentryReleaseName()})`
    : '[build] Sentry symbol upload: skipped (no KANGENTIC_SENTRY_TOKEN or SENTRY_AUTH_TOKEN)');
}

// The uploadSourcemaps guard gates the require below (the function itself runs
// eagerly at module load), so unit tests that require this module for
// assertVendorChunksLazy never load the Sentry toolchain when no token is set.
//
// Exported for test: the release name and errorHandler override are otherwise
// only checked indirectly through the plugin options object esbuild never
// exposes.
function resolveSentryEsbuildPlugins() {
  if (!uploadSourcemaps) return [];
  assertUploadCanActuallyRun();
  const { sentryEsbuildPlugin } = require('@sentry/esbuild-plugin');
  return [
    sentryEsbuildPlugin({
      org: SENTRY_ORG,
      project: SENTRY_PROJECT,
      authToken: sentryAuthToken,
      telemetry: false,
      release: { name: resolveSentryReleaseName() },
      // A token was supplied, so an upload was intended. Let the failure reach
      // the build instead of logging past it: the plugin's default handler
      // warns and continues, which ships an unreadable release while the
      // release job still reports success.
      errorHandler: (error) => { throw error; },
      sourcemaps: {
        filesToDeleteAfterUpload: ['.vite/build/*.map'],
      },
    }),
  ];
}

/**
 * Upload node-pty's shipped Windows PDBs to Sentry as debug files, under the
 * same token gate as the sourcemaps above. Kangentic ships node-pty's npm
 * prebuilds (conpty.node, pty.node, conpty_console_list.node) unchanged, and
 * the tarball carries their PDBs next to them, so the debug ids in a native
 * crash's module list match these files exactly. Without the upload a crash
 * inside conpty.node arrives as raw addresses (DESKTOP-C had to be resolved
 * offline with dbghelp); with it, Sentry symbolicates to function and line.
 *
 * Windows leg only: the release matrix builds on three platforms and the
 * files are identical on each, so one upload is enough. The `require` sits
 * behind the gate for the same reason as resolveSentryEsbuildPlugins.
 *
 * A failed upload FAILS the build. It used to warn and continue, on the reasoning
 * that the files only make a FUTURE crash readable. That reasoning assumed the
 * warning would be read, and v0.38.0 proved otherwise: the upload never ran at
 * all and nothing in the release log said so. A token being present means an
 * upload was intended, so the only two acceptable outcomes are "uploaded" and
 * "the release stopped". `execute` must be asked to reject on a non-zero exit
 * (`'rejectOnError'`); its plain live mode resolves whatever sentry-cli exits
 * with, which would turn every failure into a false "uploaded" line below.
 *
 * Debug files are keyed by build id, not by release, so this upload is
 * unaffected by the release name and takes no release argument.
 */
async function uploadNativeDebugFiles() {
  if (!uploadSourcemaps || process.platform !== 'win32') return;
  const prebuildsDir = path.join(projectDir, 'node_modules', 'node-pty', 'prebuilds');
  const debugFileDirs = ['win32-x64', 'win32-arm64']
    .map((arch) => path.join(prebuildsDir, arch))
    .filter((dir) => fs.existsSync(dir));
  if (debugFileDirs.length === 0) {
    // Not a skip. Reaching here means a token was supplied AND this is the win32
    // leg, so an upload was intended and there is nothing to upload - the same
    // "green build, no symbols" outcome as a failed upload, which is what
    // DESKTOP-C had to be symbolicated by hand around. Fail like the catch below.
    throw new Error(
      '[build] No node-pty Windows prebuilds found under '
      + `${prebuildsDir}, so there are no debug files to upload; refusing to ship a release `
      + 'whose native frames cannot symbolicate. Check that node-pty installed its win32 '
      + 'prebuilds (a partial or pruned npm ci drops them).',
    );
  }
  const SentryCli = require('@sentry/cli');
  const sentryCli = new SentryCli(null, { authToken: sentryAuthToken, silent: false });
  try {
    await sentryCli.execute(
      ['debug-files', 'upload', '--org', SENTRY_ORG, '--project', SENTRY_PROJECT, ...debugFileDirs],
      'rejectOnError',
    );
  } catch (error) {
    console.error('[build] node-pty debug-file upload FAILED; refusing to ship a release whose native frames cannot symbolicate.');
    throw error;
  }
  console.log(`[build] Uploaded node-pty debug files to Sentry from ${debugFileDirs.length} prebuild dir(s)`);
}

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
  sourcemap: uploadSourcemaps ? 'external' : false,
  minify: true,
  plugins: resolveSentryEsbuildPlugins(),
};

async function build() {
  announceSentryUploadMode();
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

  // Release-only (token-gated) and Windows-only: see uploadNativeDebugFiles.
  await uploadNativeDebugFiles();

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

module.exports = {
  assertVendorChunksLazy,
  uploadNativeDebugFiles,
  resolveSentryAuthToken,
  announceSentryUploadMode,
  assertUploadCanActuallyRun,
  resolveSentryEsbuildPlugins,
};
