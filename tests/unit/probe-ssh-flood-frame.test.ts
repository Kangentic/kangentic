/**
 * The #913 flood probe's frame header (scripts/probe-ssh-flood-host.mjs). The client and the host
 * each hold a copy of the layout, so a drift in byte order or width shows up as garbled sessions.
 * Importing the module must start nothing: the host only runs when it is the entry script.
 */
import { describe, it, expect } from 'vitest';
import { encodeFrame, FRAME_HEADER_BYTES, FrameType } from '../../scripts/probe-ssh-flood-host.mjs';

describe('flood frame encoding', () => {
  it('writes u32 BE payload length, u32 BE session id, u8 type, then the payload', () => {
    const frame = encodeFrame(0x01020304, FrameType.keystroke, Buffer.from('abc'));
    expect(frame.toString('hex')).toBe(['00000003', '01020304', '03', '616263'].join(''));
  });

  it('sizes the header at 9 bytes and sends an empty payload as the header alone', () => {
    expect(FRAME_HEADER_BYTES).toBe(9);
    const frame = encodeFrame(7, FrameType.stop, Buffer.alloc(0));
    expect(frame.length).toBe(9);
    expect(frame.toString('hex')).toBe('000000000000000705');
  });

  it('keeps a length wider than one byte big-endian', () => {
    const frame = encodeFrame(0xfffffffe, FrameType.data, Buffer.alloc(0x0102));
    expect(frame.length).toBe(9 + 0x0102);
    expect(frame.subarray(0, 9).toString('hex')).toBe('00000102' + 'fffffffe' + '12');
  });

  it('pins the numeric value of every frame type', () => {
    expect({ ...FrameType }).toEqual({
      config: 1,
      open: 2,
      keystroke: 3,
      credit: 4,
      stop: 5,
      ready: 16,
      echo: 17,
      data: 18,
      stats: 19,
    });
    expect(Object.isFrozen(FrameType)).toBe(true);
  });
});
