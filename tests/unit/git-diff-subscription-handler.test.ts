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
import type { GitBranchSummaryInput, GitDiffFilesInput, GitFileContentInput, GitFileImageInput, GitImageContentResult } from '../../src/shared/types';

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

const { mockDiffServiceConstructor, mockGetFileContent, mockGetImageContent } = vi.hoisted(() => ({
  mockDiffServiceConstructor: vi.fn(),
  // Shared by every constructed service, so a test can tell WHICH reader a
  // handler called without holding on to the instance it was routed to.
  mockGetFileContent: vi.fn(),
  mockGetImageContent: vi.fn(),
}));
vi.mock('../../src/main/git/diff-service', () => ({
  DiffService: class {
    getDiffFiles = vi.fn();
    getFileContent = mockGetFileContent;
    getImageContent = mockGetImageContent;
    constructor(gitDirectory: string) {
      mockDiffServiceConstructor(gitDirectory);
    }
  },
}));

vi.mock('../../src/main/git/worktree-head', () => ({ readWorktreeHead: vi.fn(), readWorktreeHeadUnqueued: vi.fn() }));
vi.mock('../../src/main/git/branch-summary', () => ({ getBranchSummary: vi.fn() }));
vi.mock('../../src/main/git/commit-graph', () => ({ getCommitGraph: vi.fn() }));
vi.mock('../../src/main/git/file-history', () => ({ getFileHistory: vi.fn() }));
vi.mock('../../src/main/git/blame', () => ({ getBlame: vi.fn() }));
vi.mock('../../src/main/git/fetch-throttle', () => ({ fetchAllRemotesIfStale: vi.fn() }));
vi.mock('../../src/main/git/local-only-commits', () => ({ countLocalOnlyCommits: vi.fn() }));
vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));

import { registerGitDiffHandlers } from '../../src/main/ipc/handlers/git-diff';
import { getBranchSummary } from '../../src/main/git/branch-summary';
import { readWorktreeHeadUnqueued } from '../../src/main/git/worktree-head';
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

describe('registerGitDiffHandlers GIT_WORKTREE_HEAD', () => {
  type HeadHandler = (event: unknown, input: { path: string }) => Promise<unknown>;

  function getHeadHandler(): HeadHandler {
    const entry = mockHandle.mock.calls.find((call) => call[0] === IPC.GIT_WORKTREE_HEAD);
    if (!entry) throw new Error('ipcMain.handle was never called with IPC.GIT_WORKTREE_HEAD');
    return entry[1] as HeadHandler;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readWorktreeHeadUnqueued).mockResolvedValue({ branch: 'feature/auth', sha: 'abc1234def' });
    vi.mocked(fetchAllRemotesIfStale).mockResolvedValue(undefined);

    const context = {
      mainWindow: {},
      diffWatcher: { subscribe: vi.fn(() => vi.fn()) },
    } as unknown as IpcContext;
    registerGitDiffHandlers(context);
  });

  it('reads the live HEAD of the given path through the UNQUEUED reader, never fetching', async () => {
    const handler = getHeadHandler();

    const result = await handler(null, { path: '/mock/project' });

    // Unqueued: the branch pill's refresh is an interactive path and must not
    // wait behind the global read cap (the same contract as the branch summary).
    expect(readWorktreeHeadUnqueued).toHaveBeenCalledWith('/mock/project');
    expect(fetchAllRemotesIfStale).not.toHaveBeenCalled();
    expect(result).toEqual({ branch: 'feature/auth', sha: 'abc1234def' });
  });
});

/**
 * GIT_PREFETCH_REMOTES: the head start the board fires when a drag of a
 * worktree-backed card begins, so the Done-drop probe is not the thing that
 * starts a remote fetch (measured 640 to 1150ms on the dogfooding instance
 * against a 500ms card flight - docs/board-drag-perf-audit.md).
 *
 * The gate is the load-bearing part and the reason these tests exist: the
 * endpoint honours the SAME per-project setting the background scheduler reads,
 * so a user who turned background fetching off gets no fetch from dragging a
 * card. Nothing else can catch that regressing - the UI tier drives the mock
 * bridge, which never runs this handler at all.
 */
