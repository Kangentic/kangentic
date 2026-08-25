/**
 * Handler-layer unit tests for registerGitDiffHandlers' GIT_DIFF_SUBSCRIBE /
 * GIT_DIFF_UNSUBSCRIBE wiring (src/main/ipc/handlers/git-diff.ts). The
 * per-sender refcounting itself is already covered on its own in
 * tests/unit/diff-subscription-registry.test.ts against a fake watcher, so
 * this file uses the REAL DiffSubscriptionRegistry and pins only the wiring
 * around it: how ipcMain.on hands a fake sender's id and worktreePath to the
 * registry, and how a sender's 'destroyed' / 'did-navigate' events release
 * its refs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { GitBranchSummaryInput, GitDiffFilesInput } from '../../src/shared/types';

// vi.mock() calls are hoisted above every other statement in this file
// (including plain `const` declarations), so any outer variable a factory
// references must itself be declared through vi.hoisted() - otherwise the
// factory runs before its own `const` initializer and throws a TDZ error.
const { mockHandle, mockOn } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockOn: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: mockHandle, on: mockOn } }));

vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));

const { mockDiffServiceConstructor } = vi.hoisted(() => ({
  mockDiffServiceConstructor: vi.fn(),
}));
vi.mock('../../src/main/git/diff-service', () => ({
  DiffService: class {
    getDiffFiles = vi.fn();
    getFileContent = vi.fn();
    constructor(gitDirectory: string) {
      mockDiffServiceConstructor(gitDirectory);
    }
  },
}));

vi.mock('../../src/main/git/worktree-head', () => ({ readWorktreeHead: vi.fn() }));
vi.mock('../../src/main/git/branch-summary', () => ({ getBranchSummary: vi.fn() }));
vi.mock('../../src/main/git/commit-graph', () => ({ getCommitGraph: vi.fn() }));
vi.mock('../../src/main/git/file-history', () => ({ getFileHistory: vi.fn() }));
vi.mock('../../src/main/git/blame', () => ({ getBlame: vi.fn() }));
vi.mock('../../src/main/git/fetch-throttle', () => ({ fetchAllRemotesIfStale: vi.fn() }));
vi.mock('../../src/main/git/local-only-commits', () => ({ countLocalOnlyCommits: vi.fn() }));
vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));

import { registerGitDiffHandlers } from '../../src/main/ipc/handlers/git-diff';
import { getBranchSummary } from '../../src/main/git/branch-summary';
import { fetchAllRemotesIfStale } from '../../src/main/git/fetch-throttle';

const WORKTREE_PATH_A = '/mock/worktrees/task-a';
const WORKTREE_PATH_B = '/mock/worktrees/task-b';

/** Minimal stand-in for Electron's WebContents: an EventEmitter carrying an
 *  `id`, since git-diff.ts only ever reads `event.sender.id`,
 *  `event.sender.once('destroyed', ...)`, and `event.sender.on('did-navigate', ...)`. */
type FakeSender = EventEmitter & { id: number };

function makeFakeSender(id: number): FakeSender {
  const sender = new EventEmitter() as FakeSender;
  sender.id = id;
  return sender;
}

interface FakeIpcEvent {
  sender: FakeSender;
}

function fakeEvent(sender: FakeSender): FakeIpcEvent {
  return { sender };
}

type SubscribeListener = (event: FakeIpcEvent, worktreePath: string) => void;
type FilesHandler = (event: FakeIpcEvent, input: GitDiffFilesInput) => Promise<unknown>;

