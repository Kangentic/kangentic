/**
 * Cross-platform path normalization and shell-specific conversions.
 *
 * SINGLE SOURCE OF TRUTH for all path ↔ shell interop in Kangentic.
 * Every module that touches file paths across platforms or shells
 * MUST use these utilities instead of ad-hoc `.replace(/\\/g, '/')`.
 *
 * Key invariant: Claude Code stores paths with forward slashes on ALL
 * platforms (e.g. "C:/Users/dev/..."), so any path written to or
 * compared against ~/.claude.json must go through `toForwardSlash()`.
 */
import path from 'node:path';
import {
  escapeForDoubleQuotedShell,
  isCmdShell,
  isPowerShellShell,
  isUnixLikeShell,
  sanitizeForPty,
} from './shell-quote';

// The shell predicates, `sanitizeForPty`, and the double-quote escaper live in
// `./shell-quote`, which has no Node imports so the renderer can share them.
// The predicates and `sanitizeForPty` are re-exported because this module is the
// documented single source of truth for path/shell interop and 40-odd call sites
// import them by this path. `escapeForDoubleQuotedShell` is NOT: `quoteArg` is
// the only main-process caller and the renderer imports it from `./shell-quote`
// directly, so a re-export here would just add a second name for it.
export {
  isCmdShell,
  isPowerShellShell,
  isUnixLikeShell,
  sanitizeForPty,
};

// ---------------------------------------------------------------------------
// Path normalisation
// ---------------------------------------------------------------------------

/**
 * Replace every backslash with a forward slash.
 *
 * Use for:
 *  - Paths written to ~/.claude.json (Claude Code convention)
 *  - Settings paths passed as CLI args (work in all shells)
 *  - Any cross-platform comparison of resolved paths
 */
export function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * `path.resolve()` + forward-slash normalisation in one call.
 * Convenience for the most common pattern:
 *   `toForwardSlash(path.resolve(somePath))`
 */
export function resolveForwardSlash(p: string): string {
  return toForwardSlash(path.resolve(p));
}

/**
 * True for Windows UNC paths: \\server\share or //server/share.
 * Always false on macOS/Linux (single leading slash is not UNC).
 */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(p);
}

/**
 * Replace `oldPrefix` with `newPrefix` in `target` when `target` is the
 * prefix itself or a path under it. Returns null when the target is not
 * under the old prefix (different drive, sibling directory, unrelated path).
 *
 * Uses `path.relative` rather than string comparison so Windows drive-letter
 * case and separator differences don't break the match.
 */
export function replacePathPrefix(target: string, oldPrefix: string, newPrefix: string): string | null {
  const relative = path.relative(oldPrefix, target);
  if (relative === '') return newPrefix;
  // The isAbsolute guard is load-bearing: on Windows, a target on a
  // DIFFERENT DRIVE yields an absolute path (not a '..' traversal).
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return path.join(newPrefix, relative);
}

// ---------------------------------------------------------------------------
// Shell-specific executable path conversion (Windows only)
// ---------------------------------------------------------------------------

/**
 * Convert a Windows-style path to Git Bash POSIX format.
 *   C:\Users\dev → /c/Users/dev
 */
export function toGitBashPath(windowsPath: string): string {
  // UNC: \\server\share\path -> //server/share/path (Git Bash UNC format)
  if (isUncPath(windowsPath)) {
    return windowsPath.replace(/\\/g, '/');
  }
  return windowsPath.replace(
    /^([A-Za-z]):(.*)/,
    (_m, drive: string, rest: string) =>
      `/${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`,
  );
}

/**
 * Convert a Windows-style path to WSL POSIX format.
 *   C:\Users\dev → /mnt/c/Users/dev
 */
export function toWslPath(windowsPath: string): string {
  // UNC: WSL cannot access Windows UNC shares via /mnt/.
  // Convert slashes as best-effort; user must mount the share in WSL.
  if (isUncPath(windowsPath)) {
    return windowsPath.replace(/\\/g, '/');
  }
  return windowsPath.replace(
    /^([A-Za-z]):(.*)/,
    (_m, drive: string, rest: string) =>
      `/mnt/${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`,
  );
}

/**
 * The shell-native "clear the screen" statement to prefix onto a typed
 * agent-spawn command, so the SHELL erases its own startup preamble and
 * command echo the instant it executes - before the agent's first byte.
 *
 * This is the spawn-boundary strategy that stays out of the heuristics
 * business: the pre-agent noise (ConPTY init, prompt, echoed command line)
 * is bytes Kangentic does not control and pwsh/ConPTY updates keep
 * reshaping (pwsh 7.6 started emitting \x1b[?25l and \x1b[2J in its startup
 * preamble, which broke every marker that tried to INFER where the shell
 * ends and the agent begins). A clear emitted BY the shell rides the real
 * byte stream, so the live terminal, the scrollback ring, the headless
 * parser, every replay, and the phone all clean themselves natively with
 * zero Kangentic-side parsing - and it hands the buffer manager's pre-TUI
 * strip (PtyBufferManager.pendingPreTuiScrollbackClear) a deterministic
 * clear to anchor on, emitted by us rather than guessed from TUI behavior.
 *
 * Statement separators are deliberate per family: `;` continues after the
 * clear in PowerShell and POSIX-ish shells (bash, zsh, fish, nu, git-bash,
 * WSL all ship a `clear` builtin/binary), cmd chains with `&`.
 */
