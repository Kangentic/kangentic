import path from 'node:path';
import type { StoredCliTarget } from '../../shared/types';
import { isUncPath, parseWslUncPath } from '../../shared/paths';
import { MAX_PRINTED_PATH_LENGTH } from '../../shared/terminal-link-limits';
import { driveMountToWindowsPath, linuxPathOnShare } from '../agent/shared/cli-target';
import { parseWslShellSpec } from '../pty/process-tag/task-process-tag';

/**
 * Where a session's printed paths live. `null` means somewhere this computer
 * cannot reach, or nothing Kangentic can tell, and nothing links.
 */
export type LinkPathPlace =
  | { kind: 'local' }
  /** `distro` is null for a bare `wsl` shell, which runs the default distro. */
  | { kind: 'wsl'; distro: string | null };

export interface SessionLinkFacts {
  shell: string;
  /** The folder the session's command was built for. */
  commandCwd: string;
  cliTarget: StoredCliTarget | null;
  /** An agent whose project runs it on a remote server, whose paths are that server's. */
  runsOnRemoteServer: boolean;
}

/**
 * The exhaustive switch is the guard for a place this file has not met. An SSH
 * target added to `StoredCliTarget` fails `never` here until it is classified, and
 * it must classify as null: an SSH host's paths are not on this computer.
 */
function placeOfCliTarget(target: StoredCliTarget): LinkPathPlace | null {
  switch (target.kind) {
    case 'wsl':
      return { kind: 'wsl', distro: target.distro };
    case 'ssh':
      // The paths an agent prints name files on the host, which this computer cannot stat.
      return null;
    default: {
      // A compile-time check, and a stored row can outrun it: a target written by a
      // later version reads back here, and links nothing.
      const unclassified: never = target;
      console.warn(`[terminal-links] No link place for CLI target kind: ${String((unclassified as { kind?: unknown }).kind)}`);
      return null;
    }
  }
}

export function linkPlaceOfSession(facts: SessionLinkFacts): LinkPathPlace | null {
  if (facts.runsOnRemoteServer) return null;
  if (facts.cliTarget) return placeOfCliTarget(facts.cliTarget);
  const wslShell = parseWslShellSpec(facts.shell);
  if (!wslShell) return { kind: 'local' };
  return { kind: 'wsl', distro: wslShell.distro ?? parseWslUncPath(facts.commandCwd)?.distro ?? null };
}

export interface ResolveLinkPathInput {
  place: LinkPathPlace;
  /** The folder a relative path is relative to. */
  cwd: string;
  homeDirectory: string;
  platform: NodeJS.Platform;
}

/**
 * True for a path a stat may reach. A stat of `\\host\share\x` hands this user's
 * Windows credentials to that host, and the text came from an agent, so hovering
 * it would be enough. `\\?\` and `\\.\` reach devices and raw namespaces. A distro's
 * own share is the one UNC root allowed, and only the session's own distro: a stat
 * there starts a stopped distro, which is the caller's check.
 */
function isReachableResolvedPath(resolved: string, place: LinkPathPlace, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return true;
  if (!isUncPath(resolved) && !/^[\\/]{2}[?.][\\/]/.test(resolved)) return true;
  if (place.kind !== 'wsl' || !place.distro) return false;
  return parseWslUncPath(resolved)?.distro.toLowerCase() === place.distro.toLowerCase();
}

function linuxPathOnHost(linuxPath: string, distro: string): string {
  return linuxPathOnShare(linuxPath, `\\\\wsl.localhost\\${distro}`);
}

/**
 * The path on this computer a printed path names, or null when it names nothing
 * Kangentic may touch. Pure: no stat and no IPC, and every platform runs on every
 * platform through `path.win32` and `path.posix`.
 */
export function resolveLinkPath(printedPath: string, input: ResolveLinkPathInput): string | null {
  if (printedPath.length === 0 || printedPath.length > MAX_PRINTED_PATH_LENGTH || printedPath.includes('\0')) return null;
  const { place, cwd, homeDirectory, platform } = input;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  let resolved: string | null;
  if (place.kind === 'wsl') {
    resolved = resolveInWsl(printedPath, place, cwd);
  } else if (platform === 'win32') {
    resolved = resolveOnWindows(printedPath, cwd, homeDirectory);
  } else if (/^~\//.test(printedPath)) {
    resolved = pathApi.join(homeDirectory, printedPath.slice(2));
  } else {
    resolved = pathApi.resolve(cwd, printedPath);
  }
  if (resolved === null) return null;
  // A share keeps its root through `path.win32`, which clamps a `..` there, so the
  // check below reads the path the stat will read.
  const normalized = (isUncPath(resolved) ? path.win32 : pathApi).normalize(resolved);
  return isReachableResolvedPath(normalized, place, platform) ? normalized : null;
}

function resolveOnWindows(printedPath: string, cwd: string, homeDirectory: string): string | null {
  // Refused here rather than by the shared check so a relative join below never
  // sees one. Forward slashes reach the same share.
  if (/^[\\/]{2}/.test(printedPath)) return null;
  if (/^[A-Za-z]:[\\/]/.test(printedPath)) return printedPath;
  if (/^~[\\/]/.test(printedPath)) return path.win32.join(homeDirectory, printedPath.slice(2));
  // Git Bash prints `/c/Users/dev`.
  const gitBashDrive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(printedPath);
  if (gitBashDrive) return path.win32.join(`${gitBashDrive[1].toUpperCase()}:\\`, gitBashDrive[2] ?? '');
  // A rooted path has no drive, so which file it names depends on this process.
  if (/^[\\/]/.test(printedPath)) return null;
  return path.win32.resolve(cwd, printedPath);
}

function resolveInWsl(printedPath: string, place: Extract<LinkPathPlace, { kind: 'wsl' }>, cwd: string): string | null {
  if (/^[\\/]{2}/.test(printedPath)) return parseWslUncPath(printedPath) ? printedPath : null;
  if (/^[A-Za-z]:[\\/]/.test(printedPath)) return printedPath;
  // The distro's home is not known from here.
  if (printedPath.startsWith('~')) return null;
  if (printedPath.startsWith('/')) {
    // Read as the distro reads it, so `/mnt/c/../d/a` is the D drive.
    const linuxPath = path.posix.normalize(printedPath);
    const onDrive = driveMountToWindowsPath(linuxPath);
    if (onDrive) return onDrive;
    return place.distro ? linuxPathOnHost(linuxPath, place.distro) : null;
  }
  const distroCwd = parseWslUncPath(cwd);
  if (distroCwd) {
    if (!place.distro) return null;
    return linuxPathOnHost(path.posix.resolve(distroCwd.linuxPath, printedPath), place.distro);
  }
  return path.win32.resolve(cwd, printedPath);
}
