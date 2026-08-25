/**
 * Pins monitorSurface's config-store subscription guard
 * (src/renderer/pop-out/surfaces/monitor-surface.tsx): a config:changed
 * broadcast anywhere in the app hands this window a FRESH structured-clone
 * config, so `config.monitor` is a new object reference on every write, monitor
 * or not. Comparing by reference used to re-hydrate the monitor's view on every
 * one of those broadcasts, which clobbered a view edit still inside setView's
 * 400ms persist debounce - a just-toggled Projects checkbox visibly reverted,
 * and a further edit made in that reverted state persisted the stale base.
 * `deepEqual` is what makes this a no-op unless the monitor view itself
 * actually changed on disk.
 *
 * window.electronAPI is stubbed globally before importing any store, mirroring
 * monitor-store.test.ts's pattern for a Node (non-jsdom) test environment.
 * useSessionStore and PopOutMonitorRoot are mocked away: bootstrap's calls into
 * them are incidental to this guard (session sync, the detached window's React
 * tree) and mocking them keeps the test from having to stand up session-store's
 * full IPC surface or drag in the monitor's whole component tree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';

const monitorSubscribeMock = vi.fn();
const monitorUnsubscribeMock = vi.fn();
const monitorGetSnapshotMock = vi.fn();
const monitorOnChangedMock = vi.fn();
const sessionsOnActivityMock = vi.fn();
const configSetMock = vi.fn();
const configGetMock = vi.fn();
const configGetGlobalMock = vi.fn();

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: { get: configGetMock, getGlobal: configGetGlobalMock, set: configSetMock },
    monitor: {
      subscribe: monitorSubscribeMock,
      unsubscribe: monitorUnsubscribeMock,
      getSnapshot: monitorGetSnapshotMock,
      onChanged: monitorOnChangedMock,
    },
    sessions: { onActivity: sessionsOnActivityMock },
  },
};

vi.mock('../../src/renderer/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ syncSessions: vi.fn().mockResolvedValue(undefined) }) },
}));

// Avoids dragging in the monitor's whole component tree (LazyMonitor,
// MonitorDetailLayer, window-manager, ...) for a test that never reads Root.
vi.mock('../../src/renderer/pop-out/roots/PopOutMonitorRoot', () => ({
  PopOutMonitorRoot: () => null,
}));

// Imported after the stubs/mocks above, mirroring monitor-store.test.ts.
import { useConfigStore } from '../../src/renderer/stores/config-store';
import { useMonitorStore } from '../../src/renderer/stores/monitor-store';
import { monitorSurface } from '../../src/renderer/pop-out/surfaces/monitor-surface';

function resetStores(): void {
  useConfigStore.setState({
    config: DEFAULT_CONFIG,
    globalConfig: DEFAULT_CONFIG,
    workspaceSeeded: true,
    loading: false,
  });
  useMonitorStore.setState({
    view: DEFAULT_CONFIG.monitor,
    rows: [],
    loaded: false,
    monitorOpen: false,
    snapshotGeneration: 0,
  });
}

describe('monitorSurface bootstrap: config-store subscription guard', () => {
  let controller: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    monitorSubscribeMock.mockResolvedValue({ rows: [], generatedAt: 'boot' });
    monitorUnsubscribeMock.mockResolvedValue(undefined);
    monitorGetSnapshotMock.mockResolvedValue({ rows: [], generatedAt: 'boot' });
    monitorOnChangedMock.mockReturnValue(() => {});
    sessionsOnActivityMock.mockReturnValue(() => {});
    configSetMock.mockResolvedValue(undefined);
    resetStores();
    controller = new AbortController();
  });

  afterEach(() => {
    // Tear down this test's subscription so a leftover listener from an
    // earlier test cannot mask what the NEXT test's assertions are actually
    // exercising.
    controller.abort();
  });

  it('does not re-hydrate when config.monitor is a fresh object with identical values, so an in-flight local edit survives', () => {
    monitorSurface.bootstrap({}, { signal: controller.signal });

    // A local edit still inside setView's persist debounce - the exact
    // just-toggled-Projects-checkbox scenario from the bug report.
    useMonitorStore.getState().setView({ projectFilter: ['proj-a'] });
    expect(useMonitorStore.getState().view.projectFilter).toEqual(['proj-a']);

    // An unrelated config write elsewhere in the app: loadConfig() sets a
    // FRESH structured-clone config on every config:changed broadcast, so
    // `config.monitor` is a new object reference carrying the SAME values.
    useConfigStore.setState((state) => ({
      config: { ...state.config, monitor: { ...state.config.monitor } },
    }));

    // The guard must treat this as a no-op: the local edit survives.
    expect(useMonitorStore.getState().view.projectFilter).toEqual(['proj-a']);
  });

  it('re-hydrates when config.monitor genuinely differs by value', () => {
    monitorSurface.bootstrap({}, { signal: controller.signal });

    useMonitorStore.getState().setView({ projectFilter: ['proj-a'] });
    expect(useMonitorStore.getState().view.projectFilter).toEqual(['proj-a']);

    // The main window actually wrote a different monitor view to disk.
    useConfigStore.setState((state) => ({
      config: { ...state.config, monitor: { ...state.config.monitor, projectFilter: ['proj-b'] } },
    }));

    expect(useMonitorStore.getState().view.projectFilter).toEqual(['proj-b']);
  });
});
