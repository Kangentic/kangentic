const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const exeName = context.packager.appInfo.productFilename;
  const platform = context.electronPlatformName;
  let electronBinaryPath;
  if (platform === 'darwin') {
    electronBinaryPath = path.join(context.appOutDir, `${exeName}.app`, 'Contents', 'MacOS', exeName);
  } else if (platform === 'win32') {
    electronBinaryPath = path.join(context.appOutDir, `${exeName}.exe`);
  } else {
    // Linux: binary has no extension
    electronBinaryPath = path.join(context.appOutDir, exeName);
  }

  // Resolve the framework directory (contains resources/, LICENSES.chromium.html, etc.)
  // macOS: <name>.app/Contents/  (resources dir is capitalized "Resources")
  // Windows/Linux: appOutDir directly (resources dir is lowercase "resources")
  const frameworkDir = platform === 'darwin'
    ? path.join(context.appOutDir, `${exeName}.app`, 'Contents')
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
