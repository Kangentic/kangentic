/**
 * One command on a host over `ssh`, with its output collected and optional bytes on its stdin
 * (#913). It is what the installer and the add-host probes run through: a one-shot, as opposed to
 * `ssh-connection.ts`'s long-lived stream. The same rules hold: the child is never detached, is
 * killed by pid with its tree, and ssh's own stderr is the error, unaltered.
 *
 * Imports nothing of electron.
 */

import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { childProcessEnv } from '../../shared/child-env';
import { killChildTreeNow } from '../../shared/child-tree-stop';

export interface SshRunResult {
  /** The exit status, or null when `ssh` was ended by a signal or by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SshRunOptions {
  /** Bytes for the command's stdin, or a stream of them. Closed when sent. */
  stdin?: Buffer | Readable;
  timeoutMs?: number;
}

export type SshRunner = (remoteCommand: string, options?: SshRunOptions) => Promise<SshRunResult>;

export interface SshRunnerConfig {
  sshPath: string;
  /** Everything before the remote command: options, then the destination. */
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** A test swaps the spawner. */
  spawnProcess?: typeof spawn;
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
  const spawnProcess = config.spawnProcess ?? spawn;
  return (remoteCommand, options = {}) => new Promise<SshRunResult>((resolve, reject) => {
    const child = spawnProcess(config.sshPath, [...config.args, remoteCommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: childProcessEnv(config.env),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => { stdout += text; });
    child.stderr?.on('data', (text: string) => { stderr += text; });
    // A command that exits before reading its input shows as an error here and as its exit status below.
    child.stdin?.on('error', () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTreeNow(child, { leadsGroup: false });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr: timedOut ? `${stderr}\nssh did not finish within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s` : stderr });
    });
    const input = options.stdin;
    if (input === undefined) child.stdin?.end();
    else if (Buffer.isBuffer(input)) child.stdin?.end(input);
    else {
      // A stream with no listener throws its error out of the pty host, and a pipe leaves ssh waiting for input.
      input.once('error', (error) => {
        killChildTreeNow(child, { leadsGroup: false });
        reject(error);
      });
      input.pipe(child.stdin as NodeJS.WritableStream);
    }
  });
}
