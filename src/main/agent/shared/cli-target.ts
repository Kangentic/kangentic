import os from 'node:os';
import path from 'node:path';
import { parseWslUncPath, toForwardSlash, toWslPath } from '../../../shared/paths';
import type { StoredCliTarget } from '../../../shared/types';
import { resolveWslDistroFacts, type WslDistroFacts, type WslEnvKey } from './wsl-distro';

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

/** What a session record keeps of a target, enough to find its place again. */
export function toStoredCliTarget(place: StoredCliTarget | null): StoredCliTarget | null {
  return place ? { kind: place.kind, distro: place.distro } : null;
}

/** A target as a session row's `cli_target` column holds it: JSON, or null for this machine. */
export function serializeCliTarget(place: StoredCliTarget | null): string | null {
  const stored = toStoredCliTarget(place);
  return stored ? JSON.stringify(stored) : null;
}

/** The stored form read back from a session row's JSON, or null for anything else. */
export function parseStoredCliTarget(raw: string | null | undefined): StoredCliTarget | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (record.kind === 'wsl' && typeof record.distro === 'string' && record.distro.length > 0) {
        return { kind: 'wsl', distro: record.distro };
      }
    }
  } catch {
    // A row written by a later version, or damaged: read as this machine.
  }
  return null;
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
  return place ? toWslPath(windowsPath) : toForwardSlash(windowsPath);
}

/**
 * A path the CLI reported (a transcript path in its status, a file it wrote)
 * as Kangentic can open it. A drive mount (`/mnt/c/...`) maps back to the
 * drive; anything else is reached through the distro's share. Unchanged for
 * this machine.
 */
export function hostPathForTarget(cliSidePath: string, place: CliPlace | null): string {
  if (!place) return cliSidePath;
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

/**
 * How to start the CLI outside a terminal (a version probe, `--help`, a
 * headless run): `wsl.exe -d <distro> -e env PATH=<interactive PATH> <cli>`.
 * Starting it directly, not through a shell, keeps rc output off a run whose
 * stdout is parsed, and the captured PATH still resolves a version-managed
 * node. `env` entries ride the same way, since Kangentic's environment does
 * not cross into the distro. Path-valued arguments must already be in the
 * distro's form (`cliPathForTarget`).
 */
export function cliInvocationForTarget(
  target: CliTarget,
  cliArgs: readonly string[],
  env: Record<string, string> = {},
): { file: string; args: string[] } {
  const envAssignments = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return {
    file: wslExecutablePath(),
    args: ['-d', target.distro, '-e', 'env', `PATH=${target.facts.interactivePath}`, ...envAssignments, target.linuxCliPath, ...cliArgs],
  };
}
