import fs from 'node:fs';
import os from 'node:os';
import { isUncPath } from '../../../shared/paths';
import { trackEvent, sanitizeErrorMessage } from '../../analytics/analytics';

/** Shell executable + args, split from a user-facing shell spec. */
export interface ShellInvocation {
  exe: string;
  args: string[];
}

/**
 * Resolve a shell spec (e.g. "wsl -d Ubuntu", "powershell", "/bin/bash")
 * into the executable path plus the argv prefix we want to use.
 *
 * WSL specs are `wsl -d <distro>` style - we split into exe + args so
 * node-pty sees them correctly. cmd/pwsh take no args. Fish and Nushell
 * skip `--login` because they handle init differently. Everything else
 * (bash, zsh) gets `--login` so user rc files load.
 */
export function resolveShellArgs(shell: string): ShellInvocation {
  const shellName = shell.toLowerCase();
  if (shellName.startsWith('wsl ')) {
    const parts = shell.split(/\s+/);
    return { exe: parts[0], args: parts.slice(1) };
  }
  if (shellName.includes('cmd')) return { exe: shell, args: [] };
  if (shellName.includes('powershell') || shellName.includes('pwsh')) {
    return { exe: shell, args: ['-NoLogo'] };
  }
  if (shellName.includes('fish') || shellName.includes('nu')) {
    return { exe: shell, args: [] };
  }
  return { exe: shell, args: ['--login'] };
}

/**
 * Build the environment block for `pty.spawn`.
 *
 * Strips `CLAUDECODE` so spawned Claude CLI sessions don't refuse to
 * start when Kangentic itself was launched from inside a Claude Code
 * session.
 */
export function buildSpawnEnv(
  inputEnv: Record<string, string> | undefined,
): Record<string, string> {
  const { CLAUDECODE: _, ...rest } = { ...process.env, ...inputEnv };
  return rest as Record<string, string>;
}

/**
 * Resolution of the spawn working directory.
 *
 * - `effectiveCwd` is what should be passed to node-pty.
 * - `uncPushdPrefix`, when non-null, is a shell command the caller must
 *   write into the PTY before the user command so cmd.exe can reach the
 *   real UNC path via a mapped drive letter (cmd.exe refuses UNC cwds).
 */
export interface SpawnCwdResolution {
  effectiveCwd: string;
  uncPushdPrefix: string | null;
}

/**
 * Validate the requested cwd and handle Windows-specific quirks:
 *
 *  - Fall back to the user's home directory if the requested cwd does
 *    not exist. A live session in `~` is strictly better than a dead
 *    session with exit code -1. Emits a diagnostic analytics event.
 *  - cmd.exe cannot use a UNC path as its cwd (it prints
 *    "UNC paths are not supported" and defaults to C:\Windows). When
 *    we detect this, keep the cwd as home and return a `pushd "<unc>"`
 *    prefix that the caller must write before the user command.
 *    PowerShell and Git Bash handle UNC cwds natively, so no prefix.
 */
export function resolveSpawnCwd(input: {
  requestedCwd: string;
  shellName: string;
  platform: NodeJS.Platform;
}): SpawnCwdResolution {
  let effectiveCwd = input.requestedCwd;
  if (!fs.existsSync(input.requestedCwd)) {
    effectiveCwd = os.homedir();
    trackEvent('app_error', {
      source: 'pty_spawn_cwd_missing',
      message: 'CWD does not exist, falling back to home directory',
      platform: input.platform,
    });
  }

  let uncPushdPrefix: string | null = null;
  if (
    input.platform === 'win32'
    && isUncPath(effectiveCwd)
    && input.shellName.toLowerCase().includes('cmd')
  ) {
    uncPushdPrefix = `pushd "${effectiveCwd}"`;
    effectiveCwd = os.homedir();
  }

  return { effectiveCwd, uncPushdPrefix };
}

/**
 * Diagnostic payload for a PTY spawn failure. Callers use the
 * scrollback suffix to show actionable guidance in the terminal panel
 * instead of a blank screen, and fire the analytics event via
 * `recordSpawnFailure`.
 */
export interface SpawnFailureDiagnostic {
  /** Human-readable error message from the thrown error. */
  errorMessage: string;
  /** ANSI-formatted text to append to scrollback. Empty if no special hint applies. */
  scrollbackSuffix: string;
  /** Best-effort errno/code for analytics. */
  errno: string;
  /** Whether the originally-requested cwd exists (not the resolved effective cwd). */
  cwdExists: boolean;
  /** Whether the shell executable path exists on disk. */
  shellExists: boolean;
}

/**
 * Inspect a thrown error from `pty.spawn` and build a diagnostic
 * payload. Handles the common `posix_spawnp` failure caused by
 * node-pty's spawn-helper binary missing the executable bit.
 *
 * Pure (no logging or side effects) so callers can test and also so
 * they can sequence the logging themselves (session-manager wants to
 * include the session ID in its log line).
 */
export function diagnoseSpawnFailure(params: {
  err: unknown;
  shellExe: string;
  effectiveCwd: string;
  originalCwd: string;
}): SpawnFailureDiagnostic {
  const errorMessage = params.err instanceof Error ? params.err.message : String(params.err);
  const errnoCode = (params.err as NodeJS.ErrnoException).code || '';
  const errnoNumber = (params.err as NodeJS.ErrnoException).errno ?? '';
  const errno = errnoCode || String(errnoNumber);

  const cwdExists = fs.existsSync(params.originalCwd);
  const shellExists = fs.existsSync(params.shellExe);

  let scrollbackSuffix = '';
  if (errorMessage.includes('posix_spawnp')) {
    const isPackaged = params.shellExe.includes('app.asar') || params.effectiveCwd.includes('app.asar');
    const fixInstructions = isPackaged
      ? '  Reinstalling the app should resolve this.'
      : '  find node_modules/node-pty -name spawn-helper -exec chmod +x {} \\;';
    scrollbackSuffix = [
      '',
      '\x1b[1;31mError: Failed to spawn shell process (posix_spawnp failed)\x1b[0m',
      '',
      'This is likely caused by node-pty\'s spawn-helper binary missing',
      'execute permissions. To fix:',
      '',
      fixInstructions,
      '',
      'Then restart the app. See https://github.com/Kangentic/kangentic/issues/3',
      '',
    ].join('\r\n');
  }

  return { errorMessage, scrollbackSuffix, errno, cwdExists, shellExists };
}

/**
 * Emit the spawn-failure analytics event. Split from diagnose so tests
 * of diagnose don't need to mock analytics.
 */
export function recordSpawnFailure(params: {
  diagnostic: SpawnFailureDiagnostic;
  shellExe: string;
  shellArgs: string[];
}): void {
  trackEvent('app_error', {
    source: 'pty_spawn',
    message: sanitizeErrorMessage(params.diagnostic.errorMessage),
    shell: params.shellExe,
    shellArgs: params.shellArgs.join(' '),
    cwdExists: String(params.diagnostic.cwdExists),
    shellExists: String(params.diagnostic.shellExists),
    errno: params.diagnostic.errno,
    platform: process.platform,
    arch: process.arch,
  });
}
