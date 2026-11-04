/**
 * Finds the host program this build carries or can fetch (#913). `scripts/build-host.mjs` writes a folder with
 * one tarball per CPU and a `manifest.json` naming each file and its SHA-256. The app reads the manifest, and
 * a connect uploads the tarball that matches the host's CPU. The host checks the checksum before it unpacks.
 *
 * Two shapes of build, one manifest format:
 * - A folder that holds the archives (a development build after `npm run build:host`): each entry's file is
 *   there and is used as it is.
 * - A folder that holds only the manifest (a build that does not grow its installer by about 90 MB): an entry
 *   names an `https://` `url` instead, and the asset's `prepare` downloads that one archive into the cache
 *   folder the first time a host of that CPU needs it, checks it against the manifest's SHA-256, and only
 *   then renames it into place. A download that does not match is deleted and never uploaded.
 *
 * A manifest is trusted only when it is whole and says it is this app's: the same version, a file name that
 * stays in the folder, a checksum in the form the installer expects, and a download URL that is https. Anything
 * else reads as "this build has no host program", with the reason kept for the log, because an upload of the
 * wrong version would put a helper on a host that does not match the app that talks to it.
 *
 * Imports nothing of electron: the caller says where the folders are.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HostArch, HostAsset } from './link/host-installer';

export interface HostAssetsResult {
  assets: HostAsset[];
  /** Why there are none, or why one entry was left out, for the log. Null when everything listed was found. */
  problem: string | null;
}

export interface HostAssetsOptions {
  /** Where a downloaded archive is kept, `<cache>/<version>/<file>`. Without it an entry with no local file is left out. */
  cacheDirectory?: string;
  /** For tests; the global `fetch` otherwise. */
  fetchImpl?: typeof fetch;
}

interface ManifestEntry {
  arch?: unknown;
  file?: unknown;
  sha256?: unknown;
  size?: unknown;
  url?: unknown;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARCHES: readonly HostArch[] = ['x64', 'arm64'];
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export function readHostAssets(directory: string, appVersion: string, options: HostAssetsOptions = {}): HostAssetsResult {
  const manifestPath = path.join(directory, 'manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { assets: [], problem: missing ? `No host program: ${manifestPath} does not exist.` : `The host program's manifest could not be read: ${(error as Error).message}` };
  }
  // Valid JSON that is not an object (`null`, a number) is malformed too, read as "no host program".
  if (typeof parsed !== 'object' || parsed === null) return { assets: [], problem: 'The host program manifest is not an object.' };
  const manifest = parsed as { version?: unknown; assets?: unknown };
  if (manifest.version !== appVersion) {
    return { assets: [], problem: `The host program is for version ${String(manifest.version)}, and this app is ${appVersion}.` };
  }
  if (!Array.isArray(manifest.assets)) return { assets: [], problem: 'The host program manifest lists no files.' };

  const assets: HostAsset[] = [];
  const problems: string[] = [];
  for (const candidateEntry of manifest.assets as unknown[]) {
    if (typeof candidateEntry !== 'object' || candidateEntry === null) {
      problems.push('an entry is not an object');
      continue;
    }
    const entry = candidateEntry as ManifestEntry;
    const arch = ARCHES.find((candidate) => candidate === entry.arch);
    if (!arch) {
      problems.push(`an entry names the CPU ${String(entry.arch)}`);
      continue;
    }
    // `path.basename` keeps `.` and `..`, and reads a backslash as a separator only on Windows, so both are refused outright.
    if (typeof entry.file !== 'string' || entry.file.length === 0 || entry.file === '.' || entry.file === '..' || /[\\/]/.test(entry.file)) {
      problems.push(`the ${arch} entry's file name is not a plain file name`);
      continue;
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      problems.push(`the ${arch} entry's checksum is not a lowercase SHA-256`);
      continue;
    }
    const localPath = path.join(directory, entry.file);
    if (fs.existsSync(localPath)) {
      assets.push({ version: appVersion, sha256: entry.sha256, arch, filePath: localPath });
      continue;
    }
    if (typeof entry.url === 'string' && options.cacheDirectory) {
      if (!entry.url.startsWith('https://')) {
        problems.push(`the ${arch} entry's download address is not https`);
        continue;
      }
      const cachedPath = path.join(options.cacheDirectory, appVersion, entry.file);
      const expectedSize = typeof entry.size === 'number' && entry.size > 0 ? entry.size : null;
      assets.push({
        version: appVersion,
        sha256: entry.sha256,
        arch,
        filePath: cachedPath,
        prepare: () => downloadVerified({ url: entry.url as string, destination: cachedPath, sha256: entry.sha256 as string, expectedSize, fetchImpl: options.fetchImpl ?? fetch }),
      });
      continue;
    }
    problems.push(`${entry.file} is listed but missing`);
  }
  return { assets, problem: problems.length > 0 ? `The host program manifest has a problem: ${problems.join('; ')}.` : null };
}

async function sha256OfFile(filePath: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

interface DownloadOptions {
  url: string;
  destination: string;
  sha256: string;
  expectedSize: number | null;
  fetchImpl: typeof fetch;
}

const downloadsInFlight = new Map<string, Promise<void>>();

/**
 * Put the archive at `destination`, verified against `sha256`. A copy already there that matches is kept and
 * nothing is fetched. The bytes land in a `.part` file, are hashed, and are renamed only when they match, so
 * a cut download or a wrong file is never the one a later connect finds and uploads.
 */
export function downloadVerified(options: DownloadOptions): Promise<void> {
  // Hosts connect in parallel, and two of one CPU want one archive: they share one download, or the
  // second finds the shared `.part` renamed away under it and its connect fails with a raw ENOENT.
  const running = downloadsInFlight.get(options.destination);
  if (running) return running;
  const download = fetchVerified(options).finally(() => downloadsInFlight.delete(options.destination));
  downloadsInFlight.set(options.destination, download);
  return download;
}

async function fetchVerified(options: DownloadOptions): Promise<void> {
  if (await sha256OfFile(options.destination) === options.sha256) return;

  await fs.promises.mkdir(path.dirname(options.destination), { recursive: true });
  const partial = `${options.destination}.part`;
  let response: Response;
  try {
    response = await options.fetchImpl(options.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Could not download the host program from ${new URL(options.url).host}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) throw new Error(`Could not download the host program: ${new URL(options.url).host} answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (options.expectedSize !== null && bytes.length !== options.expectedSize) {
    throw new Error(`The host program downloaded is ${bytes.length} bytes and its manifest says ${options.expectedSize}, so it was not kept.`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== options.sha256) {
    throw new Error('The host program downloaded does not match the checksum this build of Kangentic carries, so it was not kept or sent to the host.');
  }
  await fs.promises.writeFile(partial, bytes, { mode: 0o600 });
  await fs.promises.rename(partial, options.destination);
}
