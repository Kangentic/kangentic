/**
 * Unit tests for the toggleBrowserOpen and toggleMaximized reducers in
 * src/renderer/stores/session-store/task-changes-panel-slice.ts.
 *
 * The slice is a Zustand StateCreator - a plain function that takes (set, get).
 * We drive it by constructing a minimal in-memory store using a closure so no
 * browser, Electron, or ipcRenderer binding is required.
 */

import { describe, it, expect } from 'vitest';
import { createTaskChangesPanelSlice } from '../../src/renderer/stores/session-store/task-changes-panel-slice';
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
  it('starts empty (panel auto-fits when a task has no stored width)', () => {
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
