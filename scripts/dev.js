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

// PID file: this process (not the launcher's terminal/shell, which is several
// process-tree hops away and not what you actually want to kill) is the real
// long-running dev server - it hosts Vite in-process and owns the Electron
// child, so its PID is the one tooling needs to identify and later tear down
// a specific preview instance. Keyed by port so multiple simultaneous
// previews from the same worktree (different ports) never collide. Written
// as early as possible (module scope, before the slow Vite/esbuild work
// below) so a launcher polling for it doesn't wait on the build.
const pidFilePath = path.join(projectDir, '.kangentic', `preview-${port}.pid`);
try {
  fs.mkdirSync(path.dirname(pidFilePath), { recursive: true });
  fs.writeFileSync(pidFilePath, String(process.pid));
} catch (pidWriteError) {
  console.warn('[dev] could not write preview PID file:', pidWriteError);
}

// Graceful-stop channel: tooling that needs to tear down this preview (e.g.
// a restart after a main-process change) creates this file instead of
// `taskkill /F`. A forced kill exits non-zero, which Windows Terminal's
// default closeOnExit=graceful treats as a crash and leaves a dead
// "[process exited with code 1]" tab behind after every restart. Polling for
// the file lets dev.js run its normal cleanup and exit 0, so the hosting
// terminal tab closes itself. Written by
// `node scripts/worktree-preview.js --stop` (see stopPreview there).
const stopFilePath = path.join(projectDir, '.kangentic', `preview-${port}.stop`);
try {
  fs.rmSync(stopFilePath, { force: true });
} catch {
  // best-effort: a stale stop file from a crashed instance must not
  // immediately stop this one; ignore removal failures.
}
const stopWatcher = setInterval(() => {
  if (fs.existsSync(stopFilePath)) {
    console.log('[dev] Stop requested via stop file - shutting down');
    cleanup(0);
  }
}, 500);
// Never keep the process alive just to watch for stops.
stopWatcher.unref();

// Detect Electron executable path per-platform
const electronExe = process.platform === 'win32'
  ? path.join(projectDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(projectDir, 'node_modules', '.bin', 'electron');

const esbuildCommon = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'node-pty', 'sherpa-onnx-node', 'sqlite-vec', '@huggingface/transformers'],
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

  // Per-server Vite dep cache. Computed BEFORE createServer, which creates the
  // directory during boot, so the cold-cache message below stays accurate (the
  // old placement checked existsSync AFTER createServer had already made it).
  //
  // Worktree servers must NOT use the default <root>/node_modules/.vite: a
  // worktree's node_modules is a junction to the main repo's (see
  // src/main/git/node-modules-link.ts), so that default cacheDir physically IS
  // the main `npm start` server's live cache. The worktree branch below resolves
  // a different config than vite.config.mts (configFile:false, different root,
  // preserveSymlinks), so every preview boot would invalidate and rewrite that
  // shared cache under the running main server, whose in-memory `?v=<hash>`
  // module URLs then no longer match disk. The first lazy island opened after a
  // clobber (the Changes panel) failed with "Failed to fetch dynamically imported
  // module", which the browser caches for the document lifetime. .kangentic/ is
  // gitignored, covered by the worktree watch ignorePatterns, and removed by the
  // ephemeral cleanup() on exit. Guarded by
  // tests/unit/renderer-optimize-deps-parity.test.ts.
  const viteCacheDir = isWorktree
    ? path.join(projectDir, '.kangentic', 'vite-cache')
    : path.join(projectDir, 'node_modules', '.vite');
  const coldCache = !fs.existsSync(viteCacheDir);

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
      // Isolated dep cache; see the viteCacheDir comment above. Never let a
      // worktree server share node_modules/.vite with the main checkout.
      cacheDir: viteCacheDir,
      plugins: [tailwindcss(), react()],
      resolve: {
        alias: { '@shared': '/src/shared', '@kangentic/protocol': '/packages/protocol/src' },
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
    // Conversation-memory embedding worker (Electron utilityProcess entry),
    // built next to the main bundle so it resolves at __dirname in dev too.
    esbuild.build({
      ...esbuildCommon,
      entryPoints: [path.join(projectDir, 'src/main/retrieval/embedder/embed-worker.ts')],
      outfile: path.join(projectDir, '.vite/build/embed-worker.js'),
    }),
    // Untracked-file line-count worker (Electron utilityProcess entry), same
    // dev-parity reasoning as the embed worker above.
    esbuild.build({
      ...esbuildCommon,
      entryPoints: [path.join(projectDir, 'src/main/git/line-count/line-count-worker.ts')],
      outfile: path.join(projectDir, '.vite/build/line-count-worker.js'),
    }),
  ]);
  console.timeEnd('[dev] esbuild');
  console.log('[dev] Main + preload + embed worker + line-count worker built');

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
  // Best-effort: remove this instance's PID and stop files so tooling never
  // finds a stale entry for a preview that already exited. A no-op if
  // ephemeral mode is about to remove the whole .kangentic/ dir below anyway.
  try {
    fs.rmSync(pidFilePath, { force: true });
    fs.rmSync(stopFilePath, { force: true });
  } catch {
    // best-effort
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
// Closing the preview's terminal WINDOW delivers SIGHUP (on Windows, Node maps
// the console CTRL_CLOSE_EVENT to it, with a ~10s grace window before the OS
// terminates unconditionally; on unix, terminal close sends a real SIGHUP).
// Without this handler the dev server survived a closed terminal as an orphan
// still holding its port and Electron child, and left a stale PID file behind
// for the next launch to misreport. cleanup() is comfortably faster than the
// grace window (sync kills + fs removals).
process.on('SIGHUP', () => cleanup(0));

start().catch((err) => {
  console.error('[dev] Fatal error:', err);
  cleanup(1);
});
