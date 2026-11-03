/**
 * An `ssh` child's stdio as one duplex stream, for the link (#913). The link is given this as its
 * connection to a host: `ssh <options> <destination> node kangentic-host.js relay` is the byte
 * pipe, and the resume layer turns it into a session that survives it dying.
 *
 * - The child is never `detached`. On Windows a detached `ssh` opens a visible console for a jump
 *   hop (Phase 0), so it is spawned `windowsHide` and killed by its live pid, with its tree
 *   (`killChildTreeNow`): `child.kill()` alone leaves a ProxyCommand child behind.
 * - What `ssh` prints on stderr is kept (the last few KB) and becomes the error when the child
 *   ends, so the user sees ssh's own words and not a paraphrase.
 * - A stream destroyed from this side stops the child. A child that ends destroys the stream.
 *
 * Imports nothing of electron.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';
import { childProcessEnv } from '../../shared/child-env';
import { killChildTreeNow } from '../../shared/child-tree-stop';

const STDERR_TAIL_BYTES = 4096;

export interface SshStreamOptions {
  /** The `ssh` program, by full path where the platform has more than one. */
  sshPath: string;
  /** Everything before the remote command: options, then the destination. */
  args: string[];
  /** What runs on the host and speaks frames on its stdio. */
  remoteCommand: string;
  env?: NodeJS.ProcessEnv;
  /** A test swaps the spawner. */
  spawnProcess?: typeof spawn;
}

export function openSshStream(options: SshStreamOptions): Duplex {
  const spawnProcess = options.spawnProcess ?? spawn;
  const child: ChildProcess = spawnProcess(options.sshPath, [...options.args, options.remoteCommand], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: childProcessEnv(options.env),
  });
  const stdout = child.stdout;
  const stdin = child.stdin;
  const stderr = child.stderr;
  if (!stdout || !stdin || !stderr) throw new Error('ssh was started without its stdio');

  let stderrTail = '';
  stderr.setEncoding('utf8');
  stderr.on('data', (text: string) => {
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
  });
  // A write after the child died is reported by the stream's own close, not here.
  stdin.on('error', () => {});

  const stream = new Duplex({
    read() {
      stdout.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      stdin.write(chunk, callback);
    },
    final(callback) {
      stdin.end(callback);
    },
    destroy(error, callback) {
      killChildTreeNow(child, { leadsGroup: false });
      callback(error);
    },
  });

  stdout.on('data', (chunk: Buffer) => {
    if (!stream.push(chunk)) stdout.pause();
  });
  stdout.on('end', () => stream.push(null));
  child.on('error', (error) => stream.destroy(error));
  child.on('close', (code, signal) => {
    if (stream.destroyed) return;
    const detail = stderrTail.trim();
    const how = signal ? `was ended by ${signal}` : `exited with code ${code}`;
    stream.destroy(new Error(detail ? `ssh ${how}: ${detail}` : `ssh ${how}`));
  });
  return stream;
}
