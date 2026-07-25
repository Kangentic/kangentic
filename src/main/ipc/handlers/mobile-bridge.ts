import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { relayHealthUrl, validateRelayUrl } from '../../../shared/relay';
import type {
  MobileBridgeStatus,
  MobileCapabilityVerb,
  MobilePairedDevice,
  MobilePairingConfirmedPayload,
  MobilePairingEndedPayload,
  MobilePairingSasPayload,
  MobileStartPairingResult,
  RemoteServerStatus,
} from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/** "Test connection" in the Mobile Devices tab must never hang against a black-holed relay. */
const RELAY_TEST_TIMEOUT_MS = 5000;

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

  ipcMain.handle(IPC.MOBILE_CANCEL_PAIRING, () => {
    service.cancelPairing();
  });

  ipcMain.handle(IPC.MOBILE_LIST_DEVICES, (): MobilePairedDevice[] => service.listDevices());

  ipcMain.handle(IPC.MOBILE_REVOKE_DEVICE, (_event, deviceId: string) => {
    service.revokeDevice(deviceId);
  });

  ipcMain.handle(IPC.MOBILE_RENAME_DEVICE, (_event, deviceId: string, displayName: string) => {
    service.renameDevice(deviceId, displayName);
  });

  ipcMain.handle(IPC.MOBILE_SET_DEVICE_CAPABILITIES, (_event, deviceId: string, capabilities: MobileCapabilityVerb[]) => {
    service.setDeviceCapabilities(deviceId, capabilities);
  });

  // Structurally a probe (mirrors AGENT_PROBE_EXECUTION_SERVER in
  // handlers/system.ts), not a service delegation like this file's other
  // handlers - it validates and fetches a candidate URL rather than reading
  // or touching MobileBridgeService state. Takes the URL as an argument
  // since testing BEFORE committing a save is the point, so it re-runs
  // validateRelayUrl server-side rather than trusting the renderer's input.
  // Never throws: every failure mode resolves to { reachable: false, reason }.
  ipcMain.handle(IPC.MOBILE_TEST_RELAY, async (_event, relayUrl: string): Promise<RemoteServerStatus> => {
    const validation = validateRelayUrl(relayUrl);
    if (!validation.ok) return { reachable: false, reason: validation.reason };
    try {
      const response = await fetch(relayHealthUrl(validation.normalized), {
        method: 'GET',
        signal: AbortSignal.timeout(RELAY_TEST_TIMEOUT_MS),
      });
      if (!response.ok) return { reachable: false, reason: `Relay responded with HTTP ${response.status}` };
      // Any 2xx counts as reachable: the relay's documented /healthz contract
      // is `{"status":"ok"}` with no version field, so requiring one would
      // report a working relay as unreachable.
      const body = (await response.json().catch(() => null)) as { version?: string } | null;
      return { reachable: true, version: body?.version ?? null };
    } catch (error) {
      return { reachable: false, reason: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  const sendIfWindowAlive = (channel: string, ...args: unknown[]): void => {
    if (!context.mainWindow.isDestroyed()) context.mainWindow.webContents.send(channel, ...args);
  };

  service.on('pairingSas', (payload: { sas: { digits: string }; phoneStaticPublicKeyHex: string }) => {
    const pushPayload: MobilePairingSasPayload = {
      digits: payload.sas.digits,
      phoneStaticPublicKeyHex: payload.phoneStaticPublicKeyHex,
    };
    sendIfWindowAlive(IPC.MOBILE_PAIRING_SAS, pushPayload);
  });

  service.on('pairingConfirmed', (payload: MobilePairingConfirmedPayload) => {
    sendIfWindowAlive(IPC.MOBILE_PAIRING_CONFIRMED, payload);
  });

  service.on('pairingEnded', (payload: MobilePairingEndedPayload) => {
    sendIfWindowAlive(IPC.MOBILE_PAIRING_ENDED, payload);
  });

  service.on('stateChanged', () => {
    sendIfWindowAlive(IPC.MOBILE_STATE_CHANGED);
  });
}
