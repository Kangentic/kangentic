import fs from 'node:fs';
import path from 'node:path';

/**
 * Where node-pty's macOS spawn-helper can live, in the order node-pty's own
 * native loader tries (`build/Release` first, then the prebuilds). Empty when
 * node-pty cannot be resolved.
 *
 * In packaged Electron, node-pty resolves inside app.asar but the native
 * binaries are extracted to app.asar.unpacked by electron-builder, so the path
 * is rewritten to the unpacked tree, the only place a binary can be executed.
 *
 * Shared by ensureSpawnHelperPermissions below and by shell-launch.ts, which
 * runs `child_process` shells through the same helper.
 */
export function spawnHelperCandidatePaths(): string[] {
  let nodePtyRoot: string;
  try {
    const packageJsonPath = require.resolve('node-pty/package.json');
    nodePtyRoot = path.dirname(packageJsonPath);
  } catch {
    return []; // node-pty not found (shouldn't happen)
  }

  nodePtyRoot = nodePtyRoot.replace('app.asar', 'app.asar.unpacked');

  return [
    path.join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
    path.join(nodePtyRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
  ];
}

/**
 * Ensure node-pty's spawn-helper binary has execute permissions on macOS.
 *
 * node-pty 1.1.0's npm tarball ships spawn-helper with 644 (no +x), and
 * Electron's asar unpacking may also strip execute bits. This is a runtime
 * safety net for dev mode and edge cases where permissions get stripped
 * post-install. Packaged builds do not need it: build/afterPack.js replaces the
 * helper with Kangentic's own build (build/install-spawn-helper.js) and writes
 * it 755. Dev mode still runs node-pty's stock helper, which is why this stays.
 *
 * Credit to eriksaulnier (PR #4) for identifying the runtime fix approach.
 */
export function ensureSpawnHelperPermissions(): void {
  if (process.platform !== 'darwin') return;

  for (const filePath of spawnHelperCandidatePaths()) {
    try {
      const stat = fs.statSync(filePath);
      // Check if file lacks any execute permission (owner, group, or other)
      if ((stat.mode & 0o111) === 0) {
        fs.chmodSync(filePath, stat.mode | 0o755);
        // breadcrumb-ok: node-pty's install path, which the breadcrumb policy redacts
        console.log(`[APP] Fixed spawn-helper permissions: ${filePath}`);
      }
    } catch (error) {
      // ENOENT means this candidate path doesn't exist, which is expected
      // (only one of build/Release or prebuilds will exist). Warn on other errors.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // The error rides as its own argument, which the breadcrumb policy
        // reduces to name and code.
        // breadcrumb-ok: node-pty's install path, which the breadcrumb policy redacts
        console.warn(`[APP] spawn-helper permission fix failed for ${filePath}:`, error);
      }
    }
  }
}
