/**
 * Unit tests for src/main/mobile-bridge/pairing/pairing-service.ts
 *
 * Drives a full pairing ceremony end to end over an in-memory loopback
 * Transport pair, with the "phone" side built directly from
 * @kangentic/protocol's createPairingInitiatorHandshake + sealPairingConfirm
 * (the phone app itself is out of scope for this repo, so it is simulated
 * by hand here, exactly the way a real phone would drive the initiator
 * side of the Noise IKpsk0 handshake and then seal a confirm frame under
 * the resulting transport key). This proves the desktop's responder wiring
 * - token validation, message 2 construction, remote static key capture,
 * SAS derivation, and auto-enroll on the confirm frame - against a real
 * peer rather than against mocked crypto.
 *
 * PairingService itself needs no fs/electron mocking, but auto-enroll
 * calls roster-store's addOrReplaceDevice(), which touches disk unless
 * mocked. So this file carries the same electron+fs+PATHS mocking
 * scaffolding as tests/unit/mobile-bridge/identity.test.ts and
 * roster-store.test.ts (mirroring tests/unit/asana-credential-store.test.ts),
 * even though PairingService's own logic never calls into electron.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CAPABILITY_VERBS,
  createPairingInitiatorHandshake,
  deriveShortAuthenticationString,
  generateX25519KeyPair,
  randomBytes,
  bytesToHex,
  sealPairingConfirm,
  type CipherState,
  type Transport,
} from '@kangentic/protocol';
import { PAIRING_TOKEN_TTL_MS } from '../../../src/main/mobile-bridge/pairing/pairing-token';

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    whenReady: () => Promise.resolve(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const raw = buffer.toString('utf8');
      if (raw.startsWith('encrypted:')) return raw.slice('encrypted:'.length);
      throw new Error('safeStorage.decryptString: invalid ciphertext');
    },
    getSelectedStorageBackend: () => 'keychain',
  },
}));

const existsSyncSpy = vi.hoisted(() => vi.fn<(filePath: string) => boolean>());
const readFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, encoding: BufferEncoding) => string>());
const writeFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, data: string) => void>());
const mkdirSyncSpy = vi.hoisted(() => vi.fn());
const unlinkSyncSpy = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: existsSyncSpy,
      readFileSync: readFileSyncSpy,
      writeFileSync: writeFileSyncSpy,
      mkdirSync: mkdirSyncSpy,
      unlinkSync: unlinkSyncSpy,
    },
    existsSync: existsSyncSpy,
    readFileSync: readFileSyncSpy,
    writeFileSync: writeFileSyncSpy,
    mkdirSync: mkdirSyncSpy,
    unlinkSync: unlinkSyncSpy,
  };
});

vi.mock('../../../src/main/config/paths', () => ({
  PATHS: { configDir: '/mock/config' },
}));

// Import AFTER all vi.mock declarations.
const { PairingService, DEFAULT_PAIRING_CAPABILITIES, SAS_PENDING_TIMEOUT_MS, sanitizeDeviceName } = await import(
  '../../../src/main/mobile-bridge/pairing/pairing-service'
);
const { generateEd25519KeyPair } = await import('@kangentic/protocol');
type BridgeIdentityModule = typeof import('../../../src/main/mobile-bridge/identity');
type BridgeIdentity = ReturnType<BridgeIdentityModule['loadOrCreateBridgeIdentity']>;
type PairingServiceInstance = InstanceType<typeof PairingService>;

function testIdentity(): BridgeIdentity {
  return {
    staticKeyPair: generateX25519KeyPair(),
    masterSigningKeyPair: generateEd25519KeyPair(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * A loopback pair simulating what a relay would do: sending on one half
 * synchronously invokes the other half's registered onFrame listeners.
 * Both PairingService's Noise responder and this test's simulated Noise
 * initiator are fully synchronous per-message, so the entire ceremony
 * (message 1 -> message 2 -> SAS emission) completes inside the single
 * synchronous call to the first .send(), with no timers involved.
 */
