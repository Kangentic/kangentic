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
  type BrowserNavigationTarget,
} from '../../src/renderer/utils/browser-navigation-registry';

function fakeTarget(overrides: Partial<BrowserNavigationTarget> = {}): BrowserNavigationTarget {
  return {
    isActive: () => false,
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
