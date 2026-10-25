const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');
const {
  verifyUnpackedWorkerModules,
  verifyRetrievalWorkerLoads,
  verifyPtyHostLoads,
  verifySpawnWorkerLoads,
  DICTATION_WORKER_EXTERNALS,
  DICTATION_WORKER_PROBE_DEPENDENCIES,
  RETRIEVAL_WORKER_EXTERNALS,
  RETRIEVAL_WORKER_PROBE_DEPENDENCIES,
  PTY_HOST_EXTERNALS,
  PTY_HOST_PROBE_DEPENDENCIES,
} = require('./verify-unpacked-worker');
const { installSpawnHelper } = require('./install-spawn-helper');
// The targets the local embedding model has no build for, shared with the app
// (src/shared/embedding-runtime.ts), which reports the Knowledge Graph
// unavailable on them and never forks the embed worker there.
const EMBEDDING_RUNTIME_GAPS = require('../src/shared/embedding-runtime-gaps.json');

/**
 * Whether the embed worker probe can run on this target. The worker requires
 * onnxruntime-node at module scope, which loads
 * `bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`, and onnxruntime-node
 * ships no such binding for Intel macOS. There the probe would fail the package
 * over a worker the app never forks.
 *
 * Skips only a target that both lacks the binding AND is listed in
 * embedding-runtime-gaps.json, and says so. A target that lacks it without
 * being listed throws: packaging dropped onnxruntime-node's binaries, or a
 * version bump stopped shipping one, and either way the app would ship a
 * Knowledge Graph whose worker exits on every fork.
 *
 * @returns {'probe' | 'skip'}
 */
function embedWorkerProbePlan({ unpackedRoot, platform, targetArch, gaps = EMBEDDING_RUNTIME_GAPS, log = console.log }) {
  const target = `${platform}-${targetArch}`;
  const bindingPath = path.join(
    unpackedRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', platform, targetArch, 'onnxruntime_binding.node',
  );
  if (fs.existsSync(bindingPath)) return 'probe';
  if (gaps.includes(target)) {
    log(
      `[afterPack] embed worker: onnxruntime-node ships no ${target} binding, and ` +
        `src/shared/embedding-runtime-gaps.json lists ${target}, so the app reports the Knowledge Graph ` +
        'unavailable here and never forks the worker. Skipping the embed worker probe only.',
    );
    return 'skip';
  }
  throw new Error(
    `[afterPack] embed worker: onnxruntime-node has no ${target} binding at ${bindingPath}, and ` +
      `src/shared/embedding-runtime-gaps.json does not list ${target}. If packaging dropped it, check ` +
      "electron-builder.yml's files and asarUnpack for onnxruntime-node. If onnxruntime-node stopped " +
      'shipping it, list the target there so the Knowledge Graph reports itself unavailable.',
  );
}

/**
 * better-sqlite3 13 ships every platform's Node-API addon in one package
 * (`prebuilds/<platform>-<arch>.node`, plus `linuxmusl-*` for Alpine) and loads
 * the one matching the running process (`lib/binding.js`). Keep only the
 * target's: the rest are about 14 MB of binaries no installed copy can load.
 * Linux keeps the glibc build, since the deb and rpm targets are glibc systems.
 *
 * Throws when the target's prebuild is not there, rather than deleting every
 * prebuild and leaving the load probe to report a confusing failure later.
 * Logs which branch it took either way.
 */
function stripBetterSqlitePrebuilds({ unpackedRoot, platform, targetArch, log = console.log }) {
  const prebuildsDir = path.join(unpackedRoot, 'node_modules', 'better-sqlite3', 'prebuilds');
  if (!fs.existsSync(prebuildsDir)) {
    log(`[afterPack] better-sqlite3: no prebuilds directory at ${prebuildsDir}, nothing to strip`);
    return;
  }
  const keep = `${platform}-${targetArch}.node`;
  const entries = fs.readdirSync(prebuildsDir);
  if (!entries.includes(keep)) {
    throw new Error(
      `[afterPack] better-sqlite3 has no prebuild for ${platform}-${targetArch} in ${prebuildsDir} ` +
        `(found: ${entries.join(', ') || 'none'}). The packaged app could not open a database.`,
    );
  }
  const removed = entries.filter((entry) => entry !== keep);
  for (const entry of removed) {
    fs.rmSync(path.join(prebuildsDir, entry), { recursive: true, force: true });
  }
  log(`[afterPack] better-sqlite3: kept prebuilds/${keep}, removed ${removed.length} other prebuild(s)`);
}

