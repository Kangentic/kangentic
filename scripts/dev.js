const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const rendererOptimizeDeps = require('./renderer-optimize-deps.json');
const { copyExternalScripts } = require('./copy-external-scripts');

const projectDir = path.resolve(__dirname, '..');

// Parse CLI flags
const portArg = process.argv.find(a => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 5173;
const ephemeral = process.argv.includes('--ephemeral');
const fresh = process.argv.includes('--fresh');

// Detect Electron executable path per-platform
const electronExe = process.platform === 'win32'
  ? path.join(projectDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(projectDir, 'node_modules', '.bin', 'electron');

const esbuildCommon = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'node-pty', 'sherpa-onnx-node'],
  conditions: ['require'],
  define: {
    'MAIN_WINDOW_VITE_DEV_SERVER_URL': JSON.stringify(`http://localhost:${port}`),
    'MAIN_WINDOW_VITE_NAME': JSON.stringify('main_window'),
    // Build-time constant gating dev-only code (src/devtools/, devtools MCP
    // tools, dev-only Developer settings sections). esbuild's dead-code
    // elimination drops `if (__KANGENTIC_DEV__) { ... }` blocks in production
    // builds where this is `false`. See scripts/build.js for the prod value.
    '__KANGENTIC_DEV__': 'true',
  },
  sourcemap: true,
};

let viteServer = null;
let electronProc = null;

async function start() {
  // Ephemeral preview: prepare the data dir and START pre-cloning Project 1 NOW so
  // the (slow) git clone overlaps the Vite/esbuild build below. The main process then
  // ADOPTS the existing clone instead of cloning on launch, so the board appears at
  // build-speed rather than after a post-launch clone.
  const positionalArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const targetDir = positionalArgs[0] || (fresh ? null : projectDir);
  const resolvedTarget = targetDir ? path.resolve(targetDir) : projectDir;
  const ephemeralDataDir = ephemeral ? path.join(resolvedTarget, '.kangentic', 'data') : null;
  let previewClonePromise = Promise.resolve();
  if (ephemeral && !fresh && ephemeralDataDir) {
    // Fresh data dir every boot so a previous (possibly crashed) preview's clones
    // never persist. The node_modules junction lives OUTSIDE .kangentic/ and clones
    // are source-only (no junctions), so this rm is safe.
    // force suppresses ENOENT but not EBUSY/EPERM from a still-locked handle a
    // previous (crashed) preview left behind; retry briefly, then degrade to a
    // warning rather than crashing the dev server before the build starts.
    try {
      fs.rmSync(ephemeralDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (rmError) {
      console.warn('[dev] could not fully clear the ephemeral data dir (a previous preview may still hold a lock):', rmError);
    }
    fs.mkdirSync(ephemeralDataDir, { recursive: true });
    fs.writeFileSync(path.join(ephemeralDataDir, 'config.json'), JSON.stringify({ hasCompletedFirstRun: true }, null, 2));
    const preClone = (cloneDir) => new Promise((resolve) => {
      const cloneProc = spawn('git', ['clone', '--no-checkout', '--local', resolvedTarget, cloneDir], { stdio: 'inherit', windowsHide: true });
      cloneProc.on('close', () => resolve());
      cloneProc.on('error', (cloneErr) => { console.warn('[dev] preview pre-clone failed:', cloneErr); resolve(); });
    });
    // Pre-clone Project 1 + Project 2 in parallel; both overlap the build below.
    previewClonePromise = Promise.all([
      preClone(path.join(ephemeralDataDir, 'preview-projects', 'project-1')),
      preClone(path.join(ephemeralDataDir, 'preview-projects', 'project-2')),
    ]);
  }

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
    const ignorePatterns = [
      ...(['.kangentic', '.claude', '.codex', '.aider', '.vite', 'docs', 'tests'].map(
        d => path.join(projectDir, d).replace(/\\/g, '/') + '/**'
      )),
      path.join(projectDir, 'kangentic.json').replace(/\\/g, '/'),
      path.join(projectDir, 'kangentic.local.json').replace(/\\/g, '/'),
    ];
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
      define: {
        // Match the esbuild define so renderer code can use the same
        // build-time constant. See vite.config.mts for the non-worktree path.
        __KANGENTIC_DEV__: 'true',
      },
      server: { port, strictPort: true, watch: { ignored: ignorePatterns } },
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
  const viteCacheDir = path.join(projectDir, 'node_modules', '.vite');
  const coldCache = !fs.existsSync(viteCacheDir);
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
  console.timeEnd('[dev] esbuild');
  console.log('[dev] Main + preload built');

  // Copy external scripts (bridges + adapter plugins) next to the bundle, the
  // same step scripts/build.js runs. Without this, dev runs whatever stale copy
  // a prior `npm run build` left in `.vite/build/`, silently shadowing live
  // source. Shared copy list keeps dev and prod identical. See
  // .claude/rules/external-scripts-parity.md.
  copyExternalScripts(projectDir);
  console.log('[dev] Copied external scripts (bridges + adapter plugins)');

  // The MCP server is now hosted in-process by Electron main (see
  // src/main/agent/mcp-http-server.ts), so we no longer need to bundle a
  // standalone mcp-server.js or pre-write a project-level mcp-config.json
  // here. The main process writes <project>/.kangentic/mcp-config.json
  // on every project open with the live HTTP URL + per-launch token,
  // which is what `claude --mcp-config .kangentic/mcp-config.json`
  // consumes from outside Kangentic.
  if (coldCache) {
    console.log('[dev] Vite cache is cold -- warming up will take longer while Vite optimizes dependencies...');
  }
  console.time('[dev] warmup');
  await viteServer.transformRequest('/src/renderer/index.tsx');
  console.timeEnd('[dev] warmup');

  // 3. Launch Electron. targetDir / resolvedTarget / ephemeralDataDir were computed
  //    at the top of start(), where the ephemeral data dir was prepared and the
  //    Project 1 pre-clone was kicked off to overlap the build above.
  const electronArgs = [projectDir];
  if (targetDir) {
    electronArgs.push(`--cwd=${path.resolve(targetDir)}`);
  }

  // Preview instances get their own user data directory to avoid disk cache
  // conflicts with the primary Electron instance, and their own data directory
  // so preview databases don't pollute the real app. Both live inside
  // .kangentic/ which is already cleaned up on ephemeral exit.
  let spawnEnv = process.env;
  if (ephemeral) {
    const userDataDir = path.join(resolvedTarget, '.kangentic', 'electron-data');
    electronArgs.push(`--user-data-dir=${userDataDir}`);
    electronArgs.push('--ephemeral');
    spawnEnv = { ...process.env, KANGENTIC_DATA_DIR: ephemeralDataDir };
  }

  // Ensure the Project 1 pre-clone (started before the build) is on disk before
  // Electron launches, so the main process adopts it instead of cloning on boot.
  await previewClonePromise;

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
