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
import { realpathSync } from 'node:fs';
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

/** The executable a shell command line starts: its leading quoted path
 *  (double quotes, or the single quotes `quoteArg` writes for a POSIX shell,
 *  which spells an apostrophe inside the path `'\''`), or its first word. */
export function leadingExecutable(commandLine: string): string {
  const quoted = /^\s*(?:"([^"]*)"|'((?:[^']|'\\'')*)')/.exec(commandLine);
  if (quoted) return quoted[1] ?? quoted[2]?.replace(/'\\''/g, "'") ?? '';
  return commandLine.trim().split(/\s+/)[0] ?? '';
}

/** The path module for `platform`, so a Windows path is split as Windows
 *  splits it whatever the platform the check runs on. */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** An executable's name as a shell resolves it: no directory, no case and no
 *  `.exe`, on every platform. cmd finds a name through PATHEXT with `.exe` left
 *  off, and macOS's default file system ignores case. */
function commandName(file: string, platform: NodeJS.Platform): string {
  return pathFor(platform).basename(file).toLowerCase().replace(/\.exe$/, '');
}

/** Real paths of the executables compared, read once: they do not move while
 *  this process runs. Null for one that cannot be resolved. */
const realExecutables = new Map<string, string | null>();

function realPathOf(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/** The request's real path, read at most once however many executables it is
 *  compared with. Never read for a bare name: the shell finds one on PATH,
 *  where a real-path read would resolve it against the working directory, and
 *  the callers compare a name as a name. */
function lazyRealPath(file: string, platform: NodeJS.Platform): () => string | null {
  let resolved: { value: string | null } | undefined;
  return () => {
    if (pathFor(platform).basename(file) === file) return null;
    resolved ??= { value: realPathOf(file) };
    return resolved.value;
  };
}

/**
 * Whether two paths name the same executable: the same path once resolved
 * (case-folded where the file system ignores case: Windows, and macOS by
 * default), or, on this machine, the same file through a link (an install
 * link such as `/usr/bin/kangentic` to the app's binary).
 */
function isSameExecutable(
  file: string,
  candidate: string,
  platform: NodeJS.Platform,
  realFileOf: () => string | null,
): boolean {
  const platformPath = pathFor(platform);
  const foldsCase = platform === 'win32' || platform === 'darwin';
  const normalize = (value: string): string => {
    const resolved = platformPath.resolve(value);
    return foldsCase ? resolved.toLowerCase() : resolved;
  };
  if (normalize(file) === normalize(candidate)) return true;
  // A link is read off this machine's file system, so only for its platform.
  if (platform !== process.platform) return false;
  if (!realExecutables.has(candidate)) realExecutables.set(candidate, realPathOf(candidate));
  const realCandidate = realExecutables.get(candidate);
  if (!realCandidate) return false;
  const realFile = realFileOf();
  return realFile !== null && normalize(realFile) === normalize(realCandidate);
}

/** True when the request would start this app's own executable (this
 *  process's, or main's). `platform` is the platform whose paths the request
 *  holds, the one this runs on but for a test. */
export function launchesOwnBinary(
  request: HostExecRequest,
  ownExecutable: string | readonly string[] = ownExecutables(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const candidates = typeof ownExecutable === 'string' ? [ownExecutable] : ownExecutable;
  if (request.kind === 'execFile') {
    // A path is compared as a path. A bare name is found on PATH, so it is
    // compared as a name, the way the shell branch below compares one.
    const bareName = pathFor(platform).basename(request.file) === request.file;
    const realFileOf = lazyRealPath(request.file, platform);
    return candidates.some((candidate) => isSameExecutable(request.file, candidate, platform, realFileOf)
      || (bareName && commandName(request.file, platform) === commandName(candidate, platform)));
  }
  // Only the executable the command line starts is compared, by path or by
  // name. A probe's own path can contain this app's name without launching
  // it (`/opt/kangentic/bin/codex --version` on a build whose binary is
  // `kangentic`), and a substring match refused that probe.
  const executable = leadingExecutable(request.command);
  const realFileOf = lazyRealPath(executable, platform);
  return candidates.some((candidate) => isSameExecutable(executable, candidate, platform, realFileOf)
    || commandName(executable, platform) === commandName(candidate, platform));
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
