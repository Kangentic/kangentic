/**
 * A `run_script` automation on a remote project's host (#913). The task's worktree is on the host and this computer
 * holds an empty stand-in for it, so a script run here does nothing useful and records exit 0.
 *
 * It runs through the helper's `runCommand`, which stops its process group at the bound. Three things differ from
 * a local run, each because of what sits between the two machines:
 *
 * - Output goes nowhere. A reply is one frame, and a chatty script would overflow it and read as a failure of a
 *   script that passed. Nobody reads a script's output here either.
 * - The environment is bounded. A request is one frame too, and Linux refuses a single variable past 128 KiB, so a
 *   long `{{agentReply}}` could fail every script on a turn end. What does not fit is left out and named.
 * - A superseded move cannot stop it. There is no call to reach a running command, so it goes on to its own bound
 *   on the host, and the run is recorded as superseded here.
 *
 * Runs `sh` rather than the login shell, which `runCommand` has already run for the PATH: a script written for the
 * board is POSIX, and a host's fish or nushell would not run it.
 */

import { agentPathsForProjectPath } from './host-paths';
import { hostAccessFor } from './host-transfer';
import type { HostCommandResult } from './protocol/messages';

/** The script is `$1`, an argument and never part of this text. */
const WRAPPER = 'sh -c "$1" kangentic-script </dev/null >/dev/null 2>&1';

/** Past this one variable is left out, well inside the kernel's 128 KiB and the frame. */
const MAX_VARIABLE_BYTES = 32 * 1024;
/** All of them together, leaving a frame's 256 KiB room for the script and the envelope. */
const MAX_ENVIRONMENT_BYTES = 128 * 1024;

export interface HostScriptRun {
  script: string;
  environment: Record<string, string>;
  timeoutMs: number;
}

export interface HostScriptResult extends HostCommandResult {
  /** The variables left out for their size. */
  omittedVariables: string[];
}

export type HostScriptRunner = (run: HostScriptRun) => Promise<HostScriptResult>;

/** The variables that fit, smallest first so one long value costs only itself, and the names of the rest. */
export function boundedHostEnvironment(environment: Record<string, string>): { fits: Record<string, string>; omitted: string[] } {
  const fits: Record<string, string> = {};
  const omitted: string[] = [];
  let total = 0;
  const bySize = Object.entries(environment)
    .map(([name, value]) => ({ name, value, bytes: Buffer.byteLength(name) + Buffer.byteLength(value) }))
    .sort((left, right) => left.bytes - right.bytes);
  for (const { name, value, bytes } of bySize) {
    if (bytes > MAX_VARIABLE_BYTES || total + bytes > MAX_ENVIRONMENT_BYTES) {
      omitted.push(name);
      continue;
    }
    fits[name] = value;
    total += bytes;
  }
  return { fits, omitted: omitted.sort() };
}

/** How a script in `localFolder` runs on its project's host, or null for a project on this computer. */
export function hostScriptRunner(projectPath: string | null | undefined, localFolder: string): HostScriptRunner | null {
  if (!projectPath) return null;
  const paths = agentPathsForProjectPath(projectPath);
  const { hostId } = paths;
  if (!hostId) return null;
  return async ({ script, environment, timeoutMs }) => {
    const access = hostAccessFor(hostId);
    if (!access) throw new Error('This project\'s host is not available, so the script did not run.');
    const { fits, omitted } = boundedHostEnvironment(environment);
    const result = await access.runCommand({
      file: 'sh',
      args: ['-c', WRAPPER, 'kangentic-script', script],
      cwd: paths.toAgent(localFolder),
      env: fits,
      timeoutMs,
    });
    return { ...result, omittedVariables: omitted };
  };
}
