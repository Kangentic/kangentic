/**
 * Finding the host program this build carries (#913): the manifest `scripts/build-host.mjs` writes, read
 * by the app. A manifest is trusted only when it is whole and this app's own, because a mismatched helper
 * on a host would not match the app that talks to it.
 *
 * What a user loses if it breaks: a stale `dist/host` from an older checkout uploaded to a host, a manifest
 * that points a file name outside its folder, or a clear "no host program" turned into a crash.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHostAssets } from '../../src/main/remote/host-assets';

const SHA_X64 = 'a'.repeat(64);
const SHA_ARM = 'b'.repeat(64);
let directory: string;

function write(manifest: unknown, files: string[] = ['kangentic-host-0.52.0-linux-x64.tar.gz', 'kangentic-host-0.52.0-linux-arm64.tar.gz']) {
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  for (const file of files) fs.writeFileSync(path.join(directory, file), 'archive bytes');
}

const goodManifest = {
  version: '0.52.0',
  node: 'v24.22.2',
  assets: [
    { arch: 'x64', file: 'kangentic-host-0.52.0-linux-x64.tar.gz', sha256: SHA_X64, size: 13 },
    { arch: 'arm64', file: 'kangentic-host-0.52.0-linux-arm64.tar.gz', sha256: SHA_ARM, size: 13 },
  ],
};

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-host-assets-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('reading the host program', () => {
  it('returns one asset per CPU, each with its file and checksum', () => {
    write(goodManifest);

    const found = readHostAssets(directory, '0.52.0');

    expect(found.problem).toBeNull();
    expect(found.assets).toEqual([
      { version: '0.52.0', sha256: SHA_X64, arch: 'x64', filePath: path.join(directory, 'kangentic-host-0.52.0-linux-x64.tar.gz') },
      { version: '0.52.0', sha256: SHA_ARM, arch: 'arm64', filePath: path.join(directory, 'kangentic-host-0.52.0-linux-arm64.tar.gz') },
    ]);
  });

  it('says there is none, with the path, when the folder was never built', () => {
    const found = readHostAssets(path.join(directory, 'nothing-here'), '0.52.0');

    expect(found.assets).toEqual([]);
    expect(found.problem).toContain('does not exist');
  });

  it('refuses a build for another version of the app', () => {
    write({ ...goodManifest, version: '0.51.9' });

    const found = readHostAssets(directory, '0.52.0');

    expect(found.assets).toEqual([]);
    expect(found.problem).toContain('0.51.9');
    expect(found.problem).toContain('0.52.0');
  });

  it('reads a manifest that is not JSON as a problem, never a throw', () => {
    fs.writeFileSync(path.join(directory, 'manifest.json'), '{ not json');

    expect(readHostAssets(directory, '0.52.0').assets).toEqual([]);
    expect(readHostAssets(directory, '0.52.0').problem).toContain('could not be read');
  });

  it('keeps the entries that are sound and names each one it left out', () => {
    write({
      ...goodManifest,
      assets: [
        goodManifest.assets[0],
        { arch: 'arm64', file: '../escape.tar.gz', sha256: SHA_ARM },
        { arch: 'riscv64', file: 'x.tar.gz', sha256: SHA_ARM },
        { arch: 'arm64', file: 'kangentic-host-0.52.0-linux-arm64.tar.gz', sha256: 'NOT-HEX' },
        { arch: 'arm64', file: 'listed-but-absent.tar.gz', sha256: SHA_ARM },
      ],
    });

    const found = readHostAssets(directory, '0.52.0');

    expect(found.assets.map((asset) => asset.arch)).toEqual(['x64']);
    expect(found.problem).toContain('not a plain file name');
    expect(found.problem).toContain('riscv64');
    expect(found.problem).toContain('not a lowercase SHA-256');
    expect(found.problem).toContain('listed-but-absent.tar.gz is listed but missing');
  });
});
