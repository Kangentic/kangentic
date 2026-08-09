/**
 * Who may take keyboard focus when a terminal ARRIVES.
 *
 * A terminal "arrives" when it finishes mounting or replaying: the deferred-init
 * `focus()`, the mount-time scrollback replay, and any reload the host did not opt
 * out of. Those are programmatic events, not user gestures, and more than one can
 * land in the same handful of frames - opening a task detail evicts the bottom
 * panel's selected session, so the panel mounts a fresh terminal for a DIFFERENT
 * session at the same moment the detail window mounts its own. Both then fetch
 * scrollback, which main delays 150-400ms while the agent's TUI repaint settles.
 * Every one of those paths used to end in an unconditional `xterm.focus()`, so
 * whichever replay resolved LAST won, and the user's keystrokes went to whichever
 * agent that happened to be.
 *
 * THE INVARIANT: at most one terminal takes focus on arrival, and which one is
 * decided by user-intent STATE, never by replay order or rAF order. Each tier
 * below is EXCLUSIVE - a tier that resolves an answer decides, allowing if it
 * matches and DENYING if it does not. It never falls through to a lower tier.
 * Non-exclusive tiers degrade straight back into a race, because two terminals
 * arriving in the same frame would both find themselves permitted.
 *
 * Genuinely user-initiated focus does NOT come through here and stays
 * unconditional: pointer-down on a window frame, a file drop on a terminal, the
 * maximize/restore re-homing, and the imperative `focus()` those use.
 *
 * Naming note: "focused" is already taken in this codebase. `focused-terminals.ts`
 * owns the PTY-STREAM focused set (which sessions main forwards bytes for, several
 * at once), and `focused-sessions.ts` derives it. This module is about KEYBOARD
 * focus, and exactly one terminal can hold that, so it uses its own vocabulary.
 *
 * Known boundary, deliberately not closed: click into the bottom panel's xterm
 * body (rather than its tab) while a detail window still holds `focusedWindowId`,
 * and that window's terminal then arrives - tier 2 allows the steal. It is narrow,
 * because the window must have just opened for its terminal to still be arriving,
 * which means the user just clicked it. Closing it would need a claim on
 * panel-pane pointer-down, which brings a stale-claim edge of its own.
 */

import { allWindowManagers } from '../window-manager/store/window-store';
import { resolveFocusedWindowTerminal, type FocusedWindowTerminal } from './dictation-target';
import { traceTerminalRenderer } from './terminal-grid-registry';

/** Backstop only. The fingerprint below is what actually supersedes a claim; this
 *  bounds the case where a claim is set and its terminal never mounts at all. */
export const ARRIVAL_CLAIM_TTL_MS = 4000;

/** How long one granted arrival suppresses a DIFFERENT session's arrival while
 *  nothing else resolves. Only reachable in tier 3. */
export const ARRIVAL_BURST_MS = 500;

/** A user gesture that named a session before its terminal existed. */
export interface ArrivalFocusClaim {
  sessionId: string;
  /** Window-layer focus identity at gesture time, so any later window
   *  open/focus/close supersedes this claim with no subscription. */
  fingerprint: string;
  at: number;
}

export type ArrivalFocusReason =
  | 'claim'
  | 'claim-mismatch'
  | 'window'
  | 'window-mismatch'
  | 'occupied'
  | 'burst-taken'
  | 'unclaimed';

export interface ArrivalFocusInput {
  sessionId: string;
  claim: ArrivalFocusClaim | null;
  now: number;
  windowFocusFingerprint: string;
  /** Null when NO terminal-hosting window is focused in any layer. A non-null
   *  entry whose `sessionId` is null means a window owns the user's attention but
   *  has not spawned a session yet, which still denies everyone else. */
  focusedWindowTerminal: FocusedWindowTerminal | null;
  focusIsInTypingSurface: boolean;
  lastGrant: { sessionId: string; at: number } | null;
}

export interface ArrivalFocusDecision {
  allow: boolean;
  reason: ArrivalFocusReason;
}

/**
 * PURE. The whole decision, with no store or DOM reads, so every tier and every
 * exclusivity edge is testable directly.
 */
