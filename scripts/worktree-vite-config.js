const path = require('path');
const rendererOptimizeDeps = require('./renderer-optimize-deps.json');

/**
 * Where a worktree's Vite dev server keeps its dependency cache.
 *
 * Worktree servers must NOT use the default <root>/node_modules/.vite: a
 * worktree's node_modules is a junction to the main repo's (see
 * src/main/git/node-modules-link.ts), so that default cacheDir physically IS
 * the main `npm start` server's live cache. The worktree config below resolves
 * a different config than vite.config.mts (configFile:false, different root,
 * preserveSymlinks), so every preview boot would invalidate and rewrite that
 * shared cache under the running main server, whose in-memory `?v=<hash>`
 * module URLs then no longer match disk. The first lazy island opened after a
 * clobber (the Changes panel) failed with "Failed to fetch dynamically imported
 * module", which the browser caches for the document lifetime. .kangentic/ is
 * gitignored and covered by the worktree watch ignorePatterns. Guarded by
 * tests/unit/renderer-optimize-deps-parity.test.ts.
 */
function worktreeViteCacheDir(projectDir) {
  return path.join(projectDir, '.kangentic', 'vite-cache');
}

/**
 * The inline Vite config a worktree's dev server runs with. One builder for
 * scripts/dev.js and scripts/vite-prebundle.js: Vite keys its dependency cache
 * on a hash of the resolved config (root, resolve, plugin names, optimizeDeps),
 * so the pre-bundle only produces a cache the dev server accepts when both
 * start from the same config.
 *
 * vite.config.mts is bypassed entirely. Its relative watch.ignored glob for
 * .kangentic matches every file in the worktree (since the worktree lives
 * inside .kangentic/worktrees/), and Vite's mergeConfig concatenates arrays
 * instead of replacing them, so it cannot be overridden.
 */
async function worktreeViteConfig(projectDir, port) {
  const tailwindcss = (await import('@tailwindcss/vite')).default;
  const react = (await import('@vitejs/plugin-react')).default;
  // Kept in step with vite.config.mts; scripts/vite-refresh-hook-signatures.mjs says why.
  const { refreshHookSignatures } = await import('./vite-refresh-hook-signatures.mjs');
  // Ignore runtime dirs that Electron/Claude write into during the session.
  // vite.config.mts cannot be reused because its **/.kangentic/** pattern
  // matches every file in the worktree. Use absolute paths instead.
  const ignorePatterns = [
    ...(['.kangentic', '.claude', '.codex', '.aider', '.vite', 'docs', 'tests'].map(
      (directoryName) => path.join(projectDir, directoryName).replace(/\\/g, '/') + '/**'
    )),
    path.join(projectDir, 'kangentic.json').replace(/\\/g, '/'),
    path.join(projectDir, 'kangentic.local.json').replace(/\\/g, '/'),
  ];
  const viteCacheDir = worktreeViteCacheDir(projectDir);
  return {
    configFile: false,
    root: projectDir,
    // Isolated dep cache; see worktreeViteCacheDir above. Never let a worktree
    // server share node_modules/.vite with the main checkout.
    cacheDir: viteCacheDir,
    plugins: [tailwindcss(), react(), ...refreshHookSignatures()],
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
  };
}

module.exports = { worktreeViteCacheDir, worktreeViteConfig };
