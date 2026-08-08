/**
 * Unit tests for src/main/ipc/handlers/mobile-bridge.ts.
 *
 * Every other mobile-bridge test file (mobile-bridge-service.test.ts,
 * pairing-service.test.ts, etc.) exercises MobileBridgeService directly.
 * Nothing exercised the IPC handler layer itself: whether each channel
 * forwards to the right service method with the right arguments and shapes
 * its return value correctly, and whether the four push-event listeners
 * (pairingSas, pairingConfirmed, pairingEnded, stateChanged) forward the
 * service's emitted payloads to the renderer and honor the
 * mainWindow.isDestroyed() guard documented on every other push-event
 * handler in the codebase.
 *
 * Strategy mirrors config-handler-wiring.test.ts: mock electron's ipcMain to
 * capture registered handlers, build a fake MobileBridgeService (a real
 * EventEmitter so service.on(...) wiring is exercised for real, with spied
 * methods), then invoke the captured handlers directly.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IPC } from '../../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after the electron mock)
// ---------------------------------------------------------------------------

import { registerMobileBridgeHandlers } from '../../../src/main/ipc/handlers/mobile-bridge';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class FakeMobileBridgeService extends EventEmitter {
  getStatus = vi.fn(() => ({
    enabled: true,
    secureStorageAvailable: true,
    identityFingerprint: 'deadbeef',
    relayUrl: 'wss://relay.example.com',
    pairedDeviceCount: 0,
    pairingInProgress: false,
    relayState: 'idle' as const,
  }));
  startPairing = vi.fn(async () => ({
    qrPayload: { expiresAt: '2026-01-01T00:10:00.000Z' } as { expiresAt: string },
    qrUri: 'kangentic-pair://mock',
  }));
  cancelPairing = vi.fn();
  listDevices = vi.fn(() => []);
  revokeDevice = vi.fn();
  renameDevice = vi.fn();
  setDeviceCapabilities = vi.fn();
}

function makeContext(overrides?: { isDestroyed?: boolean }): IpcContext & { mobileBridgeService: FakeMobileBridgeService } {
  const mobileBridgeService = new FakeMobileBridgeService();
  const mainWindow = {
    isDestroyed: vi.fn(() => overrides?.isDestroyed ?? false),
    webContents: { send: vi.fn() },
  };
  return {
    mainWindow,
    mobileBridgeService,
  } as unknown as IpcContext & { mobileBridgeService: FakeMobileBridgeService };
}

function invokeHandler(channel: string, ...args: unknown[]): unknown {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered for channel: ${channel}`);
  return handler(undefined, ...args);
}

describe('registerMobileBridgeHandlers - request/response channels', () => {
  beforeEach(() => {
    capturedHandlers.clear();
  });

  it('MOBILE_GET_STATUS forwards to service.getStatus() and returns its result verbatim', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = invokeHandler(IPC.MOBILE_GET_STATUS);

    expect(context.mobileBridgeService.getStatus).toHaveBeenCalledTimes(1);
    expect(result).toEqual(context.mobileBridgeService.getStatus.mock.results[0]!.value);
  });

  it('MOBILE_START_PAIRING forwards to service.startPairing() and reshapes the result to { qrUri, expiresAt }', async () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = await invokeHandler(IPC.MOBILE_START_PAIRING);

    expect(context.mobileBridgeService.startPairing).toHaveBeenCalledTimes(1);
    // The handler must NOT leak the full qrPayload (desktopStaticPublicKey,
    // pairingToken) to the renderer - only qrUri and expiresAt.
    expect(result).toEqual({ qrUri: 'kangentic-pair://mock', expiresAt: '2026-01-01T00:10:00.000Z' });
  });

  it('MOBILE_CANCEL_PAIRING forwards to service.cancelPairing() with no arguments', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    invokeHandler(IPC.MOBILE_CANCEL_PAIRING);

    expect(context.mobileBridgeService.cancelPairing).toHaveBeenCalledWith();
  });

  it('MOBILE_LIST_DEVICES forwards to service.listDevices() and returns its result verbatim', () => {
    const context = makeContext();
    const seeded = [{ deviceId: 'd1', displayName: 'Phone', capabilities: [], pairedAt: '2026-01-01T00:00:00.000Z' }];
    context.mobileBridgeService.listDevices.mockReturnValue(seeded);
    registerMobileBridgeHandlers(context);

    const result = invokeHandler(IPC.MOBILE_LIST_DEVICES);

    expect(result).toBe(seeded);
  });

  it('MOBILE_REVOKE_DEVICE forwards the deviceId to service.revokeDevice()', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    invokeHandler(IPC.MOBILE_REVOKE_DEVICE, 'device-123');

    expect(context.mobileBridgeService.revokeDevice).toHaveBeenCalledWith('device-123');
  });

  it('MOBILE_RENAME_DEVICE forwards the deviceId and new display name to service.renameDevice()', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    invokeHandler(IPC.MOBILE_RENAME_DEVICE, 'device-123', 'New Name');

    expect(context.mobileBridgeService.renameDevice).toHaveBeenCalledWith('device-123', 'New Name');
  });

  it('MOBILE_SET_DEVICE_CAPABILITIES forwards deviceId and capabilities to service.setDeviceCapabilities()', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    invokeHandler(IPC.MOBILE_SET_DEVICE_CAPABILITIES, 'device-123', ['read-stream']);

    expect(context.mobileBridgeService.setDeviceCapabilities).toHaveBeenCalledWith('device-123', ['read-stream']);
  });
});

describe('registerMobileBridgeHandlers - push events', () => {
  beforeEach(() => {
    capturedHandlers.clear();
  });

  it('forwards a pairingSas event to the renderer with the reshaped payload (drops the emoji field, if the service happened to still emit one)', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingSas', {
      sas: { digits: '123456', emoji: ['star', 'rocket'] },
      phoneStaticPublicKeyHex: 'deadbeef',
    });

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.MOBILE_PAIRING_SAS, {
      digits: '123456',
      phoneStaticPublicKeyHex: 'deadbeef',
    });
  });

  it('does NOT forward a pairingSas event when the main window is destroyed', () => {
    const context = makeContext({ isDestroyed: true });
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingSas', {
      sas: { digits: '123456' },
      phoneStaticPublicKeyHex: 'deadbeef',
    });

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('forwards a pairingConfirmed event to the renderer verbatim', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingConfirmed', { deviceId: 'device-123', displayName: 'Pixel 10' });

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.MOBILE_PAIRING_CONFIRMED, {
      deviceId: 'device-123',
      displayName: 'Pixel 10',
    });
  });

  it('does NOT forward a pairingConfirmed event when the main window is destroyed', () => {
    const context = makeContext({ isDestroyed: true });
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingConfirmed', { deviceId: 'device-123', displayName: 'Pixel 10' });

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('forwards a pairingEnded event to the renderer verbatim, including kind', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingEnded', { reason: 'Cancelled by user', kind: 'cancelled' });

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.MOBILE_PAIRING_ENDED, { reason: 'Cancelled by user', kind: 'cancelled' });
  });

  it('does NOT forward a pairingEnded event when the main window is destroyed', () => {
    const context = makeContext({ isDestroyed: true });
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingEnded', { reason: 'timeout', kind: 'failed' });

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('forwards a stateChanged event to the renderer with no payload', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('stateChanged');

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.MOBILE_STATE_CHANGED);
  });

  it('does NOT forward a stateChanged event when the main window is destroyed', () => {
    const context = makeContext({ isDestroyed: true });
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('stateChanged');

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MOBILE_TEST_RELAY: structurally a probe (mirrors handlers/system.ts's
// AGENT_PROBE_EXECUTION_SERVER), not a service delegation - it validates and
// fetches a candidate URL directly, using the real validateRelayUrl /
// relayHealthUrl from src/shared/relay.ts (pure functions, safe to exercise
// for real) with a stubbed global fetch. Every case below must resolve, never
// throw or hang.
// ---------------------------------------------------------------------------

describe('registerMobileBridgeHandlers - MOBILE_TEST_RELAY', () => {
  beforeEach(() => {
    capturedHandlers.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an invalid relay URL server-side without ever calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = await invokeHandler(IPC.MOBILE_TEST_RELAY, 'not a url');

    expect(result).toMatchObject({ reachable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback ws:// relay URL server-side, even if the renderer sent it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = (await invokeHandler(IPC.MOBILE_TEST_RELAY, 'ws://not-loopback.example.com')) as { reachable: boolean; reason?: string };

    expect(result.reachable).toBe(false);
    expect(result.reason).toMatch(/TLS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports unreachable when fetch rejects (host unreachable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = await invokeHandler(IPC.MOBILE_TEST_RELAY, 'wss://relay.example.com');

    expect(result).toEqual({ reachable: false, reason: 'ECONNREFUSED' });
  });

  it('reports unreachable when the request times out (AbortSignal fires)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted.', 'AbortError'); }));
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = (await invokeHandler(IPC.MOBILE_TEST_RELAY, 'wss://relay.example.com')) as { reachable: boolean; reason?: string };

    expect(result.reachable).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('reports unreachable with the HTTP status on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = await invokeHandler(IPC.MOBILE_TEST_RELAY, 'wss://relay.example.com');

    expect(result).toEqual({ reachable: false, reason: 'Relay responded with HTTP 503' });
  });

  it('reports reachable with a null version when the body is not JSON (version is optional in the /healthz body)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); } })));
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = await invokeHandler(IPC.MOBILE_TEST_RELAY, 'wss://relay.example.com');

    // expect.any(Number), not a lower bound: the stubbed fetch resolves in the
    // same tick, so the measured latency is legitimately 0 here.
    expect(result).toEqual({ reachable: true, version: null, latencyMs: expect.any(Number) });
    // Math.round must actually run: a raw performance.now() delta is a float
    // in the general case, and expect.any(Number) above passes for either, so
    // it would not catch Math.round being dropped from the handler.
    expect(Number.isInteger((result as { latencyMs: number }).latencyMs)).toBe(true);
  });

  it('reports reachable with the version when the body provides one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version: '0.4.0' }) })));
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = await invokeHandler(IPC.MOBILE_TEST_RELAY, 'wss://relay.example.com');

    expect(result).toEqual({ reachable: true, version: '0.4.0', latencyMs: expect.any(Number) });
  });

  it('reports no latency on an unreachable relay (there is no response to have timed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    const result = await invokeHandler(IPC.MOBILE_TEST_RELAY, 'wss://relay.example.com');

    expect(result).not.toHaveProperty('latencyMs');
  });

  it('probes relayHealthUrl(normalized), not the raw input', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    await invokeHandler(IPC.MOBILE_TEST_RELAY, 'WSS://Relay.Example.com');

    expect(fetchMock).toHaveBeenCalledWith('https://relay.example.com/healthz', expect.anything());
  });
});
