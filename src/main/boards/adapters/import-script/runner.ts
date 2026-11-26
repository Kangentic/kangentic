/**
 * How the Script import source runs the saved command: the same shell a
 * terminal uses, off main, with stdout collected as JSON. A remote project
 * runs on its host instead, through the helper's `runCommand` (not the
 * run-script wrapper, which discards output).
 */

import { resolveShellLaunch } from '../../../pty/spawn/shell-launch';
import { ShellResolver } from '../../../pty/spawn/shell-resolver';
import { agentPathsForProjectPath } from '../../../remote/host-paths';
import { hostAccessFor } from '../../../remote/host-transfer';
import { childProcessEnv } from '../../../shared/child-env';
import { spawnOffMain } from '../../../utility-process/off-main-spawn';

/** How long the import waits for the script before it is stopped. */
export const SCRIPT_IMPORT_TIMEOUT_MS = 15_000;

/**
 * A reply frame is 256 KiB. Past that the host refuses the run, and a local
 * run is stopped the same way rather than truncated as success.
 */
export const SCRIPT_IMPORT_MAX_STDOUT_BYTES = 256 * 1024;

export interface ImportScriptRunResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  error?: string;
}

export interface ImportScriptRunner {
  getShell(): Promise<string>;
  isRemote(projectPath: string): boolean;
  runLocal(options: {
    exe: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  }): Promise<ImportScriptRunResult>;
  runOnHost(options: {
    projectPath: string;
    script: string;
    timeoutMs: number;
  }): Promise<ImportScriptRunResult>;
}

let shellLookup: (() => Promise<string>) | null = null;
const defaultShellResolver = new ShellResolver();

/**
 * The shell `sessionManager.getShell` would return. Set once at startup so
 * this adapter does not hold the session manager.
 */
export function setImportScriptShellLookup(lookup: (() => Promise<string>) | null): void {
  shellLookup = lookup;
}

export async function resolveImportScriptShell(): Promise<string> {
  if (shellLookup) return shellLookup();
  return defaultShellResolver.getDefaultShell();
}

export function isRemoteImportScriptProject(projectPath: string): boolean {
  return agentPathsForProjectPath(projectPath).hostId !== null;
}

export async function runImportScriptLocal(options: {
  exe: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<ImportScriptRunResult> {
  const { exe, args, cwd, timeoutMs } = options;
  return new Promise((resolve) => {
    const launch = resolveShellLaunch({ file: exe, args });
    const run = spawnOffMain(launch.file, launch.args, {
      cwd,
      env: childProcessEnv(),
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      userCommand: true,
    });
    const child = run.child;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const finish = (result: ImportScriptRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const stopTree = (): void => {
      try {
        run.stop('treeNow');
      } catch {
        // report-ok: already gone between the deadline and the kill, which is what the stop wanted.
      }
    };

    const timer = setTimeout(() => {
      stopTree();
      finish({ code: null, stdout: Buffer.concat(stdoutChunks).toString('utf8'), timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > SCRIPT_IMPORT_MAX_STDOUT_BYTES) {
        stopTree();
        finish({
          code: null,
          stdout: '',
          timedOut: false,
          error: 'The script printed more than the host can return.',
        });
        return;
      }
      stdoutChunks.push(buffer);
    });
    // Drain stderr so a chatty script cannot fill the pipe and block.
    child.stderr.on('data', () => undefined);
    child.stdin.end();

    child.on('error', (spawnError: Error) => {
      finish({
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        timedOut: false,
        error: spawnError.message,
      });
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish({
        code: code ?? (signal ? 1 : 0),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        timedOut: false,
      });
    });
  });
}

export async function runImportScriptOnHost(options: {
  projectPath: string;
  script: string;
  timeoutMs: number;
}): Promise<ImportScriptRunResult> {
  const paths = agentPathsForProjectPath(options.projectPath);
  const hostId = paths.hostId;
  if (!hostId) {
    return { code: null, stdout: '', timedOut: false, error: 'This project has no host.' };
  }
  const access = hostAccessFor(hostId);
  if (!access) {
    return {
      code: null,
      stdout: '',
      timedOut: false,
      error: 'This project\'s host is not available, so the script did not run.',
    };
  }
  try {
    const result = await access.runCommand({
      file: 'sh',
      args: ['-c', options.script],
      cwd: paths.toAgent(options.projectPath),
      timeoutMs: options.timeoutMs,
    });
    if (result.error && /more than|byte limit/i.test(result.error)) {
      return { code: null, stdout: '', timedOut: false, error: 'The script printed more than the host can return.' };
    }
    return {
      code: result.code,
      stdout: result.stdout,
      timedOut: result.timedOut,
      error: result.error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/over the .* byte limit|256/i.test(message)) {
      return { code: null, stdout: '', timedOut: false, error: 'The script printed more than the host can return.' };
    }
    throw error;
  }
}

export const liveImportScriptRunner: ImportScriptRunner = {
  getShell: resolveImportScriptShell,
  isRemote: isRemoteImportScriptProject,
  runLocal: runImportScriptLocal,
  runOnHost: runImportScriptOnHost,
};
