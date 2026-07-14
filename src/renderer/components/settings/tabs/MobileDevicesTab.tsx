import { useEffect, useState } from 'react';
import { Check, Copy, QrCode, Smartphone, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { MOBILE_CAPABILITY_VERBS, type AppConfig, type MobileCapabilityVerb, type MobilePairedDevice } from '../../../../shared/types';
import { CompactToggleList, INPUT_CLASS, SectionHeader, SettingRow, SettingToggleRow, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { useMobileStore } from '../../../stores/mobile-store';

/** Short label + blurb per verb, for the per-device capability toggle list. Keyed off MOBILE_CAPABILITY_VERBS so a new verb is a compile error here until classified. */
const CAPABILITY_LABELS: Record<MobileCapabilityVerb, { label: string; description: string }> = {
  'read-stream': { label: 'Live output', description: 'Terminal output and activity for running sessions' },
  'read-board': { label: 'Board', description: 'View tasks, columns, and backlog' },
  'read-diff': { label: 'Diffs', description: 'View code changes' },
  'send-user-message': { label: 'Send messages', description: 'Send a message to a running agent' },
  'move-task': { label: 'Move tasks', description: 'Move tasks between columns' },
  'answer-permission-prompt': { label: 'Answer prompts', description: 'Approve or deny an agent permission request' },
  'interactive-terminal': { label: 'Interactive terminal', description: 'Full keystroke control of the running terminal' },
  'board-tool-read': { label: 'Task details', description: 'Search tasks and read stats, transcripts, and handoff notes' },
  'board-tool-write': { label: 'Task actions', description: 'Create, edit, and delete tasks or backlog items, link PRs' },
};

export function MobileDevicesTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const enabled = globalConfig.mobileBridge?.enabled ?? false;
  const relayUrl = globalConfig.mobileBridge?.relayUrl ?? '';

  const status = useMobileStore((state) => state.status);
  const devices = useMobileStore((state) => state.devices);
  const loading = useMobileStore((state) => state.loading);
  const pairingSas = useMobileStore((state) => state.pairingSas);
  const pairingEndedReason = useMobileStore((state) => state.pairingEndedReason);
  const loadStatus = useMobileStore((state) => state.loadStatus);
  const loadDevices = useMobileStore((state) => state.loadDevices);
  const startPairing = useMobileStore((state) => state.startPairing);
  const confirmPairing = useMobileStore((state) => state.confirmPairing);
  const cancelPairing = useMobileStore((state) => state.cancelPairing);
  const revokeDevice = useMobileStore((state) => state.revokeDevice);
  const setDeviceCapabilities = useMobileStore((state) => state.setDeviceCapabilities);
  const setPairingSas = useMobileStore((state) => state.setPairingSas);
  const setPairingEnded = useMobileStore((state) => state.setPairingEnded);
  const clearPairingEnded = useMobileStore((state) => state.clearPairingEnded);

  const [qrUri, setQrUri] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [deviceNameDraft, setDeviceNameDraft] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<{ deviceId: string; displayName: string } | null>(null);

  useEffect(() => {
    void loadStatus();
    void loadDevices();
  }, [loadStatus, loadDevices]);

  useEffect(() => {
    const unsubscribeSas = window.electronAPI.mobile.onPairingSas((payload) => {
      setPairingSas(payload);
    });
    const unsubscribeEnded = window.electronAPI.mobile.onPairingEnded((payload) => {
      setPairingEnded(payload.reason);
      setQrUri(null);
      setQrDataUrl(null);
    });
    const unsubscribeState = window.electronAPI.mobile.onStateChanged(() => {
      void loadStatus();
      void loadDevices();
    });
    return () => {
      unsubscribeSas();
      unsubscribeEnded();
      unsubscribeState();
    };
  }, [loadStatus, loadDevices, setPairingSas, setPairingEnded]);

  useEffect(() => {
    if (!qrUri) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(qrUri, { margin: 1, width: 220 }).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [qrUri]);

  useEffect(() => {
    if (!linkCopied) return;
    const timer = setTimeout(() => setLinkCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [linkCopied]);

  const handleStartPairing = async () => {
    clearPairingEnded();
    setLinkCopied(false);
    const result = await startPairing();
    setQrUri(result.qrUri);
  };

  const handleCopyLink = async () => {
    if (!qrUri) return;
    await navigator.clipboard.writeText(qrUri);
    setLinkCopied(true);
  };

  const handleCancelPairing = async () => {
    await cancelPairing();
    setQrUri(null);
    setQrDataUrl(null);
  };

  const handleConfirmMatch = async () => {
    // Omit capabilities so the main-process default (DEFAULT_PAIRING_CAPABILITIES,
    // read-only) applies. Passing [] here would defeat that default and leave the
    // device with zero granted verbs (permanently inert until a capability UI ships).
    await confirmPairing(deviceNameDraft.trim() || 'Paired Device');
    setQrUri(null);
    setQrDataUrl(null);
    setDeviceNameDraft('');
  };

  return (
    <div className="space-y-4">
      <SettingToggleRow
        {...settingProps('mobileBridge.enabled')}
        icon={<Smartphone className="size-5" />}
        checked={enabled}
        onChange={(value) => updateGlobal({ mobileBridge: { enabled: value } })}
      />

      <div className={enabled ? 'space-y-4' : 'space-y-4 opacity-40 pointer-events-none'}>
        <SettingRow {...settingProps('mobileBridge.relayUrl')}>
          <input
            type="text"
            className={INPUT_CLASS}
            value={relayUrl}
            placeholder="wss://relay.example.com"
            disabled={!enabled}
            onChange={(event) => updateGlobal({ mobileBridge: { relayUrl: event.target.value } })}
          />
        </SettingRow>

        {status && !status.secureStorageAvailable && (
          <p className="text-xs text-danger">
            Secure storage is unavailable on this system, so a device identity cannot be created.
          </p>
        )}

        <SectionHeader label="Pair a Device" searchIds={['mobileBridge.pairing']} />
        {!qrUri ? (
          <div className="space-y-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-hover px-3 py-1.5 text-sm text-fg hover:bg-surface-hover/70 transition-colors disabled:opacity-50"
              onClick={() => void handleStartPairing()}
              disabled={loading || !status?.secureStorageAvailable}
            >
              <QrCode size={16} />
              Pair a device
            </button>
            {pairingEndedReason && <p className="text-xs text-danger">{pairingEndedReason}</p>}
          </div>
        ) : pairingSas ? (
          <div className="space-y-3 rounded-md border border-edge bg-surface-hover/40 p-4">
            <p className="text-sm text-fg-secondary">Confirm this code matches what your phone shows.</p>
            <div className="flex items-center gap-3">
              <span className="text-lg font-mono tracking-widest text-fg">{pairingSas.digits}</span>
              <span className="text-lg">{pairingSas.emoji.join(' ')}</span>
            </div>
            <input
              type="text"
              className={INPUT_CLASS}
              placeholder="Device name (e.g. My iPhone)"
              value={deviceNameDraft}
              onChange={(event) => setDeviceNameDraft(event.target.value)}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-md bg-accent-emphasis px-3 py-1.5 text-sm text-accent-on hover:bg-accent transition-colors"
                onClick={() => void handleConfirmMatch()}
              >
                Codes match
              </button>
              <button
                type="button"
                className="rounded-md border border-edge px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors"
                onClick={() => void handleCancelPairing()}
              >
                Codes don&apos;t match
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 rounded-md border border-edge bg-surface-hover/40 p-4">
            <p className="text-sm text-fg-secondary">
              Scan this code with the Kangentic mobile app, or copy the pairing link and paste it
              into the app&apos;s &quot;paste pairing link&quot; field (for devices without a
              camera on this screen, like an emulator).
            </p>
            {qrDataUrl && (
              <img src={qrDataUrl} alt="Pairing QR code" className="rounded-md border border-edge" width={220} height={220} />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors"
                onClick={() => void handleCopyLink()}
              >
                {linkCopied ? <Check size={14} /> : <Copy size={14} />}
                {linkCopied ? 'Copied' : 'Copy pairing link'}
              </button>
              <button
                type="button"
                className="rounded-md border border-edge px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors"
                onClick={() => void handleCancelPairing()}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <SectionHeader label="Paired Devices" searchIds={['mobileBridge.devices']} />
        {devices.length === 0 ? (
          <p className="text-sm text-fg-faint">No devices paired yet.</p>
        ) : (
          <ul className="space-y-2">
            {devices.map((device) => (
              <li
                key={device.deviceId}
                className="rounded-md border border-edge bg-surface-hover/30 px-3 py-2 space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-sm text-fg-secondary truncate">{device.displayName}</div>
                  <button
                    type="button"
                    className="shrink-0 rounded p-1.5 text-fg-faint hover:text-danger hover:bg-danger/10 transition-colors"
                    title="Revoke"
                    onClick={() => setRevokeTarget({ deviceId: device.deviceId, displayName: device.displayName })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <DeviceCapabilityToggles device={device} onChange={setDeviceCapabilities} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {revokeTarget && (
        <ConfirmDialog
          title="Revoke device"
          message={`Revoke "${revokeTarget.displayName}"? It loses access immediately and must be paired again to reconnect.`}
          confirmLabel="Revoke"
          variant="danger"
          onConfirm={() => {
            const target = revokeTarget;
            setRevokeTarget(null);
            void revokeDevice(target.deviceId);
          }}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * Minimal per-device capability grant UI: one toggle per verb in
 * MOBILE_CAPABILITY_VERBS, so a new verb auto-surfaces here without a
 * component change. Fuller device-management UX (grouping, presets) is
 * Bridge Phase 3 scope - this exists so the Phase 2 write/control verbs
 * (interactive-terminal, move-task, answer-permission-prompt,
 * send-user-message, board-tool-write) are actually grantable, since
 * pairing itself only grants the read-only default set.
 */
function DeviceCapabilityToggles({
  device,
  onChange,
}: {
  device: MobilePairedDevice;
  onChange: (deviceId: string, capabilities: MobileCapabilityVerb[]) => void;
}) {
  const granted = new Set(device.capabilities);
  return (
    <CompactToggleList
      items={MOBILE_CAPABILITY_VERBS.map((verb) => ({
        label: CAPABILITY_LABELS[verb].label,
        description: CAPABILITY_LABELS[verb].description,
        checked: granted.has(verb),
        onChange: (value) => {
          const next = value
            ? [...device.capabilities, verb]
            : device.capabilities.filter((existing) => existing !== verb);
          onChange(device.deviceId, next);
        },
      }))}
    />
  );
}
