/**
 * The frame format between the SSH link and the host helper (#913). A frame must be
 * self-checking, because System32's ssh.exe lost 65 to 97 KB in the middle of a stream
 * in the Phase 0 mirror runs: a frame straddling the loss may never be applied corrupted.
 */
import { describe, it, expect } from 'vitest';
import { crc32 } from 'node:zlib';
import {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FrameDecoder,
  FrameError,
  FrameKind,
  MAX_FRAME_JSON_BYTES,
  MAX_FRAME_RAW_BYTES,
  encodeFrame,
  isSequencedKind,
  type DecodedFrame,
} from '../../src/main/remote/protocol/frame-codec';

function decodeAll(bytes: Uint8Array, options?: { expectedOffset?: number }): DecodedFrame[] {
  return new FrameDecoder(options).push(bytes);
}

function expectFrameError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FrameError);
    expect((error as FrameError).code).toBe(code);
    return;
  }
  throw new Error(`expected a FrameError with code ${code}`);
}

describe('frame layout', () => {
  it('writes the magic, kind, lengths, offset and both checksums at the documented places', () => {
    const frame = encodeFrame({ kind: FrameKind.message, offset: 0x0102030405, json: { a: 1 }, raw: Buffer.from('xyz') });
    const json = Buffer.from('{"a":1}');
    expect(frame.length).toBe(FRAME_HEADER_BYTES + json.length + 3);
    expect(frame.readUInt32BE(0)).toBe(FRAME_MAGIC);
    expect(frame.subarray(0, 4).toString('latin1')).toBe('KGF1');
    expect(frame.readUInt8(4)).toBe(0x81);
    expect(frame.readUInt8(5)).toBe(0);
    expect(frame.readUInt16BE(6)).toBe(0);
    expect(frame.readUInt32BE(8)).toBe(json.length);
    expect(frame.readUInt32BE(12)).toBe(3);
    expect(frame.readUInt32BE(16)).toBe(0x01);
    expect(frame.readUInt32BE(20)).toBe(0x02030405);
    expect(frame.readUInt32BE(24)).toBe(crc32(frame.subarray(FRAME_HEADER_BYTES)));
    expect(frame.readUInt32BE(28)).toBe(crc32(frame.subarray(0, 28)));
  });

  it('pins the numeric value of every frame kind and which are sequenced', () => {
    expect({ ...FrameKind }).toEqual({ hello: 1, ack: 2, heartbeat: 3, reset: 4, close: 5, message: 0x81 });
    expect(Object.isFrozen(FrameKind)).toBe(true);
    expect(isSequencedKind(FrameKind.message)).toBe(true);
    expect(isSequencedKind(FrameKind.hello)).toBe(false);
    expect(isSequencedKind(FrameKind.ack)).toBe(false);
    expect(isSequencedKind(FrameKind.heartbeat)).toBe(false);
  });

  it('sends a frame with no body as the header alone', () => {
    const frame = encodeFrame({ kind: FrameKind.heartbeat, offset: 0 });
    expect(frame.length).toBe(FRAME_HEADER_BYTES);
    const [decoded] = decodeAll(frame);
    expect(decoded.json).toBeUndefined();
    expect(decoded.raw.length).toBe(0);
  });

  it('carries an offset past 2^32', () => {
    const offset = 5 * 0x1_0000_0000 + 17;
    const [decoded] = decodeAll(encodeFrame({ kind: FrameKind.ack, offset }));
    expect(decoded.offset).toBe(offset);
  });

  it('rejects a body over the limits and a kind or offset that does not fit', () => {
    expect(() => encodeFrame({ kind: FrameKind.message, offset: 0, raw: Buffer.alloc(MAX_FRAME_RAW_BYTES + 1) })).toThrow(RangeError);
    expect(() => encodeFrame({ kind: FrameKind.message, offset: 0, json: 'x'.repeat(MAX_FRAME_JSON_BYTES) })).toThrow(RangeError);
    expect(() => encodeFrame({ kind: 256, offset: 0 })).toThrow(RangeError);
    expect(() => encodeFrame({ kind: 1, offset: -1 })).toThrow(RangeError);
    expect(() => encodeFrame({ kind: 1, offset: 1.5 })).toThrow(RangeError);
  });
});

