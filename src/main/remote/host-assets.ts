/**
 * Finds the host program this build carries (#913). `scripts/build-host.mjs` writes a folder with one
 * tarball per CPU and a `manifest.json` naming each file and its SHA-256. The app reads the manifest, and a
 * connect uploads the tarball that matches the host's CPU. The host checks the checksum before it unpacks.
 *
 * A manifest is trusted only when it is whole and says it is this app's: the same version, a file name that
 * stays in the folder, and a checksum in the form the installer expects. Anything else reads as "this build
 * has no host program", with the reason kept for the log, because an upload of the wrong version would put
 * a helper on a host that does not match the app that talks to it.
 *
 * Imports nothing of electron: the caller says where the folder is.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HostArch, HostAsset } from './link/host-installer';

export interface HostAssetsResult {
  assets: HostAsset[];
  /** Why there are none, or why one entry was left out, for the log. Null when everything listed was found. */
  problem: string | null;
}

interface ManifestEntry {
  arch?: unknown;
  file?: unknown;
  sha256?: unknown;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARCHES: readonly HostArch[] = ['x64', 'arm64'];

export function readHostAssets(directory: string, appVersion: string): HostAssetsResult {
  const manifestPath = path.join(directory, 'manifest.json');
  let manifest: { version?: unknown; assets?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { assets: [], problem: missing ? `No host program: ${manifestPath} does not exist.` : `The host program's manifest could not be read: ${(error as Error).message}` };
  }
  if (manifest.version !== appVersion) {
    return { assets: [], problem: `The host program is for version ${String(manifest.version)}, and this app is ${appVersion}.` };
  }
  if (!Array.isArray(manifest.assets)) return { assets: [], problem: 'The host program manifest lists no files.' };

  const assets: HostAsset[] = [];
  const problems: string[] = [];
  for (const entry of manifest.assets as ManifestEntry[]) {
    const arch = ARCHES.find((candidate) => candidate === entry.arch);
    if (!arch) {
      problems.push(`an entry names the CPU ${String(entry.arch)}`);
      continue;
    }
    if (typeof entry.file !== 'string' || entry.file !== path.basename(entry.file) || entry.file.length === 0) {
      problems.push(`the ${arch} entry's file name is not a plain file name`);
      continue;
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      problems.push(`the ${arch} entry's checksum is not a lowercase SHA-256`);
      continue;
    }
    const filePath = path.join(directory, entry.file);
    if (!fs.existsSync(filePath)) {
      problems.push(`${entry.file} is listed but missing`);
      continue;
    }
    assets.push({ version: appVersion, sha256: entry.sha256, arch, filePath });
  }
  return { assets, problem: problems.length > 0 ? `The host program manifest has a problem: ${problems.join('; ')}.` : null };
}
