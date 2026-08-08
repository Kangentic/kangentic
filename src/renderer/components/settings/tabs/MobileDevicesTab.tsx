import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Copy, Loader2, Pencil, QrCode, Shield, Signal, Smartphone, Trash2, WifiOff, X } from 'lucide-react';
import { formatKeyFingerprint } from '@kangentic/protocol/roster/fingerprint';
import type { AppConfig, MobileDeviceConnectionState, MobilePairedDevice, RemoteServerStatus } from '../../../../shared/types';
import { resolveRelayMode, resolveRelayUrl, validateRelayUrl } from '../../../../shared/relay';
import { formatDate } from '../../../lib/datetime';
import { INPUT_CLASS, SectionHeader, Select, SettingToggleRow, useScopedUpdate } from '../shared';
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
 *  onward to the hosted page (which names who operates the hosted relay and
 *  details what an operator can still observe) or the self-hosting how-to. That
 *  page is now the only place the provenance claim is made: the tab states it by
 *  naming the relay in the Select and printing its domain, and no longer carries
 *  an "Official" badge asserting it a third time. Deliberately the
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

/** The relay address field's classes, authored in full rather than layered onto
 *  the shared INPUT_CLASS. Two of its states need to override a property
 *  INPUT_CLASS already sets, and Tailwind resolves same-specificity utilities by
 *  stylesheet order rather than by the order they appear in a class attribute, so
 *  "INPUT_CLASS + pl-9" is not reliably 36px of left padding and
 *  "INPUT_CLASS + text-fg-faint" is not reliably muted. Left padding and text
 *  color are therefore left out here and supplied per state at the call site.
 *  Same convention as SettingsPanel's project switcher, which writes a complete
 *  className precisely because it passes a leading icon. Mono in every mode: the
 *  content is a URL whether you typed it or it was resolved for you. */
const RELAY_ADDRESS_INPUT_BASE = 'bg-surface-hover border border-edge-input rounded py-1.5 pr-3 text-sm font-mono w-full focus:outline-none focus:border-accent';

/** The probe verdict is a CAPTION on the Test connection button, not an object of
 *  its own: bare icon plus text, no chip. Two reasons, and the shape is only the
 *  visible one.
 *
 *  A filled box made a transient result look like standing furniture beside three
 *  controls that genuinely are (picker, address, button). And as a Pill it was the
 *  single `rounded-full` element in a panel where every other box is a rounded
 *  rectangle - Pill offers no radius that matches, since `shape="square"` is
 *  rounded-lg against its neighbours' rounded. WelcomeScreen already draws this
 *  distinction: its CLI-detection verdict is a bare colored icon plus plain text,
 *  while `Pill shape="square"` is reserved there for a discrete labeled datum. A
 *  verdict is not a datum.
 *
 *  gap and icon size match the button's own (gap-1.5, size 13) so the caption's
 *  icon and text sit directly under the button's, reading as one unit. */