describe('decoding', () => {
  it('round-trips JSON and raw bytes, with every byte value surviving in the raw part', () => {
    const raw = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const [decoded] = decodeAll(encodeFrame({ kind: FrameKind.message, offset: 0, json: { type: 'event', n: [1, 2] }, raw }));
    expect(decoded.json).toEqual({ type: 'event', n: [1, 2] });
    expect(decoded.raw.equals(raw)).toBe(true);
    expect(decoded.sequenced).toBe(true);
  });

  it('decodes a frame delivered one byte at a time', () => {
    const frame = encodeFrame({ kind: FrameKind.message, offset: 0, json: { ok: true }, raw: Buffer.from('hello') });
    const decoder = new FrameDecoder();
    const seen: DecodedFrame[] = [];
    for (const byte of frame) seen.push(...decoder.push(Uint8Array.of(byte)));
    expect(seen).toHaveLength(1);
    expect(seen[0].raw.toString()).toBe('hello');
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('decodes several frames delivered in one chunk, and a frame split across chunks', () => {
    const first = encodeFrame({ kind: FrameKind.message, offset: 0, raw: Buffer.from('one') });
    const second = encodeFrame({ kind: FrameKind.message, offset: first.length, raw: Buffer.from('two') });
    const third = encodeFrame({ kind: FrameKind.message, offset: first.length + second.length, raw: Buffer.from('three') });
    const decoder = new FrameDecoder();
    const stream = Buffer.concat([first, second, third]);
    expect(decoder.push(stream.subarray(0, first.length + 5)).map((frame) => frame.raw.toString())).toEqual(['one']);
    expect(decoder.push(stream.subarray(first.length + 5)).map((frame) => frame.raw.toString())).toEqual(['two', 'three']);
    expect(decoder.nextOffset).toBe(stream.length);
  });

  it('hands out a copy of the raw part, so a later chunk cannot change it', () => {
    const shared = Buffer.from(encodeFrame({ kind: FrameKind.message, offset: 0, raw: Buffer.from('abc') }));
    const [decoded] = decodeAll(shared);
    shared.fill(0);
    expect(decoded.raw.toString()).toBe('abc');
  });

  it('does not count control frames toward the sequenced offset', () => {
    const hello = encodeFrame({ kind: FrameKind.hello, offset: 99, json: { protocol: 1 } });
    const message = encodeFrame({ kind: FrameKind.message, offset: 0, raw: Buffer.from('a') });
    const decoder = new FrameDecoder();
    const frames = decoder.push(Buffer.concat([hello, message]));
    expect(frames.map((frame) => frame.sequenced)).toEqual([false, true]);
    expect(frames[0].offset).toBe(99);
    expect(decoder.nextOffset).toBe(message.length);
  });

  it('starts at the offset a resume asked for', () => {
    const frame = encodeFrame({ kind: FrameKind.message, offset: 4096, raw: Buffer.from('x') });
    expect(decodeAll(frame, { expectedOffset: 4096 })).toHaveLength(1);
    expectFrameError(() => decodeAll(frame), 'offset-gap');
  });

  it('moves what it expects next to the offset a reset names, and holds the sender to it', () => {
    const decoder = new FrameDecoder();
    const reset = encodeFrame({ kind: FrameKind.reset, offset: 5000, json: { reason: 'retention' } });
    const after = encodeFrame({ kind: FrameKind.message, offset: 5000, raw: Buffer.from('later') });
    const frames = decoder.push(Buffer.concat([reset, after]));
    expect(frames.map((frame) => frame.kind)).toEqual([FrameKind.reset, FrameKind.message]);
    expect(decoder.nextOffset).toBe(5000 + after.length);
    const stale = encodeFrame({ kind: FrameKind.message, offset: 0, raw: Buffer.from('old') });
    expectFrameError(() => decoder.push(stale), 'offset-gap');
  });

  it('skips a well-formed frame of an unknown kind and still counts a sequenced one', () => {
    const unknownControl = encodeFrame({ kind: 0x7e, offset: 0, json: { whatever: 1 } });
    const unknownSequenced = encodeFrame({ kind: 0xfe, offset: 0, json: { future: true } });
    const after = encodeFrame({ kind: FrameKind.message, offset: unknownSequenced.length, raw: Buffer.from('ok') });
    const frames = decodeAll(Buffer.concat([unknownControl, unknownSequenced, after]));
    expect(frames.map((frame) => frame.kind)).toEqual([0x7e, 0xfe, 0x81]);
    expect(frames.map((frame) => frame.sequenced)).toEqual([false, true, true]);
  });
});

describe('damage', () => {
  it('refuses a stream that does not start with the magic', () => {
    const frame = Buffer.from(encodeFrame({ kind: FrameKind.message, offset: 0 }));
    frame[0] ^= 0xff;
    expectFrameError(() => decodeAll(frame), 'bad-magic');
  });

  it('refuses a damaged header as soon as the header is in, before any body arrives', () => {
    const frame = Buffer.from(encodeFrame({ kind: FrameKind.message, offset: 0, raw: Buffer.alloc(1000, 7) }));
    frame[13] ^= 0x01;
    expectFrameError(() => new FrameDecoder().push(frame.subarray(0, FRAME_HEADER_BYTES)), 'bad-header-crc');
  });

  it('refuses a body whose checksum fails', () => {
    const frame = Buffer.from(encodeFrame({ kind: FrameKind.message, offset: 0, raw: Buffer.from('payload') }));
    frame[FRAME_HEADER_BYTES + 2] ^= 0x20;
    expectFrameError(() => decodeAll(frame), 'bad-payload-crc');
  });

  it('refuses a length over the limits without waiting for that many bytes', () => {
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32BE(FRAME_MAGIC, 0);
    header.writeUInt8(FrameKind.message, 4);
    header.writeUInt32BE(MAX_FRAME_RAW_BYTES + 1, 12);
    header.writeUInt32BE(crc32(header.subarray(0, 28)), 28);
    expectFrameError(() => new FrameDecoder().push(header), 'too-large');
  });

  it('refuses a sequenced frame that skips ahead or repeats', () => {
    const first = encodeFrame({ kind: FrameKind.message, offset: 0, raw: Buffer.from('a') });
    const skipped = encodeFrame({ kind: FrameKind.message, offset: first.length + 1, raw: Buffer.from('b') });
    expectFrameError(() => decodeAll(Buffer.concat([first, skipped])), 'offset-gap');
    expectFrameError(() => decodeAll(Buffer.concat([first, first])), 'offset-gap');
  });

  it('refuses a JSON body that does not parse, even with a good checksum', () => {
    const frame = Buffer.from(encodeFrame({ kind: FrameKind.message, offset: 0, json: { a: 1 } }));
    frame[FRAME_HEADER_BYTES] = 0x7b + 1;
    frame.writeUInt32BE(crc32(frame.subarray(FRAME_HEADER_BYTES)), 24);
    frame.writeUInt32BE(crc32(frame.subarray(0, 28)), 28);
    expectFrameError(() => decodeAll(frame), 'bad-json');
  });

  it('stays failed after an error', () => {
    const decoder = new FrameDecoder();
    const bad = Buffer.from(encodeFrame({ kind: FrameKind.message, offset: 0 }));
    bad[0] ^= 0xff;
    expectFrameError(() => decoder.push(bad), 'bad-magic');
    const good = encodeFrame({ kind: FrameKind.message, offset: 0 });
    expectFrameError(() => decoder.push(good), 'bad-magic');
  });

  it('never applies a frame from a stream that lost bytes in the middle', () => {
    // The Phase 0 loss: tens of kilobytes gone from the middle of a stream. Sweep where it
    // starts and how much goes, against frames of mixed sizes, and demand a clean refusal
    // or a clean stop, never a delivered frame whose bytes are not the ones that were sent.
    const sent: Buffer[] = [];
    const frames: Buffer[] = [];
    let offset = 0;
    for (let index = 0; index < 24; index += 1) {
      const raw = Buffer.alloc(200 + ((index * 7919) % 9000), index);
      sent.push(raw);
      const frame = encodeFrame({ kind: FrameKind.message, offset, json: { index }, raw });
      frames.push(frame);
      offset += frame.length;
    }
    const stream = Buffer.concat(frames);
    let refusals = 0;
    for (let start = 1; start < stream.length - 1; start += 997) {
      for (const lost of [1, 7, 31, 32, 33, 500, 65_536]) {
        const damaged = Buffer.concat([stream.subarray(0, start), stream.subarray(Math.min(stream.length, start + lost))]);
        const decoder = new FrameDecoder();
        let delivered: DecodedFrame[] = [];
        try {
          delivered = decoder.push(damaged);
        } catch (error) {
          expect(error).toBeInstanceOf(FrameError);
          refusals += 1;
        }
        // Whatever came out before the damage must be exactly what was sent, in order.
        delivered.forEach((frame, position) => {
          expect(frame.raw.equals(sent[position])).toBe(true);
          expect((frame.json as { index: number }).index).toBe(position);
        });
      }
    }
    expect(refusals).toBeGreaterThan(0);
  });
});
