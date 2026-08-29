/**
 * Retention of a backgrounded project's task-detail window.
 *
 * An Electron `<webview>` guest dies the moment its DOM node moves, so a Browser
 * pane can only outlive a project switch if its window is never unmounted or
 * re-parented. `WindowLayer` renders in stable insertion order and stacks purely
 * by `zIndex`, so "never moves" reduces to "stays in the `windows` map under the
 * same id". Every assertion here is ultimately about that id surviving.
 *
 * The sharp edge is `applyWorkspace`: `deserializeWorkspace` mints FRESH ids, so
 * restoring the owning project would otherwise either replace the retained
 * window (killing the guest) or sit alongside it (one task, two windows).
 */
import { describe, it, expect } from 'vitest';
import { createWindowManagerStore } from '../../src/renderer/window-manager/store/window-store';
import { deriveOwnedDetails } from '../../src/renderer/window-manager/bridge/useDetailOwnershipSync';
import { planWindowRetention } from '../../src/renderer/window-manager/bridge/retained-task-snapshots';
import { findWindowTreeViolations } from '../../src/renderer/window-manager/store/tree-invariants';
import { isWindowDormant } from '../../src/renderer/window-manager/store/types';
import type { ManagedWindow } from '../../src/renderer/window-manager/store/types';
import type { SerializedWorkspace } from '../../src/shared/types';

function makeStore() {
  return createWindowManagerStore({ idPrefix: 'test', kind: 'task-detail' }).store;
}

const resolveSessionId = (anchor: string) => `session-for-${anchor}`;
const isKnownAnchor = () => true;

/** Serialize the current layout, so a restore round-trips real persisted shape. */
function snapshot(store: ReturnType<typeof makeStore>): SerializedWorkspace {
  return store.getState().serializeWorkspace();
}

/** Another project's persisted layout, built by serializing a throwaway store so
 *  the fixture can never drift from the real persisted shape. */
function workspaceWith(anchors: string[]): SerializedWorkspace {
  const other = makeStore();
  for (const anchor of anchors) {
    other.getState().openWindow({ anchor, sessionId: `s-${anchor}`, title: anchor });
  }
  return snapshot(other);
}

/** Build a plain ManagedWindow for planWindowRetention, which is pure and needs
 *  no store. */
function makeManagedWindow(anchor: string, overrides: Partial<ManagedWindow> = {}): ManagedWindow {
  return {
    id: `window-${anchor}`,
    kind: 'task-detail',
    anchor,
    sessionId: null,
    geometry: { x: 0, y: 0, w: 0.5, h: 1 },
    state: 'floating',
    zIndex: 1,
    leafId: null,
    sessionStatus: 'closed',
    restoreGeometry: null,
    title: anchor,
    ...overrides,
  };
}

describe('retainWindows', () => {
  it('marks only the named anchors and leaves the windows in place', () => {
    const store = makeStore();
    const keptId = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    const otherId = store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });

    store.getState().retainWindows('proj-1', ['task-a']);

    expect(store.getState().windows[keptId].retainedProjectId).toBe('proj-1');
    expect(store.getState().windows[otherId].retainedProjectId).toBeUndefined();
    // Retention is a marking, never a move: both windows still exist.
    expect(Object.keys(store.getState().windows)).toHaveLength(2);
  });

  it('clears retention from windows no longer named', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().retainWindows('proj-1', ['task-a']);
    store.getState().retainWindows('proj-1', []);
    expect(store.getState().windows[id].retainedProjectId).toBeUndefined();
  });

  it('clears focus from a window it retains, so a stray Escape cannot reach its keydown listener', () => {
    const store = makeStore();
    const focusedId = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    expect(store.getState().focusedWindowId).toBe(focusedId);

    store.getState().retainWindows('proj-1', ['task-a']);

    // A retained window is hidden with opacity:0 + inert, but inert does not
    // stop the document-level keydown listener TaskDetailWindow registers
    // while isFocused, nor its enabled:isFocused keybindings. Leaving the
    // pointer here means the next Escape runs the retained window's guarded
    // close and destroys the <webview> guest retention exists to keep alive.
    // applyWorkspace cannot be relied on to reassign focus afterwards: it
    // early-returns when the destination project has no saved layout.
    expect(store.getState().focusedWindowId).toBeNull();
  });

  it('leaves focus untouched when the retained window was not the focused one', () => {
    const store = makeStore();
    store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    const focusedId = store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    expect(store.getState().focusedWindowId).toBe(focusedId);

    store.getState().retainWindows('proj-1', ['task-a']);

    // Only a retained window's OWN focus is a hazard. Clearing focus more
    // broadly would steal it from a window the user is actively looking at.
    expect(store.getState().focusedWindowId).toBe(focusedId);
  });
});

