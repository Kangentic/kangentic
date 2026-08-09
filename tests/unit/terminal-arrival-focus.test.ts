/**
 * Unit tests for the terminal arrival-focus arbiter.
 *
 * The bug: opening a task detail evicts the bottom panel's selected session, so
 * the panel mounts a terminal for a DIFFERENT session at the same moment the
 * detail window mounts its own. Both replays end in `xterm.focus()`, and whichever
 * resolves last wins - so keystrokes intended for the task you just opened land in
 * whatever agent the panel happened to fall back to.
 *
 * The property under test is EXCLUSIVITY. Each tier that resolves an answer
 * decides outright: it allows a match and DENIES a mismatch, and never falls
 * through to a lower tier that might allow. A tier that fell through would let two
 * terminals arriving in the same frame both find themselves permitted, which is
 * the race all over again. Every mismatch case below is therefore constructed so
 * that the NEXT tier down would have allowed it.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import {
  resolveArrivalFocus,
  windowFocusFingerprint,
  mayTakeArrivalFocus,
  claimArrivalFocus,
  ARRIVAL_CLAIM_TTL_MS,
  ARRIVAL_BURST_MS,
  type ArrivalFocusInput,
} from '../../src/renderer/utils/terminal-arrival-focus';
import {
  boardWindowManager,
  commandWindowManager,
  monitorWindowManager,
} from '../../src/renderer/window-manager';

const NOW = 1_000_000;

/**
 * Shared by EVERY block below that calls the real `mayTakeArrivalFocus`, and
 * deliberately module-scope rather than one `let` per describe.
 *
 * `lastArrivalGrant` is module state inside the arbiter with no exported reset,
 * so the only way to neutralize a grant an earlier test armed is for every later
 * test to run at a strictly later timestamp. A per-describe clock breaks that:
 * the second block restarts at NOW, which is EARLIER than the grants the first
 * block advanced past, so `now - lastGrant.at` goes negative - and a negative age
 * still satisfies `<= ARRIVAL_BURST_MS`, denying an unrelated session as
 * `burst-taken`. One monotonic clock across all blocks makes that unrepresentable
 * regardless of the order vitest runs them in.
 */
let monotonicClock = NOW;

/** Advance past any grant a previous test could have armed, then pin fake time there. */
function advanceToFreshInstant(): void {
  monotonicClock += ARRIVAL_BURST_MS * 10;
  vi.setSystemTime(monotonicClock);
}

/**
 * A single monotonic fake-time cursor shared by every `beforeEach` below that
 * uses `vi.useFakeTimers()` (the two "real wrapper" describe blocks further
 * down). `lastArrivalGrant` (module state in the source, no exported reset)
 * persists across tests and across describe blocks within this file, so two
 * INDEPENDENT cursors that each restart at `NOW` can go backwards relative to
 * a grant a block collected earlier - which reads as a negative age, which is
 * always `<= ARRIVAL_BURST_MS`, which spuriously denies the next block's
 * first case. One shared, always-advancing cursor keeps every test strictly
 * later than any grant any earlier test in the file could have recorded.
 */
let arrivalFocusFakeClock = NOW;

/** Tier 3, allowing: no claim, no focused window, focus not in a typing surface. */
function baseInput(overrides: Partial<ArrivalFocusInput> = {}): ArrivalFocusInput {
  return {
    sessionId: 'sess-arriving',
    claim: null,
    now: NOW,
    windowFocusFingerprint: 'board:|cmd:|mon:',
    focusedWindowTerminal: null,
    focusIsInTypingSurface: false,
    lastGrant: null,
    ...overrides,
  };
}

