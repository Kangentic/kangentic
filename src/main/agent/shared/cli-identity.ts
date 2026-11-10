/**
 * The file each detected CLI path resolved to when detection found it, so a
 * launch report can say whether that path still resolves to the same file.
 *
 * Detection runs once and its answer is cached for the run, while the CLI on
 * disk can change under a running app: a native installer points its link at a
 * new version, a package manager replaces the file, an updater rewrites it.
 * Sentry DESKTOP-2E and DESKTOP-2H came from one macOS install whose launches
 * worked, failed, worked and failed over nine hours, once naming a missing file.
 * A launch report sends only `same`, `changed` or `unknown`, never the path.
 *
 * Keyed by the path detection returned, so no spawn site has to carry it: a
 * report looks up the path its session was launched with. A path detection did
 * not return (a sibling shim `resolveShimLaunch` swapped in on Windows, a WSL
 * path) has no record and reads `unknown`.
 */

import fs from 'node:fs';

/**
 * Read as bigints: an NTFS file id is 64 bits, sequence number over record
 * number, and a JS number drops its low bits once the sequence passes 31.
 */
interface CliFileIdentity {
  realPath: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedAtNs: bigint;
}

/** Whether a CLI path still resolves to the file detection found. */
export type CliIdentitySinceDetection = 'same' | 'changed' | 'unknown';

const detectedIdentities = new Map<string, CliFileIdentity>();

function identityOf(cliPath: string): CliFileIdentity {
  const realPath = fs.realpathSync(cliPath);
  const stats = fs.statSync(realPath, { bigint: true });
  return { realPath, device: stats.dev, inode: stats.ino, size: stats.size, modifiedAtNs: stats.mtimeNs };
}

/**
 * Remember the file `cliPath` resolves to now. Called by detection for each path
 * it finds. A path it cannot read is forgotten, so it reads `unknown` later.
 */
export function recordDetectedCliIdentity(cliPath: string): void {
  try {
    detectedIdentities.set(cliPath, identityOf(cliPath));
  } catch {
    detectedIdentities.delete(cliPath);
  }
}

/**
 * Whether `cliPath` still resolves to the file detection found: `unknown` when
 * detection recorded nothing for it, or the read fails for a reason other than
 * the file being gone. A link pointed at another file, a file replaced or
 * rewritten, and a path that no longer resolves all read `changed`. The last
 * also reads `missing` on the report's `command_head` tag.
 */
export function cliIdentitySinceDetection(cliPath: string): CliIdentitySinceDetection {
  const detected = detectedIdentities.get(cliPath);
  if (!detected) return 'unknown';
  let current: CliFileIdentity;
  try {
    current = identityOf(cliPath);
  } catch (error) {
    // Gone, or a link that leads nowhere, is a change. Any other failed read says nothing.
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' ? 'changed' : 'unknown';
  }
  const same = current.realPath === detected.realPath
    && current.device === detected.device
    && current.inode === detected.inode
    && current.size === detected.size
    && current.modifiedAtNs === detected.modifiedAtNs;
  return same ? 'same' : 'changed';
}

/** Forget every recorded identity. Tests only. */
export function resetDetectedCliIdentities(): void {
  detectedIdentities.clear();
}
