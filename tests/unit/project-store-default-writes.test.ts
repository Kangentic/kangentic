/**
 * Unit tests for project-store's project-row default writes and the relocate
 * re-key of the Settings panel.
 *
 * Settings > Agent wrote the defaults through raw IPC and refreshed only
 * `currentProject`. `projects[]` kept the old row, and `openProject` copies its
 * row from that list, so after a switch away and back the old model showed in
 * Settings, the New Task placeholder and the board manager while spawns used the
 * saved one. The store actions apply main's returned row to BOTH copies.
 *
 * The Settings panel now resolves its project by path with no fallback, so a
 * relocate must re-key `projectSettingsPath` in the same update that moves the
 * row, or the panel targets nothing until the re-open finishes.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Project } from '../../src/shared/types';

vi.mock('../../src/renderer/stores/session-lifecycle-hooks', () => ({
  killTransientSessionForProject: vi.fn(),
  markIdleSessionsSeen: vi.fn(),
}));

const configState: {
  projectSettingsPath: string | null;
  projectSettingsProjectName: string | null;
  projectSettingsInitialTab: string | null;
} = {
  projectSettingsPath: null,
  projectSettingsProjectName: null,
  projectSettingsInitialTab: null,
};
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: {
    getState: () => configState,
    setState: (partial: Partial<typeof configState>) => Object.assign(configState, partial),
  },
}));
vi.mock('../../src/renderer/stores/project-cache', () => ({
  dropProject: vi.fn(),
}));

const projectsApi = {
  setDefaultAgent: vi.fn(),
  setDefaultModel: vi.fn(),
  setDefaultEffort: vi.fn(),
  relocate: vi.fn(),
  open: vi.fn(),
};

(globalThis as Record<string, unknown>).window = {
  electronAPI: { projects: projectsApi },
};

import { useProjectStore } from '../../src/renderer/stores/project-store';

function makeProject(id: string, projectPath: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    path: projectPath,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-10-03T00:00:00.000Z',
    created_at: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

const alpha = makeProject('alpha', '/mock/alpha', { default_model: 'opus', default_effort: 'high' });
const beta = makeProject('beta', '/mock/beta', { default_model: 'sonnet', default_effort: 'low' });

beforeEach(() => {
  for (const mock of Object.values(projectsApi)) mock.mockReset();
  useProjectStore.setState({ projects: [alpha, beta], currentProject: alpha, missingPathProject: null });
  configState.projectSettingsPath = null;
  configState.projectSettingsProjectName = null;
  configState.projectSettingsInitialTab = null;
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('project-row default writes', () => {
  it('applies a write to the open project to both the list row and currentProject', async () => {
    const saved = { ...alpha, default_model: 'haiku' };
    projectsApi.setDefaultModel.mockResolvedValue(saved);

    await useProjectStore.getState().setDefaultModel(alpha.id, 'haiku');

    expect(projectsApi.setDefaultModel).toHaveBeenCalledWith(alpha.id, 'haiku');
    const state = useProjectStore.getState();
    expect(
      state.projects.find((project) => project.id === alpha.id)?.default_model,
      'openProject copies its row from this list, so a stale list brings the old model back on the next switch',
    ).toBe('haiku');
    expect(state.currentProject?.default_model).toBe('haiku');
  });

  it('updates a non-current project row without touching currentProject', async () => {
    projectsApi.setDefaultEffort.mockResolvedValue({ ...beta, default_effort: 'max' });

    await useProjectStore.getState().setDefaultEffort(beta.id, 'max');

    const state = useProjectStore.getState();
    expect(state.projects.find((project) => project.id === beta.id)?.default_effort).toBe('max');
    expect(state.currentProject, 'the board project is a different project and must keep its own row').toBe(alpha);
  });

  it('writes the agent through the same path', async () => {
    projectsApi.setDefaultAgent.mockResolvedValue({ ...beta, default_agent: 'kimi' });

    await useProjectStore.getState().setDefaultAgent(beta.id, 'kimi');

    expect(projectsApi.setDefaultAgent).toHaveBeenCalledWith(beta.id, 'kimi');
    expect(useProjectStore.getState().projects.find((project) => project.id === beta.id)?.default_agent).toBe('kimi');
  });

  it('never inserts a row the list does not already hold', async () => {
    const stranger = makeProject('stranger', '/mock/stranger', { default_model: 'opus' });
    projectsApi.setDefaultModel.mockResolvedValue(stranger);

    await useProjectStore.getState().setDefaultModel(stranger.id, 'opus');

    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual([alpha.id, beta.id]);
  });

  it('leaves the state untouched when main returns no row for a deleted id', async () => {
    projectsApi.setDefaultModel.mockResolvedValue(undefined);
    const before = useProjectStore.getState();

    await useProjectStore.getState().setDefaultModel('deleted', 'opus');

    expect(useProjectStore.getState().projects).toBe(before.projects);
    expect(useProjectStore.getState().currentProject).toBe(before.currentProject);
  });
});

describe('relocate re-keys the Settings panel target', () => {
  it('moves projectSettingsPath to the new path in the same update as the row', async () => {
    const moved = { ...beta, path: '/mock/elsewhere/beta' };
    projectsApi.relocate.mockResolvedValue({ project: moved, warnings: [] });
    configState.projectSettingsPath = beta.path;
    configState.projectSettingsProjectName = beta.name;

    await useProjectStore.getState().relocateProject(beta.id, moved.path);

    expect(
      configState.projectSettingsPath,
      'the panel resolves its project by path with no fallback; the old path would match no row',
    ).toBe(moved.path);
  });

  it('leaves a panel targeting a different project alone', async () => {
    projectsApi.relocate.mockResolvedValue({ project: { ...beta, path: '/mock/elsewhere/beta' }, warnings: [] });
    configState.projectSettingsPath = alpha.path;

    await useProjectStore.getState().relocateProject(beta.id, '/mock/elsewhere/beta');

    expect(configState.projectSettingsPath).toBe(alpha.path);
  });

  it('clears a stale initial tab in the same update, so the panel is not moved off the tab the user relocated from', async () => {
    const moved = { ...beta, path: '/mock/elsewhere/beta' };
    projectsApi.relocate.mockResolvedValue({ project: moved, warnings: [] });
    configState.projectSettingsPath = beta.path;
    configState.projectSettingsProjectName = beta.name;
    // Left by an earlier open (the New Task pencil opens with 'agent').
    configState.projectSettingsInitialTab = 'agent';

    await useProjectStore.getState().relocateProject(beta.id, moved.path);

    expect(configState.projectSettingsPath).toBe(moved.path);
    expect(
      configState.projectSettingsInitialTab,
      'SettingsPanel applies the initial tab on any path change, so a stale one would move the panel off General',
    ).toBeNull();
  });

  it('re-keys the project name along with the path', async () => {
    const moved = { ...beta, name: 'Beta Renamed', path: '/mock/elsewhere/beta' };
    projectsApi.relocate.mockResolvedValue({ project: moved, warnings: [] });
    configState.projectSettingsPath = beta.path;
    configState.projectSettingsProjectName = beta.name;

    await useProjectStore.getState().relocateProject(beta.id, moved.path);

    expect(configState.projectSettingsProjectName).toBe('Beta Renamed');
  });

  it('does not re-key a panel that targets no project', async () => {
    const moved = { ...beta, path: '/mock/elsewhere/beta' };
    projectsApi.relocate.mockResolvedValue({ project: moved, warnings: [] });
    configState.projectSettingsInitialTab = 'agent';

    await useProjectStore.getState().relocateProject(beta.id, moved.path);

    expect(configState.projectSettingsPath).toBeNull();
    expect(configState.projectSettingsProjectName).toBeNull();
    expect(configState.projectSettingsInitialTab).toBe('agent');
  });

  it('does not re-key an untargeted panel when the relocated id is not in the project list', async () => {
    // The store reads the previous path from its own list, so an unknown id has
    // none. A bare equality test would read null === null and re-key a panel
    // that targets nothing onto the ghost's new path.
    const ghost = makeProject('ghost', '/mock/elsewhere/ghost');
    projectsApi.relocate.mockResolvedValue({ project: ghost, warnings: [] });

    await useProjectStore.getState().relocateProject(ghost.id, ghost.path);

    expect(configState.projectSettingsPath).toBeNull();
    expect(configState.projectSettingsProjectName).toBeNull();
    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual([alpha.id, beta.id]);
  });

  it('leaves a panel pointed at an unrelated path alone when the relocated id is not in the project list', async () => {
    const ghost = makeProject('ghost', '/mock/elsewhere/ghost');
    projectsApi.relocate.mockResolvedValue({ project: ghost, warnings: [] });
    configState.projectSettingsPath = alpha.path;
    configState.projectSettingsProjectName = alpha.name;
    configState.projectSettingsInitialTab = 'agent';

    await useProjectStore.getState().relocateProject(ghost.id, ghost.path);

    expect(configState.projectSettingsPath).toBe(alpha.path);
    expect(configState.projectSettingsProjectName).toBe(alpha.name);
    expect(configState.projectSettingsInitialTab).toBe('agent');
  });

  it('re-keys the panel when the relocated project is the board project, then re-opens it at the new path', async () => {
    const moved = { ...alpha, path: '/mock/elsewhere/alpha' };
    projectsApi.relocate.mockResolvedValue({ project: moved, warnings: [] });
    projectsApi.open.mockResolvedValue(undefined);
    configState.projectSettingsPath = alpha.path;
    configState.projectSettingsProjectName = alpha.name;

    const result = await useProjectStore.getState().relocateProject(alpha.id, moved.path);

    expect(result.project).toBe(moved);
    expect(configState.projectSettingsPath).toBe(moved.path);
    expect(
      projectsApi.open,
      'a relocated board project is re-opened so main re-attaches its watcher at the new path',
    ).toHaveBeenCalledWith(alpha.id);
    const state = useProjectStore.getState();
    expect(state.currentProject?.path).toBe(moved.path);
    expect(state.projects.find((project) => project.id === alpha.id)?.path).toBe(moved.path);
  });

  it('re-keys the panel before it re-opens the board project, so the panel never targets a path with no row', async () => {
    const moved = { ...alpha, path: '/mock/elsewhere/alpha' };
    projectsApi.relocate.mockResolvedValue({ project: moved, warnings: [] });
    // The re-open is where main re-attaches the watcher and re-runs recovery, and it
    // yields to the renderer. What the panel targets at that moment is what it renders.
    let panelPathWhenReopened: string | null | undefined;
    projectsApi.open.mockImplementation(async () => {
      panelPathWhenReopened = configState.projectSettingsPath;
    });
    configState.projectSettingsPath = alpha.path;
    configState.projectSettingsProjectName = alpha.name;

    await useProjectStore.getState().relocateProject(alpha.id, moved.path);

    expect(projectsApi.open).toHaveBeenCalledWith(alpha.id);
    expect(
      panelPathWhenReopened,
      'the old path matches no row after the swap, so a re-key that waits for the re-open blanks the project tabs in between',
    ).toBe(moved.path);
  });

  it('does not re-open the board project when a different project is relocated', async () => {
    projectsApi.relocate.mockResolvedValue({ project: { ...beta, path: '/mock/elsewhere/beta' }, warnings: [] });

    await useProjectStore.getState().relocateProject(beta.id, '/mock/elsewhere/beta');

    expect(projectsApi.open).not.toHaveBeenCalled();
    expect(useProjectStore.getState().currentProject).toBe(alpha);
  });
});
