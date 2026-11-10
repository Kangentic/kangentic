import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import { execCliForTarget, resolveCliTarget } from '../../shared/cli-target';
import { childProcessEnv } from '../../../shared/child-env';

/** One argument the runner passes through a shell unquoted: a word, a flag, a short id, or a slash command's name. */
const PLAIN_ARGUMENT = /^\/?[A-Za-z0-9_.:=-]+$/;

const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Run the Claude CLI once to completion, off main's thread, and resolve its
 * stdout. A Claude installed in a WSL distro runs in that distro. On Windows a
 * `.cmd` shim needs a shell, so every argument must be a plain word and is
 * refused otherwise; the executable is quoted for cmd. Rejects as `execFile`
 * does (a non-zero exit, a timeout).
 */
export async function runClaudeCli(
  cliPath: string,
  cliArgs: readonly string[],
  timeoutMs: number,
  extraEnv?: Readonly<Record<string, string>>,
): Promise<string> {
  for (const argument of cliArgs) {
    if (!PLAIN_ARGUMENT.test(argument)) throw new Error('runClaudeCli takes plain arguments only');
  }
  // An account's home (task #1057) rides in the env; absent, the run inherits main's as before.
  const env = extraEnv ? childProcessEnv(extraEnv) : undefined;
  const target = await resolveCliTarget(cliPath, true);
  if (target) {
    // A distro keeps its one login, and this run cannot carry a home into it. Running anyway
    // would answer for the distro's own login under the account's name.
    if (extraEnv && Object.keys(extraEnv).length > 0) throw new Error('runClaudeCli cannot set an account home for a CLI in WSL');
    const { stdout } = await execCliForTarget(target, cliArgs, { timeout: timeoutMs, maxBuffer: OUTPUT_LIMIT_BYTES });
    return stdout;
  }
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`${quoteCmdExecutable(cliPath)} ${cliArgs.join(' ')}`, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: OUTPUT_LIMIT_BYTES,
      ...(env ? { env } : {}),
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, [...cliArgs], {
    timeout: timeoutMs,
    maxBuffer: OUTPUT_LIMIT_BYTES,
    ...(env ? { env } : {}),
  });
  return stdout;
}
