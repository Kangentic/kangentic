const { spawn } = require('child_process');
const path = require('path');
const esbuild = require('esbuild');

const projectDir = path.resolve(__dirname, '..');

// Detect Electron executable path per-platform
const electronExe = process.platform === 'win32'
  ? path.join(projectDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(projectDir, 'node_modules', '.bin', 'electron');

const esbuildCommon = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'node-pty', 'simple-git'],
  define: {
    'MAIN_WINDOW_VITE_DEV_SERVER_URL': JSON.stringify('http://localhost:5173'),
    'MAIN_WINDOW_VITE_NAME': JSON.stringify('main_window'),
  },
  sourcemap: true,
};

let viteServer = null;
let electronProc = null;

async function start() {
  // 1. Start Vite dev server using JS API
  const { createServer } = await import('vite');
  viteServer = await createServer({
    configFile: path.join(projectDir, 'vite.config.mts'),
    server: { port: 5173, strictPort: true },
  });
  await viteServer.listen();
  console.log('[dev] Vite dev server running at http://localhost:5173');

  // 2. Build main + preload with esbuild
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
  console.log('[dev] Main + preload built');

  // 3. Launch Electron
  const targetDir = process.argv[2] || projectDir;
  electronProc = spawn(electronExe, [projectDir, `--cwd=${path.resolve(targetDir)}`], {
    cwd: projectDir,
    stdio: 'inherit',
  });

  electronProc.on('close', (code) => {
    console.log(`[dev] Electron exited with code ${code}`);
    cleanup(code || 0);
  });
}

function cleanup(exitCode) {
  if (viteServer) {
    viteServer.close().catch(() => {});
    viteServer = null;
  }
  if (electronProc) {
    electronProc.kill();
    electronProc = null;
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

start().catch((err) => {
  console.error('[dev] Fatal error:', err);
  cleanup(1);
});
