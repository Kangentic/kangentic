/**
 * `browser-navigation-registry` is the seam between the global mouse
 * back/forward gesture and whichever Browser pane owns it. The exact bug
 * this module exists to prevent: a pane closes (or otherwise stops caring)
 * but its `isActive()` closure would still answer true forever, so a closed
 * pane could keep winning a gesture it no longer owns unless releasing it
 * actually removes it from consideration. These tests pin that release path
 * and the active/inactive resolution.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  registerBrowserNavigationTarget,
  resolveBrowserNavigationTarget,
  resolveBrowserNavigationTargetForGuest,
  type BrowserNavigationTarget,
} from '../../src/renderer/utils/browser-navigation-registry';

function fakeTarget(overrides: Partial<BrowserNavigationTarget> = {}): BrowserNavigationTarget {
  return {
    isActive: () => false,
    webContentsId: () => null,
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => { /* no-op */ },
    goForward: () => { /* no-op */ },
    ...overrides,
  };
}

// Module-scope singleton (a Set): release every registration this file
// makes so no test can inherit another's entries.
const pendingReleases: Array<() => void> = [];

function register(target: BrowserNavigationTarget): () => void {
  const release = registerBrowserNavigationTarget(target);
  pendingReleases.push(release);
  return release;
}

afterEach(() => {
  while (pendingReleases.length > 0) {
    pendingReleases.pop()?.();
  }
});

describe('browser-navigation-registry', () => {
  it('resolves a registered target while it is active, and stops resolving it after release even though isActive() still answers true', () => {
    const target = fakeTarget({ isActive: () => true });
    const release = register(target);

    expect(resolveBrowserNavigationTarget()).toBe(target);

    release();

    // The closure itself still says active - only removal from the
    // registry, not a change in the pane's own state, is what must stop it
    // from resolving.
    expect(target.isActive()).toBe(true);
    expect(resolveBrowserNavigationTarget()).toBeNull();
  });

  it('with two registered targets, only the active one resolves', () => {
    const inactive = fakeTarget({ isActive: () => false });
    const active = fakeTarget({ isActive: () => true });
    register(inactive);
    register(active);

    expect(resolveBrowserNavigationTarget()).toBe(active);
  });

  it('returns null when no registered target is active', () => {
    register(fakeTarget({ isActive: () => false }));
    register(fakeTarget({ isActive: () => false }));

    expect(resolveBrowserNavigationTarget()).toBeNull();
  });

  it('with two active targets, the first registered (mount order) wins', () => {
    const firstMounted = fakeTarget({ isActive: () => true });
    const secondMounted = fakeTarget({ isActive: () => true });
    register(firstMounted);
    register(secondMounted);

    expect(resolveBrowserNavigationTarget()).toBe(firstMounted);
  });
});

// A press inside a page names its guest. A window just brought forward may have
// seen neither hover nor focus on the pane, so the id is what finds it.
describe('resolveBrowserNavigationTargetForGuest', () => {
  it('takes the pane whose guest sent the press over a pane that is merely active', () => {
    const active = fakeTarget({ isActive: () => true, webContentsId: () => 7 });
    const sender = fakeTarget({ webContentsId: () => 42 });
    register(active);
    register(sender);

    expect(resolveBrowserNavigationTargetForGuest(42)).toBe(sender);
  });

  it('falls back to an active pane whose guest has not registered yet', () => {
    const idle = fakeTarget({ webContentsId: () => 8 });
    const unregistered = fakeTarget({ isActive: () => true });
    register(idle);
    register(unregistered);

    expect(resolveBrowserNavigationTargetForGuest(99)).toBe(unregistered);
  });

  // Main sends a release for a guest destroyed mid-press after its pane has
  // already unregistered. That release names a guest no pane holds, and it must
  // not navigate whichever other pane happens to be hovered or focused.
  it('never takes an active pane that holds a different guest', () => {
    register(fakeTarget({ isActive: () => true, webContentsId: () => 7 }));

    expect(resolveBrowserNavigationTargetForGuest(99)).toBeNull();
  });

  it('finds nothing when no pane holds that guest and none is active', () => {
    register(fakeTarget());

    expect(resolveBrowserNavigationTargetForGuest(99)).toBeNull();
  });
});