function createLoopbackTransportPair(): [Transport, Transport] {
  const listenersOfFirst = new Set<(frame: Uint8Array) => void>();
  const listenersOfSecond = new Set<(frame: Uint8Array) => void>();

  const first: Transport = {
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      for (const listener of listenersOfSecond) listener(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      listenersOfFirst.add(listener);
      return () => listenersOfFirst.delete(listener);
    },
    onStateChange: () => () => undefined,
  };

  const second: Transport = {
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      for (const listener of listenersOfFirst) listener(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      listenersOfSecond.add(listener);
      return () => listenersOfSecond.delete(listener);
    },
    onStateChange: () => () => undefined,
  };

  return [first, second];
}

interface ParsedRosterFile {
  devices: Array<{ deviceId: string; staticPublicKeyHex: string; displayName: string; capabilities: string[] }>;
}

/**
 * Drives a full ceremony (handshake -> SAS -> phone confirm frame) over a
 * fresh loopback pair, exactly as a real phone would: reads message 2,
 * captures the initiator-to-responder cipher state split() yields, seals a
 * confirm frame under it, and sends that back to the desktop.
 */
async function runPairingCeremony(
  identity: BridgeIdentity,
  service: PairingServiceInstance,
  deviceNamePayload: string,
): Promise<{ deviceId: string; displayName: string; phoneStaticKeyPair: ReturnType<typeof generateX25519KeyPair> }> {
  const token = service.mintToken();
  const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
  service.start(desktopTransport);

  const phoneStaticKeyPair = generateX25519KeyPair();
  const phoneHandshake = createPairingInitiatorHandshake({
    localStatic: phoneStaticKeyPair,
    remoteStatic: identity.staticKeyPair.publicKey,
    pairingToken: token.token,
  });

  let phoneConfirmCipher: CipherState | undefined;
  phoneTransport.onFrame((frame) => {
    const result = phoneHandshake.readMessage(frame);
    if (result.split) phoneConfirmCipher = result.split[0];
  });

  const sasEventPromise = new Promise<void>((resolve) => service.once('sas', () => resolve()));
  const message1 = phoneHandshake.writeMessage(new TextEncoder().encode(deviceNamePayload)).message;
  phoneTransport.send(message1);
  await sasEventPromise;

  if (!phoneConfirmCipher) throw new Error('test setup: phone did not derive a confirm cipher from message 2');
  const confirmedEventPromise = new Promise<{ deviceId: string; displayName: string }>((resolve) => {
    service.once('confirmed', resolve);
  });
  phoneTransport.send(sealPairingConfirm(phoneConfirmCipher));
  const confirmedEvent = await confirmedEventPromise;

  return { ...confirmedEvent, phoneStaticKeyPair };
}

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
  unlinkSyncSpy.mockReset();
});

