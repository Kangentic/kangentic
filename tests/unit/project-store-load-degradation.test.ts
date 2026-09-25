/**
 * Unit tests for project-store's load path when the IPC read fails.
 *
 * `loadProjects` sets `loading: true` and then awaited the invoke with no catch,
 * so a rejection left `loading` stuck at true and `hydrated` at false forever.
 * App.tsx's `Promise.all([configLoaded, projectsLoaded]).then(...)` has no catch
 * either, so `hydrateView` never ran. The user's evidence of a disk I/O error on
 * index.db was a permanent loading spinner (Sentry DESKTOP-A/B).
 *
 * `loadGroups` is worse in one respect: App.tsx calls it as a fully floating
 * promise, so a rejection there was an unhandled rejection with no owner at all.
 *
 * The main process now degrades both reads rather than rejecting (see
 * src/main/db/soft-db.ts and project-list-degradation.test.ts), so these are
 * defence in depth. They are still worth pinning: the store must reach a
 * rendered state on ANY failure, not only on the one class the main side
 * happens to soften today.
 *
 * The stub cannot be written against a real app: contextBridge exposes
 * `window.electronAPI` non-configurable and non-writable, and freezes each
 * sub-object, so this behaviour is unreachable from a devtools eval and belongs
 * here. Stub shape follows archived-tasks-slice.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

vi.mock('../../src/renderer/stores/session-lifecycle-hooks', () => ({
  killTransientSessionForProject: vi.fn(),
  markIdleSessionsSeen: vi.fn(),
}));
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: { getState: () => ({ loadConfig: vi.fn() }) },
}));
vi.mock('../../src/renderer/stores/project-cache', () => ({
  dropProject: vi.fn(),
}));

const projectsApi = { list: vi.fn(), getCurrent: vi.fn() };
const projectGroupsApi = { list: vi.fn() };

(globalThis as Record<string, unknown>).window = {
  electronAPI: { projects: projectsApi, projectGroups: projectGroupsApi },
};

import { useProjectStore } from '../../src/renderer/stores/project-store';

const DISK_IO = new Error("Error invoking remote method 'project:list': SqliteError: disk I/O error");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  projectsApi.list.mockReset();
  projectsApi.getCurrent.mockReset();
  projectGroupsApi.list.mockReset();
  useProjectStore.setState({ projects: [], groups: [], currentProject: null, loading: false, hydrated: false });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Without the restore the spies stack and the outer one keeps the previous
  // test's calls, which turns "did not log" into a false failure.
  errorSpy.mockRestore();
});

afterAll(() => {
  // Symmetric with the module-scope assignment above. Vitest's per-file
  // isolation contains the leak today, but a `window` global left standing is
  // the kind of setup that only bites once someone changes the pool config.
  delete (globalThis as Record<string, unknown>).window;
});

describe('loadProjects when the read fails', () => {
  it('does not strand the app on its loading spinner', async () => {
    projectsApi.list.mockRejectedValue(DISK_IO);

    await expect(
      useProjectStore.getState().loadProjects(),
      'a rejection must not escape: App.tsx calls this inside an uncatched Promise.all, so a throw also skips hydrateView',
    ).resolves.toBeUndefined();

    const state = useProjectStore.getState();
    expect(
      state.loading,
      'loading stuck at true is what the user actually saw: a spinner that never resolves, with no hint that the database was the problem',
    ).toBe(false);
    expect(state.projects).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('still flips hydrated so the view can render', async () => {
    projectsApi.list.mockRejectedValue(DISK_IO);
    projectsApi.getCurrent.mockResolvedValue(null);

    await useProjectStore.getState().loadProjects();
    await useProjectStore.getState().loadCurrent();

    expect(
      useProjectStore.getState().hydrated,
      'both gates have to close for hydrated to flip; a failed projects read must still count as settled or the app never leaves its boot state',
    ).toBe(true);
  });

  it('keeps working normally when the read succeeds', async () => {
    const projects = [{ id: 'project-1', name: 'One' }];
    projectsApi.list.mockResolvedValue(projects);

    await useProjectStore.getState().loadProjects();

    expect(useProjectStore.getState().projects).toBe(projects);
    expect(useProjectStore.getState().loading).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('loadGroups when the read fails', () => {
  it('swallows the rejection it has no owner for', async () => {
    // App.tsx calls loadGroups() as a floating promise, so a rejection here is
    // an unhandled rejection rather than a failure anyone reports.
    projectGroupsApi.list.mockRejectedValue(DISK_IO);

    await expect(useProjectStore.getState().loadGroups()).resolves.toBeUndefined();
    expect(
      useProjectStore.getState().groups,
      'no groups renders a flat project list, which is a working app',
    ).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('keeps working normally when the read succeeds', async () => {
    const groups = [{ id: 'group-1', name: 'Group' }];
    projectGroupsApi.list.mockResolvedValue(groups);

    await useProjectStore.getState().loadGroups();

    expect(useProjectStore.getState().groups).toBe(groups);
  });
});

describe('loadCurrent when the read fails', () => {
  it('does not strand the app on its loading spinner', async () => {
    projectsApi.getCurrent.mockRejectedValue(DISK_IO);

    await expect(
      useProjectStore.getState().loadCurrent(),
      'a rejection must not escape: App.tsx calls this as a floating promise too, so a throw would be an unhandled rejection with no owner',
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });

  it('clears currentProject to null after the failure', async () => {
    // Seed a stale selection first so the assertion below pins the DEGRADE,
    // not just an initial value that was already null.
    useProjectStore.setState({ currentProject: { id: 'stale-project', name: 'Stale' } });
    projectsApi.getCurrent.mockRejectedValue(DISK_IO);

    await useProjectStore.getState().loadCurrent();

    expect(
      useProjectStore.getState().currentProject,
      'degrading to no current project is what opens the project picker instead of leaving a stale one selected',
    ).toBe(null);
  });

  it('still flips hydrated once both reads have settled, even when both reject', async () => {
    projectsApi.list.mockRejectedValue(DISK_IO);
    projectsApi.getCurrent.mockRejectedValue(DISK_IO);

    await useProjectStore.getState().loadProjects();
    await useProjectStore.getState().loadCurrent();

    expect(
      useProjectStore.getState().hydrated,
      'both gates have to close for hydrated to flip; a failed current-project read must still count as settled or the app never leaves its boot state',
    ).toBe(true);
  });

  it('keeps working normally when the read succeeds', async () => {
    const project = { id: 'project-1', name: 'One' };
    projectsApi.getCurrent.mockResolvedValue(project);

    await useProjectStore.getState().loadCurrent();

    expect(useProjectStore.getState().currentProject).toBe(project);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
