/**
 * The collapsed-columns setting in the renderer stores (`collapsedColumnsByProject`).
 *
 * `collapsedColumnsByProject` is a dictionary path in main's config manager, so
 * a `config.set` REPLACES the whole map. What a user loses if this goes: a
 * column that comes back collapsed after being expanded, another project's
 * collapsed columns wiped by a write for this one, or a deleted project's
 * entry kept on disk for good.
 *
 * The stores read `window.electronAPI` at call time, stubbed here (the unit
 * tier has no jsdom).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConfigStore } from '../../src/renderer/stores/config-store';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { DEFAULT_CONFIG } from '../../src/shared/types';

let configSet: ReturnType<typeof vi.fn>;

function seedCollapsed(collapsedColumnsByProject: Record<string, string[]>): void {
  useConfigStore.setState({
    config: { ...DEFAULT_CONFIG, collapsedColumnsByProject },
    globalConfig: { ...DEFAULT_CONFIG, collapsedColumnsByProject },
  });
}

beforeEach(() => {
  configSet = vi.fn();
  vi.stubGlobal('window', {
    electronAPI: {
      config: { set: configSet, setSync: vi.fn(), get: vi.fn(), getGlobal: vi.fn() },
      projects: { delete: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('config-store setColumnCollapsed', () => {
  it('adds the column to that project\'s list in both configs and sends the whole map', () => {
    seedCollapsed({ 'project-b': ['lane-9'] });

    useConfigStore.getState().setColumnCollapsed('project-a', 'lane-1', true);

    const expected = { 'project-a': ['lane-1'], 'project-b': ['lane-9'] };
    expect(useConfigStore.getState().config.collapsedColumnsByProject).toEqual(expected);
    expect(useConfigStore.getState().globalConfig.collapsedColumnsByProject).toEqual(expected);
    expect(configSet).toHaveBeenCalledTimes(1);
    // The write replaces the map, so the other project's list must be in it.
    expect(configSet).toHaveBeenCalledWith({ collapsedColumnsByProject: expected });
  });

  it('writes nothing when the column is already in the asked state', () => {
    seedCollapsed({ 'project-a': ['lane-1'] });

    useConfigStore.getState().setColumnCollapsed('project-a', 'lane-1', true);
    useConfigStore.getState().setColumnCollapsed('project-a', 'lane-2', false);

    expect(configSet).not.toHaveBeenCalled();
    expect(useConfigStore.getState().globalConfig.collapsedColumnsByProject).toEqual({ 'project-a': ['lane-1'] });
  });

  it('removes the project\'s key when its last collapsed column is expanded', () => {
    seedCollapsed({ 'project-a': ['lane-1'], 'project-b': ['lane-9'] });

    useConfigStore.getState().setColumnCollapsed('project-a', 'lane-1', false);

    const expected = { 'project-b': ['lane-9'] };
    expect(useConfigStore.getState().globalConfig.collapsedColumnsByProject).toEqual(expected);
    expect(useConfigStore.getState().config.collapsedColumnsByProject).toEqual(expected);
    expect(configSet).toHaveBeenCalledWith({ collapsedColumnsByProject: expected });
    expect(Object.keys(configSet.mock.calls[0][0].collapsedColumnsByProject)).not.toContain('project-a');
  });

  it('keeps the other collapsed columns when one of several is expanded', () => {
    seedCollapsed({ 'project-a': ['lane-1', 'lane-2'] });

    useConfigStore.getState().setColumnCollapsed('project-a', 'lane-1', false);

    expect(configSet).toHaveBeenCalledWith({ collapsedColumnsByProject: { 'project-a': ['lane-2'] } });
  });
});

describe('project-store deleteProject and collapsed columns', () => {
  it('drops the deleted project\'s collapsed columns and sends the map without them', async () => {
    seedCollapsed({ 'project-a': ['lane-1'], 'project-b': ['lane-9'] });

    await useProjectStore.getState().deleteProject('project-a');

    const expected = { 'project-b': ['lane-9'] };
    expect(useConfigStore.getState().config.collapsedColumnsByProject).toEqual(expected);
    expect(useConfigStore.getState().globalConfig.collapsedColumnsByProject).toEqual(expected);
    expect(configSet).toHaveBeenCalledWith({ collapsedColumnsByProject: expected });
  });

  it('writes no collapsed-columns config when the deleted project had none', async () => {
    seedCollapsed({ 'project-b': ['lane-9'] });

    await useProjectStore.getState().deleteProject('project-a');

    const wroteCollapsed = configSet.mock.calls.some((call) => 'collapsedColumnsByProject' in call[0]);
    expect(wroteCollapsed).toBe(false);
    expect(useConfigStore.getState().globalConfig.collapsedColumnsByProject).toEqual({ 'project-b': ['lane-9'] });
  });
});
