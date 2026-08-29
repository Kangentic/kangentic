/**
 * Unit tests for the toggleBrowserOpen and toggleMaximized reducers in
 * src/renderer/stores/session-store/task-changes-panel-slice.ts.
 *
 * The slice is a Zustand StateCreator - a plain function that takes (set, get).
 * We drive it by constructing a minimal in-memory store using a closure so no
 * browser, Electron, or ipcRenderer binding is required.
 */

import { describe, it, expect, vi } from 'vitest';
// The slice imports `useProjectStore` (to stamp the project id on its debounced
// detail-view-state saves). project-store imports session-store, which eagerly
// creates its store from the slices - so importing the slice DIRECTLY as the
// module-graph entry (as this isolated unit test does) forms a TDZ cycle
// (session-store's create() runs before this slice's export is defined). The app
// is unaffected (it enters via session-store, which defines all slices before
// create()); mocking project-store here keeps the slice a leaf for the test.
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: null }) },
}));
import { createTaskChangesPanelSlice, commandTerminalChangesEntityId } from '../../src/renderer/stores/session-store/task-changes-panel-slice';
import type { TaskChangesPanelSlice } from '../../src/renderer/stores/session-store/task-changes-panel-slice';

// ---------------------------------------------------------------------------
// Minimal store harness
// ---------------------------------------------------------------------------

/**
 * Instantiates the slice with a real set/get closure so all state mutations
 * are properly tracked. Returns the slice's initial state merged with its
 * action methods, and a `getState()` accessor for reading current values.
 */
function createTestStore(): { actions: TaskChangesPanelSlice; getState: () => TaskChangesPanelSlice } {
  let state: TaskChangesPanelSlice;

  const set = (partial: Partial<TaskChangesPanelSlice> | ((s: TaskChangesPanelSlice) => Partial<TaskChangesPanelSlice>)) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next };
  };

  const get = () => state;

  // StateCreator signature: (set, get, _api) - api not used by this slice
  state = createTaskChangesPanelSlice(set as never, get as never, {} as never);

  return {
    actions: state,
    getState: get,
  };
}

// ---------------------------------------------------------------------------
// toggleBrowserOpen
// ---------------------------------------------------------------------------

