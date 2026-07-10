/**
 * Unit tests for src/main/ipc/handlers/mobile-bridge.ts.
 *
 * Every other mobile-bridge test file (mobile-bridge-service.test.ts,
 * pairing-service.test.ts, etc.) exercises MobileBridgeService directly.
 * Nothing exercised the IPC handler layer itself: whether each channel
 * forwards to the right service method with the right arguments and shapes
 * its return value correctly, and whether the three push-event listeners
 * (pairingSas, pairingEnded, stateChanged) forward the service's emitted
 * payloads to the renderer and honor the mainWindow.isDestroyed() guard
 * documented on every other push-event handler in the codebase.
 *
 * Strategy mirrors config-handler-wiring.test.ts: mock electron's ipcMain to
 * capture registered handlers, build a fake MobileBridgeService (a real
 * EventEmitter so service.on(...) wiring is exercised for real, with spied
 * methods), then invoke the captured handlers directly.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  }));
  startPairing = vi.fn(async () => ({
    qrPayload: { expiresAt: '2026-01-01T00:10:00.000Z' } as { expiresAt: string },
    qrUri: 'kangentic-pair://mock',
  }));
  confirmPairing = vi.fn();
  cancelPairing = vi.fn();
  listDevices = vi.fn(() => []);
  revokeDevice = vi.fn();
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

  it('MOBILE_CONFIRM_PAIRING forwards displayName and capabilities to service.confirmPairing()', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    invokeHandler(IPC.MOBILE_CONFIRM_PAIRING, "Tyler's Phone", ['read-board', 'move-task']);

    expect(context.mobileBridgeService.confirmPairing).toHaveBeenCalledWith("Tyler's Phone", ['read-board', 'move-task']);
  });

  it('MOBILE_CONFIRM_PAIRING forwards an omitted capabilities arg as undefined (service applies its own default)', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    invokeHandler(IPC.MOBILE_CONFIRM_PAIRING, 'Paired Device');

    expect(context.mobileBridgeService.confirmPairing).toHaveBeenCalledWith('Paired Device', undefined);
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

  it('forwards a pairingSas event to the renderer with the reshaped payload (drops any extra service fields)', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingSas', {
      sas: { digits: '123456', emoji: ['star', 'rocket'] },
      phoneStaticPublicKeyHex: 'deadbeef',
    });

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.MOBILE_PAIRING_SAS, {
      digits: '123456',
      emoji: ['star', 'rocket'],
      phoneStaticPublicKeyHex: 'deadbeef',
    });
  });

  it('does NOT forward a pairingSas event when the main window is destroyed', () => {
    const context = makeContext({ isDestroyed: true });
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingSas', {
      sas: { digits: '123456', emoji: [] },
      phoneStaticPublicKeyHex: 'deadbeef',
    });

    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('forwards a pairingEnded event to the renderer verbatim', () => {
    const context = makeContext();
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingEnded', { reason: 'Cancelled by user' });

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.MOBILE_PAIRING_ENDED, { reason: 'Cancelled by user' });
  });

  it('does NOT forward a pairingEnded event when the main window is destroyed', () => {
    const context = makeContext({ isDestroyed: true });
    registerMobileBridgeHandlers(context);

    context.mobileBridgeService.emit('pairingEnded', { reason: 'timeout' });

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
