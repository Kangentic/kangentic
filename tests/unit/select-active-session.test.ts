/**
 * Unit tests for the selectActiveSession and deleteProject store methods
 * that implement the "remember last active task tab per project" feature.
 *
 * selectActiveSession (session-store.ts):
 *   - happy path: updates activeSessionId AND persists to configStore + fires config.set
 *   - no-op guard: same taskId already stored -- must NOT call config.set again
 *   - skip cases: null, ACTIVITY_TAB, transient session, session in another project
 *
 * deleteProject cleanup (project-store.ts):
 *   - entry exists: strips from both config/globalConfig and fires config.set
 *   - entry absent: config.set is NOT called
 *
 * All tests use Zustand stores directly, with window.electronAPI stubbed so
 * the async IPC calls in other store methods do not throw when the module
 * initialises. Only config.set and project-level methods that the feature
 * path touches are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACTIVITY_TAB } from '../../src/shared/types';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { Session } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub window.electronAPI before importing any store that touches it.
// Zustand create() runs synchronously during module evaluation, but no store
// calls window.electronAPI at that point -- only in async action methods.
// We still need the stub so that any import-time optional chaining (e.g.
// window.electronAPI?.config?.set) does not throw ReferenceError in node env.
// ---------------------------------------------------------------------------

const configSetSpy = vi.fn();

// Using vi.stubGlobal would require importing vitest utilities before module
// imports, which ESM hoisting does not guarantee. Assigning to globalThis
// directly before any import of the stores is safe in node environment.
(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: {
      set: configSetSpy,
      get: async () => DEFAULT_CONFIG,
      getGlobal: async () => DEFAULT_CONFIG,
      getProjectOverrides: async () => null,
    },
    projects: {
      list: async () => [],
      delete: async () => {},
    },
    sessions: {
      list: async () => [],
      spawn: async () => ({}),
      kill: async () => {},
      reset: async () => {},
      suspend: async () => {},
      resume: async () => ({}),
      getUsage: async () => ({}),
      getActivity: async () => ({}),
      getEventsCache: async () => ({}),
    },
  },
};

// Import after the global stub so the module sees the mocked window.
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { useConfigStore } from '../../src/renderer/stores/config-store';
import { buildSessionByTaskId } from '../../src/renderer/stores/session-store/session-index';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-default',
    taskId: 'task-default',
    projectId: 'proj-default',
    pid: 1000,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    ...overrides,
  };
}

/**
 * Reset all three stores to clean state before each test.
 * This prevents state from one test leaking into the next.
 */
function resetStores(options: { currentProjectId?: string } = {}): void {
  useSessionStore.setState({
    sessions: [],
    _sessionByTaskId: new Map(),
    activeSessionId: null,
    detailTaskId: null,
    dialogSessionId: null,
    sessionUsage: {},
    sessionFirstOutput: {},
    sessionActivity: {},
    sessionEvents: {},
    seenIdleSessions: {},
    pendingCommandLabel: {},
    spawnProgress: {},
    _pendingOpenTaskId: null,
    _pendingOpenCommandTerminal: false,
  });

  useProjectStore.setState({
    projects: [],
    groups: [],
    currentProject: options.currentProjectId
      ? {
          id: options.currentProjectId,
          name: 'Test Project',
          path: '/mock/project',
          github_url: null,
          default_agent: 'claude',
          group_id: null,
          position: 0,
          last_opened: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }
      : null,
    loading: false,
    hydrated: true,
  });

  useConfigStore.setState({
    config: { ...DEFAULT_CONFIG, lastActiveTaskByProject: {} },
    globalConfig: { ...DEFAULT_CONFIG, lastActiveTaskByProject: {} },
    loading: false,
  });
}

// ---------------------------------------------------------------------------
// selectActiveSession - happy path
// ---------------------------------------------------------------------------