describe('PairingService ceremony', () => {
  it('completes the happy path: matching SAS on both sides, then the phone confirm frame auto-enrolls the device', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const { deviceId, displayName, phoneStaticKeyPair } = await runPairingCeremony(identity, service, 'Test Phone');

    // Enrollment is keyed off the handshake's own remote static key, not
    // anything a payload could claim - the confirm frame carries no fields
    // at all, so there is nothing else it COULD have enrolled from.
    expect(deviceId).toBe(bytesToHex(phoneStaticKeyPair.publicKey));
    expect(displayName).toBe('Test Phone');

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const [, writtenJson] = writeFileSyncSpy.mock.calls[0] as [string, string];
    const writtenRoster = JSON.parse(writtenJson) as ParsedRosterFile;
    const persistedDevice = writtenRoster.devices.find((device) => device.deviceId === deviceId);
    expect(persistedDevice?.staticPublicKeyHex).toBe(bytesToHex(phoneStaticKeyPair.publicKey));
    expect(persistedDevice?.capabilities).toEqual(DEFAULT_PAIRING_CAPABILITIES);
  });

  it('ignores a wrong-token message 1 without emitting sas or failed', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    service.start(desktopTransport);

    const phoneStaticKeyPair = generateX25519KeyPair();
    const wrongToken = randomBytes(32);
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: phoneStaticKeyPair,
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: wrongToken,
    });

    const sasListener = vi.fn();
    const failedListener = vi.fn();
    service.on('sas', sasListener);
    service.on('failed', failedListener);

    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message;
    phoneTransport.send(message1);

    // The loopback transport is synchronous, so by the time send() returns the
    // service has fully processed the frame: no waiting needed to prove a
    // negative here.
    expect(sasListener).not.toHaveBeenCalled();
    expect(failedListener).not.toHaveBeenCalled();
  });

  /**
   * The regression this whole change exists to prevent. The pairing slot used
   * to BE the pairing token, so anyone who could read the relay request URI
   * could deliver one frame and permanently burn the ceremony: consumed was set
   * before readMessage() ever authenticated anything.
   *
   * Asserting `consumed === false` would not be enough to prove the fix.
   * readMessage() advances messageIndex and mixes the sender's ephemeral into
   * the transcript BEFORE it throws, so a shared HandshakeState stays poisoned
   * even once the token survives. Only completing a real handshake afterwards
   * proves the ceremony is genuinely still usable.
   */
  it('survives unauthenticated frames and still completes a real pairing afterwards', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    service.start(desktopTransport);

    const failedListener = vi.fn();
    service.on('failed', failedListener);

    // Three shapes of hostile or stray traffic: raw garbage, an empty frame,
    // and a well-formed message 1 built under a different token.
    phoneTransport.send(new Uint8Array([1, 2, 3, 4]));
    phoneTransport.send(new Uint8Array(0));
    const attackerHandshake = createPairingInitiatorHandshake({
      localStatic: generateX25519KeyPair(),
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: randomBytes(32),
    });
    phoneTransport.send(attackerHandshake.writeMessage(new TextEncoder().encode('Attacker')).message);

    expect(failedListener).not.toHaveBeenCalled();
    expect(token.consumed).toBe(false);

    // Now the real phone arrives on the same, still-live ceremony.
    const phoneStaticKeyPair = generateX25519KeyPair();
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: phoneStaticKeyPair,
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: token.token,
    });

    let phoneConfirmCipher: CipherState | undefined;
    phoneTransport.onFrame((frame) => {
      const result = phoneHandshake.readMessage(frame);
      if (result.split) phoneConfirmCipher = result.split[0];
    });

    const sasEventPromise = new Promise<void>((resolve) => service.once('sas', () => resolve()));
    phoneTransport.send(phoneHandshake.writeMessage(new TextEncoder().encode('Real Phone')).message);
    await sasEventPromise;

    expect(token.consumed).toBe(true);
    if (!phoneConfirmCipher) throw new Error('test setup: phone did not derive a confirm cipher from message 2');

    const confirmedEventPromise = new Promise<{ deviceId: string; displayName: string }>((resolve) => {
      service.once('confirmed', resolve);
    });
    phoneTransport.send(sealPairingConfirm(phoneConfirmCipher));
    const confirmedEvent = await confirmedEventPromise;

    expect(confirmedEvent.deviceId).toBe(bytesToHex(phoneStaticKeyPair.publicKey));
    expect(confirmedEvent.displayName).toBe('Real Phone');
    expect(failedListener).not.toHaveBeenCalled();
  });

  /**
   * The sas-pending half of the same defect. A confirm frame that does not open
   * is unauthenticated, and the slot is reachable by anyone who can read the
   * request URI, so one injected frame must not end the ceremony. This is safe
   * because CipherState advances its nonce only on a successful decrypt, which
   * the second half of this test proves: the real frame still opens afterwards.
   */
  it('ignores confirm frames that do not open, and still enrolls on the real one', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    service.start(desktopTransport);

    const phoneStaticKeyPair = generateX25519KeyPair();
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: phoneStaticKeyPair,
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: token.token,
    });
    let phoneConfirmCipher: CipherState | undefined;
    phoneTransport.onFrame((frame) => {
      const result = phoneHandshake.readMessage(frame);
      if (result.split) phoneConfirmCipher = result.split[0];
    });
    const sasEventPromise = new Promise<void>((resolve) => service.once('sas', () => resolve()));
    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message;
    phoneTransport.send(message1);
    await sasEventPromise;

    const confirmedListener = vi.fn();
    const failedListener = vi.fn();
    service.on('confirmed', confirmedListener);
    service.on('failed', failedListener);

    // Garbage bytes instead of a genuine sealed confirm frame - an injected
    // frame that cannot open under the desktop's derived key.
    phoneTransport.send(new Uint8Array([1, 2, 3, 4]));
    phoneTransport.send(new Uint8Array([5, 6, 7, 8]));

    expect(failedListener).not.toHaveBeenCalled();
    expect(confirmedListener).not.toHaveBeenCalled();
    expect(writeFileSyncSpy).not.toHaveBeenCalled();

    if (!phoneConfirmCipher) throw new Error('test setup: phone did not derive a confirm cipher from message 2');
    const confirmedEventPromise = new Promise<{ deviceId: string }>((resolve) => service.once('confirmed', resolve));
    phoneTransport.send(sealPairingConfirm(phoneConfirmCipher));
    const confirmedEvent = await confirmedEventPromise;

    expect(confirmedEvent.deviceId).toBe(bytesToHex(phoneStaticKeyPair.publicKey));
    expect(failedListener).not.toHaveBeenCalled();
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * Transport.send() genuinely throws - RelayClient rejects a send while not
   * connected, and on its per-session byte cap - and message 2 is now sent
   * after the phase has already flipped to sas-pending. Without a guard the
   * throw would escape into the transport callback and leave the ceremony
   * parked for the whole SAS timeout, waiting on a confirm frame the phone
   * cannot produce because it never received message 2.
   */
  it('fails fast when the transport throws while sending message 2', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    const sendingDesktopTransport: Transport = {
      ...desktopTransport,
      send: () => {
        throw new Error('RelayClient.send() called while not connected');
      },
    };
    service.start(sendingDesktopTransport);

    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: generateX25519KeyPair(),
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: token.token,
    });

    const sasListener = vi.fn();
    service.on('sas', sasListener);
    const failedEventPromise = new Promise<{ reason: string }>((resolve) => service.once('failed', resolve));

    phoneTransport.send(phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message);

    const failedEvent = await failedEventPromise;
    // Match the SEND-specific reason, not a substring shared with the
    // construct-the-response failure: an assertion both branches satisfy
    // cannot tell a regression that fires the wrong one from a pass.
    expect(failedEvent.reason).toMatch(/failed while sending the response/);
    // The peer did authenticate, so the token is still correctly spent.
    expect(token.consumed).toBe(true);
    expect(sasListener).not.toHaveBeenCalled();
  });

  /**
   * Proves phase flips to 'sas-pending' BEFORE activeTransport.send() is
   * called for message 2, not after. A real relay socket can deliver a
   * queued inbound frame synchronously from inside an outbound write, so if
   * the phase commit happened after send() (the ordering this diff fixes),
   * that re-entrant frame would land on onFrame() while phase was still
   * 'waiting-for-phone', route straight back into handleMessage1() with the
   * token already marked consumed, and fail a ceremony that had just
   * succeeded - all while the outer handleMessage1() call still went on to
   * emit 'sas' as if nothing happened, since fail() does not throw.
   *
   * The mock transport simulates exactly that: its send() injects a garbage
   * frame back through the desktop's own onFrame before forwarding the real
   * message 2 to the phone. With the fix, that injected frame reaches
   * handleConfirmFrame() (phase already 'sas-pending') and is silently
   * ignored rather than reaching handleMessage1().
   */
  it('keeps a ceremony that just succeeded intact when send() re-enters onFrame synchronously', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();

    let injectedReentrantFrame = false;
    const reentrantDesktopTransport: Transport = {
      ...desktopTransport,
      send: (frame) => {
        if (!injectedReentrantFrame) {
          injectedReentrantFrame = true;
          // Simulates a relay flushing a queued inbound frame synchronously
          // from inside the outbound write - lands back on the desktop's
          // own onFrame before this send() call returns.
          phoneTransport.send(new Uint8Array([9, 9, 9, 9]));
        }
        desktopTransport.send(frame);
      },
    };
    service.start(reentrantDesktopTransport);

    const failedListener = vi.fn();
    service.on('failed', failedListener);

    const phoneStaticKeyPair = generateX25519KeyPair();
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: phoneStaticKeyPair,
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: token.token,
    });
    let phoneConfirmCipher: CipherState | undefined;
    phoneTransport.onFrame((frame) => {
      const result = phoneHandshake.readMessage(frame);
      if (result.split) phoneConfirmCipher = result.split[0];
    });

    const sasEventPromise = new Promise<void>((resolve) => service.once('sas', () => resolve()));
    phoneTransport.send(phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message);
    await sasEventPromise;

    expect(failedListener).not.toHaveBeenCalled();
    expect(token.consumed).toBe(true);

    if (!phoneConfirmCipher) throw new Error('test setup: phone did not derive a confirm cipher from message 2');
    const confirmedEventPromise = new Promise<{ deviceId: string }>((resolve) => service.once('confirmed', resolve));
    phoneTransport.send(sealPairingConfirm(phoneConfirmCipher));
    const confirmedEvent = await confirmedEventPromise;

    expect(confirmedEvent.deviceId).toBe(bytesToHex(phoneStaticKeyPair.publicKey));
    expect(failedListener).not.toHaveBeenCalled();
  });

  it('start() before mintToken() throws synchronously', () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const [desktopTransport] = createLoopbackTransportPair();

    expect(() => service.start(desktopTransport)).toThrow(/mintToken\(\) must be called before start\(\)/);
  });

  it('cancel() before any frame arrives emits cancelled and does not throw', () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    service.mintToken();
    const [desktopTransport] = createLoopbackTransportPair();
    service.start(desktopTransport);

    const cancelledListener = vi.fn();
    service.on('cancelled', cancelledListener);

    expect(() => service.cancel('User backed out')).not.toThrow();
    expect(cancelledListener).toHaveBeenCalledWith({ reason: 'User backed out' });
  });
});

