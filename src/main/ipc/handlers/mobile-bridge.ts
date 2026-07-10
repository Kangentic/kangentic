import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type {
  MobileBridgeStatus,
  MobileCapabilityVerb,
  MobilePairedDevice,
  MobilePairingEndedPayload,
  MobilePairingSasPayload,
  MobileStartPairingResult,
} from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Machine-global, not project-scoped - these channels take no trailing
 * projectId and are unaffected by the project-scoped-ipc mutation set
 * (see .claude/rules/project-scoped-ipc.md).
 */
export function registerMobileBridgeHandlers(context: IpcContext): void {
  const service = context.mobileBridgeService;

  ipcMain.handle(IPC.MOBILE_GET_STATUS, (): MobileBridgeStatus => service.getStatus());

  ipcMain.handle(IPC.MOBILE_START_PAIRING, async (): Promise<MobileStartPairingResult> => {
    const { qrUri, qrPayload } = await service.startPairing();
    return { qrUri, expiresAt: qrPayload.expiresAt };
  });

  ipcMain.handle(IPC.MOBILE_CONFIRM_PAIRING, (_event, displayName: string, capabilities?: MobileCapabilityVerb[]) => {
    service.confirmPairing(displayName, capabilities);
  });

  ipcMain.handle(IPC.MOBILE_CANCEL_PAIRING, () => {
    service.cancelPairing();
  });

  ipcMain.handle(IPC.MOBILE_LIST_DEVICES, (): MobilePairedDevice[] => service.listDevices());

  ipcMain.handle(IPC.MOBILE_REVOKE_DEVICE, (_event, deviceId: string) => {
    service.revokeDevice(deviceId);
  });

  ipcMain.handle(IPC.MOBILE_SET_DEVICE_CAPABILITIES, (_event, deviceId: string, capabilities: MobileCapabilityVerb[]) => {
    service.setDeviceCapabilities(deviceId, capabilities);
  });

  const sendIfWindowAlive = (channel: string, ...args: unknown[]): void => {
    if (!context.mainWindow.isDestroyed()) context.mainWindow.webContents.send(channel, ...args);
  };

  service.on('pairingSas', (payload: { sas: { digits: string; emoji: string[] }; phoneStaticPublicKeyHex: string }) => {
    const pushPayload: MobilePairingSasPayload = {
      digits: payload.sas.digits,
      emoji: payload.sas.emoji,
      phoneStaticPublicKeyHex: payload.phoneStaticPublicKeyHex,
    };
    sendIfWindowAlive(IPC.MOBILE_PAIRING_SAS, pushPayload);
  });

  service.on('pairingEnded', (payload: MobilePairingEndedPayload) => {
    sendIfWindowAlive(IPC.MOBILE_PAIRING_ENDED, payload);
  });

  service.on('stateChanged', () => {
    sendIfWindowAlive(IPC.MOBILE_STATE_CHANGED);
  });
}
