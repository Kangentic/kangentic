import fs from 'node:fs';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/**
 * Extract the Warp version from `oz dump-debug-info` output.
 *
 * The oz CLI does not support `--version`. Instead, `dump-debug-info`
 * prints lines like:
 *   Warp version: Some("v0.2026.04.08.08.36.stable_02")
 *
 * We extract the version string from the `Some("...")` wrapper.
 */
export function parseWarpVersion(output: string): string | null {
  const match = output.match(/Warp version:\s*Some\("([^"]+)"\)/);
  return match ? match[1] : null;
}

/**
 * Run `<binary> dump-debug-info` and extract the version.
 * Uses exec() on Windows (for .cmd shim support) and execFile() elsewhere.
 *
 * candidatePath flows from `which('oz')` or a user-configured override. On
 * Windows the `.cmd` shim case requires shell invocation, which means the
 * path is concatenated into a shell command string. Reject paths containing
 * shell metacharacters before invoking the shell so a crafted override path
 * cannot break out of the quoting.
 */
export async function execWarpVersion(candidatePath: string, timeout = 5000): Promise<string | null> {
  try {
    if (!fs.existsSync(candidatePath)) return null;
    if (process.platform === 'win32') {
      // Windows does not allow " in filenames, but other shell metacharacters
      // (`&`, `|`, `^`, `%`, `<`, `>`, newline) are theoretically valid. Reject
      // them rather than attempting to escape, since this path is a binary
      // location and should never contain them in practice.
      if (/["&|^%<>\n\r`$]/.test(candidatePath)) return null;
      // windowsHide: true prevents the cmd.exe shell from briefly flashing
      // a console window during the probe (visible in E2E test runs).
      const { stdout, stderr } = await execAsync(`"${candidatePath}" dump-debug-info`, { timeout, windowsHide: true });
      return parseWarpVersion(stdout || stderr || '');
    }
    const { stdout, stderr } = await execFileAsync(candidatePath, ['dump-debug-info'], { timeout });
    return parseWarpVersion(stdout || stderr || '');
  } catch {
    return null;
  }
}