describe('resolveArrivalFocus - tier 1, the user-gesture claim', () => {
  it('allows the claimed session', () => {
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-clicked',
      claim: { sessionId: 'sess-clicked', fingerprint: 'board:|cmd:|mon:', at: NOW },
    }));
    expect(result).toEqual({ allow: true, reason: 'claim' });
  });

  it('DENIES an unclaimed session even when tier 2 would have allowed it', () => {
    // Exclusivity. The user clicked panel tab `sess-clicked`, so the detail
    // window's terminal must not take focus just because its window is focused.
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-detail',
      claim: { sessionId: 'sess-clicked', fingerprint: 'board:|cmd:|mon:', at: NOW },
      focusedWindowTerminal: { sessionId: 'sess-detail' },
    }));
    expect(result).toEqual({ allow: false, reason: 'claim-mismatch' });
  });

  it('stops applying once the window layers move focus (fingerprint supersession)', () => {
    // The reverse bug a TTL alone would create: click a panel tab, then open a
    // detail window inside the TTL, and focus would stay stuck on the panel.
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-detail',
      claim: { sessionId: 'sess-clicked', fingerprint: 'board:|cmd:|mon:', at: NOW },
      windowFocusFingerprint: 'board:board-window-1|cmd:|mon:',
      focusedWindowTerminal: { sessionId: 'sess-detail' },
    }));
    expect(result).toEqual({ allow: true, reason: 'window' });
  });

  it('stops applying after the backstop TTL lapses', () => {
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-detail',
      claim: {
        sessionId: 'sess-clicked',
        fingerprint: 'board:|cmd:|mon:',
        at: NOW - ARRIVAL_CLAIM_TTL_MS - 1,
      },
      focusedWindowTerminal: { sessionId: 'sess-detail' },
    }));
    expect(result).toEqual({ allow: true, reason: 'window' });
  });

  it('still applies at exactly the TTL boundary', () => {
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-clicked',
      claim: {
        sessionId: 'sess-clicked',
        fingerprint: 'board:|cmd:|mon:',
        at: NOW - ARRIVAL_CLAIM_TTL_MS,
      },
    }));
    expect(result).toEqual({ allow: true, reason: 'claim' });
  });
});

describe('resolveArrivalFocus - tier 2, the focused window', () => {
  it('allows the focused window\'s own terminal', () => {
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-detail',
      focusedWindowTerminal: { sessionId: 'sess-detail' },
    }));
    expect(result).toEqual({ allow: true, reason: 'window' });
  });

  it('DENIES the bottom panel\'s evicted-fallback terminal - the reported bug', () => {
    // Exclusivity again: tier 3 would have allowed this (focus is not in a typing
    // surface), which is exactly how the panel used to win the race.
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-panel-fallback',
      focusedWindowTerminal: { sessionId: 'sess-detail' },
    }));
    expect(result).toEqual({ allow: false, reason: 'window-mismatch' });
  });

  it('DENIES everyone while a focused window has not spawned its session yet', () => {
    // A window with no session still owns the user's attention, so it must not
    // read as "no window focused" and let some other terminal grab focus.
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-panel-fallback',
      focusedWindowTerminal: { sessionId: null },
    }));
    expect(result).toEqual({ allow: false, reason: 'window-mismatch' });
  });
});

describe('resolveArrivalFocus - tier 3, nothing owns the user\'s attention', () => {
  it('allows an arrival on a cold start', () => {
    expect(resolveArrivalFocus(baseInput())).toEqual({ allow: true, reason: 'unclaimed' });
  });

  it('denies while focus sits in a typing surface', () => {
    // `.xterm-helper-textarea` is a <textarea>, so this is also what stops an
    // arriving terminal yanking focus out of one being typed into.
    const result = resolveArrivalFocus(baseInput({ focusIsInTypingSurface: true }));
    expect(result).toEqual({ allow: false, reason: 'occupied' });
  });

  it('lets one winner through when several terminals arrive together', () => {
    // A workspace restore that persisted no focused window puts every restored
    // terminal plus the panel in tier 3 at once.
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-second',
      lastGrant: { sessionId: 'sess-first', at: NOW - 10 },
    }));
    expect(result).toEqual({ allow: false, reason: 'burst-taken' });
  });

  it('does not block the SAME session re-arriving inside the burst window', () => {
    // One arrival legitimately fires focus more than once (the deferred-init rAF,
    // then the mount replay). Those must not fight each other.
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-first',
      lastGrant: { sessionId: 'sess-first', at: NOW - 10 },
    }));
    expect(result).toEqual({ allow: true, reason: 'unclaimed' });
  });

  it('releases the burst hold once it lapses', () => {
    const result = resolveArrivalFocus(baseInput({
      sessionId: 'sess-second',
      lastGrant: { sessionId: 'sess-first', at: NOW - ARRIVAL_BURST_MS - 1 },
    }));
    expect(result).toEqual({ allow: true, reason: 'unclaimed' });
  });
});

/** Shared by the fingerprint describe below and by the impure-wrapper describe
 *  further down, which also needs a known "no window focused" starting point. */
function resetWindowStores(): void {
  for (const manager of [boardWindowManager, commandWindowManager, monitorWindowManager]) {
    manager.store.setState({
      windows: {},
      order: [],
      focusedWindowId: null,
      zCounter: 0,
      tileTree: null,
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    });
  }
}

