/**
 * One command on a host over `ssh`, with its output collected and optional bytes on its stdin
 * (#913). It is what the installer and the add-host probes run through: a one-shot, as opposed to
 * `ssh-connection.ts`'s long-lived stream. The same rules hold: the child is never detached, is
 * stopped with its tree, and ssh's own stderr is the error, unaltered.
 *
 * `ssh` starts in the pty host (`spawnOffMain`), never on main's thread, where a start holds the
 * window on Windows. So its input is text, or a file `ssh` reads for itself: bytes do not cross
 * from main to the host, which carries strings and has no backpressure.
 *
 * Imports nothing of electron.
 */

import { childProcessEnv } from '../../shared/child-env';
import { spawnOffMain } from '../../utility-process/off-main-spawn';

export interface SshRunResult {
  /** The exit status, or null when `ssh` was ended by a signal or by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SshRunOptions {
  /**
   * The command's stdin, closed when sent: text, or a file opened as `ssh`'s own stdin, for bytes
   * and for input of any size. A file that cannot be opened rejects the run before `ssh` starts.
   */
  stdin?: string | { filePath: string };
  timeoutMs?: number;
}

export type SshRunner = (remoteCommand: string, options?: SshRunOptions) => Promise<SshRunResult>;

export interface SshRunnerConfig {
  sshPath: string;
  /** Everything before the remote command: options, then the destination. */
  args: string[];
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * A POSIX sh script as a remote command every login shell passes to sh unchanged. sshd hands the
 * command to the user's login shell, and fish, nushell and csh each read sh syntax their own way
 * (`set -e` erases a variable in fish, `(...)` is command substitution there). Wrapped in single
 * quotes with no single quote, backslash or newline inside, the script is one literal argument to
 * `sh -c` in all of them: nothing inside is an escape in any of them, and csh refuses a quoted newline.
 */
export function posixShellCommand(script: string): string {
  if (/['\\\n\r]/.test(script)) throw new Error('A script sent to a host holds no single quote, backslash or newline.');
  return `sh -c '${script}'`;
}

export function createSshRunner(config: SshRunnerConfig): SshRunner {
  return (remoteCommand, options = {}) => new Promise<SshRunResult>((resolve, reject) => {
    const input = options.stdin;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const run = spawnOffMain(config.sshPath, [...config.args, remoteCommand], {
      cwd: process.cwd(),
      env: childProcessEnv(config.env),
      ...(typeof input === 'object' ? { stdinFile: input.filePath } : {}),
    });
    const child = run.child;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });
    // A command that exits before reading its input shows as an error here and as its exit status below.
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      run.stop('treeNow');
    }, timeoutMs);
    // `ssh` could not be started, or its stdin file could not be opened. `close` follows and settles nothing more.
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      // Decoded whole, so a character split across two chunks is never broken.
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({ code: timedOut ? null : code, stdout, stderr: timedOut ? `${stderr}\nssh did not finish within ${Math.round(timeoutMs / 1000)} s` : stderr });
    });
    // With a file as its stdin there is no pipe to close: `ssh` reads the file to its end.
    if (typeof input === 'string') child.stdin.end(input);
    else if (input === undefined) child.stdin.end();
  });
}