describe('registerGitDiffHandlers GIT_DIFF_SUBSCRIBE / GIT_DIFF_UNSUBSCRIBE wiring', () => {
  let watcherSubscribe: ReturnType<typeof vi.fn>;
  let watcherTeardownsByPath: Map<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    watcherTeardownsByPath = new Map();
    watcherSubscribe = vi.fn((worktreePath: string) => {
      const teardown = vi.fn();
      watcherTeardownsByPath.set(worktreePath, teardown);
      return teardown;
    });

    const context = {
      mainWindow: {},
      diffWatcher: { subscribe: watcherSubscribe },
    } as unknown as IpcContext;

    registerGitDiffHandlers(context);
  });

  function getSubscribeListener(): SubscribeListener {
    const entry = mockOn.mock.calls.find((call) => call[0] === IPC.GIT_DIFF_SUBSCRIBE);
    if (!entry) throw new Error('ipcMain.on was never called with IPC.GIT_DIFF_SUBSCRIBE');
    return entry[1] as SubscribeListener;
  }

  function getUnsubscribeListener(): SubscribeListener {
    const entry = mockOn.mock.calls.find((call) => call[0] === IPC.GIT_DIFF_UNSUBSCRIBE);
    if (!entry) throw new Error('ipcMain.on was never called with IPC.GIT_DIFF_UNSUBSCRIBE');
    return entry[1] as SubscribeListener;
  }

  function getFilesHandler(): FilesHandler {
    const entry = mockHandle.mock.calls.find((call) => call[0] === IPC.GIT_DIFF_FILES);
    if (!entry) throw new Error('ipcMain.handle was never called with IPC.GIT_DIFF_FILES');
    return entry[1] as FilesHandler;
  }

  it('arms the underlying watcher exactly once per path across N subscribes from one sender', () => {
    const subscribeListener = getSubscribeListener();
    const sender = makeFakeSender(1);

    subscribeListener(fakeEvent(sender), WORKTREE_PATH_A);
    subscribeListener(fakeEvent(sender), WORKTREE_PATH_A);
    subscribeListener(fakeEvent(sender), WORKTREE_PATH_A);

    expect(watcherSubscribe).toHaveBeenCalledTimes(1);
    expect(watcherSubscribe).toHaveBeenCalledWith(WORKTREE_PATH_A, expect.any(Function));
  });

  it('one sender unsubscribing does not tear down another sender watching the same path; the last unsubscribe does', () => {
    const subscribeListener = getSubscribeListener();
    const unsubscribeListener = getUnsubscribeListener();
    const senderA = makeFakeSender(1);
    const senderB = makeFakeSender(2);

    subscribeListener(fakeEvent(senderA), WORKTREE_PATH_A);
    subscribeListener(fakeEvent(senderB), WORKTREE_PATH_A);

    unsubscribeListener(fakeEvent(senderA), WORKTREE_PATH_A);
    expect(watcherTeardownsByPath.get(WORKTREE_PATH_A)).not.toHaveBeenCalled();

    unsubscribeListener(fakeEvent(senderB), WORKTREE_PATH_A);
    expect(watcherTeardownsByPath.get(WORKTREE_PATH_A)).toHaveBeenCalledTimes(1);
  });

  it("releases the path's DiffService cache entry when the last subscriber leaves (so the next GIT_DIFF_FILES call constructs a fresh service)", async () => {
    const subscribeListener = getSubscribeListener();
    const unsubscribeListener = getUnsubscribeListener();
    const filesHandler = getFilesHandler();
    const sender = makeFakeSender(1);

    const input: GitDiffFilesInput = { worktreePath: WORKTREE_PATH_A, projectPath: WORKTREE_PATH_A, baseBranch: 'main' };
    await filesHandler(fakeEvent(sender), input);
    await filesHandler(fakeEvent(sender), input);
    // getOrCreateService caches per directory, so two GIT_DIFF_FILES calls for
    // the same path construct DiffService only once.
    expect(mockDiffServiceConstructor).toHaveBeenCalledTimes(1);

    subscribeListener(fakeEvent(sender), WORKTREE_PATH_A);
    unsubscribeListener(fakeEvent(sender), WORKTREE_PATH_A);

    await filesHandler(fakeEvent(sender), input);
    // The last subscriber leaving dropped the cached DiffService for this path
    // (onPathReleased -> serviceCache.delete), so the next call constructs a
    // NEW instance rather than reusing the stale one.
    expect(mockDiffServiceConstructor).toHaveBeenCalledTimes(2);
  });

  it("emitting 'destroyed' on a sender releases all of its refs", () => {
    const subscribeListener = getSubscribeListener();
    const sender = makeFakeSender(1);

    subscribeListener(fakeEvent(sender), WORKTREE_PATH_A);
    subscribeListener(fakeEvent(sender), WORKTREE_PATH_B);
    expect(watcherTeardownsByPath.get(WORKTREE_PATH_A)).not.toHaveBeenCalled();
    expect(watcherTeardownsByPath.get(WORKTREE_PATH_B)).not.toHaveBeenCalled();

    sender.emit('destroyed');

    expect(watcherTeardownsByPath.get(WORKTREE_PATH_A)).toHaveBeenCalledTimes(1);
    expect(watcherTeardownsByPath.get(WORKTREE_PATH_B)).toHaveBeenCalledTimes(1);
  });

  it("emitting 'did-navigate' on a sender releases all of its refs (a renderer reload must not stack refcounts)", () => {
    const subscribeListener = getSubscribeListener();
    const sender = makeFakeSender(1);

    subscribeListener(fakeEvent(sender), WORKTREE_PATH_A);
    expect(watcherTeardownsByPath.get(WORKTREE_PATH_A)).not.toHaveBeenCalled();

    sender.emit('did-navigate');

    expect(watcherTeardownsByPath.get(WORKTREE_PATH_A)).toHaveBeenCalledTimes(1);

    // The reload's own fresh subscribe re-arms cleanly instead of stacking on
    // top of a stale, already-released refcount.
    subscribeListener(fakeEvent(sender), WORKTREE_PATH_A);
    expect(watcherSubscribe).toHaveBeenCalledTimes(2);
  });

  it("registers 'destroyed' and 'did-navigate' listeners on a sender only once, across repeated subscribes for different paths", () => {
    const subscribeListener = getSubscribeListener();
    const sender = makeFakeSender(1);

    subscribeListener(fakeEvent(sender), WORKTREE_PATH_A);
    subscribeListener(fakeEvent(sender), WORKTREE_PATH_A);
    subscribeListener(fakeEvent(sender), WORKTREE_PATH_B);

    expect(sender.listenerCount('destroyed')).toBe(1);
    expect(sender.listenerCount('did-navigate')).toBe(1);
  });
});

