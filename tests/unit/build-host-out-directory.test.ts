/**
 * Which `--out` folders `scripts/build-host.mjs` agrees to empty. The build deletes `--out` first, so a
 * user's folder of other files must be refused, while the leftovers of a build that failed partway (an
 * archive and no manifest yet) must be accepted, or the next build could never start.
 *
 * Importing the script runs nothing: its build starts only when it is the entry point.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeOutDirectory, nodeDistributionKind } from '../../scripts/build-host.mjs';

let outDirectory: string;

beforeEach(() => {
  outDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-build-host-out-'));
});

afterEach(() => {
  fs.rmSync(outDirectory, { recursive: true, force: true });
});

describe('the --out folder of the host build', () => {
  it('accepts a folder holding only an archive, which is what a build that failed partway leaves', () => {
    fs.writeFileSync(path.join(outDirectory, 'kangentic-host-1.2.3-linux-x64.tar.gz'), 'partial');

    expect(() => assertSafeOutDirectory(outDirectory)).not.toThrow();
  });

  it('accepts a folder that holds an earlier build\'s manifest, an empty folder and one that is not there', () => {
    fs.writeFileSync(path.join(outDirectory, 'manifest.json'), '{}');
    expect(() => assertSafeOutDirectory(outDirectory)).not.toThrow();

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-build-host-empty-'));
    try {
      expect(() => assertSafeOutDirectory(empty)).not.toThrow();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
    expect(() => assertSafeOutDirectory(path.join(outDirectory, 'not-there'))).not.toThrow();
  });

  it('refuses a folder of other files that holds no manifest, so it is never emptied', () => {
    fs.writeFileSync(path.join(outDirectory, 'notes.txt'), 'mine');

    expect(() => assertSafeOutDirectory(outDirectory)).toThrow('not an earlier host build');
    expect(fs.readFileSync(path.join(outDirectory, 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('refuses the repository itself and a folder above it', () => {
    expect(() => assertSafeOutDirectory(path.resolve(__dirname, '..', '..'))).toThrow('the repository or a folder above it');
    expect(() => assertSafeOutDirectory(path.resolve(__dirname, '..', '..', '..'))).toThrow('the repository or a folder above it');
  });
});

describe('the Node distribution tarball the host build unpacks', () => {
  it('picks gzip on Windows, because System32 tar cannot unpack xz', () => {
    expect(nodeDistributionKind('win32')).toEqual({ extension: 'tar.gz', extractFlag: '-xzf' });
  });

  it('keeps xz on macOS and Linux, where tar can unpack it', () => {
    expect(nodeDistributionKind('linux')).toEqual({ extension: 'tar.xz', extractFlag: '-xJf' });
    expect(nodeDistributionKind('darwin')).toEqual({ extension: 'tar.xz', extractFlag: '-xJf' });
  });
});
