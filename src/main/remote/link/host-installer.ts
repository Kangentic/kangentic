/**
 * Puts the helper on a host over the connection the user already made (#913). The host needs
 * nothing from the internet: the app streams its own copy of the host asset, a tarball holding a
 * pinned Node, the helper bundle and node-pty's Linux prebuild, and the host checks its SHA-256
 * before anything is unpacked. The version is the app's, so the helper and Kangentic always agree.
 *
 * - Probe first, in one round trip: OS, CPU, glibc and the home directory. A host that is not a
 *   glibc Linux the asset was built for is refused with a sentence saying what it is.
 * - A version that is already complete (its `.complete` marker and the same checksum) is not sent
 *   again.
 * - The upload lands under a name no reader looks at, is verified, unpacked into `<version>.partial`
 *   and only then renamed to `<version>`. A cut connection leaves no half-installed version to run.
 * - Every command carries only values this module validated, never the user's text, so nothing here
 *   is a shell injection vector.
 *
 * Imports nothing of electron.
 */

import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { SshRunner } from './ssh-run';

export type HostArch = 'x64' | 'arm64';

export interface HostAsset {
  /** The app's version, so the helper and the app always agree. */
  version: string;
  /** SHA-256 of the file, lowercase hex, carried by the app. */
  sha256: string;
  arch: HostArch;
  filePath: string;
}

export interface InstalledHost {
  /** Absolute path of the version's folder on the host. */
  directory: string;
  /** The command that runs the relay: what `ssh` is given to start the link's byte pipe. */
  relayCommand: string;
  /** True when this call sent the asset, false when that version was already there. */
  installed: boolean;
}

export type HostInstallErrorCode = 'unsupported-os' | 'unsupported-arch' | 'unsupported-libc' | 'checksum' | 'failed';

/** A refusal or failure with the host's own words kept, for the user to read. */
export class HostInstallError extends Error {
  constructor(readonly code: HostInstallErrorCode, message: string) {
    super(message);
    this.name = 'HostInstallError';
  }
}

const MIN_GLIBC: readonly [number, number] = [2, 28];
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

const PROBE_COMMAND = [
  'printf \'%s\\n\' "$(uname -s)" "$(uname -m)" "$HOME"',
  '(getconf GNU_LIBC_VERSION 2>/dev/null || echo none)',
].join('; ');

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function archOf(machine: string): HostArch | null {
  if (machine === 'x86_64' || machine === 'amd64') return 'x64';
  if (machine === 'aarch64' || machine === 'arm64') return 'arm64';
  return null;
}

