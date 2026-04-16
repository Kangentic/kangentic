import fs from 'node:fs';
import path from 'node:path';

/**
 * Ensure node-pty's spawn-helper binary has execute permissions on macOS.
 *
 * node-pty 1.1.0's npm tarball ships spawn-helper with 644 (no +x), and
 * Electron's asar unpacking may also strip execute bits. This is a runtime
 * safety net for dev mode and edge cases where permissions get stripped
 * post-install. The primary fix is in build/afterPack.js for packaged builds.
 *
 * Credit to eriksaulnier (PR #4) for identifying the runtime fix approach.
 */
export function ensureSpawnHelperPermissions(): void {
  if (process.platform !== 'darwin') return;

  let nodePtyRoot: string;
  try {
    const packageJsonPath = require.resolve('node-pty/package.json');
    nodePtyRoot = path.dirname(packageJsonPath);
  } catch {
    return; // node-pty not found (shouldn't happen)
  }

  // In packaged Electron, node-pty resolves inside app.asar but the native
  // binaries are extracted to app.asar.unpacked by electron-builder.
  nodePtyRoot = nodePtyRoot.replace('app.asar', 'app.asar.unpacked');

  const candidates = [
    path.join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
    path.join(nodePtyRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
  ];

  for (const filePath of candidates) {
    try {
      const stat = fs.statSync(filePath);
      // Check if file lacks any execute permission (owner, group, or other)
      if ((stat.mode & 0o111) === 0) {
        fs.chmodSync(filePath, stat.mode | 0o755);
        console.log(`[APP] Fixed spawn-helper permissions: ${filePath}`);
      }
    } catch (error) {
      // ENOENT means this candidate path doesn't exist, which is expected
      // (only one of build/Release or prebuilds will exist). Warn on other errors.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[APP] spawn-helper permission fix failed for ${filePath}: ${error}`);
      }
    }
  }
}
