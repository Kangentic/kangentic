const fs = require('fs');
const path = require('path');

/**
 * Proves a Sentry sourcemap upload took in every bundle it was meant to.
 *
 * The bundler plugins only call `logger.warn` when an upload matches nothing, which
 * never reaches `errorHandler`, and a single bundle with no debug id or no map drops
 * out at debug level while the build still logs "Successfully uploaded". Reading those
 * lines would be a string match that goes blind on the next rewording, and it would
 * miss a partial upload. So this counts the positive case instead: a ledger entry
 * exists only when the plugin reached a bundle and found its map, and a bundle with no
 * entry fails the build, whatever the reason the plugin skipped it.
 *
 * The plugin's upload deals in cwd-relative or absolute paths depending on the bundler,
 * so everything here compares `path.resolve`d paths.
 *
 * See .claude/rules/release-gates-fail-loudly.md.
 */

// Starts `sentry-` because demo/vite.config.mts drops plugins by that prefix. The web demo
// has no upload, so a gate that outlived the filter would fail its build.
const GATE_PLUGIN_NAME = 'sentry-upload-gate';

/**
 * One ledger per Sentry plugin, shared with the gate that follows it. Both build halves
 * run in one process and load this one module, so a module-level ledger would let a
 * bundle from one half answer for the other.
 *
 * `resolveSourceMap` goes in the plugin's `sourcemaps` options. The plugin calls it
 * once per bundle, and only after finding that bundle's debug id. Returning undefined
 * leaves the plugin's own map search as it was, so this only observes. It is the
 * hook to use because the stronger signal, `rewriteSources`, replaces the plugin's
 * default rewrite, which is not exported.
 */
function createSourcemapUploadLedger() {
  const prepared = new Set();
  return {
    resolveSourceMap(bundlePath) {
      const resolvedPath = path.resolve(bundlePath);
      if (fs.existsSync(`${resolvedPath}.map`)) prepared.add(resolvedPath);
      return undefined;
    },
    has(bundlePath) {
      return prepared.has(path.resolve(bundlePath));
    },
  };
}

function unpreparedBundlesError(prefix, bundlePaths) {
  return new Error(
    `${prefix} Refusing to ship: the Sentry upload took in no sourcemap for `
    + `${bundlePaths.join(', ')}. Its stack traces would arrive minified and unreadable, and the `
    + 'plugin only warns about this, or says nothing at all. Check that the bundler still emits a '
    + 'map beside each bundle, and that the build runs from the repo root, since the plugin globs '
    + 'relative to the working directory.',
  );
}

/**
 * Goes after the Sentry plugin in the esbuild `plugins` array: esbuild runs `onEnd`
 * callbacks in order, so this reads the ledger once the upload has finished.
 *
 * Takes its bundles from each build's metafile, so a new esbuild entry is covered with
 * no list to keep in step. A build that already failed is left alone, so a rejected
 * upload reports its own error rather than this one.
 */
function createEsbuildUploadGate(ledger) {
  return {
    name: GATE_PLUGIN_NAME,
    setup({ onEnd }) {
      onEnd((result) => {
        if (result.errors.length > 0) return;
        const bundles = Object.keys(result.metafile?.outputs ?? {}).filter((output) => output.endsWith('.js'));
        if (bundles.length === 0) {
          throw new Error(
            '[build] Refusing to ship: esbuild reported no JavaScript output, so the Sentry upload '
            + 'gate has nothing to check. The Sentry plugin turns the metafile on; has it been removed?',
          );
        }
        const unprepared = bundles.filter((bundle) => !ledger.has(bundle));
        if (unprepared.length > 0) throw unpreparedBundlesError('[build]', unprepared);
        console.log(`[build] Sentry sourcemaps: uploaded ${bundles.join(', ')}`);
      });
    },
  };
}

/**
 * Goes after the Sentry plugin in Vite's `plugins` array, and runs as the last, sequential
 * `writeBundle`, because `writeBundle` is where the Sentry plugin's own upload runs. So it
 * reads the ledger once the upload has finished, and a rejected upload never reaches it and
 * reports its own error. Not `closeBundle`: that runs after a failed write too, with no
 * error passed in, and a throw there replaces the upload's real error.
 *
 * Holds every chunk the bundler wrote a map for to the ledger, and every entry chunk
 * whether it has one or not. Not every JS file:
 * - Worker bundles are assets from a separate pipeline. They have maps but never get a
 *   debug id, so the plugin skips them by design.
 * - Rolldown writes no map for the chunks holding only its own generated code
 *   (`rolldown-runtime`, `preload-helper`), since they have no sources to map to.
 * The entry chunks are the control: with maps turned off the bundle holds no map at all,
 * so nothing else is left to fail.
 */
function createViteUploadGate(ledger) {
  return {
    name: GATE_PLUGIN_NAME,
    apply: 'build',
    writeBundle: {
      order: 'post',
      sequential: true,
      handler(outputOptions, bundle) {
        const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
        if (chunks.length === 0) {
          throw new Error(
            '[vite] Refusing to ship: the renderer build wrote no chunks, so the Sentry upload gate '
            + 'has nothing to check.',
          );
        }
        const required = chunks.filter((chunk) => chunk.isEntry || `${chunk.fileName}.map` in bundle);
        const unprepared = required.filter((chunk) => !ledger.has(path.resolve(outputOptions.dir, chunk.fileName)));
        if (unprepared.length > 0) {
          throw unpreparedBundlesError('[vite]', unprepared.map((chunk) => chunk.fileName));
        }
        console.log(`[vite] Sentry sourcemaps: uploaded ${required.length} of ${chunks.length} chunks`);
      },
    },
  };
}

module.exports = {
  createSourcemapUploadLedger,
  createEsbuildUploadGate,
  createViteUploadGate,
};
