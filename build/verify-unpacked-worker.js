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
 * better-sqlite3 13 loads its Node-API addon from its own
 * `prebuilds/<platform>-<arch>.node` (lib/binding.js), with no helper package
 * to resolve, so there is nothing to probe beside it. Requiring its entry does
 * not load the addon (the Database constructor does), so this resolution probe
 * runs under plain Node; `verifyRetrievalWorkerLoads` below loads the addon
 * for real under the packaged Electron binary.
 */
const RETRIEVAL_WORKER_EXTERNALS = ['better-sqlite3'];
const RETRIEVAL_WORKER_PROBE_DEPENDENCIES = [];

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
 * worker does at startup: opens a database with the unpacked better-sqlite3,
 * whose prebuild afterPack has just narrowed to the target's, and loads the
 * unpacked sqlite-vec binary into it. It runs under the packaged Electron so
 * the addon is proven against the runtime that ships, not the build's Node.
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
    // Loaded without its suffix, as `loadVecExtensionFrom` does, so the probe
    // proves the form that ships: SQLite's retry appends the suffix (and on
    // Windows LoadLibraryW appends `.dll` itself).
    "db.loadExtension(path.join(modulesDir, vecPackage, vecBinary.replace(/\\.(dll|so|dylib)$/, '')));",
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
        'Check better-sqlite3 (and its prebuilds/ for this platform) and sqlite-vec-* in `asarUnpack` in electron-builder.yml.\n' +
        (stderr || String(error)),
    );
  }
  log(`[afterPack] retrieval worker: ${String(stdout).trim()}`);
}

/**
 * The loaded MSVC runtime DLLs (from `process.report`'s `sharedObjects`) that did
 * NOT come from `bindingDir`. Self-contained, because `buildEmbedRuntimeLoadScript`
 * inlines its source into the probe. Windows paths come back with a `\\?\` prefix
 * and any case, so both sides are normalized before they are compared.
 */
function foreignMsvcRuntimeModules(sharedObjects, bindingDir) {
  const normalize = (modulePath) => String(modulePath).replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase();
  const expectedDir = normalize(bindingDir).replace(/\\+$/, '');
  return sharedObjects.filter((modulePath) => {
    const normalized = normalize(modulePath);
    const separator = normalized.lastIndexOf('\\');
    const name = normalized.slice(separator + 1);
    if (!/^(msvcp140(_\w+)?|vcruntime140(_\w+)?|concrt140|vccorlib140|vcomp140)\.dll$/.test(name)) return false;
    return normalized.slice(0, separator) !== expectedDir;
  });
}

/**
 * The script the embed runtime load probe runs under the packaged Electron binary.
 * Fenced to the unpacked root, it requires onnxruntime-node the way the embed
 * worker does (through transformers, which requires it at module scope), which
 * loads `onnxruntime_binding.node`, and checks the binding is among the loaded
 * modules.
 *
 * On Windows it also proves the MSVC runtime came from beside the binding
 * (DESKTOP-38). A build machine has the runtime in System32, so a load alone
 * would pass a package that lacks it; `process.report` names the file each DLL was
 * loaded from, and any runtime DLL loaded from anywhere else fails the probe.
 */
function buildEmbedRuntimeLoadScript(unpackedRoot) {
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
    "require(path.join(root, 'node_modules', 'onnxruntime-node'));",
    "const bindingDir = path.join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', process.platform, process.arch);",
    'const sharedObjects = process.report.getReport().sharedObjects;',
    "if (!sharedObjects.some((modulePath) => /onnxruntime_binding\\.node$/i.test(modulePath))) {",
    "  process.stderr.write('onnxruntime-node loaded but onnxruntime_binding.node is not among the loaded modules');",
    '  process.exit(1);',
    '}',
    "let runtimeLine = 'MSVC runtime not used on ' + process.platform;",
    "if (process.platform === 'win32') {",
    `  const foreignMsvcRuntimeModules = ${foreignMsvcRuntimeModules.toString()};`,
    '  const foreign = foreignMsvcRuntimeModules(sharedObjects, bindingDir);',
    '  if (foreign.length > 0) {',
    "    process.stderr.write('the MSVC runtime loaded from outside ' + bindingDir + ': ' + foreign.join(', '));",
    '    process.exit(1);',
    '  }',
    "  runtimeLine = 'MSVC runtime loaded from beside the binding';",
    '}',
    "process.stdout.write('onnxruntime_binding.node loaded; ' + runtimeLine + '\\n');",
  ].join('\n');
}

/**
 * Run the embed runtime load probe with the packaged Electron binary as Node,
 * before `flipFuses` turns `ELECTRON_RUN_AS_NODE` off. Throws with the child's
 * stderr on failure; logs the verified branch on success.
 */
