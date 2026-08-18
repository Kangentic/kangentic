/**
 * Unit tests for the `openedByAgent` stamp on a managed window.
 *
 * `kangentic_browser_open_pane` opens or raises a task-detail window on an
 * AGENT's behalf. That moves `focusedWindowId`, which is what the arrival-focus
 * arbiter reads to decide which terminal may take the keyboard on mount - so
 * without a marker, the agent's window hands its own arriving terminal the
 * keystrokes the user was typing somewhere else.
 *
 * Two properties carry the whole design, and each has a case here that fails if
 * it is reversed:
 *
 *   1. DEFAULT BY OMISSION IS "USER". The property is set only when true, so a
 *      user path cannot inherit an agent stamp by forgetting to clear one.
 *   2. `focusWindow` CLEARS IT, INCLUDING WHEN ALREADY FOCUSED. Clearing after
 *      the same-id early return would strand the stamp forever: an agent-opened
 *      window IS the focused window, so the user's click on its frame takes
 *      exactly that path.
 *
 * Tier: Unit (vitest, no DOM, no Electron - the store is plain Zustand).
 * See `.claude/rules/agent-driven-focus.md`.
 */
import { describe, it, expect } from 'vitest';
import { createWindowManagerStore } from '../../src/renderer/window-manager/store/window-store';

function makeStore() {
  return createWindowManagerStore({ idPrefix: 'test', kind: 'task-detail' }).store;
}

describe('openWindow stamps openedByAgent', () => {
  it('sets the flag when the open came from an agent', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1', openedByAgent: true });
    expect(store.getState().windows[id].openedByAgent).toBe(true);
  });

  it('leaves the property ABSENT on a plain user open', () => {
    // Absent, not `false`: default-by-omission is what makes a forgotten flag on
    // a user path impossible rather than merely unlikely.
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1' });
    expect('openedByAgent' in store.getState().windows[id]).toBe(false);
  });

  it('leaves the property absent when openedByAgent is explicitly false', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1', openedByAgent: false });
    expect('openedByAgent' in store.getState().windows[id]).toBe(false);
  });

  it('stamps an ALREADY-OPEN window an agent asks for again', () => {
    // The warm path: the task's window is already up, so `openWindow` resolves to
    // `focusWindow` instead of creating one. That still raises the window on the
    // agent's behalf, so it still has to deny arrival focus.
    const store = makeStore();
    const first = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1' });
    const second = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1', openedByAgent: true });
    expect(second).toBe(first);
    expect(store.getState().windows[first].openedByAgent).toBe(true);
  });

  it('does not stamp an already-open window on a plain user open', () => {
    const store = makeStore();
    const first = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1', openedByAgent: true });
    // A different window takes focus, so the re-open below genuinely re-focuses.
    store.getState().openWindow({ anchor: 'task-2', sessionId: 's2', title: 'Task 2' });
    store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1' });
    expect(store.getState().windows[first].openedByAgent).toBeUndefined();
  });
});

describe('focusWindow clears openedByAgent', () => {
  it('clears the stamp when the user focuses a DIFFERENT window', () => {
    const store = makeStore();
    const agentWindow = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1', openedByAgent: true });
    store.getState().openWindow({ anchor: 'task-2', sessionId: 's2', title: 'Task 2' });
    store.getState().focusWindow(agentWindow);
    expect(store.getState().windows[agentWindow].openedByAgent).toBeUndefined();
  });

  it('clears the stamp even when the window is ALREADY focused', () => {
    // The load-bearing case. An agent-opened window is by definition the focused
    // one, so the user's first pointer-down on its frame calls `focusWindow` with
    // the id that is already focused. If the clear sat after the same-id early
    // return, the stamp would never come off and that window's terminal could
    // never take focus again.
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1', openedByAgent: true });
    expect(store.getState().focusedWindowId).toBe(id);

    store.getState().focusWindow(id);

    expect(store.getState().windows[id].openedByAgent).toBeUndefined();
    expect(store.getState().focusedWindowId).toBe(id);
  });

  it('keeps the already-focused no-op cheap when there is no stamp to clear', () => {
    // The early return still exists for the common case: re-focusing an unstamped
    // focused window must not churn the store (WindowFrame calls this on every
    // pointer-down, and a new object identity re-renders the layer).
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1' });
    const before = store.getState().windows;

    store.getState().focusWindow(id);

    expect(store.getState().windows).toBe(before);
  });

  it('does not disturb OTHER windows when clearing', () => {
    const store = makeStore();
    const other = store.getState().openWindow({ anchor: 'task-2', sessionId: 's2', title: 'Task 2', openedByAgent: true });
    const focused = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1' });

    store.getState().focusWindow(focused);

    expect(store.getState().windows[other].openedByAgent).toBe(true);
  });
});

describe('markAgentOpened', () => {
  it('stamps an existing window', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1' });
    store.getState().markAgentOpened(id);
    expect(store.getState().windows[id].openedByAgent).toBe(true);
  });

  it('is a no-op for an unknown id', () => {
    const store = makeStore();
    const before = store.getState().windows;
    store.getState().markAgentOpened('no-such-window');
    expect(store.getState().windows).toBe(before);
  });

  it('is idempotent', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1', openedByAgent: true });
    const before = store.getState().windows;
    store.getState().markAgentOpened(id);
    expect(store.getState().windows).toBe(before);
  });
});

describe('openedByAgent never reaches the persisted workspace', () => {
  // Transient by contract, the same as `skipEnterAnimation`. A stamp that
  // survived a restore would deny arrival focus on a window the USER is
  // reopening, with nothing left on screen to explain why.
  it('is not serialized', () => {
    const store = makeStore();
    store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1', openedByAgent: true });
    const serialized = store.getState().serializeWorkspace();
    expect(JSON.stringify(serialized)).not.toContain('openedByAgent');
  });

  it('is not restored', () => {
    const store = makeStore();
    store.getState().openWindow({ anchor: 'task-1', sessionId: 's1', title: 'Task 1', openedByAgent: true });
    const serialized = store.getState().serializeWorkspace();

    const restored = makeStore();
    restored.getState().applyWorkspace(
      serialized,
      (anchor: string) => `session-for-${anchor}`,
      () => true,
    );

    const rebuilt = Object.values(restored.getState().windows);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].openedByAgent).toBeUndefined();
  });
});
