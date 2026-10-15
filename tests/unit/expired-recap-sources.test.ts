/**
 * `createExpiredRecapSources` (`src/main/transition-engine/expired-recap-sources.ts`):
 * where the expired-conversation recap gets its summary, its tail and its
 * branch state.
 *
 * The recap rides a spawn the user is waiting on, so a source never costs more
 * than its own wait:
 *  - a worker read that does not answer in 1,500 ms answers null, and the same
 *    sources object then answers null at once for every later worker read, so a
 *    startup pass over many expired tasks pays the wait once, not once each;
 *  - a worker read that fails answers null but does not stop later reads;
 *  - the branch state is read in the task's checkout, never fetching, and caps
 *    what it hands the recap.
 *
 * The retrieval client and the git runner are mocked; timers are fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const retrievalMock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: retrievalMock.call },
}));

const gitMock = vi.hoisted(() => ({ runGitCommand: vi.fn() }));
vi.mock('../../src/main/git/git-client', () => ({ runGitCommand: gitMock.runGitCommand }));

import { createExpiredRecapSources } from '../../src/main/transition-engine/expired-recap-sources';

const WORKER_WAIT_MS = 1_500;
const GIT_WAIT_MS = 3_000;

/** Records whether, and with what, a promise has settled, without awaiting it. */
function watch<Value>(promise: Promise<Value>): { settled: boolean; value: Value | undefined } {
  const watched: { settled: boolean; value: Value | undefined } = { settled: false, value: undefined };
  void promise.then((value) => {
    watched.settled = true;
    watched.value = value;
  });
  return watched;
}

