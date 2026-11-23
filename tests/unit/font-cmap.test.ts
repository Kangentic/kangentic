/**
 * woff2Codepoints names the font when its cmap points past its own end. The committed faces are
 * all well formed, so nothing else reaches that branch: without it, a bad cut fails
 * scripts/cut-demo-fonts.mjs and demo-fonts.test.ts with a bare RangeError that names no file.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { woff2Codepoints, woff2VerticalMetrics } from '../../scripts/lib/font-cmap.mjs';
import { metricOverrides } from '../../scripts/lib/demo-fonts.mjs';

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

interface MetricsFixture {
  unitsPerEm: number;
  hhea: { ascender: number; descender: number; lineGap: number };
  typo: { ascender: number; descender: number; lineGap: number };
  useTypoMetrics: boolean;
}

/** A head + hhea + OS/2 WOFF2 (all untransformed), built from the fields the demo reads. */
function woff2WithMetrics(fixture: MetricsFixture): Buffer {
  const head = Buffer.alloc(54);
  head.writeUInt16BE(fixture.unitsPerEm, 18);
  const hhea = Buffer.alloc(36);
  hhea.writeInt16BE(fixture.hhea.ascender, 4);
  hhea.writeInt16BE(fixture.hhea.descender, 6);
  hhea.writeInt16BE(fixture.hhea.lineGap, 8);
  const os2 = Buffer.alloc(78);
  os2.writeUInt16BE(fixture.useTypoMetrics ? 0x80 : 0, 62);
  os2.writeInt16BE(fixture.typo.ascender, 68);
  os2.writeInt16BE(fixture.typo.descender, 70);
  os2.writeInt16BE(fixture.typo.lineGap, 72);
  const compressed = zlib.brotliCompressSync(Buffer.concat([head, hhea, os2]));
  const header = Buffer.alloc(WOFF2_HEADER_BYTES);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt16BE(3, 12);
  header.writeUInt32BE(compressed.length, 20);
  // Known tags head (1), hhea (2) and OS/2 (6), each at transform version 0, then a one-byte length.
  const directory = Buffer.from([0x01, head.length, 0x02, hhea.length, 0x06, os2.length]);
  return Buffer.concat([header, directory, compressed]);
}

// A face that disagrees with itself: the typo and hhea numbers differ everywhere, so reading the
// wrong table, or the wrong offset inside the right one, shows in the value.
const DISAGREEING_FACE: Omit<MetricsFixture, 'useTypoMetrics'> = {
  unitsPerEm: 1000,
  hhea: { ascender: 900, descender: -200, lineGap: 90 },
  typo: { ascender: 800, descender: -250, lineGap: 40 },
};

describe('woff2VerticalMetrics', () => {
  it('reads the OS/2 typo values, line gap included, when the face sets USE_TYPO_METRICS', () => {
    const metrics = woff2VerticalMetrics(woff2WithMetrics({ ...DISAGREEING_FACE, useTypoMetrics: true }), 'typo.woff2');
    expect(metrics).toEqual({ unitsPerEm: 1000, ascender: 800, descender: -250, lineGap: 40, source: 'typo' });
  });

  it('reads the hhea values, line gap included, when the face does not set it', () => {
    const metrics = woff2VerticalMetrics(woff2WithMetrics({ ...DISAGREEING_FACE, useTypoMetrics: false }), 'hhea.woff2');
    expect(metrics).toEqual({ unitsPerEm: 1000, ascender: 900, descender: -200, lineGap: 90, source: 'hhea' });
  });

  it('names the font when it is not a WOFF2 file or carries no OS/2 table', () => {
    expect(() => woff2VerticalMetrics(Buffer.alloc(64), 'plain.ttf')).toThrow(/^plain\.ttf is not a WOFF2 file/);
    // The cmap-only fixture has no head table, so the first table the metrics need is missing.
    expect(() => woff2VerticalMetrics(woff2WithCmap(Buffer.alloc(4)), 'cmap-only.woff2')).toThrow(/^cmap-only\.woff2 carries no head table/);
  });
});

describe('metricOverrides', () => {
  function overridesFor(fixture: MetricsFixture): ReturnType<typeof metricOverrides> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-overrides-'));
    try {
      const file = path.join(directory, 'face.woff2');
      fs.writeFileSync(file, woff2WithMetrics(fixture));
      return metricOverrides(file);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  it('turns the metrics into percentages of the em, the descent as a positive number and a gap kept', () => {
    expect(overridesFor({ ...DISAGREEING_FACE, useTypoMetrics: false })).toEqual({
      ascentOverride: '90%',
      descentOverride: '20%',
      lineGapOverride: '9%',
    });
  });

  it('does not let float division leak digits into a descriptor', () => {
    // 859 / 1000 * 100 is 85.89999999999999; the descriptor must read 85.9%.
    const overrides = overridesFor({
      unitsPerEm: 1000,
      hhea: { ascender: 859, descender: -190, lineGap: 0 },
      typo: { ascender: 0, descender: 0, lineGap: 0 },
      useTypoMetrics: false,
    });
    expect(overrides).toEqual({ ascentOverride: '85.9%', descentOverride: '19%', lineGapOverride: '0%' });
  });
});

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
