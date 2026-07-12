/**
 * Unit tests for src/main/mobile-bridge/mobile-bridge-service.ts
 *
 * The load-bearing property covered here: merely checking status, listing
 * devices, or opening the settings tab must NEVER have the side effect of
 * generating and persisting a new device identity keypair. Only a
 * deliberate "Pair a device" (startPairing()) does that. This was caught
 * as a real bug during review - getStatus() originally called the
 * create-if-missing path, so opening Settings with the bridge globally
 * disabled would still silently write an identity file to disk.
 *
 * Mocking mirrors the other mobile-bridge tests: electron and node:fs are
 * mocked so no real file I/O occurs, PATHS is mocked to a stable fake
 * configDir, and transport-factory is mocked so startPairing() never opens
 * a real socket (the relay client itself is covered by
 * relay-pairing-integration.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  // Phase 2's capability handlers reach real src/main/ipc/handlers and
  // src/main/agent modules at import time (attachContext() wires them into
  // the router), so their module-scope `import { ipcMain } from 'electron'`
  // statements need this to exist even though nothing in this test suite
  // ever calls ipcMain.handle/.on.
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

// Reached transitively via handlers/mcp-tool.ts -> mcp-project-context.ts ->
// task-move.ts, which imports the real analytics module (pulls in the
// aptabase-electron package and electron's `app`). Mocked the same way
// session-manager.test.ts does, since nothing here exercises analytics.
vi.mock('../../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
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

const fakeTransport = {
  state: 'connected' as const,
  connect: vi.fn(async () => undefined),
  send: vi.fn(),
  close: vi.fn(),
  onFrame: vi.fn(() => () => undefined),
  onStateChange: vi.fn(() => () => undefined),
};

vi.mock('../../../src/main/mobile-bridge/transport/transport-factory', () => ({
  createTransport: vi.fn(() => fakeTransport),
}));

const { MobileBridgeService } = await import('../../../src/main/mobile-bridge/mobile-bridge-service');

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
  unlinkSyncSpy.mockReset();
  existsSyncSpy.mockReturnValue(false); // no identity/roster file exists yet, by default
  fakeTransport.connect.mockClear();
  fakeTransport.close.mockClear();
});

describe('MobileBridgeService read paths never create an identity', () => {
  it('getStatus() does not persist an identity when none exists yet', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const status = service.getStatus();

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(status.identityFingerprint).toBeNull();
    expect(status.pairedDeviceCount).toBe(0);
    expect(status.enabled).toBe(true);
  });

  it('getStatus() reports the bridge as disabled without touching identity state', () => {
    const service = new MobileBridgeService({ enabled: false, relayUrl: '' });
    const status = service.getStatus();

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(status.enabled).toBe(false);
  });

  it('listDevices() returns an empty array without persisting an identity when none exists', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const devices = service.listDevices();

    expect(devices).toEqual([]);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('revokeDevice() is a no-op without persisting an identity when none exists', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    expect(() => service.revokeDevice('some-device')).not.toThrow();
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('setDeviceCapabilities() throws rather than creating an identity when none exists', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    expect(() => service.setDeviceCapabilities('some-device', ['read-board'])).toThrow(/No such paired device/);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });
});

describe('MobileBridgeService.startPairing() is the deliberate identity-creation trigger', () => {
  it('creates and persists an identity on the first pairing attempt', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const { qrUri } = await service.startPairing();

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    expect(qrUri.startsWith('kangentic-pair://')).toBe(true);
    expect(fakeTransport.connect).toHaveBeenCalledTimes(1);
  });

  it('throws without creating an identity when the bridge is disabled', async () => {
    const service = new MobileBridgeService({ enabled: false, relayUrl: '' });
    await expect(service.startPairing()).rejects.toThrow(/not enabled/);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });
});

describe('MobileBridgeService.reconcile()', () => {
  it('cancels an in-progress pairing when the bridge is disabled', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await service.startPairing();
    expect(service.getStatus().pairingInProgress).toBe(true);

    service.reconcile({ enabled: false, relayUrl: '' });

    expect(service.getStatus().pairingInProgress).toBe(false);
    expect(fakeTransport.close).toHaveBeenCalled();
  });
});

describe('MobileBridgeService.startPairing() closes the transport on a failed connect', () => {
  it('closes the transport, clears activePairing, and rethrows when transport.connect() rejects', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    fakeTransport.connect.mockRejectedValueOnce(new Error('relay unreachable'));

    await expect(service.startPairing()).rejects.toThrow(/relay unreachable/);

    expect(fakeTransport.close).toHaveBeenCalledTimes(1);
    expect(service.getStatus().pairingInProgress).toBe(false);
  });
});