describe('registerGitDiffHandlers GIT_PREFETCH_REMOTES gate', () => {
  type PrefetchHandler = (event: unknown, checkPath: unknown) => Promise<void>;

  const WORKTREE_PATH = '/mock/worktrees/task-a';
  const PROJECT_PATH = '/mock/project';
  let getEffectiveConfig: ReturnType<typeof vi.fn>;

  /** Mount the handlers with the auto-fetch switch set, then return the prefetch handler. */
  function mountWithAutoFetch(autoFetch: boolean): PrefetchHandler {
    vi.clearAllMocks();
    vi.mocked(fetchAllRemotesIfStale).mockResolvedValue(undefined);
    getEffectiveConfig = vi.fn(() => ({ git: { autoFetch } }));
    const context = {
      mainWindow: {},
      diffWatcher: { subscribe: vi.fn(() => vi.fn()) },
      currentProjectPath: PROJECT_PATH,
      configManager: { getEffectiveConfig },
    } as unknown as IpcContext;
    registerGitDiffHandlers(context);
    const entry = mockHandle.mock.calls.find((call) => call[0] === IPC.GIT_PREFETCH_REMOTES);
    if (!entry) throw new Error('ipcMain.handle was never called with IPC.GIT_PREFETCH_REMOTES');
    return entry[1] as PrefetchHandler;
  }

  it('fetches non-interactively for the given worktree when auto-fetch is on', async () => {
    const handler = mountWithAutoFetch(true);

    await handler(null, WORKTREE_PATH);

    // Non-interactive: a drag cannot be allowed to raise a credential prompt.
    expect(fetchAllRemotesIfStale).toHaveBeenCalledWith(WORKTREE_PATH, { nonInteractive: true });
    // Resolved against the current project, so a project override of the
    // switch applies rather than the global value alone.
    expect(getEffectiveConfig).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it('does not fetch when auto-fetch is off', async () => {
    const handler = mountWithAutoFetch(false);

    await handler(null, WORKTREE_PATH);

    expect(fetchAllRemotesIfStale).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty string', ''],
    ['a non-string', 42],
    ['undefined', undefined],
  ])('ignores %s as a path without touching the network', async (_label, checkPath) => {
    const handler = mountWithAutoFetch(true);

    await handler(null, checkPath);

    expect(fetchAllRemotesIfStale).not.toHaveBeenCalled();
  });

  it('falls back to the global config when no project is open', async () => {
    vi.clearAllMocks();
    vi.mocked(fetchAllRemotesIfStale).mockResolvedValue(undefined);
    getEffectiveConfig = vi.fn(() => ({ git: { autoFetch: true } }));
    const context = {
      mainWindow: {},
      diffWatcher: { subscribe: vi.fn(() => vi.fn()) },
      currentProjectPath: null,
      configManager: { getEffectiveConfig },
    } as unknown as IpcContext;
    registerGitDiffHandlers(context);
    const entry = mockHandle.mock.calls.find((call) => call[0] === IPC.GIT_PREFETCH_REMOTES);
    const handler = entry![1] as PrefetchHandler;

    await handler(null, WORKTREE_PATH);

    // `undefined`, not `null`: getEffectiveConfig treats a missing path as
    // "global only", and passing null would read as a path.
    expect(getEffectiveConfig).toHaveBeenCalledWith(undefined);
    expect(fetchAllRemotesIfStale).toHaveBeenCalledWith(WORKTREE_PATH, { nonInteractive: true });
  });
});

/**
 * GIT_FILE_IMAGE: the Changes panel's image read. The handler routes to
 * DiffService.getImageContent, and three things about that route are run by no
 * other tier. The UI tier drives the mock bridge, the DiffService suites call
 * the service directly, and the handler's listener is loosely typed, so a swap
 * to the text reader still typechecks. It must call the IMAGE reader, key the
 * service by the worktree when there is one, and share one cached service with
 * the other diff channels so the merge-base cache is not rebuilt per channel.
 */
describe('registerGitDiffHandlers GIT_FILE_IMAGE', () => {
  const PROJECT_PATH = '/mock/project';
  const IMAGE_RESULT: GitImageContentResult = {
    original: { kind: 'unchanged', fingerprint: 'blob:abc123' },
    modified: { kind: 'unreadable' },
  };

  function getHandler<Input, Result>(channel: string): (event: unknown, input: Input) => Promise<Result> {
    const entry = mockHandle.mock.calls.find((call) => call[0] === channel);
    if (!entry) throw new Error(`ipcMain.handle was never called with ${channel}`);
    return entry[1] as (event: unknown, input: Input) => Promise<Result>;
  }

  const imageInput = (overrides: Partial<GitFileImageInput> = {}): GitFileImageInput => ({
    worktreePath: WORKTREE_PATH_A,
    projectPath: PROJECT_PATH,
    baseBranch: 'main',
    filePath: 'img/a.png',
    status: 'M',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetImageContent.mockResolvedValue(IMAGE_RESULT);
    registerGitDiffHandlers({
      mainWindow: {},
      diffWatcher: { subscribe: vi.fn(() => vi.fn()) },
    } as unknown as IpcContext);
  });

  it('answers with the image reader\'s result for the same input, and never reads the file as text', async () => {
    const handler = getHandler<GitFileImageInput, GitImageContentResult>(IPC.GIT_FILE_IMAGE);
    const input = imageInput({ knownFingerprints: { original: 'blob:abc123' } });

    const result = await handler(null, input);

    expect(result).toBe(IMAGE_RESULT);
    // The input carries the caller's fingerprints through untouched, which is
    // what lets main answer `unchanged` for a side the caller already holds.
    expect(mockGetImageContent).toHaveBeenCalledTimes(1);
    expect(mockGetImageContent).toHaveBeenCalledWith(input);
    expect(mockGetFileContent).not.toHaveBeenCalled();
  });

  it.each([
    ['the worktree when the task has one', imageInput(), WORKTREE_PATH_A],
    ['the project when there is no worktree', imageInput({ worktreePath: undefined }), PROJECT_PATH],
  ])('reads in %s', async (_label, input, expectedDirectory) => {
    const handler = getHandler<GitFileImageInput, GitImageContentResult>(IPC.GIT_FILE_IMAGE);

    await handler(null, input);

    expect(mockDiffServiceConstructor).toHaveBeenCalledTimes(1);
    expect(mockDiffServiceConstructor).toHaveBeenCalledWith(expectedDirectory);
  });

  it('shares one DiffService per directory with the text and file-list channels', async () => {
    const imageHandler = getHandler<GitFileImageInput, GitImageContentResult>(IPC.GIT_FILE_IMAGE);
    const contentHandler = getHandler<GitFileContentInput, unknown>(IPC.GIT_FILE_CONTENT);
    const filesHandler = getHandler<GitDiffFilesInput, unknown>(IPC.GIT_DIFF_FILES);

    await imageHandler(null, imageInput());
    await contentHandler(null, imageInput());
    await filesHandler(null, { worktreePath: WORKTREE_PATH_A, projectPath: PROJECT_PATH, baseBranch: 'main' });
    await imageHandler(null, imageInput());

    // One service means one merge-base cache across a file click's text and
    // image reads; a handler building its own would redo the merge-base per call.
    expect(mockDiffServiceConstructor).toHaveBeenCalledTimes(1);
  });
});