export function buildSpawnClearPrelude(shellName: string): string {
  if (isPowerShellShell(shellName)) {
    return 'Clear-Host; ';
  }
  if (isCmdShell(shellName)) {
    return 'cls & ';
  }
  return 'clear; ';
}

/**
 * Convert the executable path at the start of a command string for the
 * target shell. Only transforms on Windows; returns unmodified on macOS/Linux.
 *
 *  - PowerShell: prefix with `& ` call operator
 *  - Git Bash:   C:\path → /c/path
 *  - WSL:        C:\path → /mnt/c/path
 *  - cmd:        no conversion
 *
 * `platform` is injectable for tests (cross-platform parity); production
 * callers omit it.
 */
export function adaptCommandForShell(
  cmd: string,
  shellName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return cmd;

  const lower = shellName.toLowerCase();

  if (isPowerShellShell(lower)) {
    return '& ' + cmd;
  }

  if (isUnixLikeShell(lower)) {
    const isWsl = lower.startsWith('wsl');
    return convertWindowsExePath(cmd, isWsl);
  }

  return cmd;
}

// ---------------------------------------------------------------------------
// CLI argument quoting
// ---------------------------------------------------------------------------

/**
 * Quote a CLI argument if it contains characters that need escaping.
 *
 * Simple args (alphanumeric + `._/:-`) are left unquoted.
 * Backslashes are NOT considered simple -- they're escape characters
 * in Unix-like shells (Git Bash, WSL).
 *
 * When `shell` is provided, quoting style is chosen by shell type:
 *  - Unix-like shells (bash, zsh, fish, WSL): single-quotes (no expansion)
 *  - PowerShell: double-quotes, backtick escaping, backslash left alone
 *  - cmd.exe: double-quotes, C-runtime backslash escaping, backtick left alone
 *
 * The two Windows branches are NOT interchangeable; `escapeForDoubleQuotedShell`
 * in `./shell-quote` carries the measured round-trips.
 *
 * When `shell` is omitted, falls back to platform detection:
 *  - Windows: the PowerShell branch
 *  - Unix:    single-quotes, escaped `'`
 *
 * Pass `{ multiline: true }` for prompt-style content where newlines must
 * survive into the quoted output (e.g. the `<task>` XML envelope). Default
 * behaviour collapses `\r\n\t` into single spaces via `sanitizeForPty`.
 *
 * Per-shell multi-line strategy (each preserves newlines as a single physical
 * input line so the PTY never has to handle continuation):
 *  - Unix-like shells (bash, zsh, fish, WSL): literal newlines inside `'...'`
 *    are taken as content. POSIX single-quoted strings handle this natively.
 *  - PowerShell/pwsh: convert `\n`/`\t` to `` `n ``/`` `t `` escape sequences
 *    inside `"..."`. PowerShell continuation via PTY is unreliable (PSReadLine
 *    behaves differently from interactive typing), so we pin everything to one
 *    physical line and let PowerShell's escape parser produce the newlines.
 *  - cmd.exe: no escape syntax for embedded newlines; falls back to the
 *    sanitised single-line form.
 *
 * The PowerShell strategy holds only while PowerShell launches the target
 * binary itself. When the command head is a `.cmd` / `.bat` shim (an npm
 * global install on Windows), PowerShell expands the escapes and hands the
 * result to cmd.exe, whose command line ends at the first newline, so the
 * agent sees the first line only (#353). The spawn chokepoints route such
 * heads through `resolveShimLaunch` (src/main/agent/shared/shim-launch.ts)
 * before any builder runs, so builders may keep relying on this contract.
 *
 * A bare `--` is quoted for PowerShell hosts. PowerShell's parameter binder
 * consumes an unquoted `--` before a `.ps1` script (the npm shim
 * `resolveShimLaunch` prefers) sees `$args`, while the quoted form reaches
 * native commands and cmd.exe as a plain `--` on every route.
 */