describe('PairingService default capability grant', () => {
  it('DEFAULT_PAIRING_CAPABILITIES is the full ten-verb set', () => {
    expect(DEFAULT_PAIRING_CAPABILITIES).toEqual(CAPABILITY_VERBS);
  });

  it('persists the full capability grant on auto-enroll', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const { deviceId } = await runPairingCeremony(identity, service, 'Test Phone');

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const [, writtenJson] = writeFileSyncSpy.mock.calls[0] as [string, string];
    const writtenRoster = JSON.parse(writtenJson) as ParsedRosterFile;
    const persistedDevice = writtenRoster.devices.find((device) => device.deviceId === deviceId);
    expect(persistedDevice?.capabilities).toEqual(CAPABILITY_VERBS);
  });
});

describe('PairingService phone-supplied device name sanitization', () => {
  it('strips control characters and trims the phone-supplied name', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    // Built via fromCharCode rather than a literal escape in source, so this
    // file's authored text stays free of literal control bytes.
    const bellCharacter = String.fromCharCode(7);
    const { displayName } = await runPairingCeremony(identity, service, `  My${bellCharacter}Phone  `);
    expect(displayName).toBe('MyPhone');
  });

  it('clamps an overlong phone-supplied name to 64 characters', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const longName = 'a'.repeat(100);
    const { displayName } = await runPairingCeremony(identity, service, longName);
    expect(displayName).toBe('a'.repeat(64));
  });

  it('falls back to "Paired Device" for a blank phone-supplied name', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const { displayName } = await runPairingCeremony(identity, service, '   ');
    expect(displayName).toBe('Paired Device');
  });
});

