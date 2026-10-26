/**
 * Handler-layer unit tests for `readTaskChanges` (the `git:taskChanges` body in
 * src/main/ipc/handlers/git-diff.ts). The resolver itself runs against real git
 * in tests/unit/task-changes-real-git.test.ts; this file pins the wiring around
 * it, which no other test reaches: the task row and project it reads, the
 * linked commits it asks the retrieval worker for (and what indexing off and a
 * worker that does not answer turn into), and the web links it stamps.
 *
 * It also pins the web-link stamping both readers share, `withCommitWebLinks`
 * (its fail-safes called directly), and that the registered `git:commitGraph`
 * handler routes its graph through it, against the repo it was asked about
 * (the worktree when there is one, else the project).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { GitCommitGraphCommit, GitCommitGraphInput, GitCommitGraphResult, Task } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  getCommitGraph: vi.fn(),
  retrievalCall: vi.fn(),
  resolveTaskChanges: vi.fn(),
  commitWebLinks: vi.fn(),
  commitsMissingFromRemotes: vi.fn(),
  getById: vi.fn(),
  getForkPointSha: vi.fn(),
}));

vi.mock('electron', () => ({ ipcMain: { handle: hoisted.ipcHandle, on: vi.fn() } }));
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));
vi.mock('../../src/main/git/commit-graph', () => ({ getCommitGraph: hoisted.getCommitGraph }));
vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: hoisted.retrievalCall } }));
vi.mock('../../src/main/git/task-changes', () => ({ resolveTaskChanges: hoisted.resolveTaskChanges, TASK_CHANGES_MAX_COMMITS: 300 }));
vi.mock('../../src/main/pr/pr-registry', () => ({ commitWebLinks: hoisted.commitWebLinks }));
vi.mock('../../src/main/git/remote-presence', () => ({ commitsMissingFromRemotes: hoisted.commitsMissingFromRemotes }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: (_context: unknown, projectId: string) => ({ projectId, projectPath: '/mock/project' }),
  getProjectRepos: () => ({ tasks: { getById: hoisted.getById, getForkPointSha: hoisted.getForkPointSha } }),
}));

import { readTaskChanges, registerGitDiffHandlers, withCommitWebLinks } from '../../src/main/ipc/handlers/git-diff';

const TASK_ID = 'task-read-changes';
const LINKED = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const WORKTREE_PATH = '/mock/worktrees/task-read-changes';
const PROJECT_PATH = '/mock/project';

/** A connector's links for a GitHub-shaped remote: the host's name and a commit URL builder. */
function githubLinks() {
  return { providerName: 'GitHub', url: (sha: string) => `https://github.com/example/example/commit/${sha}` };
}

function commitOf(hash: string): GitCommitGraphCommit {
  return { hash, shortHash: hash.slice(0, 7), parents: [], authorName: 'Dev', authorTimestamp: '2026-10-22T00:00:00.000Z', subject: `commit ${hash.slice(0, 1)}` };
}

function contextWith(indexingEnabled: boolean): IpcContext {
  return {
    configManager: {
      load: () => ({ knowledgeGraph: { indexingEnabled } }),
      getEffectiveConfig: () => ({ git: { defaultBaseBranch: 'main' } }),
    },
  } as unknown as IpcContext;
}

