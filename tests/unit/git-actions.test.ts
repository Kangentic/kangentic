/**
 * Commit, push and create a pull request (src/main/git-actions/), on real git in
 * temp repositories with real hooks and a bare remote on disk. What is mocked is
 * what would reach an agent, a database or a host: the two deliveries, the task
 * repositories, the PR registry and the linker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  holdTaskMessage: vi.fn(),
  pasteAgentMessageInBackground: vi.fn(),
  updateTask: vi.fn(),
  linkPR: vi.fn(async () => ({ status: 'linked', task: null })),
  resolvePRForBranch: vi.fn(async (): Promise<unknown> => null),
  createPullRequest: vi.fn(async (): Promise<unknown> => ({ number: 12, url: 'https://github.com/example/repo/pull/12' })),
  task: {} as Record<string, unknown>,
  laneRole: 'custom' as string,
}));

vi.mock('../../src/main/held-messages/held-messages', () => ({ holdTaskMessage: mocks.holdTaskMessage }));
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', () => ({ pasteAgentMessageInBackground: mocks.pasteAgentMessageInBackground }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('../../src/main/analytics/handled-report', () => ({ createChokepointReporter: () => ({ report: vi.fn() }) }));
vi.mock('../../src/main/ipc/helpers/default-base-branch', () => ({ resolveProjectDefaultBaseBranch: () => 'main' }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: () => ({ projectId: 'project-1', projectPath: mocks.task.projectPath }),
  getProjectRepos: () => ({
    tasks: { getById: () => mocks.task, update: mocks.updateTask },
    swimlanes: { getById: () => ({ role: mocks.laneRole }) },
  }),
}));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({ withTaskLock: (_id: string, run: () => Promise<unknown>) => run() }));
vi.mock('../../src/main/pr/pr-linking', () => ({ linkPR: mocks.linkPR }));
vi.mock('../../src/main/pr/pr-registry', async () => ({
  ...(await import('../../src/main/pr/shared/pr-errors')),
  canCreatePullRequest: async () => true,
  createPullRequest: mocks.createPullRequest,
  resolvePRForBranch: mocks.resolvePRForBranch,
}));

import { resolveGitTarget } from '../../src/main/git-actions/action-target';
import { commitTarget, createPullRequestForTarget, pushTarget } from '../../src/main/git-actions/git-actions';
import { buildGitFailureMessage } from '../../src/main/git-actions/failure-delivery';
import { classifyGitRun } from '../../src/main/git-actions/failure';
import { invalidateRemoteUrlsCache } from '../../src/main/git/git-remotes';
import { PRCreateError, PRResolverUnavailableError } from '../../src/main/pr/shared/pr-errors';
import { MOVE_MESSAGE_MAX_CHARS } from '../../src/main/agent/commands/move-message-limit';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

let root: string;
let checkout: string;
let session: { id: string; status: string; cwd: string; workflowId?: string } | null;
let activity: Record<string, string>;
const submitContent = vi.fn(async () => undefined);

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const write = (name: string, text: string): void => fs.writeFileSync(path.join(checkout, name), text);
const subject = (): string => git(checkout, 'log', '-1', '--format=%s').trim();
const porcelain = (): string => git(checkout, 'status', '--porcelain');

function hook(name: string, body: string): void {
  fs.writeFileSync(path.join(checkout, '.git', 'hooks', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function context(): IpcContext {
  return {
    sessionManager: {
      findLiveSessionByTaskId: () => session ?? undefined,
      findLiveCommandTerminalSession: () => session ?? undefined,
      listSessions: () => (session ? [session] : []),
      getActivityCache: () => activity,
      isTurnHeldByBackgroundWork: () => false,
      isWritable: () => true,
      getSessionAgentName: () => 'claude',
      getSessionCommandCwd: () => undefined,
    },
    terminalSubmit: { submitContent },
  } as unknown as IpcContext;
}

const onTask = () => resolveGitTarget(context(), { kind: 'task', taskId: 'task-1' }, 'project-1');
const onTerminal = () => resolveGitTarget(context(), { kind: 'terminal', slot: 'slot-1' }, 'project-1');
const commit = (message = 'feat: a change', pushAfter = false) => commitTarget(context(), onTask(), { message, pushAfter });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.holdTaskMessage.mockReturnValue({ status: 'held', displayId: 1, rowId: 'row' });
  mocks.resolvePRForBranch.mockResolvedValue(null);
  mocks.createPullRequest.mockResolvedValue({ number: 12, url: 'https://github.com/example/repo/pull/12' });
  mocks.laneRole = 'custom';
  session = null;
  activity = {};
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-git-actions-'));
  checkout = path.join(root, 'checkout');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'checkout');
  git(checkout, 'config', 'user.name', 'Dev');
  git(checkout, 'config', 'user.email', 'dev@example.com');
  git(checkout, 'config', 'core.autocrlf', 'false');
  git(checkout, 'config', 'commit.gpgsign', 'false');
  git(checkout, 'config', 'core.hooksPath', '.git/hooks');
  git(checkout, 'checkout', '-q', '-b', 'main');
  write('base.txt', 'base');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  git(checkout, 'checkout', '-q', '-b', 'task-branch', 'origin/main');
  mocks.task = {
    id: 'task-1', projectPath: checkout, worktree_path: checkout, branch_name: 'task-branch', base_branch: null,
    resolved_base_branch: 'main', pushed_branch: null, pr_state: null, archived_at: null, swimlane_id: 'lane-1',
  };
  invalidateRemoteUrlsCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('commit', () => {
  it('takes every change when nothing is staged, with the message exactly as written', async () => {
    write('base.txt', 'edited');
    write('new file.txt', 'new');
    const message = 'feat: a "quoted" change\n\nBody with `ticks` and %PATH%.';
    expect(await commit(message)).toEqual({ outcome: 'done' });
    expect(git(checkout, 'log', '-1', '--format=%B').trim()).toBe(message);
    expect(porcelain()).toBe('');
  });

  it('takes only what is staged when anything is', async () => {
    write('staged.txt', 'a');
    git(checkout, 'add', 'staged.txt');
    write('base.txt', 'edited');
    await commit();
    expect(git(checkout, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('staged.txt');
    expect(porcelain().trim()).toBe('M base.txt');
  });

  it('restores the index after a hook refuses, so the next commit takes what the agent fixes', async () => {
    hook('pre-commit', 'echo "lint: 2 problems"\nexit 1');
    write('base.txt', 'edited');
    write('new.txt', 'new');
    expect(await commit()).toEqual({ outcome: 'held' });
    expect(git(checkout, 'diff', '--cached', '--name-only')).toBe('');
    fs.rmSync(path.join(checkout, '.git', 'hooks', 'pre-commit'));
    write('base.txt', 'fixed');
    expect(await commit()).toEqual({ outcome: 'done' });
    expect(git(checkout, 'show', 'HEAD:base.txt')).toBe('fixed');
  });

  it('keeps what the user staged when a hook refuses', async () => {
    hook('pre-commit', 'exit 1');
    write('staged.txt', 'a');
    git(checkout, 'add', 'staged.txt');
    await commit();
    expect(git(checkout, 'diff', '--cached', '--name-only').trim()).toBe('staged.txt');
  });

  it('unstages after a failed first commit, where there is no HEAD to restore from', async () => {
    const empty = path.join(root, 'empty');
    git(root, 'init', '-q', '-b', 'main', 'empty');
    git(empty, 'config', 'user.name', 'Dev');
    git(empty, 'config', 'user.email', 'dev@example.com');
    git(empty, 'config', 'core.hooksPath', '.git/hooks');
    checkout = empty;
    hook('pre-commit', 'exit 1');
    write('file.txt', 'a');
    mocks.task = { ...mocks.task, projectPath: empty, worktree_path: empty, branch_name: 'main' };
    expect((await commit()).outcome).toBe('held');
    expect(porcelain().trim()).toBe('?? file.txt');
  });

  it('refuses while conflicts are unresolved, and does not mark them resolved', async () => {
    git(checkout, 'checkout', '-q', '-b', 'other');
    write('base.txt', 'theirs');
    git(checkout, 'commit', '-q', '-am', 'theirs');
    git(checkout, 'checkout', '-q', 'task-branch');
    write('base.txt', 'ours');
    git(checkout, 'commit', '-q', '-am', 'ours');
    expect(() => git(checkout, 'merge', 'other')).toThrow();
    await expect(commit()).rejects.toThrow('Resolve the conflicts first');
    expect(porcelain().trim()).toBe('UU base.txt');
  });

  it('keeps a merge in progress when a hook refuses its commit', async () => {
    git(checkout, 'checkout', '-q', '-b', 'other');
    write('theirs.txt', 'a');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', 'theirs');
    git(checkout, 'checkout', '-q', 'task-branch');
    git(checkout, 'merge', '-q', '--no-ff', '--no-commit', 'other');
    git(checkout, 'restore', '--staged', '--', ':/');
    hook('pre-commit', 'exit 1');
    await commit();
    expect(fs.existsSync(path.join(checkout, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('says there is nothing to commit rather than asking an agent', async () => {
    expect(await commit()).toEqual({ outcome: 'failed', step: 'commit', message: 'There is nothing to commit' });
    expect(mocks.holdTaskMessage).not.toHaveBeenCalled();
  });

  it('pushes after committing when asked, publishing the branch', async () => {
    write('base.txt', 'edited');
    expect(await commit('feat: pushed', true)).toEqual({ outcome: 'done' });
    expect(git(checkout, 'rev-parse', 'origin/task-branch')).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(git(checkout, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/task-branch');
  });
});

describe('push', () => {
  beforeEach(() => {
    write('base.txt', 'edited');
    git(checkout, 'commit', '-q', '-am', 'work');
  });

  it('goes to the branch the work was pushed to before, and never to the base it tracks', async () => {
    git(checkout, 'push', '-q', 'origin', 'HEAD~0:refs/heads/feature/renamed');
    write('base.txt', 'again');
    git(checkout, 'commit', '-q', '-am', 'more');
    mocks.task.pushed_branch = 'feature/renamed';
    expect(await pushTarget(context(), onTask())).toEqual({ outcome: 'done' });
    expect(git(checkout, 'rev-parse', 'origin/feature/renamed')).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(git(checkout, 'rev-parse', 'origin/main')).not.toBe(git(checkout, 'rev-parse', 'HEAD'));
  });

  it('never forces: a rejected push goes to the agent and leaves the remote alone', async () => {
    git(checkout, 'push', '-q', '-u', 'origin', 'HEAD:task-branch');
    const remote = git(checkout, 'rev-parse', 'origin/task-branch');
    git(checkout, 'commit', '-q', '--amend', '-m', 'rewritten');
    expect(await pushTarget(context(), onTask())).toEqual({ outcome: 'held' });
    expect(git(path.join(root, 'origin.git'), 'rev-parse', 'task-branch')).toBe(remote);
    expect(mocks.holdTaskMessage.mock.calls[0][1].message).toContain('rejected');
  });

  it('sends a pre-push hook\'s refusal to the agent, whatever the hook printed', async () => {
    hook('pre-push', 'echo "Could not resolve host: example.com" >&2\necho "pre-push: tests failed" >&2\nexit 1');
    expect((await pushTarget(context(), onTask())).outcome).toBe('held');
  });

  it('shows the user a remote it cannot reach', async () => {
    git(checkout, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'));
    invalidateRemoteUrlsCache();
    expect(await pushTarget(context(), onTask())).toMatchObject({ outcome: 'failed', step: 'push' });
    expect(mocks.holdTaskMessage).not.toHaveBeenCalled();
  });

  it('pushes main from a Command Terminal', async () => {
    git(checkout, 'checkout', '-q', 'main');
    write('base.txt', 'direct');
    git(checkout, 'commit', '-q', '-am', 'direct');
    expect(await pushTarget(context(), onTerminal())).toEqual({ outcome: 'done' });
    expect(git(checkout, 'rev-parse', 'origin/main')).toBe(git(checkout, 'rev-parse', 'HEAD'));
  });
});

describe('what a checkout must be', () => {
  beforeEach(() => write('base.txt', 'edited'));

  it.each([['thinking'], ['permission'], ['unknown']])('refuses while an agent in the folder is mid-turn (%s)', async (state) => {
    session = { id: 'session-1', status: 'running', cwd: checkout };
    activity = state === 'unknown' ? {} : { 'session-1': state };
    await expect(commit()).rejects.toThrow('The agent is working');
    expect(subject()).toBe('base');
  });

  it('refuses a worktree that is on another branch than the task\'s', async () => {
    git(checkout, 'checkout', '-q', '-b', 'stray');
    await expect(commit()).rejects.toThrow("The worktree is on 'stray'");
  });

  it('refuses a detached HEAD', async () => {
    git(checkout, 'checkout', '-q', '--detach');
    await expect(commit()).rejects.toThrow('No branch is checked out');
  });

  it('refuses a task that is done or not started', () => {
    mocks.laneRole = 'done';
    expect(() => onTask()).toThrow('This task is done');
    mocks.laneRole = 'todo';
    expect(() => onTask()).toThrow('This task has not started');
  });

  it('runs one action per folder at a time', async () => {
    const first = commit('feat: first');
    await expect(commit('feat: second')).rejects.toThrow('already running');
    expect(await first).toEqual({ outcome: 'done' });
  });
});

describe('where a failure goes', () => {
  beforeEach(() => {
    hook('pre-commit', 'echo "lint: 2 problems" >&2\nexit 1');
    write('base.txt', 'edited');
  });

  it('goes to the task\'s running agent, and on hold when the paste never reached it', async () => {
    session = { id: 'session-1', status: 'running', cwd: checkout };
    activity = { 'session-1': 'idle' };
    expect(await commit('feat: kept')).toEqual({ outcome: 'sent-to-agent' });
    const input = mocks.pasteAgentMessageInBackground.mock.calls[0][1];
    expect(input).toMatchObject({ taskId: 'task-1', sessionId: 'session-1', acceptHeld: true });
    expect(input.message).toContain('<commit_message>\nfeat: kept\n</commit_message>');
    expect(input.message).toContain('lint: 2 problems');
    expect(mocks.holdTaskMessage).not.toHaveBeenCalled();
    input.onOutcome({ outcome: 'failed', textReachedAgent: false });
    expect(mocks.holdTaskMessage).toHaveBeenCalledTimes(1);
  });

  it('goes to a Command Terminal\'s own agent, automated so a prompt on screen is not answered', async () => {
    session = { id: 'session-2', status: 'running', cwd: checkout };
    activity = { 'session-2': 'idle' };
    expect(await commitTarget(context(), onTerminal(), { message: 'feat: x', pushAfter: false })).toEqual({ outcome: 'sent-to-agent' });
    expect(submitContent).toHaveBeenCalledWith('session-2', expect.stringContaining('lint: 2 problems'), expect.objectContaining({ automated: true }));
  });

  it('shows the user when a task cannot hold it', async () => {
    mocks.holdTaskMessage.mockReturnValue({ status: 'refused', error: 'no' });
    expect(await commit()).toEqual({ outcome: 'failed', step: 'commit', message: 'lint: 2 problems' });
  });

  it('asks for the push too when the user wanted one', async () => {
    await commit('feat: x', true);
    expect(mocks.holdTaskMessage.mock.calls[0][1].message).toContain('Then push to origin/task-branch.');
  });
});

describe('buildGitFailureMessage', () => {
  it('cuts git\'s output from the front to what a held message may be', () => {
    const message = buildGitFailureMessage(
      { step: 'commit', message: 'm'.repeat(5_000), stagedOnly: false, pushAfter: false, pushTo: null },
      { for: 'agent', step: 'commit', output: `first\n${'x'.repeat(MOVE_MESSAGE_MAX_CHARS)}\nlast line` },
    );
    expect(message.length).toBeLessThanOrEqual(MOVE_MESSAGE_MAX_CHARS);
    expect(message).toContain('last line');
    expect(message).not.toContain('first\n');
    expect(message.endsWith('</git_output>')).toBe(true);
  });
});

describe('classifyGitRun', () => {
  const run = (stderr: string, stdout = '') => ({ exitCode: 1, stdout, stderr, unfinished: null });
  it.each([
    ['a missing identity', 'commit', 'Author identity unknown\n*** Please tell me who you are.', 'user'],
    ['another git process', 'commit', "fatal: Unable to create '/r/.git/index.lock': File exists.", 'user'],
    ['a hook that prints a network error', 'commit', 'Could not resolve host: registry.example.com', 'agent'],
    ['a refused sign-in', 'push', "fatal: Authentication failed for 'https://example.com/r.git/'", 'user'],
    ['no write access', 'push', 'remote: Permission to example/r.git denied to dev.\nfatal: unable to access', 'user'],
    ['no network', 'push', "fatal: unable to access 'https://example.com/': Could not resolve host: example.com", 'user'],
    ['a non-fast-forward', 'push', '! [rejected] HEAD -> topic (non-fast-forward)\nerror: failed to push some refs', 'agent'],
    ['a protected branch', 'push', 'remote: error: GH006: Protected branch update failed\n! [remote rejected] (protected branch hook declined)', 'agent'],
  ] as const)('%s', (_name, step, stderr, expected) => {
    expect(classifyGitRun(step, run(stderr), 'output').for).toBe(expected);
  });

  it('shows the user a run that never finished', () => {
    expect(classifyGitRun('push', { exitCode: null, stdout: '', stderr: '', unfinished: 'timeout' }, '')).toMatchObject({ for: 'user' });
  });
});

describe('create pull request', () => {
  const create = (extra: Record<string, unknown> = {}) => createPullRequestForTarget(context(), onTask(), {
    title: 'A title', body: 'A body', baseBranch: 'main', draft: false, ...extra,
  });

  beforeEach(() => {
    write('base.txt', 'edited');
    git(checkout, 'commit', '-q', '-am', 'work');
  });

  it('pushes first, creates, and links the task', async () => {
    expect(await create({ draft: true })).toEqual({ outcome: 'done', pullRequest: { number: 12, url: 'https://github.com/example/repo/pull/12' } });
    expect(git(checkout, 'rev-parse', 'origin/task-branch')).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(mocks.createPullRequest).toHaveBeenCalledWith(checkout, { head: 'task-branch', base: 'main', title: 'A title', body: 'A body', draft: true });
    expect(mocks.updateTask).toHaveBeenCalledWith({ id: 'task-1', pr_url: 'https://github.com/example/repo/pull/12', pr_number: 12, pr_state: null, pr_merge_readiness: null });
    expect(mocks.linkPR).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ force: true, preserveLinkOnNotFound: true }));
  });

  it('links an open pull request instead of creating a second one', async () => {
    mocks.resolvePRForBranch.mockResolvedValue({ number: 7, url: 'https://github.com/example/repo/pull/7', state: 'open' });
    expect(await create()).toMatchObject({ outcome: 'done', pullRequest: { number: 7 } });
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it('creates a new one when the branch\'s last pull request is merged', async () => {
    mocks.resolvePRForBranch.mockResolvedValue({ number: 7, url: 'https://github.com/example/repo/pull/7', state: 'merged' });
    expect(await create()).toMatchObject({ pullRequest: { number: 12 } });
  });

  it('links the one that landed when the create timed out', async () => {
    mocks.createPullRequest.mockRejectedValue(new PRResolverUnavailableError('timed out'));
    mocks.resolvePRForBranch.mockResolvedValueOnce(null).mockResolvedValueOnce({ number: 12, url: 'https://github.com/example/repo/pull/12', state: 'open' });
    expect(await create()).toMatchObject({ outcome: 'done', pullRequest: { number: 12 } });
  });

  it('sends a refusal to the agent with the title and body', async () => {
    mocks.createPullRequest.mockRejectedValue(new PRCreateError('GraphQL: No commits between main and task-branch'));
    expect(await create()).toEqual({ outcome: 'held' });
    const message = mocks.holdTaskMessage.mock.calls[0][1].message;
    expect(message).toContain('No commits between');
    expect(message).toContain('<title>\nA title\n</title>');
  });

  it('shows the user a missing CLI', async () => {
    mocks.createPullRequest.mockRejectedValue(new PRResolverUnavailableError('gh CLI not found. Install it\nmore'));
    expect(await create()).toEqual({ outcome: 'failed', step: 'create-pull-request', message: 'gh CLI not found. Install it' });
  });

  it('refuses a base it cannot pass to a command', () => {
    expect(() => create({ baseBranch: '--upload-pack=x' })).toThrow('Choose a branch');
  });
});
