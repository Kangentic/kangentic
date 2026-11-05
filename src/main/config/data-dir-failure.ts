import fs from 'node:fs';
import path from 'node:path';

/**
 * Why Kangentic could not create one of its own directories, in a form that is safe to
 * send. Sentry DESKTOP-2B and DESKTOP-2C were `ENOENT` from `mkdir` on the config directory,
 * and `toPathFreeError` removes the path on purpose, so the events could not say where the
 * directory pointed or which setting sent it there. These values answer that without the
 * path: each one is a fixed word.
 *
 * Measured with a recursive `mkdirSync` on Windows: ENOENT came from a drive that does not
 * exist, from a dangling junction at the target or a parent, and from an invalid character.
 * A file at the target gave EEXIST, a file as the parent gave ENOTDIR, and an unreachable
 * UNC share gave UNKNOWN.
 *
 * This module imports neither electron nor `paths.ts`: it runs at module load, before
 * `app.ready`, and `paths.ts` imports it.
 */

/**
 * What decided the directory. `appdata` is the OS's own per-user config variable, so it
 * covers `%APPDATA%` and `$XDG_CONFIG_HOME`. `home` is anything derived from the home
 * directory, which is every macOS install.
 */
export type DataDirOrigin = 'env' | 'flag' | 'appdata' | 'home';

/** Which of the directories `ensureDirs` creates. */
export type DataDirKind = 'config' | 'projects' | 'models';

/**
 * What is wrong with the path. `drive_missing` means the root is unreachable, so it covers
 * a drive that does not exist and a UNC share that does not answer. `other` covers
 * everything that is not one of the three named shapes, a file in the way included.
 */
export type DataDirState = 'drive_missing' | 'dangling_link' | 'invalid_path' | 'other';

/** The two filesystem questions the classifier asks, injected so a test can run Windows shapes on Linux. */
export interface DataDirProbes {
  /** Follows links, so a dangling link does not exist. */
  exists(target: string): boolean;
  /** Does not follow links. Node reports a Windows junction as a symbolic link. */
  isLink(target: string): boolean;
}

const REAL_PROBES: DataDirProbes = {
  exists: (target) => fs.existsSync(target),
  isLink: (target) => {
    try {
      return fs.lstatSync(target).isSymbolicLink();
    } catch {
      return false;
    }
  },
};

/** Characters Windows refuses in a path segment. The colon after a drive letter is in the root. */
const WINDOWS_INVALID_PATH_CHARACTERS = /[<>:"|?*]/;

/**
 * Classify a directory that could not be created. It runs inside a catch, so it never
 * throws: a probe that fails reads as `other`.
 */
export function classifyDataDirState(
  directory: string,
  probes: DataDirProbes = REAL_PROBES,
  platform: NodeJS.Platform = process.platform,
): DataDirState {
  try {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const resolved = pathApi.resolve(directory);
    const { root } = pathApi.parse(resolved);
    const belowRoot = resolved.slice(root.length);

    if (platform === 'win32' && WINDOWS_INVALID_PATH_CHARACTERS.test(belowRoot)) return 'invalid_path';
    if (!probes.exists(root)) return 'drive_missing';

    let current = root;
    for (const segment of belowRoot.split(pathApi.sep)) {
      if (segment.length === 0) continue;
      current = pathApi.join(current, segment);
      if (probes.exists(current)) continue;
      return probes.isLink(current) ? 'dangling_link' : 'other';
    }
    return 'other';
  } catch {
    return 'other';
  }
}

export interface DataDirFailure {
  /** The directory that failed. Shown to the user, and never sent anywhere. */
  path: string;
  kind: DataDirKind;
  origin: DataDirOrigin;
  state: DataDirState;
}

/**
 * Failures by the error that carried them. A WeakMap rather than a wrapper error or a
 * property: the original error goes on unchanged, so its stack, and with it the Sentry
 * grouping of DESKTOP-2C, stays the same, and no serializer can find the path on it.
 */
const failuresByError = new WeakMap<object, DataDirFailure>();

/** Record which directory `error` came from and what is wrong with it. */
export function markDataDirFailure(
  error: unknown,
  failure: Omit<DataDirFailure, 'state'>,
): void {
  if (typeof error !== 'object' || error === null) return;
  failuresByError.set(error, { ...failure, state: classifyDataDirState(failure.path) });
}

/** The failure recorded for `error`, or undefined when it did not come from `ensureDirs`. */
export function dataDirFailureOf(error: unknown): DataDirFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return failuresByError.get(error);
}

/** The Sentry tags for `error`. Fixed words only, never the path. */
export function dataDirFailureTags(error: unknown): Record<string, string> {
  const failure = dataDirFailureOf(error);
  if (!failure) return {};
  return {
    config_dir: failure.kind,
    config_dir_origin: failure.origin,
    config_dir_state: failure.state,
  };
}