describe('registerGitDiffHandlers GIT_BRANCH_SUMMARY refreshRemote flag', () => {
  type SummaryHandler = (event: unknown, input: GitBranchSummaryInput) => Promise<unknown>;

  function getSummaryHandler(): SummaryHandler {
    const entry = mockHandle.mock.calls.find((call) => call[0] === IPC.GIT_BRANCH_SUMMARY);
    if (!entry) throw new Error('ipcMain.handle was never called with IPC.GIT_BRANCH_SUMMARY');
    return entry[1] as SummaryHandler;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBranchSummary).mockResolvedValue({ currentBranch: 'main', ahead: 0, behind: 0, lastCommit: null });
    vi.mocked(fetchAllRemotesIfStale).mockResolvedValue(undefined);

    const context = {
      mainWindow: {},
      diffWatcher: { subscribe: vi.fn(() => vi.fn()) },
    } as unknown as IpcContext;
    registerGitDiffHandlers(context);
  });

  it('a flagless call never fetches - the fs.watch refire path stays local and cheap', async () => {
    const handler = getSummaryHandler();

    await handler(null, { worktreePath: WORKTREE_PATH_A, projectPath: '/mock/project', baseBranch: 'main' });

    expect(fetchAllRemotesIfStale).not.toHaveBeenCalled();
    expect(getBranchSummary).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: WORKTREE_PATH_A, baseBranch: 'main' }),
    );
  });

  it('refreshRemote awaits the throttled all-remotes fetch BEFORE computing the summary', async () => {
    const handler = getSummaryHandler();

    await handler(null, { worktreePath: WORKTREE_PATH_A, projectPath: '/mock/project', baseBranch: 'main', refreshRemote: true });

    expect(fetchAllRemotesIfStale).toHaveBeenCalledWith(WORKTREE_PATH_A);
    // Order matters: a summary computed before the refs land would report the
    // same stale `behind` the flag exists to correct.
    const fetchOrder = vi.mocked(fetchAllRemotesIfStale).mock.invocationCallOrder[0];
    const summaryOrder = vi.mocked(getBranchSummary).mock.invocationCallOrder[0];
    expect(fetchOrder).toBeLessThan(summaryOrder);
  });

  it('refreshRemote falls back to projectPath when there is no worktreePath', async () => {
    const handler = getSummaryHandler();

    await handler(null, { projectPath: '/mock/project', baseBranch: 'main', refreshRemote: true });

    expect(fetchAllRemotesIfStale).toHaveBeenCalledWith('/mock/project');
  });
});
