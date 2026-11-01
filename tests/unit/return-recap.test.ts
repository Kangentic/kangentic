/**
 * The return recap's pure core (src/main/transition-engine/return-recap.ts,
 * task #952): what a task's main conversation is told when it resumes after an
 * isolated column's session ran in its own conversation.
 *
 * Plain fakes for the three sources (git range, final reply, column names), so
 * these pin the gather, the wording and the budget with no spawn, no database
 * and no git. The wiring into the resume is spawn-agent-return-recap.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RETURN_RECAP_COMMIT_LIMIT,
  formatReturnRecap,
  gatherReturnRecap,
  mainConversationLeftAt,
  returnRecapOpeningFor,
  withinBudget,
  type ReturnRecapFacts,
  type ReturnRecapSources,
} from '../../src/main/transition-engine/return-recap';
import type { CommitsSince } from '../../src/main/git/worktree-head';
import type { IsolatedRunRecord } from '../../src/main/db/repositories/session-repository';

const CWD = '/mock/project/.kangentic/worktrees/export';
const INTRO_FOR_CODE_REVIEW = 'While this conversation was away, the task ran in Code Review in a conversation of its own, which you have not seen.';

function makeRun(overrides: Partial<IsolatedRunRecord> = {}): IsolatedRunRecord {
  return {
    id: 'run-1',
    isolated_swimlane_id: 'lane-review',
    agent_session_id: 'agent-1',
    start_head_sha: null,
    started_at: '2026-10-31T02:01:00.000Z',
    ...overrides,
  };
}

function makeCommits(overrides: Partial<CommitsSince> = {}): CommitsSince {
  return {
    head: 'ccccccc',
    commits: [{ sha: 'bbbbbbb', subject: 'fix(review): drop the unused export' }],
    omitted: 0,
    ...overrides,
  };
}

const COLUMN_NAMES: Record<string, string> = {
  'lane-review': 'Code Review',
  'lane-qa': 'QA',
  'lane-testing': 'Testing',
};

interface FakeSources extends ReturnRecapSources {
  readCommitsSince: ReturnType<typeof vi.fn<ReturnRecapSources['readCommitsSince']>>;
  readFinalReply: ReturnType<typeof vi.fn<ReturnRecapSources['readFinalReply']>>;
}

function makeSources(overrides: { commits?: CommitsSince | null; replyFor?: (run: IsolatedRunRecord) => string | null } = {}): FakeSources {
  return {
    readCommitsSince: vi.fn<ReturnRecapSources['readCommitsSince']>(async () => (overrides.commits === undefined ? makeCommits() : overrides.commits)),
    readFinalReply: vi.fn<ReturnRecapSources['readFinalReply']>(async (run) => (overrides.replyFor ? overrides.replyFor(run) : null)),
    columnName: (swimlaneId) => COLUMN_NAMES[swimlaneId] ?? null,
  };
}

function makeFacts(overrides: Partial<ReturnRecapFacts> = {}): ReturnRecapFacts {
  return { columns: ['Code Review'], commits: makeCommits(), replies: [], ...overrides };
}

describe('mainConversationLeftAt', () => {
  const STARTED = '2026-10-31T00:00:00.000Z';
  const SUSPENDED = '2026-10-31T02:00:00.000Z';
  const EXITED = '2026-10-31T01:00:00.000Z';

  it('is the suspend when the conversation was suspended, whatever else is recorded', () => {
    expect(mainConversationLeftAt({ started_at: STARTED, suspended_at: SUSPENDED, exited_at: EXITED })).toBe(SUSPENDED);
  });

  it('is the exit when it was never suspended', () => {
    expect(mainConversationLeftAt({ started_at: STARTED, suspended_at: null, exited_at: EXITED })).toBe(EXITED);
  });

  it('is the start when it neither suspended nor exited', () => {
    expect(mainConversationLeftAt({ started_at: STARTED, suspended_at: null, exited_at: null })).toBe(STARTED);
  });
});

describe('returnRecapOpeningFor', () => {
  it('acknowledges when there is no lead and no held messages, so the agent waits for what follows', () => {
    expect(returnRecapOpeningFor(undefined, false)).toBe('acknowledge');
    expect(returnRecapOpeningFor('', false)).toBe('acknowledge');
    expect(returnRecapOpeningFor('   \n', false)).toBe('acknowledge');
  });

  it('is a prefix with no lead when messages are held, since they follow the recap in one turn', () => {
    expect(returnRecapOpeningFor(undefined, true)).toBe('prefix');
    expect(returnRecapOpeningFor('  ', true)).toBe('prefix');
  });

  it('is a prefix ahead of a plain-text lead, held messages or not', () => {
    expect(returnRecapOpeningFor('Run the gate and open the PR.', false)).toBe('prefix');
    expect(returnRecapOpeningFor('Run the gate and open the PR.', true)).toBe('prefix');
  });

  it('is a prefix ahead of text that merely begins with a path, which is not a command', () => {
    expect(returnRecapOpeningFor('/usr/bin/tool crashed on startup', false)).toBe('prefix');
  });

  it('goes before a slash command, held messages or not, because text ahead of one stops it running', () => {
    expect(returnRecapOpeningFor('/pull-request', false)).toBe('before-command');
    expect(returnRecapOpeningFor('/pull-request', true)).toBe('before-command');
    expect(returnRecapOpeningFor('  /review --strict', false)).toBe('before-command');
  });
});

describe('formatReturnRecap', () => {
  it('words the whole recap for a slash command: commits, the reply, and a line to answer before the command', () => {
    const recap = formatReturnRecap(makeFacts({
      commits: makeCommits({
        commits: [
          { sha: 'bbbbbbb', subject: 'fix(review): drop the unused export' },
          { sha: 'ccccccc', subject: 'chore(review): record the pass' },
        ],
      }),
      replies: [{ column: 'Code Review', text: '1. Fixed the export.\nVerdict: Ready' }],
    }), 'before-command');

    expect(recap).toBe([
      INTRO_FOR_CODE_REVIEW,
      'It made these commits on the branch, oldest first:',
      '- bbbbbbb fix(review): drop the unused export',
      '- ccccccc chore(review): record the pass',
      'The branch is now at ccccccc.',
      '',
      'Code Review ended on this message:',
      '1. Fixed the export.',
      'Verdict: Ready',
      '',
      'Reply with one line saying you have read this. The next instruction follows once you do.',
    ].join('\n'));
  });

  it('ends on the facts for a prefix, which has the lead after it and asks for no reply', () => {
    const recap = formatReturnRecap(makeFacts(), 'prefix');

    expect(recap.endsWith('The branch is now at ccccccc.')).toBe(true);
    expect(recap).not.toContain('Reply with one line');
  });

  it('asks for a one-line answer and a wait when nothing follows the recap', () => {
    const recap = formatReturnRecap(makeFacts(), 'acknowledge');

    expect(recap.endsWith('\n\nReply with one line saying you have read this, then wait for the next instruction.')).toBe(true);
    expect(recap).not.toContain('The next instruction follows once you do.');
  });

  it('says "this commit" for exactly one commit', () => {
    const recap = formatReturnRecap(makeFacts(), 'prefix');

    expect(recap).toContain('It made this commit on the branch:\n- bbbbbbb fix(review): drop the unused export\nThe branch is now at ccccccc.');
    expect(recap).not.toContain('these commits');
  });

  it('says "these commits, oldest first" for two or more', () => {
    const recap = formatReturnRecap(makeFacts({
      commits: makeCommits({ commits: [{ sha: 'aaaaaaa', subject: 'one' }, { sha: 'bbbbbbb', subject: 'two' }] }),
    }), 'prefix');

    expect(recap).toContain('It made these commits on the branch, oldest first:');
    expect(recap).not.toContain('this commit');
  });

  it('counts the commits left out of the list toward the plural and names how many, ahead of the list', () => {
    const listed = Array.from({ length: RETURN_RECAP_COMMIT_LIMIT }, (_unused, index) => ({ sha: `sha${index}`, subject: `subject ${index}` }));
    const recap = formatReturnRecap(makeFacts({ commits: makeCommits({ commits: listed, omitted: 5 }) }), 'prefix');
    const lines = recap.split('\n');

    expect(lines[1]).toBe('It made these commits on the branch, oldest first:');
    expect(lines[2]).toBe('(5 earlier commits are not listed.)');
    expect(lines[3]).toBe('- sha0 subject 0');
    expect(lines).toContain('- sha19 subject 19');
    expect(lines.filter((line) => line.startsWith('- '))).toHaveLength(RETURN_RECAP_COMMIT_LIMIT);
  });

  it('uses the singular for one commit left out of the list', () => {
    const listed = Array.from({ length: RETURN_RECAP_COMMIT_LIMIT }, (_unused, index) => ({ sha: `sha${index}`, subject: `subject ${index}` }));
    const recap = formatReturnRecap(makeFacts({ commits: makeCommits({ commits: listed, omitted: 1 }) }), 'prefix');

    expect(recap).toContain('(1 earlier commit is not listed.)');
    expect(recap).not.toContain('commits are not listed');
  });

  it('says nothing about omitted commits when none were left out', () => {
    expect(formatReturnRecap(makeFacts(), 'prefix')).not.toContain('not listed');
  });

  it('says the session made no commits, and where the branch still is', () => {
    const recap = formatReturnRecap(makeFacts({ commits: makeCommits({ head: 'aaaaaaa', commits: [], omitted: 0 }) }), 'prefix');

    expect(recap).toContain('It made no commits. The branch is still at aaaaaaa.');
    expect(recap).not.toContain('It made this commit');
    expect(recap).not.toContain('The branch is now at');
  });

  it('says nothing about commits when git could not read the range', () => {
    const recap = formatReturnRecap(makeFacts({ commits: null, replies: [{ column: 'Code Review', text: 'Verdict: Ready' }] }), 'prefix');

    expect(recap).toBe([INTRO_FOR_CODE_REVIEW, '', 'Code Review ended on this message:', 'Verdict: Ready'].join('\n'));
  });

  it('keeps a subject-less commit line free of a trailing space', () => {
    const recap = formatReturnRecap(makeFacts({ commits: makeCommits({ commits: [{ sha: 'bbbbbbb', subject: '' }] }) }), 'prefix');

    expect(recap).toContain('\n- bbbbbbb\n');
  });

  it('quotes each column\'s final message under its own heading, oldest first', () => {
    const recap = formatReturnRecap(makeFacts({
      columns: ['Code Review', 'QA'],
      replies: [{ column: 'Code Review', text: 'Verdict: Blocked' }, { column: 'QA', text: 'Verdict: Ready' }],
    }), 'prefix');

    expect(recap.endsWith('\n\nCode Review ended on this message:\nVerdict: Blocked\n\nQA ended on this message:\nVerdict: Ready')).toBe(true);
  });

  it('joins two column names with "and"', () => {
    expect(formatReturnRecap(makeFacts({ columns: ['Code Review', 'QA'] }), 'prefix'))
      .toContain('the task ran in Code Review and QA in a conversation of its own');
  });

  it('joins three column names with commas and a final "and"', () => {
    expect(formatReturnRecap(makeFacts({ columns: ['Code Review', 'QA', 'Testing'] }), 'prefix'))
      .toContain('the task ran in Code Review, QA and Testing in a conversation of its own');
  });

  it('reads "another column" when no column name is known', () => {
    expect(formatReturnRecap(makeFacts({ columns: [] }), 'prefix'))
      .toContain('the task ran in another column in a conversation of its own');
  });
});

describe('gatherReturnRecap', () => {
  it('is null when no isolated session ran, and reads nothing', async () => {
    const sources = makeSources();

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns: [], includeReplies: true }, sources);

    expect(facts).toBeNull();
    expect(sources.readCommitsSince).not.toHaveBeenCalled();
    expect(sources.readFinalReply).not.toHaveBeenCalled();
  });

  it('is null when the sessions made no commits and left no message', async () => {
    const sources = makeSources({ commits: makeCommits({ commits: [], omitted: 0 }), replyFor: () => null });

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns: [makeRun({ start_head_sha: 'aaaaaaa1' })], includeReplies: true }, sources);

    expect(facts).toBeNull();
  });

  it('is null when no session recorded where it began and none left a message', async () => {
    const sources = makeSources();

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns: [makeRun({ start_head_sha: null })], includeReplies: true }, sources);

    expect(facts).toBeNull();
    expect(sources.readCommitsSince).not.toHaveBeenCalled();
  });

  it('anchors the commit range at the EARLIEST run that recorded its start HEAD', async () => {
    const sources = makeSources();
    const isolatedRuns = [
      // Recorded before start_head_sha existed.
      makeRun({ id: 'run-old', start_head_sha: null, started_at: '2026-10-31T01:00:00.000Z' }),
      makeRun({ id: 'run-first', start_head_sha: 'sha-first', started_at: '2026-10-31T02:00:00.000Z' }),
      makeRun({ id: 'run-second', start_head_sha: 'sha-second', started_at: '2026-10-31T03:00:00.000Z' }),
    ];

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns, includeReplies: false }, sources);

    expect(sources.readCommitsSince).toHaveBeenCalledTimes(1);
    expect(sources.readCommitsSince).toHaveBeenCalledWith(CWD, 'sha-first', RETURN_RECAP_COMMIT_LIMIT);
    expect(facts?.commits).toEqual(makeCommits());
  });

  it('lists at most 20 commits', async () => {
    const sources = makeSources();

    await gatherReturnRecap({ cwd: CWD, isolatedRuns: [makeRun({ start_head_sha: 'sha-first' })], includeReplies: false }, sources);

    expect(RETURN_RECAP_COMMIT_LIMIT).toBe(20);
    expect(sources.readCommitsSince.mock.calls[0][2]).toBe(20);
  });

  it('keeps a recap of commits alone when no session left a message', async () => {
    const sources = makeSources({ replyFor: () => null });

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns: [makeRun({ start_head_sha: 'sha-first' })], includeReplies: true }, sources);

    expect(facts).toEqual({ columns: ['Code Review'], commits: makeCommits(), replies: [] });
  });

  it('keeps a recap of a message alone when git could not read the range', async () => {
    const sources = makeSources({ commits: null, replyFor: () => 'Verdict: Ready' });

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns: [makeRun({ start_head_sha: 'sha-first' })], includeReplies: true }, sources);

    expect(facts).toEqual({ columns: ['Code Review'], commits: null, replies: [{ column: 'Code Review', text: 'Verdict: Ready' }] });
  });

  it('counts commits left out of the list as commits made', async () => {
    const sources = makeSources({ commits: makeCommits({ commits: [], omitted: 3 }) });

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns: [makeRun({ start_head_sha: 'sha-first' })], includeReplies: false }, sources);

    expect(facts).not.toBeNull();
  });

  it('keeps a "made no commits" recap when a session left a message', async () => {
    const sources = makeSources({ commits: makeCommits({ head: 'aaaaaaa', commits: [], omitted: 0 }), replyFor: () => 'Nothing to change. Verdict: Ready' });

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns: [makeRun({ start_head_sha: 'sha-first' })], includeReplies: true }, sources);

    expect(facts?.commits).toEqual({ head: 'aaaaaaa', commits: [], omitted: 0 });
    expect(formatReturnRecap(facts as ReturnRecapFacts, 'prefix')).toContain('It made no commits. The branch is still at aaaaaaa.');
  });

  it('reads no final message at all when the move carries its own', async () => {
    const sources = makeSources({ replyFor: () => 'Verdict: Ready' });

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns: [makeRun({ start_head_sha: 'sha-first' })], includeReplies: false }, sources);

    expect(sources.readFinalReply).not.toHaveBeenCalled();
    expect(facts?.replies).toEqual([]);
  });

  it('quotes only the latest three sessions\' final messages, oldest first', async () => {
    const isolatedRuns = [1, 2, 3, 4].map((number) => makeRun({
      id: `run-${number}`,
      isolated_swimlane_id: 'lane-review',
      start_head_sha: `sha-${number}`,
    }));
    const sources = makeSources({ replyFor: (run) => `reply of ${run.id}` });

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns, includeReplies: true }, sources);

    expect(sources.readFinalReply.mock.calls.map((call) => call[0].id)).toEqual(['run-2', 'run-3', 'run-4']);
    expect(facts?.replies.map((reply) => reply.text)).toEqual(['reply of run-2', 'reply of run-3', 'reply of run-4']);
  });

  it('names each column once, in the order it first ran', async () => {
    const isolatedRuns = [
      makeRun({ id: 'run-1', isolated_swimlane_id: 'lane-review', start_head_sha: 'sha-1' }),
      makeRun({ id: 'run-2', isolated_swimlane_id: 'lane-qa' }),
      makeRun({ id: 'run-3', isolated_swimlane_id: 'lane-review' }),
    ];

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns, includeReplies: false }, makeSources());

    expect(facts?.columns).toEqual(['Code Review', 'QA']);
  });

  it('reads a column that no longer resolves as "another column", once, for the name and for the quoted message', async () => {
    const isolatedRuns = [
      makeRun({ id: 'run-1', isolated_swimlane_id: 'lane-deleted', start_head_sha: 'sha-1' }),
      makeRun({ id: 'run-2', isolated_swimlane_id: null }),
    ];
    const sources = makeSources({ replyFor: (run) => (run.id === 'run-2' ? 'Verdict: Ready' : null) });

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns, includeReplies: true }, sources);

    expect(facts?.columns).toEqual(['another column']);
    expect(facts?.replies).toEqual([{ column: 'another column', text: 'Verdict: Ready' }]);
    expect(formatReturnRecap(facts as ReturnRecapFacts, 'prefix')).toContain('the task ran in another column in a conversation of its own');
  });

  it('trims a final message, and drops one that is only whitespace', async () => {
    const isolatedRuns = [
      makeRun({ id: 'run-1', start_head_sha: 'sha-1' }),
      makeRun({ id: 'run-2' }),
    ];
    const sources = makeSources({ replyFor: (run) => (run.id === 'run-1' ? '\n  Verdict: Ready  \n' : '   \n\t') });

    const facts = await gatherReturnRecap({ cwd: CWD, isolatedRuns, includeReplies: true }, sources);

    expect(facts?.replies).toEqual([{ column: 'Code Review', text: 'Verdict: Ready' }]);
  });

  describe('a long final message', () => {
    async function quotedReply(text: string): Promise<string> {
      const facts = await gatherReturnRecap(
        { cwd: CWD, isolatedRuns: [makeRun({ start_head_sha: 'sha-1' })], includeReplies: true },
        makeSources({ replyFor: () => text }),
      );
      return facts?.replies[0].text ?? '';
    }

    it('is quoted whole at exactly 1,500 characters', async () => {
      const text = 'x'.repeat(1_500);

      expect(await quotedReply(text)).toBe(text);
    });

    it('is cut back to the last word break and ends with an ellipsis once it passes 1,500', async () => {
      // 7-character words with their space: character 1,500 falls inside the
      // 215th word, whose space before it sits at index 1,497.
      const text = 'abcdef '.repeat(400).trimEnd();

      const quoted = await quotedReply(text);

      expect(quoted).toBe(`${'abcdef '.repeat(213)}abcdef...`);
      expect(quoted.length).toBeLessThanOrEqual(1_503);
    });

    it('is cut back to the last line break when that is the nearest one', async () => {
      // 98 characters and a break make 99: character 1,500 falls 15 characters
      // into the 16th line, whose break before it sits at index 1,484.
      const line = 'x'.repeat(98);
      const text = Array.from({ length: 30 }, () => line).join('\n');

      const quoted = await quotedReply(text);

      expect(quoted).toBe(`${Array.from({ length: 15 }, () => line).join('\n')}...`);
    });

    it('is cut hard at 1,500 characters with an ellipsis when it has no break at all', async () => {
      const quoted = await quotedReply('x'.repeat(2_000));

      expect(quoted).toBe(`${'x'.repeat(1_500)}...`);
    });

    it('is cut hard at 1,500 characters when its last break is too early to keep most of it', async () => {
      // The only space is at 100, well under 60% of the way to the cut.
      const text = `${'a'.repeat(100)} ${'b'.repeat(1_900)}`;

      const quoted = await quotedReply(text);

      expect(quoted).toBe(`${'a'.repeat(100)} ${'b'.repeat(1_399)}...`);
    });
  });
});

describe('withinBudget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value when the promise settles first, and leaves no timer behind', async () => {
    vi.useFakeTimers();

    const result = await withinBudget(Promise.resolve('value'), 3_000, 'fallback');

    expect(result).toBe('value');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back once the timeout passes first, and not a millisecond sooner', async () => {
    vi.useFakeTimers();
    let settledWith: string | null = null;
    const neverSettles = new Promise<string>(() => undefined);
    void withinBudget(neverSettles, 3_000, 'fallback').then((value) => { settledWith = value; });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(settledWith).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(settledWith).toBe('fallback');
  });

  it('keeps the fallback when the promise settles after the timeout', async () => {
    vi.useFakeTimers();
    let resolveLate: (value: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => { resolveLate = resolve; });
    const result = withinBudget(late, 1_000, 'fallback');

    await vi.advanceTimersByTimeAsync(1_000);
    resolveLate('late value');

    expect(await result).toBe('fallback');
  });

  it('falls back at once, without rejecting, when the promise rejects', async () => {
    vi.useFakeTimers();

    const result = await withinBudget(Promise.reject(new Error('git could not read the range')), 3_000, 'fallback');

    expect(result).toBe('fallback');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to null for a recap that cannot be built in time', async () => {
    vi.useFakeTimers();
    let settledWith: ReturnRecapFacts | null | undefined;
    const slowGather = new Promise<ReturnRecapFacts | null>(() => undefined);
    void withinBudget(slowGather, 3_000, null).then((value) => { settledWith = value; });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(settledWith).toBeNull();
  });
});