describe('selectActiveSession - happy path', () => {
  beforeEach(() => {
    configSetSpy.mockClear();
    resetStores({ currentProjectId: 'proj-alpha' });
  });

  it('sets activeSessionId on the store', () => {
    const session = makeSession({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-alpha' });
    useSessionStore.setState({
      sessions: [session],
      _sessionByTaskId: buildSessionByTaskId([session]),
    });

    useSessionStore.getState().selectActiveSession('sess-1');

    expect(useSessionStore.getState().activeSessionId).toBe('sess-1');
  });

  it('writes lastActiveTaskByProject into both config and globalConfig in the store', () => {
    const session = makeSession({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-alpha' });
    useSessionStore.setState({
      sessions: [session],
      _sessionByTaskId: buildSessionByTaskId([session]),
    });

    useSessionStore.getState().selectActiveSession('sess-1');

    const configState = useConfigStore.getState();
    expect(configState.config.lastActiveTaskByProject?.['proj-alpha']).toBe('task-1');
    expect(configState.globalConfig.lastActiveTaskByProject?.['proj-alpha']).toBe('task-1');
  });

  it('fires window.electronAPI.config.set with the updated map', () => {
    const session = makeSession({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-alpha' });
    useSessionStore.setState({
      sessions: [session],
      _sessionByTaskId: buildSessionByTaskId([session]),
    });

    useSessionStore.getState().selectActiveSession('sess-1');

    expect(configSetSpy).toHaveBeenCalledOnce();
    expect(configSetSpy).toHaveBeenCalledWith({
      lastActiveTaskByProject: { 'proj-alpha': 'task-1' },
    });
  });

  it('merges with existing entries for other projects rather than replacing them', () => {
    // Pre-seed an existing entry for a different project
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: { 'proj-beta': 'task-beta' },
      },
      globalConfig: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: { 'proj-beta': 'task-beta' },
      },
    });

    const session = makeSession({ id: 'sess-1', taskId: 'task-alpha', projectId: 'proj-alpha' });
    useSessionStore.setState({
      sessions: [session],
      _sessionByTaskId: buildSessionByTaskId([session]),
    });

    useSessionStore.getState().selectActiveSession('sess-1');

    expect(configSetSpy).toHaveBeenCalledWith({
      lastActiveTaskByProject: {
        'proj-beta': 'task-beta',
        'proj-alpha': 'task-alpha',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// selectActiveSession - no-op guard (same taskId already stored)
// ---------------------------------------------------------------------------

describe('selectActiveSession - no-op guard', () => {
  beforeEach(() => {
    configSetSpy.mockClear();
    resetStores({ currentProjectId: 'proj-alpha' });
  });

  it('does NOT call config.set when the same taskId is already stored for the project', () => {
    // Pre-seed: proj-alpha already remembers task-1
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: { 'proj-alpha': 'task-1' },
      },
      globalConfig: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: { 'proj-alpha': 'task-1' },
      },
    });

    const session = makeSession({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-alpha' });
    useSessionStore.setState({
      sessions: [session],
      _sessionByTaskId: buildSessionByTaskId([session]),
    });

    useSessionStore.getState().selectActiveSession('sess-1');

    // activeSessionId should still be updated
    expect(useSessionStore.getState().activeSessionId).toBe('sess-1');
    // But config.set must not be called (no change in stored value)
    expect(configSetSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// selectActiveSession - skip cases (no config.set)
// ---------------------------------------------------------------------------

describe('selectActiveSession - skip cases', () => {
  beforeEach(() => {
    configSetSpy.mockClear();
    resetStores({ currentProjectId: 'proj-alpha' });
  });

  it('sets activeSessionId to null but does NOT persist when id is null', () => {
    useSessionStore.setState({ activeSessionId: 'sess-prev' });

    useSessionStore.getState().selectActiveSession(null);

    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(configSetSpy).not.toHaveBeenCalled();
  });

  it('sets activeSessionId to ACTIVITY_TAB but does NOT persist it', () => {
    useSessionStore.getState().selectActiveSession(ACTIVITY_TAB);

    expect(useSessionStore.getState().activeSessionId).toBe(ACTIVITY_TAB);
    expect(configSetSpy).not.toHaveBeenCalled();
  });

  it('does NOT persist when the session is transient', () => {
    const transientSession = makeSession({
      id: 'sess-transient',
      taskId: 'task-transient',
      projectId: 'proj-alpha',
      transient: true,
    });
    useSessionStore.setState({
      sessions: [transientSession],
      _sessionByTaskId: buildSessionByTaskId([transientSession]),
    });

    useSessionStore.getState().selectActiveSession('sess-transient');

    expect(useSessionStore.getState().activeSessionId).toBe('sess-transient');
    expect(configSetSpy).not.toHaveBeenCalled();
  });

  it('does NOT persist when the session belongs to a different project', () => {
    // currentProject is proj-alpha but the session is from proj-beta
    const otherProjectSession = makeSession({
      id: 'sess-beta',
      taskId: 'task-beta',
      projectId: 'proj-beta',
    });
    useSessionStore.setState({
      sessions: [otherProjectSession],
      _sessionByTaskId: buildSessionByTaskId([otherProjectSession]),
    });

    useSessionStore.getState().selectActiveSession('sess-beta');

    expect(useSessionStore.getState().activeSessionId).toBe('sess-beta');
    expect(configSetSpy).not.toHaveBeenCalled();
  });

  it('does NOT persist when no currentProject is set', () => {
    // Reset so currentProject is null
    resetStores(); // no currentProjectId passed

    const session = makeSession({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-alpha' });
    useSessionStore.setState({
      sessions: [session],
      _sessionByTaskId: buildSessionByTaskId([session]),
    });

    useSessionStore.getState().selectActiveSession('sess-1');

    expect(configSetSpy).not.toHaveBeenCalled();
  });

  it('does NOT persist when the session ID is not found in the store', () => {
    // Empty sessions list; 'sess-unknown' does not exist
    useSessionStore.setState({
      sessions: [],
      _sessionByTaskId: new Map(),
    });

    useSessionStore.getState().selectActiveSession('sess-unknown');

    expect(configSetSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteProject cleanup - lastActiveTaskByProject
// ---------------------------------------------------------------------------

describe('deleteProject - lastActiveTaskByProject cleanup', () => {
  beforeEach(() => {
    configSetSpy.mockClear();
    // Reset projectStore with a couple of projects present
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-alpha',
          name: 'Alpha',
          path: '/mock/alpha',
          github_url: null,
          default_agent: 'claude',
          group_id: null,
          position: 0,
          last_opened: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
        {
          id: 'proj-beta',
          name: 'Beta',
          path: '/mock/beta',
          github_url: null,
          default_agent: 'claude',
          group_id: null,
          position: 1,
          last_opened: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ],
      groups: [],
      currentProject: null,
      loading: false,
      hydrated: true,
    });
    useSessionStore.setState({
      sessions: [],
      _sessionByTaskId: new Map(),
    });
    // Pre-seed both projects with a remembered task
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: {
          'proj-alpha': 'task-alpha',
          'proj-beta': 'task-beta',
        },
      },
      globalConfig: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: {
          'proj-alpha': 'task-alpha',
          'proj-beta': 'task-beta',
        },
      },
    });
  });

  it('removes the deleted project entry from config and globalConfig in the store', async () => {
    await useProjectStore.getState().deleteProject('proj-alpha');

    const configState = useConfigStore.getState();
    expect(configState.config.lastActiveTaskByProject).not.toHaveProperty('proj-alpha');
    expect(configState.config.lastActiveTaskByProject).toHaveProperty('proj-beta', 'task-beta');
    expect(configState.globalConfig.lastActiveTaskByProject).not.toHaveProperty('proj-alpha');
  });

  it('fires window.electronAPI.config.set with the remaining map after deletion', async () => {
    await useProjectStore.getState().deleteProject('proj-alpha');

    expect(configSetSpy).toHaveBeenCalledWith({
      lastActiveTaskByProject: { 'proj-beta': 'task-beta' },
    });
  });

  it('does NOT call config.set when the deleted project had no entry', async () => {
    // Remove proj-alpha from the remembered map so only proj-beta remains,
    // then delete proj-beta's sibling (proj-alpha) which has no entry.
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: { 'proj-beta': 'task-beta' },
      },
      globalConfig: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: { 'proj-beta': 'task-beta' },
      },
    });

    // Deleting proj-alpha which is NOT in the map
    await useProjectStore.getState().deleteProject('proj-alpha');

    // config.set must not have been called for the missing entry
    expect(configSetSpy).not.toHaveBeenCalled();
  });

  it('results in an empty map when the sole remembered entry is deleted', async () => {
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: { 'proj-alpha': 'task-alpha' },
      },
      globalConfig: {
        ...DEFAULT_CONFIG,
        lastActiveTaskByProject: { 'proj-alpha': 'task-alpha' },
      },
    });

    await useProjectStore.getState().deleteProject('proj-alpha');

    expect(configSetSpy).toHaveBeenCalledWith({
      lastActiveTaskByProject: {},
    });
    expect(useConfigStore.getState().config.lastActiveTaskByProject).toEqual({});
  });
});
