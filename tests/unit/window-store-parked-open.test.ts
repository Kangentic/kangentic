/**
 * A window born parked: how an agent's `kangentic_browser_open_pane` gets a host
 * for its pane without anything moving on the user's screen. Every field checked
 * here is one a plain `openWindow` changes, and each change is the reported bug:
 * the window took the top `zIndex` and `focusedWindowId` over the task the user
 * was in, and took over from an expanded window.
 */
import { describe, it, expect } from 'vitest';
import { createWindowManagerStore } from '../../src/renderer/window-manager/store/window-store';

function makeStore() {
  return createWindowManagerStore({ idPrefix: 'parked-open', kind: 'task-detail' }).store;
}

describe('openWindow with parked', () => {
  it('moves nothing: not the order, the focus, the stack or an expanded window', () => {
    const store = makeStore();
    const userWindow = store.getState().openWindow({ anchor: 'task-user', sessionId: 's1', title: 'User' });
    const other = store.getState().openWindow({ anchor: 'task-other', sessionId: 's2', title: 'Other' });
    store.getState().setExpandedWindow(userWindow);
    const before = store.getState();

    const id = store.getState().openWindow({ anchor: 'task-agent', sessionId: 's3', title: 'Agent', parked: true });

    const after = store.getState();
    expect(after.windows[id].parked).toBe(true);
    expect(after.order).toEqual(before.order);
    expect(after.focusedWindowId).toBe(before.focusedWindowId);
    expect(after.zCounter).toBe(before.zCounter);
    expect(after.expandedWindowId).toBe(userWindow);
    expect(after.windows[userWindow]).toBe(before.windows[userWindow]);
    expect(after.windows[other]).toBe(before.windows[other]);
  });

  it('is one store write, so no subscriber sees it unparked', () => {
    // The ownership report runs on every window change, and a window seen visible
    // for one write would take the detail from whichever surface holds it.
    const store = makeStore();
    const seen: (true | undefined)[] = [];
    store.subscribe((state) => {
      const opened = Object.values(state.windows).find((candidate) => candidate.anchor === 'task-agent');
      seen.push(opened?.parked);
    });

    store.getState().openWindow({ anchor: 'task-agent', sessionId: 's1', title: 'Agent', parked: true });

    expect(seen).toEqual([true]);
  });

  it('leaves a window already there exactly as it is', () => {
    const store = makeStore();
    const visible = store.getState().openWindow({ anchor: 'task-visible', sessionId: 's1', title: 'Visible' });
    const parked = store.getState().openWindow({ anchor: 'task-parked', sessionId: 's2', title: 'Parked' });
    store.getState().parkWindow(parked);
    store.getState().focusWindow(visible);
    const before = store.getState();

    expect(store.getState().openWindow({ anchor: 'task-parked', sessionId: 's2', title: 'Parked', parked: true })).toBe(parked);
    expect(store.getState().openWindow({ anchor: 'task-visible', sessionId: 's1', title: 'Visible', parked: true })).toBe(visible);

    expect(store.getState()).toBe(before);
  });

  it('can never hold focus while parked', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-agent', sessionId: 's1', title: 'Agent', parked: true });

    store.getState().focusWindow(id);

    expect(store.getState().focusedWindowId).toBeNull();
  });

  it('un-parks like any parked window: raised, focused, and done waiting for its guest', () => {
    const store = makeStore();
    const userWindow = store.getState().openWindow({ anchor: 'task-user', sessionId: 's1', title: 'User' });
    const id = store.getState().openWindow({
      anchor: 'task-agent',
      sessionId: 's2',
      title: 'Agent',
      parked: true,
      guestPendingUntil: 1234,
    });
    expect(store.getState().windows[id].guestPendingUntil).toBe(1234);

    store.getState().unparkWindow(id);

    const after = store.getState();
    expect(after.windows[id].parked).toBeUndefined();
    expect(after.windows[id].guestPendingUntil).toBeUndefined();
    expect(after.focusedWindowId).toBe(id);
    expect(after.order).toEqual([userWindow, id]);
  });

  it('never reaches the saved layout, the same as a window the user closed', () => {
    const store = makeStore();
    store.getState().openWindow({ anchor: 'task-agent', sessionId: 's1', title: 'Agent', parked: true, guestPendingUntil: 1234 });

    const saved = JSON.stringify(store.getState().serializeWorkspace());

    expect(saved).not.toContain('task-agent');
    expect(saved).not.toContain('guestPendingUntil');
  });
});
