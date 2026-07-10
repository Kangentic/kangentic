/**
 * Unit tests for src/main/mobile-bridge/pairing/pairing-service.ts
 *
 * Drives a full pairing ceremony end to end over an in-memory loopback
 * Transport pair, with the "phone" side built directly from
 * @kangentic/protocol's createPairingInitiatorHandshake (the phone app
 * itself is out of scope for this repo, so it is simulated by hand here,
 * exactly the way a real phone would drive the initiator side of the Noise
 * IKpsk0 handshake). This proves the desktop's responder wiring - token
 * validation, message 2 construction, remote static key capture, and SAS
 * derivation - against a real peer rather than against mocked crypto.
 *
 * PairingService itself needs no fs/electron mocking, but confirmSas()
 * calls roster-store's addOrReplaceDevice(), which touches disk unless
 * mocked. So this file carries the same electron+fs+PATHS mocking
 * scaffolding as tests/unit/mobile-bridge/identity.test.ts and
 * roster-store.test.ts (mirroring tests/unit/asana-credential-store.test.ts),
 * even though PairingService's own logic never calls into electron.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPairingInitiatorHandshake,
  deriveShortAuthenticationString,
  generateX25519KeyPair,
  randomBytes,
  bytesToHex,
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
const { PairingService, DEFAULT_PAIRING_CAPABILITIES } = await import(
  '../../../src/main/mobile-bridge/pairing/pairing-service'
);
const { generateEd25519KeyPair } = await import('@kangentic/protocol');
type BridgeIdentityModule = typeof import('../../../src/main/mobile-bridge/identity');
type BridgeIdentity = ReturnType<BridgeIdentityModule['loadOrCreateBridgeIdentity']>;

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

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
  unlinkSyncSpy.mockReset();
});

describe('PairingService ceremony', () => {
  it('completes the happy path: matching SAS on both sides, then confirmSas signs the device into the roster', async () => {
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

    let phoneComputedSas: ReturnType<typeof deriveShortAuthenticationString> | undefined;
    phoneTransport.onFrame((frame) => {
      phoneHandshake.readMessage(frame);
      phoneComputedSas = deriveShortAuthenticationString(phoneHandshake.getHandshakeHash());
    });

    const sasEventPromise = new Promise<{
      sas: ReturnType<typeof deriveShortAuthenticationString>;
      phoneStaticPublicKeyHex: string;
    }>((resolve) => {
      service.once('sas', resolve);
    });

    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message;
    phoneTransport.send(message1);

    const sasEvent = await sasEventPromise;

    expect(sasEvent.phoneStaticPublicKeyHex).toBe(bytesToHex(phoneStaticKeyPair.publicKey));
    expect(phoneComputedSas).toBeDefined();
    expect(sasEvent.sas).toEqual(phoneComputedSas);

    const confirmedEventPromise = new Promise<{ deviceId: string }>((resolve) => {
      service.once('confirmed', resolve);
    });
    service.confirmSas('device-abc', 'Test Phone');
    const confirmedEvent = await confirmedEventPromise;

    expect(confirmedEvent.deviceId).toBe('device-abc');
  });

  it('emits failed (not sas) when the phone uses the wrong pairing token', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    void token;
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
    service.on('sas', sasListener);
    const failedEventPromise = new Promise<{ reason: string }>((resolve) => {
      service.once('failed', resolve);
    });

    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message;
    phoneTransport.send(message1);

    const failedEvent = await failedEventPromise;

    expect(failedEvent.reason).toEqual(expect.any(String));
    expect(sasListener).not.toHaveBeenCalled();
  });

  it('start() before mintToken() throws synchronously', () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const [desktopTransport] = createLoopbackTransportPair();

    expect(() => service.start(desktopTransport)).toThrow(/mintToken\(\) must be called before start\(\)/);
  });

  it('confirmSas() before the sas event has fired throws synchronously', () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    service.mintToken();

    expect(() => service.confirmSas('device-x', 'Some Device')).toThrow(/Cannot confirm pairing while phase is/);
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

interface ParsedRosterFile {
  devices: Array<{ deviceId: string; capabilities: string[] }>;
}

describe('PairingService.confirmSas default capabilities', () => {
  it('persists the read-only default capability set when confirmSas is called without an explicit capabilities argument', async () => {
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

    const sasEventPromise = new Promise<void>((resolve) => {
      service.once('sas', () => resolve());
    });
    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message;
    phoneTransport.send(message1);
    await sasEventPromise;

    // Deliberately omit the capabilities argument - this is the exact call
    // shape the settings UI makes for a brand-new pairing.
    service.confirmSas('device-default-caps', 'Test Phone');

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const [, writtenJson] = writeFileSyncSpy.mock.calls[0] as [string, string];
    const writtenRoster = JSON.parse(writtenJson) as ParsedRosterFile;
    const persistedDevice = writtenRoster.devices.find((device) => device.deviceId === 'device-default-caps');

    expect(persistedDevice).toBeDefined();
    expect(persistedDevice?.capabilities).toEqual(DEFAULT_PAIRING_CAPABILITIES);
    expect(persistedDevice?.capabilities).toEqual(['read-stream', 'read-board', 'read-diff']);
  });
});

describe('PairingService pairing-token expiry and single-use enforcement', () => {
  it('rejects a message-1 handshake attempt against an expired pairing token', async () => {
    vi.useFakeTimers();
    try {
      const identity = testIdentity();
      const service = new PairingService(identity);
      const token = service.mintToken();
      const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
      service.start(desktopTransport);

      vi.advanceTimersByTime(PAIRING_TOKEN_TTL_MS + 1);

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
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a handshake attempt once the pairing token has already been marked consumed', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    service.start(desktopTransport);

    // Force the single-use flag directly rather than driving two full
    // handshake attempts: a genuine second frame is unreachable through the
    // public API here, because the first attempt's processing is entirely
    // synchronous and always leaves "waiting-for-phone" (moving to either
    // "sas-pending" or "done", tearing down the frame subscription) before a
    // second frame could ever arrive. This isolates the "already consumed"
    // branch of handleMessage1's validity check on its own.
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
});
