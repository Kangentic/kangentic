/**
 * `terminal-anchor-registry` is what the dictation chip asks "where is this
 * session's terminal drawn". A stale answer (a released anchor still
 * resolving, or a disposed node winning over a live one) would position the
 * chip against a node that no longer exists. These tests pin the release
 * path and the backwards tiebreak walk, since those are the two places a
 * regression would be silent rather than throw.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  registerTerminalAnchor,
  resolveTerminalAnchorElement,
} from '../../src/renderer/utils/terminal-anchor-registry';

/**
 * The registry only ever calls `.isConnected` and `.getBoundingClientRect()`
 * on whatever it is handed, so a structural stand-in is enough - no jsdom
 * needed for this module.
 */
interface FakeAnchorElement {
  isConnected: boolean;
  getBoundingClientRect: () => { width: number; height: number };
}

function fakeElement(overrides: Partial<FakeAnchorElement> = {}): HTMLElement {
  const element: FakeAnchorElement = {
    isConnected: true,
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    ...overrides,
  };
  return element as unknown as HTMLElement;
}

// Module-scope singleton: release every registration this file makes so no
// test can inherit another's entries.
const pendingReleases: Array<() => void> = [];

function register(sessionId: string | null, element: HTMLElement | null): () => void {
  const release = registerTerminalAnchor(sessionId, element);
  pendingReleases.push(release);
  return release;
}

afterEach(() => {
  while (pendingReleases.length > 0) {
    pendingReleases.pop()?.();
  }
});

describe('terminal-anchor-registry', () => {
  it('leaves the second anchor resolvable after the first of two same-session registrations releases', () => {
    const sessionId = 'session-double-hold';
    const first = fakeElement();
    const second = fakeElement();
    const releaseFirst = register(sessionId, first);
    register(sessionId, second);

    releaseFirst();

    expect(resolveTerminalAnchorElement(sessionId)).toBe(second);
  });

  it('walks backwards: the most recently registered anchor wins when a session is held twice', () => {
    const sessionId = 'session-tiebreak';
    const older = fakeElement();
    const newer = fakeElement();
    register(sessionId, older);
    register(sessionId, newer);

    expect(resolveTerminalAnchorElement(sessionId)).toBe(newer);
  });

  it('skips a detached anchor in favor of an older connected one', () => {
    const sessionId = 'session-detached';
    const older = fakeElement({ isConnected: true });
    const newerDetached = fakeElement({ isConnected: false });
    register(sessionId, older);
    register(sessionId, newerDetached);

    expect(resolveTerminalAnchorElement(sessionId)).toBe(older);
  });

  it('skips a zero-sized anchor in favor of an older non-zero one', () => {
    const sessionId = 'session-zero-size';
    const older = fakeElement({ getBoundingClientRect: () => ({ width: 200, height: 80 }) });
    const newerZeroSized = fakeElement({ getBoundingClientRect: () => ({ width: 0, height: 0 }) });
    register(sessionId, older);
    register(sessionId, newerZeroSized);

    expect(resolveTerminalAnchorElement(sessionId)).toBe(older);
  });

  it('calling the same release function twice does not remove a later registration of the same element', () => {
    const sessionId = 'session-double-release';
    const element = fakeElement();
    const release = register(sessionId, element);

    release();
    expect(resolveTerminalAnchorElement(sessionId)).toBeNull();

    // The same element reference re-registers (e.g. the same DOM node
    // remounted after the first release already fired).
    register(sessionId, element);

    // The STALE first release fires again (e.g. a cleanup effect invoked
    // twice). Without the `released` latch this matches by object identity
    // and rips the fresh registration back out.
    release();

    expect(resolveTerminalAnchorElement(sessionId)).toBe(element);
  });

  it('is safe to call the release function when registered with a null sessionId or a null element', () => {
    const releaseForNullSession = register(null, fakeElement());
    const releaseForNullElement = register('session-null-element', null);

    expect(() => releaseForNullSession()).not.toThrow();
    expect(() => releaseForNullElement()).not.toThrow();
    expect(resolveTerminalAnchorElement('session-null-element')).toBeNull();
  });

  it('returns null once the last anchor for a session is released', () => {
    const sessionId = 'session-empties-out';
    const release = register(sessionId, fakeElement());

    expect(resolveTerminalAnchorElement(sessionId)).not.toBeNull();

    release();

    expect(resolveTerminalAnchorElement(sessionId)).toBeNull();
  });
});
