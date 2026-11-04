import { execAsync, execFileAsync } from '../../utility-process/off-main-exec';
import { quoteCmdExecutable } from '../../../shared/shell-quote';
import { childProcessEnv } from '../../shared/child-env';

/**
 * A program a detector starts directly, with no shell, in place of the path it
 * found, for its version probe (`AgentDetectorConfig.versionLaunch`). `env` is
 * laid over main's environment.
 */
export interface VersionLaunch {
  file: string;
  env?: Record<string, string>;
}

/**
 * Run `candidatePath --version` (or the CLI's own version command, `args`)
 * and return { stdout, stderr }.
 *
 * On Windows, npm global installs create .cmd shims that require a shell
 * to interpret. We use exec() with a single command string (not execFile
 * with an args array) to avoid Node.js DEP0190 which warns against
 * passing args when shell: true. `windowsHide: true` keeps cmd.exe from
 * briefly flashing a console window for every probe (noticeable in E2E
 * runs where every test launch probes every installed agent CLI).
 *
 * On macOS/Linux, we use execFile() without a shell for direct execution.
 *
 * `launch` starts that program directly instead, on every platform, for a CLI
 * whose output never reaches a pipe through cmd (Warp's `oz.cmd` runs a
 * GUI-subsystem `warp.exe`, whose output cmd loses).
 */
export async function execVersion(
  candidatePath: string,
  timeout = 5000,
  args: readonly string[] = ['--version'],
  launch?: VersionLaunch | null,
): Promise<{ stdout: string; stderr: string }> {
  if (launch) {
    return execFileAsync(launch.file, [...args], { timeout, windowsHide: true, env: childProcessEnv(launch.env) });
  }
  if (process.platform === 'win32') {
    // Safe: candidatePath comes from which() or hardcoded fallback paths, never
    // user input; `args` are a detector's fixed words, never user input either.
    return execAsync(`${quoteCmdExecutable(candidatePath)} ${args.join(' ')}`, { timeout, windowsHide: true });
  }
  return execFileAsync(candidatePath, [...args], { timeout });
}
