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
import { spawnOffMain, type OffMainChild } from '../../utility-process/off-main-spawn';

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

export interface CollectedRun {
  /** The run's own exit status, or null when a signal ended it. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** What stopped the run here, if anything did. Its exit status then means nothing. */
  stopped: 'timeout' | 'outputCap' | null;
}

export interface CollectRunLimits {
  /** Stop the run this long after it starts. No timeout when omitted. */
  timeoutMs?: number;
  /** Stop the run once either stream passes this many bytes. No cap when omitted. */
  maxOutputBytes?: number;
}

/**
 * Collect a started run's output until it closes. Both one-shot runners use it: this file's, and
 * `runProgram` in `ssh-setup.ts`. The caller owns the run's stdin.
 *
 * A limit stops the run's whole tree at once (`treeNow`): a signal to `ssh` alone would leave a
 * ProxyCommand or jump-host hop it started running. What a run stopped by the timeout still prints
 * is kept, since ssh's last words say why it was waiting. Past the cap nothing more is kept.
 *
 * It rejects on the run's `error`: a start that failed, a stdin file that could not be opened, or
 * the pty host lost under it. The `close` that follows settles nothing more.
 */
export function collectRun(run: OffMainChild, limits: CollectRunLimits = {}): Promise<CollectedRun> {
  return new Promise<CollectedRun>((resolve, reject) => {
    const { timeoutMs, maxOutputBytes } = limits;
    const child = run.child;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stopped: CollectedRun['stopped'] = null;
    let overCap = false;
    let settled = false;
    const stop = (cause: 'timeout' | 'outputCap'): void => {
      stopped ??= cause;
      run.stop('treeNow');
    };
    const timer = timeoutMs === undefined ? null : setTimeout(() => stop('timeout'), timeoutMs);
    const collect = (chunks: Buffer[]): ((chunk: Buffer) => void) => {
      let streamBytes = 0;
      return (chunk) => {
        if (overCap) return;
        streamBytes += chunk.length;
        if (maxOutputBytes !== undefined && streamBytes > maxOutputBytes) {
          overCap = true;
          stop('outputCap');
          return;
        }
        chunks.push(chunk);
      };
    };
    child.stdout.on('data', collect(stdoutChunks));
    child.stderr.on('data', collect(stderrChunks));
    child.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Decoded whole, so a character split across two chunks is never broken.
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stopped,
      });
    });
  });
}

export function createSshRunner(config: SshRunnerConfig): SshRunner {
  return async (remoteCommand, options = {}) => {
    const input = options.stdin;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const run = spawnOffMain(config.sshPath, [...config.args, remoteCommand], {
      cwd: process.cwd(),
      env: childProcessEnv(config.env),
      ...(typeof input === 'object' ? { stdinFile: input.filePath } : {}),
    });
    const collected = collectRun(run, { timeoutMs });
    // A command that exits before reading its input shows as an error here and as its exit status below.
    run.child.stdin.on('error', () => {});
    // With a file as its stdin there is no pipe to close: `ssh` reads the file to its end.
    if (typeof input === 'string') run.child.stdin.end(input);
    else if (input === undefined) run.child.stdin.end();
    const { code, stdout, stderr, stopped } = await collected;
    if (stopped !== 'timeout') return { code, stdout, stderr };
    return { code: null, stdout, stderr: `${stderr}\nssh did not finish within ${Math.round(timeoutMs / 1000)} s` };
  };
}
