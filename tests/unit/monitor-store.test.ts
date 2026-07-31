/**
 * Unit tests for src/renderer/stores/monitor-store.ts.
 *
 * tests/ui/agent-monitor.spec.ts drives the store through the real UI, so it
 * covers what a user can reach: opening, filtering, switching layout, and the
 * preference surviving a close and reopen. What it cannot reach is the state a
 * PREVIOUS version of the app persisted. This file drives the store directly to
 * pin those branches:
 *  - hydrateView migrates the renamed keys ('compact' layout, hideIdle) instead
 *    of silently resetting a remembered preference on upgrade,
 *  - hydrateView discards values whose option was REMOVED ('flat' grouping,
 *    'attention' sort) rather than leaving a control with nothing selected,
 *  - setView merges rather than replaces, and persists through the GLOBAL config
 *    merge (which is what makes the view survive a crash, not only a clean close),
 *  - applyActivity patches a known row in place and DROPS a push for a session
 *    the snapshot has not carried yet.
 *
 * window.electronAPI is stubbed globally before importing the store, mirroring
 * mobile-store.test.ts's pattern for a Node (non-jsdom) test environment.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppConfig, MonitorSessionRow, MonitorView } from '../../src/shared/types';
import { DEFAULT_CONFIG } from '../../src/shared/types';

const configSetMock = vi.fn<(patch: Partial<AppConfig>) => Promise<void>>();
const getSnapshotMock = vi.fn();
const subscribeMock = vi.fn();
const unsubscribeMock = vi.fn();

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: { set: configSetMock },
    monitor: { getSnapshot: getSnapshotMock, subscribe: subscribeMock, unsubscribe: unsubscribeMock },
  },
};

// Import after the global stub so the store module sees the mocked window.
import { useMonitorStore } from '../../src/renderer/stores/monitor-store';

/** A persisted blob shaped like an older release wrote it. */
function legacyView(overrides: Record<string, unknown>): Partial<MonitorView> {
  return overrides as Partial<MonitorView>;
}

function makeRow(overrides: Partial<MonitorSessionRow> = {}): MonitorSessionRow {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    projectName: 'kangentic',
    taskId: 'task-1',
    taskTitle: 'Fix PTY capture race',
    taskDescription: null,
    displayId: 142,
    columnName: 'Tests',
    labels: [],
    prUrl: null,
    prNumber: null,
    prState: null,
    agentName: 'claude',
    modelDisplayName: 'Opus 5',
    effort: null,
    permissionMode: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: null,
    status: 'running',
    activity: 'thinking',
    activityReason: null,
    lastEvent: null,
    contextPercent: null,
    isolated: false,
    isCommandTerminal: false,
    ...overrides,
  };
}

