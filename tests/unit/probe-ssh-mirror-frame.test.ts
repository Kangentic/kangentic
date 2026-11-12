/**
 * The #913 mirror link's framing (scripts/probe-ssh-mirror-host.mjs). Down the link a frame opens with
 * a magic and carries a CRC of its payload; up the link there is no magic. Importing the module must
 * start nothing: the modes only run when it is the entry script.
 */
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { encodeFrame, FrameReader, FRAME_MAGIC } from '../../scripts/probe-ssh-mirror-host.mjs';

interface ReceivedFrame {
  header: Record<string, unknown>;
  raw: Buffer;
}

/** The local-to-host direction: u32 BE length of the rest, u32 BE header length, header JSON, raw bytes. */
function buildInbound(header: Record<string, unknown>, raw: Buffer): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header));
  const lengthPrefix = Buffer.alloc(8);
  lengthPrefix.writeUInt32BE(4 + headerBytes.length + raw.length, 0);
  lengthPrefix.writeUInt32BE(headerBytes.length, 4);
  return Buffer.concat([lengthPrefix, headerBytes, raw]);
}

function collect(): { reader: InstanceType<typeof FrameReader>; frames: ReceivedFrame[] } {
  const frames: ReceivedFrame[] = [];
  const reader = new FrameReader((header: Record<string, unknown>, raw: Buffer) => {
    frames.push({ header, raw: Buffer.from(raw) });
  });
  return { reader, frames };
}

describe('encodeFrame', () => {
  it('opens with the magic, then the length of the rest, then the header length', () => {
    const payload = Buffer.from('hello world');
    const { prefix, headerBytes } = encodeFrame({ type: 'data', path: 'a.jsonl' }, payload);
    expect(FRAME_MAGIC).toBe(0x4b4d4631);
    expect(prefix.length).toBe(12);
    expect(prefix.readUInt32BE(0)).toBe(0x4b4d4631);
    expect(prefix.readUInt32BE(4)).toBe(4 + headerBytes.length + payload.length);
    expect(prefix.readUInt32BE(8)).toBe(headerBytes.length);
  });

  it('carries the CRC32 of the payload in the header, next to the caller fields', () => {
    const payload = Buffer.from('hello world');
    const { headerBytes, payload: returned } = encodeFrame({ type: 'data', so: 5 }, payload);
    const header = JSON.parse(headerBytes.toString('utf8'));
    expect(header).toEqual({ type: 'data', so: 5, crc: zlib.crc32(payload) });
    expect(header.crc).not.toBe(0);
    expect(returned).toBe(payload);
  });

  it('gives a different CRC when the payload differs', () => {
    const first = JSON.parse(encodeFrame({}, Buffer.from('aaaa')).headerBytes.toString('utf8'));
    const second = JSON.parse(encodeFrame({}, Buffer.from('aaab')).headerBytes.toString('utf8'));
    expect(first.crc).not.toBe(second.crc);
  });

  it('treats a missing payload as zero bytes with the CRC of nothing', () => {
    const { prefix, headerBytes, payload } = encodeFrame({ type: 'ping' });
    expect(payload.length).toBe(0);
    expect(prefix.readUInt32BE(4)).toBe(4 + headerBytes.length);
    expect(JSON.parse(headerBytes.toString('utf8')).crc).toBe(zlib.crc32(Buffer.alloc(0)));
  });
});

describe('FrameReader', () => {
  const header = { type: 'ack', bytes: 4096 };
  const raw = Buffer.from('payload bytes é with a non-ASCII tail');

  it('delivers one frame that arrives in one push', () => {
    const { reader, frames } = collect();
    reader.push(buildInbound(header, raw));
    expect(frames).toHaveLength(1);
    expect(frames[0].header).toEqual(header);
    expect(frames[0].raw.equals(raw)).toBe(true);
  });

  it('delivers a frame with no raw bytes', () => {
    const { reader, frames } = collect();
    reader.push(buildInbound(header, Buffer.alloc(0)));
    expect(frames).toHaveLength(1);
    expect(frames[0].raw.length).toBe(0);
  });

  it('delivers exactly one intact frame when it is split into two chunks at every byte offset', () => {
    const whole = buildInbound(header, raw);
    for (let offset = 0; offset <= whole.length; offset += 1) {
      const { reader, frames } = collect();
      reader.push(whole.subarray(0, offset));
      reader.push(whole.subarray(offset));
      expect(frames, `split at ${offset}`).toHaveLength(1);
      expect(frames[0].header).toEqual(header);
      expect(frames[0].raw.equals(raw)).toBe(true);
    }
  });

  it('delivers the frame when it arrives one byte at a time, and only at the last byte', () => {
    const whole = buildInbound(header, raw);
    const { reader, frames } = collect();
    for (let index = 0; index < whole.length - 1; index += 1) {
      reader.push(whole.subarray(index, index + 1));
      expect(frames).toHaveLength(0);
    }
    reader.push(whole.subarray(whole.length - 1));
    expect(frames).toHaveLength(1);
    expect(frames[0].raw.equals(raw)).toBe(true);
  });

  it('delivers two frames that arrive in one push, in order', () => {
    const secondHeader = { type: 'ack', bytes: 8192 };
    const secondRaw = Buffer.from('second');
    const { reader, frames } = collect();
    reader.push(Buffer.concat([buildInbound(header, raw), buildInbound(secondHeader, secondRaw)]));
    expect(frames).toHaveLength(2);
    expect(frames[0].header).toEqual(header);
    expect(frames[0].raw.equals(raw)).toBe(true);
    expect(frames[1].header).toEqual(secondHeader);
    expect(frames[1].raw.equals(secondRaw)).toBe(true);
  });

  it('keeps the start of a second frame buffered until the rest of it arrives', () => {
    const secondHeader = { type: 'ack', bytes: 1 };
    const secondRaw = Buffer.from('tail');
    const second = buildInbound(secondHeader, secondRaw);
    const { reader, frames } = collect();
    reader.push(Buffer.concat([buildInbound(header, raw), second.subarray(0, 6)]));
    expect(frames).toHaveLength(1);
    reader.push(second.subarray(6));
    expect(frames).toHaveLength(2);
    expect(frames[1].header).toEqual(secondHeader);
    expect(frames[1].raw.equals(secondRaw)).toBe(true);
  });

  it('delivers nothing for a truncated frame until the rest arrives', () => {
    const whole = buildInbound(header, raw);
    const { reader, frames } = collect();
    reader.push(whole.subarray(0, whole.length - 1));
    expect(frames).toHaveLength(0);
    reader.push(Buffer.alloc(0));
    expect(frames).toHaveLength(0);
    reader.push(whole.subarray(whole.length - 1));
    expect(frames).toHaveLength(1);
    expect(frames[0].raw.equals(raw)).toBe(true);
  });
});