function resolution(overrides: Record<string, unknown> = {}) {
  return { range: null, commits: [], truncated: false, files: [], totals: null, emptyReason: 'no-commits', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.getById.mockReturnValue({
    id: TASK_ID, branch_name: 'feature/x', head_sha: OTHER, base_branch: null, resolved_base_branch: 'develop',
  } as unknown as Task);
  hoisted.getForkPointSha.mockReturnValue(null);
  hoisted.commitWebLinks.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readTaskChanges', () => {
  it('asks the worker for the task\'s linked commits and hands their shas, the row and the base to the resolver', async () => {
    hoisted.retrievalCall.mockResolvedValue(new Map([[TASK_ID, { commits: [{ sha: LINKED, subject: 's', committedAt: 'now' }] }]]));
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: null, commits: [commitOf(LINKED)] }));

    const result = await readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID });

    // One past the 300-commit cap, so the resolver can tell a task that had more.
    expect(hoisted.retrievalCall).toHaveBeenCalledWith('task.knowledge', { projectId: 'project-1', taskIds: [TASK_ID], limits: { commits: 301, files: 0 } });
    expect(hoisted.resolveTaskChanges).toHaveBeenCalledWith({
      repoPath: '/mock/project',
      baseBranch: 'develop',
      branchName: 'feature/x',
      headSha: OTHER,
      forkPointSha: null,
      linkedCommitShas: [LINKED],
    });
    expect(result).toMatchObject({ projectPath: '/mock/project', baseBranch: 'develop', branchName: 'feature/x', webProviderName: null });
  });

  it('with indexing off, never asks the worker and tells the resolver there is no index', async () => {
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: 'indexing-off' }));

    const result = await readTaskChanges(contextWith(false), { projectId: 'project-1', taskId: TASK_ID });

    expect(hoisted.retrievalCall).not.toHaveBeenCalled();
    expect(hoisted.resolveTaskChanges.mock.calls[0][0]).toMatchObject({ linkedCommitShas: null });
    expect(result.emptyReason).toBe('indexing-off');
  });

  it('throws when the worker fails and git alone finds nothing, so the view offers Retry', async () => {
    hoisted.retrievalCall.mockRejectedValue(new Error('worker restarting'));
    hoisted.resolveTaskChanges.mockResolvedValue(resolution());

    await expect(readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID })).rejects.toThrow(/index is restarting/);
    // The resolver still ran on what git has, with no linked commits.
    expect(hoisted.resolveTaskChanges.mock.calls[0][0]).toMatchObject({ linkedCommitShas: [] });
  });

  it('answers from git when the worker fails but the branch alone resolves', async () => {
    hoisted.retrievalCall.mockRejectedValue(new Error('worker restarting'));
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: null, range: { base: OTHER, head: LINKED }, commits: [commitOf(LINKED)] }));

    const result = await readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID });

    expect(result.range).toEqual({ base: OTHER, head: LINKED });
  });

  it('stamps a web link on each commit the remote has, and names the host', async () => {
    hoisted.retrievalCall.mockResolvedValue(new Map());
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: null, commits: [commitOf(LINKED), commitOf(OTHER)] }));
    hoisted.commitWebLinks.mockResolvedValue({ providerName: 'GitHub', url: (sha: string) => `https://github.com/example/example/commit/${sha}` });
    // The second commit is only in this clone.
    hoisted.commitsMissingFromRemotes.mockResolvedValue(new Set([OTHER]));

    const result = await readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID });

    expect(result.webProviderName).toBe('GitHub');
    expect(result.commits.map((commit) => commit.webUrl)).toEqual([`https://github.com/example/example/commit/${LINKED}`, null]);
  });

  it('with commitWebLinks false, looks up no web links, leaves the commits as the resolver gave them, and keeps the rest of the answer', async () => {
    const commits = [commitOf(LINKED), commitOf(OTHER)];
    const files = [{ path: 'src/example.ts', status: 'M' as const, insertions: 3, deletions: 1, binary: false }];
    const totals = { insertions: 3, deletions: 1, filesChanged: 1 };
    hoisted.retrievalCall.mockResolvedValue(new Map());
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({
      emptyReason: null,
      range: { base: OTHER, head: LINKED },
      commits,
      files,
      totals,
    }));
    // A connector that would stamp both commits, so only the option keeps the
    // links off. With no connector, the early return would hide a regression.
    hoisted.commitWebLinks.mockResolvedValue(githubLinks());
    hoisted.commitsMissingFromRemotes.mockResolvedValue(new Set());

    const result = await readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID }, { commitWebLinks: false });

    expect(hoisted.commitWebLinks).not.toHaveBeenCalled();
    expect(hoisted.commitsMissingFromRemotes).not.toHaveBeenCalled();
    expect(result.webProviderName).toBeNull();
    // Not even a `webUrl: undefined` key: the commits are the resolver's own.
    expect(result.commits).toStrictEqual(commits);
    for (const commit of result.commits) {
      expect(commit).not.toHaveProperty('webUrl');
    }
    expect(result).toMatchObject({
      range: { base: OTHER, head: LINKED },
      files,
      totals,
      emptyReason: null,
      branchName: 'feature/x',
      baseBranch: 'develop',
      projectPath: '/mock/project',
    });
  });

  it('with commitWebLinks true or left out, still looks up the web links', async () => {
    hoisted.retrievalCall.mockResolvedValue(new Map());
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: null, commits: [commitOf(LINKED)] }));
    hoisted.commitWebLinks.mockResolvedValue(githubLinks());
    hoisted.commitsMissingFromRemotes.mockResolvedValue(new Set());

    const explicitlyOn = await readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID }, { commitWebLinks: true });
    const optionsOmitted = await readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID }, {});

    expect(hoisted.commitWebLinks).toHaveBeenCalledTimes(2);
    for (const result of [explicitlyOn, optionsOmitted]) {
      expect(result.webProviderName).toBe('GitHub');
      expect(result.commits.map((commit) => commit.webUrl)).toEqual([`https://github.com/example/example/commit/${LINKED}`]);
    }
  });

  it('refuses a task the project does not have', async () => {
    hoisted.getById.mockReturnValue(undefined);

    await expect(readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: 'missing' })).rejects.toThrow(/could not be found/);
    expect(hoisted.resolveTaskChanges).not.toHaveBeenCalled();
  });

  it('falls back to the task\'s own base branch when no base was resolved, ahead of the configured default', async () => {
    // The configured default is 'main', so a wrong precedence cannot pass by coincidence.
    hoisted.getById.mockReturnValue({
      id: TASK_ID, branch_name: 'feature/x', head_sha: OTHER, base_branch: 'release/x', resolved_base_branch: null,
    } as unknown as Task);
    hoisted.retrievalCall.mockResolvedValue(new Map());
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: null, commits: [commitOf(LINKED)] }));

    const result = await readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID });

    expect(hoisted.resolveTaskChanges.mock.calls[0][0]).toMatchObject({ baseBranch: 'release/x' });
    expect(result.baseBranch).toBe('release/x');
  });

  it('prefers the resolved base branch over the task\'s own when both are set', async () => {
    hoisted.getById.mockReturnValue({
      id: TASK_ID, branch_name: 'feature/x', head_sha: OTHER, base_branch: 'release/x', resolved_base_branch: 'develop',
    } as unknown as Task);
    hoisted.retrievalCall.mockResolvedValue(new Map());
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: null, commits: [commitOf(LINKED)] }));

    const result = await readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID });

    expect(hoisted.resolveTaskChanges.mock.calls[0][0]).toMatchObject({ baseBranch: 'develop' });
    expect(result.baseBranch).toBe('develop');
  });

  it('falls back to the configured default base branch when the task has neither a resolved nor its own base', async () => {
    hoisted.getById.mockReturnValue({
      id: TASK_ID, branch_name: 'feature/x', head_sha: OTHER, base_branch: null, resolved_base_branch: null,
    } as unknown as Task);
    hoisted.retrievalCall.mockResolvedValue(new Map());
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: null, commits: [commitOf(LINKED)] }));

    const result = await readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID });

    expect(hoisted.resolveTaskChanges.mock.calls[0][0]).toMatchObject({ baseBranch: 'main' });
    expect(result.baseBranch).toBe('main');
  });

  it('gives the worker 8000 ms to answer, then reads as unavailable and throws when git finds nothing', async () => {
    vi.useFakeTimers();
    // The worker never answers.
    hoisted.retrievalCall.mockReturnValue(new Promise(() => {}));
    hoisted.resolveTaskChanges.mockResolvedValue(resolution());

    const pending = readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID });
    // Attached before time moves so the rejection never goes unhandled.
    const rejection = expect(pending).rejects.toThrow(/index is restarting/);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(hoisted.resolveTaskChanges).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    // The wait ran out: the resolver ran on what git has, with no linked commits.
    expect(hoisted.resolveTaskChanges).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveTaskChanges.mock.calls[0][0]).toMatchObject({ linkedCommitShas: [] });
    await rejection;
  });

  it('answers from git when the worker never answers but the branch alone resolves', async () => {
    vi.useFakeTimers();
    hoisted.retrievalCall.mockReturnValue(new Promise(() => {}));
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: null, range: { base: OTHER, head: LINKED }, commits: [commitOf(LINKED)] }));

    const pending = readTaskChanges(contextWith(true), { projectId: 'project-1', taskId: TASK_ID });
    await vi.advanceTimersByTimeAsync(8_000);

    // Checked before awaiting, so a wait that is too long fails here instead of hanging the test.
    expect(hoisted.resolveTaskChanges).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveTaskChanges.mock.calls[0][0]).toMatchObject({ linkedCommitShas: [] });
    await expect(pending).resolves.toMatchObject({ range: { base: OTHER, head: LINKED } });
  });
});