describe('sanitizeDeviceName filters the full control-character range, not just C0 low codes', () => {
  it('strips the DEL character (code point 127), which sits above MIN_PRINTABLE_CODE_POINT and needs its own exclusion', () => {
    // Every other "strips control characters" test in this file (and in
    // mobile-bridge-service.test.ts's rename tests) uses BEL (7), which is
    // caught by the `codePoint >= 32` half of the filter. DEL (127) is NOT
    // caught by that half - it only gets excluded by the separate
    // `codePoint !== DELETE_CODE_POINT` check, which was otherwise never
    // exercised by any existing test.
    const deleteCharacter = String.fromCharCode(127);
    expect(sanitizeDeviceName(`My${deleteCharacter}Phone`)).toBe('MyPhone');
  });

  it('falls back to "Paired Device" when the raw name is entirely control characters, not just whitespace', () => {
    // The existing blank-fallback tests use whitespace-only input ('   '),
    // which trim() alone would reduce to empty. This exercises the OTHER
    // path to an empty result: the control-character filter itself removing
    // every character, with no whitespace involved at all.
    const bellCharacter = String.fromCharCode(7);
    const deleteCharacter = String.fromCharCode(127);
    expect(sanitizeDeviceName(bellCharacter + bellCharacter + deleteCharacter)).toBe('Paired Device');
  });
});

