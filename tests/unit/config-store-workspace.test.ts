/**
 * Coverage for the config-store `saveWorkspaceForProject` action: the actual
 * persistence write for the in-app window layout. Proves it is decoupled from the
 * Settings panel (no `projectSettingsPath` involved) and that it merges the layout
 * under the project id via `config.set` WITHOUT clobbering other projects' entries -
 * the exact data-loss hazard that ruled out the project-override write path.
 *
 * The store reads `window.electronAPI.config.set` at call time, stubbed here (the
 * unit tier has no jsdom); changing only `workspaceByProject` never trips the store's
 * theme / animations subscriptions, so no DOM access occurs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConfigStore } from '../../src/renderer/stores/config-store';
import { DEFAULT_CONFIG, type SerializedWorkspace } from '../../src/shared/types';

function makeWorkspace(taskId: string): SerializedWorkspace {
  return {
    version: 1,
    windows: [
      { taskId, title: taskId, geometry: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 }, restoreGeometry: null, state: 'floating' },
    ],
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    focusedTaskId: taskId,
  };
}

describe('config-store workspace persistence', () => {
  let configSet: ReturnType<typeof vi.fn>;
  let configSetSync: ReturnType<typeof vi.fn>;
  let configGet: ReturnType<typeof vi.fn>;
  let configGetGlobal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configSet = vi.fn();
    configSetSync = vi.fn();
    configGet = vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG });
    configGetGlobal = vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG });
    vi.stubGlobal('window', {
      electronAPI: {
        config: { set: configSet, setSync: configSetSync, get: configGet, getGlobal: configGetGlobal },
      },
    });
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG },
      globalConfig: { ...DEFAULT_CONFIG },
      workspaceSeeded: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges the layout under the project id without clobbering other projects, writing via config.set', () => {
    const layoutA = makeWorkspace('task-a');
    const layoutB = makeWorkspace('task-b');
    // Seed an existing entry for another project.
    useConfigStore.setState((state) => ({
      config: { ...state.config, workspaceByProject: { 'proj-b': layoutB } },
      globalConfig: { ...state.globalConfig, workspaceByProject: { 'proj-b': layoutB } },
    }));

    useConfigStore.getState().saveWorkspaceForProject('proj-a', layoutA);

    const map = useConfigStore.getState().config.workspaceByProject;
    expect(map['proj-a']).toBe(layoutA);
    expect(map['proj-b']).toBe(layoutB); // untouched: no clobber
    expect(configSet).toHaveBeenCalledTimes(1);
    expect(configSet).toHaveBeenCalledWith({ workspaceByProject: { 'proj-b': layoutB, 'proj-a': layoutA } });
  });

  it('updates both the effective and global config optimistically', () => {
    const layoutA = makeWorkspace('task-a');
    useConfigStore.getState().saveWorkspaceForProject('proj-a', layoutA);
    expect(useConfigStore.getState().config.workspaceByProject['proj-a']).toBe(layoutA);
    expect(useConfigStore.getState().globalConfig.workspaceByProject['proj-a']).toBe(layoutA);
  });

  it('flushWorkspaceForProject persists synchronously via config.setSync with the merged map', () => {
    const layoutA = makeWorkspace('task-a');
    useConfigStore.getState().flushWorkspaceForProject('proj-a', layoutA);
    expect(configSetSync).toHaveBeenCalledTimes(1);
    expect(configSetSync).toHaveBeenCalledWith({ workspaceByProject: { 'proj-a': layoutA } });
    // Same optimistic update as the async save, but through the blocking sync write.
    expect(useConfigStore.getState().config.workspaceByProject['proj-a']).toBe(layoutA);
    expect(useConfigStore.getState().globalConfig.workspaceByProject['proj-a']).toBe(layoutA);
    expect(configSet).not.toHaveBeenCalled();
  });

  it('seeds workspaceByProject from disk on the first config fetch', async () => {
    const layoutA = makeWorkspace('task-a');
    const diskConfig = { ...DEFAULT_CONFIG, workspaceByProject: { 'proj-a': layoutA } };
    configGet.mockResolvedValue(diskConfig);
    configGetGlobal.mockResolvedValue(diskConfig);
    await useConfigStore.getState().loadConfig();
    expect(useConfigStore.getState().config.workspaceByProject['proj-a']).toEqual(layoutA);
    expect(useConfigStore.getState().workspaceSeeded).toBe(true);
  });

  it('does not let a later config fetch clobber an in-flight optimistic save (renderer is authoritative)', async () => {
    const layoutA = makeWorkspace('task-a');
    // First load seeds workspaceByProject from disk (empty here).
    await useConfigStore.getState().loadConfig();
    expect(useConfigStore.getState().workspaceSeeded).toBe(true);
    // User saves a layout: the store updates optimistically, but the async persist has not
    // yet reached our stale disk stub (still empty).
    useConfigStore.getState().saveWorkspaceForProject('proj-a', layoutA);
    expect(useConfigStore.getState().config.workspaceByProject['proj-a']).toBe(layoutA);
    // A second fetch resolves with the STALE disk (no proj-a). It must NOT revert the store.
    await useConfigStore.getState().loadConfig();
    expect(useConfigStore.getState().config.workspaceByProject['proj-a']).toBe(layoutA);
    expect(useConfigStore.getState().globalConfig.workspaceByProject['proj-a']).toBe(layoutA);
  });
});
