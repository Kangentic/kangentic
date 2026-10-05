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

/** SOI, an APP0 segment to skip, then an SOF0 frame header. */
function jpegBase64(width: number, height: number): string {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]).toString('base64');
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