describe('sanitizeDeviceName clamps by code point, not UTF-16 code unit', () => {
  it('does not split an astral character in half when clamping to MAX_DEVICE_NAME_LENGTH', () => {
    // A plain decoded.slice(0, 64) clamps by UTF-16 CODE UNIT: the emoji at
    // code-point index 63 is a surrogate pair, so a code-unit slice to 64
    // units keeps only its lone high surrogate, corrupting the result. The
    // fix clamps by code point via Array.from(...).slice(...), which keeps
    // the whole emoji or drops it entirely, never a fragment.
    const emoji = '\u{1F600}';
    const rawName = 'a'.repeat(63) + emoji + 'trailing text that must be clamped away entirely';

    const result = sanitizeDeviceName(rawName);
    const resultCodePoints = Array.from(result);

    expect(resultCodePoints).toHaveLength(64);
    for (const character of resultCodePoints) {
      const codePoint = character.codePointAt(0) ?? 0;
      // No lone surrogate (0xD800-0xDFFF) anywhere in the result.
      expect(codePoint < 0xd800 || codePoint > 0xdfff).toBe(true);
    }
    // The emoji at index 63 must survive intact as the 64th code point, not
    // be cut into a fragment.
    expect(result.endsWith(emoji)).toBe(true);
  });
});

