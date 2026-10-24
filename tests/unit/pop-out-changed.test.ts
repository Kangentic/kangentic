/**
 * Unit tests for src/renderer/pop-out/pop-out-changed.ts: the `popOut:changed`
 * push handler that mirrors the open set into the pop-out store and closes the
 * in-app Changes panel for any `changes` window that just disappeared.
 *
 * The load-bearing property here is the SPLIT between the two entry points.
 * `pop-out-store.setOpen()` is also reached from `loadOpen()`, which App.tsx
 * calls at mount and on every HMR `vite:afterUpdate`, so it must stay a plain
 * setter with no cross-store effects; only the push may close a panel. Folding
 * the diff into `setOpen` would look like a tidy simplification and would make a
 * Fast Refresh close the user's panel, so both halves are asserted.
 *
 * window.electronAPI is stubbed before importing the stores, mirroring
 * pop-out-store.test.ts's pattern for a Node (non-jsdom) test environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const listOpenMock = vi.fn<() => Promise<string[]>>();
const setDetailViewStateMock = vi.fn();

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    popOut: { listOpen: listOpenMock },
    tasks: { setDetailViewState: setDetailViewStateMock },
  },
};

import { receivePopOutOpenSet } from '../../src/renderer/pop-out/pop-out-changed';
import { usePopOutStore } from '../../src/renderer/stores/pop-out-store';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { useProjectStore } from '../../src/renderer/stores/project-store';

const CHANGES_KEY = 'changes:p1:t1';

/** Seed "the Changes panel is open for t1, detached into its own window". */
function seedDetachedChangesPanel(): void {
  useSessionStore.setState({
    changesOpenTasks: new Set(['t1']),
    changesViewMode: { t1: 'split' },
  });
  usePopOutStore.setState({ openInstanceKeys: { [CHANGES_KEY]: true } });
}

