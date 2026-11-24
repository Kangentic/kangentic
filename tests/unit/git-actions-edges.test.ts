/**
 * The edges of commit, push and create pull request (src/main/git-actions/), beside
 * git-actions.test.ts: where a push is recorded on the task row, who a failure goes
 * to, a push that fails inside another action, the refusals of a pull request, which
 * sessions block a checkout, an index that cannot be restored, the classifier's
 * reading of real stderr, a message that must fit its cap, the capture of a child's
 * output, and the IPC handlers' announcement of a write.
 *
 * Real git in temp repositories with real hooks and a bare remote on disk. Mocked:
 * what would reach an agent, a database or a host.
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
  canCreate: vi.fn(async (): Promise<boolean> => true),
  report: vi.fn(),
  announce: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  task: {} as Record<string, unknown>,
  laneRole: 'custom' as string,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => { mocks.handlers.set(channel, handler); } },
}));
vi.mock('../../src/main/ipc/helpers/task-write-announce', () => ({ announceTaskWrite: mocks.announce }));
vi.mock('../../src/main/git-actions/draft-text', () => ({ draftGitText: vi.fn() }));
vi.mock('../../src/main/held-messages/held-messages', () => ({ holdTaskMessage: mocks.holdTaskMessage }));
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', () => ({ pasteAgentMessageInBackground: mocks.pasteAgentMessageInBackground }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('../../src/main/analytics/handled-report', () => ({ createChokepointReporter: () => ({ report: mocks.report }) }));
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
  canCreatePullRequest: () => mocks.canCreate(),
  createPullRequest: mocks.createPullRequest,
  resolvePRForBranch: mocks.resolvePRForBranch,
}));

import { assertTargetReady, resolveGitTarget, type ResolvedGitTarget } from '../../src/main/git-actions/action-target';
import { commitTarget, createPullRequestForTarget, pushTarget } from '../../src/main/git-actions/git-actions';
import { buildGitFailureMessage, type AskedGitAction } from '../../src/main/git-actions/failure-delivery';
import { classifyGitRun, failureLine } from '../../src/main/git-actions/failure';
import { outputTail } from '../../src/main/git-actions/run-git-captured';
import { cutText } from '../../src/main/git-actions/prompt-text';
import { registerGitActionHandlers } from '../../src/main/ipc/handlers/git-actions';
import { capturedOutputOf, spawnWithAbort } from '../../src/main/git/spawn-with-abort';
import { invalidateRemoteUrlsCache } from '../../src/main/git/git-remotes';
import { PRCreateError, PRResolverTransientError } from '../../src/main/pr/shared/pr-errors';
import { MOVE_MESSAGE_MAX_CHARS } from '../../src/main/agent/commands/move-message-limit';
import { IPC } from '../../src/shared/ipc-channels';
import type { GitWorkDetail } from '../../src/main/git/work-state';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

let root: string;
let checkout: string;
let session: { id: string; status: string; cwd: string; workflowId?: string } | null;
let commandCwd: string | undefined;
let activity: Record<string, string>;
let writable: boolean;
const submitContent = vi.fn(async (): Promise<undefined> => undefined);

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const write = (name: string, text: string): void => fs.writeFileSync(path.join(checkout, name), text);
const subject = (): string => git(checkout, 'log', '-1', '--format=%s').trim();

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
      isWritable: () => writable,
      getSessionAgentName: () => 'claude',
      getSessionCommandCwd: () => commandCwd,
    },
    terminalSubmit: { submitContent },
  } as unknown as IpcContext;
}

const onTask = () => resolveGitTarget(context(), { kind: 'task', taskId: 'task-1' }, 'project-1');
const onTerminal = () => resolveGitTarget(context(), { kind: 'terminal', slot: 'slot-1' }, 'project-1');
const commit = (message = 'feat: a change', pushAfter = false) => commitTarget(context(), onTask(), { message, pushAfter });
const heldMessage = (): string => mocks.holdTaskMessage.mock.calls[0][1].message;

/** Each test of the calling describe gets a fresh clone, a bare origin and cleared mocks. */
function useRepository(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.holdTaskMessage.mockReturnValue({ status: 'held', displayId: 1, rowId: 'row' });
    mocks.resolvePRForBranch.mockResolvedValue(null);
    mocks.createPullRequest.mockResolvedValue({ number: 12, url: 'https://github.com/example/repo/pull/12' });
    mocks.canCreate.mockResolvedValue(true);
    mocks.laneRole = 'custom';
    session = null;
    activity = {};
    writable = true;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-git-edges-'));
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
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

describe('where a push is recorded on the task', () => {
  useRepository();
  /** Work that is ahead of origin and tracks a branch of another name. */
  function publishUnderAnotherName(): void {
    write('base.txt', 'one');
    git(checkout, 'commit', '-q', '-am', 'one');
    git(checkout, 'push', '-q', '-u', 'origin', 'HEAD:elsewhere');
    write('base.txt', 'two');
    git(checkout, 'commit', '-q', '-am', 'two');
  }

  it('writes the branch a push went to when it is not the task\'s own', async () => {
    publishUnderAnotherName();
    expect(await pushTarget(context(), onTask())).toEqual({ outcome: 'done' });
    expect(git(path.join(root, 'origin.git'), 'rev-parse', 'elsewhere')).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(mocks.updateTask).toHaveBeenCalledTimes(1);
    expect(mocks.updateTask).toHaveBeenCalledWith({ id: 'task-1', pushed_branch: 'elsewhere' });
  });

  it('writes nothing for a push to the task\'s own branch', async () => {
    write('base.txt', 'one');
    git(checkout, 'commit', '-q', '-am', 'one');
    expect(await pushTarget(context(), onTask())).toEqual({ outcome: 'done' });
    expect(git(path.join(root, 'origin.git'), 'rev-parse', 'task-branch')).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it.each([
    ['the base the task was set to', { base_branch: 'main', resolved_base_branch: null }],
    ['the base its worktree was cut from', { base_branch: 'release', resolved_base_branch: 'main' }],
  ])('never writes %s as where the work was pushed', async (_name, bases) => {
    git(checkout, 'checkout', '-q', 'main');
    write('base.txt', 'direct');
    git(checkout, 'commit', '-q', '-am', 'direct');
    mocks.task = { ...mocks.task, ...bases, branch_name: null };
    expect(await pushTarget(context(), onTask())).toEqual({ outcome: 'done' });
    expect(git(path.join(root, 'origin.git'), 'rev-parse', 'main')).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it('writes nothing when the task went back to To Do while the push ran', async () => {
    publishUnderAnotherName();
    const resolved = onTask();
    mocks.laneRole = 'todo';
    expect(await pushTarget(context(), resolved)).toEqual({ outcome: 'done' });
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it('writes nothing for a Command Terminal, which has no task row', async () => {
    publishUnderAnotherName();
    expect(await pushTarget(context(), onTerminal())).toEqual({ outcome: 'done' });
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
});

describe('who a failure is delivered to', () => {
  useRepository();
  beforeEach(() => {
    hook('pre-commit', 'echo "first line" >&2\necho "last line" >&2\nexit 1');
    write('base.txt', 'edited');
    session = { id: 'session-1', status: 'running', cwd: checkout };
    activity = { 'session-1': 'idle' };
  });

  it.each([
    ['a confirmed paste', { outcome: 'confirmed' }],
    ['a failed paste with no word on the text', { outcome: 'failed', textReachedAgent: undefined }],
    ['a failed paste whose text reached the agent', { outcome: 'failed', textReachedAgent: true }],
  ])('does not hold the message after %s', async (_name, report) => {
    expect(await commit()).toEqual({ outcome: 'sent-to-agent' });
    mocks.pasteAgentMessageInBackground.mock.calls[0][1].onOutcome(report);
    expect(mocks.holdTaskMessage).not.toHaveBeenCalled();
  });

  it('holds the message for the next agent when the session cannot be written to', async () => {
    writable = false;
    expect(await commit()).toEqual({ outcome: 'held' });
    expect(mocks.pasteAgentMessageInBackground).not.toHaveBeenCalled();
    expect(heldMessage()).toContain('last line');
  });

  it('tells the user the last line when a Command Terminal has no agent', async () => {
    session = null;
    expect(await commitTarget(context(), onTerminal(), { message: 'feat: x', pushAfter: false }))
      .toEqual({ outcome: 'failed', step: 'commit', message: 'last line' });
    expect(mocks.holdTaskMessage).not.toHaveBeenCalled();
    expect(submitContent).not.toHaveBeenCalled();
  });

  it('reports a terminal delivery that rejects, and still says it was sent', async () => {
    const failure = new Error('the terminal went away');
    submitContent.mockRejectedValueOnce(failure);
    expect(await commitTarget(context(), onTerminal(), { message: 'feat: x', pushAfter: false })).toEqual({ outcome: 'sent-to-agent' });
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledWith(failure, { tags: { stage: 'terminal_delivery' } }));
  });
});

describe('a push that fails inside another action', () => {
  useRepository();
  beforeEach(() => hook('pre-push', 'echo "pre-push: tests failed" >&2\nexit 1'));

  it('sends a commit\'s push failure as a push, without the commit message', async () => {
    write('base.txt', 'edited');
    expect(await commit('feat: kept', true)).toEqual({ outcome: 'held' });
    expect(subject()).toBe('feat: kept');
    const message = heldMessage();
    expect(message.startsWith("The user's push to origin/task-branch from this checkout failed.")).toBe(true);
    expect(message).not.toContain('<commit_message>');
    expect(message).toContain('pre-push: tests failed');
  });

  it('sends a pull request\'s push failure with the title and body to create it with after', async () => {
    write('base.txt', 'edited');
    git(checkout, 'commit', '-q', '-am', 'work');
    const result = await createPullRequestForTarget(context(), onTask(), { title: 'A title', body: 'A body', baseBranch: 'main', draft: false });
    expect(result).toEqual({ outcome: 'held' });
    const message = heldMessage();
    expect(message).toContain('<title>\nA title\n</title>');
    expect(message).toContain('<body>\nA body\n</body>');
    expect(message).toContain('Then create the pull request into main');
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });
});

describe('createPullRequestForTarget refusals and edges', () => {
  useRepository();
  const input = { title: 'A title', body: 'A body', baseBranch: 'main', draft: false };
  const create = (extra: Record<string, unknown> = {}) => createPullRequestForTarget(context(), onTask(), { ...input, ...extra });

  beforeEach(() => {
    write('base.txt', 'edited');
    git(checkout, 'commit', '-q', '-am', 'work');
  });

  it('refuses a branch that would merge into itself', async () => {
    await expect(create({ baseBranch: 'task-branch' })).rejects.toThrow('The branch is the one it would merge into');
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it('refuses a repository with no remote', async () => {
    git(checkout, 'remote', 'remove', 'origin');
    invalidateRemoteUrlsCache();
    await expect(create()).rejects.toThrow('This repository has no remote');
  });

  it('refuses a title that is only blanks', () => {
    expect(() => create({ title: '   ' })).toThrow('The pull request needs a title');
  });

  it('refuses a remote pull requests cannot be created on, before pushing anything', async () => {
    mocks.canCreate.mockResolvedValue(false);
    await expect(create()).rejects.toThrow('No pull request can be created');
    expect(git(path.join(root, 'origin.git'), 'branch', '--list', 'task-branch')).toBe('');
  });

  it('creates anyway when the lookup before it was only transient', async () => {
    mocks.resolvePRForBranch.mockRejectedValueOnce(new PRResolverTransientError('rate limited'));
    expect(await create()).toMatchObject({ outcome: 'done', pullRequest: { number: 12 } });
    expect(mocks.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it('shows the user a create that failed transiently, by its first line', async () => {
    mocks.createPullRequest.mockRejectedValue(new PRResolverTransientError('rate limited\nretry later'));
    expect(await create()).toEqual({ outcome: 'failed', step: 'create-pull-request', message: 'rate limited' });
    expect(mocks.holdTaskMessage).not.toHaveBeenCalled();
  });

  it('rejects an error nobody classified, and frees the folder for the next action', async () => {
    mocks.createPullRequest.mockRejectedValueOnce(new Error('unclassified failure'));
    await expect(create()).rejects.toThrow('unclassified failure');
    expect(await create()).toMatchObject({ outcome: 'done' });
  });

  it('does not push a branch that is already on its remote', async () => {
    hook('pre-push', 'echo ran >> .git/pre-push-ran');
    const ranFile = path.join(checkout, '.git', 'pre-push-ran');
    await create();
    expect(fs.existsSync(ranFile)).toBe(true);
    fs.rmSync(ranFile);
    expect(await create()).toMatchObject({ outcome: 'done' });
    expect(fs.existsSync(ranFile)).toBe(false);
    expect(mocks.createPullRequest).toHaveBeenCalledTimes(2);
  });

  it('writes no task row and links nothing for a Command Terminal', async () => {
    const result = await createPullRequestForTarget(context(), onTerminal(), input);
    expect(result).toMatchObject({ outcome: 'done', pullRequest: { number: 12 } });
    expect(mocks.updateTask).not.toHaveBeenCalled();
    expect(mocks.linkPR).not.toHaveBeenCalled();
  });
});

describe('assertTargetReady', () => {
  let folder: string;
  const work = { branch: 'task-branch' } as GitWorkDetail;
  const check = (directory = folder): void => assertTargetReady(context(), { directory, task: null } as ResolvedGitTarget, work);

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-git-ready-'));
    activity = { 'session-1': 'thinking' };
    session = null;
    commandCwd = undefined;
  });

  afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

  it('refuses while a thinking agent works in the same folder', () => {
    session = { id: 'session-1', status: 'running', cwd: folder };
    expect(() => check()).toThrow('The agent is working');
  });

  it('refuses for a host\'s agent, whose own cwd is the host\'s path', () => {
    session = { id: 'session-1', status: 'running', cwd: '/home/dev/project' };
    commandCwd = folder;
    expect(() => check()).toThrow('The agent is working');
  });

  it('is not blocked by a thinking session in another folder, of a workflow, or not running', () => {
    session = { id: 'session-1', status: 'running', cwd: path.join(folder, '..', 'kng-elsewhere') };
    expect(() => check()).not.toThrow();
    session = { id: 'session-1', status: 'running', cwd: folder, workflowId: 'workflow-1' };
    expect(() => check()).not.toThrow();
    session = { id: 'session-1', status: 'exited', cwd: folder };
    expect(() => check()).not.toThrow();
  });

  it('refuses a folder that is gone', () => {
    expect(() => check(path.join(folder, 'gone'))).toThrow('The folder is gone');
  });
});

describe('classifyGitRun on what git and hooks print', () => {
  const run = (stderr: string) => ({ exitCode: 1, stdout: '', stderr, unfinished: null });

  it('shows the user a push that cannot resolve a host, though the repository is named for a hook', () => {
    const stderr = "fatal: unable to access 'https://github.com/pre-commit/pre-commit.git/': Could not resolve host: github.com";
    expect(classifyGitRun('push', run(stderr), 'output').for).toBe('user');
  });

  it('still gives an agent a hook\'s decline when the same line follows it', () => {
    const stderr = "remote: pre-receive hook declined\nfatal: unable to access 'https://example.com/r.git/': Could not resolve host: example.com";
    expect(classifyGitRun('push', run(stderr), 'output').for).toBe('agent');
  });

  it('strips color from the output an agent reads and from the line a user reads', () => {
    const colored = { stdout: '', stderr: '\u001b[31merror: \u001b[1mlint failed\u001b[0m\n' };
    expect(outputTail(colored, 1_000)).toBe('error: lint failed');
    expect(failureLine(colored)).toBe('lint failed');
  });
});

describe('the environment a hook runs in', () => {
  useRepository();

  it('runs a hook with git\'s messages in English, whatever the user\'s language', async () => {
    vi.stubEnv('LANGUAGE', 'de');
    hook('pre-commit', 'echo "hook sees LANGUAGE=$LANGUAGE" >&2\nexit 1');
    write('base.txt', 'edited');
    expect(await commit()).toEqual({ outcome: 'held' });
    expect(heldMessage()).toContain('hook sees LANGUAGE=en');
  });
});

describe('buildGitFailureMessage within the hold limit', () => {
  const output = `${'o'.repeat(30_000)}\nthe last line`;
  const agentFailure = (step: 'commit' | 'push' | 'create-pull-request') => ({ for: 'agent' as const, step, output });

  function expectFits(message: string, tags: string[]): void {
    expect(message.length).toBeLessThanOrEqual(MOVE_MESSAGE_MAX_CHARS);
    for (const tag of [...tags, 'git_output']) {
      expect(message.split(`<${tag}>`).length - 1).toBe(1);
      expect(message.split(`</${tag}>`).length - 1).toBe(1);
    }
    expect(message.endsWith('the last line\n</git_output>')).toBe(true);
    expect(message.slice(message.indexOf('<git_output>'))).not.toBe('<git_output>\n\n</git_output>');
  }

  it('holds a 25,000 character pull request body', () => {
    const asked: AskedGitAction = {
      step: 'create-pull-request', head: 'topic', pullRequest: { title: 'T', body: 'b'.repeat(25_000), baseBranch: 'main', draft: false },
    };
    expectFits(buildGitFailureMessage(asked, agentFailure('create-pull-request')), ['title', 'body']);
    expectFits(buildGitFailureMessage(asked, agentFailure('push')), ['title', 'body']);
  });

  it('holds a 25,000 character commit message', () => {
    const asked: AskedGitAction = { step: 'commit', message: 'c'.repeat(25_000), stagedOnly: false, pushAfter: true, pushTo: 'origin/topic' };
    expectFits(buildGitFailureMessage(asked, agentFailure('commit')), ['commit_message']);
  });
});

describe('cutText', () => {
  const hasLoneSurrogate = (text: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

  it('drops half a pair at the end of what it keeps from the head', () => {
    const cut = cutText('ab\u{1F600}cd', 3, 'head');
    expect(cut).toBe('ab');
    expect(hasLoneSurrogate(cut)).toBe(false);
  });

  it('drops half a pair at the start of what it keeps from the tail', () => {
    const cut = cutText('cd\u{1F600}ab', 3, 'tail');
    expect(cut).toBe('ab');
    expect(hasLoneSurrogate(cut)).toBe(false);
  });

  it('keeps a whole pair that fits', () => {
    expect(cutText('ab\u{1F600}cd', 4, 'head')).toBe('ab\u{1F600}');
    expect(cutText('ab\u{1F600}cd', 4, 'tail')).toBe('\u{1F600}cd');
  });
});

describe('spawnWithAbort capture', () => {
  const nodeTarget = (code: string) => ({ command: process.execPath, args: ['-e', code], cwd: os.tmpdir(), label: 'node probe', signalKillAssertsTimeout: true });
  const FLOOD = "process.stdout.write('x'.repeat(2100000));process.stdout.write('END_MARKER\\n');";

  it('keeps the end of output past the cap when asked to, where the default keeps the start', async () => {
    const tail = await spawnWithAbort(nodeTarget(FLOOD), { timeoutMs: 60_000, keepOutput: 'tail' });
    expect(tail.stdout.endsWith('END_MARKER\n')).toBe(true);
    expect(tail.stdout.length).toBeLessThanOrEqual(2_000_000);
    const head = await spawnWithAbort(nodeTarget(FLOOD), { timeoutMs: 60_000 });
    expect(head.stdout).not.toContain('END_MARKER');
  }, 60_000);

  it('hands back both streams and the exit code of a child that exited non-zero', async () => {
    const error = await spawnWithAbort(nodeTarget("console.log('said');console.error('bad');process.exit(3)"), { timeoutMs: 30_000 }).catch((caught: unknown) => caught);
    expect(capturedOutputOf(error)).toEqual({ exitCode: 3, stdout: expect.stringContaining('said'), stderr: expect.stringContaining('bad') });
  });

  it('has no exit code for a child that timed out', async () => {
    const error = await spawnWithAbort(nodeTarget('setTimeout(() => {}, 60000)'), { timeoutMs: 500 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(capturedOutputOf(error)).toMatchObject({ exitCode: null });
  });

  it('has nothing for a binary that is not there, or for an error that is not its own', async () => {
    const error = await spawnWithAbort(
      { command: 'kng-no-such-binary-for-test', args: [], cwd: os.tmpdir(), label: 'missing', signalKillAssertsTimeout: true },
      { timeoutMs: 30_000 },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(capturedOutputOf(error)).toBeNull();
    expect(capturedOutputOf(new Error('other'))).toBeNull();
    expect(capturedOutputOf('text')).toBeNull();
  });
});

describe('registerGitActionHandlers', () => {
  useRepository();
  const event = { sender: {} };
  const changeFor = (ids: string[]) => ({ change: 'task-updated', ids });
  const task = { kind: 'task', taskId: 'task-1' };
  const terminal = { kind: 'terminal', slot: 'slot-1' };

  beforeEach(() => {
    mocks.handlers.clear();
    registerGitActionHandlers(context());
  });

  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = mocks.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(event, ...args);
  };

  it('announces the task a commit wrote, whether the commit returned or threw', async () => {
    write('base.txt', 'edited');
    expect(await invoke(IPC.GIT_COMMIT, task, { message: 'feat: x', pushAfter: false }, 'project-1')).toEqual({ outcome: 'done' });
    expect(mocks.announce).toHaveBeenCalledTimes(1);
    expect(mocks.announce).toHaveBeenLastCalledWith(expect.anything(), event, 'project-1', changeFor(['task-1']));
    await expect(invoke(IPC.GIT_COMMIT, task, { message: '  ', pushAfter: false }, 'project-1')).rejects.toThrow('needs a message');
    expect(mocks.announce).toHaveBeenCalledTimes(2);
    expect(mocks.announce).toHaveBeenLastCalledWith(expect.anything(), event, 'project-1', changeFor(['task-1']));
  });

  it('announces a push and a pull request, with no task for a Command Terminal', async () => {
    expect(await invoke(IPC.GIT_PUSH, terminal, 'project-1')).toEqual({ outcome: 'done' });
    expect(mocks.announce).toHaveBeenLastCalledWith(expect.anything(), event, 'project-1', changeFor([]));
    await expect(invoke(IPC.GIT_CREATE_PULL_REQUEST, terminal, { title: ' ', body: '', baseBranch: 'main', draft: false }, 'project-1'))
      .rejects.toThrow('needs a title');
    expect(mocks.announce).toHaveBeenCalledTimes(2);
    expect(mocks.announce).toHaveBeenLastCalledWith(expect.anything(), event, 'project-1', changeFor([]));
  });
});
