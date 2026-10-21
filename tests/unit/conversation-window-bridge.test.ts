/**
 * `useConversationWindowBridge`: how the session store's open-conversation
 * signal becomes a window, and in particular the tab request riding with it.
 *
 * A Route pill calls `setConversationSessionId(sessionId, tab)`. The bridge hands
 * that tab to `openWindow`, then CLEARS it from the store, so the request is a
 * one-shot. Without the clear, any later re-run of the effect (a remount, a
 * project switch that keeps the signal) would hand the same tab to a window the
 * user has since moved to another tab, and snap it back.
 *
 * The signal's request counter is the other half: the effect keys on
 * `[conversationSessionId, conversationRequestId]`, so a second Route pill for a
 * conversation that is already open re-runs it and re-aims the window.
 *
 * The unit tier has no DOM and no renderer (see agent-driven-invalidation-
 * changed-in-other-window.test.ts), so `react` is replaced with a small
 * harness: `useRef` keeps its value per call slot, and `useEffect` queues its
 * effect, runs it only when its deps changed (compared with `Object.is`, as React
 * does) and runs the previous cleanup first. `renderBridge()` is one render
 * followed by the queued effects, and it repeats until no effect fires, which is
 * the re-render React would schedule after an effect writes to a store. The two
 * store hooks are wrapped as plain selector functions over the REAL stores, so
 * the real `openWindow`, `clearConversationTab` and `setConversationSessionId`
 * run. An always-run `useEffect` would hide the deps contract, which is why the
 * harness compares them.
 *
 * Kept apart from session-store-conversation-request.test.ts on purpose: a
 * file-level `vi.mock('react')` must not leak into that file's plain store cases.
 *
 * Red-green: drop the `setState({ conversationTab: null })` line in the bridge
 * and the first two cases fail; drop `conversationRequestId` from the effect's
 * deps and the repeat-request case fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConversationTabRequest } from '../../src/shared/types';

const harness = vi.hoisted(() => {
  const trackFeatureUsed = vi.fn();
  // The bridge reads a bare `window` for its analytics ping.
  (globalThis as Record<string, unknown>).window = { electronAPI: { analytics: { trackFeatureUsed } } };
  return {
    trackFeatureUsed,
    effects: [] as Array<{ deps: readonly unknown[] | undefined; cleanup: unknown }>,
    refs: [] as Array<{ current: unknown }>,
    effectIndex: 0,
    refIndex: 0,
    queued: [] as Array<() => void>,
  };
});

function sameDeps(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (!previous || !next || previous.length !== next.length) return false;
  return next.every((dependency, index) => Object.is(dependency, previous[index]));
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const withHarnessHooks = {
    ...actual,
    useRef: <Value,>(initial: Value) => {
      const slot = harness.refIndex++;
      harness.refs[slot] ??= { current: initial };
      return harness.refs[slot] as { current: Value };
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const slot = harness.effectIndex++;
      const previous = harness.effects[slot];
      if (previous && sameDeps(previous.deps, deps)) return;
      harness.queued.push(() => {
        if (typeof previous?.cleanup === 'function') previous.cleanup();
        harness.effects[slot] = { deps, cleanup: effect() };
      });
    },
  };
  return { ...withHarnessHooks, default: withHarnessHooks };
});

vi.mock('../../src/renderer/stores/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/stores/session-store')>();
  const real = actual.useSessionStore;
  const plainHook = Object.assign(
    <Selected,>(selector: (state: ReturnType<typeof real.getState>) => Selected) => selector(real.getState()),
    { getState: real.getState, setState: real.setState, subscribe: real.subscribe },
  );
  return { ...actual, useSessionStore: plainHook };
});

vi.mock('../../src/renderer/window-manager/store/window-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/window-manager/store/window-store')>();
  const real = actual.useWindowStore;
  const plainHook = Object.assign(
    <Selected,>(selector: (state: ReturnType<typeof real.getState>) => Selected) => selector(real.getState()),
    { getState: real.getState, setState: real.setState, subscribe: real.subscribe },
  );
  return { ...actual, useWindowStore: plainHook };
});

import { useConversationWindowBridge } from '../../src/renderer/window-manager/bridge/useConversationWindowBridge';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { useWindowStore } from '../../src/renderer/window-manager/store/window-store';

const SESSION_ID = 'session-bridge-1';
const REVIEW_TAB: ConversationTabRequest = {
  swimlaneId: 'swimlane-review',
  visitStartedAt: '2026-10-20T18:11:00.000Z',
};
const EXECUTING_TAB: ConversationTabRequest = { swimlaneId: 'swimlane-executing' };

/** One render, then its queued effects. Returns how many effects ran. */
function renderOnce(): number {
  harness.effectIndex = 0;
  harness.refIndex = 0;
  harness.queued = [];
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the harness stands in for React's renderer: `react` is mocked, so this call is the render
  useConversationWindowBridge();
  const queued = harness.queued;
  for (const run of queued) run();
  return queued.length;
}

