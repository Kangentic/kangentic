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
  if (shellName.startsWith('wsl ') || shellName.startsWith('wsl.exe ')) {
    const parts = shell.split(/\s+/);
    // node-pty's ConPTY resolver needs the extension: a bare `wsl` fails its
    // executable search ("File not found", session exits -1 with no output)
    // while `wsl.exe` resolves. Every other picker entry stores a full path;
    // the WSL spec is the only bare name that reaches pty.spawn. The picker
    // emits `wsl -d <distro>`, but a hand-edited config may already carry
    // the `.exe` suffix, so accept both and append only when missing.
    const executable = parts[0].toLowerCase().endsWith('.exe') ? parts[0] : `${parts[0]}.exe`;
    return { exe: executable, args: parts.slice(1) };
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
 * marker except the keeplisted tuning flag below. This is the documented
 * practice for tools that spawn the Claude CLI as a subprocess; it is harmless
 * for non-Claude agents, which ignore these vars, and it deliberately leaves
 * `ANTHROPIC_*` keys (BYOK / API auth) untouched.
 *
 * Also strips `NO_COLOR`, but ONLY when the merged environment carries
 * `CLAUDECODE`, the same parentage marker stripped above. Claude Code exports
 * `NO_COLOR=1` into its tool shells alongside `CLAUDECODE`, so a dev/preview
 * Kangentic launched from inside a Claude Code session would otherwise
 * force-dim every color-capable CLI in every agent PTY (agy honors NO_COLOR
 * and drops to monochrome). A `NO_COLOR` present WITHOUT `CLAUDECODE` is a
 * deliberate user preference and passes through untouched, and an explicit
 * `inputEnv.NO_COLOR` (a caller opting one spawn out of color) always
 * survives. The strip must live here rather than in an adapter buildEnv:
 * adapter env merges over `process.env` and can only add or overwrite, never
 * delete, and overriding with an empty string is unreliable (no-color.org
 * says empty means off, but many implementations check mere presence).
 *
 * Also defaults `TERM=xterm-256color` when the merged environment has no TERM
 * (empty counts as absent: capability detectors treat `TERM=""` as unset).
 * node-pty turns the `name` spawn option into the child's TERM only on POSIX
 * (unixTerminal.js assigns `env.TERM = name`; the Windows agent computes the
 * name and never touches the env), so a child of a PowerShell-launched
 * Kangentic sees no TERM at all and capability-detecting TUIs (agy) render
 * monochrome. The default makes the child env match what POSIX children
 * already get; an explicit TERM in the environment always wins. A TERM-set
 * child env can reopen Claude Code's DECSTBM capability gate, which was
 * measured shut while TERM was unset - see `scrollRegionSuffix()` in
 * `src/main/pty/buffer/headless-frame.ts` for the guard and the measurement.
 *
 * `platform` is injectable for tests (cross-platform parity); production
 * callers omit it.
 */

/**
 * The first of the two `CLAUDE_CODE_*` keys that survive the strip (the
 * keeplist is KEEPLISTED_CLAUDE_CODE_KEYS below), and its Windows default.
 * Unlike the identity markers above, this is a renderer tuning flag:
 * it cannot re-parent a child session. Claude Code's fullscreen TUI
 * intermittently omits history entries from its incremental scrolled-view
 * updates (deep scroll up, ride back down: entries vanish with the layout
 * closed up until a re-anchor - anthropics/claude-code#83714, confirmed
 * producer-side by diffing the raw PTY stream). Full-frame repaints remove
 * the incremental-update path entirely, and Claude Code's own agent views
 * enable this automatically on Windows. Defaulted on win32 only, matching
 * that practice; an explicit value already in the environment (including a
 * user's opt-out) always wins, and non-Claude agents ignore the var, the
 * same argument the strip itself relies on. PARTIAL mitigation: it removes
 * the dominant closed-up flavor, while the rarer blank-band flavor (a
 * window-assembly defect upstream) persists.
 * UNWIND(claude-code#83714): drop this default once the upstream issue is
 * fixed.
 */
export const FULL_REPAINT_ENV_KEY = 'CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT';

/**
 * The second keeplisted renderer tuning flag - keeplisted so a user's
 * exported value survives the strip, but deliberately NOT defaulted. A
 * default of 3 (vim's, per the fullscreen docs) was shipped and reverted the
 * same day: the fullscreen TUI's differential renderer intermittently
 * mis-assembles frames on large scrolled jumps, pipe reads coalesce rapid
 * wheel reports into one jump, and a 3x multiplier tripled every such jump
 * past the corruption threshold (dogfooded; single 3-line jumps rendered
 * clean under controlled injection, coalesced multiples spliced rows). The
 * CLI default of 1 matches the native terminals verified clean. Non-Claude
 * agents ignore the var, the same argument the strip itself relies on.
 * UNWIND(claude-code#83714): the keeplist entry itself stays (a user's
 * exported value must always survive the strip), but the no-default stance
 * exists because of the same upstream mis-assembly - re-evaluate a default
 * alongside the rest of the unwind when upstream fixes the renderer.
 */
export const SCROLL_SPEED_ENV_KEY = 'CLAUDE_CODE_SCROLL_SPEED';

const KEEPLISTED_CLAUDE_CODE_KEYS: ReadonlySet<string> = new Set([
  FULL_REPAINT_ENV_KEY,
  SCROLL_SPEED_ENV_KEY,
]);

export function buildSpawnEnv(
  inputEnv: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const merged = { ...process.env, ...inputEnv };
  // Read the parentage signal before the loop strips CLAUDECODE itself. An
  // explicit caller-supplied NO_COLOR survives: the heuristic targets only
  // the inherited leak, never a deliberate per-spawn choice.
  const stripNoColor = merged.CLAUDECODE !== undefined && inputEnv?.NO_COLOR === undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || (key.startsWith('CLAUDE_CODE_') && !KEEPLISTED_CLAUDE_CODE_KEYS.has(key))) continue;
    if (key === 'NO_COLOR' && stripNoColor) continue;
    result[key] = value;
  }
  if (platform === 'win32' && result[FULL_REPAINT_ENV_KEY] === undefined) {
    result[FULL_REPAINT_ENV_KEY] = '1';
  }
  if (result.TERM === undefined || result.TERM === '') {
    result.TERM = 'xterm-256color';
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