describe('retained windows and persistence', () => {
  it('excludes a retained window from the serialized layout', () => {
    const store = makeStore();
    store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    store.getState().retainWindows('proj-1', ['task-a']);

    // The saver reads the layout and the CURRENT project id together, so a
    // retained window left in here would be persisted into a different
    // project's blob and restore as a phantom window it cannot resolve.
    const workspace = snapshot(store);
    expect(workspace.windows.map((entry) => entry.taskId)).toEqual(['task-b']);
  });

  it('untiles a window when retaining it, so no leaf outlives its tree', () => {
    const store = makeStore();
    const first = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    const second = store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    store.getState().dockWindow(first, 'left');
    store.getState().dockWindow(second, 'right');
    expect(store.getState().windows[first].state).toBe('tiled');

    store.getState().retainWindows('proj-1', ['task-a']);

    const retained = store.getState().windows[first];
    expect(retained.retainedProjectId).toBe('proj-1');
    // applyWorkspace replaces the tile tree wholesale; a retained window still
    // claiming a leaf in the old tree breaks the tree <-> state <-> leafId
    // invariant the dev tripwire asserts after every mutation.
    expect(retained.state).not.toBe('tiled');
    expect(retained.leafId).toBeNull();
  });
});

describe('detail ownership', () => {
  const anchorToDetail = (anchor: string) => ({ projectId: 'p', taskId: anchor });

  it('excludes a retained window, so its task can be opened elsewhere', () => {
    const store = makeStore();
    store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    store.getState().retainWindows('proj-1', ['task-a']);

    const owned = deriveOwnedDetails(Object.values(store.getState().windows), anchorToDetail);

    // A retained window has no terminal, so it arbitrates nothing: reporting it
    // would block the Agent Monitor from opening that task while its project is
    // backgrounded, for no benefit.
    expect(owned.map((entry) => entry.taskId)).toEqual(['task-b']);
  });

  it('reports the task again once the window is adopted back', () => {
    const store = makeStore();
    store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().retainWindows('proj-1', ['task-a']);
    store.getState().applyWorkspace(workspaceWith(['task-a']), resolveSessionId, isKnownAnchor);

    const owned = deriveOwnedDetails(Object.values(store.getState().windows), anchorToDetail);
    expect(owned.map((entry) => entry.taskId)).toEqual(['task-a']);
  });
});

