import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Copy, Loader2, Pencil, QrCode, Server, Smartphone, Trash2, WifiOff, X } from 'lucide-react';
import { formatKeyFingerprint } from '@kangentic/protocol/roster/fingerprint';
import type { AppConfig, MobileDeviceConnectionState, MobilePairedDevice, RemoteServerStatus } from '../../../../shared/types';
import { resolveRelayMode, resolveRelayUrl, validateRelayUrl } from '../../../../shared/relay';
import { formatDate } from '../../../lib/datetime';
import { INPUT_CLASS, SectionHeader, Select, SettingRow, SettingToggleRow, useScopedUpdate } from '../shared';
import { Pill } from '../../Pill';
import { settingProps } from '../settings-registry';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { QrImage } from '../../QrImage';
import { ExternalLinkButton } from '../../ExternalLinkButton';
import { useMobileStore } from '../../../stores/mobile-store';

/** The anyone-can-join Google Group that authorizes Play closed-test access
 *  (its members are the track's tester list in the Play Console). Also
 *  referenced by the mobile-launch announcement in announcements.json. */
const ANDROID_TESTERS_GROUP_URL = 'https://groups.google.com/g/kangentic-testers';
/** Deterministic from the Android applicationId (com.kangentic.mobile);
 *  resolves once the closed testing track is published in the Play Console. */
const ANDROID_CLOSED_TEST_OPT_IN_URL = 'https://play.google.com/apps/testing/com.kangentic.mobile';

/**
 * 'idle' means this device has no session open yet (nothing to report), so it
 * renders nothing rather than a confusing "Disconnected".
 *
 * 'offline' and 'reconnecting' are deliberately distinct: 'reconnecting' means
 * the relay link itself dropped and is backing off (fix the network), while
 * 'offline' means the relay is healthy and the phone is simply not attached
 * (open the phone). Offline is also the one steady state here, so it gets a
 * static muted treatment rather than a spinner promising imminent resolution.
 */
function connectionStateDisplay(state: MobileDeviceConnectionState): { label: string; className: string; icon: ReactNode } | null {
  switch (state) {
    case 'connected':
      return { label: 'Connected', className: 'text-green-400', icon: <Check size={12} /> };
    case 'connecting':
      return { label: 'Connecting…', className: 'text-amber-400', icon: <Loader2 size={12} className="animate-spin" /> };
    case 'reconnecting':
      return { label: 'Reconnecting…', className: 'text-amber-400', icon: <Loader2 size={12} className="animate-spin" /> };
    case 'offline':
      return { label: 'Offline', className: 'text-fg-faint', icon: <WifiOff size={12} /> };
    case 'closed':
      return { label: 'Disconnected', className: 'text-danger', icon: <CircleAlert size={12} /> };
    case 'idle':
      return null;
  }
}

