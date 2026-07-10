/**
 * Validates the shared Noise interpreter (HandshakeState + SymmetricState +
 * CipherState) against three independent official test vectors, sourced
 * from the cacophony vector suite (mirrored at
 * https://github.com/mcginty/snow/blob/main/tests/vectors/cacophony.txt):
 *
 *   - Noise_KK_25519_ChaChaPoly_BLAKE2s: the production ongoing-session
 *     pattern. Covers pre-message static mixing on both sides, the
 *     es/se/ss/ee DH combiners, Split(), and post-handshake transport
 *     encryption with the split CipherStates.
 *   - Noise_IK_25519_ChaChaPoly_BLAKE2s: covers the in-message "s" token
 *     (encrypted-with-current-key on write, HasKey()-gated length on
 *     read) that KK never exercises, since KK's statics are pre-messages.
 *   - Noise_NKpsk0_25519_ChaChaPoly_BLAKE2s: covers the "psk" token /
 *     MixKeyAndHash path.
 *
 * Together these three vectors exercise every token type the interpreter
 * supports. The production KK driver (crypto/noise/kk.ts) and pairing
 * driver (crypto/pairing-handshake.ts, pattern IKpsk0) are thin wrappers
 * around the exact same interpreter, combining what these three vectors
 * validate independently (KK's pre-message statics, IK's in-message "s"
 * token, and psk0's MixKeyAndHash) - see noise-pairing.test.ts for
 * dedicated behavioral tests of the pairing driver itself.
 */
import { describe, expect, it } from 'vitest';
import { hexToBytes, x25519PublicKeyFrom, type X25519KeyPair } from '../../../packages/protocol/src/crypto/primitives';
import { HandshakeState } from '../../../packages/protocol/src/crypto/noise/handshake-state';
import { KK_PATTERN, type NoisePattern } from '../../../packages/protocol/src/crypto/noise/patterns';

const IK_PATTERN: NoisePattern = {
  name: 'IK',
  initiatorPreMessage: [],
  responderPreMessage: ['s'],
  messages: [
    ['e', 'es', 's', 'ss'],
    ['e', 'ee', 'se'],
  ],
  usesPsk: false,
};

const NKPSK0_PATTERN: NoisePattern = {
  name: 'NKpsk0',
  initiatorPreMessage: [],
  responderPreMessage: ['s'],
  messages: [
    ['psk', 'e', 'es'],
    ['e', 'ee'],
  ],
  usesPsk: true,
};

function keyPairFromSecretHex(secretHex: string): X25519KeyPair {
  const secretKey = hexToBytes(secretHex);
  return { secretKey, publicKey: x25519PublicKeyFrom(secretKey) };
}

function fixedEphemeral(secretHex: string): () => X25519KeyPair {
  const keyPair = keyPairFromSecretHex(secretHex);
  return () => keyPair;
}

interface VectorSpec {
  pattern: NoisePattern;
  prologueHex: string;
  initStaticHex?: string;
  initEphemeralHex: string;
  initRemoteStaticHex?: string;
  initPskHex?: string;
  respStaticHex?: string;
  respEphemeralHex: string;
  respRemoteStaticHex?: string;
  respPskHex?: string;
  handshakeHashHex: string;
  messages: { payloadHex: string; ciphertextHex: string }[];
}

