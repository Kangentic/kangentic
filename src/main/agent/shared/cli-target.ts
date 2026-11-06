import os from 'node:os';
import path from 'node:path';
import { parseWslUncPath, toForwardSlash, toWslPath } from '../../../shared/paths';
import type { StoredCliTarget } from '../../../shared/types';
import type { HostCommandRequest, HostCommandResult, HostFileWrite, JsonPatchRequest, JsonPatchResult } from '../../remote/protocol/messages';
import { childProcessEnv } from '../../shared/child-env';
import { listInWslEnv } from '../../pty/process-tag/task-process-tag';
import { execFileAsync } from '../../utility-process/off-main-exec';
import { WSL_ENV_KEYS, isWslDistroRunning, peekWslDistroFacts, resolveWslDistroFacts, type WslDistroFacts } from './wsl-distro';

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
/**
 * A Linux machine reached over SSH (#913). The CLI, its files and the project all live there, and this
 * computer keeps a mirror folder per project (the "shell folder") whose layout matches the host's, so a
 * path this computer builds under the shell folder names the same file on the host once `roots` maps it.
 */
export interface SshCliPlace {
  kind: 'ssh';
  hostId: string;
  /** The user's home on the host. */
  home: string;
  /** The host's login shell by program name, which decides how a typed command is quoted. */
  shellName: string;
  /** This computer's folder standing in for the host's home, where readers look. Empty when the place has no mirror. */
  localHome: string;
  /** Local folder to host folder: the shell folder maps to the project's folder on the host. */
  roots: ReadonlyArray<{ local: string; host: string }>;
  /** The CLI's path on the host, when known (a bare name is resolved by the host's own PATH). */
  linuxCliPath?: string;
  /**
   * The helper's file jobs, for the work an adapter does on the host's files before a spawn (its trust
   * entry, the settings it merges). Never stored: a place read back from a session row has none.
   */
  files?: SshPlaceFiles;
}

/** What an adapter may ask of the host's files, through the helper. */
export interface SshPlaceFiles {
  readFile(hostPath: string): Promise<{ exists: boolean; content: string | null }>;
  jsonPatch(request: JsonPatchRequest): Promise<JsonPatchResult>;
  /** Write files on the host, making their folders. Each path is beneath the host's home. */
  writeFiles(files: HostFileWrite[]): Promise<{ written: number; conflicts?: string[] }>;
  /**
   * Remove files on the host. A file that is not there is not an error. A path named in `expect` is removed
   * only while it holds that text, and is listed in `conflicts` otherwise.
   */
  removeFiles(paths: string[], expect?: Record<string, string>): Promise<{ removed: number; conflicts?: string[] }>;
  /** Whether each path is there. Only this answer may call a path absent; a failed ask is an error. */
  pathPresence(paths: string[]): Promise<Array<'present' | 'absent'>>;
  /** Run a program on the host to completion and return what it printed (`HostCommandRequest`). */
  runCommand(request: HostCommandRequest): Promise<HostCommandResult>;
}

export type CliPlace = WslCliPlace | SshCliPlace;

/** Narrowing for the many readers that only mean a WSL distro. */
export function isWslPlace(place: CliPlace | null | undefined): place is WslCliPlace {
  return place?.kind === 'wsl';
}

export function isSshPlace(place: CliPlace | null | undefined): place is SshCliPlace {
  return place?.kind === 'ssh';
}

type SshRoot = SshCliPlace['roots'][number];

/** A local path with forward slashes, `..` resolved, and no trailing slash. */
function normalizedLocal(localPath: string): string {
  return path.posix.normalize(toForwardSlash(localPath)).replace(/(.)\/+$/, '$1');
}

