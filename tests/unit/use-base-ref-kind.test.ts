/**
 * `resolveBaseRef` and `shortRefLabel` (`src/renderer/hooks/useBaseRefKind.ts`).
 *
 * The module holds two module-scope Maps (answers and in-flight requests) with
 * no reset export, so each test loads a fresh copy with `vi.resetModules()` and
 * a dynamic import. `window.electronAPI` and the project store are stubbed the
 * way git-branches.test.ts does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GitResolveRefResult } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  resolveRef: vi.fn(),
  useProjectStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/project-store', () => ({ useProjectStore: mocks.useProjectStore }));

const SHA = 'a'.repeat(40);
const OK_TAG: GitResolveRefResult = { ok: true, kind: 'tag', sha: SHA };
const MISS: GitResolveRefResult = { ok: false, reason: 'git', error: 'unknown revision' };

function setOpenProject(id: string | null): void {
  mocks.useProjectStore.getState.mockReturnValue({ currentProject: id ? { id } : null });
}

async function loadModule(): Promise<typeof import('../../src/renderer/hooks/useBaseRefKind')> {
  vi.resetModules();
  return import('../../src/renderer/hooks/useBaseRefKind');
}

beforeEach(() => {
  mocks.resolveRef.mockReset();
  setOpenProject('project-a');
  (globalThis as unknown as { window: { electronAPI: { git: { resolveRef: typeof mocks.resolveRef } } } }).window = {
    electronAPI: { git: { resolveRef: mocks.resolveRef } },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('resolveBaseRef', () => {
  it('serves an ok answer from the cache with no second IPC call', async () => {
    const { resolveBaseRef } = await loadModule();
    mocks.resolveRef.mockResolvedValue(OK_TAG);

    await expect(resolveBaseRef('v1.0.0', 'project-a')).resolves.toEqual(OK_TAG);
    await expect(resolveBaseRef('v1.0.0', 'project-a')).resolves.toEqual(OK_TAG);

    expect(mocks.resolveRef).toHaveBeenCalledTimes(1);
    expect(mocks.resolveRef).toHaveBeenCalledWith('v1.0.0', 'project-a', undefined);
  });

  it('asks again after a miss, since the ref may be created or fetched a moment later', async () => {
    const { resolveBaseRef } = await loadModule();
    mocks.resolveRef.mockResolvedValueOnce(MISS).mockResolvedValueOnce(OK_TAG);

    await expect(resolveBaseRef('v1.0.0', 'project-a')).resolves.toEqual(MISS);
    await expect(resolveBaseRef('v1.0.0', 'project-a')).resolves.toEqual(OK_TAG);

    expect(mocks.resolveRef).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent local-only callers', async () => {
    const { resolveBaseRef } = await loadModule();
    mocks.resolveRef.mockResolvedValue(OK_TAG);

    await Promise.all([resolveBaseRef('v1.0.0', 'project-a'), resolveBaseRef('v1.0.0', 'project-a')]);

    expect(mocks.resolveRef).toHaveBeenCalledTimes(1);
  });

  it('never lets a local-only request absorb a fetchTag one for the same ref', async () => {
    const { resolveBaseRef } = await loadModule();
    mocks.resolveRef
      .mockResolvedValueOnce(MISS)
      .mockResolvedValueOnce(OK_TAG);

    const [local, fetching] = await Promise.all([
      resolveBaseRef('v1.0.0', 'project-a'),
      resolveBaseRef('v1.0.0', 'project-a', { fetchTag: true }),
    ]);

    expect(mocks.resolveRef).toHaveBeenCalledTimes(2);
    expect(mocks.resolveRef).toHaveBeenNthCalledWith(1, 'v1.0.0', 'project-a', undefined);
    expect(mocks.resolveRef).toHaveBeenNthCalledWith(2, 'v1.0.0', 'project-a', { fetchTag: true });
    expect(local).toEqual(MISS);
    expect(fetching).toEqual(OK_TAG);
  });

  it('follows the open project when the project id is null', async () => {
    const { resolveBaseRef } = await loadModule();
    mocks.resolveRef.mockResolvedValue(OK_TAG);

    await resolveBaseRef('v1.0.0', null);
    await resolveBaseRef('v1.0.0', null);
    expect(mocks.resolveRef).toHaveBeenCalledTimes(1);

    // A tag in one project must not answer for the same name in the next one opened.
    setOpenProject('project-b');
    await resolveBaseRef('v1.0.0', null);
    expect(mocks.resolveRef).toHaveBeenCalledTimes(2);
  });
});

describe('shortRefLabel', () => {
  it('shortens a commit to seven characters and leaves a tag or branch as given', async () => {
    const { shortRefLabel } = await loadModule();

    expect(shortRefLabel('abcdef1234567', 'commit')).toBe('abcdef1');
    expect(shortRefLabel('abcdef1234567', 'tag')).toBe('abcdef1234567');
    expect(shortRefLabel('abcdef1234567', 'branch')).toBe('abcdef1234567');
    expect(shortRefLabel('abcdef1234567', null)).toBe('abcdef1234567');
  });
});
