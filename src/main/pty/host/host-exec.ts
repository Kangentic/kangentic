/**
 * The pty host's exec service: run a one-shot child process for main and
 * hand back what `promisify(exec)` would have. On Windows libuv's spawn runs
 * CreateProcess synchronously on the calling thread (15 to 30 ms a spawn,
 * measured at startup), so main's version probes, help-text reads, gh and git
 * checks run here instead. Main reaches it through `off-main-exec.ts`.
 *
 * It never forks and never launches this process's own binary: with the
 * RunAsNode fuse off, a packaged Kangentic.exe started as a child boots a
 * second app (the bug `conpty-console-list.ts` fixed for node-pty's kill).
 * `tests/unit/pty-host-boundary.test.ts` pins both.
 */

import { exec, execFile } from 'node:child_process';
import path from 'node:path';
import { isSamePath } from '../../../shared/paths';
import type { HostExecFailure, HostExecRequest, HostExecResult } from './protocol';

/** What both `exec` and `execFile` hand their callback on a failed run. */
type ChildProcessFailure = Error & {
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
  cmd?: string;
};

/**
 * Main's executable, as main reported it in the host's init. On macOS a
 * utility process runs from the app's Helper bundle, so this process's own
 * `execPath` is the Helper and never the app binary a request could name.
 */
let mainExecutable: string | null = null;

/** Record main's executable (`PtyHostInitMessage.mainExecutable`). */
export function setMainExecutable(executable: string | undefined): void {
  mainExecutable = executable && executable.length > 0 ? executable : null;
}

/** Every executable that is this app: this process's and main's. */
export function ownExecutables(): string[] {
  return mainExecutable && !isSamePath(mainExecutable, process.execPath)
    ? [process.execPath, mainExecutable]
    : [process.execPath];
}

/** The executable a shell command line starts: its leading quoted path, or
 *  its first word. */
export function leadingExecutable(commandLine: string): string {
  const quoted = /^\s*"([^"]*)"/.exec(commandLine);
  if (quoted) return quoted[1];
  return commandLine.trim().split(/\s+/)[0] ?? '';
}

/** True when the request would start this app's own executable (this
 *  process's, or main's). */
export function launchesOwnBinary(
  request: HostExecRequest,
  ownExecutable: string | readonly string[] = ownExecutables(),
): boolean {
  const candidates = typeof ownExecutable === 'string' ? [ownExecutable] : ownExecutable;
  if (request.kind === 'execFile') return candidates.some((candidate) => isSamePath(request.file, candidate));
  // Only the executable the command line starts is compared, by path or by
  // name. A probe's own path can contain this app's name without launching
  // it (`/opt/kangentic/bin/codex --version` on a build whose binary is
  // `kangentic`), and a substring match refused that probe.
  const executable = leadingExecutable(request.command);
  return candidates.some((candidate) => isSamePath(executable, candidate)
    || path.basename(executable).toLowerCase() === path.basename(candidate).toLowerCase());
}

function failure(error: ChildProcessFailure, stdout: string, stderr: string): HostExecFailure {
  const code = error.code;
  return {
    message: error.message,
    code: typeof code === 'string' ? code : undefined,
    exitCode: typeof code === 'number' ? code : null,
    killed: error.killed === true,
    signal: typeof error.signal === 'string' ? error.signal : null,
    stdout,
    stderr,
    cmd: error.cmd,
    stack: error.stack,
  };
}

export function runHostExec(request: HostExecRequest): Promise<HostExecResult> {
  if (launchesOwnBinary(request)) {
    return Promise.resolve({
      ok: false,
      error: {
        message: 'The pty host does not launch its own executable',
        exitCode: null,
        killed: false,
        signal: null,
        stdout: '',
        stderr: '',
      },
    });
  }
  return new Promise((resolve) => {
    const done = (error: ChildProcessFailure | null, stdout: string, stderr: string): void => {
      if (error) resolve({ ok: false, error: failure(error, stdout, stderr) });
      else resolve({ ok: true, stdout, stderr });
    };
    try {
      if (request.kind === 'exec') {
        exec(request.command, { ...request.options, encoding: 'utf8' }, done);
      } else {
        execFile(request.file, request.args, { ...request.options, encoding: 'utf8' }, done);
      }
    } catch (error) {
      // A synchronous throw (an invalid argument) is a failed run, as
      // promisify would report it.
      const thrown: ChildProcessFailure = error instanceof Error ? error : new Error(String(error));
      resolve({ ok: false, error: failure(thrown, '', '') });
    }
  });
}
