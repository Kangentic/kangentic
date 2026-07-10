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
    // `tests/unit/**` runs by default via `npm run test:unit`.
    // `tests/integration/**` is opt-in - tests there hit real CLIs / file
    // system / network and only make sense to run on demand. They are
    // excluded from `npm run test:unit` via the explicit unit-only path
    // in package.json (`vitest run tests/unit`), and are picked up here
    // when a developer runs `npx vitest run tests/integration/...`.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
  },
});