describe('applyWorkspace with retained windows', () => {
  it('leaves the plain path untouched when nothing is retained', () => {
    const store = makeStore();
    store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    const workspace = snapshot(store);
    store.getState().applyWorkspace(workspace, resolveSessionId, isKnownAnchor);

    const windows = Object.values(store.getState().windows);
    expect(windows).toHaveLength(1);
    expect(windows[0].anchor).toBe('task-a');
  });

  it('keeps a retained window mounted when another project restores', () => {
    const store = makeStore();
    const retainedId = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().retainWindows('proj-1', ['task-a']);

    // Project 2's persisted layout knows nothing about task-a.
    store.getState().applyWorkspace(workspaceWith(['task-z']), resolveSessionId, isKnownAnchor);

    // THE contract: same id, so the same DOM node, so the same live guest.
    expect(store.getState().windows[retainedId]).toBeDefined();
    expect(store.getState().windows[retainedId].retainedProjectId).toBe('proj-1');
    expect(Object.values(store.getState().windows).map((managedWindow) => managedWindow.anchor).sort()).toEqual(['task-a', 'task-z']);
  });

  it('ADOPTS the retained window when its own project restores, rather than duplicating it', () => {
    const store = makeStore();
    const retainedId = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().setGeometry(retainedId, { x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    const ownWorkspace = snapshot(store);
    store.getState().retainWindows('proj-1', ['task-a']);

    store.getState().applyWorkspace(ownWorkspace, resolveSessionId, isKnownAnchor);

    const windows = Object.values(store.getState().windows);
    // Exactly one window for the anchor, and it is the ORIGINAL id.
    expect(windows).toHaveLength(1);
    expect(windows[0].id).toBe(retainedId);
    expect(windows[0].anchor).toBe('task-a');
    // Retention ends on adoption, so content goes back to the live board lookup.
    expect(windows[0].retainedProjectId).toBeUndefined();
    // The persisted layout still applies.
    expect(windows[0].geometry).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    expect(store.getState().order).toEqual([retainedId]);
  });

  it('gives zCounter a value above every surviving window, not just the restored ones', () => {
    const store = makeStore();
    store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().retainWindows('proj-1', ['task-a']);

    store.getState().applyWorkspace(workspaceWith(['task-z']), resolveSessionId, isKnownAnchor);

    // Two windows survived; a zCounter of 1 would collide on the next focus.
    expect(store.getState().zCounter).toBe(2);
  });

  it('orders a still-retained window behind the active project\'s windows', () => {
    const store = makeStore();
    const retainedId = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().retainWindows('proj-1', ['task-a']);

    const otherProjectWorkspace: SerializedWorkspace = {
      windows: [{ anchor: 'task-z', geometry: { x: 0, y: 0, width: 0.5, height: 0.5 }, state: 'floating', restoreGeometry: null, kind: 'task-detail', title: 'Z' }],
      tileTree: null,
      tileTreeRect: { x: 0, y: 0, width: 1, height: 1 },
      focusedAnchor: null,
    };
    store.getState().applyWorkspace(otherProjectWorkspace, resolveSessionId, isKnownAnchor);

    const order = store.getState().order;
    expect(order[order.length - 1]).toBe(retainedId);
  });
});

describe('planWindowRetention', () => {
  it('retains a browser-open window that is not yet retained', () => {
    const windows = [makeManagedWindow('task-a')];

    const { retainAnchors, snapshotTaskIds } = planWindowRetention(windows, new Set(['task-a']));

    expect(retainAnchors).toEqual(['task-a']);
    expect(snapshotTaskIds).toEqual(new Set(['task-a']));
  });

  it('excludes an already-retained window from retainAnchors, so a later switch cannot re-stamp it with the new project id', () => {
    // browserOpenTaskIds is neither project-keyed nor ever cleared, so the SAME
    // anchor that earned the earlier retention is still in the set here. The
    // bug re-stamped the window with THIS switch's project id, pointing its
    // pane's URL lookup and pane-registry scope at the wrong project.
    const alreadyRetained = makeManagedWindow('task-a', { retainedProjectId: 'proj-earlier' });

    const { retainAnchors, snapshotTaskIds } = planWindowRetention([alreadyRetained], new Set(['task-a']));

    expect(retainAnchors).toEqual([]);
    // The window is still covered, just via the snapshot path, not a re-retain.
    expect(snapshotTaskIds).toEqual(new Set(['task-a']));
  });

  it('keeps the snapshot of an already-retained window even after its anchor drops out of browserOpenTaskIds', () => {
    // The Browser pane could since have been closed, so the anchor is no
    // longer in the (unscoped) browserOpenTaskIds set. Losing the snapshot
    // here makes getRetainedTask return null, and WindowContent then renders
    // the "no longer available" placeholder INSTEAD of the task-detail
    // subtree, unmounting the very <webview> guest retention exists to keep
    // alive - worse than the bug this function fixes, so it is pinned here
    // even though a naive fix (filtering both sets the same way) looks correct.
    const alreadyRetained = makeManagedWindow('task-a', { retainedProjectId: 'proj-earlier' });

    const { retainAnchors, snapshotTaskIds } = planWindowRetention([alreadyRetained], new Set());

    expect(retainAnchors).toEqual([]);
    expect(snapshotTaskIds).toEqual(new Set(['task-a']));
  });

  it('ignores a non-task-detail window even when its anchor is browser-open', () => {
    const terminalWindow = makeManagedWindow('slot-1', { kind: 'command-terminal' });

    const { retainAnchors, snapshotTaskIds } = planWindowRetention([terminalWindow], new Set(['slot-1']));

    expect(retainAnchors).toEqual([]);
    expect(snapshotTaskIds).toEqual(new Set());
  });

  it('ignores a window that is neither already retained nor browser-open', () => {
    const windows = [makeManagedWindow('task-a')];

    const { retainAnchors, snapshotTaskIds } = planWindowRetention(windows, new Set(['task-other']));

    expect(retainAnchors).toEqual([]);
    expect(snapshotTaskIds).toEqual(new Set());
  });

  it('retains a PARKED browser-open window like any other, so a project switch keeps its guest', () => {
    const parked = makeManagedWindow('task-a', { parked: true });

    const { retainAnchors, snapshotTaskIds } = planWindowRetention([parked], new Set(['task-a']));

    expect(retainAnchors).toEqual(['task-a']);
    expect(snapshotTaskIds).toEqual(new Set(['task-a']));
  });
});

/**
 * Parking: the user CLOSED the window, but its Browser pane's guest must survive
 * for the task's live agent. Same mechanism as retention (the id, and so the
 * DOM node, stays in the map), same hazards, plus the ones a close brings: the
 * window must leave stacking, focus, tiling, ownership, claims and the
 * persisted blob, and an un-park must bring it back where it was.
 */
describe('parkWindow / unparkWindow', () => {
  it('keeps the window in the map, out of order, and gives up its focus', () => {
    const store = makeStore();
    const otherId = store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    expect(store.getState().focusedWindowId).toBe(id);

    store.getState().parkWindow(id);

    const parked = store.getState().windows[id];
    expect(parked).toBeDefined();
    expect(parked.parked).toBe(true);
    expect(isWindowDormant(parked)).toBe(true);
    expect(store.getState().order).toEqual([otherId]);
    // Focus falls to the last visible window, exactly as a close does.
    expect(store.getState().focusedWindowId).toBe(otherId);
  });

  it('leaves focus untouched when the parked window was not the focused one', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    const focusedId = store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });

    store.getState().parkWindow(id);

    expect(store.getState().focusedWindowId).toBe(focusedId);
  });

  it('untiles a window when parking it, and the survivor reflows', () => {
    const store = makeStore();
    const first = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    const second = store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    store.getState().dockWindow(first, 'left');
    store.getState().dockWindow(second, 'right');
    expect(store.getState().windows[first].state).toBe('tiled');

    store.getState().parkWindow(first);

    const parked = store.getState().windows[first];
    expect(parked.state).not.toBe('tiled');
    expect(parked.leafId).toBeNull();
    expect(findWindowTreeViolations(store.getState().windows, store.getState().tileTree)).toEqual([]);
  });

  it('is idempotent', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().parkWindow(id);
    const once = store.getState();
    store.getState().parkWindow(id);
    expect(store.getState()).toBe(once);
  });

  it('refuses focus while parked, so no isFocused-gated shortcut can reach it', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().parkWindow(id);

    store.getState().focusWindow(id);

    expect(store.getState().focusedWindowId).toBeNull();
    expect(store.getState().order).toEqual([]);
  });

  it('un-parks back into order, focused and raised, with its geometry untouched', () => {
    const store = makeStore();
    const otherId = store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().setGeometry(id, { x: 0.2, y: 0.3, w: 0.4, h: 0.5 });
    store.getState().maximizeWindow(id);
    const before = store.getState().windows[id];
    store.getState().parkWindow(id);
    store.getState().focusWindow(otherId);

    store.getState().unparkWindow(id);

    const revived = store.getState().windows[id];
    expect(revived.parked).toBeUndefined();
    expect(revived.geometry).toEqual(before.geometry);
    expect(revived.restoreGeometry).toEqual(before.restoreGeometry);
    expect(revived.state).toBe('maximized');
    expect(store.getState().order).toEqual([otherId, id]);
    expect(store.getState().focusedWindowId).toBe(id);
    expect(revived.zIndex).toBe(store.getState().zCounter);
  });

  it('un-parking clears the agent stamp like any raise, so an agent path must re-stamp after it', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A', openedByAgent: true });
    store.getState().parkWindow(id);

    store.getState().unparkWindow(id);
    expect(store.getState().windows[id].openedByAgent).toBeUndefined();

    store.getState().markAgentOpened(id);
    expect(store.getState().windows[id].openedByAgent).toBe(true);
  });

  it('is a no-op for a window that is not parked', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    const before = store.getState();
    store.getState().unparkWindow(id);
    expect(store.getState()).toBe(before);
  });

  it('closeWindow drops a parked window for real', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().parkWindow(id);
    store.getState().closeWindow(id);
    expect(store.getState().windows[id]).toBeUndefined();
  });
});

