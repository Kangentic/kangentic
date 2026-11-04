/**
 * The versions of the helper installed on a host (#913): `~/.kangentic/host/<version>/`, one folder per app
 * version that ever connected, plus `run/` for the daemon's socket and log. Nothing removed them, so a
 * host that saw ten releases kept ten copies of a ~45 MB Node and bundle.
 *
 * Imports nothing of electron. Runs in the helper on the host.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
/** Folders the installer is still working in, or that are not versions at all. */
const NOT_A_VERSION = /\.(partial|upload)$/;
const NOT_VERSION_NAMES = new Set(['run']);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InstalledProgramVersion {
  version: string;
  /** When the install finished (its `.complete` marker), as epoch milliseconds. */
  completedAtMs: number;
}

/** Every complete version under `root`, oldest first. A folder with no `.complete` marker is half-installed and not listed. */
export async function listInstalledVersions(root: string): Promise<InstalledProgramVersion[]> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: InstalledProgramVersion[] = [];
  for (const name of names) {
    if (NOT_VERSION_NAMES.has(name) || NOT_A_VERSION.test(name) || !VERSION_PATTERN.test(name)) continue;
    try {
      const marker = await fs.stat(path.join(root, name, '.complete'));
      found.push({ version: name, completedAtMs: marker.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return found.sort((left, right) => left.completedAtMs - right.completedAtMs);
}

export interface PruneOptions {
  root: string;
  /** Versions that must stay: the one running, and the app's own. */
  keep: ReadonlySet<string>;
  /** A version installed more recently than this is left, so two computers on one account never delete each other's. */
  olderThanDays: number;
  nowMs: number;
}

/** Remove complete versions older than the age that are not kept. Returns the versions removed. */
export async function pruneOldVersions(options: PruneOptions): Promise<string[]> {
  const removed: string[] = [];
  const cutoff = options.nowMs - options.olderThanDays * DAY_MS;
  for (const installed of await listInstalledVersions(options.root)) {
    if (options.keep.has(installed.version) || installed.completedAtMs > cutoff) continue;
    await fs.rm(path.join(options.root, installed.version), { recursive: true, force: true });
    removed.push(installed.version);
  }
  return removed;
}
