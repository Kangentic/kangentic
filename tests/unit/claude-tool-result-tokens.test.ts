/**
 * Tests for the Claude adapter's tool-result size estimate
 * (`src/main/agent/adapters/claude/tool-result-tokens.ts`), the source of
 * `PerToolStat.resultTokens`. The image path is the one that matters most: a
 * character estimate over base64 would turn one screenshot into tens of
 * thousands of tokens.
 */
import { describe, it, expect } from 'vitest';
import {
  estimateToolResultTokens,
  estimateImageTokens,
  readImageDimensions,
  IMAGE_TOKEN_CAP,
} from '../../src/main/agent/adapters/claude/tool-result-tokens';

function pngBase64(width: number, height: number): string {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString('base64');
}

function gifBase64(width: number, height: number): string {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header.toString('base64');
}

/** A JPEG stream as base64: SOI followed by the given raw segments, in order. */
function jpegFromSegments(...segments: Buffer[]): string {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments]).toString('base64');
}

/** A length-prefixed segment: 0xff, the marker, a big-endian length that counts itself, then the payload. */
function jpegSegment(marker: number, payload: Buffer): Buffer {
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(2 + payload.length, 2);
  payload.copy(segment, 4);
  return segment;
}

/** A 16-byte APP0 segment, the usual first thing after SOI. */
function app0Segment(): Buffer {
  return jpegSegment(0xe0, Buffer.alloc(14));
}

/** A 19-byte frame header with the given SOF marker (0xc0 baseline, 0xc2 progressive, ...). */
function sofSegment(marker: number, width: number, height: number): Buffer {
  const payload = Buffer.alloc(15);
  payload[0] = 8;
  payload.writeUInt16BE(height, 1);
  payload.writeUInt16BE(width, 3);
  return jpegSegment(marker, payload);
}

/** SOI, an APP0 segment to skip, then an SOF0 frame header. */
function jpegBase64(width: number, height: number): string {
  return jpegFromSegments(app0Segment(), sofSegment(0xc0, width, height));
}

describe('estimateToolResultTokens', () => {
  it('estimates string content at chars/4', () => {
    expect(estimateToolResultTokens('a'.repeat(400))).toBe(100);
  });

  it('sums text blocks and prices image blocks separately', () => {
    const content = [
      { type: 'text', text: 'a'.repeat(40) },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64(756, 112) } },
    ];
    // 756 x 112 is exactly 27 x 4 patches of 28px.
    expect(estimateToolResultTokens(content)).toBe(10 + 108);
  });

  it('returns 0 for content it cannot read', () => {
    expect(estimateToolResultTokens(undefined)).toBe(0);
    expect(estimateToolResultTokens({ type: 'text' })).toBe(0);
  });
});

describe('estimateImageTokens', () => {
  it('matches the high-resolution column of the vision docs table', () => {
    // platform.claude.com/docs/en/build-with-claude/vision, "Resolution and token cost".
    expect(estimateImageTokens({ data: pngBase64(200, 200) })).toBe(64);
    expect(estimateImageTokens({ data: pngBase64(1000, 1000) })).toBe(1296);
    expect(estimateImageTokens({ data: pngBase64(1092, 1092) })).toBe(1521);
    expect(estimateImageTokens({ data: pngBase64(1920, 1080) })).toBe(2691);
    expect(estimateImageTokens({ data: pngBase64(2000, 1500) })).toBe(3888);
    expect(estimateImageTokens({ data: pngBase64(3840, 2160) })).toBe(4784);
  });

  it('scales the long edge to 2576px and never exceeds the per-image ceiling', () => {
    // 5152 x 140 scales to 2576 x 70: 92 x 3 patches.
    expect(estimateImageTokens({ data: pngBase64(5152, 140) })).toBe(276);
    // 8000 x 8000 scales to 2576 x 2576, still over the ceiling, so it costs the ceiling.
    expect(estimateImageTokens({ data: pngBase64(8000, 8000) })).toBe(IMAGE_TOKEN_CAP);
  });

  it('counts an unreadable header at the cap', () => {
    expect(estimateImageTokens({ data: Buffer.from('not an image').toString('base64') })).toBe(IMAGE_TOKEN_CAP);
    expect(estimateImageTokens(undefined)).toBe(IMAGE_TOKEN_CAP);
  });
});

describe('readImageDimensions', () => {
  it('reads PNG, GIF, and JPEG headers', () => {
    expect(readImageDimensions(pngBase64(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(readImageDimensions(gifBase64(64, 32))).toEqual({ width: 64, height: 32 });
    expect(readImageDimensions(jpegBase64(800, 450))).toEqual({ width: 800, height: 450 });
  });

  it('returns null for anything else', () => {
    expect(readImageDimensions('')).toBeNull();
    expect(readImageDimensions(Buffer.from('RIFF....WEBP').toString('base64'))).toBeNull();
  });
});

describe('readImageDimensions JPEG segment walk', () => {
  // 0xc4 (DHT), 0xc8 (JPG), and 0xcc (DAC) sit inside the 0xc0-0xcf SOF range
  // but are not frame headers. Each is a length-prefixed segment to skip.
  const nonFrameMarkers = [
    { name: 'DHT', marker: 0xc4 },
    { name: 'JPG', marker: 0xc8 },
    { name: 'DAC', marker: 0xcc },
  ];

  it.each(nonFrameMarkers)('skips a $name segment and reads the SOF2 frame header after it', ({ marker }) => {
    // Laid out so that reading this segment as a frame header would give
    // 1110 x 291, which is not the image's real 640 x 480.
    const misleadingPayload = Buffer.alloc(18);
    misleadingPayload.writeUInt16BE(291, 1);
    misleadingPayload.writeUInt16BE(1110, 3);
    const base64 = jpegFromSegments(
      jpegSegment(marker, misleadingPayload),
      sofSegment(0xc2, 640, 480),
    );
    expect(readImageDimensions(base64)).toEqual({ width: 640, height: 480 });
  });

  it('skips fill bytes before a marker', () => {
    // Three 0xff in a row (two fill bytes plus the SOF0 marker's own 0xff).
    const base64 = jpegFromSegments(Buffer.from([0xff, 0xff]), sofSegment(0xc0, 800, 450));
    expect(readImageDimensions(base64)).toEqual({ width: 800, height: 450 });
  });

  it('returns null when the stream ends before any frame header', () => {
    expect(readImageDimensions(jpegFromSegments(app0Segment()))).toBeNull();
  });

  it('returns null, without throwing, when the stream ends inside the frame header', () => {
    // SOF0 cut after 6 of its 19 bytes: too short to hold the width and height.
    const truncatedFrameHeader = sofSegment(0xc0, 800, 450).subarray(0, 6);
    expect(readImageDimensions(jpegFromSegments(app0Segment(), truncatedFrameHeader))).toBeNull();
  });

  it('returns null when a segment does not start with 0xff', () => {
    // A valid SOF0 follows the garbage. The garbage is shaped so a walker that
    // ignored the 0xff check would step over it (marker 0x00, length 2) and
    // land on that SOF0, so only the check itself yields null here.
    const garbage = Buffer.from([0x12, 0x00, 0x00, 0x02]);
    const base64 = jpegFromSegments(app0Segment(), garbage, sofSegment(0xc0, 800, 450));
    expect(readImageDimensions(base64)).toBeNull();
  });
});