/** How long `flipFusesWhenBinaryIdle` waits for the binary to be released: 40 tries, 250 ms apart. */
const FUSE_FLIP_BUSY_ATTEMPTS = 40;
const FUSE_FLIP_BUSY_DELAY_MS = 250;

/**
 * `flipFuses`, for a binary a probe has just run.
 *
 * The load probes above run a real process under the packaged Electron binary, and
 * `flipFuses` then opens that same file for writing. On Linux a write-open of an
 * executable fails with ETXTBSY for as long as any process still has it mapped to
 * run, and the kernel can release it a few milliseconds after the probe reports its
 * child's exit. The pty host probe's last line and the failure were 10 ms apart on
 * ubuntu-24.04-arm, where the package smoke job passed and then failed twice in a
 * row on the same code.
 *
 * Retries ONLY ETXTBSY, for about ten seconds, and then throws that same error, so
 * a binary something still holds fails the package as it did before. Any other
 * error, a fuse this config does not set included, is thrown at once.
 */
async function flipFusesWhenBinaryIdle(binaryPath, config, {
  flip = flipFuses,
  attempts = FUSE_FLIP_BUSY_ATTEMPTS,
  delayMs = FUSE_FLIP_BUSY_DELAY_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  log = console.log,
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await flip(binaryPath, config);
    } catch (error) {
      if (!error || error.code !== 'ETXTBSY' || attempt >= attempts) throw error;
      log(`[afterPack] ${binaryPath} is still busy after the probes (ETXTBSY), retrying (${attempt}/${attempts - 1})`);
      await sleep(delayMs);
    }
  }
}

