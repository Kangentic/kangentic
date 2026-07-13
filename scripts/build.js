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

const esbuildCommon = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'node-pty', 'sherpa-onnx-node', 'sqlite-vec', '@huggingface/transformers'],
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
  await viteBuild({
    configFile: path.join(projectDir, 'vite.config.mts'),
    base: './',
    build: {
      outDir: path.join(projectDir, '.vite/build/renderer/main_window'),
      emptyOutDir: true,
    },
  });
  console.log('[build] Renderer built');

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

build().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