describe('toggleBrowserOpen', () => {
  it('adds taskId to browserOpenTasks when not present', () => {
    const { actions, getState } = createTestStore();
    actions.toggleBrowserOpen('task-1');
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);
  });

  it('removes taskId from browserOpenTasks when already present', () => {
    const { actions, getState } = createTestStore();
    actions.toggleBrowserOpen('task-1');
    actions.toggleBrowserOpen('task-1');
    expect(getState().browserOpenTasks.has('task-1')).toBe(false);
  });

  it('toggles independently per taskId', () => {
    const { actions, getState } = createTestStore();
    actions.toggleBrowserOpen('task-1');
    actions.toggleBrowserOpen('task-2');
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);
    expect(getState().browserOpenTasks.has('task-2')).toBe(true);

    actions.toggleBrowserOpen('task-1');
    expect(getState().browserOpenTasks.has('task-1')).toBe(false);
    expect(getState().browserOpenTasks.has('task-2')).toBe(true);
  });

  it('setBrowserOpen is idempotent: a redundant call changes no state', () => {
    // The MCP open/close tools drive this directly, where a toggle would be
    // wrong (an agent asking to OPEN must never close an already-open pane).
    // The early return is what makes a repeated push a genuine no-op rather
    // than a fresh Set plus a persistence write on every call.
    const { actions, getState } = createTestStore();
    actions.setBrowserOpen('task-1', true);
    const afterFirstOpen = getState().browserOpenTasks;

    actions.setBrowserOpen('task-1', true);
    expect(getState().browserOpenTasks).toBe(afterFirstOpen); // same reference: no churn
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);

    actions.setBrowserOpen('task-1', false);
    expect(getState().browserOpenTasks.has('task-1')).toBe(false);
    const afterClose = getState().browserOpenTasks;
    actions.setBrowserOpen('task-1', false);
    expect(getState().browserOpenTasks).toBe(afterClose);
  });

  // Hiding a pane from the UI HOLDS it (kept mounted, hidden, for the agent
  // that may be driving it); only an agent's close_pane or a hydration discards
  // it. The distinction is the `hold` option, which only the UI toggle passes.
  describe('browser hold', () => {
    it('starts with no held panes', () => {
      const { getState } = createTestStore();
      expect(getState().browserHeldTasks.size).toBe(0);
    });

    it('the UI toggle holds the pane it hides, and showing it again ends the hold', () => {
      const { actions, getState } = createTestStore();
      actions.toggleBrowserOpen('task-1');
      expect(getState().browserHeldTasks.has('task-1')).toBe(false);

      actions.toggleBrowserOpen('task-1');
      expect(getState().browserOpenTasks.has('task-1')).toBe(false);
      expect(getState().browserHeldTasks.has('task-1')).toBe(true);

      actions.toggleBrowserOpen('task-1');
      expect(getState().browserOpenTasks.has('task-1')).toBe(true);
      expect(getState().browserHeldTasks.has('task-1')).toBe(false);
    });

    it("an explicit close without `hold` DISCARDS: the agent's close_pane path", () => {
      const { actions, getState } = createTestStore();
      actions.toggleBrowserOpen('task-1');
      actions.setBrowserOpen('task-1', false);
      expect(getState().browserOpenTasks.has('task-1')).toBe(false);
      expect(getState().browserHeldTasks.has('task-1')).toBe(false);
    });

    it('an explicit close without `hold` also ends an existing hold', () => {
      // The pane was hidden by the user (held), then the agent called
      // close_pane: the discard must win, or the guest the agent asked to drop
      // stays mounted.
      const { actions, getState } = createTestStore();
      actions.toggleBrowserOpen('task-1');
      actions.toggleBrowserOpen('task-1');
      expect(getState().browserHeldTasks.has('task-1')).toBe(true);

      const heldBefore = getState().browserHeldTasks;
      actions.setBrowserOpen('task-1', false);
      expect(getState().browserHeldTasks.has('task-1')).toBe(false);
      expect(getState().browserHeldTasks).not.toBe(heldBefore); // a real state change, not the idempotent skip
    });

    it("an agent's open_pane on a held pane shows it and ends the hold", () => {
      const { actions, getState } = createTestStore();
      actions.toggleBrowserOpen('task-1');
      actions.toggleBrowserOpen('task-1');
      actions.setBrowserOpen('task-1', true);
      expect(getState().browserOpenTasks.has('task-1')).toBe(true);
      expect(getState().browserHeldTasks.has('task-1')).toBe(false);
    });

    it('each set is replaced only when its own membership changes', () => {
      // A subscriber keyed on one set's identity (the park reaper, a `has()`
      // selector) must not wake for the other. Hiding an already-hidden pane
      // with `hold` holds it (the slice cannot know whether a guest exists;
      // only the toggle passes `hold`, against a showing pane) but leaves the
      // open set untouched by reference.
      const { actions, getState } = createTestStore();
      const openBefore = getState().browserOpenTasks;
      actions.setBrowserOpen('task-1', false, { hold: true });
      expect(getState().browserHeldTasks.has('task-1')).toBe(true);
      expect(getState().browserOpenTasks).toBe(openBefore);

      // And a redundant hide-with-hold on an already-held pane changes nothing.
      const heldBefore = getState().browserHeldTasks;
      actions.setBrowserOpen('task-1', false, { hold: true });
      expect(getState().browserHeldTasks).toBe(heldBefore);
      expect(getState().browserOpenTasks).toBe(openBefore);

      // Showing it replaces both: the open set gains the task, the held set loses it.
      actions.setBrowserOpen('task-1', true);
      expect(getState().browserOpenTasks).not.toBe(openBefore);
      expect(getState().browserHeldTasks).not.toBe(heldBefore);
      expect(getState().browserHeldTasks.size).toBe(0);
    });

    it('releaseBrowserHold ends only the named hold and leaves the open flag alone', () => {
      const { actions, getState } = createTestStore();
      actions.toggleBrowserOpen('task-1');
      actions.toggleBrowserOpen('task-1');
      actions.toggleBrowserOpen('task-2');
      actions.toggleBrowserOpen('task-2');
      expect(getState().browserHeldTasks).toEqual(new Set(['task-1', 'task-2']));

      actions.releaseBrowserHold('task-1');
      expect(getState().browserHeldTasks).toEqual(new Set(['task-2']));
      expect(getState().browserOpenTasks.has('task-1')).toBe(false);

      const afterRelease = getState().browserHeldTasks;
      actions.releaseBrowserHold('task-1');
      expect(getState().browserHeldTasks).toBe(afterRelease); // idempotent
    });

    it('holds are keyed per task', () => {
      const { actions, getState } = createTestStore();
      actions.toggleBrowserOpen('task-1');
      actions.toggleBrowserOpen('task-2');
      actions.toggleBrowserOpen('task-1');
      expect(getState().browserHeldTasks.has('task-1')).toBe(true);
      expect(getState().browserHeldTasks.has('task-2')).toBe(false);
      expect(getState().browserOpenTasks.has('task-2')).toBe(true);
    });
  });

  // The renderer's "a browser guest is alive for this task" fact, published by
  // the pane on register / unregister. The pill dot, the card globe, and the
  // kebab's Close all read it, and Close needs the id to retire the handle.
  describe('browser guest map', () => {
    it('starts empty and records a guest per task', () => {
      const { actions, getState } = createTestStore();
      expect(getState().browserGuestTasks.size).toBe(0);
      actions.setBrowserGuest('task-1', 41);
      actions.setBrowserGuest('task-2', 42);
      expect(getState().browserGuestTasks.get('task-1')).toBe(41);
      expect(getState().browserGuestTasks.get('task-2')).toBe(42);
    });

    it('a repeated register of the same guest changes nothing', () => {
      const { actions, getState } = createTestStore();
      actions.setBrowserGuest('task-1', 41);
      const before = getState().browserGuestTasks;
      actions.setBrowserGuest('task-1', 41);
      expect(getState().browserGuestTasks).toBe(before);
    });

    it('clears only when the entry still names THIS guest, so a stale unmount never erases a newer one', () => {
      // An in-app pane unmounting after a pop-out registered a newer guest for
      // the same task must not drop the newer registration.
      const { actions, getState } = createTestStore();
      actions.setBrowserGuest('task-1', 41);
      actions.setBrowserGuest('task-1', 52);
      actions.clearBrowserGuest('task-1', 41);
      expect(getState().browserGuestTasks.get('task-1')).toBe(52);
      actions.clearBrowserGuest('task-1', 52);
      expect(getState().browserGuestTasks.has('task-1')).toBe(false);
      const after = getState().browserGuestTasks;
      actions.clearBrowserGuest('task-1', 52);
      expect(getState().browserGuestTasks).toBe(after); // idempotent
    });
  });

  it('refreshBrowserUrl bumps only its own task, from an absent start', () => {
    const { actions, getState } = createTestStore();
    expect(getState().browserUrlRefreshTokens['task-1']).toBeUndefined();
    actions.refreshBrowserUrl('task-1');
    actions.refreshBrowserUrl('task-1');
    expect(getState().browserUrlRefreshTokens['task-1']).toBe(2);
    expect(getState().browserUrlRefreshTokens['task-2']).toBeUndefined();
  });

  it('does not mutate changesOpenTasks when toggling browser', () => {
    const { actions, getState } = createTestStore();
    // Pre-populate changesOpenTasks via toggleChangesOpen
    actions.toggleChangesOpen('task-1');
    expect(getState().changesOpenTasks.has('task-1')).toBe(true);

    actions.toggleBrowserOpen('task-1');
    // changesOpenTasks must be unaffected
    expect(getState().changesOpenTasks.has('task-1')).toBe(true);
  });

  it('does not mutate browserOpenTasks when toggling changes', () => {
    const { actions, getState } = createTestStore();
    actions.toggleBrowserOpen('task-1');
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);

    actions.toggleChangesOpen('task-1');
    // browserOpenTasks must be unaffected
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);
  });

  it('starts with an empty browserOpenTasks set', () => {
    const { getState } = createTestStore();
    expect(getState().browserOpenTasks.size).toBe(0);
  });

  it('toggles changesOpenTasks independently per Command Terminal window slot id', () => {
    // Guards against the bug where every Command Terminal window shared one
    // 'command-terminal' entity id: toggling one window's Changes pill opened
    // every window's panel. Each window now derives its own id via
    // commandTerminalChangesEntityId(slot), so they must toggle independently,
    // like any other pair of entity ids.
    const { actions, getState } = createTestStore();
    const slotOneEntityId = commandTerminalChangesEntityId('slot-1');
    const slotTwoEntityId = commandTerminalChangesEntityId('slot-2');

    actions.toggleChangesOpen(slotOneEntityId);
    expect(getState().changesOpenTasks.has(slotOneEntityId)).toBe(true);
    expect(getState().changesOpenTasks.has(slotTwoEntityId)).toBe(false);

    actions.toggleChangesOpen(slotTwoEntityId);
    expect(getState().changesOpenTasks.has(slotOneEntityId)).toBe(true);
    expect(getState().changesOpenTasks.has(slotTwoEntityId)).toBe(true);

    actions.toggleChangesOpen(slotOneEntityId);
    expect(getState().changesOpenTasks.has(slotOneEntityId)).toBe(false);
    expect(getState().changesOpenTasks.has(slotTwoEntityId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setChangesScope
// ---------------------------------------------------------------------------

describe('setChangesScope', () => {
  it('starts with an empty changesScope map (panel falls back to the config default)', () => {
    const { getState } = createTestStore();
    expect(getState().changesScope).toEqual({});
  });

  it('records the live scope per task id', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesScope('task-1', 'working');
    expect(getState().changesScope['task-1']).toBe('working');
  });

  it('overwrites the scope on a subsequent change', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesScope('task-1', 'working');
    actions.setChangesScope('task-1', 'staged');
    expect(getState().changesScope['task-1']).toBe('staged');
  });

  it('keys scope independently per task id', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesScope('task-1', 'working');
    actions.setChangesScope('task-2', 'branch');
    expect(getState().changesScope['task-1']).toBe('working');
    expect(getState().changesScope['task-2']).toBe('branch');
  });
});

// ---------------------------------------------------------------------------
// setChangesFileTreeWidth
// ---------------------------------------------------------------------------

describe('setChangesFileTreeWidth', () => {
  it('starts empty (panel uses the default width when a task has no stored width)', () => {
    const { getState } = createTestStore();
    expect(getState().changesFileTreeWidth).toEqual({});
  });

  it('records and updates a per-task width', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesFileTreeWidth('task-1', 280);
    expect(getState().changesFileTreeWidth['task-1']).toBe(280);
    actions.setChangesFileTreeWidth('task-1', 320);
    expect(getState().changesFileTreeWidth['task-1']).toBe(320);
  });

  it('keys width independently per task id', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesFileTreeWidth('task-1', 260);
    actions.setChangesFileTreeWidth('task-2', 360);
    expect(getState().changesFileTreeWidth['task-1']).toBe(260);
    expect(getState().changesFileTreeWidth['task-2']).toBe(360);
  });
});

