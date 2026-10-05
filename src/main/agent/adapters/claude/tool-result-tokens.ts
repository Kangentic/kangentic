import { estimateTokens } from '../../../retrieval/token-estimate';

/**
 * Estimated tokens one Claude `tool_result` adds to the conversation, from its
 * size. An estimate, not reported usage: the transcript carries no per-result
 * token count, and splitting a turn's `usage` across its tool calls would be a
 * guess dressed as a measurement. Feeds `PerToolStat.resultTokens`.
 *
 * Text goes through the chars/4 estimate the retrieval chunker uses. An image
 * NEVER does: its base64 payload would turn one screenshot into tens of
 * thousands of "tokens". Images are priced by Anthropic's documented vision
 * rule instead, with the dimensions read from the image header: one visual
 * token per 28x28-pixel patch, `ceil(width / 28) * ceil(height / 28)`, after
 * the long edge is scaled down to the model's limit.
 *
 * One tier for every model, on purpose. The docs give two: Claude 4.7 and later
 * models read up to a 2576px long edge and 4,784 tokens per image, older models
 * (Haiku 4.5 among them) 1568px and 1,568 tokens. Picking per model would mean
 * keeping a model table, which `cli-features-over-custom-layers.md` rules out,
 * so this uses the high-resolution tier the current models share. On an older
 * model it overstates a large image by up to about three times, which the
 * figure's "estimate" label already covers.
 * (https://platform.claude.com/docs/en/build-with-claude/vision, "Resolution
 * and token cost".)
 */

const IMAGE_PATCH_PIXELS = 28;
const IMAGE_LONG_EDGE_LIMIT = 2576;
/** The tier's per-image ceiling, and what an image with an unreadable header counts as. */
export const IMAGE_TOKEN_CAP = 4784;
/** Enough decoded bytes to reach a JPEG frame header past typical EXIF blocks. */
const JPEG_HEADER_SCAN_BYTES = 64 * 1024;

export function estimateToolResultTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'image') {
      total += estimateImageTokens(block.source);
    } else if (typeof block.text === 'string') {
      total += estimateTokens(block.text);
    }
  }
  return total;
}

export function estimateImageTokens(source: unknown): number {
  const dimensions = isRecord(source) && typeof source.data === 'string'
    ? readImageDimensions(source.data)
    : null;
  if (!dimensions) return IMAGE_TOKEN_CAP;
  const { width, height } = dimensions;
  const longEdgeScale = Math.min(1, IMAGE_LONG_EDGE_LIMIT / Math.max(width, height));
  const scaledWidth = Math.round(width * longEdgeScale);
  const scaledHeight = Math.round(height * longEdgeScale);
  const patches = Math.ceil(scaledWidth / IMAGE_PATCH_PIXELS) * Math.ceil(scaledHeight / IMAGE_PATCH_PIXELS);
  // An image still over the token ceiling after the long-edge scale is
  // downsized further until it fits, so it costs the ceiling.
  return Math.min(IMAGE_TOKEN_CAP, patches);
}

/** Width and height from a base64 PNG, GIF, or JPEG header, else null. */
export function readImageDimensions(base64: string): { width: number; height: number } | null {
  // Decode only the head. 4 base64 chars encode 3 bytes, so trim to a
  // multiple of 4 to keep the decode aligned.
  const headChars = Math.floor(Math.min(base64.length, Math.ceil(JPEG_HEADER_SCAN_BYTES / 3) * 4) / 4) * 4;
  const bytes = Buffer.from(base64.slice(0, headChars), 'base64');
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    return validDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 4) === 'GIF8') {
    return validDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return readJpegDimensions(bytes);
  }
  return null;
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // Fill bytes between segments.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    // SOF0-SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      return validDimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function validDimensions(width: number, height: number): { width: number; height: number } | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
