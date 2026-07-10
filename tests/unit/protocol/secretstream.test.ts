import { describe, expect, it } from 'vitest';
import { randomBytes } from '../../../packages/protocol/src/crypto/primitives';
import { deriveSecretstreamPair, FrameTag, SecretstreamState } from '../../../packages/protocol/src/crypto/secretstream';

describe('secretstream framing', () => {
  it('round-trips a sequence of frames in order', () => {
    const chainingKey = randomBytes(32);
    const initiator = deriveSecretstreamPair(chainingKey, true);
    const responder = deriveSecretstreamPair(chainingKey, false);

    for (const text of ['first', 'second', 'third']) {
      const frame = initiator.send.seal(new TextEncoder().encode(text));
      const { tag, plaintext } = responder.receive.open(frame);
      expect(tag).toBe(FrameTag.Message);
      expect(new TextDecoder().decode(plaintext)).toBe(text);
    }
  });

  it('derives matching key material for both peers from the same chaining key', () => {
    const chainingKey = randomBytes(32);
    const initiator = deriveSecretstreamPair(chainingKey, true);
    const responder = deriveSecretstreamPair(chainingKey, false);

    const fromInitiator = initiator.send.seal(new TextEncoder().encode('hello'));
    expect(() => responder.receive.open(fromInitiator)).not.toThrow();

    const fromResponder = responder.send.seal(new TextEncoder().encode('hi back'));
    expect(() => initiator.receive.open(fromResponder)).not.toThrow();
  });

  it('rejects a tampered frame', () => {
    const chainingKey = randomBytes(32);
    const initiator = deriveSecretstreamPair(chainingKey, true);
    const responder = deriveSecretstreamPair(chainingKey, false);

    const frame = initiator.send.seal(new TextEncoder().encode('payload'));
    const tampered = new Uint8Array(frame);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => responder.receive.open(tampered)).toThrow();
  });

  it('rejects a replayed frame (same frame processed twice)', () => {
    const chainingKey = randomBytes(32);
    const initiator = deriveSecretstreamPair(chainingKey, true);
    const responder = deriveSecretstreamPair(chainingKey, false);

    const frame = initiator.send.seal(new TextEncoder().encode('payload'));
    responder.receive.open(frame);
    // The receiver's counter has already advanced past this frame's nonce;
    // replaying it fails to authenticate against the now-current counter.
    expect(() => responder.receive.open(frame)).toThrow();
  });

  it('rejects an out-of-order frame (a gap causes the wrong nonce to be derived)', () => {
    const chainingKey = randomBytes(32);
    const initiator = deriveSecretstreamPair(chainingKey, true);
    const responder = deriveSecretstreamPair(chainingKey, false);

    const frame1 = initiator.send.seal(new TextEncoder().encode('one'));
    const frame2 = initiator.send.seal(new TextEncoder().encode('two'));
    // Skip frame1 entirely; hand the receiver frame2 first.
    expect(() => responder.receive.open(frame2)).toThrow();
    void frame1;
  });

  it('rekey() rotates the key so a frame sealed under the old key no longer opens', () => {
    const key = randomBytes(32);
    const nonceHeader = randomBytes(24);
    const sender = new SecretstreamState(key, nonceHeader);
    const receiverBeforeRekey = new SecretstreamState(key, nonceHeader);
    const receiverAfterRekey = new SecretstreamState(key, nonceHeader);
    receiverAfterRekey.rekey();

    sender.rekey();
    const frame = sender.seal(new TextEncoder().encode('post-rekey'));

    expect(() => receiverBeforeRekey.open(frame)).toThrow();
    const { plaintext } = receiverAfterRekey.open(frame);
    expect(new TextDecoder().decode(plaintext)).toBe('post-rekey');
  });

  it('carries the FINAL tag so a receiver can distinguish a clean close from a truncation', () => {
    const chainingKey = randomBytes(32);
    const initiator = deriveSecretstreamPair(chainingKey, true);
    const responder = deriveSecretstreamPair(chainingKey, false);

    const frame = initiator.send.seal(new Uint8Array(0), FrameTag.Final);
    const { tag } = responder.receive.open(frame);
    expect(tag).toBe(FrameTag.Final);
  });
});
