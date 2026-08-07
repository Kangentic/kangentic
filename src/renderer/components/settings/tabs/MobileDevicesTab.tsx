import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Copy, Loader2, Pencil, QrCode, Server, ShieldCheck, Smartphone, Trash2, WifiOff, X } from 'lucide-react';
import { formatKeyFingerprint } from '@kangentic/protocol/roster/fingerprint';
import type { AppConfig, MobileDeviceConnectionState, MobilePairedDevice, RemoteServerStatus } from '../../../../shared/types';
import { resolveRelayMode, resolveRelayUrl, validateRelayUrl } from '../../../../shared/relay';
import { formatDate } from '../../../lib/datetime';
import { INPUT_CLASS, SectionHeader, Select, SettingRow, SettingToggleRow, useScopedUpdate } from '../shared';
import { Pill } from '../../Pill';
import { settingProps } from '../settings-registry';
import { useAnySettingVisible } from '../settings-search';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { QrImage } from '../../QrImage';
import { ExternalLinkButton } from '../../ExternalLinkButton';
import { useMobileStore } from '../../../stores/mobile-store';

/** The docs page owns the install instructions, so the launch phase (closed
 *  test, open beta, public release, and the iOS status) can change on the
 *  website without a desktop release. The signup steps for whichever phase is
 *  live belong in the mobile-launch announcement in announcements.json. */
const MOBILE_DOCS_URL = 'https://www.kangentic.com/mobile/';

/** The relay section's overview: what the relay is, why it exists, the
 *  blind-forwarding guarantee, and a hosted-vs-your-own comparison that routes
 *  onward to the hosted page (which backs the "Official" badge and details what
 *  an operator can still observe) or the self-hosting how-to. Deliberately the
 *  overview rather than either leaf: someone opening this from the settings tab
 *  is asking what the relay does, and can pick a branch from there. The relay
 *  docs are their own top-level section on the site, not a subsection of
 *  Mobile, which is the same split this tab draws between Relay and Mobile. */
const RELAY_DOCS_URL = 'https://www.kangentic.com/relay/';

/** The ids each section's heading advertises. Declared once and passed to BOTH
 *  the SectionHeader's `searchIds` and the body's `useAnySettingVisible` gate,
 *  so the two cannot answer the search differently: a body gated on a subset
 *  hides the very row the query matched and leaves the heading orphaned. */
