/**
 * Runs one program on the host to completion, for the probes an agent CLI answers (a trust check, a chat
 * id, a model listing) and that the app cannot run itself because the CLI is not on this computer (#913).
 * The helper's other jobs touch files; this is the one that starts a process, so it is bounded and narrow:
 * a fixed timeout the caller names, its process group stopped as a whole, output capped, and the folder
 * held beneath the user's home by the caller (`HelperServer.homePath`).
 *
 * The program runs through the user's own shell, because that is where the CLI is found: `claude` or
 * `codex` installed with npm under nvm is on the PATH only the shell's startup files build. bash, zsh and
 * ksh run interactively and as a login shell, so both `.profile` and `.bashrc` apply; sh, dash and ash run
 * as a login shell. A shell that cannot run the script below (fish, nushell, csh) is replaced by `sh -lc`,
 * which sees the login PATH only. An agent installed where just that shell's own config puts it is found
 * by the PTY spawn (which types into the real shell) but not by this probe, which then reports it as not
 * installed.
 *
 * A startup file that prints (a version manager's banner, a message of the day) must not read as the
 * program's output, so the program's output is bracketed by two marker lines the script prints around it,
 * and only what lies between them is returned. The exit status rides the closing marker.
 *
 * Imports only `node:` built-ins and the shell helpers, so the helper bundle stays free of Electron.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { isFishShell, isNushellShell } from '../../../shared/shell-quote';
import type { HostCommandRequest, HostCommandResult } from '../protocol/messages';

const BEGIN_MARKER = '__KANGENTIC_BEGIN__';
const END_MARKER = '__KANGENTIC_END__';
/** What a run may print before it is stopped. A probe's answer is a few KB; a runaway is not an answer. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** After the shell exits, how long the output pipes get to drain before a process still holding them is let go. */
const PIPE_DRAIN_GRACE_MS = 2000;

/**
 * The script the shell runs: print the opening marker, run the program (`$0` and the arguments after it, so
 * nothing the caller sent is ever parsed as shell text), print the closing marker with the exit status.
 * The script is a constant: it holds none of the caller's text, and the shell gets it as one argument.
 */
const SCRIPT = `printf '%s\\n' ${BEGIN_MARKER}; "$0" "$@"; kangentic_status=$?; printf '\\n%s %s\\n' ${END_MARKER} "$kangentic_status"`;

/** Shells that read their interactive startup file (`.bashrc`, `.zshrc`) when asked, where a user's PATH usually lives. */
const INTERACTIVE_LOGIN_SHELLS = new Set(['bash', 'zsh', 'ksh']);
/** Shells that take `-lc` and nothing more: dash and ash reject `-i` with `-c` in some builds. */
const LOGIN_ONLY_SHELLS = new Set(['sh', 'dash', 'ash']);

export interface HostCommandPlan {
  file: string;
  args: string[];
}

/** The shell invocation that runs `request.file` with `request.args`, as described above. Pure. */
export function planHostCommand(shellPath: string, request: Pick<HostCommandRequest, 'file' | 'args'>): HostCommandPlan {
  const name = path.basename(shellPath).toLowerCase();
  if (!isFishShell(name) && !isNushellShell(name)) {
    if (INTERACTIVE_LOGIN_SHELLS.has(name)) return { file: shellPath, args: ['-ilc', SCRIPT, request.file, ...request.args] };
    if (LOGIN_ONLY_SHELLS.has(name)) return { file: shellPath, args: ['-lc', SCRIPT, request.file, ...request.args] };
  }
  // fish, nushell, csh and anything unknown cannot run the script above, so sh does, with the login PATH.
  return { file: '/bin/sh', args: ['-lc', SCRIPT, request.file, ...request.args] };
}

/** What the shell printed between the markers, and the status on the closing one. Null status: the markers never came. */
export function readBracketedOutput(raw: string): { output: string; status: number | null } {
  const begin = raw.indexOf(`${BEGIN_MARKER}\n`);
  if (begin === -1) return { output: '', status: null };
  const afterBegin = begin + BEGIN_MARKER.length + 1;
  const end = raw.lastIndexOf(`\n${END_MARKER} `);
  if (end === -1 || end < afterBegin - 1) return { output: raw.slice(afterBegin), status: null };
  // Only the closing line: a logout script can print after it, and that is not part of the status.
  const statusText = raw.slice(end + END_MARKER.length + 2).split('\n')[0].trim();
  const status = /^-?\d+$/.test(statusText) ? Number(statusText) : null;
  return { output: raw.slice(afterBegin, end), status };
}

export interface RunHostCommandOptions {
  shellPath: string;
  /** The folder the program starts in, already held beneath the user's home. */
  cwd: string;
  /** The environment the run starts from, before `request.env`. */
  baseEnv: NodeJS.ProcessEnv;
}

export function runHostCommand(request: HostCommandRequest, options: RunHostCommandOptions): Promise<HostCommandResult> {
  const plan = planHostCommand(options.shellPath, request);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.baseEnv)) {
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, request.env);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let capped = false;
    let timedOut = false;
    let settled = false;
    const finish = (result: HostCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // A folder that is not there fails the spawn with ENOENT, which a caller reads as "the program is not
    // installed". Say what is missing instead.
    if (!existsSync(options.cwd)) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: `The folder ${options.cwd} does not exist on this host, so ${request.file} was not run.` });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group (`detached`), so the timeout stops the program and what it started.
      child = spawn(plan.file, plan.args, { cwd: options.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const stopGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup();
    }, Math.max(1, request.timeoutMs));
    timer.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES && !capped) {
        capped = true;
        stopGroup();
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
    });
    child.on('error', (error) => {
      finish({ code: null, stdout: '', stderr, timedOut: false, error: error.message });
    });
    // A program or a startup file can leave a background process holding the output pipes, and 'close'
    // then never comes. Once the shell itself has exited, what it printed is all there will be.
    child.on('exit', (exitCode) => {
      const fallback = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        complete(exitCode);
      }, PIPE_DRAIN_GRACE_MS);
      fallback.unref?.();
    });
    child.on('close', (exitCode) => complete(exitCode));

    function complete(exitCode: number | null): void {
      const { output, status } = readBracketedOutput(stdout);
      if (timedOut) {
        finish({ code: null, stdout: output, stderr, timedOut: true });
        return;
      }
      if (capped) {
        finish({ code: null, stdout: output, stderr, timedOut: false, error: 'The program printed more than 8 MB, so it was stopped.' });
        return;
      }
      if (status === null) {
        // The shell ended before the script's closing marker: it did not start the program at all.
        finish({
          code: null,
          stdout: output,
          stderr,
          timedOut: false,
          error: `The host's shell (${path.basename(plan.file)}) ended before running ${request.file}${exitCode === null ? '' : ` (exit ${exitCode})`}.`,
        });
        return;
      }
      finish({ code: status, stdout: output, stderr, timedOut: false });
    }

    if (request.stdin !== undefined) child.stdin?.end(request.stdin);
    else child.stdin?.end();
    child.stdin?.on('error', () => undefined);
  });
}
