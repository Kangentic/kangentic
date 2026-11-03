/**
 * The release must not ship an installer whose host manifest is missing, for another version or half
 * written (#913). electron-builder only warns when an `extraResources` source is gone, so without this
 * check an installer without the manifest builds, passes every job and then tells every user "no host
 * program". The check is the gate; these tests pin what it accepts and what it names.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const requireFromRepo = createRequire(path.join(__dirname, '..', '..', 'package.json'));
const { manifestProblems, archiveProblems, packagedResourceFolders } = requireFromRepo('./scripts/verify-host-manifest.js') as {
  manifestProblems: (manifest: unknown, expected: { version: string }) => string[];
  archiveProblems: (manifest: unknown, folder: string) => string[];
  packagedResourceFolders: (platform: string, outDirectory: string) => string[];
};

const VERSION = '9.9.9';
const HASH = 'a'.repeat(64);

function entry(arch: 'x64' | 'arm64', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const file = `kangentic-host-${VERSION}-linux-${arch}.tar.gz`;
  return { arch, file, sha256: HASH, size: 1000, url: `https://github.com/example/example/releases/download/v${VERSION}/${file}`, ...overrides };
}

function whole(): { version: string; node: string; assets: Record<string, unknown>[] } {
  return { version: VERSION, node: 'v24.22.2', assets: [entry('x64'), entry('arm64')] };
}

const temporaryFolders: string[] = [];
afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('a host manifest a release may ship', () => {
  it('accepts a whole manifest for this version', () => {
    expect(manifestProblems(whole(), { version: VERSION })).toEqual([]);
  });

  it('names a manifest for another version, which the app would refuse at run time', () => {
    expect(manifestProblems({ ...whole(), version: '9.9.8' }, { version: VERSION })[0]).toMatch(/9\.9\.8.*9\.9\.9/);
  });

  it('names a missing CPU, a renamed file, a bad checksum, a bad size and a download address off this release', () => {
    const problems = manifestProblems(
      { ...whole(), assets: [entry('x64', { file: 'other.tar.gz', sha256: 'XYZ', size: 0, url: 'http://example.com/other.tar.gz' })] },
      { version: VERSION },
    );

    expect(problems.join('\n')).toMatch(/lists 1 archives/);
    expect(problems.join('\n')).toMatch(/no arm64 archive/);
    expect(problems.join('\n')).toMatch(/x64 archive is named other\.tar\.gz/);
    expect(problems.join('\n')).toMatch(/x64 checksum/);
    expect(problems.join('\n')).toMatch(/x64 size/);
    expect(problems.join('\n')).toMatch(/x64 download address/);
  });

  it('refuses a manifest that is not an object', () => {
    expect(manifestProblems(null, { version: VERSION })).toEqual(['the manifest is not an object']);
  });
});

describe('the archives a manifest names', () => {
  it('passes archives whose size and SHA-256 match, and names each that does not', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-manifest-test-'));
    temporaryFolders.push(folder);
    const good = Buffer.from('good archive');
    const goodEntry = entry('x64', { sha256: createHash('sha256').update(good).digest('hex'), size: good.length });
    fs.writeFileSync(path.join(folder, goodEntry.file as string), good);
    const badEntry = entry('arm64', { size: 5 });
    fs.writeFileSync(path.join(folder, badEntry.file as string), 'not the archive');

    expect(archiveProblems({ assets: [goodEntry] }, folder)).toEqual([]);
    const problems = archiveProblems({ assets: [goodEntry, badEntry] }, folder).join('\n');
    expect(problems).toMatch(/arm64\.tar\.gz is 15 bytes and the manifest says 5/);
    expect(problems).toMatch(/hashes to/);
    expect(archiveProblems({ assets: [entry('arm64')] }, path.join(folder, 'missing'))[0]).toMatch(/not in/);
  });
});

describe('where each release leg keeps the packaged resources', () => {
  it('finds every macOS app, and the one folder electron-builder makes elsewhere', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-out-test-'));
    temporaryFolders.push(out);
    fs.mkdirSync(path.join(out, 'mac-arm64', 'Kangentic.app', 'Contents', 'Resources'), { recursive: true });
    fs.mkdirSync(path.join(out, 'win-unpacked'), { recursive: true });

    expect(packagedResourceFolders('macos-arm64', out)).toEqual([path.join(out, 'mac-arm64', 'Kangentic.app', 'Contents', 'Resources')]);
    expect(packagedResourceFolders('windows', out)).toEqual([path.join(out, 'win-unpacked', 'resources')]);
    expect(packagedResourceFolders('linux', out)).toEqual([path.join(out, 'linux-unpacked', 'resources')]);
    expect(packagedResourceFolders('linux-arm64', out)).toEqual([path.join(out, 'linux-arm64-unpacked', 'resources')]);
    expect(packagedResourceFolders('freebsd', out)).toEqual([]);
  });
});
