/**
 * Cross-platform path normalization and shell-specific conversions.
 *
 * SINGLE SOURCE OF TRUTH for all path ↔ shell interop in Kangentic.
 * Every module that touches file paths across platforms or shells
 * MUST use these utilities instead of ad-hoc `.replace(/\\/g, '/')`.
 *
 * Key invariant: Claude Code stores paths with forward slashes on ALL
 * platforms (e.g. "C:/Users/tyler/..."), so any path written to or
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

// ---------------------------------------------------------------------------
// Shell-specific executable path conversion (Windows only)
// ---------------------------------------------------------------------------

/**
 * Convert a Windows-style path to Git Bash POSIX format.
 *   C:\Users\tyler → /c/Users/tyler
 */
export function toGitBashPath(windowsPath: string): string {
  return windowsPath.replace(
    /^([A-Za-z]):(.*)/,
    (_m, drive: string, rest: string) =>
      `/${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`,
  );
}

/**
 * Convert a Windows-style path to WSL POSIX format.
 *   C:\Users\tyler → /mnt/c/Users/tyler
 */
export function toWslPath(windowsPath: string): string {
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
 * Convert the executable path at the start of a command string for the
 * target shell. Only transforms on Windows; returns unmodified on macOS/Linux.
 *
 *  - PowerShell: prefix with `& ` call operator
 *  - Git Bash:   C:\path → /c/path
 *  - WSL:        C:\path → /mnt/c/path
 *  - cmd:        no conversion
 */
export function adaptCommandForShell(cmd: string, shellName: string): string {
  if (process.platform !== 'win32') return cmd;

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
// CLI argument quoting
// ---------------------------------------------------------------------------

/**
 * Quote a CLI argument if it contains characters that need escaping.
 *
 * Simple args (alphanumeric + `._/:-`) are left unquoted.
 * Backslashes are NOT considered simple — they're escape characters
 * in Unix-like shells (Git Bash, WSL).
 *
 *  - Windows: double-quotes, escaped `"`
 *  - Unix:    single-quotes, escaped `'`
 */
export function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9_.\/:-]+$/.test(arg)) {
    return arg;
  }
  // Replace literal newlines with spaces — PTY shells interpret newlines
  // as line-break / execute, which splits the command across multiple lines.
  const sanitised = arg.replace(/\r?\n/g, ' ');
  if (process.platform === 'win32') {
    return `"${sanitised.replace(/"/g, '\\"')}"`;
  }
  return `'${sanitised.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Windows-style executable path at the START of a command to
 * POSIX format. Handles both quoted and unquoted paths.
 *
 * Quoted:   "C:\path with spaces\exe" --flag  →  /c/path with spaces/exe --flag
 * Unquoted: C:\path\to\exe --flag             →  /c/path/to/exe --flag
 */
function convertWindowsExePath(cmd: string, isWsl: boolean): string {
  const prefix = isWsl ? '/mnt/' : '/';

  if (cmd.startsWith('"')) {
    return cmd.replace(
      /^"([A-Za-z]):((?:\\[^"]+)+)"/,
      (_m, drive: string, rest: string) => {
        const posix = `${prefix}${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`;
        return posix.includes(' ') ? `"${posix}"` : posix;
      },
    );
  }

  return cmd.replace(
    /^([A-Za-z]):((?:\\[^\s]+)+)/,
    (_m, drive: string, rest: string) =>
      `${prefix}${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`,
  );
}
