#!/usr/bin/env node
/**
 * Builds the renderer as a static bundle for the UI test tier, into dist/ui-bundle/.
 *
 * The UI tier used to load the app from the Vite dev server in every test. That is 759 source
 * modules, each its own request, into a browser context with no cache, from one single-threaded
 * server the shard's workers share. A test that makes three assertions took 3.7s on CI, nearly all
 * of it that boot, and about 2,300 of the tier's tests boot per test. Served as a bundle the same
 * app arrives in a few files.
 *
 * It is the DEVELOPMENT app, not the one a release ships. `NODE_ENV=development` keeps
 * `import.meta.env.DEV` true in a build and `mode: 'development'` keeps `__KANGENTIC_DEV__` true
 * (vite.config.mts), so every hook the specs reach the app through is still there:
 * `window.__zustandStores`, `window.__kangenticTestModules`, `window.__monaco`, the terminal trace
 * and the dev-only settings. React is its development build under StrictMode, as on the dev
 * server. What a build cannot keep is `import.meta.hot` and source-path URLs, which is why a few
 * specs still take the dev server (tests/ui/dev-server.ts).
 *
 * CI runs this before the UI shards and sets KANGENTIC_UI_BUNDLE=1, which playwright.config.ts
 * reads to serve the bundle. Locally the UI tier stays on the dev server unless that flag is set:
 * `npm run test:ui:bundle` builds and runs the CI way.
 *
 * Usage: node scripts/build-ui-bundle.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where the bundle is written, repo-relative. `dist/` is gitignored and outside what a release packs. */
export const UI_BUNDLE_DIRECTORY = 'dist/ui-bundle';

/** Globals the specs reach the app through. Each exists only in a development build. */
export const REQUIRED_TEST_HOOKS = ['__zustandStores', '__kangenticTestModules'];

/** The hooks no emitted script mentions. A production-shaped build drops every one of them. */
export function missingTestHooks(bundleDirectory, hooks = REQUIRED_TEST_HOOKS) {
  const assetsDirectory = path.join(bundleDirectory, 'assets');
  if (!fs.existsSync(assetsDirectory)) return [...hooks];
  const scripts = fs.readdirSync(assetsDirectory)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(assetsDirectory, name), 'utf8'));
  return hooks.filter((hook) => !scripts.some((script) => script.includes(hook)));
}

export async function buildUiBundle() {
  // Before vite loads. Its config resolution keeps a NODE_ENV that is already set and defaults a
  // build to production otherwise, which would compile the test hooks out.
  process.env.NODE_ENV = 'development';
  const { build } = await import('vite');
  const bundleDirectory = path.join(REPO_ROOT, UI_BUNDLE_DIRECTORY);
  const startedAt = Date.now();
  await build({
    configFile: path.join(REPO_ROOT, 'vite.config.mts'),
    mode: 'development',
    base: '/',
    logLevel: 'warn',
    build: {
      outDir: bundleDirectory,
      emptyOutDir: true,
      // Unminified with no maps: the specs read function and component names the way the dev
      // server shows them, and nothing downloads this over a network.
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
    },
  });
  const missing = missingTestHooks(bundleDirectory);
  if (missing.length > 0) {
    throw new Error(
      `[ui-bundle] The bundle in ${UI_BUNDLE_DIRECTORY} has no ${missing.join(' or ')}, so it was built without `
      + 'the development flags and nearly every UI spec would fail to reach the app. Check that NODE_ENV '
      + 'is development and the mode is not production.',
    );
  }
  console.log(`[ui-bundle] built ${UI_BUNDLE_DIRECTORY} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

if (isEntrypoint(import.meta.url)) {
  await buildUiBundle();
}