/**
 * The fingerprint is what supersedes a stale claim without any subscription, so
 * it must actually move on every window-focus transition. If it stopped changing,
 * tier 1 would keep applying after the user moved to a window and the arbiter
 * would hold focus on the panel.
 */
describe('windowFocusFingerprint (real window stores)', () => {
  beforeEach(resetWindowStores);
  afterAll(resetWindowStores);

  it('changes when a window opens, when focus moves, and when a window closes', () => {
    const empty = windowFocusFingerprint();

    const firstId = boardWindowManager.store.getState().openWindow({
      anchor: 'task-1',
      sessionId: null,
      title: 'Task One',
    });
    const afterOpen = windowFocusFingerprint();
    expect(afterOpen).not.toBe(empty);

    boardWindowManager.store.getState().openWindow({
      anchor: 'task-2',
      sessionId: null,
      title: 'Task Two',
    });
    const afterSecondOpen = windowFocusFingerprint();
    expect(afterSecondOpen).not.toBe(afterOpen);

    boardWindowManager.store.getState().focusWindow(firstId);
    expect(windowFocusFingerprint()).toBe(afterOpen);

    boardWindowManager.store.getState().closeWindow(firstId);
    expect(windowFocusFingerprint()).not.toBe(afterOpen);
  });

  it('distinguishes the layer a window belongs to', () => {
    boardWindowManager.store.getState().openWindow({
      anchor: 'task-1',
      sessionId: null,
      title: 'Task One',
    });
    const boardFocused = windowFocusFingerprint();

    resetWindowStores();
    monitorWindowManager.store.getState().openWindow({
      anchor: 'proj-1:task-1',
      sessionId: null,
      title: 'Task One',
    });

    // Both layers issue ids from their own sequence, so a fingerprint that did not
    // carry the layer prefix could collide across layers.
    expect(windowFocusFingerprint()).not.toBe(boardFocused);
  });
});

/**
 * `resolveArrivalFocus` above is the pure decision table, exercised with
 * injected inputs. These tests instead call the REAL exported wrapper -
 * `mayTakeArrivalFocus` / `claimArrivalFocus` - so a bug in the module-scope
 * `arrivalClaim` / `lastArrivalGrant` plumbing itself (not just the pure
 * decision table) fails red. Nothing here duplicates the pure-function tiers;
 * every case below is chosen because it can only be observed through the real
 * wrapper's module state.
 *
 * This project deliberately runs its unit tier without jsdom (see
 * use-terminal-font-race.test.ts), so `document` does not exist as a runtime
 * global here. `mayTakeArrivalFocus` reaches `document.activeElement` only via
 * the private `focusIsInTypingSurface()`, so a minimal stub - not a full DOM -
 * is enough: `activeElement: null` makes that check false unconditionally,
 * which is all tier 1 and tier 3 below need. `vi.stubGlobal` mirrors the same
 * pattern `terminal-mount-registry.test.ts` uses for `window`.
 *
 * `lastArrivalGrant` has no exported reset, so a fixed `vi.setSystemTime(NOW)`
 * per test would let a grant armed by an earlier test still read as "0ms old"
 * in a later one. `advanceToFreshInstant()` steps the SHARED monotonic clock
 * instead, so every test starts strictly later than any grant armed anywhere in
 * this file and residual state never has to be tracked by hand.
 */