describe('withCommitWebLinks', () => {
  it('leaves every commit without a link, and still names the host, when the push check fails', async () => {
    hoisted.commitWebLinks.mockResolvedValue(githubLinks());
    // null is "could not tell which commits are on a remote", not "all of them are".
    hoisted.commitsMissingFromRemotes.mockResolvedValue(null);

    const result = await withCommitWebLinks(PROJECT_PATH, { commits: [commitOf(LINKED), commitOf(OTHER)] });

    expect(result.commits.map((commit) => commit.webUrl)).toEqual([null, null]);
    expect(result.webProviderName).toBe('GitHub');
  });

  it('looks nothing up for a graph with no commits', async () => {
    // A connector that would answer, so only the early return keeps the name null.
    hoisted.commitWebLinks.mockResolvedValue(githubLinks());
    hoisted.commitsMissingFromRemotes.mockResolvedValue(new Set());

    const result = await withCommitWebLinks(PROJECT_PATH, { commits: [] });

    expect(hoisted.commitWebLinks).not.toHaveBeenCalled();
    expect(hoisted.commitsMissingFromRemotes).not.toHaveBeenCalled();
    expect(result.commits).toEqual([]);
    expect(result.webProviderName).toBeNull();
  });

  it('leaves the commits as given and the host unnamed when no connector owns the remote', async () => {
    hoisted.commitWebLinks.mockResolvedValue(null);

    const result = await withCommitWebLinks(PROJECT_PATH, { commits: [commitOf(LINKED)] });

    expect(hoisted.commitsMissingFromRemotes).not.toHaveBeenCalled();
    expect(result.commits.map((commit) => commit.webUrl)).toEqual([undefined]);
    expect(result.webProviderName).toBeNull();
  });
});

