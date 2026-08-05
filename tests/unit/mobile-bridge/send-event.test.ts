/**
 * Unit tests for sendEvent (src/main/mobile-bridge/handlers/send-event.ts).
 *
 * sendEvent's try/catch used to swallow every BridgeSession.sendMessage
 * failure uniformly - both a routine torn-down-session throw (expected any
 * time a session outlives its last listener callback) and an oversize-frame
 * throw from encodeMessage (packages/protocol/src/wire/framing.ts), which is
 * NOT routine: retrying resends the same over-budget payload, and the phone
 * has no other signal that the event was dropped. It now distinguishes the
 * two by matching the encode/size throw's message prefix and warns only for
 * that case, staying silent for every other throw.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { BridgeEvent } from '@kangentic/protocol';
import { encodeMessage, MAX_DECODED_LENGTH, MAX_FRAME_LENGTH } from '@kangentic/protocol';
import { ENCODE_SIZE_ERROR_PREFIX, sendEvent } from '../../../src/main/mobile-bridge/handlers/send-event';
import type { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';

function fakeSession(overrides: { isEstablished?: boolean; sendMessage?: ReturnType<typeof vi.fn> } = {}): BridgeSession {
  return {
    isEstablished: overrides.isEstablished ?? true,
    sendMessage: overrides.sendMessage ?? vi.fn(),
  } as unknown as BridgeSession;
}

const diffEvent: BridgeEvent = { kind: 'diff', taskId: 'task-1', payload: null };

describe('sendEvent', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does not send or warn when the session is not established', () => {
    const sendMessage = vi.fn();
    const session = fakeSession({ isEstablished: false, sendMessage });

    sendEvent(session, diffEvent);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('sends the event and does not warn on a successful send', () => {
    const sendMessage = vi.fn();
    const session = fakeSession({ sendMessage });

    sendEvent(session, diffEvent);

    expect(sendMessage).toHaveBeenCalledWith({ type: 'event', event: diffEvent });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when sendMessage throws an encode/size-cap error (framing.ts prefix)', () => {
    // Mirrors framing.ts's two throws verbatim: `Encoded bridge message
    // exceeds ${MAX_DECODED_LENGTH} bytes before compression` and
    // `Encoded bridge message exceeds ${MAX_FRAME_LENGTH} bytes`.
    const sendMessage = vi.fn(() => {
      throw new Error('Encoded bridge message exceeds 1048576 bytes before compression');
    });
    const session = fakeSession({ sendMessage });

    expect(() => sendEvent(session, diffEvent)).not.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as unknown[];
    expect(String(message)).toContain('dropped oversize');
    expect(String(message)).toContain(diffEvent.kind);
  });

  it('stays silent for a routine send failure (e.g. a torn-down session)', () => {
    const sendMessage = vi.fn(() => {
      throw new Error('BridgeSession is disposed');
    });
    const session = fakeSession({ sendMessage });

    expect(() => sendEvent(session, diffEvent)).not.toThrow();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/**
 * The tests above throw hand-typed message strings from a mocked sendMessage,
 * which pins sendEvent's own matching logic but NOT the cross-package coupling
 * it depends on: `ENCODE_SIZE_ERROR_PREFIX` has to stay byte-for-byte in sync
 * with two throw sites in `@kangentic/protocol`, a package versioned and
 * published on its own cadence (see .claude/rules/protocol-release-parity.md).
 * Reword either throw over there and the oversize warn silently stops firing
 * in production while every test in this file keeps passing, because both
 * copies of the literal drift together.
 *
 * These cases close that by driving the REAL `encodeMessage` past each of its
 * two caps and asserting the message it actually throws is one sendEvent would
 * still recognize. Deliberately asserting against the prefix CONSTANT rather
 * than a literal: the point is to pin the relationship, not to restate the
 * string a third time.
 */
describe('ENCODE_SIZE_ERROR_PREFIX matches what @kangentic/protocol actually throws', () => {
  it('matches the pre-compression cap throw (MAX_DECODED_LENGTH)', () => {
    // The cap is checked on the raw JSON before any deflate, so a plain
    // repeated string is enough to trip it - compressibility is irrelevant here.
    const oversizeEvent = { kind: 'diff', taskId: 'task-1', payload: 'x'.repeat(MAX_DECODED_LENGTH + 1024) } as unknown as BridgeEvent;

    expect(() => encodeMessage({ type: 'event', event: oversizeEvent })).toThrowError(
      expect.objectContaining({ message: expect.stringContaining(ENCODE_SIZE_ERROR_PREFIX) }),
    );
  });

  it('matches the post-compression frame cap throw (MAX_FRAME_LENGTH)', () => {
    // This is the cap that actually binds in production (1 MiB frame vs 4 MiB
    // JSON), so it needs its own case. It only trips on data deflate cannot
    // shrink below the frame cap, hence the seeded PRNG: a repeated string
    // would compress to a few hundred bytes and encode cleanly.
    //
    // xorshift32 via Math.imul-free 32-bit ops, not an LCG: a textbook LCG's
    // low bits cycle with a very short period, and `state % 64` reads exactly
    // those - the resulting string is visibly periodic and deflate crushes it
    // well under the cap (observed: this test failed to throw at all). Seeded
    // and integer-only, so it produces identical bytes on every platform and
    // run - no Math.random, nothing for CI to disagree with local Windows about.
    let randomState = 0x9e3779b9;
    const nextRandom = (): number => {
      randomState ^= randomState << 13;
      randomState >>>= 0;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      randomState >>>= 0;
      return randomState;
    };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    // 2x the frame cap: a 64-symbol alphabet carries 6 bits per char, so deflate
    // can legitimately shrink this to ~75%. Twice the cap still lands ~1.5 MiB,
    // comfortably over, rather than hugging the boundary.
    const incompressible = Array.from({ length: MAX_FRAME_LENGTH * 2 }, () => alphabet[(nextRandom() >>> 8) % alphabet.length]).join('');
    const oversizeEvent = { kind: 'diff', taskId: 'task-1', payload: incompressible } as unknown as BridgeEvent;

    // Guards the premise: if this payload ever became small enough to encode,
    // the assertion below would pass vacuously by never running the throw.
    expect(incompressible.length).toBeGreaterThan(MAX_FRAME_LENGTH);
    expect(incompressible.length).toBeLessThan(MAX_DECODED_LENGTH);

    expect(() => encodeMessage({ type: 'event', event: oversizeEvent })).toThrowError(
      expect.objectContaining({ message: expect.stringContaining(ENCODE_SIZE_ERROR_PREFIX) }),
    );
  });
});
