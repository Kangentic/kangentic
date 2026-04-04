import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/**
 * Run `candidatePath --version` and return { stdout, stderr }.
 *
 * On Windows, npm global installs create .cmd shims that require a shell
 * to interpret. We use exec() with a single command string (not execFile
 * with an args array) to avoid Node.js DEP0190 which warns against
 * passing args when shell: true.
 *
 * On macOS/Linux, we use execFile() without a shell for direct execution.
 */
export async function execVersion(
  candidatePath: string,
  timeout = 5000,
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform === 'win32') {
    // Safe: candidatePath comes from which() or hardcoded fallback paths, never user input
    return execAsync(`"${candidatePath}" --version`, { timeout });
  }
  return execFileAsync(candidatePath, ['--version'], { timeout });
}
