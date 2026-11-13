/**
 * The codepoints a WOFF2 font maps to a glyph, read from its `cmap` table.
 *
 * The web demo ships its own faces (scripts/lib/demo-fonts.mjs), and a codepoint none of them
 * maps falls back to whatever face the visitor's OS has, which is a different glyph on every OS.
 * scripts/cut-demo-fonts.mjs and tests/unit/demo-fonts.test.ts both need to know what
 * each shipped file covers. A face's `unicode-range` is not that answer: Fontsource declares a
 * range per subset, and the subset's file may carry only part of it (Roboto's "symbols" subset
 * declares the dingbats and maps none of them).
 *
 * WOFF2 (https://www.w3.org/TR/WOFF2/) compresses every table as one Brotli stream after a table
 * directory of variable-length entries. `cmap` is never transformed, so its bytes sit in the
 * decompressed stream at the sum of the lengths before it. Formats 4 and 12 are the two a
 * Unicode cmap uses; the others map nothing past the BMP basics and are skipped.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const WOFF2_SIGNATURE = 0x774f4632; // 'wOF2'
const WOFF2_HEADER_BYTES = 48;

/** The spec's known-table list, indexed by the low six bits of an entry's flags byte. */
const KNOWN_TABLE_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

/** UIntBase128: up to five bytes, seven bits each, high bit set on every byte but the last. */
function readBase128(buffer, cursor) {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    const byte = buffer[cursor.offset++];
    value = (value * 128) + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error('a UIntBase128 ran past five bytes');
}

/** The `cmap` table's bytes out of a WOFF2 file's contents. */
function woff2CmapBytes(bytes, label) {
  if (bytes.length < WOFF2_HEADER_BYTES || bytes.readUInt32BE(0) !== WOFF2_SIGNATURE) {
    throw new Error(`${label} is not a WOFF2 file`);
  }
  const tableCount = bytes.readUInt16BE(12);
  const compressedLength = bytes.readUInt32BE(20);
  const cursor = { offset: WOFF2_HEADER_BYTES };
  const tables = [];
  for (let index = 0; index < tableCount; index++) {
    const flags = bytes[cursor.offset++];
    let tag;
    if ((flags & 0x3f) === 0x3f) {
      tag = bytes.toString('latin1', cursor.offset, cursor.offset + 4);
      cursor.offset += 4;
    } else {
      tag = KNOWN_TABLE_TAGS[flags & 0x3f];
    }
    const transformVersion = (flags >> 6) & 0x03;
    const originalLength = readBase128(bytes, cursor);
    // glyf and loca are transformed at version 0 and plain at 3; every other table the reverse.
    const transformed = tag === 'glyf' || tag === 'loca' ? transformVersion !== 3 : transformVersion !== 0;
    const length = transformed ? readBase128(bytes, cursor) : originalLength;
    tables.push({ tag, length });
  }
  const stream = zlib.brotliDecompressSync(bytes.subarray(cursor.offset, cursor.offset + compressedLength));
  let offset = 0;
  for (const table of tables) {
    if (table.tag === 'cmap') return stream.subarray(offset, offset + table.length);
    offset += table.length;
  }
  throw new Error(`${label} carries no cmap table`);
}

function addFormat4(cmap, start, into) {
  const segmentCountTimesTwo = cmap.readUInt16BE(start + 6);
  const endCodes = start + 14;
  const startCodes = endCodes + segmentCountTimesTwo + 2;
  const idDeltas = startCodes + segmentCountTimesTwo;
  const idRangeOffsets = idDeltas + segmentCountTimesTwo;
  for (let segment = 0; segment < segmentCountTimesTwo / 2; segment++) {
    const endCode = cmap.readUInt16BE(endCodes + segment * 2);
    const startCode = cmap.readUInt16BE(startCodes + segment * 2);
    const idDelta = cmap.readInt16BE(idDeltas + segment * 2);
    const idRangeOffset = cmap.readUInt16BE(idRangeOffsets + segment * 2);
    for (let code = startCode; code <= endCode && code !== 0xffff; code++) {
      let glyph;
      if (idRangeOffset === 0) {
        glyph = (code + idDelta) & 0xffff;
      } else {
        glyph = cmap.readUInt16BE(idRangeOffsets + segment * 2 + idRangeOffset + (code - startCode) * 2);
        if (glyph !== 0) glyph = (glyph + idDelta) & 0xffff;
      }
      if (glyph !== 0) into.add(code);
    }
  }
}

function addFormat12(cmap, start, into) {
  const groupCount = cmap.readUInt32BE(start + 12);
  for (let group = 0; group < groupCount; group++) {
    const at = start + 16 + group * 12;
    const startCode = cmap.readUInt32BE(at);
    const endCode = cmap.readUInt32BE(at + 4);
    const startGlyph = cmap.readUInt32BE(at + 8);
    for (let code = startCode; code <= endCode; code++) {
      if (startGlyph + (code - startCode) !== 0) into.add(code);
    }
  }
}

/** Every codepoint a WOFF2 font's bytes map to a glyph other than .notdef. */
export function woff2Codepoints(bytes, label = 'font') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cmap = woff2CmapBytes(buffer, label);
  const covered = new Set();
  try {
    const subtableCount = cmap.readUInt16BE(2);
    for (let index = 0; index < subtableCount; index++) {
      const subtableOffset = cmap.readUInt32BE(4 + index * 8 + 4);
      const format = cmap.readUInt16BE(subtableOffset);
      if (format === 4) addFormat4(cmap, subtableOffset, covered);
      else if (format === 12) addFormat12(cmap, subtableOffset, covered);
    }
  } catch (error) {
    // A read past the table's end throws a RangeError that names no file.
    if (!(error instanceof RangeError)) throw error;
    throw new Error(`${label} has a cmap table that points past its own end (${error.message})`, { cause: error });
  }
  return covered;
}

/** The same, for a file on disk. */
export function woff2FileCodepoints(filePath) {
  return woff2Codepoints(fs.readFileSync(filePath), filePath);
}