/** Re-render until no effect fires, as React does after an effect writes a store. */
function renderUntilSettled(): void {
  for (let pass = 0; pass < 10; pass += 1) {
    if (renderOnce() === 0) return;
  }
  throw new Error('the bridge never settled: an effect keeps re-triggering itself');
}

/** Tear the hook down the way an unmount does: cleanups run, slots are dropped. */
function unmountBridge(): void {
  for (const effect of harness.effects) {
    if (typeof effect?.cleanup === 'function') effect.cleanup();
  }
  harness.effects.length = 0;
  harness.refs.length = 0;
}

function conversationWindows() {
  return Object.values(useWindowStore.getState().windows).filter((candidate) => candidate.kind === 'conversation');
}

beforeEach(() => {
  harness.trackFeatureUsed.mockClear();
  useSessionStore.setState({ conversationSessionId: null, conversationTab: null, conversationRequestId: 0 });
  useWindowStore.setState({ windows: {}, order: [], focusedWindowId: null, zCounter: 0, tileTree: null });
});

afterEach(() => {
  unmountBridge();
});

describe('useConversationWindowBridge: the tab request', () => {
  it('hands the tab to the new window, then clears it from the store', () => {
    renderUntilSettled();
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);

    renderUntilSettled();

    const opened = conversationWindows();
    expect(opened).toHaveLength(1);
    expect(opened[0].anchor).toBe(SESSION_ID);
    expect(opened[0].conversationTab).toEqual(REVIEW_TAB);
    // The one-shot: the store no longer holds the request, but still holds the signal.
    expect(useSessionStore.getState().conversationTab).toBeNull();
    expect(useSessionStore.getState().conversationSessionId).toBe(SESSION_ID);
  });

  it('opens a window with no tab when none was asked for', () => {
    renderUntilSettled();
    useSessionStore.getState().setConversationSessionId(SESSION_ID);

    renderUntilSettled();

    const opened = conversationWindows();
    expect(opened).toHaveLength(1);
    expect('conversationTab' in opened[0]).toBe(false);
  });

  it('does not ask for the tab again when the hook remounts with the signal still set', () => {
    renderUntilSettled();
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);
    renderUntilSettled();
    const [opened] = conversationWindows();
    // The window has applied the request and acknowledged it, as ConversationWindow does.
    useWindowStore.getState().clearConversationTab(opened.id);
    expect('conversationTab' in useWindowStore.getState().windows[opened.id]).toBe(false);

    unmountBridge();
    renderUntilSettled();

    // Same window, still on the tab the user moved to: nothing re-handed the old request.
    expect(conversationWindows()).toHaveLength(1);
    expect('conversationTab' in useWindowStore.getState().windows[opened.id]).toBe(false);
  });

  it('re-aims the open window when the same session is requested again with another tab', () => {
    renderUntilSettled();
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);
    renderUntilSettled();
    const [opened] = conversationWindows();
    useWindowStore.getState().clearConversationTab(opened.id);

    // Same session id as before: only the request counter tells the effect to re-run.
    useSessionStore.getState().setConversationSessionId(SESSION_ID, EXECUTING_TAB);
    renderUntilSettled();

    const reopened = conversationWindows();
    expect(reopened).toHaveLength(1);
    expect(reopened[0].id).toBe(opened.id);
    expect(reopened[0].conversationTab).toEqual(EXECUTING_TAB);
    expect(useSessionStore.getState().conversationTab).toBeNull();
  });
});
