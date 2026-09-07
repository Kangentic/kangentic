import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPowerShellShell, isUnixLikeShell, sanitizeForPty } from '../../../shared/paths';

const execFileAsync = promisify(execFile);

/**
 * Pick the launcher for an agent CLI that resolved to a Windows `.cmd` /
 * `.bat` shim, so a multi-line prompt survives the trip to the agent (#353).
 *
 * `AgentDetector` finds an npm-installed CLI through `which`, which walks
 * PATHEXT and therefore lands on the `.cmd` shim (`codex.CMD`). Every builder
 * emits that path as the command head and the task prompt as one quoted
 * argument, and the spawn flow types the line into the live PTY shell.
 * PowerShell expands the backtick-n escapes `quoteArg` wrote back into real
 * newlines, Git Bash passes its single-quoted newlines through as they are,
 * and then either host launches the `.cmd` through cmd.exe, whose command
 * line ends at the first newline. The shim's `%*` forwards `"<task>` and the
 * agent sees `<task>` and nothing else. Measured on Windows PowerShell 5.1,
 * pwsh 7.6, and Git Bash: no encoding survives cmd.exe.
 *
 * npm writes two more shims beside every `.cmd`: a `.ps1` that forwards
 * `$args` to node.exe, and an extensionless `#!/bin/sh` script that forwards
 * `"$@"` (with explicit MINGW/MSYS handling). A `$args` splat preserves a
 * multi-line argument on both PowerShell hosts, and bash to node.exe
 * preserves it too, so each host gets the sibling native to it. `exit $ret`
 * inside the `.ps1` ends the script, not the host shell, so the shell
 * survives the agent exactly as it does with the `.cmd`. The process tree
 * becomes `pwsh -> node` instead of `pwsh -> cmd.exe -> node`; the
 * background-shell watcher's immediate-parent rule already counts both
 * shapes (tests/unit/bg-shell-watcher.test.ts pins each).
 *
 * A `.ps1` cannot run when the host's effective execution policy is
 * Restricted (Windows PowerShell 5.1's client default) or AllSigned, and the
 * two hosts keep separate policies, so the policy is probed once per shell
 * per run through the same host executable. With no usable sibling the
 * `.cmd` stays and the prompt is flattened to one line instead, so the whole
 * title and description still arrive; that is the reporter's own workaround
 * and it never regresses a spawn that works today. Nothing here inspects the
 * agent's name: a `.cmd` shim is a Windows packaging fact, not an agent fact.
 *
 * Runs at every spawn chokepoint after `ensureTrust` and before
 * `buildCommand` (see .claude/rules/spawn-entry-point-parity.md). Import it
 * by this file's path, never through the `agent/shared` barrel, which several
 * suites replace with a factory.
 */

export interface ShimLaunchInput {
  /** The path `detect()` resolved, possibly a `.cmd` / `.bat` shim. */
  agentPath: string;
  /** The shell the PTY types the command into. Undefined leaves the input untouched. */
  shell: string | undefined;
  /** The task prompt the builder will quote, if this spawn carries one. */
  prompt: string | undefined;
}

export type ShimLaunchStrategy =
  /** Not Windows, not a batch shim, or a shell that needs no swap. */
  | 'unchanged'
  /** PowerShell host: the sibling `.ps1` shim runs the agent. */
  | 'ps1-sibling'
  /** Git Bash host: the sibling `#!/bin/sh` shim runs the agent. */
  | 'sh-sibling'
  /** The batch shim stays and any prompt is flattened to one line. */
  | 'flattened-prompt';

export interface ShimLaunch {
  agentPath: string;
  prompt: string | undefined;
  strategy: ShimLaunchStrategy;
}

/** Injection points for tests; production callers pass nothing. */
export interface ShimLaunchDependencies {
  platform?: NodeJS.Platform;
  fileExists?: (candidatePath: string) => boolean;
  /** The first bytes of a file, for the `#!` sniff; empty when unreadable. */
  readFileHead?: (candidatePath: string) => string;
  /** Trimmed `Get-ExecutionPolicy` output for the shell, or null when the probe failed. */
  probeExecutionPolicy?: (shell: string) => Promise<string | null>;
  warn?: (message: string) => void;
}

