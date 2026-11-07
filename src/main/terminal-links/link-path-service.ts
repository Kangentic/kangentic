import fs from 'node:fs';
import os from 'node:os';
import { shell } from 'electron';
import { parseWslUncPath } from '../../shared/paths';
import { MAX_LINK_PATHS_PER_ROW } from '../../shared/terminal-link-limits';
import { isWslDistroRunning } from '../agent/shared/wsl-distro';
import { parseDefaultDistro } from '../pty/process-tag/wsl-reap';
import { childProcessEnv } from '../shared/child-env';
import { execFileAsync } from '../utility-process/off-main-exec';
import { linkPlaceOfSession, resolveLinkPath, type LinkPathPlace, type SessionLinkFacts } from './resolve-link-path';

/** Hover waits on this. A slow disk or a share reads as missing, and the short TTL asks again. */
export const LINK_STAT_TIMEOUT_MS = 1_000;

export interface LinkPathDependencies {
  statIsPresent(hostPath: string): Promise<boolean>;
  isDistroRunning(distro: string): Promise<boolean>;
  defaultDistro(): Promise<string | null>;
  reveal(hostPath: string): void;
  homeDirectory: string;
  platform: NodeJS.Platform;
}

export function withStatTimeout(stat: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void stat.then(
      (present) => {
        clearTimeout(timer);
        resolve(present);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

let defaultDistroRead: Promise<string | null> | null = null;

/** One `wsl.exe` per launch unless it found nothing, since a default rarely moves. */
function readDefaultDistro(): Promise<string | null> {
  defaultDistroRead ??= execFileAsync('wsl.exe', ['-l', '-v'], { env: childProcessEnv({ WSL_UTF8: '1' }), timeout: 3_000 })
    .then((result) => parseDefaultDistro(String(result.stdout)))
    .catch(() => null)
    .then((distro) => {
      if (!distro) defaultDistroRead = null;
      return distro;
    });
  return defaultDistroRead;
}

export const liveLinkPathDependencies: LinkPathDependencies = {
  // lstat, so a link a repo checked in that points at `\\host\share` is not followed
  // onto the network by a hover. Whether the name exists is all this asks.
  statIsPresent: (hostPath) => withStatTimeout(fs.promises.lstat(hostPath).then(() => true), LINK_STAT_TIMEOUT_MS),
  isDistroRunning: (distro) => isWslDistroRunning(distro),
  defaultDistro: readDefaultDistro,
  reveal: (hostPath) => shell.showItemInFolder(hostPath),
  homeDirectory: os.homedir(),
  platform: process.platform,
};

/** The distro a bare `wsl` shell runs, named only for a path that needs one. */
async function namedPlace(place: LinkPathPlace, dependencies: LinkPathDependencies): Promise<LinkPathPlace> {
  if (place.kind !== 'wsl' || place.distro) return place;
  return { kind: 'wsl', distro: await dependencies.defaultDistro() };
}

async function hostPathIfPresent(
  printedPath: string,
  facts: SessionLinkFacts,
  dependencies: LinkPathDependencies,
): Promise<string | null> {
  const sessionPlace = linkPlaceOfSession(facts);
  if (!sessionPlace) return null;
  const inputFor = (place: LinkPathPlace) => ({
    place,
    cwd: facts.commandCwd,
    homeDirectory: dependencies.homeDirectory,
    platform: dependencies.platform,
  });
  const place = await namedPlace(sessionPlace, dependencies);
  const hostPath = resolveLinkPath(printedPath, inputFor(place));
  if (!hostPath) return null;
  // A read of a distro's share starts it, and a task's ended session can name a
  // distro nobody is using.
  const distro = parseWslUncPath(hostPath)?.distro;
  if (distro && !(await dependencies.isDistroRunning(distro))) return null;
  return (await dependencies.statIsPresent(hostPath)) ? hostPath : null;
}

/** Which printed paths exist on this computer, in request order. */
export async function presentLinkPaths(
  printedPaths: readonly string[],
  facts: SessionLinkFacts,
  dependencies: LinkPathDependencies = liveLinkPathDependencies,
): Promise<boolean[]> {
  const asked = printedPaths.slice(0, MAX_LINK_PATHS_PER_ROW);
  return Promise.all(asked.map(async (printedPath) => (await hostPathIfPresent(printedPath, facts, dependencies)) !== null));
}

/**
 * Shows a printed path in the file manager, resolving it again: the renderer holds
 * text an agent printed, and hands main that text, never a path to act on. Revealing
 * cannot run anything, where `shell.openPath` would run a printed `.exe`. False when
 * nothing is there any more.
 */
export async function revealLinkPath(
  printedPath: string,
  facts: SessionLinkFacts,
  dependencies: LinkPathDependencies = liveLinkPathDependencies,
): Promise<boolean> {
  const hostPath = await hostPathIfPresent(printedPath, facts, dependencies);
  if (!hostPath) return false;
  dependencies.reveal(hostPath);
  return true;
}
