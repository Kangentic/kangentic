import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  serializeWorkspace,
  deserializeWorkspace,
  WORKSPACE_SCHEMA_VERSION,
  type RestoreContext,
} from '../../src/renderer/window-manager/persistence/workspace';
import { createWorkspaceSaver } from '../../src/renderer/window-manager/persistence/workspace-saver';
import type { SerializedWorkspace } from '../../src/shared/types';
import type { ManagedWindow, TileNode, FractionalRect, WindowState } from '../../src/renderer/window-manager/store/types';

function makeWindow(
  id: string,
  taskId: string,
  state: WindowState,
  geometry: FractionalRect,
  leafId: string | null = null,
): ManagedWindow {
  return {
    id,
    kind: 'task-detail',
    anchor: taskId,
    sessionId: `sess-${taskId}`,
    geometry,
    state,
    zIndex: 1,
    leafId,
    sessionStatus: 'live',
    restoreGeometry: null,
    title: `Task ${taskId}`,
  };
}

function makeContext(knownTasks: string[]): RestoreContext {
  let windowCounter = 0;
  let tileCounter = 0;
  return {
    kind: 'task-detail',
    resolveSessionId: (anchor) => (knownTasks.includes(anchor) ? `live-${anchor}` : null),
    isKnownAnchor: (anchor) => knownTasks.includes(anchor),
    makeWindowId: () => `w${(windowCounter += 1)}`,
    makeTileId: (kind) => `${kind}-${(tileCounter += 1)}`,
  };
}

function leafWindowIds(node: TileNode): string[] {
  return node.kind === 'leaf' ? [node.windowId] : node.children.flatMap(leafWindowIds);
}

const HALF_LEFT: FractionalRect = { x: 0, y: 0, w: 0.5, h: 1 };
const HALF_RIGHT: FractionalRect = { x: 0.5, y: 0, w: 0.5, h: 1 };
const FULL: FractionalRect = { x: 0, y: 0, w: 1, h: 1 };

