const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectDir = path.resolve(__dirname, '..');

const esbuildCommon = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'node-pty'],
  conditions: ['require'],
  define: {
    'MAIN_WINDOW_VITE_DEV_SERVER_URL': JSON.stringify(''),
    'MAIN_WINDOW_VITE_NAME': JSON.stringify('main_window'),
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

  console.log('[build] Building renderer with Vite...');
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
  ]);
  console.log('[build] Main + preload built');

  // Copy bridge scripts (external scripts invoked by Claude Code, not bundled)
  fs.copyFileSync(
    path.join(projectDir, 'src/main/agent/status-bridge.js'),
    path.join(projectDir, '.vite/build/status-bridge.js'),
  );
  fs.copyFileSync(
    path.join(projectDir, 'src/main/agent/event-bridge.js'),
    path.join(projectDir, '.vite/build/event-bridge.js'),
  );
  console.log('[build] Copied status-bridge.js + event-bridge.js');

  // The kangentic MCP server now runs in-process inside Electron main
  // (see src/main/agent/mcp-http-server.ts), so we no longer bundle a
  // standalone mcp-server.js for Claude Code to spawn as a child.

  console.log('[build] Done! Output in .vite/build/');
}

build().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
