const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Release gate for the packaged embed worker.
 *
 * The worker (`.vite/build/embed-worker.js`) is forked from the
 * `app.asar.unpacked` tree and keeps `@huggingface/transformers` external, so
 * at runtime it resolves that package, and everything the package requires,
 * with plain Node resolution from real directories. A dependency that ships
 * only inside the asar is invisible to it, and the worker then dies at module
 * load with `Cannot find module` on every fork. That is exactly what shipped
 * in 0.38.0 and 0.39.0 (DESKTOP-6, DESKTOP-H): `onnxruntime-common` and
 * `sharp` were in the asar and not in `asarUnpack`, and nothing in the build
 * ever tried to load the worker's closure from the unpacked tree.
 *
 * This gate does that load, with plain Node, against the tree electron-builder
 * just produced. Two things make it honest:
 *
 * - Resolution is FENCED to the unpacked root. The output directory sits under
 *   the repo, so an unfenced `require` would walk up into the repo's own
 *   `node_modules`, find every missing package there, and pass a tree that
 *   fails the moment it is installed anywhere else.
 * - It runs in a child `node`, not in electron-builder's process, so a native
 *   binding it loads (onnxruntime, sharp) cannot poison the build, and its
 *   stderr (the `Cannot find module` text) is what the thrown error carries.
 *
 * Node, not Electron: the fuse flip that disables `ELECTRON_RUN_AS_NODE` runs
 * in the same afterPack hook, and the failure class this guards is module
 * resolution, which does not depend on the runtime. Every release platform
 * builds on its native arch (see .github/workflows/release.yml), so the native
 * bindings load here too; an arch mismatch surfaces as a load failure, which
 * is the loud outcome .claude/rules/release-gates-fail-loudly.md asks for.
 */

/** The worker's esbuild externals (scripts/build.js `external`, minus the ones
 *  the worker never imports). tests/unit/verify-unpacked-worker.test.ts pins
 *  this against the worker's real imports and the build config. */
const EMBED_WORKER_EXTERNALS = ['@huggingface/transformers'];

/** Bare specifiers `transformers.node.cjs` requires at module scope that live
 *  in their own packages. Printed with their resolved paths on success, so the
 *  build log shows where each one came from. */
const EMBED_WORKER_PROBE_DEPENDENCIES = ['onnxruntime-common', 'onnxruntime-node', 'sharp'];

/**
 * The script the probe child runs. Everything it needs is inlined, since it is
 * handed to `node -e` and cannot import from this file.
 */
function buildProbeScript(unpackedRoot, moduleName, probeDependencies) {
  return [
    "const Module = require('module');",
    "const path = require('path');",
    "const fs = require('fs');",
    // Node records a loaded module's REAL path, so the fence below has to
    // compare against the real path too, or a symlinked or junctioned output
    // directory (macOS's /var -> /private/var tmpdir, say) fails every lookup.
    `const root = fs.realpathSync(${JSON.stringify(unpackedRoot)});`,
    // Fence: keep only lookup directories under the unpacked root, and drop
    // the global ones (NODE_PATH, ~/.node_modules), so the child sees the
    // packaged tree the way an installed app does.
    'const originalNodeModulePaths = Module._nodeModulePaths;',
    'Module._nodeModulePaths = function fencedNodeModulePaths(from) {',
    '  return originalNodeModulePaths.call(Module, from).filter((candidate) => candidate.startsWith(root));',
    '};',
    'Module.globalPaths = [];',
    `const target = path.join(root, 'node_modules', ${JSON.stringify(moduleName)});`,
    'require(target);',
    "const requireFromTarget = Module.createRequire(path.join(target, 'package.json'));",
    `for (const dependency of ${JSON.stringify(probeDependencies)}) {`,
    "  process.stdout.write(dependency + ' -> ' + requireFromTarget.resolve(dependency) + '\\n');",
    '}',
  ].join('\n');
}

/**
 * Load each of `moduleNames` from `<unpackedRoot>/node_modules` in a child
 * Node fenced to that root. Throws (with the child's stderr) on the first
 * failure; logs the verified branch for each success, so the build log always
 * says which way the gate went.
 */
function verifyUnpackedWorkerModules({
  unpackedRoot,
  moduleNames = EMBED_WORKER_EXTERNALS,
  probeDependencies = EMBED_WORKER_PROBE_DEPENDENCIES,
  spawn = execFileSync,
  log = console.log,
}) {
  const runtime = `node ${process.version}, ${process.arch}`;
  for (const moduleName of moduleNames) {
    const script = buildProbeScript(unpackedRoot, moduleName, probeDependencies);
    let stdout;
    try {
      stdout = spawn(process.execPath, ['-e', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
    } catch (error) {
      const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
      throw new Error(
        `[afterPack] ${moduleName} does not load from the unpacked tree at ${unpackedRoot} (${runtime}). ` +
          'The packaged embed worker would exit 1 on every fork. ' +
          'Add the missing package to both `files` and `asarUnpack` in electron-builder.yml.\n' +
          (stderr || String(error)),
      );
    }
    log(`[afterPack] ${moduleName} loads from the unpacked tree (${runtime})`);
    for (const line of String(stdout).split('\n').filter((entry) => entry.length > 0)) {
      log(`[afterPack]   ${line}`);
    }
  }
}

module.exports = {
  EMBED_WORKER_EXTERNALS,
  EMBED_WORKER_PROBE_DEPENDENCIES,
  buildProbeScript,
  verifyUnpackedWorkerModules,
};