module.exports = async function afterPack(context) {
  const productFilename = context.packager.appInfo.productFilename;
  const platform = context.electronPlatformName;
  let electronBinaryPath;
  if (platform === 'darwin') {
    electronBinaryPath = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  } else if (platform === 'win32') {
    electronBinaryPath = path.join(context.appOutDir, `${productFilename}.exe`);
  } else {
    // Linux: executable name comes from package.json "name" (lowercase),
    // not productName. electron-builder exposes it as executableName.
    const linuxExeName = context.packager.executableName;
    electronBinaryPath = path.join(context.appOutDir, linuxExeName);
  }

  // Resolve the framework directory (contains resources/, LICENSES.chromium.html, etc.)
  // macOS: <name>.app/Contents/  (resources dir is capitalized "Resources")
  // Windows/Linux: appOutDir directly (resources dir is lowercase "resources")
  const frameworkDir = platform === 'darwin'
    ? path.join(context.appOutDir, `${productFilename}.app`, 'Contents')
    : context.appOutDir;
  const resourcesDirName = platform === 'darwin' ? 'Resources' : 'resources';
  const unpackedRoot = path.join(frameworkDir, resourcesDirName, 'app.asar.unpacked');

  // Strip cross-platform prebuilds and PDB debug symbols from node-pty
  const archMap = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };
  const targetArch = archMap[context.arch];
  if (!targetArch) {
    console.warn(`[afterPack] Unknown arch enum ${context.arch}, skipping prebuild stripping`);
  }
  const prebuildsDir = path.join(unpackedRoot, 'node_modules', 'node-pty', 'prebuilds');
  if (targetArch && fs.existsSync(prebuildsDir)) {
    for (const entry of fs.readdirSync(prebuildsDir)) {
      const entryPath = path.join(prebuildsDir, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;
      // Keep only the directory matching target platform-arch
      if (entry !== `${platform}-${targetArch}`) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        console.log(`[afterPack] Removed prebuild: ${entry}`);
      } else {
        // Remove PDB debug symbols from the target directory
        for (const file of fs.readdirSync(entryPath)) {
          if (file.endsWith('.pdb')) {
            fs.unlinkSync(path.join(entryPath, file));
            console.log(`[afterPack] Removed PDB: ${entry}/${file}`);
          }
        }
      }
    }
  }

  // Before the retrieval and pty-host load probes below, so they load the
  // prebuild that was kept.
  if (targetArch) {
    stripBetterSqlitePrebuilds({ unpackedRoot, platform, targetArch });
  }

  // Replace node-pty's macOS spawn-helper with Kangentic's build, which clears
  // the inherited mach exception ports before it execs a terminal's program,
  // and prove it on this host before the build is signed. It also writes the
  // helper 755, which covers node-pty 1.1.0 shipping it as 644 and asar
  // unpacking stripping +x. Throws on darwin when it cannot; logs that it does
  // not apply elsewhere. See build/install-spawn-helper.js.
  installSpawnHelper({ unpackedRoot, platform });

  // The packaged embed worker must be able to load its externals from the
  // unpacked tree, or it exits 1 on every fork (DESKTOP-H). Throws on failure,
  // which fails the package; see build/verify-unpacked-worker.js. Skipped, with
  // a log line, only on a target the local model has no build for, where the
  // app never forks the worker (embedWorkerProbePlan).
  if (!targetArch || embedWorkerProbePlan({ unpackedRoot, platform, targetArch }) === 'probe') {
    verifyUnpackedWorkerModules({ unpackedRoot });
  }

  // Same gate for the dictation (sherpa-onnx) worker added for DESKTOP-X: a
  // packaging regression here would re-ship the DESKTOP-H shape for
  // sherpa-onnx-node instead of transformers.js.
  verifyUnpackedWorkerModules({
    unpackedRoot,
    moduleNames: DICTATION_WORKER_EXTERNALS,
    probeDependencies: DICTATION_WORKER_PROBE_DEPENDENCIES,
  });

  // The retrieval worker opens the project databases with better-sqlite3 and
  // loads sqlite-vec into them. Resolution first, then a real load under the
  // packaged Electron binary, which only works before the fuses below turn
  // ELECTRON_RUN_AS_NODE off.
  verifyUnpackedWorkerModules({
    unpackedRoot,
    moduleNames: RETRIEVAL_WORKER_EXTERNALS,
    probeDependencies: RETRIEVAL_WORKER_PROBE_DEPENDENCIES,
  });
  verifyRetrievalWorkerLoads({ unpackedRoot, electronBinaryPath });

  // The pty host runs every terminal from the unpacked tree: resolve node-pty
  // there, then spawn a real process with it under the packaged Electron
  // binary, before the fuses below turn ELECTRON_RUN_AS_NODE off.
  verifyUnpackedWorkerModules({
    unpackedRoot,
    moduleNames: PTY_HOST_EXTERNALS,
    probeDependencies: PTY_HOST_PROBE_DEPENDENCIES,
  });
  verifyPtyHostLoads({ unpackedRoot, electronBinaryPath });
  // The host starts every child process on its spawn worker thread, off the
  // thread that carries terminal I/O: start it the same way and run one child.
  verifySpawnWorkerLoads({ unpackedRoot, electronBinaryPath });

  // strictlyRequireAllFuses makes flipFuses throw when the binary carries a fuse
  // this config does not set, so an Electron upgrade that adds one fails the
  // build instead of shipping the new fuse at whatever default it came with.
  // Every fuse is therefore set explicitly, the last three at the defaults read
  // off Electron 45.0.0's own wire (the same nine fuses and defaults as 44.5.1).
  await flipFusesWhenBinaryIdle(electronBinaryPath, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Default. No browser-process-specific V8 snapshot is built or shipped.
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    // Default, and load-bearing: every window loads the renderer over file://
    // through loadFile, lazy chunks and the Monaco ?worker workers included.
    // Turning this off needs a protocol.handle migration first.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    // Default. V8's WebAssembly trap handlers, which Electron enables.
    [FuseV1Options.WasmTrapHandlers]: true,
  });
};

module.exports.flipFusesWhenBinaryIdle = flipFusesWhenBinaryIdle;
module.exports.stripBetterSqlitePrebuilds = stripBetterSqlitePrebuilds;
module.exports.embedWorkerProbePlan = embedWorkerProbePlan;
