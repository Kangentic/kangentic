import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDiffFiles = vi.fn();
const getFileContent = vi.fn();

vi.mock('../../../src/main/git/diff-service', () => ({
  DiffService: class {
    getDiffFiles(...args: unknown[]): unknown {
      return getDiffFiles(...args);
    }
    getFileContent(...args: unknown[]): unknown {
      return getFileContent(...args);
    }
  },
}));

const tasksGetById = vi.fn();
vi.mock('../../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({ tasks: { getById: tasksGetById } })),
}));

import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleReadDiff } from '../../../src/main/mobile-bridge/handlers/read-diff';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';
import type { DiffWatcher } from '../../../src/main/git/diff-watcher';
import type { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';
import { SubscriptionRegistry } from '../../../src/main/mobile-bridge/session/subscription-registry';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'read-diff', payload };
}

function fakeSession(): BridgeSession {
  return { deviceId: 'device-1', isEstablished: true, sendMessage: vi.fn() } as unknown as BridgeSession;
}

function fakeDiffWatcher(): DiffWatcher {
  // subscribe returns a per-subscriber teardown (the real DiffWatcher does),
  // which the handler must store as the subscription teardown.
  return { subscribe: vi.fn(() => vi.fn()), unsubscribe: vi.fn() } as unknown as DiffWatcher;
}