export function quoteArg(
  arg: string,
  shell?: string,
  options?: { multiline?: boolean },
): string {
  if (arg === '--' && shell !== undefined && isPowerShellShell(shell)) {
    return '"--"';
  }
  if (/^[a-zA-Z0-9_./:-]+$/.test(arg)) {
    return arg;
  }
  const useDoubleQuotes = shell
    ? !isUnixLikeShell(shell)
    : process.platform === 'win32';
  const isCmd = shell ? isCmdShell(shell) : false;
  // multiline=true with no shell hint falls back to sanitisation: we can't
  // tell PowerShell from cmd, and only the unix branch tolerates raw newlines.
  const preserveNewlines = options?.multiline === true && shell !== undefined && !isCmd;

  if (useDoubleQuotes) {
    // Per-shell escaping, because cmd.exe and PowerShell disagree about the
    // backslash: see escapeForDoubleQuotedShell for the measured round-trips.
    const source = preserveNewlines ? arg : sanitizeForPty(arg);
    let escaped = escapeForDoubleQuotedShell(source, isCmd);
    if (preserveNewlines) {
      // Convert real newlines/tabs to PowerShell escape sequences. These are
      // NEW backticks (not literal content), so the parser interprets them as
      // a single newline/tab character inside the quoted string. Order: CRLF
      // first (so the LF in CRLF is consumed), then lone LF, then lone CR
      // (rare classic-Mac line endings), then tabs.
      escaped = escaped
        .replace(/\r\n/g, '`n')
        .replace(/\n/g, '`n')
        .replace(/\r/g, '`n')
        .replace(/\t/g, '`t');
    }
    return `"${escaped}"`;
  }
  const source = preserveNewlines ? arg : sanitizeForPty(arg);
  return `'${source.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Windows executable path conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Windows-style executable path at the START of a command to
 * POSIX format. Handles unquoted, double-quoted, and single-quoted paths;
 * single quotes are what `quoteArg` emits for unix-like shells.
 *
 * Double:   "C:\path\to\exe" --flag  →  "/c/path/to/exe" --flag
 * Single:   'C:\path\to\exe' --flag  →  '/c/path/to/exe' --flag
 * Unquoted: C:\path\to\exe --flag    →  /c/path/to/exe --flag
 *
 * A quoted token STAYS quoted (same quote character) even without spaces:
 * legal Windows paths can contain shell-active characters (& $ parens), and
 * the quotes are what keep them inert in the target shell. Double-quoted
 * input keeps double quotes rather than upgrading to single quotes, because
 * a path containing a literal single quote is representable inside double
 * quotes but not inside a naive single-quoted rewrap.
 */
export function convertWindowsExePath(cmd: string, isWsl: boolean): string {
  const convertDrivePath = isWsl ? toWslPath : toGitBashPath;

  // UNC paths (\\server\share) - normalize slashes in the exe path only,
  // leaving arguments after it unchanged. Exe paths are almost never on
  // network shares, but handle gracefully if they are.
  if (cmd.startsWith('"\\\\')) {
    return cmd.replace(
      /^"(\\\\[^"]+)"/,
      (_m, uncPath: string) => `"${toForwardSlash(uncPath)}"`,
    );
  }
  if (cmd.startsWith("'\\\\")) {
    return cmd.replace(
      /^'(\\\\[^']+)'/,
      (_m, uncPath: string) => `'${toForwardSlash(uncPath)}'`,
    );
  }
  if (cmd.startsWith('\\\\')) {
    return cmd.replace(
      /^(\\\\[^\s]+)/,
      (_m, uncPath: string) => toForwardSlash(uncPath),
    );
  }

  // The repeated groups below exclude `\` from their character classes so a
  // backslash run has exactly one parse; the ambiguous `(?:\\[^X]+)+` shape
  // backtracks exponentially on adversarial input.

  // Like the single-quoted branch below, the converted path is re-emitted
  // quoted unconditionally: quoteArg's win32 fallback (a transient session
  // with no shell hint) double-quotes the cliPath, and stripping the quotes
  // on a spaceless path would let shell-active characters in a legal
  // Windows path (& parens) become live bash syntax.
  if (cmd.startsWith('"')) {
    return cmd.replace(
      /^"([A-Za-z]):((?:\\[^"\\]*)+)"/,
      (_m, drive: string, rest: string) => `"${convertDrivePath(`${drive}:${rest}`)}"`,
    );
  }

  // quoteArg emits this form for unix-like shells (Git Bash, WSL). The
  // converted path is re-emitted single-quoted unconditionally: stripping
  // the quotes would let shell-active characters in a legal Windows path
  // (& $ parens) become live syntax. A path containing a literal single
  // quote arrives as 'C:\...'\''...' (POSIX escaping), so the match stops
  // at the first quote and the tail keeps its backslashes; such a path
  // fails to resolve, the same outcome it had before this branch existed.
  // Accepted - a robust fix means converting before quoting, not
  // re-parsing the quoted form.
  if (cmd.startsWith("'")) {
    return cmd.replace(
      /^'([A-Za-z]):((?:\\[^'\\]*)+)'/,
      (_m, drive: string, rest: string) => `'${convertDrivePath(`${drive}:${rest}`)}'`,
    );
  }

  return cmd.replace(
    /^([A-Za-z]):((?:\\[^\s\\]*)+)/,
    (_m, drive: string, rest: string) => convertDrivePath(`${drive}:${rest}`),
  );
}
