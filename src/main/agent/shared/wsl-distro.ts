import { execFileAsync } from '../../utility-process/off-main-exec';
import { childProcessEnv } from '../../shared/child-env';

/**
 * What every layer that reaches an agent CLI installed inside a WSL distro
 * needs to know about that distro, read once per distro and cached:
 *
 * - where its home is, as the distro sees it and as Windows reaches it, for
 *   the files a CLI keeps there (trust, transcripts, rollouts);
 * - the PATH an INTERACTIVE shell gives the user, because a version-managed
 *   node (nvm) resolves only there: Ubuntu's `~/.bashrc` returns early for a
 *   non-interactive shell and nvm appends below that guard, so a login shell
 *   is not enough;
 * - the agent home overrides set in that shell (`CODEX_HOME` and the like);
 * - the networking mode, which decides how a session reaches the MCP server.
 *
 * Re-detect clears the cache, so an install or a `.bashrc` edit is picked up.
 */
export interface WslDistroFacts {
  distro: string;
  /** `$HOME` as the distro sees it: `/home/dev`. */
  homeLinux: string;
  /** `$HOME` as Windows reaches it: `\\wsl.localhost\Ubuntu\home\dev`. */
  homeUnc: string;
  /** The distro's root as Windows reaches it, with no trailing separator: `\\wsl.localhost\Ubuntu`. */
  uncRoot: string;
  /** PATH in the user's interactive shell. */
  interactivePath: string;
  /** Only the keys in `WSL_ENV_KEYS`. Nothing else the shell holds is kept. */
  env: Partial<Record<WslEnvKey, string>>;
  networkingMode: 'nat' | 'mirrored' | 'unknown';
}

/**
 * The environment keys kept from the distro's shell: agent home overrides and
 * the XDG base directories. A distro's environment can carry the user's
 * secrets (their own `WSLENV` forwards Windows variables into it), so the
 * capture is parsed for these names only and never logged or stored whole.
 */
