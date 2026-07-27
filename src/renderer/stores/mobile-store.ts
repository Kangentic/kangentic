import { create } from 'zustand';
import type {
  MobileBridgeStatus,
  MobileCapabilityVerb,
  MobilePairedDevice,
  MobilePairingConfirmedPayload,
  MobilePairingSasPayload,
  MobileStartPairingResult,
} from '../../shared/types';

/**
 * Identify the newest in-flight listDevices() / getStatus() so an older reply
 * cannot clobber a newer one. 'stateChanged' fires loadStatus() and
 * loadDevices() unsequenced, and the main process now notifies on every
 * per-device connection change (not just when the panel-wide aggregate moves),
 * so overlapping fetches are routine rather than exotic - and an out-of-order
 * reply would reintroduce exactly the stale-badge symptom this store exists to
 * avoid. Both loaders are guarded, so neither reads as protected merely by
 * sitting next to one that is.
 *
 * Preserved across HMR (Pattern A), matching moveGeneration in
 * board-store/task-slice.ts: it keeps the counters monotonic across a dev
 * session rather than resetting to 0 on every Fast Refresh. It does NOT protect
 * a reply already in flight when the module is replaced - that reply's own
 * staleness check closes over the OLD module's binding, whatever this one seeds
 * itself with.
 */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let latestDevicesRequestId: number = import.meta.hot?.data?.latestDevicesRequestId ?? 0;
// @ts-expect-error -- Vite handles import.meta.hot
let latestStatusRequestId: number = import.meta.hot?.data?.latestStatusRequestId ?? 0;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.latestDevicesRequestId = latestDevicesRequestId;
    data.latestStatusRequestId = latestStatusRequestId;
  });
}

/**
 * Backs the Mobile Devices settings tab. Machine-global (not project-scoped),
 * matching the mobile bridge itself. Pairing push events (SAS, confirmed,
 * ended) are NOT subscribed here - the tab component owns that
 * subscription via a useEffect tied to its own mount lifecycle (it is the
 * only consumer), and calls setPairingSas/setPairingConfirmed/clearPairingSas/setPairingEnded
 * to reflect them into this store.
 */
interface MobileStore {
  status: MobileBridgeStatus | null;
  devices: MobilePairedDevice[];
  loading: boolean;
  pairingSas: MobilePairingSasPayload | null;
  pairingConfirmed: MobilePairingConfirmedPayload | null;
  pairingEndedReason: string | null;

  loadStatus: () => Promise<void>;
  loadDevices: () => Promise<void>;
  startPairing: () => Promise<MobileStartPairingResult>;
  cancelPairing: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;
  renameDevice: (deviceId: string, displayName: string) => Promise<void>;
  setDeviceCapabilities: (deviceId: string, capabilities: MobileCapabilityVerb[]) => Promise<void>;

  setPairingSas: (payload: MobilePairingSasPayload) => void;
  clearPairingSas: () => void;
  setPairingConfirmed: (payload: MobilePairingConfirmedPayload) => void;
  clearPairingConfirmed: () => void;
  setPairingEnded: (reason: string) => void;
  clearPairingEnded: () => void;
}

export const useMobileStore = create<MobileStore>((set, get) => ({
  status: null,
  devices: [],
  loading: false,
  pairingSas: null,
  pairingConfirmed: null,
  pairingEndedReason: null,

  loadStatus: async () => {
    latestStatusRequestId += 1;
    const requestId = latestStatusRequestId;
    const status = await window.electronAPI.mobile.getStatus();
    // A newer fetch superseded this one while it was in flight.
    if (requestId !== latestStatusRequestId) return;
    set({ status });
  },

  loadDevices: async () => {
    latestDevicesRequestId += 1;
    const requestId = latestDevicesRequestId;
    const devices = await window.electronAPI.mobile.listDevices();
    // A newer fetch was issued while this one was in flight; its reply is the
    // current truth, so drop this one rather than overwriting with older data.
    if (requestId !== latestDevicesRequestId) return;
    set({ devices });
  },

  startPairing: async () => {
    set({ loading: true, pairingSas: null, pairingConfirmed: null, pairingEndedReason: null });
    try {
      const result = await window.electronAPI.mobile.startPairing();
      await get().loadStatus();
      return result;
    } finally {
      set({ loading: false });
    }
  },

  cancelPairing: async () => {
    await window.electronAPI.mobile.cancelPairing();
    set({ pairingSas: null });
    await get().loadStatus();
  },

  revokeDevice: async (deviceId) => {
    await window.electronAPI.mobile.revokeDevice(deviceId);
    await Promise.all([get().loadDevices(), get().loadStatus()]);
  },

  renameDevice: async (deviceId, displayName) => {
    await window.electronAPI.mobile.renameDevice(deviceId, displayName);
    await get().loadDevices();
  },

  setDeviceCapabilities: async (deviceId, capabilities) => {
    await window.electronAPI.mobile.setDeviceCapabilities(deviceId, capabilities);
    await get().loadDevices();
  },

  setPairingSas: (payload) => set({ pairingSas: payload }),
  clearPairingSas: () => set({ pairingSas: null }),
  setPairingConfirmed: (payload) => set({ pairingSas: null, pairingConfirmed: payload }),
  clearPairingConfirmed: () => set({ pairingConfirmed: null }),
  setPairingEnded: (reason) => set({ pairingEndedReason: reason }),
  clearPairingEnded: () => set({ pairingEndedReason: null }),
}));
