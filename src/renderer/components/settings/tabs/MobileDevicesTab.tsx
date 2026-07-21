import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Copy, Loader2, QrCode, Server, Smartphone, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { MOBILE_CAPABILITY_VERBS, type AppConfig, type MobileBridgeTransportState, type MobileCapabilityVerb, type MobilePairedDevice, type RemoteServerStatus } from '../../../../shared/types';
import { inferRelayMode, resolveRelayUrl, validateRelayUrl } from '../../../../shared/relay';
import { CompactToggleList, INPUT_CLASS, SectionHeader, Select, SettingRow, SettingToggleRow, useScopedUpdate } from '../shared';
import { Pill } from '../../Pill';
import { settingProps } from '../settings-registry';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { useMobileStore } from '../../../stores/mobile-store';

/**
 * 'idle' means no paired device has a session open yet (nothing to report -
 * the "Paired Devices" list is empty), so it renders nothing rather than a
 * confusing "Disconnected" for a desktop with no devices at all.
 */
function relayStatusDisplay(relayState: MobileBridgeTransportState): { label: string; className: string; icon: ReactNode } | null {
  switch (relayState) {
    case 'connected':
      return { label: 'Connected', className: 'text-green-400', icon: <Check size={12} /> };
    case 'connecting':
      return { label: 'Connecting…', className: 'text-amber-400', icon: <Loader2 size={12} className="animate-spin" /> };
    case 'reconnecting':
      return { label: 'Reconnecting…', className: 'text-amber-400', icon: <Loader2 size={12} className="animate-spin" /> };
    case 'closed':
      return { label: 'Disconnected', className: 'text-danger', icon: <CircleAlert size={12} /> };
    case 'idle':
      return null;
  }
}

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
  'register-push': { label: 'Push notifications', description: 'Register this device for end-to-end encrypted push notifications' },
};

