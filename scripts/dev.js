const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

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
let mainCtx = null;
let preloadCtx = null;
let restartTimer = null;
let isRestarting = false;
let startupComplete = false;

async function start() {
  // 1. Start Vite dev server using JS API
  const { createServer } = await import('vite');
  const isWorktree = projectDir.replace(/\\/g, '/').includes('.kangentic/worktrees/');
  if (isWorktree) {
    // Bypass vite.config.mts entirely. The config's watch.ignored pattern
    // (**/.kangentic/**) matches every file in the worktree (since the worktree
    // lives inside .kangentic/worktrees/), and Vite's mergeConfig concatenates
    // arrays instead of replacing them, so we can't override it.
    const tailwindcss = (await import('@tailwindcss/vite')).default;
    const react = (await import('@vitejs/plugin-react')).default;
    viteServer = await createServer({
      configFile: false,
      root: projectDir,
      plugins: [tailwindcss(), react()],
      resolve: {
        alias: { '@shared': '/src/shared' },
        preserveSymlinks: true,
      },
      server: { port, strictPort: true },
    });
  } else {
    viteServer = await createServer({
      configFile: path.join(projectDir, 'vite.config.mts'),
      server: { port, strictPort: true },
    });
  }
  await viteServer.listen();
  console.log(`[dev] Vite dev server running at http://localhost:${port}`);

  // 2. Build main + preload with esbuild (watch mode)
  const rebuildPlugin = {
    name: 'rebuild-notify',
    setup(build) {
      let firstBuild = true;
      build.onEnd(result => {
        if (firstBuild) { firstBuild = false; return; }
        if (!startupComplete) return;
        if (result.errors.length > 0) {
          console.log('[dev] Build errors — Electron keeps running with previous code');
          return;
        }
        console.log('[dev] Main/preload rebuilt — restarting Electron...');
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => restartElectron(), 300);
      });
    },
  };

  mainCtx = await esbuild.context({
    ...esbuildCommon,
    entryPoints: [path.join(projectDir, 'src/main/index.ts')],
    outfile: path.join(projectDir, '.vite/build/index.js'),
    plugins: [rebuildPlugin],
  });
  preloadCtx = await esbuild.context({
    ...esbuildCommon,
    entryPoints: [path.join(projectDir, 'src/preload/preload.ts')],
    outfile: path.join(projectDir, '.vite/build/preload.js'),
    plugins: [rebuildPlugin],
  });

  await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()]);
  console.log('[dev] Main + preload built');

  await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
  console.log('[dev] Watching main + preload for changes');

  // 3. Copy bridge scripts (external scripts invoked by Claude Code, not bundled)
  const bridgeFiles = [
    'src/main/agent/status-bridge.js',
    'src/main/agent/activity-bridge.js',
    'src/main/agent/event-bridge.js',
  ];
  const buildDir = path.join(projectDir, '.vite/build');
  for (const rel of bridgeFiles) {
    fs.copyFileSync(path.join(projectDir, rel), path.join(buildDir, path.basename(rel)));
  }
  console.log('[dev] Copied bridge scripts');

  // Watch bridge scripts for changes and re-copy + restart Electron
  for (const rel of bridgeFiles) {
    const absPath = path.join(projectDir, rel);
    fs.watch(absPath, { persistent: false }, () => {
      if (!startupComplete) return;
      try {
        fs.copyFileSync(absPath, path.join(buildDir, path.basename(rel)));
        console.log(`[dev] Bridge script changed: ${path.basename(rel)} — restarting Electron...`);
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => restartElectron(), 300);
      } catch {
        // File may be mid-write
      }
    });
  }

  // 4. Launch Electron
  launchElectron();

  // Grace period: ignore spurious filesystem events from the initial build/copy.
  // esbuild watch and fs.watch on Windows fire duplicate events immediately after
  // setup — suppress them until the dust settles.
  setTimeout(() => { startupComplete = true; }, 2000);
}

function launchElectron() {
  const positionalArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const targetDir = positionalArgs[0] || projectDir;
  const electronArgs = [projectDir, `--cwd=${path.resolve(targetDir)}`];

  // Preview instances get their own user data directory to avoid disk cache
  // conflicts with the primary Electron instance.
  if (ephemeral) {
    const userDataDir = path.join(path.resolve(targetDir), '.kangentic', 'electron-data');
    electronArgs.push(`--user-data-dir=${userDataDir}`);
  }

  electronProc = spawn(electronExe, electronArgs, {
    cwd: projectDir,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  electronProc.on('close', (code) => {
    electronProc = null;
    isRestarting = false;
    if (code === 75) {
      // Graceful restart — respawn with fresh code (already rebuilt by esbuild watch)
      console.log('[dev] Restarting Electron...');
      startupComplete = false;
      launchElectron();
      setTimeout(() => { startupComplete = true; }, 2000);
    } else if (code === 0) {
      // Normal exit (user closed the window)
      console.log('[dev] Electron exited normally');
      cleanup(0);
    } else {
      // Crash or error — keep watchers alive, auto-retry on next rebuild
      console.log(`[dev] Electron exited with code ${code} — watchers still active, will restart on next rebuild`);
    }
  });
}

function restartElectron() {
  if (isRestarting) return;

  if (!electronProc) {
    // Electron not running (crashed earlier) — just relaunch with fresh code
    console.log('[dev] Relaunching Electron...');
    launchElectron();
    return;
  }

  isRestarting = true;
  // Signal Electron to gracefully shut down (suspend sessions)
  try {
    electronProc.send({ type: 'graceful-restart' });
  } catch {
    // IPC channel may already be closed — fall back to kill
    electronProc.kill();
  }
}

function cleanup(exitCode) {
  if (mainCtx) {
    mainCtx.dispose().catch(() => {});
    mainCtx = null;
  }
  if (preloadCtx) {
    preloadCtx.dispose().catch(() => {});
    preloadCtx = null;
  }
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
