/**
 * Unit tests for `openProject`'s outcome contract.
 *
 * Sentry DESKTOP-V: a renderer whose project list outlived the row behind it
 * (a global-DB recovery that reopened onto a different file, or a dev-only
 * boot prune) clicked a stale sidebar row. `PROJECT_OPEN` threw a bare,
 * un-sentinelled `Project <id> not found`, and `openProject` re-threw it into
 * an unawaited click handler: an unhandled rejection with nothing on screen.
 *
 * `openProject` now never throws. Every failure is reported through the
 * store itself (a toast, or `missingPathProject` for the "Locate Folder..."
 * dialog) and reflected back to the caller as an `OpenProjectOutcome`, since
 * two callers act on whether the switch actually landed
 * (`board-config-slice.ts`'s `applyConfigChange`, and
 * `ProjectPathMissingDialog`'s success toast).
 *
 * Every fake IPC error below is wrapped the way Electron actually wraps a
 * rejected `ipcRenderer.invoke`: `Error invoking remote method '<channel>':
 * Error: <message>`. The sentinel match is `.includes()`, not `instanceof` or
 * `===`, precisely because of that wrapping - an unwrapped bare `Error` would
 * pass a broken match that never fires in production.
 *
 * Harness follows project-store-load-degradation.test.ts: contextBridge
 * exposes `window.electronAPI` non-configurable and frozen, so this behavior
 * is unreachable from a devtools eval and belongs in a stubbed unit test.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { PROJECT_PATH_MISSING_PREFIX, PROJECT_NOT_FOUND_PREFIX } from '../../src/shared/ipc-channels';

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

const addToastSpy = vi.fn();
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: addToastSpy }) },
}));

const projectsApi = {
  open: vi.fn(),
  list: vi.fn(),
  getCurrent: vi.fn(),
  openByPath: vi.fn(),
};

(globalThis as Record<string, unknown>).window = {
  electronAPI: { projects: projectsApi },
};

import { useProjectStore } from '../../src/renderer/stores/project-store';

/** Electron's real wrapping shape for a rejected `ipcRenderer.invoke`. */
function wrapped(message: string): Error {
  return new Error(`Error invoking remote method 'project:open': Error: ${message}`);
}

const PROJECT_A = { id: 'project-a', name: 'Alpha', path: '/mock/alpha' };
const PROJECT_B = { id: 'project-b', name: 'Beta', path: '/mock/beta' };