beforeEach(() => {
  vi.useFakeTimers();
  retrievalMock.call.mockReset();
  gitMock.runGitCommand.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('worker reads (the task summary and the conversation tail)', () => {
  it('asks the worker for the project\'s summary and tail with the ids the caller gave', async () => {
    retrievalMock.call.mockResolvedValueOnce('A summary.').mockResolvedValueOnce('User: hi');
    const sources = createExpiredRecapSources('project-1');

    expect(await sources.readTaskSummary!('task-1')).toBe('A summary.');
    expect(await sources.readConversationTail!('agent-session-1', 900)).toBe('User: hi');

    expect(retrievalMock.call).toHaveBeenNthCalledWith(1, 'summary.forTask', { projectId: 'project-1', taskId: 'task-1' });
    expect(retrievalMock.call).toHaveBeenNthCalledWith(2, 'transcript.recapTail', {
      projectId: 'project-1', agentSessionId: 'agent-session-1', maxChars: 900,
    });
  });

  // Red-green: the `if (workerWaitRanOut) return null;` in `fromWorker`. Delete
  // it and the later reads call the worker again, which here answers.
  it('answers null once the wait runs out, then answers null at once, without calling the worker, from the same sources', async () => {
    retrievalMock.call.mockImplementation(() => new Promise(() => undefined));
    const sources = createExpiredRecapSources('project-1');

    const first = watch(sources.readTaskSummary!('task-1'));
    await vi.advanceTimersByTimeAsync(WORKER_WAIT_MS - 1);
    expect(first.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.settled).toBe(true);
    expect(first.value).toBeNull();
    expect(retrievalMock.call).toHaveBeenCalledTimes(1);

    // The worker is back, but this set has stopped asking it.
    retrievalMock.call.mockReset();
    retrievalMock.call.mockResolvedValue('an answer');
    const laterSummary = watch(sources.readTaskSummary!('task-2'));
    const laterTail = watch(sources.readConversationTail!('agent-session-1', 500));
    await vi.advanceTimersByTimeAsync(0);
    expect(laterSummary.settled).toBe(true);
    expect(laterSummary.value).toBeNull();
    expect(laterTail.settled).toBe(true);
    expect(laterTail.value).toBeNull();
    expect(retrievalMock.call).not.toHaveBeenCalled();

    // A new sources object, as a board spawn builds for each spawn, asks again.
    const fresh = createExpiredRecapSources('project-1');
    expect(await fresh.readTaskSummary!('task-2')).toBe('an answer');
    expect(retrievalMock.call).toHaveBeenCalledTimes(1);
  });

  it('shares the stop between the summary and the tail', async () => {
    retrievalMock.call.mockImplementation(() => new Promise(() => undefined));
    const sources = createExpiredRecapSources('project-1');

    const tail = watch(sources.readConversationTail!('agent-session-1', 500));
    await vi.advanceTimersByTimeAsync(WORKER_WAIT_MS);
    expect(tail.settled).toBe(true);

    retrievalMock.call.mockReset();
    retrievalMock.call.mockResolvedValue('a summary');
    const summary = watch(sources.readTaskSummary!('task-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(summary.settled).toBe(true);
    expect(summary.value).toBeNull();
    expect(retrievalMock.call).not.toHaveBeenCalled();
  });

  // Red-green: the failure path of `within`. Report it as `timedOut: true` and
  // the second read below is answered null without calling the worker.
  it('answers null for a read that fails, and does not stop later reads', async () => {
    const sources = createExpiredRecapSources('project-1');
    retrievalMock.call.mockRejectedValueOnce(new Error('the worker is restarting'));

    expect(await sources.readTaskSummary!('task-1')).toBeNull();

    retrievalMock.call.mockResolvedValueOnce('a summary');
    expect(await sources.readTaskSummary!('task-1')).toBe('a summary');
    expect(retrievalMock.call).toHaveBeenCalledTimes(2);
  });

  it('answers null for a read the worker answers null', async () => {
    retrievalMock.call.mockResolvedValue(null);
    const sources = createExpiredRecapSources('project-1');

    expect(await sources.readTaskSummary!('task-1')).toBeNull();
    // An answer of null is an answer: the next read still asks the worker.
    expect(await sources.readConversationTail!('agent-session-1', 500)).toBeNull();
    expect(retrievalMock.call).toHaveBeenCalledTimes(2);
  });
});

/** Stubs `git` by the arguments the code under test passes; an Error answer is thrown. */
function stubGit(answer: (args: readonly string[]) => string | Error): void {
  gitMock.runGitCommand.mockImplementation(async (_directory: string, args: readonly string[]) => {
    const result = answer(args);
    if (result instanceof Error) throw result;
    return result;
  });
}

function gitCalls(): string[][] {
  return gitMock.runGitCommand.mock.calls.map((call) => [...(call[1] as readonly string[])]);
}

const isBranchRead = (args: readonly string[]) => args[0] === 'rev-parse' && args[1] === '--abbrev-ref';
const isVerify = (args: readonly string[]) => args[0] === 'rev-parse' && args[1] === '--verify';
const isLog = (args: readonly string[]) => args[0] === 'log';
const isStatus = (args: readonly string[]) => args[0] === 'status';

describe('git state', () => {
  it('reads the branch, its commits past origin/<base>, and its uncommitted changes, in the task\'s checkout', async () => {
    stubGit((args) => {
      if (isBranchRead(args)) return 'fix-login\n';
      if (isVerify(args)) return 'abc123\n';
      if (isLog(args)) return 'c2 Second change\nc1 First change\n';
      if (isStatus(args)) return ' M src/auth.ts\n?? notes.md\n';
      return new Error(`unexpected git ${args.join(' ')}`);
    });
    const sources = createExpiredRecapSources('project-1');

    const state = await sources.readGitState!('/mock/worktree', 'main');

    expect(state).toEqual({
      branch: 'fix-login',
      commits: ['c2 Second change', 'c1 First change'],
      changes: [' M src/auth.ts', '?? notes.md'],
    });
    expect(gitMock.runGitCommand.mock.calls.every((call) => call[0] === '/mock/worktree')).toBe(true);
    // origin/main was there, so the plain branch was never needed.
    const verified = gitCalls().filter(isVerify).map((args) => args.at(-1));
    expect(verified).toEqual(['origin/main']);
    const log = gitCalls().find(isLog);
    expect(log).toContain('origin/main..HEAD');
    // Commits are capped at 20 by the log read itself.
    expect(log).toContain('-n20');
    // It never fetches.
    expect(gitCalls().some((args) => args[0] === 'fetch' || args[0] === 'pull')).toBe(false);
  });

  // Red-green: the order of `[`origin/${baseBranch}`, baseBranch]` in
  // `readRecapGitState`. Swap them and `main` is verified first.
  it('tries origin/<base> first, then <base> when the remote form is not there', async () => {
    stubGit((args) => {
      if (isBranchRead(args)) return 'fix-login\n';
      if (isVerify(args)) return args.at(-1) === 'origin/main' ? new Error('not a valid ref') : 'def456\n';
      if (isLog(args)) return 'c1 First change\n';
      if (isStatus(args)) return '';
      return new Error(`unexpected git ${args.join(' ')}`);
    });
    const sources = createExpiredRecapSources('project-1');

    const state = await sources.readGitState!('/mock/worktree', 'main');

    const verified = gitCalls().filter(isVerify).map((args) => args.at(-1));
    expect(verified).toEqual(['origin/main', 'main']);
    expect(gitCalls().find(isLog)).toContain('main..HEAD');
    expect(state).toEqual({ branch: 'fix-login', commits: ['c1 First change'], changes: [] });
  });

  it('moves on to <base> when origin/<base> verifies to nothing', async () => {
    stubGit((args) => {
      if (isBranchRead(args)) return 'fix-login\n';
      if (isVerify(args)) return args.at(-1) === 'origin/main' ? '\n' : 'def456\n';
      if (isLog(args)) return 'c1 First change\n';
      if (isStatus(args)) return '';
      return new Error(`unexpected git ${args.join(' ')}`);
    });
    const sources = createExpiredRecapSources('project-1');

    const state = await sources.readGitState!('/mock/worktree', 'main');

    expect(gitCalls().filter(isVerify).map((args) => args.at(-1))).toEqual(['origin/main', 'main']);
    expect(state?.commits).toEqual(['c1 First change']);
  });

  it('answers no commits, but still the branch and changes, when neither form of the base exists', async () => {
    stubGit((args) => {
      if (isBranchRead(args)) return 'fix-login\n';
      if (isVerify(args)) return new Error('not a valid ref');
      if (isStatus(args)) return ' M a.ts\n';
      return new Error(`unexpected git ${args.join(' ')}`);
    });
    const sources = createExpiredRecapSources('project-1');

    const state = await sources.readGitState!('/mock/worktree', 'develop');

    expect(state).toEqual({ branch: 'fix-login', commits: [], changes: [' M a.ts'] });
    expect(gitCalls().filter(isVerify).map((args) => args.at(-1))).toEqual(['origin/develop', 'develop']);
    expect(gitCalls().some(isLog)).toBe(false);
  });

  // Red-green: `MAX_CHANGES` in expired-recap-sources.ts (30). Make it 31 and
  // the change list is one longer.
  it('caps the uncommitted changes at 30, keeping the first ones', async () => {
    const statusLines = Array.from({ length: 40 }, (_unused, index) => ` M src/file-${index}.ts`);
    stubGit((args) => {
      if (isBranchRead(args)) return 'fix-login\n';
      if (isVerify(args)) return 'abc123\n';
      if (isLog(args)) return '';
      if (isStatus(args)) return `${statusLines.join('\n')}\n`;
      return new Error(`unexpected git ${args.join(' ')}`);
    });
    const sources = createExpiredRecapSources('project-1');

    const state = await sources.readGitState!('/mock/worktree', 'main');

    expect(state?.changes).toHaveLength(30);
    expect(state?.changes[0]).toBe(' M src/file-0.ts');
    expect(state?.changes[29]).toBe(' M src/file-29.ts');
  });

  // Red-green: `MAX_COMMITS` (20), which reaches git as `-n20`. Make it 21 and
  // the log read asks for 21.
  it('asks git for at most 20 commits', async () => {
    stubGit((args) => {
      if (isBranchRead(args)) return 'fix-login\n';
      if (isVerify(args)) return 'abc123\n';
      if (isLog(args)) return 'c1 First change\n';
      if (isStatus(args)) return '';
      return new Error(`unexpected git ${args.join(' ')}`);
    });
    const sources = createExpiredRecapSources('project-1');

    await sources.readGitState!('/mock/worktree', 'main');

    const log = gitCalls().find(isLog) ?? [];
    expect(log).toContain('-n20');
    expect(log.some((argument) => /^-n(?!20$)\d+$/.test(argument))).toBe(false);
  });

  // Red-green: the `catch { return null; }` around the branch read. Continue
  // instead and a directory that is not a checkout answers a state.
  it('answers null when the branch cannot be read, which is a directory that is not a checkout', async () => {
    stubGit((args) => (isBranchRead(args) ? new Error('fatal: not a git repository') : 'unused'));
    const sources = createExpiredRecapSources('project-1');

    expect(await sources.readGitState!('/mock/not-a-checkout', 'main')).toBeNull();
    expect(gitCalls().some((args) => isVerify(args) || isLog(args) || isStatus(args))).toBe(false);
  });

  it('keeps the branch and commits when the status read fails', async () => {
    stubGit((args) => {
      if (isBranchRead(args)) return 'fix-login\n';
      if (isVerify(args)) return 'abc123\n';
      if (isLog(args)) return 'c1 First change\n';
      return new Error('status failed');
    });
    const sources = createExpiredRecapSources('project-1');

    expect(await sources.readGitState!('/mock/worktree', 'main')).toEqual({
      branch: 'fix-login', commits: ['c1 First change'], changes: [],
    });
  });

  it('answers null after 3,000 ms when git does not answer, and leaves worker reads alone', async () => {
    gitMock.runGitCommand.mockImplementation(() => new Promise(() => undefined));
    retrievalMock.call.mockResolvedValue('a summary');
    const sources = createExpiredRecapSources('project-1');

    const state = watch(sources.readGitState!('/mock/worktree', 'main'));
    await vi.advanceTimersByTimeAsync(GIT_WAIT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.value).toBeNull();

    // A git wait that ran out is not the worker's: the worker is still asked.
    expect(await sources.readTaskSummary!('task-1')).toBe('a summary');
  });
});
