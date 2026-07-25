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
    const status = await window.electronAPI.mobile.getStatus();
    set({ status });
  },

  loadDevices: async () => {
    const devices = await window.electronAPI.mobile.listDevices();
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
