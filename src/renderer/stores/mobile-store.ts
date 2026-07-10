import { create } from 'zustand';
import type {
  MobileBridgeStatus,
  MobileCapabilityVerb,
  MobilePairedDevice,
  MobilePairingSasPayload,
  MobileStartPairingResult,
} from '../../shared/types';

/**
 * Backs the Mobile Devices settings tab. Machine-global (not project-scoped),
 * matching the mobile bridge itself. Pairing push events (SAS, pairing
 * ended) are NOT subscribed here - the tab component owns that
 * subscription via a useEffect tied to its own mount lifecycle (it is the
 * only consumer), and calls setPairingSas/clearPairingSas/setPairingEnded
 * to reflect them into this store.
 */
interface MobileStore {
  status: MobileBridgeStatus | null;
  devices: MobilePairedDevice[];
  loading: boolean;
  pairingSas: MobilePairingSasPayload | null;
  pairingEndedReason: string | null;

  loadStatus: () => Promise<void>;
  loadDevices: () => Promise<void>;
  startPairing: () => Promise<MobileStartPairingResult>;
  confirmPairing: (displayName: string, capabilities?: MobileCapabilityVerb[]) => Promise<void>;
  cancelPairing: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;
  setDeviceCapabilities: (deviceId: string, capabilities: MobileCapabilityVerb[]) => Promise<void>;

  setPairingSas: (payload: MobilePairingSasPayload) => void;
  clearPairingSas: () => void;
  setPairingEnded: (reason: string) => void;
  clearPairingEnded: () => void;
}

export const useMobileStore = create<MobileStore>((set, get) => ({
  status: null,
  devices: [],
  loading: false,
  pairingSas: null,
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
    set({ loading: true, pairingSas: null, pairingEndedReason: null });
    try {
      const result = await window.electronAPI.mobile.startPairing();
      await get().loadStatus();
      return result;
    } finally {
      set({ loading: false });
    }
  },

  confirmPairing: async (displayName, capabilities) => {
    await window.electronAPI.mobile.confirmPairing(displayName, capabilities);
    set({ pairingSas: null });
    await Promise.all([get().loadDevices(), get().loadStatus()]);
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

  setDeviceCapabilities: async (deviceId, capabilities) => {
    await window.electronAPI.mobile.setDeviceCapabilities(deviceId, capabilities);
    await get().loadDevices();
  },

  setPairingSas: (payload) => set({ pairingSas: payload }),
  clearPairingSas: () => set({ pairingSas: null }),
  setPairingEnded: (reason) => set({ pairingEndedReason: reason }),
  clearPairingEnded: () => set({ pairingEndedReason: null }),
}));