describe('registerGitDiffHandlers git:commitGraph', () => {
  type CommitGraphHandler = (event: unknown, input: GitCommitGraphInput) => Promise<GitCommitGraphResult>;

  /** Registers the handlers against a minimal context and returns the one the channel got. */
  function registeredCommitGraphHandler(): CommitGraphHandler {
    registerGitDiffHandlers({ diffWatcher: { subscribe: vi.fn() }, mainWindow: null } as unknown as IpcContext);
    const registration = hoisted.ipcHandle.mock.calls.find(([channel]) => channel === IPC.GIT_COMMIT_GRAPH);
    if (!registration) throw new Error('git:commitGraph was never registered');
    return registration[1] as CommitGraphHandler;
  }

  /** What git hands back: no web fields on any commit, so a link can only come from the handler. */
  function graphOf(commits: GitCommitGraphCommit[]): GitCommitGraphResult {
    return { commits, tipHash: LINKED, baseHash: OTHER, mergeBaseHash: OTHER, currentBranch: 'feature/x', truncated: false };
  }

  it('stamps each commit the remote has with its web link, names the host, and keeps the rest of the graph', async () => {
    hoisted.getCommitGraph.mockResolvedValue(graphOf([commitOf(LINKED), commitOf(OTHER)]));
    hoisted.commitWebLinks.mockResolvedValue(githubLinks());
    // The second commit is only in this clone.
    hoisted.commitsMissingFromRemotes.mockResolvedValue(new Set([OTHER]));
    const input: GitCommitGraphInput = { worktreePath: WORKTREE_PATH, projectPath: PROJECT_PATH, baseBranch: 'main' };

    const result = await registeredCommitGraphHandler()({}, input);

    expect(hoisted.getCommitGraph).toHaveBeenCalledWith(input);
    expect(result.webProviderName).toBe('GitHub');
    expect(result.commits.map((commit) => commit.webUrl)).toEqual([`https://github.com/example/example/commit/${LINKED}`, null]);
    expect(result.tipHash).toBe(LINKED);
    expect(result.currentBranch).toBe('feature/x');
  });

  it('asks about the task\'s worktree, not the project, when it has one', async () => {
    hoisted.getCommitGraph.mockResolvedValue(graphOf([commitOf(LINKED), commitOf(OTHER)]));
    hoisted.commitWebLinks.mockResolvedValue(githubLinks());
    hoisted.commitsMissingFromRemotes.mockResolvedValue(new Set());

    await registeredCommitGraphHandler()({}, { worktreePath: WORKTREE_PATH, projectPath: PROJECT_PATH, baseBranch: 'main' });

    expect(hoisted.commitWebLinks).toHaveBeenCalledWith(WORKTREE_PATH);
    expect(hoisted.commitsMissingFromRemotes).toHaveBeenCalledWith(WORKTREE_PATH, [LINKED, OTHER]);
  });

  it('asks about the project when there is no worktree', async () => {
    hoisted.getCommitGraph.mockResolvedValue(graphOf([commitOf(LINKED)]));
    hoisted.commitWebLinks.mockResolvedValue(githubLinks());
    hoisted.commitsMissingFromRemotes.mockResolvedValue(new Set());

    await registeredCommitGraphHandler()({}, { projectPath: PROJECT_PATH, baseBranch: 'main' });

    expect(hoisted.commitWebLinks).toHaveBeenCalledWith(PROJECT_PATH);
    expect(hoisted.commitsMissingFromRemotes).toHaveBeenCalledWith(PROJECT_PATH, [LINKED]);
  });
});

