/**
 * Cross-platform path normalization and shell-specific conversions.
 *
 * SINGLE SOURCE OF TRUTH for Node-side path/shell interop in Kangentic.
 * Every main-process module that touches file paths across platforms or
 * shells MUST use these utilities instead of ad-hoc `.replace(/\\/g, '/')`.
 * The renderer cannot import this file (it pulls in `node:path`), so the
 * parts it shares live in `./shell-quote` and are re-exported below.
 *
 * Key invariant: Claude Code stores paths with forward slashes on ALL
 * platforms (e.g. "C:/Users/dev/..."), so any path written to or
 * compared against ~/.claude.json must go through `toForwardSlash()`.
 */
import path from 'node:path';
import {
  escapeForDoubleQuotedShell,
  escapePercentForCmd,
  isBareShellToken,
  isCmdShell,
  isFishShell,
  isNushellShell,
  isPowerShellShell,
  isUnixLikeShell,
  quoteForFish,
  quoteForNushell,
  sanitizeForPty,
} from './shell-quote';

// The shell predicates, `sanitizeForPty`, and the double-quote escapers live in
// `./shell-quote`, which has no Node imports so the renderer can share them.
// The predicates and `sanitizeForPty` are re-exported because this module is the
// documented single source of truth for path/shell interop and 40-odd call sites
// import them by this path. The escapers are NOT: each has one or two callers
// that import it from `./shell-quote` directly, so a re-export here would just
// add a second name for it.
export {
  isCmdShell,
  isFishShell,
  isNushellShell,
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
 * Whether two paths name the same on-disk location, whatever separators or
 * drive-letter case each side used. Both sides are resolved, and case-folded
 * on Windows, where the filesystem is case-insensitive. Use for comparing a
 * path git printed (forward slashes, e.g. `git worktree list --porcelain`)
 * against one Node wrote (backslashes), which a plain string compare never
 * matches on Windows.
 */
export function isSamePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * True for Windows UNC paths: \\server\share or //server/share.
 * Always false on macOS/Linux (single leading slash is not UNC).
 */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(p);
}

/**
 * Parse a path into a WSL distro's own filesystem, as Windows names it:
 * `\\wsl.localhost\<distro>\...` (what `wslpath -w` prints on current
 * builds) or the older `\\wsl$\<distro>\...`, with either slash. Returns the
 * distro and the path as the distro itself sees it, or null for anything
 * else, a bare share root with no distro included.
 *
 *   \\wsl.localhost\Ubuntu\home\dev\.local\bin\claude
 *     -> { distro: 'Ubuntu', linuxPath: '/home/dev/.local/bin/claude' }
 */
