/**
 * The frame format between the link (on this computer) and the helper (on the host),
 * for #913. One ordered byte stream carries frames in each direction, over an `ssh`
 * connection that can lose, delay or cut bytes. Every frame is self-checking, so a
 * damaged stream ends the connection instead of being applied:
 *
 *   offset  size  field
 *   0       4     magic, the bytes "KGF1"
 *   4       1     kind (see `FrameKind`)
 *   5       1     flags, zero, reserved
 *   6       2     reserved, zero
 *   8       4     JSON body length
 *   12      4     raw body length
 *   16      8     offset (see below)
 *   24      4     CRC-32 of the JSON body followed by the raw body
 *   28      4     CRC-32 of header bytes 0 to 27
 *
 * Big-endian throughout. The body is the JSON bytes, then the raw bytes. Terminal output
 * rides in the raw part, so it is never escaped or re-encoded.
 *
 * The header is validated before the receiver waits for a body (`FrameDecoder`), so a
 * damaged length can never park the stream behind bytes that will not come. A frame
 * whose kind has the high bit set is sequenced: its offset is where it starts in the
 * sender's stream, a receiver requires each one to continue exactly where the last
 * ended, and a resume replays from an acknowledged offset (`resume-endpoint.ts`). The
 * other kinds are per-connection control frames. Their offset field means what their
 * kind says (the resume point in a hello, the offset acknowledged in an ack).
 *
 * Measured reason for all of it: System32's `ssh.exe` 9.5p2 lost 65 to 97 KB in the middle
 * of a stream in 19 of 24 full mirror syncs, and a frame straddling the loss is
 * otherwise applied corrupted (docs/audits/ssh-remote-phase-0-audit.md).
 *
 * Pure module: it imports nothing of electron, so the helper's bundle can carry it.
 */

import { crc32 } from 'node:zlib';

/** The bytes "KGF1". The trailing digit is this header layout's version, not the protocol's. */
export const FRAME_MAGIC = 0x4b474631;
export const FRAME_HEADER_BYTES = 32;
/** Largest JSON body a frame may carry. A bigger message is split by its sender. */
export const MAX_FRAME_JSON_BYTES = 256 * 1024;
/** Largest raw body a frame may carry. A bigger stretch of output is cut into several frames. */
export const MAX_FRAME_RAW_BYTES = 1024 * 1024;

const SEQUENCED_BIT = 0x80;
const HEADER_CRC_COVERS_BYTES = 28;
const EMPTY = Buffer.alloc(0);

export const FrameKind = Object.freeze({
  /** First frame of a connection, each way. Its offset is the next sequenced offset the sender expects to receive. */
  hello: 0x01,
  /** The sender has received every sequenced byte below this offset. */
  ack: 0x02,
  /** Proof of life while nothing else flows. Carries nothing. */
  heartbeat: 0x03,
  /** The sender's sequenced stream continues at this offset: what the receiver expected is gone. */
  reset: 0x04,
  /** The sender is hanging up on purpose. The JSON body names why, in words for the user. */
  close: 0x05,
  /** A sequenced message: a command, request, reply or event, with output bytes as the raw part. */
  message: 0x81,
} as const);

export function isSequencedKind(kind: number): boolean {
  return (kind & SEQUENCED_BIT) !== 0;
}

export type FrameErrorCode =
  | 'bad-magic'
  | 'bad-header-crc'
  | 'too-large'
  | 'bad-payload-crc'
  | 'bad-json'
  | 'offset-gap';