function verifyEmbedRuntimeLoads({ unpackedRoot, electronBinaryPath, spawn = execFileSync, log = console.log }) {
  let stdout;
  try {
    stdout = spawn(electronBinaryPath, ['-e', buildEmbedRuntimeLoadScript(unpackedRoot)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (error) {
    const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `[afterPack] onnxruntime-node's binding does not load from ${unpackedRoot} under ${electronBinaryPath}. ` +
        'The packaged embed worker would exit 1 on every fork. On Windows, check that build/msvc-runtime.js ' +
        'staged the MSVC runtime beside onnxruntime_binding.node.\n' +
        (stderr || String(error)),
    );
  }
  log(`[afterPack] embed runtime: ${String(stdout).trim()}`);
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
 *
 * On Windows and macOS, where the host's process readers use koffi, it also
 * loads koffi from the same place and makes one real native call, the
 * process's own id, checked against `process.pid`. Linux never loads koffi,
 * and the line it prints says so.
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
    "let koffiLine = 'koffi not used on ' + process.platform + ', skipped';",
    "if (process.platform === 'win32' || process.platform === 'darwin') {",
    '  try {',
    "    const koffi = require(path.join(loadThroughAsar ? asarRoot : root, 'node_modules', 'koffi'));",
    "    const ownPid = process.platform === 'win32'",
    "      ? koffi.load('kernel32.dll').func('uint32 __stdcall GetCurrentProcessId()')()",
    "      : koffi.load('/usr/lib/libSystem.B.dylib').func('int getpid()')();",
    "    if (ownPid !== process.pid) throw new Error('its native call returned ' + ownPid + ', not this process id ' + process.pid);",
    "    koffiLine = 'koffi loaded and its native call returned this process id';",
    '  } catch (error) {',
    "    process.stderr.write('koffi did not load or call: ' + (error && error.stack ? error.stack : String(error)));",
    '    process.exit(1);',
    '  }',
    '}',
    "const isWindows = process.platform === 'win32';",
    "const marker = 'pty-host-probe';",
    "const term = pty.spawn(isWindows ? 'cmd.exe' : '/bin/sh', isWindows ? ['/c', 'echo ' + marker] : ['-c', 'echo ' + marker], { name: 'xterm-256color', cols: 80, rows: 24, cwd: root, env: process.env });",
    "let output = '';",
    'term.onData((data) => { output += data; });',
    "const timer = setTimeout(() => { process.stderr.write('node-pty spawned but the process never finished; output: ' + JSON.stringify(output)); process.exit(1); }, 20000);",
    'term.onExit(({ exitCode }) => {',
    '  clearTimeout(timer);',
    "  if (!output.includes(marker)) { process.stderr.write('node-pty read no output back: ' + JSON.stringify(output)); process.exit(1); }",
    "  process.stdout.write('node-pty spawned a process and read its output (exit ' + exitCode + '); ' + koffiLine + '\\n');",
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
        'The packaged app would spawn no terminals, or on Windows and macOS find no process a task left running. ' +
        'Check node-pty, koffi and @koromix/koffi-* in `asarUnpack` in electron-builder.yml.\n' +
        (stderr || String(error)),
    );
  }
  log(`[afterPack] pty host: ${String(stdout).trim()}`);
}

/**
 * The script the spawn worker probe runs under the packaged Electron binary:
 * it starts the pty host's spawn worker (`.vite/build/pty-host-spawn-worker.js`,
 * a worker thread, unpacked because Node's own loader reads its file) the way
 * the host does, asks it for one one-shot run, and reads the run's output back.
 * Every git, gh and agent CLI run the host makes for main starts in it.
 */
function buildSpawnWorkerLoadScript(unpackedRoot) {
  return [
    "const path = require('path');",
    "const fs = require('fs');",
    "const { Worker } = require('worker_threads');",
    `const root = fs.realpathSync(${JSON.stringify(unpackedRoot)});`,
    "const workerPath = path.join(root, '.vite', 'build', 'pty-host-spawn-worker.js');",
    "const marker = 'spawn-worker-probe';",
    'const worker = new Worker(workerPath, { workerData: { relaySlowSpans: false } });',
    "const timer = setTimeout(() => { process.stderr.write('the spawn worker started but never answered its run'); process.exit(1); }, 20000);",
    "worker.on('error', (error) => { process.stderr.write('the spawn worker failed: ' + (error && error.stack ? error.stack : String(error))); process.exit(1); });",
    "worker.on('message', (message) => {",
    "  if (!message || message.type !== 'execResult') return;",
    '  clearTimeout(timer);',
    "  if (!message.result.ok || !message.result.stdout.includes(marker)) { process.stderr.write('the spawn worker ran no child: ' + JSON.stringify(message.result)); process.exit(1); }",
    "  process.stdout.write('the spawn worker started and ran a child\\n');",
    '  process.exit(0);',
    '});',
    "worker.postMessage({ type: 'exec', id: 1, request: { kind: 'exec', command: 'echo ' + marker, options: {} } });",
  ].join('\n');
}

/**
 * Run the spawn worker probe with the packaged Electron binary as Node, before
 * `flipFuses` turns `ELECTRON_RUN_AS_NODE` off. Throws with the child's stderr
 * on failure; logs the verified branch on success.
 */