export function MobileDevicesTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const enabled = globalConfig.mobileBridge?.enabled ?? false;
  // resolveRelayMode, not inferRelayMode: the Select below only offers 'local'
  // in a dev build, but the persisted value can still BE 'local' in production
  // (mobileBridge.* is global config in a shared configDir). Binding the raw
  // stored mode would give a controlled <select> a value matching no <option>,
  // which renders blank - above a pill showing the hosted URL it resolved to.
  const relayMode = resolveRelayMode(globalConfig.mobileBridge);
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
  const pairingConfirmed = useMobileStore((state) => state.pairingConfirmed);
  const pairingEndedReason = useMobileStore((state) => state.pairingEndedReason);
  const loadStatus = useMobileStore((state) => state.loadStatus);
  const loadDevices = useMobileStore((state) => state.loadDevices);
  const startPairing = useMobileStore((state) => state.startPairing);
  const cancelPairing = useMobileStore((state) => state.cancelPairing);
  const revokeDevice = useMobileStore((state) => state.revokeDevice);
  const renameDevice = useMobileStore((state) => state.renameDevice);
  const setPairingSas = useMobileStore((state) => state.setPairingSas);
  const setPairingConfirmed = useMobileStore((state) => state.setPairingConfirmed);
  const clearPairingConfirmed = useMobileStore((state) => state.clearPairingConfirmed);
  const setPairingEnded = useMobileStore((state) => state.setPairingEnded);
  const clearPairingEnded = useMobileStore((state) => state.clearPairingEnded);

  const [qrUri, setQrUri] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ deviceId: string; displayName: string } | null>(null);
  const [renamingDeviceId, setRenamingDeviceId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  useEffect(() => {
    void loadStatus();
    void loadDevices();
  }, [loadStatus, loadDevices]);

  useEffect(() => {
    const unsubscribeSas = window.electronAPI.mobile.onPairingSas((payload) => {
      setPairingSas(payload);
    });
    const unsubscribeConfirmed = window.electronAPI.mobile.onPairingConfirmed((payload) => {
      setPairingConfirmed(payload);
      setQrUri(null);
    });
    const unsubscribeEnded = window.electronAPI.mobile.onPairingEnded((payload) => {
      // A plain cancel (Cancel button, or the panel closing mid-ceremony) is
      // a deliberate action already obvious from the UI returning to idle -
      // only a genuine failure (mismatch, timeout, handshake error) is worth
      // surfacing as a message.
      if (payload.kind === 'failed') setPairingEnded(payload.reason);
      setQrUri(null);
    });
    const unsubscribeState = window.electronAPI.mobile.onStateChanged(() => {
      void loadStatus();
      void loadDevices();
    });
    return () => {
      unsubscribeSas();
      unsubscribeConfirmed();
      unsubscribeEnded();
      unsubscribeState();
    };
  }, [loadStatus, loadDevices, setPairingSas, setPairingConfirmed, setPairingEnded]);

  // Genuine unmount only, so this lives in its own effect with empty deps
  // rather than riding along on the subscription effect above: that one's
  // cleanup re-runs whenever its dependencies change, and this teardown
  // mutates main-process state, so it must never fire on a mere re-subscribe.
  //
  // The desktop displaying the SAS digits IS the pairing ceremony: if this
  // tab unmounts (Settings closed, tab switched away) mid-ceremony, the human
  // can no longer complete the comparison, so the ceremony must not be left
  // auto-enrolling in the background. Clearing the two transient banners
  // matters for the same reason - they live in the module-global store, so a
  // "Paired: <name>" whose 3s timer was cut short by the unmount, or a
  // failure reason (only ever cleared by starting a NEW pairing), would
  // otherwise reappear as stale text the next time this tab mounts.
  // Actions are read via getState() so no store reference enters the deps.
  useEffect(() => {
    return () => {
      void window.electronAPI.mobile.cancelPairing();
      useMobileStore.getState().clearPairingConfirmed();
      useMobileStore.getState().clearPairingEnded();
    };
  }, []);

  // The "Paired: <name>" confirmation is a brief acknowledgement, not a
  // resting state - it self-dismisses back to the idle/device-list view.
  useEffect(() => {
    if (!pairingConfirmed) return;
    const timer = setTimeout(() => clearPairingConfirmed(), 3000);
    return () => clearTimeout(timer);
  }, [pairingConfirmed, clearPairingConfirmed]);

  useEffect(() => {
    if (!linkCopied) return;
    const timer = setTimeout(() => setLinkCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [linkCopied]);

  const handleStartPairing = async () => {
    clearPairingEnded();
    clearPairingConfirmed();
    setLinkCopied(false);
    try {
      const result = await startPairing();
      setQrUri(result.qrUri);
    } catch (error) {
      setPairingEnded(error instanceof Error ? error.message : 'Could not start pairing.');
    }
  };

  const handleCopyLink = async () => {
    if (!qrUri) return;
    await navigator.clipboard.writeText(qrUri);
    setLinkCopied(true);
  };

  const handleCancelPairing = async () => {
    await cancelPairing();
    setQrUri(null);
  };

  const startRename = (device: MobilePairedDevice) => {
    setRenamingDeviceId(device.deviceId);
    setRenameDraft(device.displayName);
  };

  const commitRename = async (deviceId: string) => {
    const trimmed = renameDraft.trim();
    setRenamingDeviceId(null);
    if (!trimmed) return;
    await renameDevice(deviceId, trimmed);
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
        {!qrUri && !pairingConfirmed ? (
          <div className="space-y-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-hover px-3 py-1.5 text-sm text-fg hover:bg-surface-hover/70 transition-colors disabled:opacity-50"
              onClick={() => void handleStartPairing()}
              disabled={loading || !status?.secureStorageAvailable}
              data-testid="mobile-pair-start"
            >
              <QrCode size={16} />
              Pair a device
            </button>
            {pairingEndedReason && <p className="text-xs text-danger">{pairingEndedReason}</p>}
          </div>
        ) : pairingConfirmed ? (
          <div className="rounded-md border border-edge bg-surface-hover/40 p-4 flex items-center gap-2 text-sm text-fg">
            <Check size={16} className="text-green-400" />
            Paired: {pairingConfirmed.displayName}
          </div>
        ) : pairingSas ? (
          <div className="space-y-3 rounded-md border border-edge bg-surface-hover/40 p-4" data-testid="mobile-pair-waiting">
            <p className="text-sm text-fg-secondary">Waiting for your phone…</p>
            <span className="text-lg font-mono tracking-widest text-fg" data-testid="mobile-pair-sas-digits">
              {pairingSas.digits}
            </span>
            <p className="text-xs text-fg-faint">Your phone shows this code too. Confirm there to finish pairing.</p>
            <button
              type="button"
              className="rounded-md border border-edge px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors"
              onClick={() => void handleCancelPairing()}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="space-y-3 rounded-md border border-edge bg-surface-hover/40 p-4" data-testid="mobile-pair-qr">
            <p className="text-sm text-fg-secondary">Scan this code with the Kangentic app on your phone.</p>
            {qrUri && <QrImage value={qrUri} alt="Pairing QR code" />}
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
            <p className="text-xs text-fg-faint">No camera? Copy the link and paste it into the app.</p>
          </div>
        )}

        <SectionHeader label="Paired Devices" searchIds={['mobileBridge.devices']} />
        {devices.length === 0 ? (
          <p className="text-sm text-fg-faint">No devices paired yet.</p>
        ) : (
          <ul className="space-y-2">
            {devices.map((device) => {
              const connection = connectionStateDisplay(device.connectionState);
              const fingerprint = formatKeyFingerprint(device.deviceId);
              return (
                <li
                  key={device.deviceId}
                  className="rounded-md border border-edge bg-surface-hover/30 px-3 py-2 space-y-1.5"
                  data-testid="mobile-device-row"
                >
                  <div className="flex items-center justify-between gap-3">
                    {renamingDeviceId === device.deviceId ? (
                      <div className="flex-1 flex items-center gap-1">
                        <input
                          type="text"
                          autoFocus
                          // Matches the main process's own clamp on the way
                          // into the signed roster, so the field cannot accept
                          // a name that would be silently truncated on save.
                          maxLength={64}
                          className={`${INPUT_CLASS} flex-1`}
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            // Settings' dismiss listener is a bubble-phase
                            // document keydown (shared.tsx), so without this
                            // the Escape that cancels the rename ALSO closes
                            // the whole panel - the same reason the other two
                            // inline-edit fields stop propagation first thing
                            // (ProjectListItem.tsx, KeyCaptureInput.tsx).
                            event.stopPropagation();
                            if (event.key === 'Enter') void commitRename(device.deviceId);
                            if (event.key === 'Escape') setRenamingDeviceId(null);
                          }}
                        />
                        <button
                          type="button"
                          className="shrink-0 rounded p-1.5 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
                          title="Save name"
                          onClick={() => void commitRename(device.deviceId)}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          className="shrink-0 rounded p-1.5 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
                          title="Cancel"
                          onClick={() => setRenamingDeviceId(null)}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="min-w-0 flex items-center gap-2">
                          <span className="text-sm text-fg-secondary truncate">{device.displayName}</span>
                          <Pill size="sm" className="shrink-0 bg-surface-hover/60 text-fg-faint font-mono" data-testid="mobile-device-fingerprint">
                            {fingerprint}
                          </Pill>
                        </div>
                        <div className="shrink-0 flex items-center gap-1">
                          <button
                            type="button"
                            className="rounded p-1.5 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
                            title="Rename"
                            data-testid="mobile-device-rename"
                            onClick={() => startRename(device)}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            className="rounded p-1.5 text-fg-faint hover:text-danger hover:bg-danger/10 transition-colors"
                            title="Revoke"
                            data-testid="mobile-device-revoke"
                            onClick={() => setRevokeTarget({ deviceId: device.deviceId, displayName: device.displayName })}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-fg-faint">
                    {connection && (
                      <>
                        <span className={`flex items-center gap-1 ${connection.className}`} data-testid="mobile-device-connection">
                          {connection.icon}
                          {connection.label}
                        </span>
                        <span aria-hidden="true">|</span>
                      </>
                    )}
                    <span>Paired {formatDate(device.pairedAt)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Outside the enabled-gated wrapper above: getting the app is exactly
          what a user with the bridge still off needs, so this section stays
          fully interactive regardless of the toggle. */}
      <SectionHeader label="Get the App" searchIds={['mobileBridge.getApp']} />
      <div className="space-y-3" data-testid="mobile-get-app">
        <p className="text-sm text-fg-muted">
          Kangentic Mobile for Android is in closed testing. Two steps to join:
        </p>
        <div className="rounded-md border border-edge bg-surface-hover/40 p-4 space-y-2" data-testid="mobile-get-app-step-group">
          <p className="text-sm text-fg">1. Join the testers Google Group</p>
          <QrImage
            value={ANDROID_TESTERS_GROUP_URL}
            alt="QR code for the Kangentic testers Google Group"
            testId="mobile-get-app-group-qr"
          />
          <ExternalLinkButton
            label="Join the testers Google Group"
            url={ANDROID_TESTERS_GROUP_URL}
            testId="mobile-get-app-group-link"
          />
        </div>
        <div className="rounded-md border border-edge bg-surface-hover/40 p-4 space-y-2" data-testid="mobile-get-app-step-optin">
          <p className="text-sm text-fg">2. Become a tester</p>
          <QrImage
            value={ANDROID_CLOSED_TEST_OPT_IN_URL}
            alt="QR code for the Play Store tester opt-in page"
            testId="mobile-get-app-optin-qr"
          />
          <ExternalLinkButton
            label="Become a tester on Google Play"
            url={ANDROID_CLOSED_TEST_OPT_IN_URL}
            testId="mobile-get-app-optin-link"
          />
        </div>
        <p className="text-xs text-fg-faint">
          Use the same Google account you use in the Play Store, and stay opted in while the test is running.
        </p>
      </div>

      {revokeTarget && (
        <ConfirmDialog
          title="Revoke device"
          message={`Revoke "${revokeTarget.displayName}" (${formatKeyFingerprint(revokeTarget.deviceId)})? It loses access immediately and must be paired again to reconnect.`}
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