describe('PairingService pairing-token expiry and single-use enforcement', () => {
  it('rejects a message-1 handshake attempt against an expired pairing token', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    service.start(desktopTransport);

    // Force expiry directly on the token object rather than advancing real
    // or fake time: the ceremony's own phase timer (armed at start() for
    // exactly this token's TTL) would otherwise race the same deadline and
    // fail the ceremony first, with a DIFFERENT (timeout) reason. Setting
    // expiresAt in the past isolates handleMessage1's lazy
    // isPairingTokenValid check, mirroring the "already consumed" test below.
    (service as unknown as { activeToken: { expiresAt: number } }).activeToken.expiresAt = Date.now() - 1;

    const phoneStaticKeyPair = generateX25519KeyPair();
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: phoneStaticKeyPair,
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: token.token,
    });

    const sasListener = vi.fn();
    service.on('sas', sasListener);
    const failedEventPromise = new Promise<{ reason: string }>((resolve) => {
      service.once('failed', resolve);
    });

    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message;
    phoneTransport.send(message1);

    const failedEvent = await failedEventPromise;
    expect(failedEvent.reason).toMatch(/expired or already used/);
    expect(sasListener).not.toHaveBeenCalled();
  });

  it('rejects a handshake attempt once the pairing token has already been marked consumed', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    service.start(desktopTransport);

    // Force the single-use flag directly rather than driving two full
    // handshake attempts. Rejected frames no longer consume the token and no
    // longer end the ceremony, so several message-1 frames CAN now arrive in
    // "waiting-for-phone" - but none of them reaches this branch, because the
    // only thing that sets consumed is a frame that authenticates, and that
    // same frame moves the phase to "sas-pending". Forcing the flag isolates
    // the "already consumed" branch of handleMessage1's validity check.
    (service as unknown as { activeToken: { consumed: boolean } }).activeToken.consumed = true;

    const phoneStaticKeyPair = generateX25519KeyPair();
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: phoneStaticKeyPair,
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: token.token,
    });

    const failedEventPromise = new Promise<{ reason: string }>((resolve) => {
      service.once('failed', resolve);
    });

    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message;
    phoneTransport.send(message1);

    const failedEvent = await failedEventPromise;
    expect(failedEvent.reason).toMatch(/expired or already used/);
  });

  /**
   * The validity check runs per frame now that a rejected frame no longer ends
   * the ceremony, so a valid handshake landing in the last moments of the TTL
   * has to still complete. That path was previously unreachable: frame one
   * always terminated waiting-for-phone.
   */
  it('completes a valid handshake that arrives just before the pairing token expires', async () => {
    // Fake timers freeze Date.now(), so "1 ms before expiry" is exact rather
    // than a race against however long the handshake takes to run. The whole
    // ceremony is synchronous, so no timer ever needs advancing here.
    vi.useFakeTimers();
    try {
      const identity = testIdentity();
      const service = new PairingService(identity);
      const token = service.mintToken();
      const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
      service.start(desktopTransport);

      // A rejected frame first, so the near-expiry attempt is genuinely the
      // second one to reach handleMessage1.
      phoneTransport.send(new Uint8Array([9, 9, 9, 9]));

      // Still valid, but only just: isPairingTokenValid is `now < expiresAt`.
      (service as unknown as { activeToken: { expiresAt: number } }).activeToken.expiresAt = Date.now() + 1;

      const phoneStaticKeyPair = generateX25519KeyPair();
      const phoneHandshake = createPairingInitiatorHandshake({
        localStatic: phoneStaticKeyPair,
        remoteStatic: identity.staticKeyPair.publicKey,
        pairingToken: token.token,
      });

      const failedListener = vi.fn();
      service.on('failed', failedListener);
      const sasEventPromise = new Promise<void>((resolve) => service.once('sas', () => resolve()));

      phoneTransport.send(phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message);
      await sasEventPromise;

      expect(token.consumed).toBe(true);
      expect(failedListener).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PairingService ceremony timeouts', () => {
  it('fails the ceremony if the QR is never scanned before the pairing token TTL elapses', async () => {
    vi.useFakeTimers();
    try {
      const identity = testIdentity();
      const service = new PairingService(identity);
      service.mintToken();
      const [desktopTransport] = createLoopbackTransportPair();
      service.start(desktopTransport);

      const failedEventPromise = new Promise<{ reason: string }>((resolve) => {
        service.once('failed', resolve);
      });

      vi.advanceTimersByTime(PAIRING_TOKEN_TTL_MS + 1);

      const failedEvent = await failedEventPromise;
      expect(failedEvent.reason).toMatch(/Timed out waiting for your phone/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the ceremony if the phone never sends its confirm frame before the SAS-pending timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const identity = testIdentity();
      const service = new PairingService(identity);
      const token = service.mintToken();
      const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
      service.start(desktopTransport);

      const phoneStaticKeyPair = generateX25519KeyPair();
      const phoneHandshake = createPairingInitiatorHandshake({
        localStatic: phoneStaticKeyPair,
        remoteStatic: identity.staticKeyPair.publicKey,
        pairingToken: token.token,
      });
      const sasEventPromise = new Promise<void>((resolve) => service.once('sas', () => resolve()));
      const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message;
      phoneTransport.send(message1);
      await sasEventPromise;

      const failedEventPromise = new Promise<{ reason: string }>((resolve) => {
        service.once('failed', resolve);
      });

      vi.advanceTimersByTime(SAS_PENDING_TIMEOUT_MS + 1);

      const failedEvent = await failedEventPromise;
      expect(failedEvent.reason).toMatch(/Timed out waiting for your phone/);
    } finally {
      vi.useRealTimers();
    }
  });
});