describe('parked windows stay out of shared state', () => {
  const anchorToDetail = (anchor: string) => ({ projectId: 'p', taskId: anchor });

  it('is excluded from the serialized layout', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    store.getState().parkWindow(id);

    // The user closed it; persisting it would restore it VISIBLE next time.
    expect(snapshot(store).windows.map((entry) => entry.taskId)).toEqual(['task-b']);
  });

  it('is excluded from detail ownership while parked, and reported again once un-parked', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    store.getState().parkWindow(id);

    // A parked window has no terminal and the user closed it, so the task must
    // be openable in the Agent Monitor or a pop-out.
    expect(deriveOwnedDetails(Object.values(store.getState().windows), anchorToDetail).map((entry) => entry.taskId)).toEqual(['task-b']);

    store.getState().unparkWindow(id);
    expect(deriveOwnedDetails(Object.values(store.getState().windows), anchorToDetail).map((entry) => entry.taskId).sort()).toEqual(['task-a', 'task-b']);
  });
});

describe('parked windows across a project switch', () => {
  it('retainWindows stamps a parked window and keeps it parked', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().parkWindow(id);

    store.getState().retainWindows('proj-1', ['task-a']);

    expect(store.getState().windows[id]).toMatchObject({ parked: true, retainedProjectId: 'proj-1' });
    expect(store.getState().order).toEqual([]);
  });

  it('keeps a parked (non-retained) window mounted on the plain restore path', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().parkWindow(id);

    store.getState().applyWorkspace(workspaceWith(['task-z']), resolveSessionId, isKnownAnchor);

    // THE contract: same id, so the same DOM node, so the same live guest.
    expect(store.getState().windows[id]).toMatchObject({ parked: true });
    expect(store.getState().order).not.toContain(id);
    expect(Object.values(store.getState().windows).map((managedWindow) => managedWindow.anchor).sort()).toEqual(['task-a', 'task-z']);
  });

  it('does NOT adopt a parked window when its own project restores: the restored copy is dropped and it stays parked', () => {
    const store = makeStore();
    const id = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    const ownWorkspace = snapshot(store); // names task-a and task-b
    store.getState().parkWindow(id);
    store.getState().retainWindows('proj-1', ['task-a', 'task-b']);

    store.getState().applyWorkspace(ownWorkspace, resolveSessionId, isKnownAnchor);

    const windows = Object.values(store.getState().windows);
    // Exactly one window for task-a: the parked ORIGINAL, still parked, still
    // retained (adoption is what clears retention, and it was skipped), out of
    // order; task-b was adopted normally.
    expect(windows.filter((managedWindow) => managedWindow.anchor === 'task-a')).toHaveLength(1);
    expect(store.getState().windows[id]).toMatchObject({ parked: true, retainedProjectId: 'proj-1' });
    expect(store.getState().order).not.toContain(id);
    expect(windows.find((managedWindow) => managedWindow.anchor === 'task-b')?.retainedProjectId).toBeUndefined();
    expect(findWindowTreeViolations(store.getState().windows, store.getState().tileTree)).toEqual([]);
  });

  it('drops a restored TILED copy of a parked anchor without breaking the tree', () => {
    const store = makeStore();
    const first = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    const second = store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    store.getState().dockWindow(first, 'left');
    store.getState().dockWindow(second, 'right');
    const tiledWorkspace = snapshot(store);
    store.getState().parkWindow(first);
    store.getState().retainWindows('proj-1', ['task-a', 'task-b']);

    store.getState().applyWorkspace(tiledWorkspace, resolveSessionId, isKnownAnchor);

    expect(store.getState().windows[first]).toMatchObject({ parked: true });
    expect(findWindowTreeViolations(store.getState().windows, store.getState().tileTree)).toEqual([]);
    expect(store.getState().order).not.toContain(first);
  });

  it('releaseRetainedWindows clears retention on a parked window and leaves it parked, other projects untouched', () => {
    const store = makeStore();
    const parkedId = store.getState().openWindow({ anchor: 'task-a', sessionId: 's-a', title: 'A' });
    const otherId = store.getState().openWindow({ anchor: 'task-b', sessionId: 's-b', title: 'B' });
    store.getState().parkWindow(parkedId);
    store.getState().retainWindows('proj-1', ['task-a']);
    store.getState().retainWindows('proj-2', ['task-b']);

    store.getState().releaseRetainedWindows('proj-1');

    expect(store.getState().windows[parkedId].retainedProjectId).toBeUndefined();
    expect(store.getState().windows[parkedId].parked).toBe(true);
    expect(store.getState().windows[otherId].retainedProjectId).toBe('proj-2');
  });
});
