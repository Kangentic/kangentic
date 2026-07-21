/**
 * Unit tests for src/renderer/stores/mobile-store.ts.
 *
 * tests/ui/mobile-devices-settings.spec.ts already exercises this store
 * end-to-end through MobileDevicesTab and a real headless mock-electron-api,
 * but only reaches the branches the component happens to touch through DOM
 * interactions. This file drives the store directly to pin the contract
 * pieces the UI spec does not assert on:
 *  - startPairing() resets pairingSas/pairingEndedReason to null on entry
 *    (so a stale error from a PREVIOUS failed ceremony doesn't linger under
 *    the new QR) and toggles `loading` around the call, including on a
 *    rejected startPairing (the `finally` branch).
 *  - confirmPairing() clears pairingSas and reloads devices+status in
 *    parallel (both IPC calls happen, not just one).
 *  - cancelPairing() clears pairingSas and reloads status only (not
 *    devices - cancelling never changes the device list).
 *  - revokeDevice() reloads BOTH devices and status (status.pairedDeviceCount
 *    must drop).
 *  - setDeviceCapabilities() reloads devices only, NOT status - the one
 *    asymmetric case in this store, easy to get wrong by copy-pasting
 *    revokeDevice's Promise.all.
 *  - the four pure push-event reducers (setPairingSas/clearPairingSas/
 *    setPairingEnded/clearPairingEnded) mutate exactly the field they name.
 *
 * window.electronAPI.mobile is stubbed globally before importing the store,
 * mirroring session-store-rate-limits.test.ts's pattern for a Node
 * (non-jsdom) test environment.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MobileBridgeStatus, MobilePairedDevice, MobileStartPairingResult } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub window.electronAPI.mobile before importing the store.
// ---------------------------------------------------------------------------

const getStatusMock = vi.fn<() => Promise<MobileBridgeStatus>>();
const listDevicesMock = vi.fn<() => Promise<MobilePairedDevice[]>>();
const startPairingMock = vi.fn<() => Promise<MobileStartPairingResult>>();
const confirmPairingMock = vi.fn<() => Promise<void>>();
const cancelPairingMock = vi.fn<() => Promise<void>>();
const revokeDeviceMock = vi.fn<() => Promise<void>>();
const setDeviceCapabilitiesMock = vi.fn<() => Promise<void>>();

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    mobile: {
      getStatus: getStatusMock,
      listDevices: listDevicesMock,
      startPairing: startPairingMock,
      confirmPairing: confirmPairingMock,
      cancelPairing: cancelPairingMock,
      revokeDevice: revokeDeviceMock,
      setDeviceCapabilities: setDeviceCapabilitiesMock,
    },
  },
};

// Import after the global stub so the store module sees the mocked window.
import { useMobileStore } from '../../src/renderer/stores/mobile-store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStatus(overrides: Partial<MobileBridgeStatus> = {}): MobileBridgeStatus {
  return {
    enabled: true,
    secureStorageAvailable: true,
    identityFingerprint: 'deadbeef',
    relayUrl: 'wss://relay.example.com',
    relayState: 'idle',
    pairedDeviceCount: 0,
    pairingInProgress: false,
    ...overrides,
  };
}

function makeDevice(overrides: Partial<MobilePairedDevice> = {}): MobilePairedDevice {
  return {
    deviceId: 'device-1',
    displayName: 'Test Phone',
    capabilities: ['read-board'],
    pairedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function resetStore(): void {
  useMobileStore.setState({
    status: null,
    devices: [],
    loading: false,
    pairingSas: null,
    pairingEndedReason: null,
  });
}

beforeEach(() => {
  resetStore();
  getStatusMock.mockReset().mockResolvedValue(makeStatus());
  listDevicesMock.mockReset().mockResolvedValue([]);
  startPairingMock.mockReset().mockResolvedValue({ qrUri: 'kangentic-pair://mock', expiresAt: '2026-01-01T00:10:00.000Z' });
  confirmPairingMock.mockReset().mockResolvedValue(undefined);
  cancelPairingMock.mockReset().mockResolvedValue(undefined);
  revokeDeviceMock.mockReset().mockResolvedValue(undefined);
  setDeviceCapabilitiesMock.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// loadStatus / loadDevices
// ---------------------------------------------------------------------------

describe('loadStatus / loadDevices', () => {
  it('loadStatus() writes the resolved status into state', async () => {
    const status = makeStatus({ pairedDeviceCount: 3 });
    getStatusMock.mockResolvedValue(status);

    await useMobileStore.getState().loadStatus();

    expect(useMobileStore.getState().status).toEqual(status);
  });

  it('loadDevices() writes the resolved device list into state', async () => {
    const devices = [makeDevice(), makeDevice({ deviceId: 'device-2' })];
    listDevicesMock.mockResolvedValue(devices);

    await useMobileStore.getState().loadDevices();

    expect(useMobileStore.getState().devices).toEqual(devices);
  });
});

// ---------------------------------------------------------------------------
// startPairing
// ---------------------------------------------------------------------------

describe('startPairing()', () => {
  it('clears a stale pairingSas/pairingEndedReason from a previous ceremony before starting', async () => {
    useMobileStore.setState({
      pairingSas: { digits: '000000', emoji: [], phoneStaticPublicKeyHex: 'stale' },
      pairingEndedReason: 'Previous ceremony timed out',
    });

    await useMobileStore.getState().startPairing();

    expect(useMobileStore.getState().pairingSas).toBeNull();
    expect(useMobileStore.getState().pairingEndedReason).toBeNull();
  });

  it('sets loading true for the duration of the call and false once it resolves', async () => {
    let loadingDuringCall: boolean | undefined;
    startPairingMock.mockImplementation(async () => {
      loadingDuringCall = useMobileStore.getState().loading;
      return { qrUri: 'kangentic-pair://mock', expiresAt: '2026-01-01T00:10:00.000Z' };
    });

    expect(useMobileStore.getState().loading).toBe(false);
    await useMobileStore.getState().startPairing();

    expect(loadingDuringCall).toBe(true);
    expect(useMobileStore.getState().loading).toBe(false);
  });

  it('clears loading via the finally branch even when startPairing() rejects', async () => {
    startPairingMock.mockRejectedValue(new Error('relay unreachable'));

    await expect(useMobileStore.getState().startPairing()).rejects.toThrow('relay unreachable');

    expect(useMobileStore.getState().loading).toBe(false);
  });

  it('reloads status after a successful startPairing() (pairingInProgress flips to true)', async () => {
    getStatusMock.mockResolvedValue(makeStatus({ pairingInProgress: true }));

    await useMobileStore.getState().startPairing();

    expect(useMobileStore.getState().status?.pairingInProgress).toBe(true);
  });

  it('returns the IPC result to the caller', async () => {
    const result = await useMobileStore.getState().startPairing();
    expect(result).toEqual({ qrUri: 'kangentic-pair://mock', expiresAt: '2026-01-01T00:10:00.000Z' });
  });
});

// ---------------------------------------------------------------------------
// confirmPairing
// ---------------------------------------------------------------------------

describe('confirmPairing()', () => {
  it('forwards displayName and capabilities to the IPC call', async () => {
    await useMobileStore.getState().confirmPairing('My Phone', ['read-board', 'move-task']);
    expect(confirmPairingMock).toHaveBeenCalledWith('My Phone', ['read-board', 'move-task']);
  });

  it('clears pairingSas', async () => {
    useMobileStore.setState({ pairingSas: { digits: '123456', emoji: [], phoneStaticPublicKeyHex: 'abc' } });

    await useMobileStore.getState().confirmPairing('My Phone');

    expect(useMobileStore.getState().pairingSas).toBeNull();
  });

  it('reloads BOTH devices and status', async () => {
    const devices = [makeDevice({ displayName: 'My Phone' })];
    const status = makeStatus({ pairedDeviceCount: 1 });
    listDevicesMock.mockResolvedValue(devices);
    getStatusMock.mockResolvedValue(status);

    await useMobileStore.getState().confirmPairing('My Phone');

    expect(listDevicesMock).toHaveBeenCalledTimes(1);
    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(useMobileStore.getState().devices).toEqual(devices);
    expect(useMobileStore.getState().status).toEqual(status);
  });
});

// ---------------------------------------------------------------------------
// cancelPairing
// ---------------------------------------------------------------------------

describe('cancelPairing()', () => {
  it('clears pairingSas and reloads status, but does NOT reload devices', async () => {
    useMobileStore.setState({ pairingSas: { digits: '654321', emoji: [], phoneStaticPublicKeyHex: 'def' } });

    await useMobileStore.getState().cancelPairing();

    expect(useMobileStore.getState().pairingSas).toBeNull();
    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(listDevicesMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// revokeDevice
// ---------------------------------------------------------------------------

describe('revokeDevice()', () => {
  it('forwards the deviceId to the IPC call and reloads BOTH devices and status', async () => {
    getStatusMock.mockResolvedValue(makeStatus({ pairedDeviceCount: 0 }));
    listDevicesMock.mockResolvedValue([]);

    await useMobileStore.getState().revokeDevice('device-1');

    expect(revokeDeviceMock).toHaveBeenCalledWith('device-1');
    expect(listDevicesMock).toHaveBeenCalledTimes(1);
    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(useMobileStore.getState().status?.pairedDeviceCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setDeviceCapabilities - the asymmetric case
// ---------------------------------------------------------------------------

describe('setDeviceCapabilities()', () => {
  it('forwards deviceId and capabilities to the IPC call', async () => {
    await useMobileStore.getState().setDeviceCapabilities('device-1', ['read-stream']);
    expect(setDeviceCapabilitiesMock).toHaveBeenCalledWith('device-1', ['read-stream']);
  });

  it('reloads devices but does NOT reload status (unlike revokeDevice/confirmPairing)', async () => {
    await useMobileStore.getState().setDeviceCapabilities('device-1', ['read-stream']);

    expect(listDevicesMock).toHaveBeenCalledTimes(1);
    expect(getStatusMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pure push-event reducers
// ---------------------------------------------------------------------------

describe('push-event reducers', () => {
  it('setPairingSas() writes the payload without touching other fields', () => {
    useMobileStore.setState({ pairingEndedReason: 'unrelated' });
    const payload = { digits: '111222', emoji: ['star'], phoneStaticPublicKeyHex: 'abc' };

    useMobileStore.getState().setPairingSas(payload);

    expect(useMobileStore.getState().pairingSas).toEqual(payload);
    expect(useMobileStore.getState().pairingEndedReason).toBe('unrelated');
  });

  it('clearPairingSas() resets pairingSas to null', () => {
    useMobileStore.setState({ pairingSas: { digits: '111222', emoji: [], phoneStaticPublicKeyHex: 'abc' } });

    useMobileStore.getState().clearPairingSas();

    expect(useMobileStore.getState().pairingSas).toBeNull();
  });

  it('setPairingEnded() writes the reason without touching pairingSas', () => {
    useMobileStore.setState({ pairingSas: { digits: '111222', emoji: [], phoneStaticPublicKeyHex: 'abc' } });

    useMobileStore.getState().setPairingEnded('Device declined pairing');

    expect(useMobileStore.getState().pairingEndedReason).toBe('Device declined pairing');
    expect(useMobileStore.getState().pairingSas).not.toBeNull();
  });

  it('clearPairingEnded() resets pairingEndedReason to null', () => {
    useMobileStore.setState({ pairingEndedReason: 'some reason' });

    useMobileStore.getState().clearPairingEnded();

    expect(useMobileStore.getState().pairingEndedReason).toBeNull();
  });
});
