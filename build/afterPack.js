const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');
const {
  verifyUnpackedWorkerModules,
  DICTATION_WORKER_EXTERNALS,
  DICTATION_WORKER_PROBE_DEPENDENCIES,
} = require('./verify-unpacked-worker');
const { installSpawnHelper } = require('./install-spawn-helper');

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

  await flipFuses(electronBinaryPath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
};
