const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Release gate for every packaged utilityProcess worker forked from the
 * `app.asar.unpacked` tree (the embed worker, and the dictation worker added
 * for DESKTOP-X).
 *
 * Each such worker keeps its native/heavy dependency external, so at runtime
 * it resolves that package, and everything the package requires, with plain
 * Node resolution from real directories. A dependency that ships only inside
 * the asar is invisible to it, and the worker then dies at module load with
 * `Cannot find module` on every fork. That is exactly what shipped in 0.38.0
 * and 0.39.0 (DESKTOP-6, DESKTOP-H): `onnxruntime-common` and `sharp` were in
 * the asar and not in `asarUnpack`, and nothing in the build ever tried to
 * load the embed worker's closure from the unpacked tree.
 *
 * This gate does that load, with plain Node, against the tree electron-builder
 * just produced, once per worker (`build/afterPack.js` calls
 * `verifyUnpackedWorkerModules` once with each worker's `moduleNames`/
 * `probeDependencies` pair). Two things make it honest:
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
 * The dictation worker's esbuild external (src/main/transcription/dictation-worker.ts,
 * see DESKTOP-X). `sherpa-onnx-node` resolves its native binding by a
 * RELATIVE require (`../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`,
 * addon.js), not a bare specifier, so loading it exercises both packages
 * (itself and its platform sibling) with no separate probe dependency to
 * list - a missing platform package fails the same `require(target)` call
 * this gate already makes.
 */
const DICTATION_WORKER_EXTERNALS = ['sherpa-onnx-node'];
const DICTATION_WORKER_PROBE_DEPENDENCIES = [];

/**
 * The retrieval worker's esbuild external (src/main/retrieval/worker/retrieval-worker.ts).
 * better-sqlite3 loads its native addon through `bindings`, which requires
 * `file-uri-to-path`, so both are probed. Requiring better-sqlite3's entry does
 * not load the addon (the Database constructor does), so this resolution probe
 * runs under plain Node; `verifyRetrievalWorkerLoads` below loads the addon
 * for real under the packaged Electron binary.
 */
const RETRIEVAL_WORKER_EXTERNALS = ['better-sqlite3'];
const RETRIEVAL_WORKER_PROBE_DEPENDENCIES = ['bindings', 'file-uri-to-path'];

/**
 * The pty host's esbuild externals (src/main/pty/host/pty-host-entry.ts): every
 * node-pty instance, better-sqlite3 for the raw transcripts it writes, and
 * koffi for the Windows and macOS process readers (src/main/pty/process-tag/).
 * better-sqlite3's closure is the retrieval worker's, already probed; this
 * resolves node-pty and loads koffi's per-platform binary, and
 * `verifyPtyHostLoads` spawns a real process with node-pty under the packaged
 * Electron binary.
 */
const PTY_HOST_EXTERNALS = ['node-pty', 'koffi'];
const PTY_HOST_PROBE_DEPENDENCIES = [];

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
          'The packaged worker that imports it would exit 1 on every fork. ' +
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

/**
 * The script the retrieval load probe runs under the packaged Electron binary.
 * Fenced to the unpacked root like `buildProbeScript`, then it does what the
 * worker does at startup: opens a database with the unpacked better-sqlite3
 * (Electron's ABI, which plain Node cannot load) and loads the unpacked
 * sqlite-vec binary into it.
 */
function buildRetrievalLoadScript(unpackedRoot) {
  return [
    "const Module = require('module');",
    "const path = require('path');",
    "const fs = require('fs');",
    `const root = fs.realpathSync(${JSON.stringify(unpackedRoot)});`,
    'const originalNodeModulePaths = Module._nodeModulePaths;',
    'Module._nodeModulePaths = function fencedNodeModulePaths(from) {',
    '  return originalNodeModulePaths.call(Module, from).filter((candidate) => candidate.startsWith(root));',
    '};',
    'Module.globalPaths = [];',
    "const modulesDir = path.join(root, 'node_modules');",
    "const Database = require(path.join(modulesDir, 'better-sqlite3'));",
    "const db = new Database(':memory:');",
    "const vecPackage = fs.readdirSync(modulesDir).find((name) => name.startsWith('sqlite-vec-'));",
    "if (!vecPackage) throw new Error('no sqlite-vec platform package in ' + modulesDir);",
    'const vecBinary = fs.readdirSync(path.join(modulesDir, vecPackage)).find((name) => /^vec0\\.(dll|so|dylib)$/.test(name));',
    "if (!vecBinary) throw new Error('no vec0 binary in ' + vecPackage);",
    'db.loadExtension(path.join(modulesDir, vecPackage, vecBinary));',
    "process.stdout.write('better-sqlite3 opened, sqlite-vec ' + db.prepare('SELECT vec_version() AS version').get().version + ' loaded\\n');",
    'db.close();',
  ].join('\n');
}

/**
 * Run the retrieval load probe with the packaged Electron binary as Node
 * (`ELECTRON_RUN_AS_NODE`), which is possible only before `flipFuses` turns
 * that off, so afterPack calls this first. Throws with the child's stderr on
 * failure; logs the verified branch on success.
 */