/** A local path as roots are compared: on Windows case-folded too, since its file system ignores case. */
function comparableLocal(localPath: string): string {
  const normalized = normalizedLocal(localPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** A host path with `..` resolved and no trailing slash, so a path that climbs out of a root is not under it. */
function normalizedHost(hostPath: string): string {
  return path.posix.normalize(hostPath).replace(/(.)\/+$/, '$1');
}

/** The root a path lies in or names, the longest when roots nest; null when it is under none. */
function longestRoot(roots: SshCliPlace['roots'], side: 'local' | 'host', candidate: string): SshRoot | null {
  const key = side === 'local' ? comparableLocal(candidate) : normalizedHost(candidate);
  let best: SshRoot | null = null;
  let bestLength = -1;
  for (const root of roots) {
    const rootKey = side === 'local' ? comparableLocal(root.local) : normalizedHost(root.host);
    const inside = key === rootKey || key.startsWith(`${rootKey}/`);
    if (inside && rootKey.length > bestLength) {
      best = root;
      bestLength = rootKey.length;
    }
  }
  return best;
}

/** A local path as the host names it, by the longest matching root; a path under no root is left as given. */
export function localPathToHost(localPath: string, roots: SshCliPlace['roots']): string {
  const normalized = normalizedLocal(localPath);
  const best = longestRoot(roots, 'local', localPath);
  if (!best) return normalized;
  return `${normalizedHost(best.host)}${normalized.slice(normalizedLocal(best.local).length)}`;
}

/** Whether a local path is a root or inside one, so `localPathToHost` names it on the host. */
export function isUnderLocalRoot(localPath: string, roots: SshCliPlace['roots']): boolean {
  return longestRoot(roots, 'local', localPath) !== null;
}

/** Whether a host path is a root or inside one, so `hostPathToLocal` names it on this computer. */
export function isUnderHostRoot(hostPath: string, roots: SshCliPlace['roots']): boolean {
  return longestRoot(roots, 'host', hostPath) !== null;
}

/**
 * A path inside a root (the shell folder, a session folder or a worktree stand-in below it) as the host names
 * it, or null when it is in no root. A root itself is a folder, so it is no file to copy and answers null too.
 */
export function rootPathToHost(localPath: string, place: SshCliPlace): string | null {
  const root = longestRoot(place.roots, 'local', localPath);
  if (!root || comparableLocal(localPath) === comparableLocal(root.local)) return null;
  return localPathToHost(localPath, place.roots);
}

/**
 * Whether an id can name a file. A hook's id comes from the host, and one that went into a path on this
 * computer unchecked could climb out of the folder the copy belongs in.
 */
export function isPlainIdName(agentSessionId: string): boolean {
  return /^\w[\w.-]*$/.test(agentSessionId);
}

/**
 * The parts of a host path below a folder, to join onto a folder here. A Linux file name can hold a backslash,
 * which `path.join` on Windows reads as a separator, so a name from a host could climb out of the folder. No file
 * here has such a name, so the character is replaced and the path names nothing.
 */
function localSegments(hostRest: string): string[] {
  const segments = hostRest.split('/').filter(Boolean);
  return path.sep === '\\' ? segments.map((segment) => segment.replaceAll('\\', '_')) : segments;
}

/** A host path as this computer's mirror folder names it, or the path unchanged when it is under no root. */
export function hostPathToLocal(hostPath: string, roots: SshCliPlace['roots']): string {
  const best = longestRoot(roots, 'host', hostPath);
  if (!best) return hostPath;
  const rest = normalizedHost(hostPath).slice(normalizedHost(best.host).length);
  return path.join(best.local, ...localSegments(rest));
}

/**
 * A path in this computer's mirror of the host's home folder, as the host names it, or null when the path
 * is not inside the mirror. The mirror is laid out as the host's home is, so what an adapter's reader
 * builds under `cliHomeDir` is the host's file once the home replaces the mirror's root.
 */
export function mirrorPathToHost(localPath: string, place: SshCliPlace): string | null {
  if (!place.localHome) return null;
  const relative = path.relative(place.localHome, localPath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return `${normalizedHost(place.home)}/${relative.split(path.sep).join('/')}`;
}

/**
 * Where the copy of an exported conversation lives in this computer's mirror of the host's home: the file
 * `<host home>/.kangentic/transcripts/<agent>/<id>.json`, once `mirrorPathToHost` maps it. For an agent whose
 * conversations sit in one shared database, so a reader has a file of the conversation's own to open. Null for
 * a session not on a host, and for an id that is no plain name: it becomes a file on both computers, and an
 * argument of the export.
 */
export function remoteExportPath(place: CliPlace | null | undefined, agentName: string, agentSessionId: string | null | undefined): string | null {
  if (place?.kind !== 'ssh' || !agentSessionId || !isPlainIdName(agentSessionId)) return null;
  return path.join(place.localHome, '.kangentic', 'transcripts', agentName, `${agentSessionId}.json`);
}

/**
 * A path under the host's home as this computer's mirror of that home names it (the inverse of
 * `mirrorPathToHost`), or null when the place has no mirror or the path is not inside the host's home.
 * This is what a path the CLI reported (`~/.claude/projects/...` in its status line) becomes here.
 */
export function hostPathToMirror(hostPath: string, place: SshCliPlace): string | null {
  if (!place.localHome || !hostPath.startsWith('/')) return null;
  const home = normalizedHost(place.home);
  const normalized = normalizedHost(hostPath);
  if (normalized === home || !normalized.startsWith(`${home}/`)) return null;
  return path.join(place.localHome, ...localSegments(normalized.slice(home.length + 1)));
}

export type CliTarget = CliPlace & {
  /** The CLI's path where it runs: in the distro, or on the SSH host (`/home/dev/.local/bin/claude`). */
  linuxCliPath: string;
};

/** What detecting a CLI path can produce: only a WSL path names a place by itself. */
export type WslCliTarget = WslCliPlace & { linuxCliPath: string };

/**
 * Whether a distro name fits the session shell `wsl -d <name>`, which the PTY
 * spawn splits on whitespace: no whitespace, and no leading `-` that wsl.exe
 * would read as a flag.
 */
function isUsableDistroName(name: string): boolean {
  return name.length > 0 && !/\s/.test(name) && !name.startsWith('-');
}

/**
 * The distro and in-distro path a CLI path names, or null. Only on Windows,
 * and only for a path into a distro's own filesystem that names a file (not a
 * bare share root), in a distro the session shell can name.
 */
export function parseWslCliPath(
  cliPath: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): { distro: string; linuxCliPath: string } | null {
  if (platform !== 'win32' || !cliPath) return null;
  const parsed = parseWslUncPath(cliPath);
  if (!parsed || parsed.linuxPath === '/' || !isUsableDistroName(parsed.distro)) return null;
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
): Promise<WslCliTarget | null> {
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
): WslCliTarget | null {
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
  if (place.kind === 'ssh') {
    return {
      kind: 'ssh',
      hostId: place.hostId,
      home: place.home,
      shellName: place.shellName,
      localHome: place.localHome,
      roots: place.roots.map((root) => ({ local: root.local, host: root.host })),
      // A host's CLI may be a bare name its login shell resolves, not only an absolute path.
      ...(place.linuxCliPath ? { linuxCliPath: place.linuxCliPath } : {}),
    };
  }
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
      if (record.kind === 'ssh' && typeof record.hostId === 'string' && record.hostId.length > 0) {
        const roots = Array.isArray(record.roots)
          ? record.roots.filter((root): root is { local: string; host: string } => (
            root !== null && typeof root === 'object'
            && typeof (root as Record<string, unknown>).local === 'string'
            && typeof (root as Record<string, unknown>).host === 'string'
          ))
          : [];
        return toStoredCliTarget({
          kind: 'ssh',
          hostId: record.hostId,
          home: optionalString(record.home) ?? '',
          shellName: optionalString(record.shellName) ?? 'sh',
          localHome: optionalString(record.localHome) ?? '',
          roots,
          linuxCliPath: optionalString(record.linuxCliPath),
        });
      }
      if (record.kind === 'wsl' && typeof record.distro === 'string' && isUsableDistroName(record.distro)) {
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
  if (stored?.kind === 'ssh') {
    return {
      kind: 'ssh',
      hostId: stored.hostId,
      home: stored.home,
      shellName: stored.shellName,
      localHome: stored.localHome,
      roots: stored.roots,
      ...(stored.linuxCliPath ? { linuxCliPath: stored.linuxCliPath } : {}),
    };
  }
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
  // A host's readers look at this computer's mirror folder, which reading cannot start.
  return !place || place.kind !== 'wsl' || isWslDistroRunning(place.distro);
}

/** `placeFromStored` for a session row's `cli_target` column. */
export function placeOfRecord(record: { cli_target?: string | null } | null | undefined): CliPlace | null {
  return placeFromStored(parseStoredCliTarget(record?.cli_target));
}

/**
 * Whether a CLI that ran where a row's `cli_target` says ran in the same place
 * as `place`: the same distro (WSL compares names without case), or this
 * machine for both. A conversation lives in the home of the place its CLI ran
 * in, so only a CLI in that place can resume it.
 */
export function isSameCliPlace(storedCliTarget: string | null | undefined, place: CliPlace | null): boolean {
  return placeIdentity(parseStoredCliTarget(storedCliTarget)) === placeIdentity(place);
}

/** What makes two places the same: a distro by name without case, a host by id, this machine as null. */
function placeIdentity(place: CliPlace | StoredCliTarget | null): string | null {
  if (!place) return null;
  return place.kind === 'ssh' ? `ssh:${place.hostId}` : `wsl:${place.distro.toLowerCase()}`;
}

/**
 * A Windows path as the CLI must be handed it: forward slashes for this
 * machine (what every builder already passed), the distro's view (`/mnt/c/...`)
 * for a WSL CLI.
 */
export function cliPathForTarget(windowsPath: string, place: CliPlace | null): string {
  if (!place) return toForwardSlash(windowsPath);
  if (place.kind === 'ssh') {
    // A host sees the same folder tree under its own roots (the shell folder is the project's folder there).
    if (isUnderLocalRoot(windowsPath, place.roots)) return localPathToHost(windowsPath, place.roots);
    // A file in this computer's mirror of the host's home, such as a prior session's history in a handoff.
    return mirrorPathToHost(windowsPath, place) ?? localPathToHost(windowsPath, place.roots);
  }
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
 * arrived, which starts with the share's `\\`), so mapping twice is mapping
 * once.
 */
export function hostPathForTarget(cliSidePath: string, place: CliPlace | null): string {
  if (!place || !cliSidePath.startsWith('/')) return cliSidePath;
  if (place.kind === 'ssh') {
    // A folder under a project root is the shell folder's; anything else under the host's home is the mirror's.
    if (longestRoot(place.roots, 'host', cliSidePath)) return hostPathToLocal(cliSidePath, place.roots);
    return hostPathToMirror(cliSidePath, place) ?? cliSidePath;
  }
  const driveMount = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(cliSidePath);
  if (driveMount) {
    const rest = (driveMount[2] ?? '').split('/').filter(Boolean).join('\\');
    return `${driveMount[1].toUpperCase()}:\\${rest}`;
  }
  const segments = cliSidePath.split('/').filter(Boolean);
  return segments.length > 0 ? `${place.facts.uncRoot}\\${segments.join('\\')}` : place.facts.uncRoot;
}

/**
 * The folder an adapter's project settings are read from: the project root, else the working folder. On a
 * host over SSH only the working folder's files are pulled (`remoteFiles`), and a remote task has no
 * worktree. Any other folder here is an empty shell folder, and merging from it would write over the
 * user's settings on the host.
 */
export function pulledProjectRoot(options: { cwd: string; projectRoot?: string; cliTarget?: { kind: string } | null }): string {
  if (options.cliTarget?.kind === 'ssh') return options.cwd;
  return options.projectRoot || options.cwd;
}

/** The home the CLI keeps its files under: the distro's, reached through its share, or this machine's. */
export function cliHomeDir(place: CliPlace | null): string {
  if (!place) return os.homedir();
  // A host's home is not here; readers find this computer's mirror of it, which is empty until it exists.
  return place.kind === 'ssh' ? place.localHome : place.facts.homeUnc;
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
  if (!place) return null;
  // A host's session is typed into its own login shell, which only its program name describes.
  return place.kind === 'ssh' ? place.shellName : `wsl -d ${place.distro}`;
}

/**
 * `wsl.exe` by absolute path: node-pty's ConPTY spawn does not search PATH for
 * an extension-less name. A Windows path on every host, so a test on Linux
 * sees the path Windows uses.
 */
export function wslExecutablePath(): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
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
 * (`cliPathForTarget`). A variable passed as `undefined` is unset in the distro
 * by `env -u`, whether `WSLENV` or the distro itself would have set it.
 */
export function cliInvocationForTarget(
  target: CliTarget,
  cliArgs: readonly string[],
  env: Record<string, string | undefined> = {},
): CliInvocation {
  // A CLI on a host is run by the host's helper, not by a program started here; until that exists a
  // probe or headless run for a host's CLI fails with this sentence rather than running something local.
  if (target.kind === 'ssh') throw new Error('Running a command on a remote host this way is not available yet.');
  const assigned: Record<string, string> = {};
  const unsetArguments: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) unsetArguments.push('-u', name);
    else assigned[name] = value;
  }
  const names = Object.keys(assigned);
  // A place read back from a session row carries no captured PATH
  // (`placeFromStored`): `PATH=` with nothing after it would blank the
  // distro's own, so the run keeps the default `-e` gives (`/usr/bin`, where
  // `git` lives) instead.
  const pathAssignment = target.facts.interactivePath ? [`PATH=${target.facts.interactivePath}`] : [];
  return {
    file: wslExecutablePath(),
    args: ['-d', target.distro, '-e', 'env', ...unsetArguments, ...pathAssignment, target.linuxCliPath, ...cliArgs],
    env: names.length > 0 ? listInWslEnv(assigned, names, process.env.WSLENV) : {},
  };
}

/** A failed run on a host, shaped as `execFile`'s rejection is: callers read `stdout`, `stderr`, `code` and `killed`. */
export class HostCommandError extends Error {
  constructor(message: string, readonly stdout: string, readonly stderr: string, readonly code: number | string | null, readonly killed: boolean) {
    super(message);
    this.name = 'HostCommandError';
  }
}

/**
 * Run the CLI on its host to completion through the helper (`HostCommandRequest`), rejecting as `execFile`
 * does: a non-zero exit carries its output, a timeout is `killed`, and a program that is not installed is an
 * error naming it. The program is the CLI's name, found by the host's own shell; `options.cwd` is a folder on
 * this computer's side of the path map.
 */
async function execCliOnHost(
  target: SshCliPlace & { linuxCliPath: string },
  cliArgs: readonly string[],
  options: ExecCliForTargetOptions,
): Promise<{ stdout: string; stderr: string }> {
  const files = target.files;
  if (!files) throw new Error('This host has no connection to run a command through.');
  const result = await files.runCommand({
    file: target.linuxCliPath,
    args: [...cliArgs],
    ...(options.cwd ? { cwd: cliPathForTarget(options.cwd, target) } : {}),
    ...(options.env ? { env: options.env } : {}),
    timeoutMs: options.timeout,
  });
  if (result.error) throw new HostCommandError(result.error, result.stdout, result.stderr, 'ENOENT', false);
  if (result.timedOut) throw new HostCommandError(`${target.linuxCliPath} did not finish in ${Math.round(options.timeout / 1000)} s on the host.`, result.stdout, result.stderr, null, true);
  if (result.code !== 0) throw new HostCommandError(`${target.linuxCliPath} exited with code ${result.code} on the host.`, result.stdout, result.stderr, result.code, false);
  return { stdout: result.stdout, stderr: result.stderr };
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
  if (target.kind === 'ssh') return execCliOnHost(target, cliArgs, options);
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