export function resolveArrivalFocus(input: ArrivalFocusInput): ArrivalFocusDecision {
  // Tier 1: a user gesture named a session. Still live only while the window
  // layers have not moved focus since (a later open/focus/close changes the
  // fingerprint) and the backstop TTL has not lapsed.
  const { claim } = input;
  if (
    claim
    && claim.fingerprint === input.windowFocusFingerprint
    && input.now - claim.at <= ARRIVAL_CLAIM_TTL_MS
  ) {
    return claim.sessionId === input.sessionId
      ? { allow: true, reason: 'claim' }
      : { allow: false, reason: 'claim-mismatch' };
  }

  // Tier 2: a terminal-hosting window holds window-layer focus. That window is
  // where the user is working, so only its terminal may arrive into focus.
  if (input.focusedWindowTerminal) {
    return input.focusedWindowTerminal.sessionId === input.sessionId
      ? { allow: true, reason: 'window' }
      : { allow: false, reason: 'window-mismatch' };
  }

  // Tier 3: nothing owns the user's attention. Cold start, a hard reload, and the
  // bottom panel with no windows open all land here.
  //
  // The test is "is focus in a typing surface", NOT "is focus orphaned". After
  // clicking a panel tab or the collapse chevron, `document.activeElement` is that
  // <button>, so an orphan test would deny the most common interaction in the app.
  // A <button> is not a typing surface; `.xterm-helper-textarea` is a <textarea>,
  // so an arriving terminal still never yanks focus out of one being typed in.
  if (input.focusIsInTypingSurface) return { allow: false, reason: 'occupied' };

  // Several terminals can reach tier 3 together (a workspace restore that
  // persisted no focused window). One winner, rather than last-rAF-wins.
  if (
    input.lastGrant
    && input.lastGrant.sessionId !== input.sessionId
    && input.now - input.lastGrant.at <= ARRIVAL_BURST_MS
  ) {
    return { allow: false, reason: 'burst-taken' };
  }

  return { allow: true, reason: 'unclaimed' };
}

// hmr-safe is NOT enough here: a Fast Refresh mid-gesture would drop a live claim
// and let the wrong terminal win, so both are preserved (hmr-patterns Pattern A).
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let arrivalClaim: ArrivalFocusClaim | null = import.meta.hot?.data?.arrivalClaim ?? null;
// @ts-expect-error -- Vite handles import.meta.hot
let lastArrivalGrant: { sessionId: string; at: number } | null = import.meta.hot?.data?.lastArrivalGrant ?? null;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.arrivalClaim = arrivalClaim;
    data.lastArrivalGrant = lastArrivalGrant;
  });
}

/**
 * Window-layer focus identity across every layer. Opening, focusing, or closing
 * any window moves it, which is exactly when a pending claim should stop applying:
 * a TTL alone would reintroduce the bug in reverse (click a panel tab, open a
 * detail inside the TTL, and focus would stay on the panel).
 */
export function windowFocusFingerprint(): string {
  const parts: string[] = [];
  for (const manager of allWindowManagers) {
    parts.push(`${manager.options.idPrefix}:${manager.store.getState().focusedWindowId ?? ''}`);
  }
  return parts.join('|');
}

/**
 * Record that a user gesture named this session's terminal before it existed.
 *
 * Needed because the bottom panel is not a window: clicking its tab does not move
 * any layer's `focusedWindowId`, so tier 2 would deny it forever while a detail
 * window is open. Passing null clears any standing claim.
 *
 * Deliberately NOT consumed on grant. One arrival legitimately fires focus more
 * than once (the deferred-init rAF, then the mount replay), and those are all the
 * same user intent; the fingerprint and the TTL are what end a claim.
 */
export function claimArrivalFocus(sessionId: string | null): void {
  if (!sessionId) {
    arrivalClaim = null;
    return;
  }
  arrivalClaim = { sessionId, fingerprint: windowFocusFingerprint(), at: Date.now() };
}

/** True while focus sits in something the user could be typing into. */
function focusIsInTypingSurface(): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  return active.matches('input, textarea, select, [contenteditable="true"]');
}

/**
 * The live gate. Hosts pass this down to `useTerminal` as a predicate, so the hook
 * itself stays surface-agnostic and never imports this module.
 *
 * A null `sessionId` cannot arrive (both hosts require one before they mount a
 * terminal), so it is permitted rather than given a policy of its own.
 */
export function mayTakeArrivalFocus(sessionId: string | null): boolean {
  if (!sessionId) return true;
  const now = Date.now();
  const decision = resolveArrivalFocus({
    sessionId,
    claim: arrivalClaim,
    now,
    windowFocusFingerprint: windowFocusFingerprint(),
    focusedWindowTerminal: resolveFocusedWindowTerminal(),
    focusIsInTypingSurface: focusIsInTypingSurface(),
    lastGrant: lastArrivalGrant,
  });
  // Dev-only ring (see traceTerminalRenderer), so this costs nothing shipped. The
  // decision is the only record of WHY a terminal did or did not take focus, and
  // the next "typed into the wrong terminal" report needs it.
  traceTerminalRenderer(sessionId, 'arrival-focus', () => ({
    allow: decision.allow,
    reason: decision.reason,
  }));
  // Only a TIER-3 grant is recorded, because only tier 3 reads it. Tiers 1 and 2
  // are already exclusive - they deny a mismatch outright - so a burst hold adds
  // nothing there and actively misfires: a window that won tier 2 and then closed
  // would leave an unrelated tier-3 arrival denied as `burst-taken` for up to
  // ARRIVAL_BURST_MS with nothing actually contending for focus.
  if (decision.allow && decision.reason === 'unclaimed') {
    lastArrivalGrant = { sessionId, at: now };
  }
  return decision.allow;
}
