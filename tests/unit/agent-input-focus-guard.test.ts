/**
 * Unit tests for the Browser pane's agent-input focus-guard POLICY.
 *
 * The guard exists because a CDP click gives the guest REAL focus. Measured on
 * Electron 41 against a live guest: one `Input.dispatchMouseEvent` moved
 * `document.activeElement` from the terminal's `xterm-helper-textarea` to the
 * `<webview>` and flipped `document.hasFocus()` to false, so the rest of what
 * the user was typing went into the page. Main announces each drive and the
 * renderer puts the focus back.
 *
 * The three decisions are pure functions over primitives, split out the same way
 * `resolveArrivalFocus` is split out of `mayTakeArrivalFocus` - the unit tier
 * has no DOM, and each decision encodes a distinction that is easy to get subtly
 * wrong and effectively invisible when it is. The DOM plumbing around them
 * (listeners, timers, the actual `.focus()`) is UI-tier territory.
 *
 * Tier: Unit (vitest, no DOM).
 */
import { describe, it, expect } from 'vitest';
import {
  shouldArmFocusGuard,
  isGestureAwayFromGuardedElement,
  shouldRestoreStolenFocus,
} from '../../src/renderer/utils/agent-input-focus-guard';

describe('shouldArmFocusGuard', () => {
  it('arms when the user is focused somewhere outside the pane', () => {
    expect(shouldArmFocusGuard({
      hasActiveElement: true,
      activeIsBody: false,
      activeInsidePane: false,
      activeIsTextTarget: false,
    })).toBe(true);
  });

  it('does not arm when nothing has focus', () => {
    expect(shouldArmFocusGuard({
      hasActiveElement: false,
      activeIsBody: false,
      activeInsidePane: false,
      activeIsTextTarget: false,
    })).toBe(false);
  });

  it('does not arm when focus is parked on <body>', () => {
    // There is nothing to restore TO, and focusing body back would be a no-op
    // that still counts as the guard having acted.
    expect(shouldArmFocusGuard({
      hasActiveElement: true,
      activeIsBody: true,
      activeInsidePane: false,
      activeIsTextTarget: false,
    })).toBe(false);
  });

  it('does not arm when the user was already working inside the pane', () => {
    // An intra-pane focus move is the user's own business, not a steal - and
    // restoring would fight them.
    expect(shouldArmFocusGuard({
      hasActiveElement: true,
      activeIsBody: false,
      activeInsidePane: true,
      activeIsTextTarget: false,
    })).toBe(false);
  });

  it('DOES arm for an opted-in text input inside the pane', () => {
    // The pane's own note input is inside the pane, so the rule above read it as
    // the user's business and the guard never armed - which meant a drive stole
    // focus out of a sentence they were mid-way through typing, and every
    // keystroke after that went into the page with nothing to route it back.
    // The whole point of the "inside the pane" carve-out is a focus move the
    // user made themselves; this is one they did not.
    expect(shouldArmFocusGuard({
      hasActiveElement: true,
      activeIsBody: false,
      activeInsidePane: true,
      activeIsTextTarget: true,
    })).toBe(true);
  });

  it('still does not arm for a NON-text element inside the pane', () => {
    // The contrast case, and the one that keeps the exception narrow. A guest
    // the user clicked into surfaces as the <webview> element and the toolbar is
    // buttons; neither is a text target. Arming for those would snapshot a
    // terminal session and deliver keystrokes there while the user was typing
    // into the page - a misroute, which is worse than the drop it replaces.
    expect(shouldArmFocusGuard({
      hasActiveElement: true,
      activeIsBody: false,
      activeInsidePane: true,
      activeIsTextTarget: false,
    })).toBe(false);
  });

  it('a text target OUTSIDE the pane arms too, unchanged', () => {
    expect(shouldArmFocusGuard({
      hasActiveElement: true,
      activeIsBody: false,
      activeInsidePane: false,
      activeIsTextTarget: true,
    })).toBe(true);
  });

  it('body still wins over a text target claim', () => {
    // Order matters: the body short-circuit runs first, so a nonsensical input
    // combination cannot arm the guard on an element there is nothing to
    // restore to.
    expect(shouldArmFocusGuard({
      hasActiveElement: true,
      activeIsBody: true,
      activeInsidePane: false,
      activeIsTextTarget: true,
    })).toBe(false);
  });
});

describe('isGestureAwayFromGuardedElement', () => {
  it('does NOT count a keystroke into the guarded element as moving on', () => {
    // THE case this guard was rewritten for. The reported bug is "type in the
    // terminal while an agent drives"; a drive is short enough that an actively
    // typing user lands a keystroke inside it. Treating that as "the user went
    // elsewhere" disarms the guard and lets the steal through - the fix failing
    // in exactly its own repro, intermittently.
    expect(isGestureAwayFromGuardedElement({
      gestureIsGuardedElement: true,
      gestureInsideGuardedElement: false,
    })).toBe(false);
  });

  it('does not count a gesture on a child of the guarded element as moving on', () => {
    expect(isGestureAwayFromGuardedElement({
      gestureIsGuardedElement: false,
      gestureInsideGuardedElement: true,
    })).toBe(false);
  });

  it('counts a gesture aimed anywhere else as moving on', () => {
    // The user chose a different target; restoring would yank them back.
    expect(isGestureAwayFromGuardedElement({
      gestureIsGuardedElement: false,
      gestureInsideGuardedElement: false,
    })).toBe(true);
  });
});

describe('shouldRestoreStolenFocus', () => {
  it('restores when focus landed on the guest', () => {
    expect(shouldRestoreStolenFocus({
      restoreTargetConnected: true,
      activeIsRestoreTarget: false,
      activeIsGuest: true,
      activeInsidePane: false,
    })).toBe(true);
  });

  it('restores when focus landed elsewhere inside the pane', () => {
    // A pop-out pane's tree above the guest differs from the docked one's, so
    // containment is checked as well as the WEBVIEW tag.
    expect(shouldRestoreStolenFocus({
      restoreTargetConnected: true,
      activeIsRestoreTarget: false,
      activeIsGuest: false,
      activeInsidePane: true,
    })).toBe(true);
  });

  it('does nothing when focus never entered the pane', () => {
    // The user moved somewhere else entirely during the drive.
    expect(shouldRestoreStolenFocus({
      restoreTargetConnected: true,
      activeIsRestoreTarget: false,
      activeIsGuest: false,
      activeInsidePane: false,
    })).toBe(false);
  });

  it('does nothing when focus never actually moved', () => {
    expect(shouldRestoreStolenFocus({
      restoreTargetConnected: true,
      activeIsRestoreTarget: true,
      activeIsGuest: false,
      activeInsidePane: false,
    })).toBe(false);
  });

  it('does nothing when the element it would restore to has left the document', () => {
    // Focusing a detached node silently does nothing, so this would report a
    // restore that never happened.
    expect(shouldRestoreStolenFocus({
      restoreTargetConnected: false,
      activeIsRestoreTarget: false,
      activeIsGuest: true,
      activeInsidePane: false,
    })).toBe(false);
  });
});