const EXECUTION_POLICY_PROBE_TIMEOUT_MS = 5000;

/** Effective policies under which an unsigned local `.ps1` runs. */
const SCRIPT_ALLOWING_POLICIES = new Set(['remotesigned', 'unrestricted', 'bypass']);

/** One probe per shell string for the life of the process. */
const executionPolicyProbes = new Map<string, Promise<string | null>>();

/** One warning per shell and agent path, so a busy board does not repeat it per spawn. */
const warnedLaunches = new Set<string>();

/** `.cmd` / `.bat` by extension, case-insensitive (`which` returns `.CMD`). */
export function isWindowsBatchShim(agentPath: string): boolean {
  return /\.(cmd|bat)$/i.test(agentPath);
}

/**
 * The sibling shim path: same directory and base name, the given extension.
 * A string slice on the original path, never `path.join(path.dirname(...))`:
 * on a posix host `path` would mangle a `C:\...` input, and the base name's
 * case must survive (`codex.CMD` -> `codex.ps1`).
 */
export function shimSibling(agentPath: string, extension: '.ps1' | ''): string {
  const match = /\.[^./\\]+$/.exec(agentPath);
  const stem = match ? agentPath.slice(0, match.index) : agentPath;
  return stem + extension;
}

/** True when `Get-ExecutionPolicy` output names a policy that runs unsigned local scripts. */
export function executionPolicyAllowsScripts(policyOutput: string | null): boolean {
  if (policyOutput === null) return false;
  return SCRIPT_ALLOWING_POLICIES.has(policyOutput.trim().toLowerCase());
}

/**
 * Ask the PowerShell host for its effective execution policy. Uncached; the
 * resolver caches per shell. Any failure (missing host, timeout, non-zero
 * exit, empty output) resolves null, which the resolver treats as blocked:
 * a wrongly allowed `.ps1` fails the launch outright, while a wrongly blocked
 * one only flattens the prompt.
 */
export async function probeExecutionPolicy(shell: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'],
      {
        env: environmentWithoutModulePath(),
        timeout: EXECUTION_POLICY_PROBE_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf-8',
      },
    );
    const policy = stdout.trim();
    return policy.length > 0 ? policy : null;
  } catch {
    return null;
  }
}

/**
 * The probe's child environment: the app's own, minus `PSModulePath`.
 *
 * Windows PowerShell 5.1 autoloads `Get-ExecutionPolicy` from the
 * Microsoft.PowerShell.Security module. A `PSModulePath` inherited from a
 * pwsh 7 ancestor (the dogfood shape: `npm start` from a pwsh terminal, whose
 * MSIX install lists its own Modules directory) makes 5.1 pick up the pwsh
 * build of that module and fail with "the module could not be loaded", so the
 * probe reported null on a machine whose policy was Bypass. Without the
 * variable each host computes its own default module path; the policy itself
 * is read from the registry and is unaffected. Matched case-insensitively,
 * since Windows environment names are.
 */
function environmentWithoutModulePath(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toLowerCase() === 'psmodulepath') continue;
    environment[name] = value;
  }
  return environment;
}

/** Test-only: forget every probed policy and every warning already issued. */
export function resetShimLaunchCacheForTests(): void {
  executionPolicyProbes.clear();
  warnedLaunches.clear();
}

