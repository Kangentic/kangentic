import { describe, expect, it } from 'vitest';
import { SessionFrameKind, unwrapSessionFrame, wrapSessionFrame } from '../../../packages/protocol/src/wire/session-frame';

describe('session frame prefix', () => {
  it('round-trips a handshake frame', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const wrapped = wrapSessionFrame(SessionFrameKind.Handshake, payload);
    const { kind, payload: unwrapped } = unwrapSessionFrame(wrapped);
    expect(kind).toBe(SessionFrameKind.Handshake);
    expect(Array.from(unwrapped)).toEqual(Array.from(payload));
  });

  it('round-trips an application frame', () => {
    const payload = new Uint8Array([9, 8, 7]);
    const wrapped = wrapSessionFrame(SessionFrameKind.Application, payload);
    const { kind, payload: unwrapped } = unwrapSessionFrame(wrapped);
    expect(kind).toBe(SessionFrameKind.Application);
    expect(Array.from(unwrapped)).toEqual(Array.from(payload));
  });

  it('handles an empty payload', () => {
    const wrapped = wrapSessionFrame(SessionFrameKind.Application, new Uint8Array(0));
    const { payload } = unwrapSessionFrame(wrapped);
    expect(payload.length).toBe(0);
  });

  it('rejects an empty frame (no kind byte)', () => {
    expect(() => unwrapSessionFrame(new Uint8Array(0))).toThrow();
  });

  it('rejects an unknown kind byte', () => {
    expect(() => unwrapSessionFrame(new Uint8Array([99, 1, 2]))).toThrow();
  });
});