describe('registerGitDiffHandlers git:taskChanges', () => {
  it('keeps the web links on, because the view shows the commits (only get_task_report turns them off)', async () => {
    hoisted.retrievalCall.mockResolvedValue(new Map());
    hoisted.resolveTaskChanges.mockResolvedValue(resolution({ emptyReason: null, commits: [commitOf(LINKED)] }));
    hoisted.commitWebLinks.mockResolvedValue(githubLinks());
    hoisted.commitsMissingFromRemotes.mockResolvedValue(new Set());
    registerGitDiffHandlers({
      ...contextWith(true),
      diffWatcher: { subscribe: vi.fn() },
      mainWindow: null,
    } as unknown as IpcContext);
    const registration = hoisted.ipcHandle.mock.calls.find(([channel]) => channel === IPC.GIT_TASK_CHANGES);
    if (!registration) throw new Error('git:taskChanges was never registered');
    const handler = registration[1] as (event: unknown, input: { projectId: string; taskId: string }) => Promise<{ webProviderName: string | null; commits: GitCommitGraphCommit[] }>;

    const result = await handler({}, { projectId: 'project-1', taskId: TASK_ID });

    expect(result.webProviderName).toBe('GitHub');
    expect(result.commits.map((commit) => commit.webUrl)).toEqual([`https://github.com/example/example/commit/${LINKED}`]);
  });
});