describe('receivePopOutOpenSet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePopOutStore.setState({ openInstanceKeys: {} });
    useSessionStore.setState({
      changesOpenTasks: new Set<string>(),
      browserOpenTasks: new Set<string>(),
      changesViewMode: {},
    });
  });

  it('mirrors the pushed open set into the pop-out store', () => {
    receivePopOutOpenSet(['stats', CHANGES_KEY]);

    expect(usePopOutStore.getState().openInstanceKeys).toEqual({ stats: true, [CHANGES_KEY]: true });
  });

  describe('the setOpen / push split', () => {
    it('the raw setOpen (and therefore loadOpen and the HMR re-sync) never closes the panel', () => {
      seedDetachedChangesPanel();

      usePopOutStore.getState().setOpen([]);

      expect([...useSessionStore.getState().changesOpenTasks]).toEqual(['t1']);
    });

    it('the push DOES close the panel when the changes window disappears', () => {
      seedDetachedChangesPanel();

      receivePopOutOpenSet([]);

      expect([...useSessionStore.getState().changesOpenTasks]).toEqual([]);
    });
  });

  it('drops the task view mode along with the open flag, so the next open is not resurrected as expanded', () => {
    seedDetachedChangesPanel();
    useSessionStore.setState({ changesViewMode: { t1: 'expanded' } });

    receivePopOutOpenSet([]);

    expect(useSessionStore.getState().changesViewMode).not.toHaveProperty('t1');
  });

  it('leaves the panel open while the changes window is still in the pushed set', () => {
    seedDetachedChangesPanel();

    receivePopOutOpenSet([CHANGES_KEY, 'stats']);

    expect([...useSessionStore.getState().changesOpenTasks]).toEqual(['t1']);
  });

  it('closes only the task whose window disappeared', () => {
    useSessionStore.setState({ changesOpenTasks: new Set(['t1', 't2']) });
    usePopOutStore.setState({ openInstanceKeys: { 'changes:p1:t1': true, 'changes:p1:t2': true } });

    receivePopOutOpenSet(['changes:p1:t2']);

    expect([...useSessionStore.getState().changesOpenTasks]).toEqual(['t2']);
  });

  /**
   * A per-file diff window is ADDITIVE: it is opened FROM the inline panel and
   * that panel stays mounted behind it, so closing one must leave the panel
   * exactly as it was.
   */
  it('a closing "changes-file" window leaves the inline Changes panel open', () => {
    useSessionStore.setState({ changesOpenTasks: new Set(['t1']) });
    usePopOutStore.setState({ openInstanceKeys: { 'changes-file:p1:t1:src/a b/c.ts': true } });

    receivePopOutOpenSet([]);

    expect([...useSessionStore.getState().changesOpenTasks]).toEqual(['t1']);
  });

  /** The Browser pane reclaims the same way; it is deliberately left alone. */
  it('a closing "browser" window leaves browserOpenTasks untouched', () => {
    useSessionStore.setState({ browserOpenTasks: new Set(['t1']) });
    usePopOutStore.setState({ openInstanceKeys: { 'browser:p1:t1': true } });

    receivePopOutOpenSet([]);

    expect([...useSessionStore.getState().browserOpenTasks]).toEqual(['t1']);
  });

  it('a closing global "stats" window closes no panel', () => {
    useSessionStore.setState({ changesOpenTasks: new Set(['t1']) });
    usePopOutStore.setState({ openInstanceKeys: { stats: true } });

    receivePopOutOpenSet([]);

    expect([...useSessionStore.getState().changesOpenTasks]).toEqual(['t1']);
  });

  /**
   * The detached Command Terminal: its in-app panel never shows beside it, and
   * closing it brings the panel back only while that project is on screen AND
   * still has a terminal running. Stopping the last terminal closes the window
   * too, and reopening the panel then would start a terminal nobody asked for.
   */
  describe('the detached Command Terminal', () => {
    const COMMAND_TERMINAL_KEY = 'command-terminal:p1';
    const project = { id: 'p1', name: 'Project', path: '/mock/project' };

    function liveTerminal(projectId: string): Record<string, unknown> {
      return { id: `term-${projectId}`, projectId, transient: true, status: 'running', commandTerminalSlot: 'slot-1', taskId: '' };
    }

    function seedDetachedTerminals(sessions: Array<Record<string, unknown>>): void {
      useProjectStore.setState({ currentProject: project });
      useSessionStore.setState({
        sessions: sessions as never,
        commandBarVisible: false,
        _pendingOpenCommandTerminal: false,
      });
      usePopOutStore.setState({ openInstanceKeys: { [COMMAND_TERMINAL_KEY]: true } });
    }

    afterEach(() => useProjectStore.setState({ currentProject: null }));

    it('hides the in-app panel when its project\'s window opens', () => {
      useProjectStore.setState({ currentProject: project });
      useSessionStore.setState({ commandBarVisible: true });

      receivePopOutOpenSet([COMMAND_TERMINAL_KEY]);

      expect(useSessionStore.getState().commandBarVisible).toBe(false);
    });

    it('leaves the panel alone when another project\'s window opens', () => {
      useProjectStore.setState({ currentProject: project });
      useSessionStore.setState({ commandBarVisible: true });

      receivePopOutOpenSet(['command-terminal:p2']);

      expect(useSessionStore.getState().commandBarVisible).toBe(true);
    });

    it('asks for the panel again when the window closes with a terminal still running', () => {
      seedDetachedTerminals([liveTerminal('p1')]);

      receivePopOutOpenSet([]);

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(true);
    });

    it('does not reopen the panel once the last terminal stopped', () => {
      seedDetachedTerminals([{ ...liveTerminal('p1'), status: 'exited' }, liveTerminal('p2')]);

      receivePopOutOpenSet([]);

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
    });

    it('does not reopen the panel when the board is on another project', () => {
      seedDetachedTerminals([liveTerminal('p1')]);
      useProjectStore.setState({ currentProject: { id: 'p2', name: 'Other', path: '/mock/other' } });

      receivePopOutOpenSet([]);

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
    });

    it('the raw setOpen (the HMR re-sync) never reopens it', () => {
      seedDetachedTerminals([liveTerminal('p1')]);

      usePopOutStore.getState().setOpen([]);

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
    });
  });

  /**
   * The window can outlive a board switch, so the closed state must be persisted
   * against the project named by the KEY, not whichever board is open now.
   */
  describe('persistence', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    afterEach(() => useProjectStore.setState({ currentProject: null }));

    it('saves the task blob against the project id carried by the closed key', () => {
      seedDetachedChangesPanel();

      receivePopOutOpenSet([]);
      vi.runAllTimers();

      expect(setDetailViewStateMock).toHaveBeenCalledTimes(1);
      const [taskId, blob, projectId] = setDetailViewStateMock.mock.calls[0];
      expect(taskId).toBe('t1');
      expect(projectId).toBe('p1');
      expect(blob).not.toHaveProperty('changesOpen');
    });

    it('still saves against the closed key project id when the ambient project is a different one', () => {
      // The test above only proves the override beats an ABSENT ambient
      // project: useProjectStore's currentProject defaults to null, and the
      // override wins over null even by accident (`projectIdOverride ??
      // null`). Seeding a real, DIFFERENT current project here is what
      // actually exercises why projectIdOverride exists: a `changes` pop-out
      // can close after the user has switched boards, and the write must
      // still land on the task's own project (the one named by the closed
      // key), never whichever project is on screen when the window closes.
      useProjectStore.setState({
        currentProject: { id: 'p2', name: 'Other Project', path: '/mock/other-project' },
      });
      seedDetachedChangesPanel();

      receivePopOutOpenSet([]);
      vi.runAllTimers();

      expect(setDetailViewStateMock).toHaveBeenCalledTimes(1);
      const [taskId, , projectId] = setDetailViewStateMock.mock.calls[0];
      expect(taskId).toBe('t1');
      expect(projectId).toBe('p1'); // the closed key's project, not the ambient 'p2'
    });
  });
});
