/**
 * project-store `settleOpenProject` and `deleteProject` (#913). When the open project is taken away (a
 * delete, an SSH host's removal or Clear data) the most recently opened project left opens in its place,
 * and the removed one stays current until then. What a user loses if it breaks: the app drops to the
 * app-wide theme for a frame (or for good), or lands on a project they never touched, or stays on a board
 * whose project is gone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../../src/shared/types';

vi.mock('../../src/renderer/stores/session-lifecycle-hooks', () => ({
  killTransientSessionForProject: vi.fn(),
  markIdleSessionsSeen: vi.fn(),
}));
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: {
    getState: () => ({ config: {}, globalConfig: {} }),
    setState: vi.fn(),
  },
}));
vi.mock('../../src/renderer/stores/project-cache', () => ({
  dropProject: vi.fn(),
}));

(globalThis as Record<string, unknown>).window = {
  electronAPI: { projects: { delete: vi.fn(async () => undefined) } },
};

import { useProjectStore, type OpenProjectOutcome } from '../../src/renderer/stores/project-store';

function makeProject(id: string, lastOpened: string): Project {
  return { id, name: id, path: `/mock/${id}`, last_opened: lastOpened } as Project;
}

const gone = makeProject('gone', '2026-11-07T00:00:00.000Z');
const recent = makeProject('recent', '2026-11-05T00:00:00.000Z');
const old = makeProject('old', '2026-09-01T00:00:00.000Z');

const openProject = vi.fn<(id: string) => Promise<OpenProjectOutcome>>();
const loadCurrent = vi.fn<() => Promise<void>>();

beforeEach(() => {
  openProject.mockReset();
  loadCurrent.mockReset();
  openProject.mockResolvedValue('opened');
  loadCurrent.mockResolvedValue(undefined);
  useProjectStore.setState({ projects: [], currentProject: null, openProject, loadCurrent });
});

describe('settleOpenProject', () => {
  it('leaves a current project that is still listed alone', async () => {
    useProjectStore.setState({ projects: [gone, recent], currentProject: gone });
    await useProjectStore.getState().settleOpenProject();
    expect(openProject).not.toHaveBeenCalled();
    expect(loadCurrent).not.toHaveBeenCalled();
  });

  it('does nothing when no project is open', async () => {
    useProjectStore.setState({ projects: [recent], currentProject: null });
    await useProjectStore.getState().settleOpenProject();
    expect(openProject).not.toHaveBeenCalled();
    expect(loadCurrent).not.toHaveBeenCalled();
  });

  it('opens the most recently opened project left when the current one is gone, and stops once it opened', async () => {
    useProjectStore.setState({ projects: [old, recent], currentProject: gone });
    await useProjectStore.getState().settleOpenProject();
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(openProject).toHaveBeenCalledWith('recent');
    expect(loadCurrent).not.toHaveBeenCalled();
  });

  it.each<OpenProjectOutcome>(['missing-path', 'not-found', 'failed'])(
    'asks main for the current project when the next one answers %s',
    async (outcome) => {
      openProject.mockResolvedValue(outcome);
      useProjectStore.setState({ projects: [recent], currentProject: gone });
      await useProjectStore.getState().settleOpenProject();
      expect(openProject).toHaveBeenCalledWith('recent');
      expect(loadCurrent).toHaveBeenCalledTimes(1);
    },
  );

  it('asks main for the current project, opening nothing, when no project is left', async () => {
    useProjectStore.setState({ projects: [], currentProject: gone });
    await useProjectStore.getState().settleOpenProject();
    expect(openProject).not.toHaveBeenCalled();
    expect(loadCurrent).toHaveBeenCalledTimes(1);
  });
});

describe('deleteProject', () => {
  it('keeps the deleted project current until the next one opens, so the theme never jumps', async () => {
    const currentWhenOpening: Array<string | null> = [];
    openProject.mockImplementation(async () => {
      currentWhenOpening.push(useProjectStore.getState().currentProject?.id ?? null);
      return 'opened';
    });
    useProjectStore.setState({ projects: [gone, recent], currentProject: gone });

    await useProjectStore.getState().deleteProject('gone');

    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual(['recent']);
    expect(openProject).toHaveBeenCalledWith('recent');
    expect(currentWhenOpening).toEqual(['gone']);
  });

  it('does not open another project when a project other than the open one is deleted', async () => {
    useProjectStore.setState({ projects: [gone, recent], currentProject: recent });
    await useProjectStore.getState().deleteProject('gone');
    expect(openProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().currentProject?.id).toBe('recent');
  });
});