function readFileHeadFromDisk(candidatePath: string): string {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(candidatePath, 'r');
    const buffer = Buffer.alloc(2);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function cachedExecutionPolicy(
  shell: string,
  probe: (shell: string) => Promise<string | null>,
): Promise<string | null> {
  const pending = executionPolicyProbes.get(shell);
  if (pending) return pending;
  const started = probe(shell).catch(() => null);
  executionPolicyProbes.set(shell, started);
  return started;
}

function isWslShell(shell: string): boolean {
  return shell.toLowerCase().startsWith('wsl');
}

function noSiblingMessage(agentPath: string, siblingPath: string): string {
  return `[shim-launch] ${agentPath} is a cmd.exe batch shim with no ${siblingPath} beside it. `
    + 'cmd.exe cuts the command line at the first newline, so the task prompt is flattened to one '
    + 'line for this session. An npm install writes the sibling shims automatically; otherwise point '
    + 'Settings > Agent at the CLI\'s native executable to keep multi-line prompts.';
}

function blockedPolicyMessage(
  agentPath: string,
  siblingPath: string,
  shell: string,
  policy: string | null,
): string {
  return `[shim-launch] ${siblingPath} exists but ${shell} reports execution policy `
    + `"${policy ?? 'unknown'}", which blocks .ps1 scripts, so the agent launches through ${agentPath} `
    + 'via cmd.exe and the task prompt is flattened to one line. Fix: run '
    + '"Set-ExecutionPolicy RemoteSigned -Scope CurrentUser" in that PowerShell, then restart '
    + 'Kangentic (the policy is probed once per shell per run).';
}

function keepBatchShim(input: ShimLaunchInput, warn: (message: string) => void, message: string): ShimLaunch {
  // Only a prompt is degraded by the batch shim; a resume or a Command
  // Terminal carries none, so there is nothing to warn about.
  if (input.prompt !== undefined) {
    const key = `${input.shell}\u0000${input.agentPath}`;
    if (!warnedLaunches.has(key)) {
      warnedLaunches.add(key);
      warn(message);
    }
  }
  return {
    agentPath: input.agentPath,
    prompt: input.prompt === undefined ? undefined : sanitizeForPty(input.prompt),
    strategy: 'flattened-prompt',
  };
}

/**
 * Resolve how a spawn should launch `agentPath` under `shell`. The gate order
 * is load-bearing: no filesystem or process access until the platform, shell,
 * and extension checks all pass, so a unit test with a fake path never
 * touches disk or spawns a shell.
 */
export async function resolveShimLaunch(
  input: ShimLaunchInput,
  dependencies: ShimLaunchDependencies = {},
): Promise<ShimLaunch> {
  const platform = dependencies.platform ?? process.platform;
  const { agentPath, shell, prompt } = input;
  if (platform !== 'win32' || shell === undefined || !isWindowsBatchShim(agentPath)) {
    return { agentPath, prompt, strategy: 'unchanged' };
  }
  const fileExists = dependencies.fileExists ?? fs.existsSync;
  const warn = dependencies.warn ?? console.warn;

  if (isPowerShellShell(shell)) {
    const siblingPath = shimSibling(agentPath, '.ps1');
    if (!fileExists(siblingPath)) {
      return keepBatchShim(input, warn, noSiblingMessage(agentPath, siblingPath));
    }
    const policy = await cachedExecutionPolicy(shell, dependencies.probeExecutionPolicy ?? probeExecutionPolicy);
    if (!executionPolicyAllowsScripts(policy)) {
      return keepBatchShim(input, warn, blockedPolicyMessage(agentPath, siblingPath, shell, policy));
    }
    return { agentPath: siblingPath, prompt, strategy: 'ps1-sibling' };
  }

  if (isUnixLikeShell(shell) && !isWslShell(shell)) {
    // Git Bash. WSL is excluded: it cannot launch a `.cmd` at all (documented
    // in docs/cross-platform.md), and the sh shim would run a Windows bundle
    // under a Linux node, so that route stays as it is.
    const siblingPath = shimSibling(agentPath, '');
    const readFileHead = dependencies.readFileHead ?? readFileHeadFromDisk;
    if (fileExists(siblingPath) && readFileHead(siblingPath).startsWith('#!')) {
      return { agentPath: siblingPath, prompt, strategy: 'sh-sibling' };
    }
    return keepBatchShim(input, warn, noSiblingMessage(agentPath, siblingPath));
  }

  // cmd.exe host: quoteArg already flattens for it. WSL: see above.
  return { agentPath, prompt, strategy: 'unchanged' };
}