describe('mayTakeArrivalFocus / claimArrivalFocus (the real, impure wrapper)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    advanceToFreshInstant();
    resetWindowStores();
    claimArrivalFocus(null);
    vi.stubGlobal('document', { activeElement: null });
  });

  afterEach(() => {
    claimArrivalFocus(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('claimArrivalFocus(null) clears a standing claim', () => {
    claimArrivalFocus('sess-a');
    claimArrivalFocus(null);

    // A DIFFERENT session must now be granted through tier 3 rather than
    // denied as a claim-mismatch against the session cleared above. If the
    // null branch became a no-op, the stale claim on 'sess-a' would still be
    // live and would deny 'sess-b'.
    expect(mayTakeArrivalFocus('sess-b')).toBe(true);
  });

  it('claims tier-1 exclusivity through the real wrapper: the claimed session is allowed, any other is denied', () => {
    claimArrivalFocus('sess-a');
    expect(mayTakeArrivalFocus('sess-a')).toBe(true);

    // Step past the tier-3 burst window (well inside the tier-1 claim's own
    // TTL) before the second check. Without this, a wrapper that silently
    // stopped threading the real `arrivalClaim` into tier 1 would fall
    // through to tier 3, which would ALSO deny 'sess-b' immediately after
    // granting 'sess-a' - but for the wrong reason (a fresh burst hold, not a
    // live claim mismatch), making the assertion below pass vacuously.
    // Stepping past the burst window removes that false-pass path.
    vi.advanceTimersByTime(ARRIVAL_BURST_MS + 1);

    expect(mayTakeArrivalFocus('sess-b')).toBe(false);
  });

  it('records lastArrivalGrant only for a tier-3 (unclaimed) grant, never for a tier-1 (claim) grant', () => {
    claimArrivalFocus('sess-claimed');
    // Tier-1 grant. If this incorrectly armed the burst hold, the very next
    // check below (an unrelated session, checked at the SAME instant, well
    // inside ARRIVAL_BURST_MS) would be denied as burst-taken instead of
    // reaching tier 3 on its own.
    expect(mayTakeArrivalFocus('sess-claimed')).toBe(true);
    claimArrivalFocus(null);

    expect(mayTakeArrivalFocus('sess-unrelated')).toBe(true);
  });
});

/**
 * `focusIsInTypingSurface` is private, with no exported test seam, so this
 * block reaches it the only way anything can: through `mayTakeArrivalFocus`'s
 * real tier-3 branch. A stub `document.activeElement` with a SPIED `matches`
 * stands in for jsdom, which this tier deliberately does not have (see the
 * block above). That means these tests can only pin the CONTRACT - which
 * exact selector string gets asked, and the `document.body` short-circuit -
 * rather than real `Element.matches` CSS-matching semantics. That is a
 * narrower claim than a real browser DOM would give, and is a deliberate
 * tradeoff: a UI-tier version was considered and rejected, because every
 * user gesture that causes an arrival in the real running app (a panel tab
 * click, the collapse/expand toggle) ALSO calls `claimArrivalFocus` - so a
 * genuinely unclaimed arrival with a controlled focus target cannot be
 * manufactured through the app's real mounted flows without mutating
 * session activity mid-test through the mock IPC layer, which is not
 * available at this tier either.
 */
describe('focusIsInTypingSurface (through mayTakeArrivalFocus, its only entry point)', () => {
  // Shares the file-level monotonic clock with the block above, which is the
  // whole point: a per-block clock restarting at NOW would run EARLIER than the
  // grants that block already armed, and a negative grant age still reads as
  // inside ARRIVAL_BURST_MS, denying these sessions as `burst-taken`.
  beforeEach(() => {
    vi.useFakeTimers();
    advanceToFreshInstant();
    resetWindowStores();
    claimArrivalFocus(null);
  });

  afterEach(() => {
    claimArrivalFocus(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not read a non-matching element (e.g. a <button>) as a typing surface, and asks the exact selector list', () => {
    const matchesSpy = vi.fn(() => false);
    vi.stubGlobal('document', { body: {}, activeElement: { matches: matchesSpy } });

    expect(mayTakeArrivalFocus('sess-button-focus')).toBe(true);
    // The load-bearing assertion: this is what fails if `button` (or anything
    // else) is ever added to the selector list. The return-value assertion
    // above cannot see that change, because the stub returns whatever this
    // test told it to regardless of which selector string was actually
    // passed in.
    expect(matchesSpy).toHaveBeenCalledWith('input, textarea, select, [contenteditable="true"]');
  });

  it('reads a matching element (e.g. a <textarea>) as a typing surface and denies the arrival', () => {
    const matchesSpy = vi.fn(() => true);
    vi.stubGlobal('document', { body: {}, activeElement: { matches: matchesSpy } });

    expect(mayTakeArrivalFocus('sess-textarea-focus')).toBe(false);
  });

  it('short-circuits on activeElement === document.body without calling matches', () => {
    const matchesSpy = vi.fn(() => true);
    const bodySentinel = { matches: matchesSpy };
    vi.stubGlobal('document', { body: bodySentinel, activeElement: bodySentinel });

    expect(mayTakeArrivalFocus('sess-body-focus')).toBe(true);
    // The load-bearing assertion for the second red condition: dropping the
    // `active === document.body` guard would route this call into
    // `active.matches(...)` instead of short-circuiting. A real
    // `document.body` never matches the selector list either, so a
    // return-value-only assertion cannot see the guard's removal - only the
    // call count can.
    expect(matchesSpy).not.toHaveBeenCalled();
  });
});