beforeEach(() => {
  projectsApi.open.mockReset();
  projectsApi.list.mockReset();
  projectsApi.getCurrent.mockReset();
  projectsApi.openByPath.mockReset();
  addToastSpy.mockReset();
  useProjectStore.setState({
    projects: [PROJECT_A, PROJECT_B],
    currentProject: null,
    missingPathProject: null,
    loading: false,
    hydrated: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('openProject: success', () => {
  it('resolves "opened" and sets currentProject', async () => {
    projectsApi.open.mockResolvedValue(undefined);

    const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

    expect(outcome).toBe('opened');
    expect(useProjectStore.getState().currentProject).toBe(PROJECT_B);
    expect(addToastSpy).not.toHaveBeenCalled();
  });

  it('falls back to getCurrent() when the cached list has not caught up', async () => {
    projectsApi.open.mockResolvedValue(undefined);
    const unlisted = { id: 'project-c', name: 'Gamma', path: '/mock/gamma' };
    projectsApi.getCurrent.mockResolvedValue(unlisted);

    const outcome = await useProjectStore.getState().openProject(unlisted.id);

    expect(outcome).toBe('opened');
    expect(projectsApi.getCurrent).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().currentProject).toBe(unlisted);
  });

  it('resolves "failed" instead of throwing when that getCurrent() fallback rejects', async () => {
    // The fallback sits after the try/catch that handles `projects.open`, so it
    // is the one path that could still reject out of a function five call sites
    // now trust never to throw. It is reached only when the cached list misses
    // the id, which is the same staleness DESKTOP-V is about, so the two
    // conditions co-occur rather than being independently unlikely.
    projectsApi.open.mockResolvedValue(undefined);
    projectsApi.getCurrent.mockRejectedValue(wrapped('database is locked'));

    // Resolving rather than rejecting is the load-bearing half: a caller that
    // dropped its try/catch turns a rejection here into an unhandled one.
    const outcome = await useProjectStore.getState().openProject('project-c');

    expect(outcome).toBe('failed');
    expect(addToastSpy).toHaveBeenCalledTimes(1);
    expect(addToastSpy.mock.calls[0][0]).toMatchObject({ variant: 'error' });
    expect(useProjectStore.getState().currentProject).toBeNull();
  });
});

describe('openProject: PROJECT_NOT_FOUND', () => {
  it('refetches the list, toasts, and resolves "not-found" without throwing', async () => {
    projectsApi.open.mockRejectedValue(wrapped(PROJECT_NOT_FOUND_PREFIX + PROJECT_B.id));
    // The refetch drops the dead row, mirroring the production repro where
    // main can no longer resolve it either.
    projectsApi.list.mockResolvedValue([PROJECT_A]);
    projectsApi.getCurrent.mockResolvedValue(PROJECT_A);

    const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

    expect(outcome).toBe('not-found');
    expect(projectsApi.list).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().projects).toEqual([PROJECT_A]);
    expect(addToastSpy).toHaveBeenCalledTimes(1);
    expect(addToastSpy.mock.calls[0][0].variant).toBe('error');
    expect(addToastSpy.mock.calls[0][0].message).toMatch(/no longer available/);
  });

  it('reports a main-side inconsistency instead of "no longer available" when the refetch still lists it', async () => {
    projectsApi.open.mockRejectedValue(wrapped(PROJECT_NOT_FOUND_PREFIX + PROJECT_B.id));
    // The refetch still returns the row - main is now inconsistent with
    // itself, not merely behind the renderer.
    projectsApi.list.mockResolvedValue([PROJECT_A, PROJECT_B]);
    projectsApi.getCurrent.mockResolvedValue(PROJECT_A);

    const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

    expect(outcome).toBe('not-found');
    expect(addToastSpy).toHaveBeenCalledTimes(1);
    const message = addToastSpy.mock.calls[0][0].message as string;
    expect(message).not.toMatch(/no longer available/);
    expect(message).toMatch(/Could not open that project/);
    // The underlying error's message IS the sentinel - a naive
    // describeIpcError(err) interpolation would leak it verbatim.
    expect(message).not.toMatch(PROJECT_NOT_FOUND_PREFIX);
  });
});

describe('openProject: PROJECT_PATH_MISSING', () => {
  it('sets missingPathProject and resolves "missing-path" with no toast', async () => {
    projectsApi.open.mockRejectedValue(wrapped(PROJECT_PATH_MISSING_PREFIX + PROJECT_B.path));

    const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

    expect(outcome).toBe('missing-path');
    expect(useProjectStore.getState().missingPathProject).toBe(PROJECT_B);
    expect(addToastSpy).not.toHaveBeenCalled();
  });

  it('refetches once when the row is not in the local list, and toasts + resolves "failed" (never "not-found") if it is still absent', async () => {
    // The renderer's OWN list is already stale - the row it needs to put in
    // the dialog is gone locally even though main confirmed it exists (it
    // threw path-missing, not not-found).
    useProjectStore.setState({ projects: [PROJECT_A] });
    projectsApi.open.mockRejectedValue(wrapped(PROJECT_PATH_MISSING_PREFIX + PROJECT_B.path));
    projectsApi.list.mockResolvedValue([PROJECT_A]);

    const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

    expect(outcome).toBe('failed');
    expect(projectsApi.list).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().missingPathProject).toBe(null);
    expect(addToastSpy).toHaveBeenCalledTimes(1);
    expect(addToastSpy.mock.calls[0][0].variant).toBe('error');
    // The underlying error's message IS the sentinel - a naive
    // describeIpcError(err) interpolation would leak it verbatim.
    const message = addToastSpy.mock.calls[0][0].message as string;
    expect(message).not.toMatch(PROJECT_PATH_MISSING_PREFIX);
  });

  it('finds the row after a refetch and still shows the dialog', async () => {
    useProjectStore.setState({ projects: [PROJECT_A] });
    projectsApi.open.mockRejectedValue(wrapped(PROJECT_PATH_MISSING_PREFIX + PROJECT_B.path));
    // The refetch catches up with main's view, which does have the row.
    projectsApi.list.mockResolvedValue([PROJECT_A, PROJECT_B]);

    const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

    expect(outcome).toBe('missing-path');
    expect(useProjectStore.getState().missingPathProject).toBe(PROJECT_B);
    expect(addToastSpy).not.toHaveBeenCalled();
  });
});

describe('openProject: unrecognized failure', () => {
  it('toasts the stripped message and resolves "failed" without throwing', async () => {
    projectsApi.open.mockRejectedValue(wrapped('SqliteError: disk I/O error'));

    const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

    expect(outcome).toBe('failed');
    expect(addToastSpy).toHaveBeenCalledTimes(1);
    const message = addToastSpy.mock.calls[0][0].message as string;
    // describeIpcError strips both the "Error invoking remote method '...'"
    // wrapper and the leading error-class prefix.
    expect(message).not.toMatch(/Error invoking remote method/);
    expect(message).toMatch(/disk I\/O error/);
  });
});

describe('openProjectByPath: already-registered path whose open fails', () => {
  it('resolves null without throwing, and the store has already toasted once', async () => {
    projectsApi.open.mockRejectedValue(wrapped(PROJECT_NOT_FOUND_PREFIX + PROJECT_B.id));
    projectsApi.list.mockResolvedValue([PROJECT_A]);
    projectsApi.getCurrent.mockResolvedValue(PROJECT_A);

    const result = await useProjectStore.getState().openProjectByPath(PROJECT_B.path);

    expect(result).toBeNull();
    expect(projectsApi.openByPath).not.toHaveBeenCalled();
    expect(addToastSpy).toHaveBeenCalledTimes(1);
  });
});
