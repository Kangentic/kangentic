import os from 'node:os';
import path from 'node:path';
import { parseWslUncPath, toForwardSlash, toWslPath } from '../../../shared/paths';
import type { StoredCliTarget } from '../../../shared/types';
import { childProcessEnv } from '../../shared/child-env';
import { listInWslEnv } from '../../pty/process-tag/task-process-tag';
import { execFileAsync } from '../../utility-process/off-main-exec';
import { WSL_ENV_KEYS, isWslDistroRunning, peekWslDistroFacts, resolveWslDistroFacts, type WslDistroFacts, type WslEnvKey } from './wsl-distro';

/**
 * Where an agent CLI runs and keeps its files, when that is not this machine
 * as Kangentic sees it. Today the one kind is a WSL distro: a CLI configured
 * by its `\\wsl.localhost\<distro>\...` path runs inside that distro as a
 * Linux process. A later kind (a remote machine) joins the union, and
 * `executionTarget` (`execution-target.ts`) can feed it rather than replace
 * it. `null` everywhere means "this machine", and every helper below returns
 * exactly what the code did before a target existed for it.
 *
 * `CliPlace` is what the readers need (a home, an environment); `CliTarget`
 * adds the CLI itself, for the builders and runners.
 */
export interface WslCliPlace {
  kind: 'wsl';
  distro: string;
  facts: WslDistroFacts;
  /**
   * The CLI's path as the distro sees it, when the place was read back from a
   * session that recorded it (`placeFromStored`): what a reader runs to ask the
   * CLI itself (`targetOfPlace`). Always set on a `CliTarget`.
   */
  linuxCliPath?: string;
}
export type CliPlace = WslCliPlace;

export type CliTarget = CliPlace & {
  /** The CLI's path as the distro sees it: `/home/dev/.local/bin/claude`. */
  linuxCliPath: string;
};

/**
 * The distro and in-distro path a CLI path names, or null. Only on Windows,
 * and only for a path into a distro's own filesystem that names a file (not a
 * bare share root).
 */
export function parseWslCliPath(
  cliPath: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): { distro: string; linuxCliPath: string } | null {
  if (platform !== 'win32' || !cliPath) return null;
  const parsed = parseWslUncPath(cliPath);
  if (!parsed || parsed.linuxPath === '/') return null;
  return { distro: parsed.distro, linuxCliPath: parsed.linuxPath };
}

export interface ResolveCliTargetOptions {
  platform?: NodeJS.Platform;
  resolveFacts?: (distro: string) => Promise<WslDistroFacts>;
}

/**
 * The target for a RESOLVED CLI path (a detection's `path`, never raw config),
 * computed once per spawn at each build site and carried on `CommandOptions`.
 * Null unless the adapter runs from WSL and the path is a WSL path. Rejects
 * with the distro's own error when its facts cannot be read, which fails the
 * spawn with that error rather than starting a CLI that cannot work.
 */
export async function resolveCliTarget(
  cliPath: string | null | undefined,
  adapterSupportsWsl: boolean,
  options: ResolveCliTargetOptions = {},
): Promise<CliTarget | null> {
  if (!adapterSupportsWsl) return null;
  const parsed = parseWslCliPath(cliPath, options.platform);
  if (!parsed) return null;
  const facts = await (options.resolveFacts ?? resolveWslDistroFacts)(parsed.distro);
  return { kind: 'wsl', distro: parsed.distro, linuxCliPath: parsed.linuxCliPath, facts };
}

/**
 * `resolveCliTarget` for a caller that must answer synchronously (an answer
 * session opened on demand): the target from facts already read, or null when
 * none have been. Detection of the same path reads them first.
 */
export function peekCliTarget(
  cliPath: string | null | undefined,
  adapterSupportsWsl: boolean,
  platform: NodeJS.Platform = process.platform,
): CliTarget | null {
  if (!adapterSupportsWsl) return null;
  const parsed = parseWslCliPath(cliPath, platform);
  if (!parsed) return null;
  const facts = peekWslDistroFacts(parsed.distro);
  return facts ? { kind: 'wsl', distro: parsed.distro, linuxCliPath: parsed.linuxCliPath, facts } : null;
}

/**
 * What a session record keeps of a target: its distro, and from a resolved
 * place the homes a reader needs (`placeFromStored`). Only the agent home
 * overrides of the distro's environment are kept, never anything else.
 */
export function toStoredCliTarget(place: CliPlace | StoredCliTarget | null): StoredCliTarget | null {
  if (!place) return null;
  if ('facts' in place) {
    return {
      kind: place.kind,
      distro: place.distro,
      homeLinux: place.facts.homeLinux,
      homeUnc: place.facts.homeUnc,
      uncRoot: place.facts.uncRoot,
      env: storedEnvironment(place.facts.env) ?? {},
      ...(isLinuxPath(place.linuxCliPath) ? { linuxCliPath: place.linuxCliPath } : {}),
    };
  }
  const environment = storedEnvironment(place.env);
  return {
    kind: place.kind,
    distro: place.distro,
    ...(place.homeLinux ? { homeLinux: place.homeLinux } : {}),
    ...(place.homeUnc ? { homeUnc: place.homeUnc } : {}),
    ...(place.uncRoot ? { uncRoot: place.uncRoot } : {}),
    ...(environment ? { env: environment } : {}),
    ...(isLinuxPath(place.linuxCliPath) ? { linuxCliPath: place.linuxCliPath } : {}),
  };
}