export const WSL_ENV_KEYS = [
  'CODEX_HOME',
  'GROK_HOME',
  'COPILOT_HOME',
  'KIMI_CODE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;
export type WslEnvKey = typeof WSL_ENV_KEYS[number];

/** Runs `wsl.exe` with the given arguments. Injectable for tests. */
export type WslExec = (args: readonly string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

/** Long enough for the first call after a reboot, which boots the WSL VM. */
const WSL_FACTS_TIMEOUT_MS = 30_000;

const ENV_BEGIN_MARKER = '__KANGENTIC_ENV_BEGIN__';
const ENV_END_MARKER = '__KANGENTIC_ENV_END__';

/**
 * Runs the user's own shell interactively and prints its environment between
 * two markers, so anything the rc files print around it is ignored. The
 * `printf`/`env`/`printf` line reads the same in bash, zsh and fish.
 */
const INTERACTIVE_ENV_SCRIPT =
  `exec "\${SHELL:-/bin/sh}" -ic 'printf "%s\\n" ${ENV_BEGIN_MARKER}; env; printf "%s\\n" ${ENV_END_MARKER}' </dev/null`;

/**
 * Prints the home and the root as Windows paths, then the networking mode
 * (`wslinfo` is in WSL 2.0 and later; older builds print `unknown`). The
 * home arrives as `$1`, never inside the script text.
 */
const PATHS_AND_MODE_SCRIPT =
  'wslpath -w "$1"; wslpath -w /; wslinfo --networking-mode 2>/dev/null || echo unknown';

/**
 * `wsl.exe` writes its own messages (a distro that does not exist, WSL not
 * installed) as UTF-16 unless `WSL_UTF8` is set; the NUL strip covers a build
 * that ignores it, so an error reaches the user as text rather than spaced
 * letters.
 */
function cleanWslText(text: string): string {
  return text.replace(/\u0000/g, '');
}

function defaultWslExec(args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('wsl.exe', args, {
    env: childProcessEnv({ WSL_UTF8: '1' }),
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** The keys a capture is read for: PATH and HOME, plus `WSL_ENV_KEYS`. */
const CAPTURED_KEYS: ReadonlySet<string> = new Set(['PATH', 'HOME', ...WSL_ENV_KEYS]);

/**
 * Parse the marked block of `env` output for the captured keys only. Lines
 * outside the markers (rc noise) and every other variable are dropped here
 * and never leave this function.
 */
export function parseInteractiveEnvironment(stdout: string): Map<string, string> {
  const lines = cleanWslText(stdout).split(/\r?\n/);
  const begin = lines.indexOf(ENV_BEGIN_MARKER);
  const end = lines.indexOf(ENV_END_MARKER, begin + 1);
  const captured = new Map<string, string>();
  if (begin === -1 || end === -1) return captured;
  for (const line of lines.slice(begin + 1, end)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (CAPTURED_KEYS.has(key)) captured.set(key, line.slice(separator + 1));
  }
  return captured;
}

/** Parse the paths-and-mode script's three lines. */
export function parsePathsAndMode(stdout: string): { homeUnc: string; uncRoot: string; networkingMode: WslDistroFacts['networkingMode'] } | null {
  const lines = cleanWslText(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return null;
  const [homeUnc, rootLine, modeLine] = lines;
  const uncRoot = rootLine.replace(/[\\/]+$/, '');
  const networkingMode = modeLine === 'nat' || modeLine === 'mirrored' ? modeLine : 'unknown';
  return { homeUnc, uncRoot, networkingMode };
}

/** One readable line for a failed `wsl.exe` run: its own error text where it gave one. */
export function describeWslFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr: unknown = Object.getOwnPropertyDescriptor(error, 'stderr')?.value;
  const stdout: unknown = Object.getOwnPropertyDescriptor(error, 'stdout')?.value;
  const firstLine = (text: unknown): string => typeof text === 'string'
    ? cleanWslText(text).split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
    : '';
  return firstLine(stderr) || firstLine(stdout) || cleanWslText(error.message).split(/\r?\n/)[0];
}

async function readDistroFacts(distro: string, run: WslExec): Promise<WslDistroFacts> {
  let environment: Map<string, string>;
  try {
    const capture = await run(['-d', distro, '-e', 'sh', '-c', INTERACTIVE_ENV_SCRIPT], WSL_FACTS_TIMEOUT_MS);
    environment = parseInteractiveEnvironment(capture.stdout);
  } catch (error) {
    throw new Error(describeWslFailure(error), { cause: error });
  }
  const homeLinux = environment.get('HOME');
  const interactivePath = environment.get('PATH');
  if (!homeLinux || !interactivePath) {
    throw new Error(`Could not read HOME and PATH from an interactive shell in ${distro}.`);
  }

  let pathsAndMode: ReturnType<typeof parsePathsAndMode>;
  try {
    const output = await run(['-d', distro, '-e', 'sh', '-c', PATHS_AND_MODE_SCRIPT, 'sh', homeLinux], WSL_FACTS_TIMEOUT_MS);
    pathsAndMode = parsePathsAndMode(output.stdout);
  } catch (error) {
    throw new Error(describeWslFailure(error), { cause: error });
  }
  if (!pathsAndMode) throw new Error(`wslpath gave no Windows path for ${distro}.`);

  const env: Partial<Record<WslEnvKey, string>> = {};
  for (const key of WSL_ENV_KEYS) {
    const value = environment.get(key);
    if (value) env[key] = value;
  }
  return { distro, homeLinux, interactivePath, env, ...pathsAndMode };
}

const factsByDistro = new Map<string, Promise<WslDistroFacts>>();

/**
 * The facts for `distro`, read on first use and cached. A failure is not
 * cached: a distro that was stopped or still booting can answer next time.
 * Rejects with the error `wsl.exe` or the distro gave, for the CLI path row.
 */
export function resolveWslDistroFacts(distro: string, run: WslExec = defaultWslExec): Promise<WslDistroFacts> {
  const cached = factsByDistro.get(distro);
  if (cached) return cached;
  const reading = readDistroFacts(distro, run);
  factsByDistro.set(distro, reading);
  reading.catch(() => {
    if (factsByDistro.get(distro) === reading) factsByDistro.delete(distro);
  });
  return reading;
}

/** Forget every distro's facts, so the next read asks again (Re-detect). */
export function invalidateWslDistroFacts(): void {
  factsByDistro.clear();
}

/** Test seam: drop every cached read. */
export function resetWslDistroCacheForTests(): void {
  factsByDistro.clear();
}
