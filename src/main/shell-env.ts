import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_SHELL_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/bin/zsh',
  linux: '/bin/bash',
};

// Delimiters bracket the env dump so rc-file output (oh-my-zsh banners,
// powerlevel10k instant-prompts, nvm version echoes, motd, etc.) can be
// stripped. Underscore+uppercase-only so no shell glob or quoting
// concerns when they are embedded in single-quoted printf arguments.
const START_MARKER = '___KANGENTIC_ENV_BEGIN___';
const END_MARKER = '___KANGENTIC_ENV_END___';

// Guard against a future rename that could introduce quotes or backslashes,
// which would break the single-quoted printf argument below.
if (/['\\]/.test(START_MARKER) || /['\\]/.test(END_MARKER)) {
  throw new Error('shell-env markers must not contain single quotes or backslashes');
}

// oh-my-zsh's auto-update check can block 5-10s on first daily run.
// Pass a flag that disables it just for our probe.
const OMZ_DISABLE_AUTO_UPDATE = 'true';

// 10s is the same budget VSCode's vscode-shell-env uses. Shorter risks
// timing out on first-boot rc files (nvm init, pyenv init, rbenv init,
// oh-my-zsh update check). Longer would user-visibly delay startup.
const SHELL_TIMEOUT_MS = 10_000;

/**
 * Outcome of parsing the shell's env dump. `null` means the delimiter
 * markers were not found in stdout, which indicates the shell did not
 * successfully run our command (rc error, shell exited early, stdout
 * was redirected). Empty string means the markers were found but no
 * `PATH=` line was present inside.
 */
type PathParseResult = string | null;

/**
 * On macOS, apps launched from Finder/Spotlight/Dock inherit a minimal
 * PATH from launchd (roughly /usr/bin:/bin:/usr/sbin:/sbin), not the
 * user's shell PATH from ~/.zshrc or ~/.bash_profile. The same problem
 * exists on Linux for apps launched from GNOME/KDE desktop launchers.
 *
 * This helper spawns the user's login shell, reads its PATH, and merges
 * any new segments into process.env.PATH so downstream consumers
 * (agent detection via `which()`, git, child_process.spawn) can find
 * user-installed binaries like Claude Code, Codex, Gemini, Aider, etc.
 *
 * Implementation detail: we run `/usr/bin/env` inside the shell and
 * parse its output rather than echoing $PATH directly. Reasons:
 *   1. Works across all POSIX shells AND fish (fish treats $PATH as an
 *      array, so `echo $PATH` produces space-separated not colon-sep).
 *      `/usr/bin/env` always prints colon-separated PATH regardless.
 *   2. Isolates us from user-defined echo/printf aliases.
 *   3. Is the same pattern used by shell-env / fix-path (Sindre
 *      Sorhus's canonical packages that ship in VSCode, GitHub
 *      Desktop, Slack, Discord, and most major Electron apps).
 *
 * The fix is scoped to PATH only - we do not import arbitrary
 * environment variables from the user's shell. Any failure (timeout,
 * shell rc error, parse error) is logged and ignored; the app
 * continues with whatever PATH it had, relying on fallback paths
 * wired into each AgentDetector.
 *
 * Set KANGENTIC_SHELL_ENV=off to skip this step entirely (escape
 * hatch for users whose rc files hang or error).
 */
export async function restoreShellEnv(): Promise<void> {
  if (process.platform === 'win32') return;
  if (process.env.KANGENTIC_SHELL_ENV === 'off') return;

  const shell = process.env.SHELL || DEFAULT_SHELL_BY_PLATFORM[process.platform];
  if (!shell) return;

  let parsed: PathParseResult;
  try {
    parsed = await readShellPath(shell);
  } catch (error) {
    console.warn(
      `[shell-env] Failed to spawn ${shell} -ilc. Agent detection will rely on fallback paths; ` +
      'configure an explicit cliPath in Settings if your CLI is installed in a non-standard location. Error:',
      (error as Error).message,
    );
    return;
  }

  if (parsed === null) {
    console.warn(
      `[shell-env] ${shell} ran but stdout did not contain our delimiter markers. ` +
      'Likely cause: an rc file errored before the probe command ran, or stdout was redirected. ' +
      'Falling back to pre-existing PATH.',
    );
    return;
  }

  if (parsed === '') {
    console.warn(`[shell-env] ${shell} env dump had no PATH entry; leaving process.env.PATH unchanged`);
    return;
  }

  const before = process.env.PATH ?? '';
  const merged = mergePathSegments(before, parsed);
  if (merged !== before) {
    process.env.PATH = merged;
    console.log(`[shell-env] PATH restored from ${shell} (added ${countAddedSegments(before, merged)} segments)`);
  }
}