const RELAY_SEARCH_IDS = ['mobileBridge.relayMode', 'mobileBridge.relayUrl'];
const MOBILE_SEARCH_IDS = ['mobileBridge.pairing', 'mobileBridge.devices', 'mobileBridge.getApp'];

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

  /** Every control in a section dims and stops taking clicks with the bridge
   *  off; each section's docs tail sits outside this wrapper (see the comment
   *  in the JSX below). */
  const gatedSectionClass = enabled ? 'space-y-4' : 'space-y-4 opacity-40 pointer-events-none';
  /** The relay controls used to be a SettingRow, which hid itself on a search
   *  miss. Now that its heading is a SectionHeader, the controls have to honor
   *  the same search filtering explicitly or they render under a hidden header.
   *  Gated on the WHOLE id list the heading advertises, not just relayMode:
   *  SectionHeader shows when ANY of its ids match, so a relayUrl-only query
   *  ("websocket", "address") kept the heading and hid the Custom Relay Address
   *  field the user was searching for. */
  const relaySectionVisible = useAnySettingVisible(RELAY_SEARCH_IDS);
  /** Same rule for the Mobile section. Applied as a class rather than an
   *  `&&` wrapper only to avoid adding a JSX nesting level around ~190 lines:
   *  the pairing flow and device list would all have to shift one indent, and
   *  the resulting whitespace hunk would bury the real change. `hidden` is
   *  display:none, so the content is out of the accessibility tree too. */
  const mobileSectionVisible = useAnySettingVisible(MOBILE_SEARCH_IDS);
  /** Via settingProps, not a raw SETTINGS_BY_ID index: a future rename of the
   *  id then fails with "Unknown setting ID: ..." instead of a bare "cannot
   *  read properties of undefined". */
  const relayHeading = settingProps('mobileBridge.relayMode');

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

      {/* The tab below the master switch is two independent sections, Relay and
          Mobile: where this desktop connects, and which phones may use it.
          They are peers, so both are SectionHeaders - the relay controls used
          to sit in a SettingRow whose own label was also "Relay", which put two
          different headings for the same thing on one tab.

          Each section ends in an UNGATED documentation tail. Everything else in
          a section is inside the enabled-gate, but the docs are exactly what a
          user with the bridge still off needs: someone deciding whether to
          route agent traffic through our relay has by definition not flipped
          the toggle, and someone who has not installed the app yet has not
          either. Parent opacity cannot be undone by a child, so the link has to
          live outside the gated wrapper rather than opt out of it. */}
      <SectionHeader
        label={relayHeading.label}
        description={relayHeading.description}
        searchIds={RELAY_SEARCH_IDS}
      />
      {relaySectionVisible && (
        <>
          <div className={gatedSectionClass}>
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
                <option value="hosted">Kangentic Relay</option>
                <option value="custom">Custom Relay</option>
              </Select>
              {relayMode !== 'custom' && (
                // The badge is a SIBLING of the resolved-URL pill, never nested
                // inside it: that pill is asserted with an exact toHaveText.
                // Laying them out side by side (rather than stacked) also keeps
                // the pill's y fixed, which a test pins to within 1px.
                <div className="flex flex-wrap items-center gap-2 self-start">
                  <Pill size="sm" className="bg-surface-hover/60 text-fg-faint font-mono" data-testid="mobile-relay-resolved-url">
                    {resolvedRelayUrl}
                  </Pill>
                  {/* Keyed to 'hosted', not to the pill's presence: the pill
                      also renders for the dev-only 'local' mode, and marking a
                      localhost relay "Official" would be simply untrue. */}
                  {relayMode === 'hosted' && (
                    <Pill size="sm" className="bg-surface-hover/60 text-accent-fg border border-edge/50" data-testid="mobile-relay-official-badge">
                      <ShieldCheck size={11} />
                      Official
                    </Pill>
                  )}
                </div>
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
                      {/* Inert against the hosted relay today: its /healthz
                          contract is {"status":"ok"} with no version field, so
                          this reads "Reachable" in practice and only the test
                          mock exercises the version branch. Kept so the pill
                          lights up on its own if the relay starts reporting
                          one. */}
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
          </div>

          <ExternalLinkButton
            label="How the relay works"
            url={RELAY_DOCS_URL}
            testId="mobile-relay-docs-link"
          />
        </>
      )}

      {/* ── Mobile ── the phones allowed to use the relay above. Named for the
          device, not the ceremony: "Pairing" over a "Pair a device" button and
          a "Paired Devices" list stacked three "pair"s deep, and the thing this
          section is actually about is your phone.

          Label and description are literals here, where Relay's come from the
          registry: this heading spans THREE registry rows (pairing, devices,
          getApp), so there is no single entry to source them from. Relay maps
          1:1 onto mobileBridge.relayMode and reads it directly. */}
      <SectionHeader
        label="Mobile"
        description="Phones paired to this desktop, and the app they run. Each paired phone is identified here by key fingerprint."
        searchIds={MOBILE_SEARCH_IDS}
      />
      <div className={mobileSectionVisible ? gatedSectionClass : 'hidden'}>
        {status && !status.secureStorageAvailable && (
          <p className="text-xs text-danger">
            Secure storage is unavailable on this system, so a device identity cannot be created.
          </p>
        )}

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

        {/* A sub-label, not a SectionHeader: the device list belongs to Mobile
            rather than sitting beside it as a third peer section. */}
        <div className="text-sm font-medium text-fg-secondary pt-1">Paired Devices</div>
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

      {/* Mobile's documentation tail, the counterpart to the relay's. Outside
          the gate for the same reason, and NOT conditioned on the device list
          being empty: the target is a docs landing page rather than an install
          page, so a paired user is most of its audience, and pairing one phone
          does not mean the next device is installed. */}
      <div className={mobileSectionVisible ? 'space-y-3' : 'hidden'} data-testid="mobile-get-app">
        <p className="text-sm text-fg-muted">
          Installing the app, pairing a phone, and push notifications.
        </p>
        <ExternalLinkButton
          label="How to install and pair"
          url={MOBILE_DOCS_URL}
          testId="mobile-get-app-docs-link"
        />
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