describe('handleReadDiff', () => {
  beforeEach(() => {
    getDiffFiles.mockReset();
    getFileContent.mockReset();
    tasksGetById.mockReset();
  });

  it('rejects an unknown project', async () => {
    const context = { projectRepo: { getById: vi.fn(() => undefined) } } as unknown as IpcContext;
    const response = await handleReadDiff(
      fakeRequest({ taskId: 't-1', projectId: 'ghost' }),
      fakeSession(),
      context,
      new SubscriptionRegistry(),
      fakeDiffWatcher(),
    );
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no such project/i);
  });

  it('rejects an unknown task', async () => {
    tasksGetById.mockReturnValue(undefined);
    const context = { projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', path: '/projects/proj-1' })) } } as unknown as IpcContext;
    const response = await handleReadDiff(
      fakeRequest({ taskId: 'ghost', projectId: 'proj-1' }),
      fakeSession(),
      context,
      new SubscriptionRegistry(),
      fakeDiffWatcher(),
    );
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no such task/i);
  });

  it('returns the file list and subscribes the bridge-owned DiffWatcher to the worktree, never context.diffWatcher', async () => {
    tasksGetById.mockReturnValue({ id: 't-1', worktree_path: '/worktrees/t-1', base_branch: 'main' });
    getDiffFiles.mockResolvedValue({ files: [{ path: 'a.ts', status: 'M' }], totalInsertions: 1, totalDeletions: 0 });
    const rendererDiffWatcher = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    const bridgeDiffWatcher = fakeDiffWatcher();
    const context = {
      projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', path: '/projects/proj-1' })) },
      diffWatcher: rendererDiffWatcher,
    } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    const response = await handleReadDiff(
      fakeRequest({ taskId: 't-1', projectId: 'proj-1' }),
      fakeSession(),
      context,
      subscriptions,
      bridgeDiffWatcher,
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ files: [{ path: 'a.ts', status: 'M' }], totalInsertions: 1, totalDeletions: 0 });
    expect(getDiffFiles).toHaveBeenCalledWith({
      worktreePath: '/worktrees/t-1',
      projectPath: '/projects/proj-1',
      baseBranch: 'main',
      scope: undefined,
    });
    expect(bridgeDiffWatcher.subscribe).toHaveBeenCalledWith('/worktrees/t-1', expect.any(Function));
    expect(rendererDiffWatcher.subscribe).not.toHaveBeenCalled();
    expect(subscriptions.has('diff:t-1')).toBe(true);
  });

  it('stores the per-subscriber teardown returned by subscribe, not a blanket unsubscribe(path)', async () => {
    // The shared DiffWatcher multiplexes callbacks per path, so tearing a
    // subscription down must remove only this device's callback (the returned
    // teardown) rather than unsubscribe(watchPath), which would kill a
    // co-located subscription (another device / worktree-less task in the same repo).
    tasksGetById.mockReturnValue({ id: 't-1', worktree_path: '/worktrees/t-1', base_branch: 'main' });
    getDiffFiles.mockResolvedValue({ files: [], totalInsertions: 0, totalDeletions: 0 });
    const perSubscriberTeardown = vi.fn();
    const unsubscribe = vi.fn();
    const bridgeDiffWatcher = {
      subscribe: vi.fn(() => perSubscriberTeardown),
      unsubscribe,
    } as unknown as DiffWatcher;
    const context = {
      projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', path: '/projects/proj-1' })) },
    } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    await handleReadDiff(
      fakeRequest({ taskId: 't-1', projectId: 'proj-1' }),
      fakeSession(),
      context,
      subscriptions,
      bridgeDiffWatcher,
    );

    subscriptions.remove('diff:t-1');
    expect(perSubscriberTeardown).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribe tears down via the bridge-owned watcher, never context.diffWatcher', async () => {
    const rendererDiffWatcher = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    const bridgeDiffWatcher = fakeDiffWatcher();
    const context = { diffWatcher: rendererDiffWatcher } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    subscriptions.set('diff:t-1', () => bridgeDiffWatcher.unsubscribe('/worktrees/t-1'));

    const response = await handleReadDiff(
      fakeRequest({ taskId: 't-1', projectId: 'proj-1', action: 'unsubscribe' }),
      fakeSession(),
      context,
      subscriptions,
      bridgeDiffWatcher,
    );

    expect(response.ok).toBe(true);
    expect(bridgeDiffWatcher.unsubscribe).toHaveBeenCalledWith('/worktrees/t-1');
    expect(rendererDiffWatcher.unsubscribe).not.toHaveBeenCalled();
    expect(subscriptions.has('diff:t-1')).toBe(false);
  });

  it('resolves the file status from the current diff list before fetching content (the wire payload carries no status)', async () => {
    tasksGetById.mockReturnValue({ id: 't-1', worktree_path: '/worktrees/t-1', base_branch: 'main' });
    getDiffFiles.mockResolvedValue({
      files: [{ path: 'a.ts', status: 'A', oldPath: undefined }],
      totalInsertions: 5,
      totalDeletions: 0,
    });
    getFileContent.mockResolvedValue({ original: '', modified: 'content', language: 'typescript' });
    const context = {
      projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', path: '/projects/proj-1' })) },
    } as unknown as IpcContext;

    const response = await handleReadDiff(
      fakeRequest({ taskId: 't-1', projectId: 'proj-1', filePath: 'a.ts' }),
      fakeSession(),
      context,
      new SubscriptionRegistry(),
      fakeDiffWatcher(),
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ original: '', modified: 'content', language: 'typescript' });
    expect(getFileContent).toHaveBeenCalledWith({
      worktreePath: '/worktrees/t-1',
      projectPath: '/projects/proj-1',
      baseBranch: 'main',
      filePath: 'a.ts',
      status: 'A',
      oldPath: undefined,
      scope: undefined,
    });
  });

  it('rejects a filePath not present in the current diff', async () => {
    tasksGetById.mockReturnValue({ id: 't-1', worktree_path: '/worktrees/t-1', base_branch: 'main' });
    getDiffFiles.mockResolvedValue({ files: [], totalInsertions: 0, totalDeletions: 0 });
    const context = {
      projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', path: '/projects/proj-1' })) },
    } as unknown as IpcContext;

    const response = await handleReadDiff(
      fakeRequest({ taskId: 't-1', projectId: 'proj-1', filePath: 'missing.ts' }),
      fakeSession(),
      context,
      new SubscriptionRegistry(),
      fakeDiffWatcher(),
    );

    expect(response.ok).toBe(false);
    expect(getFileContent).not.toHaveBeenCalled();
  });
});
