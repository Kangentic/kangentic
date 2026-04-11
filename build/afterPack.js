const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');

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

  // Strip cross-platform prebuilds and PDB debug symbols from node-pty
  const archMap = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };
  const targetArch = archMap[context.arch];
  if (!targetArch) {
    console.warn(`[afterPack] Unknown arch enum ${context.arch}, skipping prebuild stripping`);
  }
  const prebuildsDir = path.join(
    frameworkDir,
    resourcesDirName, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds'
  );
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

  // Fix spawn-helper permissions on macOS (node-pty 1.1.0 ships with 644).
  // asar unpacking may also strip +x. Belt-and-suspenders with the runtime fix.
  if (platform === 'darwin' && fs.existsSync(prebuildsDir)) {
    for (const entry of fs.readdirSync(prebuildsDir)) {
      const spawnHelper = path.join(prebuildsDir, entry, 'spawn-helper');
      if (fs.existsSync(spawnHelper)) {
        fs.chmodSync(spawnHelper, 0o755);
        console.log(`[afterPack] Fixed spawn-helper permissions: ${entry}/spawn-helper`);
      }
    }
  }

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