/** A target as a session row's `cli_target` column holds it: JSON, or null for this machine. */
export function serializeCliTarget(place: CliPlace | StoredCliTarget | null): string | null {
  const stored = toStoredCliTarget(place);
  return stored ? JSON.stringify(stored) : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** An absolute path as a distro sees it, the only CLI path a stored target keeps. */
function isLinuxPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/');
}

/** The agent home overrides a stored target may carry, named keys only. */
function storedEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const environment: Record<string, string> = {};
  for (const key of WSL_ENV_KEYS) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry === 'string' && entry.length > 0) environment[key] = entry;
  }
  return environment;
}

/** The stored form read back from a session row's JSON, or null for anything else. */
export function parseStoredCliTarget(raw: string | null | undefined): StoredCliTarget | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (record.kind === 'wsl' && typeof record.distro === 'string' && record.distro.length > 0) {
        return toStoredCliTarget({
          kind: 'wsl',
          distro: record.distro,
          homeLinux: optionalString(record.homeLinux),
          homeUnc: optionalString(record.homeUnc),
          uncRoot: optionalString(record.uncRoot),
          env: storedEnvironment(record.env),
          linuxCliPath: optionalString(record.linuxCliPath),
        });
      }
    }
  } catch {
    // A row written by a later version, or damaged: read as this machine.
  }
  return null;
}

/**
 * The place a stored target recorded, built from its homes with no call into
 * the distro, for a reader after the session (in main or the retrieval
 * worker): where the CLI keeps its transcripts, rollouts and settings. Null for
 * this machine, and for a stored target without its homes, which then reads as
 * this machine.
 */
export function placeFromStored(stored: StoredCliTarget | null | undefined): CliPlace | null {
  if (!stored || !stored.homeUnc || !stored.uncRoot) return null;
  return {
    kind: 'wsl',
    distro: stored.distro,
    facts: {
      distro: stored.distro,
      homeLinux: stored.homeLinux ?? '',
      homeUnc: stored.homeUnc,
      uncRoot: stored.uncRoot,
      interactivePath: '',
      env: storedEnvironment(stored.env) ?? {},
      networkingMode: 'unknown',
    },
    ...(isLinuxPath(stored.linuxCliPath) ? { linuxCliPath: stored.linuxCliPath } : {}),
  };
}

/**
 * The place as a target a reader can run the CLI in, when it carries the CLI's
 * path (a session's recorded target does): null for this machine and for a
 * place read back from a row written before the path was kept.
 */
export function targetOfPlace(place: CliPlace | null): CliTarget | null {
  return place && isLinuxPath(place.linuxCliPath) ? { ...place, linuxCliPath: place.linuxCliPath } : null;
}

/**
 * Whether a reader nobody asked for may read a place's files now: always for
 * this machine, and for a distro only while it is running, since reading its
 * share would start it (`isWslDistroRunning`).
 */
export async function mayReadPlaceUnattended(place: CliPlace | null): Promise<boolean> {
  return !place || isWslDistroRunning(place.distro);
}

/** `placeFromStored` for a session row's `cli_target` column. */
export function placeOfRecord(record: { cli_target?: string | null } | null | undefined): CliPlace | null {
  return placeFromStored(parseStoredCliTarget(record?.cli_target));
}

/** The place a stored target names, with its facts read (cached), for readers after the session. */
export async function resolveStoredCliPlace(
  stored: StoredCliTarget | null,
  resolveFacts: (distro: string) => Promise<WslDistroFacts> = resolveWslDistroFacts,
): Promise<CliPlace | null> {
  if (!stored) return null;
  return { kind: 'wsl', distro: stored.distro, facts: await resolveFacts(stored.distro) };
}

/**
 * A Windows path as the CLI must be handed it: forward slashes for this
 * machine (what every builder already passed), the distro's view (`/mnt/c/...`)
 * for a WSL CLI.
 */
export function cliPathForTarget(windowsPath: string, place: CliPlace | null): string {
  if (!place) return toForwardSlash(windowsPath);
  // A path into another distro has no path from inside this one, and its
  // Linux path could name a different file here, so it is left as it is.
  const intoDistro = parseWslUncPath(windowsPath);
  if (intoDistro && intoDistro.distro.toLowerCase() !== place.distro.toLowerCase()) return windowsPath;
  return toWslPath(windowsPath);
}