function glibcAtLeast(text: string, minimum: readonly [number, number]): boolean {
  const match = text.match(/glibc\s+(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

function validate(asset: HostAsset): void {
  if (!VERSION_PATTERN.test(asset.version)) throw new HostInstallError('failed', `The host version "${asset.version}" is not a plain version string.`);
  if (!SHA256_PATTERN.test(asset.sha256)) throw new HostInstallError('failed', 'The host asset checksum is not a SHA-256 in lowercase hex.');
}

/** The script that receives the upload on stdin. Only validated values are put in it. */
function installScript(version: string, sha256: string): string {
  const v = shellQuote(version);
  const s = shellQuote(sha256);
  return [
    'set -e',
    'umask 077',
    'base="$HOME/.kangentic/host"',
    'mkdir -p "$base"',
    `version=${v}`,
    `expected=${s}`,
    'upload="$base/$version.upload"',
    'cat > "$upload"',
    'actual=$(sha256sum "$upload" | cut -d" " -f1)',
    'if [ "$actual" != "$expected" ]; then rm -f "$upload"; echo "checksum mismatch: expected $expected, got $actual" >&2; exit 65; fi',
    'rm -rf "$base/$version.partial"',
    'mkdir -p "$base/$version.partial"',
    'tar -xzf "$upload" -C "$base/$version.partial"',
    'rm -f "$upload"',
    // The archive may have been built where files carry no execute bit (an NTFS checkout), so the modes are set here.
    'chmod 755 "$base/$version.partial/node/bin/node"',
    'find "$base/$version.partial/app" -type f \\( -name "*.node" -o -name spawn-helper \\) -exec chmod 755 {} +',
    'test -x "$base/$version.partial/node/bin/node"',
    'test -f "$base/$version.partial/app/host.js"',
    'printf "%s\\n" "$expected" > "$base/$version.partial/.sha256"',
    'touch "$base/$version.partial/.complete"',
    'rm -rf "$base/$version"',
    'mv "$base/$version.partial" "$base/$version"',
  ].join('\n');
}

/**
 * Make sure the helper for this app version is on the host, and say how to start its relay.
 * `openAsset` is for tests: it replaces reading the file from disk.
 */
export async function installHost(
  run: SshRunner,
  assets: HostAsset | readonly HostAsset[],
  openAsset: (filePath: string) => Readable = (filePath) => createReadStream(filePath),
): Promise<InstalledHost> {
  // A build carries one asset per CPU it supports; the host's own CPU, learned below, picks the one to send.
  const candidates: readonly HostAsset[] = Array.isArray(assets) ? assets : [assets as HostAsset];
  for (const candidate of candidates) validate(candidate);
  const probe = await run(PROBE_COMMAND);
  if (probe.code !== 0) {
    throw new HostInstallError('failed', `Could not read the host's details: ${probe.stderr.trim() || `ssh exited with ${probe.code}`}`);
  }
  const [system = '', machine = '', home = '', libc = ''] = probe.stdout.split('\n').map((line) => line.trim());
  if (system !== 'Linux') {
    throw new HostInstallError('unsupported-os', `Kangentic can run agents only on a Linux host. This one reports ${system || 'an unknown system'} ${machine}.`.trim());
  }
  const hostArch = archOf(machine);
  const asset = candidates.find((candidate) => candidate.arch === hostArch);
  if (!asset) {
    const carried = candidates.map((candidate) => (candidate.arch === 'x64' ? 'x86_64' : 'arm64')).join(' and ');
    throw new HostInstallError('unsupported-arch', `This host is ${machine}, and this build carries the helper for ${carried || 'no CPU'}.`);
  }
  if (!glibcAtLeast(libc, MIN_GLIBC)) {
    throw new HostInstallError('unsupported-libc', `Kangentic's helper needs glibc ${MIN_GLIBC.join('.')} or newer. This host reports ${libc && libc !== 'none' ? libc : 'no glibc (Alpine and other musl hosts are not supported)'}.`);
  }
  if (!home.startsWith('/')) throw new HostInstallError('failed', `The host's home directory "${home}" is not an absolute path.`);

  const directory = `${home}/.kangentic/host/${asset.version}`;
  const runDirectory = `${home}/.kangentic/host/run`;
  const relayCommand = `${shellQuote(`${directory}/node/bin/node`)} ${shellQuote(`${directory}/app/host.js`)} relay --dir ${shellQuote(runDirectory)}`;

  const present = await run(`(test -f ${shellQuote(`${directory}/.complete`)} && cat ${shellQuote(`${directory}/.sha256`)}) 2>/dev/null; true`);
  if (present.stdout.trim() === asset.sha256) return { directory, relayCommand, installed: false };

  const upload = await run(installScript(asset.version, asset.sha256), { stdin: openAsset(asset.filePath), timeoutMs: UPLOAD_TIMEOUT_MS });
  if (upload.code === 65) throw new HostInstallError('checksum', upload.stderr.trim());
  if (upload.code !== 0) {
    throw new HostInstallError('failed', `Installing the helper failed: ${upload.stderr.trim() || `ssh exited with ${upload.code}`}`);
  }
  return { directory, relayCommand, installed: true };
}