function runVector(spec: VectorSpec): void {
  const initiator = new HandshakeState({
    pattern: spec.pattern,
    initiator: true,
    prologue: hexToBytes(spec.prologueHex),
    s: spec.initStaticHex ? keyPairFromSecretHex(spec.initStaticHex) : undefined,
    rs: spec.initRemoteStaticHex ? hexToBytes(spec.initRemoteStaticHex) : undefined,
    psk: spec.initPskHex ? hexToBytes(spec.initPskHex) : undefined,
    generateEphemeral: fixedEphemeral(spec.initEphemeralHex),
  });
  const responder = new HandshakeState({
    pattern: spec.pattern,
    initiator: false,
    prologue: hexToBytes(spec.prologueHex),
    s: spec.respStaticHex ? keyPairFromSecretHex(spec.respStaticHex) : undefined,
    rs: spec.respRemoteStaticHex ? hexToBytes(spec.respRemoteStaticHex) : undefined,
    psk: spec.respPskHex ? hexToBytes(spec.respPskHex) : undefined,
    generateEphemeral: fixedEphemeral(spec.respEphemeralHex),
  });

  const handshakeMessageCount = spec.pattern.messages.length;
  // Each side calls split() independently on its own HandshakeState, so
  // these are two distinct pairs of CipherState objects with independent
  // nonce counters - exactly modeling two real, separate peers. Track
  // which pair belongs to which role explicitly rather than assuming an
  // order, since the writer of the LAST handshake message alternates
  // with the pattern's message count.
  let initiatorSplit: NonNullable<ReturnType<HandshakeState['writeMessage']>['split']> | undefined;
  let responderSplit: NonNullable<ReturnType<HandshakeState['writeMessage']>['split']> | undefined;

  for (let i = 0; i < handshakeMessageCount; i++) {
    const { payloadHex, ciphertextHex } = spec.messages[i];
    const initiatorWrites = i % 2 === 0;
    const writer = initiatorWrites ? initiator : responder;
    const reader = initiatorWrites ? responder : initiator;

    const writeResult = writer.writeMessage(hexToBytes(payloadHex));
    expect(Buffer.from(writeResult.message).toString('hex')).toBe(ciphertextHex);

    const readResult = reader.readMessage(hexToBytes(ciphertextHex));
    expect(Buffer.from(readResult.payload).toString('hex')).toBe(payloadHex);

    if (i === handshakeMessageCount - 1) {
      expect(writeResult.split).toBeDefined();
      expect(readResult.split).toBeDefined();
      if (initiatorWrites) {
        initiatorSplit = writeResult.split;
        responderSplit = readResult.split;
      } else {
        responderSplit = writeResult.split;
        initiatorSplit = readResult.split;
      }
    }
  }

  expect(Buffer.from(initiator.getHandshakeHash()).toString('hex')).toBe(spec.handshakeHashHex);
  expect(Buffer.from(responder.getHandshakeHash()).toString('hex')).toBe(spec.handshakeHashHex);

  if (!initiatorSplit || !responderSplit) throw new Error('Split ciphers were not produced');
  // Split() convention (Noise section 5.2): c1 is the initiator's send
  // cipher (and the responder's receive cipher for the same messages);
  // c2 is the reverse. Each side uses its OWN split() result here, as a
  // real peer would.
  const [initiatorSend, initiatorReceive] = initiatorSplit;
  const [responderReceive, responderSend] = responderSplit;

  for (let i = handshakeMessageCount; i < spec.messages.length; i++) {
    const { payloadHex, ciphertextHex } = spec.messages[i];
    const initiatorTurn = i % 2 === 0;
    const sendCipher = initiatorTurn ? initiatorSend : responderSend;
    const receiveCipher = initiatorTurn ? responderReceive : initiatorReceive;

    const ciphertext = sendCipher.encryptWithAd(new Uint8Array(0), hexToBytes(payloadHex));
    expect(Buffer.from(ciphertext).toString('hex')).toBe(ciphertextHex);

    const plaintext = receiveCipher.decryptWithAd(new Uint8Array(0), hexToBytes(ciphertextHex));
    expect(Buffer.from(plaintext).toString('hex')).toBe(payloadHex);
  }
}