/**
 * A path the CLI reported (a transcript path in its status, a file it wrote)
 * as Kangentic can open it. A drive mount (`/mnt/c/...`) maps back to the
 * drive; anything else is reached through the distro's share. Unchanged for
 * this machine, and for a path that is not a Linux path (one already mapped,
 * such as a status line's transcript path the session manager mapped as it
 * arrived), so mapping twice is mapping once.
 */
export function hostPathForTarget(cliSidePath: string, place: CliPlace | null): string {
  if (!place || !cliSidePath.startsWith('/') || cliSidePath.startsWith(place.facts.uncRoot)) return cliSidePath;
  const driveMount = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(cliSidePath);
  if (driveMount) {
    const rest = (driveMount[2] ?? '').split('/').filter(Boolean).join('\\');
    return `${driveMount[1].toUpperCase()}:\\${rest}`;
  }
  const segments = cliSidePath.split('/').filter(Boolean);
  return segments.length > 0 ? `${place.facts.uncRoot}\\${segments.join('\\')}` : place.facts.uncRoot;
}

/** The home the CLI keeps its files under: the distro's, reached through its share, or this machine's. */
export function cliHomeDir(place: CliPlace | null): string {
  return place ? place.facts.homeUnc : os.homedir();
}

/**
 * An environment value as the CLI sees it: from the distro's interactive
 * shell for a WSL CLI (Kangentic's own environment does not reach it), else
 * from Kangentic's.
 */
export function cliEnvValue(key: WslEnvKey, place: CliPlace | null): string | undefined {
  return place ? place.facts.env[key] : process.env[key];
}

/**
 * The platform whose shell runs the CLI's hooks: Linux for a WSL CLI, so a
 * hook command is quoted for `sh`, not for PowerShell or cmd.
 */
export function cliPlatformForTarget(place: CliPlace | null, platform: NodeJS.Platform = process.platform): NodeJS.Platform {
  return place ? 'linux' : platform;
}

/** The session shell a target needs, or null to keep the configured one. */
export function shellForTarget(place: CliPlace | null): string | null {
  return place ? `wsl -d ${place.distro}` : null;
}

/** `wsl.exe` by absolute path: node-pty's ConPTY spawn does not search PATH for an extension-less name. */
export function wslExecutablePath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
}

/** How a CLI in a distro is started outside a terminal: the program, its arguments, and the environment to give it. */
export interface CliInvocation {
  file: string;
  args: string[];
  /**
   * The caller's variables, each listed in `WSLENV` (`/u`), which is the only
   * way a Windows variable reaches a distro. Empty when the caller passed none.
   * Merge it into the child's environment (`childProcessEnv`).
   */
  env: Record<string, string>;
}

/**
 * How to start the CLI outside a terminal (a version probe, `--help`, a
 * headless run): `wsl.exe -d <distro> -e env PATH=<interactive PATH> <cli>`.
 * Starting it directly, not through a shell, keeps rc output off a run whose
 * stdout is parsed, and the captured PATH still resolves a version-managed
 * node. The caller's variables cross through `WSLENV` rather than the command
 * line, so a token never shows in the distro's process list, and their values
 * must already be in the distro's form. So must every path-valued argument
 * (`cliPathForTarget`).
 */
export function cliInvocationForTarget(
  target: CliTarget,
  cliArgs: readonly string[],
  env: Record<string, string> = {},
): CliInvocation {
  const names = Object.keys(env);
  // A place read back from a session row carries no captured PATH
  // (`placeFromStored`): `PATH=` with nothing after it would blank the
  // distro's own, so the run keeps the default `-e` gives (`/usr/bin`, where
  // `git` lives) instead.
  const pathAssignment = target.facts.interactivePath ? [`PATH=${target.facts.interactivePath}`] : [];
  return {
    file: wslExecutablePath(),
    args: ['-d', target.distro, '-e', 'env', ...pathAssignment, target.linuxCliPath, ...cliArgs],
    env: names.length > 0 ? listInWslEnv(env, names, process.env.WSLENV) : {},
  };
}

export interface ExecCliForTargetOptions {
  /** The Windows directory to start in; the distro sees it as its `/mnt` path. */
  cwd?: string;
  timeout: number;
  maxBuffer?: number;
  env?: Record<string, string>;
}

/**
 * Run the CLI in its distro to completion and capture its output (`--help`, a
 * model list, an auth probe). Rejects as `execFile` does, with `stdout` and
 * `stderr` on the error; `describeWslFailure` turns one into the line to show.
 */
export function execCliForTarget(
  target: CliTarget,
  cliArgs: readonly string[],
  options: ExecCliForTargetOptions,
): Promise<{ stdout: string; stderr: string }> {
  const invocation = cliInvocationForTarget(target, cliArgs, options.env);
  return execFileAsync(invocation.file, invocation.args, {
    // `WSL_UTF8` makes wsl.exe write its own messages (a missing distro) as UTF-8.
    env: childProcessEnv({ WSL_UTF8: '1', ...invocation.env }),
    timeout: options.timeout,
    windowsHide: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
  });
}