describe('workspace serialize / deserialize', () => {
  it('round-trips floating + maximized windows by taskId, re-resolving the session', () => {
    const windows = [
      makeWindow('win-1', 'task-a', 'floating', { x: 0.1, y: 0.1, w: 0.4, h: 0.5 }),
      makeWindow('win-2', 'task-b', 'maximized', { x: 0.2, y: 0.2, w: 0.4, h: 0.5 }),
    ];
    const serialized = serializeWorkspace(windows, null, FULL, 'win-1');
    expect(serialized.windows.map((window) => window.taskId)).toEqual(['task-a', 'task-b']);
    expect(serialized.focusedTaskId).toBe('task-a');

    const restored = deserializeWorkspace(serialized, makeContext(['task-a', 'task-b']))!;
    const byTask = Object.fromEntries(Object.values(restored.windows).map((window) => [window.anchor, window]));
    expect(byTask['task-a'].state).toBe('floating');
    expect(byTask['task-a'].geometry).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.5 });
    expect(byTask['task-a'].sessionId).toBe('live-task-a'); // re-resolved, not the stale serialized one
    expect(byTask['task-b'].state).toBe('maximized');
    expect(restored.focusedWindowId).toBe(byTask['task-a'].id);
    expect(restored.tileTree).toBeNull();
  });

  it('marks every restored window to skip the entrance animation, and never persists the flag', () => {
    // A restored window must paint flat (no project-switch entrance replay), so deserialize
    // stamps the transient flag. It is presentation-only and must not survive a serialize.
    const restoredWindow = makeWindow('win-1', 'task-a', 'floating', HALF_LEFT);
    restoredWindow.skipEnterAnimation = true; // as a window already rebuilt by a prior restore carries
    const serialized = serializeWorkspace([restoredWindow], null, FULL, 'win-1');
    expect(serialized.windows[0]).not.toHaveProperty('skipEnterAnimation');

    const windows = [
      makeWindow('win-1', 'task-a', 'floating', { x: 0.1, y: 0.1, w: 0.4, h: 0.5 }),
      makeWindow('win-2', 'task-b', 'maximized', { x: 0.2, y: 0.2, w: 0.4, h: 0.5 }),
    ];
    const fresh = serializeWorkspace(windows, null, FULL, 'win-1');
    const restored = deserializeWorkspace(fresh, makeContext(['task-a', 'task-b']))!;
    expect(Object.values(restored.windows).every((window) => window.skipEnterAnimation === true)).toBe(true);
  });

  it('round-trips a 2-up tile tree, re-anchoring leaves by taskId then back to fresh window ids', () => {
    const tree: TileNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [
        { kind: 'leaf', id: 'leaf-1', windowId: 'win-1' },
        { kind: 'leaf', id: 'leaf-2', windowId: 'win-2' },
      ],
      sizes: [0.5, 0.5],
    };
    const windows = [
      makeWindow('win-1', 'task-a', 'tiled', HALF_LEFT, 'leaf-1'),
      makeWindow('win-2', 'task-b', 'tiled', HALF_RIGHT, 'leaf-2'),
    ];
    const serialized = serializeWorkspace(windows, tree, FULL, 'win-1');
    expect(serialized.tileTree).toEqual({
      kind: 'split',
      direction: 'horizontal',
      children: [{ kind: 'leaf', taskId: 'task-a' }, { kind: 'leaf', taskId: 'task-b' }],
      sizes: [0.5, 0.5],
    });

    const restored = deserializeWorkspace(serialized, makeContext(['task-a', 'task-b']))!;
    expect(restored.tileTree?.kind).toBe('split');
    const tiled = Object.values(restored.windows).filter((window) => window.state === 'tiled');
    expect(tiled).toHaveLength(2);
    expect(tiled.every((window) => window.leafId)).toBe(true);
    // The skip-enter flag rides the tiled-window spread too (restored tiles paint flat).
    expect(tiled.every((window) => window.skipEnterAnimation === true)).toBe(true);
    // The tree's leaves reference exactly the restored windows' new ids.
    expect(new Set(leafWindowIds(restored.tileTree!))).toEqual(new Set(Object.keys(restored.windows)));
  });

  it('drops a window whose task no longer exists', () => {
    const windows = [
      makeWindow('win-1', 'task-a', 'floating', HALF_LEFT),
      makeWindow('win-2', 'task-gone', 'floating', HALF_RIGHT),
    ];
    const serialized = serializeWorkspace(windows, null, FULL, null);
    const restored = deserializeWorkspace(serialized, makeContext(['task-a']))!;
    expect(Object.values(restored.windows).map((window) => window.anchor)).toEqual(['task-a']);
  });

  it('drops the tile tree and floats the survivor when a tiled task is gone', () => {
    const tree: TileNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [
        { kind: 'leaf', id: 'leaf-1', windowId: 'win-1' },
        { kind: 'leaf', id: 'leaf-2', windowId: 'win-2' },
      ],
      sizes: [0.5, 0.5],
    };
    const survivor = makeWindow('win-1', 'task-a', 'tiled', HALF_LEFT, 'leaf-1');
    survivor.restoreGeometry = { x: 0.15, y: 0.15, w: 0.4, h: 0.5 };
    const windows = [survivor, makeWindow('win-2', 'task-gone', 'tiled', HALF_RIGHT, 'leaf-2')];
    const serialized = serializeWorkspace(windows, tree, FULL, null);

    const restored = deserializeWorkspace(serialized, makeContext(['task-a']))!;
    expect(restored.tileTree).toBeNull();
    const restoredSurvivor = Object.values(restored.windows)[0];
    expect(restoredSurvivor.anchor).toBe('task-a');
    expect(restoredSurvivor.state).toBe('floating');
    expect(restoredSurvivor.geometry).toEqual({ x: 0.15, y: 0.15, w: 0.4, h: 0.5 }); // its pre-tile float
  });

  it('returns null when no persisted task survives', () => {
    const windows = [makeWindow('win-1', 'task-gone', 'floating', HALF_LEFT)];
    const serialized = serializeWorkspace(windows, null, FULL, null);
    expect(deserializeWorkspace(serialized, makeContext([]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Restore hardening: a layout read back from an on-disk config is never trusted.
// ---------------------------------------------------------------------------

/** Build a raw serialized workspace whose window entries can hold deliberately
 *  invalid values (out-of-range / malformed geometry, unknown state) so the
 *  sanitizing restore path can be exercised. */
function serializedWith(windows: Array<Record<string, unknown>>): SerializedWorkspace {
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    windows: windows as SerializedWorkspace['windows'],
    tileTree: null,
    tileTreeRect: { ...FULL },
    focusedTaskId: null,
  };
}

const VALID_PERSISTED = {
  taskId: 'task-a',
  title: 'Task task-a',
  geometry: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 },
  restoreGeometry: null,
  state: 'floating',
};

describe('deserializeWorkspace hardening', () => {
  it('ignores a workspace stamped with an unknown schema version', () => {
    const serialized = serializeWorkspace(
      [makeWindow('win-1', 'task-a', 'floating', HALF_LEFT)],
      null,
      FULL,
      null,
    );
    const fromFuture = { ...serialized, version: serialized.version + 1 };
    expect(deserializeWorkspace(fromFuture, makeContext(['task-a']))).toBeNull();
  });

  it('clamps out-of-range geometry back into the overlay', () => {
    const serialized = serializedWith([
      { ...VALID_PERSISTED, geometry: { x: -0.5, y: 2, w: 5, h: 0.4 } },
    ]);
    const restored = deserializeWorkspace(serialized, makeContext(['task-a']))!;
    const window = Object.values(restored.windows)[0];
    // w clamped to 1, x pinned so the (now full-width) window stays on the overlay,
    // y pinned so its bottom edge stays visible.
    expect(window.geometry).toEqual({ x: 0, y: 0.6, w: 1, h: 0.4 });
  });

  it('raises a below-minimum window size to the minimum visible size', () => {
    const serialized = serializedWith([
      { ...VALID_PERSISTED, geometry: { x: 0.1, y: 0.1, w: 0.001, h: 0 } },
    ]);
    const restored = deserializeWorkspace(serialized, makeContext(['task-a']))!;
    const window = Object.values(restored.windows)[0];
    expect(window.geometry).toEqual({ x: 0.1, y: 0.1, w: 0.05, h: 0.05 });
  });

  it('drops a window with malformed geometry instead of throwing, keeping the valid ones', () => {
    const serialized = serializedWith([
      VALID_PERSISTED,
      { taskId: 'task-bad', title: 'bad', geometry: { x: Number.NaN, y: 0, w: 0.4, h: 0.5 }, restoreGeometry: null, state: 'floating' },
    ]);
    const restored = deserializeWorkspace(serialized, makeContext(['task-a', 'task-bad']))!;
    expect(Object.values(restored.windows).map((window) => window.anchor)).toEqual(['task-a']);
  });

  it('drops a window with an unknown state', () => {
    const serialized = serializedWith([
      VALID_PERSISTED,
      { ...VALID_PERSISTED, taskId: 'task-weird', state: 'bogus' },
    ]);
    const restored = deserializeWorkspace(serialized, makeContext(['task-a', 'task-weird']))!;
    expect(Object.values(restored.windows).map((window) => window.anchor)).toEqual(['task-a']);
  });

  it('returns null when windows is not an array', () => {
    const hostile = {
      version: WORKSPACE_SCHEMA_VERSION,
      windows: null,
      tileTree: null,
      tileTreeRect: { ...FULL },
      focusedTaskId: null,
    };
    expect(deserializeWorkspace(hostile as unknown as SerializedWorkspace, makeContext(['task-a']))).toBeNull();
  });

  it('returns null when the blob itself is null or undefined', () => {
    expect(deserializeWorkspace(null as unknown as SerializedWorkspace, makeContext([]))).toBeNull();
    expect(deserializeWorkspace(undefined as unknown as SerializedWorkspace, makeContext([]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Command-terminal restore path: kind stamping + always-true isKnownAnchor.
// ---------------------------------------------------------------------------

function makeCommandContext(): RestoreContext {
  let windowCounter = 0;
  let tileCounter = 0;
  return {
    kind: 'command-terminal',
    // The command layer has no live PTY sessions at restore time; resolveSessionId
    // always returns null (the slot is the anchor, not a session id).
    resolveSessionId: () => null,
    // Slot anchors are synthetic and always survive the restore filter.
    isKnownAnchor: () => true,
    makeWindowId: () => `cw${(windowCounter += 1)}`,
    makeTileId: (kind) => `c${kind}-${(tileCounter += 1)}`,
  };
}

describe('command-terminal restore path', () => {
  it('stamps every restored window with kind=command-terminal from the restore context', () => {
    // Serialize a workspace as if it came from the task-detail layer (makeWindow uses kind: 'task-detail'
    // internally), then restore with the command-terminal context and verify the kind is overridden.
    const windows = [makeWindow('win-1', 'slot-1', 'floating', { x: 0.1, y: 0.1, w: 0.4, h: 0.5 })];
    const serialized = serializeWorkspace(windows, null, FULL, 'win-1');

    const restored = deserializeWorkspace(serialized, makeCommandContext())!;
    const restoredWindow = Object.values(restored.windows)[0];

    // The kind must come from context.kind, not from the serialized form (which has no kind field).
    expect(restoredWindow.kind).toBe('command-terminal');
    // The anchor round-trips correctly via the taskId field.
    expect(restoredWindow.anchor).toBe('slot-1');
  });

  it('isKnownAnchor: () => true keeps anchors that the task-detail filter would drop', () => {
    // 'slot-never-a-real-task' would be dropped by makeContext([]) since it has no known tasks,
    // but the command-terminal filter always returns true.
    const windows = [
      makeWindow('win-1', 'slot-never-a-real-task', 'floating', HALF_LEFT),
    ];
    const serialized = serializeWorkspace(windows, null, FULL, null);

    // The task-detail context with an empty known-task list would return null (nothing survives).
    expect(deserializeWorkspace(serialized, makeContext([]))).toBeNull();

    // The command-terminal context keeps the slot unconditionally.
    const restored = deserializeWorkspace(serialized, makeCommandContext())!;
    expect(restored).not.toBeNull();
    const restoredWindow = Object.values(restored.windows)[0];
    expect(restoredWindow.anchor).toBe('slot-never-a-real-task');
    expect(restoredWindow.kind).toBe('command-terminal');
  });
});

// ---------------------------------------------------------------------------
// The save trigger: the regression guard for the bug. Pure debounce/gate/flush
// state machine, exercised with fake timers (no jsdom, no stores).
// ---------------------------------------------------------------------------

const EMPTY_WORKSPACE = serializeWorkspace([], null, FULL, null);

describe('createWorkspaceSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves the active project\'s layout after the debounce while a project is open (Settings irrelevant)', () => {
    const save = vi.fn();
    const saver = createWorkspaceSaver({
      getProjectId: () => 'proj-1',
      getWorkspace: () => EMPTY_WORKSPACE,
      save,
      debounceMs: 500,
    });
    saver.onChange();
    expect(save).not.toHaveBeenCalled(); // not yet: still settling
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('proj-1', EMPTY_WORKSPACE);
  });

  it('does not save when no project is open', () => {
    const save = vi.fn();
    const saver = createWorkspaceSaver({
      getProjectId: () => null,
      getWorkspace: () => EMPTY_WORKSPACE,
      save,
      debounceMs: 500,
    });
    saver.onChange();
    vi.advanceTimersByTime(500);
    expect(save).not.toHaveBeenCalled();
  });

  it('coalesces rapid changes into a single save', () => {
    const save = vi.fn();
    const saver = createWorkspaceSaver({
      getProjectId: () => 'proj-1',
      getWorkspace: () => EMPTY_WORKSPACE,
      save,
      debounceMs: 500,
    });
    saver.onChange();
    vi.advanceTimersByTime(200);
    saver.onChange();
    vi.advanceTimersByTime(200);
    saver.onChange();
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush persists a pending layout immediately via saveSync, and does not double-save afterward', () => {
    const save = vi.fn();
    const saveSync = vi.fn();
    const saver = createWorkspaceSaver({
      getProjectId: () => 'proj-1',
      getWorkspace: () => EMPTY_WORKSPACE,
      save,
      saveSync,
      debounceMs: 500,
    });
    saver.onChange();
    saver.flush();
    expect(saveSync).toHaveBeenCalledTimes(1);
    expect(saveSync).toHaveBeenCalledWith('proj-1', EMPTY_WORKSPACE);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(saveSync).toHaveBeenCalledTimes(1); // the pending timer was cleared
    expect(save).not.toHaveBeenCalled();
  });

  it('flush persists the current layout even when nothing is pending (covers an in-flight async save)', () => {
    const save = vi.fn();
    const saveSync = vi.fn();
    const saver = createWorkspaceSaver({
      getProjectId: () => 'proj-1',
      getWorkspace: () => EMPTY_WORKSPACE,
      save,
      saveSync,
    });
    // A debounced async save fired and cleared its timer; before it lands the user quits.
    saver.flush();
    expect(saveSync).toHaveBeenCalledTimes(1);
    expect(saveSync).toHaveBeenCalledWith('proj-1', EMPTY_WORKSPACE);
  });

  it('flush falls back to the async save when no saveSync is provided', () => {
    const save = vi.fn();
    const saver = createWorkspaceSaver({
      getProjectId: () => 'proj-1',
      getWorkspace: () => EMPTY_WORKSPACE,
      save,
    });
    saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when no project is open', () => {
    const saveSync = vi.fn();
    const saver = createWorkspaceSaver({
      getProjectId: () => null,
      getWorkspace: () => EMPTY_WORKSPACE,
      save: vi.fn(),
      saveSync,
    });
    saver.flush();
    expect(saveSync).not.toHaveBeenCalled();
  });

  it('reads the project id and workspace together at persist time (consistent, never cross-contaminated)', () => {
    const save = vi.fn();
    let projectId: string | null = 'proj-a';
    let workspace = EMPTY_WORKSPACE;
    const otherWorkspace = serializeWorkspace([], null, HALF_LEFT, null);
    const saver = createWorkspaceSaver({
      getProjectId: () => projectId,
      getWorkspace: () => workspace,
      save,
      debounceMs: 500,
    });
    saver.onChange();
    // A project switch lands before the debounce fires: both reads must reflect the
    // new project, so the save can never write one project's windows under another's id.
    projectId = 'proj-b';
    workspace = otherWorkspace;
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('proj-b', otherWorkspace);
  });

  it('disposing cancels a pending save', () => {
    const save = vi.fn();
    const saver = createWorkspaceSaver({
      getProjectId: () => 'proj-1',
      getWorkspace: () => EMPTY_WORKSPACE,
      save,
      debounceMs: 500,
    });
    saver.onChange();
    saver.dispose();
    vi.advanceTimersByTime(500);
    expect(save).not.toHaveBeenCalled();
  });
});