export function parseWslUncPath(p: string): { distro: string; linuxPath: string } | null {
  const match = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i.exec(p);
  if (!match) return null;
  const rest = (match[2] ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return { distro: match[1], linuxPath: `/${rest}` };
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
 *   C:\Users\dev                        → /mnt/c/Users/dev
 *   \\wsl.localhost\Ubuntu\home\dev     → /home/dev
 *
 * A path into a distro's own filesystem becomes the path that distro sees,
 * on the assumption that it names the distro the session runs in: another
 * distro's files have no path from inside this one.
 */
export function toWslPath(windowsPath: string): string {
  const wslUncPath = parseWslUncPath(windowsPath);
  if (wslUncPath) return wslUncPath.linuxPath;
  // Other UNC: WSL cannot access Windows UNC shares via /mnt/.
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
 * target shell.
 *
 *  - PowerShell: prefix with `& ` call operator, on every platform
 *  - nushell:    prefix a QUOTED head with `^`, on every platform
 *  - Git Bash:   C:\path → /c/path (Windows only)
 *  - WSL:        C:\path → /mnt/c/path (Windows only)
 *  - cmd:        no conversion
 *
 * PowerShell's `& ` applies on macOS and Linux too, where pwsh can be the login
 * shell `getDefaultShell` returns. Its parser reads a quoted head followed by
 * flags as a string expression and fails ("Unexpected token"), and quoteArg
 * quotes any head outside the bare token set (a Homebrew `node@22` path).
 *
 * nushell runs a string as an external command only behind its `^` sigil (the
 * nushell book, "Strings as external commands"), so the same quoted head needs
 * it there. Only a quoted head gets it: a bare head is already a command.
 *
 * `platform` is injectable for tests (cross-platform parity); production
 * callers omit it.
 */
export function adaptCommandForShell(
  cmd: string,
  shellName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const lower = shellName.toLowerCase();

  // By program name, ahead of the PowerShell substring gate, as in quoteArg.
  if (isNushellShell(lower)) {
    return cmd.startsWith('"') || cmd.startsWith("'") ? '^' + cmd : cmd;
  }

  if (isPowerShellShell(lower)) {
    return '& ' + cmd;
  }

  if (platform !== 'win32') return cmd;

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
 *  - POSIX shells (bash, zsh, sh, WSL): single-quotes (no expansion), an
 *    apostrophe written `'\''`
 *  - fish: single-quotes with every `\` and `'` backslash-escaped, since fish
 *    reads `\\` and `\'` inside them (`quoteForFish`)
 *  - nushell: double-quotes escaping `\` and `"`, since its single quotes have
 *    no escapes and cannot hold an apostrophe (`quoteForNushell`)
 *  - PowerShell: double-quotes, backtick escaping, backslash left alone
 *  - cmd.exe: double-quotes, a trailing backslash run doubled for the C runtime,
 *    backtick left alone, and each `%` broken out of the quotes so cmd cannot
 *    expand `%NAME%`
 *
 * Both Windows branches write a content `"` as `'`, the only form no Windows
 * shell lets out of the argument. The two branches are otherwise NOT
 * interchangeable; `escapeForDoubleQuotedShell` and `escapePercentForCmd` in
 * `./shell-quote` carry the measured round-trips.
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
 *  - POSIX shells and fish: literal newlines inside `'...'` are taken as
 *    content. Single-quoted strings handle this natively.
 *  - nushell: `\n` / `\t` escapes inside `"..."`, one physical line.
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
/**
 * Whether `quoteArg(..., { multiline: true })` keeps a value's newlines under
 * `shell`. cmd.exe has no escape for one, so its value is flattened to one
 * line, and so is a value quoted with no shell hint, which cannot tell
 * PowerShell from cmd. Every other shell keeps them.
 */
export function quoteArgKeepsNewlines(shell: string | undefined): boolean {
  return shell !== undefined && !isCmdShell(shell);
}

export function quoteArg(
  arg: string,
  shell?: string,
  options?: { multiline?: boolean },
): string {
  if (arg === '--' && shell !== undefined && isPowerShellShell(shell)) {
    return '"--"';
  }
  if (isBareShellToken(arg)) {
    return arg;
  }
  // Unix-like for paths, but not POSIX for quotes: nushell's single quotes
  // cannot hold an apostrophe at all, and fish reads `\\` and `\'` inside them.
  // Decided by program name ahead of the substring gates below, so a fish under
  // a directory named cmd is still fish.
  if (shell && (isNushellShell(shell) || isFishShell(shell))) {
    const source = options?.multiline === true ? arg : sanitizeForPty(arg);
    return isNushellShell(shell) ? quoteForNushell(source) : quoteForFish(source);
  }
  const useDoubleQuotes = shell
    ? !isUnixLikeShell(shell)
    : process.platform === 'win32';
  const isCmd = shell ? isCmdShell(shell) : false;
  const preserveNewlines = options?.multiline === true && quoteArgKeepsNewlines(shell);

  if (useDoubleQuotes) {
    // Per-shell escaping, because cmd.exe and PowerShell disagree about the
    // backslash: see escapeForDoubleQuotedShell for the measured round-trips.
    const source = preserveNewlines ? arg : sanitizeForPty(arg);
    let escaped = escapeForDoubleQuotedShell(source, isCmd);
    if (isCmd) {
      // cmd expands %NAME% even inside the quotes. Running this after the
      // quote and trailing-backslash escapes is safe, because a trailing run
      // is never followed by `%` and the rewrite never ends in a backslash.
      escaped = escapePercentForCmd(escaped);
    }
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
  // network shares, but handle gracefully if they are. For WSL, a path into a
  // distro's own filesystem (a CLI installed in the distro, configured by its
  // \\wsl.localhost path) becomes the path the distro sees.
  const convertUncPath = (uncPath: string): string =>
    (isWsl ? parseWslUncPath(uncPath)?.linuxPath : undefined) ?? toForwardSlash(uncPath);

  if (cmd.startsWith('"\\\\')) {
    return cmd.replace(
      /^"(\\\\[^"]+)"/,
      (_m, uncPath: string) => `"${convertUncPath(uncPath)}"`,
    );
  }
  if (cmd.startsWith("'\\\\")) {
    return cmd.replace(
      /^'(\\\\[^']+)'/,
      (_m, uncPath: string) => `'${convertUncPath(uncPath)}'`,
    );
  }
  if (cmd.startsWith('\\\\')) {
    return cmd.replace(
      /^(\\\\[^\s]+)/,
      (_m, uncPath: string) => convertUncPath(uncPath),
    );
  }

  // The repeated groups below exclude `\` from their character classes so a
  // backslash run has exactly one parse; the ambiguous `(?:\\[^X]+)+` shape
  // backtracks exponentially on adversarial input.

  // Like the single-quoted branch below, the converted path is re-emitted
  // quoted unconditionally: quoteArg's win32 fallback (a caller that passes
  // no shell) double-quotes the cliPath, and stripping the quotes
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
