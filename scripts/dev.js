const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const rendererOptimizeDeps = require('./renderer-optimize-deps.json');

const projectDir = path.resolve(__dirname, '..');

// Parse CLI flags
const portArg = process.argv.find(a => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 5173;
const ephemeral = process.argv.includes('--ephemeral');

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
    'MAIN_WINDOW_VITE_DEV_SERVER_URL': JSON.stringify(`http://localhost:${port}`),
    'MAIN_WINDOW_VITE_NAME': JSON.stringify('main_window'),
  },
  sourcemap: true,
};

let viteServer = null;
let electronProc = null;

async function start() {
  // 1. Start Vite dev server using JS API
  console.time('[dev] vite createServer');
  const { createServer } = await import('vite');
  const isWorktree = projectDir.replace(/\\/g, '/').includes('.kangentic/worktrees/');
  if (isWorktree) {
    // Bypass vite.config.mts entirely. The config's watch.ignored pattern
    // (**/.kangentic/**) matches every file in the worktree (since the worktree
    // lives inside .kangentic/worktrees/), and Vite's mergeConfig concatenates
    // arrays instead of replacing them, so we can't override it.
    const tailwindcss = (await import('@tailwindcss/vite')).default;
    const react = (await import('@vitejs/plugin-react')).default;
    // Ignore runtime dirs that Electron/Claude write into during the session.
    // We can't reuse vite.config.mts because its **/.kangentic/** pattern
    // matches every file in the worktree. Use absolute paths instead.
    const ignoreDirs = ['.kangentic', '.claude', '.vite'].map(
      d => path.join(projectDir, d).replace(/\\/g, '/') + '/**'
    );
    viteServer = await createServer({
      configFile: false,
      root: projectDir,
      plugins: [tailwindcss(), react()],
      resolve: {
        alias: { '@shared': '/src/shared' },
        preserveSymlinks: true,
      },
      optimizeDeps: {
        include: rendererOptimizeDeps,
      },
      server: { port, strictPort: true, watch: { ignored: ignoreDirs } },
    });
  } else {
    viteServer = await createServer({
      configFile: path.join(projectDir, 'vite.config.mts'),
      server: { port, strictPort: true },
    });
  }
  await viteServer.listen();
  console.timeEnd('[dev] vite createServer');
  console.log(`[dev] Vite dev server running at http://localhost:${port}`);

  // 2. Build main + preload with esbuild, and warm up Vite's renderer
  //    module graph in parallel. transformRequest forces Vite's dependency
  //    optimizer to complete before Electron loads the page, preventing
  //    the renderer from blocking on mid-load re-optimization.
  console.time('[dev] esbuild');
  console.time('[dev] warmup');
  await Promise.all([
    Promise.all([
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
    ]).then(() => {
      console.timeEnd('[dev] esbuild');
      console.log('[dev] Main + preload built');
    }),
    viteServer.transformRequest('/src/renderer/index.tsx')
      .finally(() => console.timeEnd('[dev] warmup')),
  ]);

  // 3. Launch Electron
  const positionalArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const targetDir = positionalArgs[0] || projectDir;
  const electronArgs = [projectDir, `--cwd=${path.resolve(targetDir)}`];

  // Preview instances get their own user data directory to avoid disk cache
  // conflicts with the primary Electron instance, and their own data directory
  // so preview databases don't pollute the real app. Both live inside
  // .kangentic/ which is already cleaned up on ephemeral exit.
  let spawnEnv = process.env;
  if (ephemeral) {
    const resolvedTarget = path.resolve(targetDir);
    const userDataDir = path.join(resolvedTarget, '.kangentic', 'electron-data');
    electronArgs.push(`--user-data-dir=${userDataDir}`);
    electronArgs.push('--ephemeral');
    spawnEnv = { ...process.env, KANGENTIC_DATA_DIR: path.join(resolvedTarget, '.kangentic', 'data') };
  }

  electronProc = spawn(electronExe, electronArgs, {
    cwd: projectDir,
    stdio: 'inherit',
    env: spawnEnv,
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
  // Ephemeral mode: remove the worktree's .kangentic/ and .vite/ on exit.
  // With the junction approach, dev.js runs from the worktree itself so
  // projectDir IS the worktree. Detect worktree by checking if the path
  // contains .kangentic/worktrees/ rather than comparing directories.
  if (ephemeral) {
    const normalized = projectDir.replace(/\\/g, '/');
    if (normalized.includes('.kangentic/worktrees/')) {
      const kanDir = path.join(projectDir, '.kangentic');
      const viteDir = path.join(projectDir, '.vite');
      for (const dir of [kanDir, viteDir]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`[dev] Ephemeral cleanup: removed ${dir}`);
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

start().catch((err) => {
  console.error('[dev] Fatal error:', err);
  cleanup(1);
});
