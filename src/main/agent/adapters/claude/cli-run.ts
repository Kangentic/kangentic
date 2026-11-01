import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import { execCliForTarget, resolveCliTarget } from '../../shared/cli-target';

/** One argument the runner passes through a shell unquoted: a word, a flag, or a short id. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_.:=-]+$/;

const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Run the Claude CLI once to completion, off main's thread, and resolve its
 * stdout. A Claude installed in a WSL distro runs in that distro. On Windows a
 * `.cmd` shim needs a shell, so every argument must be a plain word and is
 * refused otherwise; the executable is quoted for cmd. Rejects as `execFile`
 * does (a non-zero exit, a timeout).
 */
export async function runClaudeCli(cliPath: string, cliArgs: readonly string[], timeoutMs: number): Promise<string> {
  for (const argument of cliArgs) {
    if (!PLAIN_ARGUMENT.test(argument)) throw new Error('runClaudeCli takes plain arguments only');
  }
  const target = await resolveCliTarget(cliPath, true);
  if (target) {
    const { stdout } = await execCliForTarget(target, cliArgs, { timeout: timeoutMs, maxBuffer: OUTPUT_LIMIT_BYTES });
    return stdout;
  }
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`${quoteCmdExecutable(cliPath)} ${cliArgs.join(' ')}`, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: OUTPUT_LIMIT_BYTES,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, [...cliArgs], {
    timeout: timeoutMs,
    maxBuffer: OUTPUT_LIMIT_BYTES,
  });
  return stdout;
}
