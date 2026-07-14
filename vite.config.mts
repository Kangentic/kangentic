import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rendererOptimizeDeps from './scripts/renderer-optimize-deps.json';

// fileURLToPath(import.meta.url) rather than a __dirname shim: this config is
// bundled/evaluated as ESM.
const configDir = path.dirname(fileURLToPath(import.meta.url));
const isWorktree = configDir.replace(/\\/g, '/').includes('.kangentic/worktrees/');

export default defineConfig(({ mode }) => ({
  // Worktree checkouts share the main repo's physical node_modules via a
  // junction (src/main/git/node-modules-link.ts). A server started from a
  // worktree with THIS config (Playwright's webServer for UI tests, or a manual
  // `npx vite`) resolves a different config hash than the main `npm start`
  // server and would invalidate/rewrite the live server's dep cache at the
  // default <root>/node_modules/.vite. Give it a worktree-local cache instead.
  // Deliberately distinct from scripts/dev.js's worktree cache
  // (.kangentic/vite-cache): the two configs resolve differently, so sharing one
  // directory would just recreate the cross-server clobbering inside the
  // worktree (a UI-test run would poison a live preview). Non-worktree servers
  // (main dev, CI) keep the default cache. Guarded by
  // tests/unit/renderer-optimize-deps-parity.test.ts.
  ...(isWorktree
    ? { cacheDir: path.join(configDir, '.kangentic', 'vite-cache-tests') }
    : {}),
  // Build-time constant gating dev-only renderer code (DevtoolsBootstrap,
  // DevToolsSections). `mode === 'production'` happens during `npm run build`,
  // dropping the conditional blocks from the production renderer bundle.
  // The dev path (Vite's dev server, started via scripts/dev.js) sets the
  // same constant inline at createServer time for worktrees, or via this
  // function for non-worktree dev.
  define: {
    __KANGENTIC_DEV__: JSON.stringify(mode !== 'production'),
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@shared': '/src/shared',
      '@kangentic/protocol': '/packages/protocol/src',
    },
  },
  server: {
    watch: {
      // Ignore non-renderer directories to prevent unnecessary HMR triggers.
      // .kangentic/ contains worktrees and session data, .claude/ has agent configs,
      // docs/ and tests/ are markdown/test files that don't affect the renderer.
      ignored: ['**/.kangentic/**', '**/.claude/**', '**/.codex/**', '**/.aider/**', '**/.qwen/**', '**/docs/**', '**/tests/**', '**/kangentic.json', '**/kangentic.local.json'],
    },
  },
  // Renderer deps pre-bundled at dev-server boot. The list lives in
  // scripts/renderer-optimize-deps.json so scripts/dev.js's inline worktree
  // config (which cannot load this file) shares it. Two invariants, both
  // enforced by tests/unit/renderer-optimize-deps-parity.test.ts:
  // 1. Every DEEP import of a listed package used by the renderer must be listed
  //    too. A dep first met after boot triggers a mid-session re-optimization;
  //    the Changes panel's lazy monaco graph hit this and died with "Failed to
  //    fetch dynamically imported module".
  // 2. @monaco-editor/react stays OUT: pre-bundling wraps it in Vite's CJS-ESM
  //    interop and hands it a React whose hooks dispatcher is null (useState
  //    crash in DiffEditor, commit 5bb2e089). As native ESM its react imports
  //    rewrite to the shared pre-bundled react.
  optimizeDeps: {
    include: rendererOptimizeDeps,
  },
  build: {
    // Electron loads from disk, so large DOWNLOAD sizes are not a concern -
    // but parse/eval at cold start is. Named vendor chunks serve two goals:
    // keep the always-loaded xterm out of the main bundle, and give
    // scripts/build.js's assertVendorChunksLazy a stable name to verify
    // recharts stays out of the entry's static import closure (it is only
    // reachable through the lazy StatsDashboardBody boundary; the name match
    // cannot hit first-party sources - the chart wrappers live at
    // stats/charts/Kng*.tsx).
    //
    // The react group is LOAD-BEARING, not an optimization: rolldown's
    // manualChunks grouping absorbs shared dependencies (react's CJS interop,
    // Vite's preload helper) into a named group that references them -
    // react-dom's CJS module landed in the recharts chunk, which made the
    // ENTRY statically import it and silently defeated the lazy boundary
    // (the whole chunk parses at startup). Claiming react/react-dom/scheduler
    // into their own chunk (which the entry statically needs anyway) severs
    // that eager edge.
    //
    // monaco-editor deliberately has NO manualChunks entry: a named monaco
    // group absorbed those same shared modules and became a STATIC import of
    // the entry, parsing all ~4MB of monaco at every cold start and silently
    // defeating the lazy ChangesPanel boundary. Natural chunking puts monaco
    // in lazy chunks (editor api + per-language) reached only through the
    // ChangesPanel dynamic import. assertVendorChunksLazy fails the build if
    // monaco (or recharts) ever re-enters the entry's static closure.
    rolldownOptions: {
      output: {
        manualChunks(id: string) {
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
          if (id.includes('@xterm/xterm') || id.includes('@xterm/addon-webgl')) return 'xterm';
          if (id.includes('recharts')) return 'recharts';
        },
      },
    },
    chunkSizeWarningLimit: 3000,
  },
}));
