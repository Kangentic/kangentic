/**
 * Unit coverage for the manager-resize gate primitive.
 *
 * The gate is a module-level singleton that the window manager's imperative
 * resizers open for the duration of a drag, so a window-hosted terminal suppresses
 * its per-frame ResizeObserver refit and the PTY is resized once on commit instead
 * of once per drag frame (which would stack duplicate Claude banners in scrollback).
 *
 * The functions are pure counter logic with no DOM dependency, so we exercise the
 * real exported module directly. The end-to-end SIGWINCH/scrollback behavior is
 * verified empirically via the dev getScrollback IPC, not here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginManagerResize,
  endManagerResize,
  isManagerResizeInProgress,
} from '../../src/renderer/window-manager/terminal/manager-resize-gate';

describe('manager-resize-gate', () => {
  // The gate is a module singleton; drain it to a known-closed state before each
  // test so state does not leak between cases.
  beforeEach(() => {
    while (isManagerResizeInProgress()) endManagerResize();
  });

  it('starts closed', () => {
    expect(isManagerResizeInProgress()).toBe(false);
  });

  it('opens on begin and closes on the matching end', () => {
    beginManagerResize();
    expect(isManagerResizeInProgress()).toBe(true);
    endManagerResize();
    expect(isManagerResizeInProgress()).toBe(false);
  });

  it('stays open across nested gestures until every begin is matched', () => {
    beginManagerResize();
    beginManagerResize();
    expect(isManagerResizeInProgress()).toBe(true);
    endManagerResize();
    // One gesture still open: the gate must stay closed-suppressing, i.e. in progress.
    expect(isManagerResizeInProgress()).toBe(true);
    endManagerResize();
    expect(isManagerResizeInProgress()).toBe(false);
  });

  it('floors at zero so an unmatched end cannot drive the counter negative', () => {
    // A spurious end (e.g. a multi-pointer race) must not leave the gate "owing"
    // ends, which would wedge a later real begin as a no-op.
    endManagerResize();
    endManagerResize();
    expect(isManagerResizeInProgress()).toBe(false);
    // A subsequent real gesture still opens the gate normally.
    beginManagerResize();
    expect(isManagerResizeInProgress()).toBe(true);
    endManagerResize();
    expect(isManagerResizeInProgress()).toBe(false);
  });
});