describe('Noise interpreter vs official test vectors', () => {
  it('Noise_KK_25519_ChaChaPoly_BLAKE2s', () => {
    runVector({
      pattern: KK_PATTERN,
      prologueHex: '4a6f686e2047616c74',
      initStaticHex: 'e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1',
      initEphemeralHex: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
      initRemoteStaticHex: '31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62',
      respStaticHex: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
      respEphemeralHex: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
      respRemoteStaticHex: '6bc3822a2aa7f4e6981d6538692b3cdf3e6df9eea6ed269eb41d93c22757b75a',
      handshakeHashHex: '1362b8627a00907ce11e558aba8ce7cbca88e83f0e84ce7db5159b1c3e25ab59',
      messages: [
        { payloadHex: '4c756477696720766f6e204d69736573', ciphertextHex: 'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944266a5f53784aa3becb0f7485c2759c328937867a4cbaafef07422b0725e098be' },
        { payloadHex: '4d757272617920526f746862617264', ciphertextHex: '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843008aeea5d76d6abcbab87a18502c8a8352d9933ac11e2a7d228038d721e31e' },
        { payloadHex: '462e20412e20486179656b', ciphertextHex: '5f92113edf78c3e56e6d67201f5f9e0c8f2930c3e1ffb64ede0358' },
        { payloadHex: '4361726c204d656e676572', ciphertextHex: '30ebbd9cdcef7f40d99c8cd11e880dac28f5c9e5032c1059b3b56a' },
        { payloadHex: '4a65616e2d426170746973746520536179', ciphertextHex: 'b011620dc31f88abd1788db50912952fe45da56e9d0907ab2cbce5f609b58b1cf2' },
        { payloadHex: '457567656e2042f6686d20766f6e2042617765726b', ciphertextHex: 'a0661971e9047b28a815c7b1f62fefb471e4d34bc2a5b48149e7f80c3772b8e4aae8b44baa' },
      ],
    });
  });

  it('Noise_IK_25519_ChaChaPoly_BLAKE2s', () => {
    runVector({
      pattern: IK_PATTERN,
      prologueHex: '4a6f686e2047616c74',
      initStaticHex: 'e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1',
      initEphemeralHex: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
      initRemoteStaticHex: '31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62',
      respStaticHex: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
      respEphemeralHex: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
      handshakeHashHex: '48f3cb8bc9319da4ba1e9933991b1c4ed4034f1f126a76d3a1fbcfd7f94248d4',
      messages: [
        { payloadHex: '4c756477696720766f6e204d69736573', ciphertextHex: 'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79440b03ddc7aac5123d06a1b23b71670e32e76c28239a7ca4ac8f784de7e44c1adbfc6e83fef7352a58d9d56157400c0a737b1d171ce368229c7b752ac25b8faf4eca690f6d896f543be02c996ab2b86b76' },
        { payloadHex: '4d757272617920526f746862617264', ciphertextHex: '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843d9b5a8927f0ac9655ef76833bc7e5561f42e691ac8404efd6fbd6308b6a27c' },
        { payloadHex: '462e20412e20486179656b', ciphertextHex: '2c256ed08fcd08c2980f954ee4beaccb61c9581340f5dd2fd1cf3b' },
        { payloadHex: '4361726c204d656e676572', ciphertextHex: 'd6033f70eee20945c7c9dba304e397ee3b284ff5e00fd9efb095d3' },
        { payloadHex: '4a65616e2d426170746973746520536179', ciphertextHex: 'a9c068ca5d8babf72560652d8e851adbfac35c8a66e810d560863173e96adf4cfe' },
        { payloadHex: '457567656e2042f6686d20766f6e2042617765726b', ciphertextHex: '2a09d8f459e5927e40fdd2eddc99bdafb04e13a26f145cb5cfe9e6ba34c94331ebc17d5156' },
      ],
    });
  });

  it('Noise_NKpsk0_25519_ChaChaPoly_BLAKE2s', () => {
    const psk = '54686973206973206d7920417573747269616e20706572737065637469766521';
    runVector({
      pattern: NKPSK0_PATTERN,
      prologueHex: '4a6f686e2047616c74',
      initPskHex: psk,
      initEphemeralHex: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
      initRemoteStaticHex: '31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62',
      respPskHex: psk,
      respStaticHex: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
      respEphemeralHex: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
      handshakeHashHex: '6bd69bd4066f41f32e47134976f5bf01606f7a4a0e04369fe61158b06f3a144e',
      messages: [
        { payloadHex: '4c756477696720766f6e204d69736573', ciphertextHex: 'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c794427635ede06947b2d3acd77a36788aaaf17e9f5a8ac252e560fb421ba161a2cf8' },
        { payloadHex: '4d757272617920526f746862617264', ciphertextHex: '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843d682eb9cf4fee6816c8c8cfd34c15774321e234e3a426d7cfd3f13e5e84d04' },
        { payloadHex: '462e20412e20486179656b', ciphertextHex: 'b6645684db57679aa08f0b3352d58f32ec7f1e1a02083d5bd54277' },
        { payloadHex: '4361726c204d656e676572', ciphertextHex: '473a9a4109eba0939e934640d318984df8d0900aa922f0195a09ad' },
        { payloadHex: '4a65616e2d426170746973746520536179', ciphertextHex: 'c8c44a16fff728f83e61272382149feadd3eb0ee1bab6313f84c72fe1581225236' },
        { payloadHex: '457567656e2042f6686d20766f6e2042617765726b', ciphertextHex: '21354f87158ac5e357529e87e8c84cfcdb49c8a080550c8f908d05ef7ea82ca525e3d1398e' },
      ],
    });
  });
});