function verifySpawnWorkerLoads({ unpackedRoot, electronBinaryPath, spawn = execFileSync, log = console.log }) {
  let stdout;
  try {
    stdout = spawn(electronBinaryPath, ['-e', buildSpawnWorkerLoadScript(unpackedRoot)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (error) {
    const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `[afterPack] the pty host's spawn worker cannot run a child from ${unpackedRoot} under ${electronBinaryPath}. ` +
        'The packaged host would fall back to starting every git and agent CLI run on its terminal thread. ' +
        'Check .vite/build/pty-host-spawn-worker.js in `asarUnpack` in electron-builder.yml.\n' +
        (stderr || String(error)),
    );
  }
  log(`[afterPack] pty host spawn worker: ${String(stdout).trim()}`);
}

/**
 * The script the checkpoint thread probe runs under the packaged Electron
 * binary: it writes a WAL into a temp database with the unpacked better-sqlite3,
 * starts the retrieval worker's checkpoint thread
 * (`.vite/build/retrieval-checkpoint-thread.js`, a worker thread that loads
 * better-sqlite3 itself) the way the worker does, asks it for one PASSIVE
 * checkpoint, and closes the thread's connection. A thread that cannot load the
 * addon would leave every checkpoint on the worker's request loop.
 */
function buildCheckpointThreadLoadScript(unpackedRoot) {
  return [
    "const path = require('path');",
    "const fs = require('fs');",
    "const os = require('os');",
    "const { Worker } = require('worker_threads');",
    `const root = fs.realpathSync(${JSON.stringify(unpackedRoot)});`,
    "const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));",
    "const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-checkpoint-probe-'));",
    "const dbPath = path.join(directory, 'probe.db');",
    'const writer = new Database(dbPath);',
    "writer.pragma('journal_mode = WAL');",
    "writer.pragma('wal_autocheckpoint = 0');",
    "writer.exec('CREATE TABLE probe (value TEXT)');",
    "writer.prepare('INSERT INTO probe (value) VALUES (?)').run('checkpoint-thread-probe');",
    "const finish = (code, text) => { try { writer.close(); fs.rmSync(directory, { recursive: true, force: true }); } catch { /* temp dir */ } (code === 0 ? process.stdout : process.stderr).write(text + '\\n'); process.exit(code); };",
    "const worker = new Worker(path.join(root, '.vite', 'build', 'retrieval-checkpoint-thread.js'));",
    "const timer = setTimeout(() => finish(1, 'the checkpoint thread started but never answered its checkpoint'), 20000);",
    "worker.on('error', (error) => finish(1, 'the checkpoint thread failed: ' + (error && error.stack ? error.stack : String(error))));",
    "worker.on('message', (message) => {",
    "  if (!message || message.type !== 'result') return;",
    '  if (message.id === 1) {',
    "    if (!message.ok || !message.row || message.row.checkpointed < 1) { clearTimeout(timer); finish(1, 'the checkpoint thread copied nothing: ' + JSON.stringify(message)); return; }",
    "    worker.postMessage({ type: 'close', id: 2, dbPath });",
    '    return;',
    '  }',
    '  clearTimeout(timer);',
    "  if (!message.ok) { finish(1, 'the checkpoint thread did not close its connection: ' + JSON.stringify(message)); return; }",
    "  finish(0, 'the checkpoint thread loaded better-sqlite3 and checkpointed a WAL');",
    '});',
    "worker.postMessage({ type: 'checkpoint', id: 1, dbPath });",
  ].join('\n');
}

/**
 * Run the checkpoint thread probe with the packaged Electron binary as Node,
 * before `flipFuses` turns `ELECTRON_RUN_AS_NODE` off. Throws with the child's
 * stderr on failure; logs the verified branch on success.
 */
function verifyRetrievalCheckpointThreadLoads({ unpackedRoot, electronBinaryPath, spawn = execFileSync, log = console.log }) {
  let stdout;
  try {
    stdout = spawn(electronBinaryPath, ['-e', buildCheckpointThreadLoadScript(unpackedRoot)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (error) {
    const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `[afterPack] the retrieval worker's checkpoint thread cannot checkpoint from ${unpackedRoot} under ${electronBinaryPath}. ` +
        'The packaged worker would run every WAL checkpoint on its request loop. ' +
        'Check .vite/build/retrieval-checkpoint-thread.js and better-sqlite3 in `asarUnpack` in electron-builder.yml.\n' +
        (stderr || String(error)),
    );
  }
  log(`[afterPack] retrieval checkpoint thread: ${String(stdout).trim()}`);
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
  buildSpawnWorkerLoadScript,
  buildCheckpointThreadLoadScript,
  buildEmbedRuntimeLoadScript,
  foreignMsvcRuntimeModules,
  verifyUnpackedWorkerModules,
  verifyEmbedRuntimeLoads,
  verifyRetrievalWorkerLoads,
  verifyPtyHostLoads,
  verifySpawnWorkerLoads,
  verifyRetrievalCheckpointThreadLoads,
};