describe('monitor-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    configSetMock.mockResolvedValue(undefined);
    useMonitorStore.setState({
      view: DEFAULT_CONFIG.monitor,
      rows: [],
      loaded: false,
      monitorOpen: false,
      snapshotGeneration: 0,
    });
  });

  describe('hydrateView', () => {
    it('fills every key the stored blob lacks', () => {
      useMonitorStore.getState().hydrateView({ layout: 'table' });
      const { view } = useMonitorStore.getState();
      expect(view.layout).toBe('table');
      expect(view.groupBy).toBe(DEFAULT_CONFIG.monitor.groupBy);
      expect(view.textFilter).toBe('');
    });

    it('treats a missing blob as the defaults rather than throwing', () => {
      useMonitorStore.getState().hydrateView(undefined);
      expect(useMonitorStore.getState().view).toEqual(DEFAULT_CONFIG.monitor);
    });

    it("migrates the old 'compact' layout to 'list'", () => {
      useMonitorStore.getState().hydrateView(legacyView({ layout: 'compact' }));
      expect(useMonitorStore.getState().view.layout).toBe('list');
    });

    it('migrates hideIdle to liveOnly, keeping the value', () => {
      useMonitorStore.getState().hydrateView(legacyView({ hideIdle: true }));
      expect(useMonitorStore.getState().view.liveOnly).toBe(true);
    });

    it('prefers an explicit liveOnly over a stale hideIdle left beside it', () => {
      useMonitorStore.getState().hydrateView(legacyView({ liveOnly: false, hideIdle: true }));
      expect(useMonitorStore.getState().view.liveOnly).toBe(false);
    });

    it('clears a filter no control can undo', () => {
      // An older build shipped a project scope picker. Honouring what it wrote
      // would hide rows on this build with nothing in the UI able to unhide them.
      useMonitorStore.getState().hydrateView(legacyView({
        projectFilter: ['a-project-that-no-longer-exists'],
        stateFilter: ['finished'],
      }));
      const { view } = useMonitorStore.getState();
      expect(view.projectFilter).toEqual([]);
      expect(view.stateFilter).toEqual([]);
    });

    it('falls back to the default for an option that no longer exists', () => {
      // Merged in blindly, these would leave the control with nothing selected
      // and the list ordered by something the toolbar does not admit to.
      useMonitorStore.getState().hydrateView(legacyView({ groupBy: 'flat', sort: 'attention' }));
      const { view } = useMonitorStore.getState();
      // Falls back to the shipped defaults rather than a hard-coded literal, so
      // changing a default cannot leave the sanitiser pointing at the old one.
      expect(view.groupBy).toBe(DEFAULT_CONFIG.monitor.groupBy);
      expect(view.sort).toBe(DEFAULT_CONFIG.monitor.sort);
    });
  });

  describe('setView', () => {
    it('merges the patch instead of replacing the whole view', () => {
      useMonitorStore.getState().setView({ textFilter: 'noise' });
      useMonitorStore.getState().setView({ layout: 'list' });
      const { view } = useMonitorStore.getState();
      expect(view.layout).toBe('list');
      expect(view.textFilter).toBe('noise');
    });

    it('coalesces rapid changes into one global-config write', async () => {
      vi.useFakeTimers();
      useMonitorStore.getState().setView({ textFilter: 'a' });
      useMonitorStore.getState().setView({ textFilter: 'ab' });
      useMonitorStore.getState().setView({ textFilter: 'abc' });
      expect(configSetMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(configSetMock).toHaveBeenCalledTimes(1);
      expect(configSetMock.mock.calls[0][0].monitor?.textFilter).toBe('abc');
    });
  });

  describe('applySnapshot', () => {
    /**
     * The push is unconditional and every row arrives as a fresh object (structured
     * clone across IPC), so assigning the incoming array would re-render the whole
     * monitor on a 250ms cadence for as long as session events flow. These pin the
     * merge that makes an equivalent push cost nothing.
     */
    it('keeps the array and every row identity when nothing changed', () => {
      const initial = [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b' })];
      useMonitorStore.getState().applySnapshot({ rows: initial, generatedAt: 'x' });
      const held = useMonitorStore.getState().rows;

      // A structurally identical snapshot, freshly allocated as IPC would deliver it.
      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b' })],
        generatedAt: 'y',
      });

      expect(useMonitorStore.getState().rows).toBe(held);
    });

    it('does not notify subscribers on an equivalent push', () => {
      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a' })],
        generatedAt: 'x',
      });

      const listener = vi.fn();
      const unsubscribe = useMonitorStore.subscribe(listener);
      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a' })],
        generatedAt: 'y',
      });
      unsubscribe();

      expect(listener).not.toHaveBeenCalled();
    });

    it('reuses the unchanged rows and replaces only the one that moved', () => {
      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b' })],
        generatedAt: 'x',
      });
      const held = useMonitorStore.getState().rows;

      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b', activity: 'idle' })],
        generatedAt: 'y',
      });

      const next = useMonitorStore.getState().rows;
      expect(next).not.toBe(held);
      expect(next[0]).toBe(held[0]);
      expect(next[1]).not.toBe(held[1]);
      expect(next[1].activity).toBe('idle');
    });

    it('treats a reorder as a change even though both rows are reused', () => {
      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b' })],
        generatedAt: 'x',
      });
      const held = useMonitorStore.getState().rows;

      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'b' }), makeRow({ sessionId: 'a' })],
        generatedAt: 'y',
      });

      const next = useMonitorStore.getState().rows;
      expect(next).not.toBe(held);
      expect(next.map((row) => row.sessionId)).toEqual(['b', 'a']);
      expect(next[0]).toBe(held[1]);
    });

    it('reuses a row whose nested values are equal but freshly allocated', () => {
      // Structured clone rebuilds the nested objects too, so a shallow compare
      // would see labels / activityReason / lastEvent differ on every push and
      // never reuse anything.
      const nested = () => makeRow({
        sessionId: 'a',
        labels: ['ui', 'perf'],
        activityReason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' },
        lastEvent: { type: 'tool_start', detail: 'npm test' },
      });
      useMonitorStore.getState().applySnapshot({ rows: [nested()], generatedAt: 'x' });
      const held = useMonitorStore.getState().rows;

      useMonitorStore.getState().applySnapshot({ rows: [nested()], generatedAt: 'y' });

      expect(useMonitorStore.getState().rows).toBe(held);
    });

    it('replaces a row when a nested value actually changed', () => {
      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a', labels: ['ui'] })],
        generatedAt: 'x',
      });
      const held = useMonitorStore.getState().rows;

      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a', labels: ['ui', 'perf'] })],
        generatedAt: 'y',
      });

      const next = useMonitorStore.getState().rows;
      expect(next).not.toBe(held);
      expect(next[0].labels).toEqual(['ui', 'perf']);
    });

    it('marks loaded on the first snapshot even when it is empty', () => {
      // Both arrays are empty, so the merge returns the previous reference; the
      // cold-load skeleton still has to be dismissed.
      expect(useMonitorStore.getState().loaded).toBe(false);
      useMonitorStore.getState().applySnapshot({ rows: [], generatedAt: 'x' });
      expect(useMonitorStore.getState().loaded).toBe(true);
    });

    it('drops a row that disappeared from the snapshot', () => {
      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b' })],
        generatedAt: 'x',
      });
      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a' })],
        generatedAt: 'y',
      });
      expect(useMonitorStore.getState().rows.map((row) => row.sessionId)).toEqual(['a']);
    });
  });

  describe('applyActivity', () => {
    it('patches the matching row in place without a refetch', () => {
      useMonitorStore.setState({ rows: [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b' })] });
      useMonitorStore.getState().applyActivity('b', 'idle', { kind: 'idle', since: 1_000 });

      const { rows } = useMonitorStore.getState();
      expect(rows[0].activity).toBe('thinking');
      expect(rows[1].activity).toBe('idle');
      expect(rows[1].activityReason).toEqual({ kind: 'idle', since: 1_000 });
      expect(getSnapshotMock).not.toHaveBeenCalled();
    });

    it('drops a push for a session the snapshot has not carried yet', () => {
      // The snapshot is the authority on WHICH sessions exist; synthesizing a
      // half-populated row here would render a card with no project or title.
      const rows = [makeRow({ sessionId: 'a' })];
      useMonitorStore.setState({ rows });
      useMonitorStore.getState().applyActivity('unknown', 'idle', null);
      expect(useMonitorStore.getState().rows).toBe(rows);
    });
  });

  describe('snapshotGeneration', () => {
    // MonitorTaskDetailHost keys its bundle refetch on this counter. The
    // contract that stops the getTaskDetail amplification: only a snapshot that
    // actually changed the rows moves it; an activity patch never does, no
    // matter how many arrive.
    it('bumps when a snapshot changes the rows', () => {
      const before = useMonitorStore.getState().snapshotGeneration;
      useMonitorStore.getState().applySnapshot({ rows: [makeRow({ sessionId: 'a' })], generatedAt: 'x' });
      expect(useMonitorStore.getState().snapshotGeneration).toBe(before + 1);
    });

    it('does not bump on an equivalent (no-op) snapshot', () => {
      useMonitorStore.getState().applySnapshot({ rows: [makeRow({ sessionId: 'a' })], generatedAt: 'x' });
      const before = useMonitorStore.getState().snapshotGeneration;
      useMonitorStore.getState().applySnapshot({ rows: [makeRow({ sessionId: 'a' })], generatedAt: 'y' });
      expect(useMonitorStore.getState().snapshotGeneration).toBe(before);
    });

    it('never bumps on applyActivity, however many ticks arrive', () => {
      useMonitorStore.getState().applySnapshot({
        rows: [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b' })],
        generatedAt: 'x',
      });
      const before = useMonitorStore.getState().snapshotGeneration;
      for (let tick = 0; tick < 25; tick += 1) {
        useMonitorStore.getState().applyActivity(tick % 2 === 0 ? 'a' : 'b', 'idle', null);
        useMonitorStore.getState().applyActivity(tick % 2 === 0 ? 'a' : 'b', 'thinking', null);
      }
      expect(useMonitorStore.getState().snapshotGeneration).toBe(before);
    });
  });

  describe('attach / detach (monitor:subscribe handshake)', () => {
    it('attach seeds the rows from the snapshot the subscription returns', async () => {
      subscribeMock.mockResolvedValue({ rows: [makeRow({ sessionId: 'a' })], generatedAt: 'x' });
      await useMonitorStore.getState().attach();
      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect(useMonitorStore.getState().rows.map((row) => row.sessionId)).toEqual(['a']);
      expect(useMonitorStore.getState().loaded).toBe(true);
      expect(useMonitorStore.getState().loading).toBe(false);
    });

    it('open attaches and close detaches', async () => {
      subscribeMock.mockResolvedValue({ rows: [], generatedAt: 'x' });
      unsubscribeMock.mockResolvedValue(undefined);
      useMonitorStore.getState().open();
      expect(useMonitorStore.getState().monitorOpen).toBe(true);
      expect(subscribeMock).toHaveBeenCalledTimes(1);
      useMonitorStore.getState().close();
      expect(useMonitorStore.getState().monitorOpen).toBe(false);
      expect(unsubscribeMock).toHaveBeenCalledTimes(1);
      await Promise.resolve();
    });
  });
});