const RELAY_VERDICT_CLASS = 'flex items-center gap-1.5 text-xs text-fg-secondary';
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
   *  ("websocket", "address") kept the heading and hid the custom relay address
   *  field the user was searching for.
   *
   *  This is now the ONLY gate on that address field, which is a fix rather than
   *  a loss of precision. The field had a SettingRow with its own per-row gate,
   *  so the mirror-image bug was live in the other direction: a relayMode-only
   *  query while in custom mode hid the address field and left the Select reading
   *  "Custom Relay" above the gap, a picker pointing at a control that was not
   *  rendered. One any-of gate for the whole section cannot desynchronize. */
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
    // Custom mode ONLY. The address box is now mounted in every mode, and
    // `readOnly` blocks typing but not focus, so clicking into the hosted or
    // local address to copy it (the whole reason it is readOnly rather than
    // disabled) fires this on the way out. Every path below writes
    // `relayMode: 'custom'`, so without this guard that copy silently switched
    // the user off the Kangentic relay and onto a custom one holding a stale or
    // empty draft. While the field lived inside `{relayMode === 'custom' && ...}`
    // the mount itself was the guard; it no longer is.
    //
    // Reads `relayMode` rather than the `isCustomRelay` alias, which is declared
    // below this handler, matching how handleTestRelay already tests the mode.
    if (relayMode !== 'custom') return;
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

  /** The relay row has ONE error line, wherever the failure came from, so a
   *  draft that is invalid and a probe that failed cannot print two red lines of
   *  near-identical text in two different places (which is what happened while
   *  the address field lived in its own SettingRow below the probe row).
   *
   *  The draft's own validation error wins: it is the more specific statement,
   *  it is about what is literally in the box, and when both are set the invalid
   *  URL IS why the probe failed - the main process re-runs validateRelayUrl and
   *  reports the same cause back as an unreachable reason. Each source keeps its
   *  own data-testid so tests can still tell which one is showing. */
  const relayProbeReason = relayTestResult && !relayTestResult.reachable ? relayTestResult.reason : null;
  const relayErrorMessage = relayDraftError ?? relayProbeReason;

  /** Whether the address box accepts typing, and whether it earns the shield.
   *  Deliberately two flags rather than one: the dev-only 'local' mode is
   *  read-only like hosted but is NOT the Kangentic-operated relay, so marking it
   *  with the shield would be as untrue as the old "Official" chip would have
   *  been on loopback. */
  const isCustomRelay = relayMode === 'custom';
  const showHostedRelayShield = relayMode === 'hosted';

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
            {/* ONE grid, not two stacked flex columns. The address field and the
                probe verdict belong to different
                COLUMNS of the same grid ROW, so a single `items-center` centers
                both of them in one shared row box and their vertical centers
                cannot drift. As two independent flex columns they each carried
                their own rhythm (a gap-2 stack beside a gap-1 stack), which put
                the two chips' centers 5px apart with nothing in the layout
                tying them together. `justify-items` stays at its `stretch`
                default so the Select fills column 1; the button opts out with
                `justify-self-start` so it keeps its natural width rather than
                stretching if a result chip ever drives column 2 wider than
                itself. A test pins that today's verdict does not, since a wider
                column 2 would narrow the Select on every completed probe. */}
            <div className="grid grid-cols-[1fr_auto] items-center gap-2">
              <Select
                value={relayMode}
                onChange={(event) => {
                  // A stale reachability result from the previous mode must not
                  // linger next to a mode/URL it was never actually run against.
                  // Bumping the ref also discards a probe still in flight for
                  // the old mode, which would otherwise land after this clear.
                  relayTestRequestRef.current++;
                  setRelayTestResult(null);
                  // Same reason, for the draft's own validation error. It used
                  // to unmount with the custom-only SettingRow that held it;
                  // now the error line is part of the always-rendered row, so a
                  // rejected draft left its red text under the resolved address
                  // of a relay it was never about.
                  setRelayDraftError(null);
                  updateGlobal({ mobileBridge: { relayMode: event.target.value as 'hosted' | 'local' | 'custom' } });
                }}
                disabled={!enabled}
                data-testid="mobile-relay-mode"
              >
                {__KANGENTIC_DEV__ && <option value="local">Local</option>}
                <option value="hosted">Kangentic Relay</option>
                <option value="custom">Custom Relay</option>
              </Select>
              <button
                type="button"
                onClick={() => void handleTestRelay()}
                disabled={testingRelay || !enabled || (relayMode === 'custom' && relayDraft.trim().length === 0)}
                className="justify-self-start flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-edge-input bg-surface-hover text-fg-secondary hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="mobile-relay-test-connection"
              >
                {/* Signal, not Server. Server was not WRONG - the target is a
                    server - but at 13px its two stacked rects each carrying an
                    interior line and dot collapse into mush, the same failure the
                    shield had at 11px. Signal is pure straight strokes with no
                    interior detail, so it survives the size, and "does this
                    endpoint answer, and how well" is exactly what the button
                    does now that the verdict reports latency.

                    The candidates it beat, and why they were unavailable rather
                    than merely worse: Activity already means agent activity
                    (TerminalPanel, the Agent Monitor pop-out, DeveloperTab), Plug
                    means MCP Server, Globe means Browser, Zap is a settings tab
                    icon, and WifiOff means "phone not attached" a few lines below
                    - reusing any of them would repeat the mistake of borrowing a
                    meaning the app has already assigned. Radio's ping metaphor
                    fits best of all, but a Radio glyph inside a settings form
                    reads as a radio-button control.

                    agent-execution-fields.tsx has the same button for the agent
                    execution-server probe and must keep the same glyph. */}
                {testingRelay ? <Loader2 size={13} className="animate-spin" /> : <Signal size={13} />}
                Test connection
              </button>

              {/* Row 2, column 1: THE ADDRESS. ONE control for every mode - the
                  same input, read-only where the address is resolved for you
                  (hosted, and the dev-only local) and editable where you supply
                  it (custom). So the section has a single skeleton, picker over
                  address and probe button over verdict, whose only difference
                  between modes is whether the address box accepts typing.

                  readOnly, NOT disabled. This box replaced a resolved-URL Pill
                  whose text could be selected and copied, and a disabled input
                  can be neither focused nor selected - it would take away the
                  ability to copy the relay address for no gain. readOnly also
                  announces itself correctly to a screen reader. `disabled` is
                  still wired, but to the MASTER TOGGLE, which is a different
                  question ("is the bridge on") from mode.

                  The editable form used to live in its own SettingRow BELOW this
                  whole row, which read backwards: the probe verdict and its
                  failure reason both appeared above the input being tested, that
                  reason was stranded under an empty cell ~400px from its own
                  chip, and the SettingRow put a second heading and an indent rule
                  inside a section that already has a heading. Its description
                  only restated the dependency ("when Relay above is set to Custom
                  Relay") that showing the field solely in that mode already made
                  self-evident.

                  No visible label, deliberately: the box sits directly under the
                  picker at the same width, so its position says which relay it is
                  the address OF, and the placeholder demonstrates the required
                  format. `aria-label` carries both facts for screen readers. */}
              <div className="relative min-w-0">
                {/* Shield ONLY for the Kangentic-operated relay, which is what
                    makes it worth drawing: unlike the "Official" chip this
                    replaces, it has a real contrast case, since the same box in
                    local or custom mode shows none. 14px inside a 34px field,
                    where a shield is legible - the chip that failed was trying to
                    draw one at 11px. aria-hidden because the fact is in the
                    input's own accessible name; the title is a supplementary
                    affordance for sighted users, never the sole carrier.

                    The title lives on a wrapping span because lucide's props omit
                    `title`, and that span deliberately does NOT carry
                    pointer-events-none: it would suppress the hover the title
                    needs. The cost is a 14px dead zone over the field's left
                    padding, which is free here - the mark only ever renders in
                    hosted mode, where the field is read-only and there is no
                    typing position to click into. */}
                {showHostedRelayShield && (
                  <span
                    aria-hidden="true"
                    title="Kangentic-operated relay"
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-accent-fg"
                  >
                    <Shield size={14} />
                  </span>
                )}
                <input
                  type="text"
                  className={`${RELAY_ADDRESS_INPUT_BASE} ${showHostedRelayShield ? 'pl-9' : 'pl-3'} ${isCustomRelay ? 'text-fg' : 'text-fg-faint cursor-default'}`}
                  value={isCustomRelay ? relayDraft : resolvedRelayUrl}
                  placeholder="wss://relay.example.com"
                  readOnly={!isCustomRelay}
                  aria-label={showHostedRelayShield ? 'Relay address, the Kangentic-operated relay' : 'Relay address'}
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
              </div>

              {/* Row 2, column 2. Fixed-height slot, always present: the verdict
                  must not reflow the address row next to it when a result
                  appears/disappears or flips between widths. h-6 is under the
                  34px address field's height, so the slot never drives the row -
                  the address cell does, and `items-center` centers the verdict in
                  it. pl-3 matches the button's px-3 above, putting the caption's
                  icon and text directly under the button's own rather than out at
                  its border box (1px shy, since the button also has a border -
                  below the threshold where a reader sees misalignment). */}
              <div className="h-6 flex items-center pl-3">
                {relayTestResult && (
                  relayTestResult.reachable ? (
                    // The verdict leads and is never displaced by anything else
                    // the probe happened to learn. Latency and the relay's
                    // version are each an OPTIONAL clause that renders only when
                    // the probe produced one: a relay need not report a version,
                    // and RemoteServerStatus is shared with an agent-server probe
                    // that does not time its request.
                    //
                    // That version is the relay SERVICE's own semver. It is not
                    // the wire PROTOCOL_VERSION, which is bound into the Noise
                    // prologue and enforced between desktop and phone - never by
                    // the relay, which forwards blind and never joins the
                    // handshake. So it carries no compatibility meaning, has
                    // nothing here to be checked against, and rides in the
                    // tooltip instead of the verdict.
                    //
                    // Only the ICON carries the verdict, via the `active` /
                    // `attention` tokens - the same treatment WelcomeScreen gives
                    // its CLI-detection probe, for the same two reasons. Facts get
                    // weight, not hue: a filled green box made a one-shot health
                    // check the loudest thing on the row, above even the address
                    // it is about. And a raw green is not how this app paints a
                    // VERDICT - the literal green-400 further down this file is a
                    // steady connection STATE, not the outcome of a check, and
                    // WelcomeScreen's CLI probe already uses these same two
                    // tokens. Tokens, not raw green-500 / amber-400 hues, so both
                    // states track all 11 themes the way the shield on the address
                    // field already does.
                    //
                    // And NOT the accent, which is the other tempting swap here.
                    // The accent is theme-defined and is only blue in some of
                    // them (index.css gives it green in two and gold in one), so
                    // a verdict painted with it would be green in the very
                    // themes we just moved off green, and in the gold theme a
                    // reachable relay would render the same hue as an
                    // unreachable one. The division that actually holds: the
                    // accent is safe on a STANDING element because it carries no
                    // state meaning, and active / attention are safe on a
                    // TRANSIENT verdict because they are theme-invariant and
                    // mean exactly "good" and "needs you".
                    <span
                      className={RELAY_VERDICT_CLASS}
                      title={relayTestResult.version ? `Relay v${relayTestResult.version}` : undefined}
                      data-testid="mobile-relay-test-result"
                      data-reachable="true"
                    >
                      {/* A bare Check, not CheckCircle: an enclosed glyph loses
                          its interior at this size the way ShieldCheck did. */}
                      <Check size={13} className="text-active shrink-0" />
                      {relayTestResult.latencyMs == null ? 'Reachable' : `Reachable, ${relayTestResult.latencyMs} ms`}
                    </span>
                  ) : (
                    <span
                      className={RELAY_VERDICT_CLASS}
                      title={relayTestResult.reason}
                      data-testid="mobile-relay-test-result"
                      data-reachable="false"
                    >
                      <CircleAlert size={13} className="text-attention shrink-0" />
                      No response
                    </span>
                  )
                )}
              </div>

              {/* Row 3, spanning both columns: the row's single error line, from
                  whichever source produced it (see relayErrorMessage above for
                  the precedence and why there is only one). "No response" is the
                  verdict; the reason is what makes it actionable, so it is
                  printed rather than left hover-only on the verdict, which keeps
                  its tooltip too. Below the address row and never above it: a
                  test pins that a result must not shift the address field. */}
              {relayErrorMessage && (
                <p
                  className="col-span-2 text-xs text-danger"
                  data-testid={relayDraftError ? 'mobile-relay-url-error' : 'mobile-relay-test-error'}
                >
                  {relayErrorMessage}
                </p>
              )}
            </div>
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