/**
 * Spawn `<shell> -ilc 'printf MARKER; /usr/bin/env; printf MARKER'` and
 * extract the PATH= line from the env dump.
 *
 * Flags:
 *   -i   interactive (so zsh sources .zshrc, bash sources .bashrc, etc.)
 *   -l   login (so bash sources .bash_profile / .profile, zsh sources .zprofile)
 *   -c   run the command string and exit
 *
 * Both -i and -l are needed because different users put `export PATH=...`
 * in different files (login vs interactive). The combo is what shell-env
 * and fix-path use and what has proven reliable across thousands of
 * Electron apps.
 *
 * We pass a minimal env to the shell (only DISABLE_AUTO_UPDATE and
 * TERM=dumb) so the shell builds its PATH from scratch via rc files.
 * TERM=dumb discourages rc files from emitting color codes or launching
 * prompt frameworks that may hang waiting for a tty.
 */
async function readShellPath(shell: string): Promise<PathParseResult> {
  const command = buildShellCommand();

  const { stdout } = await execFileAsync(
    shell,
    ['-ilc', command],
    {
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10 MB - user env can be large (e.g. GH Codespaces secrets, GPG_TTY lists)
      env: {
        DISABLE_AUTO_UPDATE: OMZ_DISABLE_AUTO_UPDATE,
        TERM: 'dumb',
      },
      windowsHide: true, // no-op on darwin/linux but harmless
    },
  );

  return parsePathFromEnvDump(stdout);
}

/**
 * Build the shell command. Uses printf (POSIX) to bracket the env dump
 * with our delimiters. Works in bash, zsh, dash, ksh, sh, and fish
 * (fish's builtin printf accepts the same format string).
 */
function buildShellCommand(): string {
  // printf '%s' MARKER uses an absolute path to avoid any alias/function
  // shadowing. /usr/bin/printf exists on macOS and Linux. /usr/bin/env
  // likewise.
  //
  // The markers are underscore+uppercase only (guarded at module load),
  // so single-quote wrapping is safe without escaping.
  return [
    `/usr/bin/printf '%s' '${START_MARKER}'`,
    '/usr/bin/env',
    `/usr/bin/printf '%s' '${END_MARKER}'`,
  ].join('; ');
}

/**
 * Extract the PATH= line from the env dump bracketed by START/END markers.
 *
 * Returns:
 *   - `null`   when the markers are not found in stdout. Indicates the
 *              shell did not successfully execute our command (rc error,
 *              early exit, stdout redirected).
 *   - `''`     when markers are found but no `PATH=` line is present.
 *              Indicates the shell ran but has no PATH set.
 *   - string   the PATH value when successfully extracted.
 */
export function parsePathFromEnvDump(stdout: string): PathParseResult {
  const startIndex = stdout.indexOf(START_MARKER);
  if (startIndex < 0) return null;
  const endIndex = stdout.indexOf(END_MARKER, startIndex + START_MARKER.length);
  if (endIndex < 0) return null;

  const envBlock = stdout.slice(startIndex + START_MARKER.length, endIndex);

  // env output is one KEY=VALUE per line. PATH values cannot contain
  // newlines, so the first newline after `PATH=` ends the value.
  for (const line of envBlock.split('\n')) {
    if (line.startsWith('PATH=')) {
      return line.slice('PATH='.length).trim();
    }
  }
  return '';
}

/**
 * Merge two colon-separated PATH strings, preserving the order of
 * `existing` first (so anything already in process.env.PATH keeps its
 * priority) and appending unique segments from `shellPath`.
 *
 * Empty segments are dropped.
 */
export function mergePathSegments(existing: string, shellPath: string): string {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const segment of existing.split(':')) {
    if (!segment) continue;
    if (seen.has(segment)) continue;
    seen.add(segment);
    result.push(segment);
  }

  for (const segment of shellPath.split(':')) {
    if (!segment) continue;
    if (seen.has(segment)) continue;
    seen.add(segment);
    result.push(segment);
  }

  return result.join(':');
}

function countAddedSegments(before: string, after: string): number {
  const beforeCount = before.split(':').filter(Boolean).length;
  const afterCount = after.split(':').filter(Boolean).length;
  return Math.max(0, afterCount - beforeCount);
}