/** The stream is damaged or out of step. The only safe answer is to end the connection and resume. */
export class FrameError extends Error {
  constructor(readonly code: FrameErrorCode, message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export interface FrameInput {
  kind: number;
  offset: number;
  json?: unknown;
  raw?: Uint8Array;
}

export interface DecodedFrame {
  kind: number;
  sequenced: boolean;
  offset: number;
  /** Undefined when the frame carried no JSON body. */
  json: unknown;
  /** A copy, never a view of the receive buffer. */
  raw: Buffer;
  /** Header plus body, the amount a sequenced frame advances its stream by. */
  byteLength: number;
}

function writeOffset(target: Buffer, position: number, offset: number): void {
  target.writeUInt32BE(Math.floor(offset / 0x1_0000_0000), position);
  target.writeUInt32BE(offset % 0x1_0000_0000, position + 4);
}

function readOffset(source: Buffer, position: number): number {
  return source.readUInt32BE(position) * 0x1_0000_0000 + source.readUInt32BE(position + 4);
}

export function encodeFrame(input: FrameInput): Buffer {
  if (!Number.isInteger(input.kind) || input.kind < 0 || input.kind > 0xff) {
    throw new RangeError(`frame kind ${input.kind} does not fit one byte`);
  }
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new RangeError(`frame offset ${input.offset} is not a non-negative safe integer`);
  }
  const jsonBytes = input.json === undefined ? EMPTY : Buffer.from(JSON.stringify(input.json), 'utf8');
  const rawBytes = input.raw ? Buffer.from(input.raw.buffer, input.raw.byteOffset, input.raw.byteLength) : EMPTY;
  if (jsonBytes.length > MAX_FRAME_JSON_BYTES) {
    throw new RangeError(`a ${jsonBytes.length} byte JSON body is over the ${MAX_FRAME_JSON_BYTES} byte limit`);
  }
  if (rawBytes.length > MAX_FRAME_RAW_BYTES) {
    throw new RangeError(`a ${rawBytes.length} byte raw body is over the ${MAX_FRAME_RAW_BYTES} byte limit`);
  }

  const frame = Buffer.alloc(FRAME_HEADER_BYTES + jsonBytes.length + rawBytes.length);
  frame.writeUInt32BE(FRAME_MAGIC, 0);
  frame.writeUInt8(input.kind, 4);
  frame.writeUInt32BE(jsonBytes.length, 8);
  frame.writeUInt32BE(rawBytes.length, 12);
  writeOffset(frame, 16, input.offset);
  jsonBytes.copy(frame, FRAME_HEADER_BYTES);
  rawBytes.copy(frame, FRAME_HEADER_BYTES + jsonBytes.length);
  frame.writeUInt32BE(crc32(frame.subarray(FRAME_HEADER_BYTES)), 24);
  frame.writeUInt32BE(crc32(frame.subarray(0, HEADER_CRC_COVERS_BYTES)), HEADER_CRC_COVERS_BYTES);
  return frame;
}

interface ParsedHeader {
  kind: number;
  jsonLength: number;
  rawLength: number;
  offset: number;
  payloadCrc: number;
}

function parseHeader(header: Buffer): ParsedHeader {
  if (header.readUInt32BE(0) !== FRAME_MAGIC) {
    throw new FrameError('bad-magic', `expected the frame magic, found 0x${header.readUInt32BE(0).toString(16)}`);
  }
  if (crc32(header.subarray(0, HEADER_CRC_COVERS_BYTES)) !== header.readUInt32BE(HEADER_CRC_COVERS_BYTES)) {
    throw new FrameError('bad-header-crc', 'the frame header failed its checksum');
  }
  const jsonLength = header.readUInt32BE(8);
  const rawLength = header.readUInt32BE(12);
  if (jsonLength > MAX_FRAME_JSON_BYTES || rawLength > MAX_FRAME_RAW_BYTES) {
    throw new FrameError('too-large', `a frame announced ${jsonLength} JSON bytes and ${rawLength} raw bytes`);
  }
  return {
    kind: header.readUInt8(4),
    jsonLength,
    rawLength,
    offset: readOffset(header, 16),
    payloadCrc: header.readUInt32BE(24),
  };
}

export interface FrameDecoderOptions {
  /** Where the first sequenced frame must start. A resume passes the offset it asked for. */
  expectedOffset?: number;
}

/**
 * Cuts frames out of a byte stream delivered in arbitrary pieces. Any damage throws a
 * `FrameError`, and the decoder then stays failed: the stream is not trusted again
 * until a new connection starts a new decoder at the resume offset.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private bufferedByteCount = 0;
  private header: ParsedHeader | null = null;
  private nextSequencedOffset: number;
  private failure: FrameError | null = null;

  constructor(options: FrameDecoderOptions = {}) {
    this.nextSequencedOffset = options.expectedOffset ?? 0;
  }

  /** Where the next sequenced frame must start. Advances as complete sequenced frames are decoded. */
  get nextOffset(): number {
    return this.nextSequencedOffset;
  }

  get bufferedBytes(): number {
    return this.bufferedByteCount;
  }

  push(chunk: Uint8Array): DecodedFrame[] {
    if (this.failure) throw this.failure;
    if (chunk.byteLength > 0) {
      this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      this.bufferedByteCount += chunk.byteLength;
    }
    const frames: DecodedFrame[] = [];
    try {
      for (;;) {
        if (!this.header) {
          if (this.bufferedByteCount < FRAME_HEADER_BYTES) break;
          const header = parseHeader(this.flatten().subarray(0, FRAME_HEADER_BYTES));
          if (isSequencedKind(header.kind) && header.offset !== this.nextSequencedOffset) {
            throw new FrameError('offset-gap', `expected a frame at offset ${this.nextSequencedOffset}, found ${header.offset}`);
          }
          this.header = header;
        }
        const bodyLength = this.header.jsonLength + this.header.rawLength;
        if (this.bufferedByteCount < FRAME_HEADER_BYTES + bodyLength) break;
        frames.push(this.completeFrame(this.header, bodyLength));
        this.header = null;
      }
    } catch (error) {
      this.failure = error instanceof FrameError ? error : new FrameError('bad-json', String(error));
      throw this.failure;
    }
    return frames;
  }

  private flatten(): Buffer {
    if (this.chunks.length === 1) return this.chunks[0];
    const joined = Buffer.concat(this.chunks, this.bufferedByteCount);
    this.chunks = [joined];
    return joined;
  }

  private completeFrame(header: ParsedHeader, bodyLength: number): DecodedFrame {
    const all = this.flatten();
    const byteLength = FRAME_HEADER_BYTES + bodyLength;
    const body = all.subarray(FRAME_HEADER_BYTES, byteLength);
    if (crc32(body) !== header.payloadCrc) {
      throw new FrameError('bad-payload-crc', 'the frame body failed its checksum');
    }
    let json: unknown;
    if (header.jsonLength > 0) {
      try {
        json = JSON.parse(body.subarray(0, header.jsonLength).toString('utf8'));
      } catch (error) {
        throw new FrameError('bad-json', `the frame's JSON body does not parse: ${String(error)}`);
      }
    }
    const raw = Buffer.from(body.subarray(header.jsonLength));
    this.chunks = byteLength < all.length ? [all.subarray(byteLength)] : [];
    this.bufferedByteCount -= byteLength;
    const sequenced = isSequencedKind(header.kind);
    if (sequenced) this.nextSequencedOffset += byteLength;
    // The sender says its stream picks up elsewhere (it can no longer replay what we missed),
    // so what we expect next moves to where it says. The caller learns of the loss from the frame.
    if (header.kind === FrameKind.reset) this.nextSequencedOffset = header.offset;
    return { kind: header.kind, sequenced, offset: header.offset, json, raw, byteLength };
  }
}
