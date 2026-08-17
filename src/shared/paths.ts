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
 * True when the shell is Unix-like (bash, zsh, fish, nu, wsl) and
 * expects POSIX-style paths.
 *
 * False for cmd.exe (Windows native); PowerShell is handled separately
 * because it needs the `& ` call operator rather than path conversion.
 */
export function isUnixLikeShell(shellName: string): boolean {
  const lower = shellName.toLowerCase();
  return (
    !lower.includes('cmd') &&
    !lower.includes('powershell') &&
    !lower.includes('pwsh')
  );
}

/**
 * True when the shell is cmd.exe (Windows native).
 *
 * cmd terminates the command line on a literal newline mid-quote, so
 * multi-line quoted args have to be flattened before delivery.
 *
 * Match is anchored on the basename (stripped of `.exe`) to avoid false
 * positives on unrelated paths that contain the substring `cmd` (e.g. a
 * tool installed under `/usr/local/cmd-something/`).
 */
export function isCmdShell(shellName: string): boolean {
  const basename = shellName.toLowerCase().split(/[\\/]/).pop() ?? '';
  return basename.replace(/\.exe$/, '') === 'cmd';
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

  if (lower.includes('powershell') || lower.includes('pwsh')) {
    return '& ' + cmd;
  }

  if (isUnixLikeShell(lower)) {
    const isWsl = lower.startsWith('wsl');
    return convertWindowsExePath(cmd, isWsl);
  }

  return cmd;
}

// ---------------------------------------------------------------------------
// PTY-safe text sanitisation
// ---------------------------------------------------------------------------

/**
 * Sanitise text before writing to a PTY.
 *
 * Newlines are interpreted as Enter (submit) by terminal emulators,
 * tabs can trigger autocomplete, and consecutive whitespace is noise.
 * This function collapses all of these into tidy single spaces.
 */
export function sanitizeForPty(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
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
 *  - PowerShell/cmd: double-quotes with backtick, `$`, and `"` escaping
 *
 * When `shell` is omitted, falls back to platform detection:
 *  - Windows: double-quotes with backtick, `$`, and `"` escaping
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
 */
export function quoteArg(
  arg: string,
  shell?: string,
  options?: { multiline?: boolean },
): string {
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
    // PowerShell: ` is escape char, $ triggers variable/subexpression expansion.
    // Escape backticks first (` → ``), then $ ($ → `$), then quotes (" → \").
    // cmd.exe: $ is not special, `` and `$ are harmless literal text.
    const source = preserveNewlines ? arg : sanitizeForPty(arg);
    let escaped = source.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '\\"');
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