// ---------------------------------------------------------------------------
// toggleChangesFileViewed
// ---------------------------------------------------------------------------

describe('toggleChangesFileViewed', () => {
  it('starts empty', () => {
    const { getState } = createTestStore();
    expect(getState().changesViewedFiles).toEqual({});
  });

  it('marks a file viewed, then un-viewed, on successive toggles', () => {
    const { actions, getState } = createTestStore();
    actions.toggleChangesFileViewed('task-1', 'src/a.ts');
    expect(getState().changesViewedFiles['task-1'].has('src/a.ts')).toBe(true);
    actions.toggleChangesFileViewed('task-1', 'src/a.ts');
    expect(getState().changesViewedFiles['task-1'].has('src/a.ts')).toBe(false);
  });

  it('tracks multiple files and keys them independently per task id', () => {
    const { actions, getState } = createTestStore();
    actions.toggleChangesFileViewed('task-1', 'src/a.ts');
    actions.toggleChangesFileViewed('task-1', 'src/b.ts');
    actions.toggleChangesFileViewed('task-2', 'src/a.ts');
    expect(getState().changesViewedFiles['task-1'].size).toBe(2);
    expect(getState().changesViewedFiles['task-2'].has('src/a.ts')).toBe(true);
    expect(getState().changesViewedFiles['task-2'].has('src/b.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// markChangesFileViewed (idempotent add, used by cross-file roll-forward)
// ---------------------------------------------------------------------------

describe('markChangesFileViewed', () => {
  it('adds a file as viewed', () => {
    const { actions, getState } = createTestStore();
    actions.markChangesFileViewed('task-1', 'src/a.ts');
    expect(getState().changesViewedFiles['task-1'].has('src/a.ts')).toBe(true);
  });

  it('is idempotent: marking an already-viewed file does not un-view it', () => {
    const { actions, getState } = createTestStore();
    actions.markChangesFileViewed('task-1', 'src/a.ts');
    actions.markChangesFileViewed('task-1', 'src/a.ts');
    expect(getState().changesViewedFiles['task-1'].has('src/a.ts')).toBe(true);
    expect(getState().changesViewedFiles['task-1'].size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setChangesSelectedCommit
// ---------------------------------------------------------------------------

describe('setChangesSelectedCommit', () => {
  it('starts empty (panel falls back to Uncommitted changes)', () => {
    const { getState } = createTestStore();
    expect(getState().changesSelectedCommit).toEqual({});
  });

  it('records the selected commit OID per task id', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesSelectedCommit('task-1', 'commit-abc');
    expect(getState().changesSelectedCommit['task-1']).toBe('commit-abc');
  });

  it('overwrites the selection on a subsequent change', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesSelectedCommit('task-1', 'commit-abc');
    actions.setChangesSelectedCommit('task-1', 'commit-def');
    expect(getState().changesSelectedCommit['task-1']).toBe('commit-def');
  });

  it('setting null returns to Uncommitted changes', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesSelectedCommit('task-1', 'commit-abc');
    actions.setChangesSelectedCommit('task-1', null);
    expect(getState().changesSelectedCommit['task-1']).toBeNull();
  });

  it('keys selection independently per task id', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesSelectedCommit('task-1', 'commit-abc');
    actions.setChangesSelectedCommit('task-2', 'commit-xyz');
    expect(getState().changesSelectedCommit['task-1']).toBe('commit-abc');
    expect(getState().changesSelectedCommit['task-2']).toBe('commit-xyz');
  });
});

// ---------------------------------------------------------------------------
// setChangesHistoryHeight
// ---------------------------------------------------------------------------

describe('setChangesHistoryHeight', () => {
  it('starts empty (panel uses the default history-region height)', () => {
    const { getState } = createTestStore();
    expect(getState().changesHistoryHeight).toEqual({});
  });

  it('records and updates a per-task height', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesHistoryHeight('task-1', 240);
    expect(getState().changesHistoryHeight['task-1']).toBe(240);
    actions.setChangesHistoryHeight('task-1', 300);
    expect(getState().changesHistoryHeight['task-1']).toBe(300);
  });

  it('keys height independently per task id', () => {
    const { actions, getState } = createTestStore();
    actions.setChangesHistoryHeight('task-1', 200);
    actions.setChangesHistoryHeight('task-2', 260);
    expect(getState().changesHistoryHeight['task-1']).toBe(200);
    expect(getState().changesHistoryHeight['task-2']).toBe(260);
  });
});

// ---------------------------------------------------------------------------
// toggleMaximized
// ---------------------------------------------------------------------------

describe('toggleMaximized', () => {
  it('adds taskId to maximizedTasks when not present', () => {
    const { actions, getState } = createTestStore();
    actions.toggleMaximized('task-1');
    expect(getState().maximizedTasks.has('task-1')).toBe(true);
  });

  it('removes taskId from maximizedTasks when already present', () => {
    const { actions, getState } = createTestStore();
    actions.toggleMaximized('task-1');
    actions.toggleMaximized('task-1');
    expect(getState().maximizedTasks.has('task-1')).toBe(false);
  });

  it('toggles independently per taskId', () => {
    const { actions, getState } = createTestStore();
    actions.toggleMaximized('task-1');
    actions.toggleMaximized('task-2');
    expect(getState().maximizedTasks.has('task-1')).toBe(true);
    expect(getState().maximizedTasks.has('task-2')).toBe(true);

    actions.toggleMaximized('task-1');
    expect(getState().maximizedTasks.has('task-1')).toBe(false);
    expect(getState().maximizedTasks.has('task-2')).toBe(true);
  });

  it('starts with an empty maximizedTasks set', () => {
    const { getState } = createTestStore();
    expect(getState().maximizedTasks.size).toBe(0);
  });

  it('does not mutate browserOpenTasks when toggling maximized', () => {
    const { actions, getState } = createTestStore();
    actions.toggleBrowserOpen('task-1');
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);

    actions.toggleMaximized('task-1');
    // browserOpenTasks must be unaffected
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);
  });

  it('does not mutate changesOpenTasks when toggling maximized', () => {
    const { actions, getState } = createTestStore();
    actions.toggleChangesOpen('task-1');
    expect(getState().changesOpenTasks.has('task-1')).toBe(true);

    actions.toggleMaximized('task-1');
    // changesOpenTasks must be unaffected
    expect(getState().changesOpenTasks.has('task-1')).toBe(true);
  });

  it('allows the command-terminal entity id to be keyed independently from a task id', () => {
    const { actions, getState } = createTestStore();
    actions.toggleMaximized('task-1');
    actions.toggleMaximized('command-terminal');
    expect(getState().maximizedTasks.has('task-1')).toBe(true);
    expect(getState().maximizedTasks.has('command-terminal')).toBe(true);

    actions.toggleMaximized('task-1');
    expect(getState().maximizedTasks.has('task-1')).toBe(false);
    expect(getState().maximizedTasks.has('command-terminal')).toBe(true);
  });
});