export function MobileDevicesTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const enabled = globalConfig.mobileBridge?.enabled ?? false;
  const relayMode = inferRelayMode(globalConfig.mobileBridge);
  const resolvedRelayUrl = resolveRelayUrl(globalConfig.mobileBridge);

  // Local draft with a commit boundary (blur/Enter), not a per-keystroke write:
  // each committed relayUrl change disposes and redials every bridge session
  // (mobile-bridge-service.ts's reconcile()), so typing a URL character by
  // character used to do that on every keystroke.
  const [relayDraft, setRelayDraft] = useState(globalConfig.mobileBridge?.relayUrl ?? '');
  const [relayDraftError, setRelayDraftError] = useState<string | null>(null);
  const [testingRelay, setTestingRelay] = useState(false);
  const [relayTestResult, setRelayTestResult] = useState<RemoteServerStatus | null>(null);
  /** Identifies the in-flight "Test connection" probe so a reply for a relay the user has since navigated away from is discarded rather than shown. Bumped on every retarget. */
  const relayTestRequestRef = useRef(0);

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

  const commitRelayDraft = () => {
    const trimmed = relayDraft.trim();
    if (trimmed.length === 0) {
      // Empty draft: resolveRelayUrl falls back to the built-in default, so
      // this is a valid "no custom URL yet" state, not an error.
      setRelayDraftError(null);
      updateGlobal({ mobileBridge: { relayMode: 'custom', relayUrl: '' } });
      return;
    }
    const validation = validateRelayUrl(trimmed);
    if (!validation.ok) {
      setRelayDraftError(validation.reason);
      return;
    }
    setRelayDraftError(null);
    setRelayDraft(validation.normalized);
    updateGlobal({ mobileBridge: { relayMode: 'custom', relayUrl: validation.normalized } });
  };

  const handleTestRelay = async () => {
    const urlToTest = relayMode === 'custom' ? relayDraft.trim() : resolvedRelayUrl;
    const requestId = ++relayTestRequestRef.current;
    setTestingRelay(true);
    try {
      const result = await window.electronAPI.mobile.testRelay(urlToTest);
      // Neither the mode Select nor the URL input is disabled during a probe,
      // and the probe has a 5s timeout budget, so the user can retarget while
      // one is in flight. Their onChange already cleared the result slot and
      // invalidated this request; without the guard the late reply would
      // repopulate that slot with a verdict for a URL they navigated away from.
      if (relayTestRequestRef.current !== requestId) return;
      setRelayTestResult(result);
    } finally {
      // Unconditional on purpose. The button is disabled while testingRelay is
      // true, so there is only ever one probe in flight and it always owns the
      // spinner. Guarding this on requestId (as the result assignment above
      // correctly is) would strand testingRelay=true forever whenever the user
      // retargets mid-probe, leaving the button disabled and spinning until
      // the tab remounts.
      setTestingRelay(false);
    }
  };

  const relayStatus = status ? relayStatusDisplay(status.relayState) : null;

  return (
    <div className="space-y-4">
      <SettingToggleRow
        {...settingProps('mobileBridge.enabled')}
        icon={<Smartphone className="size-5" />}
        checked={enabled}
        onChange={(value) => updateGlobal({ mobileBridge: { enabled: value } })}
      />

      <div className={enabled ? 'space-y-4' : 'space-y-4 opacity-40 pointer-events-none'}>
        <SettingRow {...settingProps('mobileBridge.relayMode')}>
          <div className="flex gap-2 items-start">
            <div className="flex-1 flex flex-col gap-2">
              <Select
                value={relayMode}
                onChange={(event) => {
                  // A stale reachability result from the previous mode must not
                  // linger next to a mode/URL it was never actually run against.
                  // Bumping the ref also discards a probe still in flight for
                  // the old mode, which would otherwise land after this clear.
                  relayTestRequestRef.current++;
                  setRelayTestResult(null);
                  updateGlobal({ mobileBridge: { relayMode: event.target.value as 'hosted' | 'local' | 'custom' } });
                }}
                disabled={!enabled}
                data-testid="mobile-relay-mode"
              >
                {__KANGENTIC_DEV__ && <option value="local">Local</option>}
                <option value="hosted">Kangentic Cloud</option>
                <option value="custom">Custom Relay</option>
              </Select>
              {relayMode !== 'custom' && (
                <Pill size="sm" className="self-start bg-surface-hover/60 text-fg-faint font-mono" data-testid="mobile-relay-resolved-url">
                  {resolvedRelayUrl}
                </Pill>
              )}
            </div>
            <div className="shrink-0 flex flex-col items-start gap-1">
              <button
                type="button"
                onClick={() => void handleTestRelay()}
                disabled={testingRelay || !enabled || (relayMode === 'custom' && relayDraft.trim().length === 0)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-edge-input bg-surface-hover text-fg-secondary hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="mobile-relay-test-connection"
              >
                {testingRelay ? <Loader2 size={13} className="animate-spin" /> : <Server size={13} />}
                Test connection
              </button>
              {/* Fixed-height slot, always present: the result pill must not
                  reflow the resolved-URL row next to it when a test result
                  appears/disappears or flips between the two pill widths. */}
              <div className="h-6 flex items-center">
                {relayTestResult && (
                  relayTestResult.reachable ? (
                    <Pill size="sm" className="bg-green-500/15 text-green-400">
                      <Check size={11} />
                      {relayTestResult.version ? `v${relayTestResult.version}` : 'Reachable'}
                    </Pill>
                  ) : (
                    <Pill size="sm" className="bg-amber-500/15 text-amber-400" title={relayTestResult.reason}>
                      <CircleAlert size={11} />
                      No response
                    </Pill>
                  )
                )}
              </div>
            </div>
          </div>
        </SettingRow>

        {relayMode === 'custom' && (
          <SettingRow {...settingProps('mobileBridge.relayUrl')}>
            <div className="ml-1 space-y-2 border-l border-edge pl-3" data-testid="mobile-relay-custom-fields">
              <input
                type="text"
                className={INPUT_CLASS}
                value={relayDraft}
                placeholder="wss://relay.example.com"
                disabled={!enabled}
                data-testid="mobile-relay-url-input"
                onChange={(event) => {
                  setRelayDraft(event.target.value);
                  setRelayDraftError(null);
                  // Same in-flight invalidation as the mode Select above.
                  relayTestRequestRef.current++;
                  setRelayTestResult(null);
                }}
                onBlur={commitRelayDraft}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              {relayDraftError && (
                <p className="text-xs text-danger" data-testid="mobile-relay-url-error">
                  {relayDraftError}
                </p>
              )}
            </div>
          </SettingRow>
        )}

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
        {devices.length > 0 && relayStatus && (
          <p className={`text-xs flex items-center gap-1 -mt-1 ${relayStatus.className}`} data-testid="mobile-relay-status">
            {relayStatus.icon}
            Relay: {relayStatus.label}
          </p>
        )}
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
