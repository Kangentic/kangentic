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
import { createHash } from 'node:crypto';
import { readHostAssets } from '../../src/main/remote/host-assets';
import { RefusalError } from '../../src/shared/refusal';
import { isExpectedFailure } from '../../src/main/analytics/handled-report';

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

  it('reads a manifest of null, or a null entry, as a problem, never a throw', () => {
    fs.writeFileSync(path.join(directory, 'manifest.json'), 'null');
    expect(readHostAssets(directory, '0.52.0')).toEqual({ assets: [], problem: 'The host program manifest is not an object.' });

    write({ ...goodManifest, assets: [null, goodManifest.assets[0]] });
    const found = readHostAssets(directory, '0.52.0');
    expect(found.assets.map((asset) => asset.arch)).toEqual(['x64']);
    expect(found.problem).toContain('an entry is not an object');
  });

  it('refuses a file name of . or .., which would name the folder or its parent', () => {
    write({ ...goodManifest, assets: [{ arch: 'x64', file: '..', sha256: SHA_X64 }, { arch: 'arm64', file: '.', sha256: SHA_ARM }] });

    const found = readHostAssets(directory, '0.52.0');

    expect(found.assets).toEqual([]);
    expect(found.problem).toContain('not a plain file name');
  });
});

describe('a build that carries only the manifest and downloads the archive on first use', () => {
  const ARCHIVE = Buffer.from('pretend this is a 45 MB tarball');
  const ARCHIVE_SHA = createHash('sha256').update(ARCHIVE).digest('hex');
  const URL_X64 = 'https://example.test/releases/v0.52.0/kangentic-host-0.52.0-linux-x64.tar.gz';
  let cacheDirectory: string;

  function manifestOnly(overrides: Record<string, unknown> = {}) {
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
      version: '0.52.0',
      assets: [{ arch: 'x64', file: 'kangentic-host-0.52.0-linux-x64.tar.gz', sha256: ARCHIVE_SHA, size: ARCHIVE.length, url: URL_X64, ...overrides }],
    }));
  }

  function fakeFetch(handler: (url: string) => { status?: number; body?: Buffer } | Error) {
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const result = handler(url);
      if (result instanceof Error) throw result;
      return new Response(result.body ? new Uint8Array(result.body) : null, { status: result.status ?? 200 });
    }) as typeof fetch;
    return { impl, calls };
  }

  beforeEach(() => {
    cacheDirectory = path.join(directory, 'cache');
  });

  it('offers the entry with a cache path and a prepare step, and fetches nothing until it is called', () => {
    manifestOnly();
    const network = fakeFetch(() => ({ body: ARCHIVE }));

    const found = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: network.impl });

    expect(found.problem).toBeNull();
    expect(found.assets).toHaveLength(1);
    expect(found.assets[0].filePath).toBe(path.join(cacheDirectory, '0.52.0', 'kangentic-host-0.52.0-linux-x64.tar.gz'));
    expect(found.assets[0].prepare).toBeTypeOf('function');
    expect(network.calls).toEqual([]);
  });

  it('downloads, verifies and puts the archive in the cache, and leaves no partial file', async () => {
    manifestOnly();
    const network = fakeFetch(() => ({ body: ARCHIVE }));
    const [asset] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: network.impl }).assets;

    await asset.prepare!();

    expect(fs.readFileSync(asset.filePath)).toEqual(ARCHIVE);
    expect(fs.readdirSync(path.dirname(asset.filePath))).toEqual(['kangentic-host-0.52.0-linux-x64.tar.gz']);
    expect(network.calls).toEqual([URL_X64]);
  });

  it('keeps a verified copy and fetches nothing the second time', async () => {
    manifestOnly();
    const network = fakeFetch(() => ({ body: ARCHIVE }));
    const [asset] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: network.impl }).assets;
    await asset.prepare!();

    await asset.prepare!();

    expect(network.calls).toHaveLength(1);
  });

  it('shares one fetch between two prepares of one destination that run at once, and both resolve', async () => {
    manifestOnly();
    let release = (): void => undefined;
    const open = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      await open;
      return new Response(new Uint8Array(ARCHIVE), { status: 200 });
    }) as typeof fetch;
    const [first] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: impl }).assets;
    const [second] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: impl }).assets;

    const both = Promise.all([first.prepare!(), second.prepare!()]);
    release();
    await both;

    expect(calls).toEqual([URL_X64]);
    expect(fs.readFileSync(first.filePath)).toEqual(ARCHIVE);
    expect(fs.readdirSync(path.dirname(first.filePath))).toEqual(['kangentic-host-0.52.0-linux-x64.tar.gz']);
  });

  it('does not remember a failed download, so a later prepare fetches again', async () => {
    manifestOnly();
    let attempt = 0;
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      attempt += 1;
      return attempt === 1 ? new Response(null, { status: 503 }) : new Response(new Uint8Array(ARCHIVE), { status: 200 });
    }) as typeof fetch;
    const [asset] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: impl }).assets;

    await expect(asset.prepare!()).rejects.toThrow('answered 503');
    await asset.prepare!();

    expect(calls).toHaveLength(2);
    expect(fs.readFileSync(asset.filePath)).toEqual(ARCHIVE);
  });

  it('replaces a cached copy that is not the one the manifest names, instead of uploading it', async () => {
    manifestOnly();
    const network = fakeFetch(() => ({ body: ARCHIVE }));
    const [asset] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: network.impl }).assets;
    fs.mkdirSync(path.dirname(asset.filePath), { recursive: true });
    fs.writeFileSync(asset.filePath, 'a truncated or tampered file');

    await asset.prepare!();

    expect(fs.readFileSync(asset.filePath)).toEqual(ARCHIVE);
    expect(network.calls).toHaveLength(1);
  });

  it('refuses bytes that do not match the checksum, keeping nothing', async () => {
    manifestOnly();
    // The same length as the real one, so it is the checksum and not the size check that refuses it.
    const network = fakeFetch(() => ({ body: Buffer.alloc(ARCHIVE.length, 'x') }));
    const [asset] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: network.impl }).assets;

    await expect(asset.prepare!()).rejects.toThrow('does not match the checksum');

    expect(fs.existsSync(asset.filePath)).toBe(false);
    expect(fs.existsSync(`${asset.filePath}.part`)).toBe(false);
  });

  it('refuses a download whose size is not the manifest\'s, before it is hashed', async () => {
    manifestOnly({ size: ARCHIVE.length + 1 });
    const [asset] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: fakeFetch(() => ({ body: ARCHIVE })).impl }).assets;

    await expect(asset.prepare!()).rejects.toThrow('manifest says');
  });

  it('says which host answered with an error status, and when the network is not there at all', async () => {
    manifestOnly();
    const [refused] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: fakeFetch(() => ({ status: 404 })).impl }).assets;
    await expect(refused.prepare!()).rejects.toThrow('example.test answered 404');

    const [offline] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: fakeFetch(() => new Error('getaddrinfo ENOTFOUND example.test')).impl }).assets;
    await expect(offline.prepare!()).rejects.toThrow('ENOTFOUND');
  });

  it('wraps a failed fetch in a plain Error with its cause: a defect still reports, a network failure is skipped', async () => {
    manifestOnly();
    const prepareRejection = async (failure: Error): Promise<unknown> => {
      const [asset] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: fakeFetch(() => failure).impl }).assets;
      return asset.prepare!().then(() => null, (error: unknown) => error);
    };

    const defect = new TypeError('boom');
    const defectRejection = await prepareRejection(defect);
    expect(defectRejection).toBeInstanceOf(Error);
    expect(defectRejection).not.toBeInstanceOf(RefusalError);
    expect((defectRejection as Error).cause).toBe(defect);
    expect(isExpectedFailure(defectRejection)).toBe(false);

    const networkFailure = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    const networkRejection = await prepareRejection(networkFailure);
    expect(networkRejection).not.toBeInstanceOf(RefusalError);
    expect((networkRejection as Error).cause).toBe(networkFailure);
    expect(isExpectedFailure(networkRejection)).toBe(true);
  });

  it('refuses an error status with a RefusalError, which is expected', async () => {
    manifestOnly();
    const [refused] = readHostAssets(directory, '0.52.0', { cacheDirectory, fetchImpl: fakeFetch(() => ({ status: 404 })).impl }).assets;

    const rejection = await refused.prepare!().then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(RefusalError);
    expect(isExpectedFailure(rejection)).toBe(true);
  });

  it('refuses a download address that is not https, and leaves the entry out', () => {
    manifestOnly({ url: 'http://example.test/host.tar.gz' });

    const found = readHostAssets(directory, '0.52.0', { cacheDirectory });

    expect(found.assets).toEqual([]);
    expect(found.problem).toContain('not https');
  });

  it('uses the archive in the folder when there is one, whatever the manifest\'s address says', () => {
    manifestOnly();
    fs.writeFileSync(path.join(directory, 'kangentic-host-0.52.0-linux-x64.tar.gz'), ARCHIVE);

    const [asset] = readHostAssets(directory, '0.52.0', { cacheDirectory }).assets;

    expect(asset.filePath).toBe(path.join(directory, 'kangentic-host-0.52.0-linux-x64.tar.gz'));
    expect(asset.prepare).toBeUndefined();
  });

  it('leaves an address-only entry out when the caller gave no cache folder to download into', () => {
    manifestOnly();

    expect(readHostAssets(directory, '0.52.0').assets).toEqual([]);
  });
});
