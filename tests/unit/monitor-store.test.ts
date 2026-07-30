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

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: { set: configSetMock },
    monitor: { getSnapshot: getSnapshotMock },
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
    useMonitorStore.setState({ view: DEFAULT_CONFIG.monitor, rows: [], loaded: false });
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
});
