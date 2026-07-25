/**
 * End-to-end pairing over a REAL WebSocket connection (not the in-memory
 * loopback Transport double used in pairing-service.test.ts): the desktop
 * side runs the actual production RelayClient (Node's global WebSocket)
 * against a local relay-double.ts server, and a simulated phone connects
 * with the `ws` package's WebSocket client to the same slot. This is the
 * closest to a real end-to-end run achievable without the separate relay
 * server task/repo - see relay-double.ts's doc comment.
 *
 * Same electron/fs/PATHS mocking as pairing-service.test.ts: PairingService's
 * own logic never touches electron, but confirmSas() calls roster-store's
 * addOrReplaceDevice(), which does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import {
  bytesToHex,
  createPairingInitiatorHandshake,
  deriveShortAuthenticationString,
  generateX25519KeyPair,
  sealPairingConfirm,
  type CipherState,
  type ShortAuthenticationString,
} from '@kangentic/protocol';
import { startRelayDouble, type RelayDouble } from './relay-double';

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

const { PairingService } = await import('../../../src/main/mobile-bridge/pairing/pairing-service');
const { RelayClient } = await import('../../../src/main/mobile-bridge/transport/relay-client');
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

function toBytes(data: unknown): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('Unexpected ws message data type in test');
}

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
  unlinkSyncSpy.mockReset();
});

describe('mobile bridge pairing over a real relay double', () => {
  let relay: RelayDouble;

  beforeEach(async () => {
    relay = await startRelayDouble();
  });

  afterEach(async () => {
    await relay.close();
  });

  it('completes pairing end to end: RelayClient <-> relay double <-> simulated phone', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    const slotId = bytesToHex(token.token);

    const desktopTransport = new RelayClient({ relayUrl: relay.url, slotId });
    await desktopTransport.connect();
    service.start(desktopTransport);

    const phoneSocket = new NodeWebSocket(`${relay.url}?slot=${encodeURIComponent(slotId)}`);
    await new Promise<void>((resolve, reject) => {
      phoneSocket.once('open', () => resolve());
      phoneSocket.once('error', reject);
    });

    const phoneStaticKeyPair = generateX25519KeyPair();
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: phoneStaticKeyPair,
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: token.token,
    });

    let phoneComputedSas: ShortAuthenticationString | undefined;
    let phoneConfirmCipher: CipherState | undefined;
    const phoneSasReady = new Promise<void>((resolve) => {
      phoneSocket.on('message', (data) => {
        const result = phoneHandshake.readMessage(toBytes(data));
        phoneComputedSas = deriveShortAuthenticationString(phoneHandshake.getHandshakeHash());
        if (result.split) phoneConfirmCipher = result.split[0];
        resolve();
      });
    });

    const sasEventPromise = new Promise<{ sas: ShortAuthenticationString; phoneStaticPublicKeyHex: string }>((resolve) => {
      service.once('sas', resolve);
    });

    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Real Relay Phone')).message;
    phoneSocket.send(message1);

    const [sasEvent] = await Promise.all([sasEventPromise, phoneSasReady]);

    expect(sasEvent.phoneStaticPublicKeyHex).toBe(bytesToHex(phoneStaticKeyPair.publicKey));
    expect(phoneComputedSas).toBeDefined();
    expect(sasEvent.sas).toEqual(phoneComputedSas);

    // Auto-enroll: the phone seals a confirm frame under the transport key
    // its own read of message 2 just derived, exactly as a real "tap
    // Confirm" would - the desktop opens it and enrolls with no further
    // desktop-side confirmation.
    const confirmedPromise = new Promise<{ deviceId: string; displayName: string }>((resolve) => {
      service.once('confirmed', resolve);
    });
    if (!phoneConfirmCipher) throw new Error('test setup: phone did not derive a confirm cipher from message 2');
    phoneSocket.send(sealPairingConfirm(phoneConfirmCipher));
    const confirmed = await confirmedPromise;
    expect(confirmed.deviceId).toBe(bytesToHex(phoneStaticKeyPair.publicKey));
    expect(confirmed.displayName).toBe('Real Relay Phone');

    phoneSocket.close();
    desktopTransport.close();
  });

  it('rejects pairing when the simulated phone presents the wrong token, even over a real relay connection', async () => {
    const identity = testIdentity();
    const service = new PairingService(identity);
    const token = service.mintToken();
    const slotId = bytesToHex(token.token);

    const desktopTransport = new RelayClient({ relayUrl: relay.url, slotId });
    await desktopTransport.connect();
    service.start(desktopTransport);

    const phoneSocket = new NodeWebSocket(`${relay.url}?slot=${encodeURIComponent(slotId)}`);
    await new Promise<void>((resolve, reject) => {
      phoneSocket.once('open', () => resolve());
      phoneSocket.once('error', reject);
    });

    const phoneStaticKeyPair = generateX25519KeyPair();
    const wrongToken = new Uint8Array(32).fill(0x42);
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

    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Wrong Token Phone')).message;
    phoneSocket.send(message1);

    const failedEvent = await failedEventPromise;
    expect(failedEvent.reason).toEqual(expect.any(String));
    expect(sasListener).not.toHaveBeenCalled();

    phoneSocket.close();
    desktopTransport.close();
  });
});
