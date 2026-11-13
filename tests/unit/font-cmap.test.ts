/**
 * woff2Codepoints names the font when its cmap points past its own end. The committed faces are
 * all well formed, so nothing else reaches that branch: without it, a bad cut fails
 * scripts/cut-demo-fonts.mjs and demo-fonts.test.ts with a bare RangeError that names no file.
 */
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { woff2Codepoints } from '../../scripts/lib/font-cmap.mjs';

const WOFF2_HEADER_BYTES = 48;

/** A one-table WOFF2 (cmap, untransformed) around the given cmap bytes. */
function woff2WithCmap(cmap: Buffer): Buffer {
  const compressed = zlib.brotliCompressSync(cmap);
  const header = Buffer.alloc(WOFF2_HEADER_BYTES);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(compressed.length, 20);
  // The table directory entry: flags 0 is the known tag cmap at transform version 0
  // (untransformed), then its length as a one-byte UIntBase128.
  const directory = Buffer.from([0x00, cmap.length]);
  return Buffer.concat([header, directory, compressed]);
}

describe('woff2Codepoints', () => {
  it('reads a format 12 group out of a well-formed cmap', () => {
    const cmap = Buffer.alloc(4 + 8 + 28);
    cmap.writeUInt16BE(0, 0);
    cmap.writeUInt16BE(1, 2);
    cmap.writeUInt16BE(3, 4);
    cmap.writeUInt16BE(10, 6);
    cmap.writeUInt32BE(12, 8);
    cmap.writeUInt16BE(12, 12);
    cmap.writeUInt32BE(28, 16);
    cmap.writeUInt32BE(1, 24);
    cmap.writeUInt32BE(0x2190, 28);
    cmap.writeUInt32BE(0x2192, 32);
    cmap.writeUInt32BE(5, 36);

    expect([...woff2Codepoints(woff2WithCmap(cmap), 'arrows.woff2')]).toEqual([0x2190, 0x2191, 0x2192]);
  });

  it('names the font when a subtable offset points past the cmap table', () => {
    const cmap = Buffer.alloc(12);
    cmap.writeUInt16BE(0, 0);
    cmap.writeUInt16BE(1, 2);
    cmap.writeUInt16BE(3, 4);
    cmap.writeUInt16BE(10, 6);
    cmap.writeUInt32BE(1000, 8);

    let thrown: unknown = null;
    try {
      woff2Codepoints(woff2WithCmap(cmap), 'broken-cut.woff2');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/^broken-cut\.woff2 has a cmap table that points past its own end/);
    expect((thrown as Error).cause).toBeInstanceOf(RangeError);
  });
});
