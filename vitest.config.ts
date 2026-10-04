import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // No existing alias precedent for @shared in this config (unit tests import
    // it via relative paths instead); this one is added specifically so
    // tests/unit/protocol/*.test.ts can exercise the real public export
    // surface of the package (`import ... from '@kangentic/protocol'`) rather
    // than reaching into its internals via deep relative paths.
    alias: {
      '@kangentic/protocol': path.join(configDir, 'packages/protocol/src'),
      // The Aptabase SDK's ESM build named-imports from 'electron', which
      // Node's ESM linker rejects against the CJS electron stub under
      // plain-node vitest - so any suite whose import graph reaches
      // src/main/analytics/analytics.ts would fail at link time. This stub
      // keeps the graph loadable; suites that assert on analytics still
      // vi.mock the SDK or the analytics module, which overrides the alias.
      '@aptabase/electron/main': path.join(
        configDir,
        'tests/fixtures/aptabase-electron-main-stub.ts'
      ),
      // Same ESM-link problem, same cure (see the stub's header comment).
      '@sentry/electron/main': path.join(configDir, 'tests/fixtures/sentry-electron-stub.ts'),
      '@sentry/electron/renderer': path.join(configDir, 'tests/fixtures/sentry-electron-stub.ts'),
    },
  },
  // Match the build-time constant used by esbuild (scripts/{dev,build}.js)
  // and Vite (vite.config.mts). Vitest evaluates source TS with on-the-fly
  // transforms - the constant is unset by default, so any `if (__KANGENTIC_DEV__)`
  // branch in product code would throw a ReferenceError when the test
  // module loads it. Pinning to `false` runs tests as production-like:
  // the dev-only `src/devtools/` import branches in product files are
  // dead code, no devtools wiring fires, the rest of the test runs as it
  // would in a packaged build.
  define: {
    __KANGENTIC_DEV__: 'false',
  },
  test: {
    // A throwaway KANGENTIC_DATA_DIR per test file, so a suite that reaches the
    // real getGlobalDb() never opens the developer's own global database. See
    // isolate-data-dir.ts for why this became necessary with better-sqlite3 13;
    // unit-data-root.ts owns the per-run parent and removes it afterwards.
    // node-api-floor.ts goes first: below Node-API 10 better-sqlite3 13
    // segfaults instead of failing, so the run stops there with a reason.
    globalSetup: ['tests/unit/helpers/node-api-floor.ts', 'tests/unit/helpers/unit-data-root.ts'],
    setupFiles: ['tests/unit/helpers/isolate-data-dir.ts'],
    // `tests/unit/**` runs by default via `npm run test:unit`.
    // `tests/integration/**` is opt-in - tests there hit real CLIs / file
    // system / network and only make sense to run on demand. They are
    // excluded from `npm run test:unit` via the explicit unit-only path
    // in package.json (`vitest run tests/unit`), and are picked up here
    // when a developer runs `npx vitest run tests/integration/...`.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
  },
});
