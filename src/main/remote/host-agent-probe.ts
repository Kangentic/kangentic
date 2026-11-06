/**
 * Whether an agent's CLI is installed on a host (#913). A remote project runs its agent there, so the
 * inventory the pickers show and the check a spawn makes ask the host, never this computer's PATH.
 *
 * The probe runs `<cli> --version` through the host's login shell (the helper's `runCommand`), the same
 * PATH the agent itself starts with. Every adapter takes `--version`, so nothing is adapter specific.
 *
 * Three answers, never two: a failed ask is not an absence (`ssh-remote.md`). A link that is down, a
 * program that timed out, or a refusal reads `unknown` with the reason, and only the shell's own
 * "not found" (an `error` from the helper, or exit 127) reads `missing`.
 */

import type { HostCommandRequest, HostCommandResult } from './protocol/messages';

export type HostAgentStatus = 'found' | 'missing' | 'unknown';

export interface HostAgentProbe {
  status: HostAgentStatus;
  /** The version the CLI printed, when it printed one that reads as a version. */
  version: string | null;
  /** Why the answer is `unknown`, in the words of whatever failed. */
  detail: string | null;
}

export type HostCommandRunner = (hostId: string, request: HostCommandRequest) => Promise<HostCommandResult>;

/** A shell prints 127 when the program is not on PATH. */
const SHELL_COMMAND_NOT_FOUND = 127;
const PROBE_TIMEOUT_MS = 10_000;

/** The first thing in the output that looks like a version, e.g. `2.1.304` out of `claude 2.1.304 (build 9)`. */
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?/;

export function versionFromOutput(output: string): string | null {
  return output.match(VERSION_PATTERN)?.[0] ?? null;
}

export async function probeAgentOnHost(runCommand: HostCommandRunner, hostId: string, cliName: string): Promise<HostAgentProbe> {
  let result: HostCommandResult;
  try {
    result = await runCommand(hostId, { file: cliName, args: ['--version'], timeoutMs: PROBE_TIMEOUT_MS });
  } catch (error) {
    return { status: 'unknown', version: null, detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.error) return { status: 'missing', version: null, detail: null };
  if (result.timedOut) return { status: 'unknown', version: null, detail: `${cliName} --version did not answer in time` };
  if (result.code === SHELL_COMMAND_NOT_FOUND) return { status: 'missing', version: null, detail: null };
  if (result.code === 0) {
    return { status: 'found', version: versionFromOutput(`${result.stdout}\n${result.stderr}`), detail: null };
  }
  // The program ran and said no. It is there, so it is not missing, but nothing says it works.
  const words = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
  return { status: 'unknown', version: null, detail: words || `${cliName} --version exited with ${result.code}` };
}
