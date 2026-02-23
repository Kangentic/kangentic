const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectDir = path.resolve(__dirname, '..');

const esbuildCommon = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'node-pty', 'simple-git'],
  define: {
    'MAIN_WINDOW_VITE_DEV_SERVER_URL': JSON.stringify(''),
    'MAIN_WINDOW_VITE_NAME': JSON.stringify('main_window'),
  },
  sourcemap: true,
  minify: true,
};

async function build() {
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

  // Copy status-bridge.js (external script invoked by Claude Code, not bundled)
  fs.copyFileSync(
    path.join(projectDir, 'src/main/agent/status-bridge.js'),
    path.join(projectDir, '.vite/build/status-bridge.js'),
  );
  console.log('[build] Copied status-bridge.js');

  console.log('[build] Done! Output in .vite/build/');
}

build().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
