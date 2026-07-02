import fs from 'node:fs';
import os from 'node:os';
import { isUncPath, isCmdShell } from '../../../shared/paths';
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
 * Strips the parent Claude Code session's detection/identity markers. When
 * Kangentic is launched from inside a Claude Code session (the team dogfoods
 * this way, and `/preview` is often started from an agent), Claude Code exports
 * these into the environment and they would otherwise leak into every spawned
 * agent PTY:
 *   - `CLAUDECODE`               - "you are inside Claude Code" (made the child refuse to start)
 *   - `CLAUDE_CODE_ENTRYPOINT`   - the parent's entry point (e.g. `cli`)
 *   - `CLAUDE_CODE_CHILD_SESSION`- "you are a nested session" (Claude Code v2.1.172+)
 *   - `CLAUDE_CODE_SESSION_ID`   - the PARENT's session UUID
 *   - `CLAUDE_CODE_EXECPATH`     - the parent's claude binary
 *
 * A child that inherits the parent's session identity does not persist its own
 * transcript under the `--session-id <uuid>` Kangentic assigns it, so a later
 * `claude --resume <uuid>` reports "No conversation found" and the conversation
 * is lost on a Done -> back round-trip. (Clearing `CLAUDECODE` alone, the prior
 * behavior, only stopped the child from refusing to start.) A Kangentic-spawned
 * agent must always be a clean top-level session, so drop every `CLAUDE_CODE_*`
 * marker. This is the documented practice for tools that spawn the Claude CLI as
 * a subprocess; it is harmless for non-Claude agents, which ignore these vars,
 * and it deliberately leaves `ANTHROPIC_*` keys (BYOK / API auth) untouched.
 */
export function buildSpawnEnv(
  inputEnv: Record<string, string> | undefined,
): Record<string, string> {
  const merged = { ...process.env, ...inputEnv };
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Resolution of the spawn working directory.
 *
 * - `effectiveCwd` is what should be passed to node-pty.
 * - `cwdFixupCommand`, when non-null, is a shell command the caller must
 *   write into the PTY before the user command so the session lands in the
 *   real project directory. Two mutually-exclusive Windows quirks produce it:
 *     1. cmd.exe + UNC cwd: cmd cannot use a UNC path as its cwd, so
 *        `effectiveCwd` is REPLACED with home and the fixup is
 *        `pushd "<unc>"` (maps the UNC path to a temporary drive letter).
 *     2. PowerShell + bracketed cwd: `effectiveCwd` is LEFT UNCHANGED (the
 *        Win32 process cwd is valid) and the fixup is
 *        `Set-Location -LiteralPath '<cwd>'` to correct PowerShell's
 *        provider location. See `resolveSpawnCwd` for the quirk details.
 */
export interface SpawnCwdResolution {
  effectiveCwd: string;
  cwdFixupCommand: string | null;
}

/**
 * Validate the requested cwd and handle Windows-specific quirks:
 *
 *  - Fall back to the user's home directory if the requested cwd does
 *    not exist. A live session in `~` is strictly better than a dead
 *    session with exit code -1. Emits a diagnostic analytics event.
 *  - cmd.exe cannot use a UNC path as its cwd (it prints
 *    "UNC paths are not supported" and defaults to C:\Windows). When
 *    we detect this, REPLACE the cwd with home and return a `pushd "<unc>"`
 *    fixup that the caller must write before the user command.
 *    PowerShell and Git Bash handle UNC cwds natively, so no fixup.
 *  - Windows PowerShell 5.1 (`powershell.exe`, the default Windows shell)
 *    treats `[` / `]` in its startup path as wildcard characters: launched
 *    with a valid Win32 cwd like `D:\[foo]\bar` its path provider fails to
 *    resolve the location and silently falls back to `$PSHOME`
 *    (`C:\Windows\System32\WindowsPowerShell\v1.0`), so the agent CLI it
 *    spawns runs against the wrong workspace. node-pty's `cwd` is still a
 *    valid Win32 directory, so we LEAVE `effectiveCwd` unchanged and return
 *    a `Set-Location -LiteralPath '<cwd>'` fixup that corrects the provider
 *    location. Applied to the whole PowerShell family (powershell + pwsh):
 *    the fixup is harmless in pwsh 7, and full shell paths make edition
 *    detection by name unreliable.
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

  const lowerShellName = input.shellName.toLowerCase();
  let cwdFixupCommand: string | null = null;
  if (input.platform === 'win32') {
    if (isUncPath(effectiveCwd) && isCmdShell(input.shellName)) {
      cwdFixupCommand = `pushd "${effectiveCwd}"`;
      effectiveCwd = os.homedir();
    } else if (
      (lowerShellName.includes('powershell') || lowerShellName.includes('pwsh'))
      && /[[\]]/.test(effectiveCwd)
    ) {
      const escapedCwd = effectiveCwd.replace(/'/g, "''");
      cwdFixupCommand = `Set-Location -LiteralPath '${escapedCwd}'`;
    }
  }

  return { effectiveCwd, cwdFixupCommand };
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