function verifyRetrievalWorkerLoads({ unpackedRoot, electronBinaryPath, spawn = execFileSync, log = console.log }) {
  let stdout;
  try {
    stdout = spawn(electronBinaryPath, ['-e', buildRetrievalLoadScript(unpackedRoot)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (error) {
    const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `[afterPack] the retrieval worker's native modules do not load from ${unpackedRoot} under ${electronBinaryPath}. ` +
        'The packaged retrieval worker could not open a project database. ' +
        'Check better-sqlite3, bindings, file-uri-to-path and sqlite-vec-* in `asarUnpack` in electron-builder.yml.\n' +
        (stderr || String(error)),
    );
  }
  log(`[afterPack] retrieval worker: ${String(stdout).trim()}`);
}

/**
 * The script the pty host load probe runs under the packaged Electron binary:
 * fenced to the packaged tree, it does what the host does for every terminal.
 * It loads node-pty from where the host loads it and spawns a short process,
 * reading its output back. On Windows and Linux that is the unpacked tree, so
 * the native binding and ConPTY's conout worker thread load from real
 * directories. On macOS the host is forked from inside the asar (node-pty's
 * spawn-helper lookup rewrites `app.asar` to `app.asar.unpacked` in its own
 * path, see `ptyHostEntryPath`), so the probe loads it through the asar too,
 * and a spawn proves the helper was found.
 */
function buildPtyHostLoadScript(unpackedRoot) {
  return [
    "const Module = require('module');",
    "const path = require('path');",
    "const fs = require('fs');",
    `const root = fs.realpathSync(${JSON.stringify(unpackedRoot)});`,
    "const asarRoot = path.join(path.dirname(root), 'app.asar');",
    "const loadThroughAsar = process.platform === 'darwin' && path.basename(root) === 'app.asar.unpacked' && fs.existsSync(asarRoot);",
    // `app.asar.unpacked` starts with `app.asar`, so this fence admits both.
    'const fence = loadThroughAsar ? asarRoot : root;',
    'const originalNodeModulePaths = Module._nodeModulePaths;',
    'Module._nodeModulePaths = function fencedNodeModulePaths(from) {',
    '  return originalNodeModulePaths.call(Module, from).filter((candidate) => candidate.startsWith(fence));',
    '};',
    'Module.globalPaths = [];',
    "const pty = require(path.join(loadThroughAsar ? asarRoot : root, 'node_modules', 'node-pty'));",
    "const isWindows = process.platform === 'win32';",
    "const marker = 'pty-host-probe';",
    "const term = pty.spawn(isWindows ? 'cmd.exe' : '/bin/sh', isWindows ? ['/c', 'echo ' + marker] : ['-c', 'echo ' + marker], { name: 'xterm-256color', cols: 80, rows: 24, cwd: root, env: process.env });",
    "let output = '';",
    'term.onData((data) => { output += data; });',
    "const timer = setTimeout(() => { process.stderr.write('node-pty spawned but the process never finished; output: ' + JSON.stringify(output)); process.exit(1); }, 20000);",
    'term.onExit(({ exitCode }) => {',
    '  clearTimeout(timer);',
    "  if (!output.includes(marker)) { process.stderr.write('node-pty read no output back: ' + JSON.stringify(output)); process.exit(1); }",
    "  process.stdout.write('node-pty spawned a process and read its output (exit ' + exitCode + ')\\n');",
    '  process.exit(0);',
    '});',
  ].join('\n');
}

/**
 * Run the pty host load probe with the packaged Electron binary as Node, before
 * `flipFuses` turns `ELECTRON_RUN_AS_NODE` off. Throws with the child's stderr
 * on failure; logs the verified branch on success.
 */
function verifyPtyHostLoads({ unpackedRoot, electronBinaryPath, spawn = execFileSync, log = console.log }) {
  let stdout;
  try {
    stdout = spawn(electronBinaryPath, ['-e', buildPtyHostLoadScript(unpackedRoot)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (error) {
    const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `[afterPack] the pty host cannot run a terminal from ${unpackedRoot} under ${electronBinaryPath}. ` +
        'The packaged app would spawn no terminals. Check node-pty in `asarUnpack` in electron-builder.yml.\n' +
        (stderr || String(error)),
    );
  }
  log(`[afterPack] pty host: ${String(stdout).trim()}`);
}

module.exports = {
  EMBED_WORKER_EXTERNALS,
  EMBED_WORKER_PROBE_DEPENDENCIES,
  DICTATION_WORKER_EXTERNALS,
  DICTATION_WORKER_PROBE_DEPENDENCIES,
  RETRIEVAL_WORKER_EXTERNALS,
  RETRIEVAL_WORKER_PROBE_DEPENDENCIES,
  PTY_HOST_EXTERNALS,
  PTY_HOST_PROBE_DEPENDENCIES,
  buildProbeScript,
  buildRetrievalLoadScript,
  buildPtyHostLoadScript,
  verifyUnpackedWorkerModules,
  verifyRetrievalWorkerLoads,
  verifyPtyHostLoads,
};
