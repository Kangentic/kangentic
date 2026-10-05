const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');
const {
  verifyUnpackedWorkerModules,
  verifyRetrievalWorkerLoads,
  verifyPtyHostLoads,
  DICTATION_WORKER_EXTERNALS,
  DICTATION_WORKER_PROBE_DEPENDENCIES,
  RETRIEVAL_WORKER_EXTERNALS,
  RETRIEVAL_WORKER_PROBE_DEPENDENCIES,
  PTY_HOST_EXTERNALS,
  PTY_HOST_PROBE_DEPENDENCIES,
} = require('./verify-unpacked-worker');
const { installSpawnHelper } = require('./install-spawn-helper');

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
  // which fails the package; see build/verify-unpacked-worker.js.
  verifyUnpackedWorkerModules({ unpackedRoot });

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

  // strictlyRequireAllFuses makes flipFuses throw when the binary carries a fuse
  // this config does not set, so an Electron upgrade that adds one fails the
  // build instead of shipping the new fuse at whatever default it came with.
  // Every fuse is therefore set explicitly, the last three at the defaults read
  // off Electron 44.5.1's own wire.
  await flipFuses(electronBinaryPath, {
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

module.exports.stripBetterSqlitePrebuilds = stripBetterSqlitePrebuilds;
