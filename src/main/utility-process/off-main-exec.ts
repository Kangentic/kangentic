/**
 * `execAsync` and `execFileAsync`: drop-ins for `promisify(exec)` and
 * `promisify(execFile)` that run the child in the pty host when one is
 * registered, so the spawn's CreateProcess (synchronous on the calling thread
 * on Windows, 15 to 30 ms each) does not block main.
 *
 * Measured at startup, agent detection alone ran 30 such spawns on main, 17
 * of them 16 ms or longer, while the board was already on screen. The
 * resolved value and the rejection match `promisify`: `{ stdout, stderr }` as
 * strings, and an Error carrying `code`, `killed`, `signal`, `stdout`,
 * `stderr` and `cmd`.
 *
 * With no executor registered (unit tests, the retrieval worker, the pty host
 * itself, startup before the host exists) or when the host cannot be reached,
 * the child runs here instead, exactly as before.
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostExecFailure, HostExecOptions, HostExecRequest, HostExecResult } from '../pty/host/protocol';

export interface OffMainExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  windowsHide?: boolean;
  encoding?: 'utf8' | 'utf-8';
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
}

/** Runs a request in the pty host. Rejects only when the host cannot be
 *  reached; a child that fails resolves with `ok: false`. */
export type OffMainExecutor = (request: HostExecRequest, timeoutMs: number) => Promise<HostExecResult>;

let executor: OffMainExecutor | null = null;

/** Route `execAsync` and `execFileAsync` through `next`, or back to local
 *  spawns with null. Set once the pty host transport exists. */
export function setOffMainExecutor(next: OffMainExecutor | null): void {
  executor = next;
}

// Promisified per call, not at load: a module that only ever runs execFile
// should not need exec to exist (unit tests mock one or the other). The
// caller's options pass through untouched, so this path is exactly the
// `promisify` call it replaced; utf8 is already the default encoding.
function localExec(command: string, options: OffMainExecOptions): Promise<ExecOutput> {
  return promisify(exec)(command, options) as Promise<ExecOutput>;
}

function localExecFile(file: string, args: string[], options: OffMainExecOptions): Promise<ExecOutput> {
  return promisify(execFile)(file, args, options) as Promise<ExecOutput>;
}

/** Longest a request may wait on the host when the child has no timeout of
 *  its own (a large git read), before main gives up and runs it here. */
const UNBOUNDED_EXEC_BUDGET_MS = 10 * 60_000;
/** Slack over the child's own timeout for the round trip. */
const EXEC_BUDGET_MARGIN_MS = 5_000;

function toHostOptions(options: OffMainExecOptions): HostExecOptions {
  // The host forked with main's environment at startup; PATH and the rest
  // can change after that, so every request carries main's current one.
  const sourceEnv = options.env ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value === 'string') env[key] = value;
  }
  return {
    cwd: options.cwd,
    env,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: options.windowsHide,
  };
}

function toError(failure: HostExecFailure): Error {
  const error = new Error(failure.message) as Error & {
    code?: number | string;
    killed?: boolean;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    cmd?: string;
  };
  error.code = failure.exitCode ?? failure.code;
  error.killed = failure.killed;
  error.signal = failure.signal;
  error.stdout = failure.stdout;
  error.stderr = failure.stderr;
  if (failure.cmd !== undefined) error.cmd = failure.cmd;
  return error;
}

async function runRemote(
  run: OffMainExecutor,
  request: HostExecRequest,
  runLocally: () => Promise<ExecOutput>,
): Promise<ExecOutput> {
  const budgetMs = request.options.timeout && request.options.timeout > 0
    ? request.options.timeout + EXEC_BUDGET_MARGIN_MS
    : UNBOUNDED_EXEC_BUDGET_MS;
  let result: HostExecResult;
  try {
    result = await run(request, budgetMs);
  } catch {
    // The host is restarting or did not answer: run it here rather than
    // fail a caller that only wanted a child process.
    return runLocally();
  }
  if (result.ok) return { stdout: result.stdout, stderr: result.stderr };
  throw toError(result.error);
}

export function execAsync(command: string, options: OffMainExecOptions = {}): Promise<ExecOutput> {
  const runLocally = (): Promise<ExecOutput> => localExec(command, options);
  const run = executor;
  if (!run) return runLocally();
  return runRemote(run, { kind: 'exec', command, options: toHostOptions(options) }, runLocally);
}

export function execFileAsync(file: string, args: readonly string[] = [], options: OffMainExecOptions = {}): Promise<ExecOutput> {
  const runLocally = (): Promise<ExecOutput> => localExecFile(file, [...args], options);
  const run = executor;
  if (!run) return runLocally();
  return runRemote(run, { kind: 'execFile', file, args: [...args], options: toHostOptions(options) }, runLocally);
}
