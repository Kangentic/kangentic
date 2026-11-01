/**
 * Claude Code's own background sessions (`/bg`), which outlive the task's PTY.
 *
 * `stopClaudeBackgroundSession` lists them with `claude agents --json` and
 * stops the live one holding the conversation with `claude stop <id>`.
 * Measured on 2.1.316: the listing covers every session on the machine, of
 * every project, so the match is the full session id and `kind: background`
 * only; `pid` is listed only while the process is alive.
 *
 * `resolveClaudeResumableSessionId` answers which id a `--resume` reaches: a
 * fork that has not taken a turn holds only its title and name, and
 * `--resume <fork>` answered "No conversation found" while the conversation
 * it continued (named by its `continued-in` record) resumed.
 *
 * `claudeBackgroundSessionOf` is the CLI-free gate a Command Terminal's end and
 * an Earlier resume read: the session the conversation's own transcript ends by
 * continuing in, or the id itself when another transcript continues in it.
 *
 * Test tier: Unit. The CLI runner and the transcript locator are mocked; the
 * transcripts are real files under os.tmpdir().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runClaudeCli = vi.fn<(cliPath: string, cliArgs: readonly string[], timeoutMs: number) => Promise<string>>();
vi.mock('../../src/main/agent/adapters/claude/cli-run', () => ({ runClaudeCli }));

const findClaudeTranscriptFile = vi.fn<(query: { agentSessionId: string }) => Promise<string | null>>();
/** The folder the cwd maps to, where the real locator's fallback path points. */
let derivedFolder = os.tmpdir();
// As the real one: the transcript where it is found, else the path the cwd derives.
const resolveClaudeTranscriptFile = vi.fn(async (query: { agentSessionId: string }) =>
  (await findClaudeTranscriptFile(query)) ?? path.join(derivedFolder, `${query.agentSessionId}.jsonl`));
vi.mock('../../src/main/agent/adapters/claude/transcript-locator', () => ({ findClaudeTranscriptFile, resolveClaudeTranscriptFile }));

const {
  stopClaudeBackgroundSession,
  resolveClaudeResumableSessionId,
  claudeConfirmsBackgroundMove,
  claudeBackgroundSessionOf,
} = await import('../../src/main/agent/adapters/claude/background-sessions');

const CLI_PATH = 'C:\\Users\\dev\\.local\\bin\\claude.exe';
const MOVED = '8c4cb30b-352c-4d33-ba24-3c53324bfd49';
const ORIGINAL = '6e21471d-887a-42d3-97d3-fcfedac9dd51';
const OTHER = '0005843e-b5d5-4bc9-8a45-38ae97f6cdc2';

// These mirror STOP_SETTLE_POLL_MS, STOP_BUDGET_MS and MAX_PREDECESSOR_HOPS in
// background-sessions.ts. They are restated here on purpose: a test that imported
// the constant could not notice the constant being changed.
const STOP_SETTLE_POLL_MS = 250;
const STOP_BUDGET_MS = 10_000;
const PREDECESSOR_HOP_LIMIT = 4;

function listing(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify(entries);
}

describe('stopClaudeBackgroundSession', () => {
  beforeEach(() => {
    runClaudeCli.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the live background session holding the conversation, by its short id, and waits until it is gone', async () => {
    const live = listing([
      { pid: 61392, id: '8c4cb30b', cwd: 'C:\\work', kind: 'background', sessionId: MOVED, state: 'blocked' },
      { pid: 29628, cwd: 'C:\\work', kind: 'interactive', sessionId: ORIGINAL, status: 'idle' },
    ]);
    const gone = listing([
      { id: '8c4cb30b', cwd: 'C:\\work', kind: 'background', sessionId: MOVED, state: 'stopped' },
    ]);
    runClaudeCli
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce('stopped 8c4cb30b\n')
      .mockResolvedValueOnce(gone);

    await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(true);
    expect(runClaudeCli.mock.calls.map((call) => call[1])).toEqual([
      ['agents', '--json'],
      ['stop', '8c4cb30b'],
      ['agents', '--json'],
    ]);
    expect(runClaudeCli.mock.calls.every((call) => call[0] === CLI_PATH)).toBe(true);
  });

  it('stops nothing for an interactive session, another conversation, or a session already stopped', async () => {
    runClaudeCli.mockResolvedValueOnce(listing([
      { pid: 29628, cwd: 'C:\\work', kind: 'interactive', sessionId: MOVED, status: 'idle' },
      { pid: 8532, id: '0005843e', cwd: 'C:\\work', kind: 'background', sessionId: OTHER, state: 'working' },
      { id: '8c4cb30b', cwd: 'C:\\work', kind: 'background', sessionId: MOVED, state: 'stopped' },
    ]));

    await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(false);
    expect(runClaudeCli).toHaveBeenCalledTimes(1);
  });

  it('never passes a short id that is not a plain word to the CLI', async () => {
    runClaudeCli.mockResolvedValueOnce(listing([
      { pid: 1, id: '8c4cb30b & calc', kind: 'background', sessionId: MOVED, state: 'working' },
    ]));

    await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(false);
    expect(runClaudeCli).toHaveBeenCalledTimes(1);
  });

  it('reads a failed listing, unexpected output, or a failed stop as nothing stopped, without throwing', async () => {
    runClaudeCli.mockRejectedValueOnce(new Error('spawn ENOENT'));
    await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(false);

    runClaudeCli.mockResolvedValueOnce('not json');
    await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(false);

    runClaudeCli.mockResolvedValueOnce('{"sessions":[]}');
    await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(false);

    runClaudeCli
      .mockResolvedValueOnce(listing([{ pid: 61392, id: '8c4cb30b', kind: 'background', sessionId: MOVED }]))
      .mockRejectedValueOnce(new Error('Command failed: claude stop 8c4cb30b'));
    await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(false);
  });

  // tests/fixtures/claude-background-move/agents-list.json is a sanitized live
  // capture from Claude Code 2.1.316 (only `cwd` replaced): a task moved with
  // `/bg` and still alive, an interactive terminal, and a background session
  // `claude stop` ended. It was captured with `--all`, because the plain
  // `claude agents --json` the stop runs leaves stopped sessions out (measured
  // the same minute); the entries share one shape. The synthetic listings above
  // prove the logic; this proves it reads the fields Claude Code really prints.
  describe('a listing captured from Claude Code 2.1.316', () => {
    const CAPTURED_LIVE = '59769594-7995-49c4-9410-5a1b408802b9';
    const CAPTURED_INTERACTIVE = 'c32d75aa-9c51-4693-85d6-7b36c4a5658a';
    const CAPTURED_STOPPED = 'a5d43424-eaa8-4b41-b6e3-f4b758bc4de8';
    const capturedListing = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-background-move', 'agents-list.json'), 'utf8');

    /** The captured listing once the live session is stopped: as Claude lists the stopped one, with no `pid`. */
    function afterStop(): string {
      const entries = JSON.parse(capturedListing) as Array<Record<string, unknown>>;
      return JSON.stringify(entries.map((entry) => {
        if (entry.sessionId !== CAPTURED_LIVE) return entry;
        const { pid: _pid, status: _status, ...rest } = entry;
        return { ...rest, state: 'stopped' };
      }));
    }

    it('holds the three kinds of entry it was captured to hold', () => {
      const entries = JSON.parse(capturedListing) as Array<{ kind: string; sessionId: string; pid?: number; state?: string }>;
      expect(entries.map((entry) => [entry.sessionId, entry.kind, typeof entry.pid, entry.state])).toEqual([
        [CAPTURED_STOPPED, 'background', 'undefined', 'stopped'],
        [CAPTURED_INTERACTIVE, 'interactive', 'number', undefined],
        [CAPTURED_LIVE, 'background', 'number', 'blocked'],
      ]);
    });

    it('stops the live /bg session by the short id Claude Code listed for it', async () => {
      runClaudeCli
        .mockResolvedValueOnce(capturedListing)
        .mockResolvedValueOnce('stopped 59769594\n')
        .mockResolvedValueOnce(afterStop());

      await expect(stopClaudeBackgroundSession({ agentSessionId: CAPTURED_LIVE, cliPath: CLI_PATH })).resolves.toBe(true);
      expect(runClaudeCli.mock.calls.map((call) => call[1])).toEqual([
        ['agents', '--json'],
        ['stop', '59769594'],
        ['agents', '--json'],
      ]);
    });

    it('stops nothing for the interactive terminal or the stopped session', async () => {
      runClaudeCli.mockResolvedValue(capturedListing);

      await expect(stopClaudeBackgroundSession({ agentSessionId: CAPTURED_INTERACTIVE, cliPath: CLI_PATH })).resolves.toBe(false);
      await expect(stopClaudeBackgroundSession({ agentSessionId: CAPTURED_STOPPED, cliPath: CLI_PATH })).resolves.toBe(false);
      expect(runClaudeCli.mock.calls.every((call) => call[1][0] === 'agents')).toBe(true);
    });
  });

  describe('waiting for the stopped session to leave the listing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('lists again every 250 ms while the stopped entry is alive, and resolves true once it is gone', async () => {
      const alive = listing([{ pid: 61392, id: '8c4cb30b', kind: 'background', sessionId: MOVED, state: 'working' }]);
      const gone = listing([{ id: '8c4cb30b', kind: 'background', sessionId: MOVED, state: 'stopped' }]);
      runClaudeCli
        .mockResolvedValueOnce(alive)
        .mockResolvedValueOnce('stopped 8c4cb30b\n')
        .mockResolvedValueOnce(alive)
        .mockResolvedValueOnce(alive)
        .mockResolvedValueOnce(gone);

      const outcome: { result?: boolean } = {};
      const pending = stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })
        .then((result) => {
          outcome.result = result;
          return result;
        });

      // The first listing, the stop, and the first settle listing need no timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(runClaudeCli).toHaveBeenCalledTimes(3);
      expect(outcome.result).toBeUndefined();

      // The entry was alive, so nothing lists again before a full poll interval.
      await vi.advanceTimersByTimeAsync(STOP_SETTLE_POLL_MS - 1);
      expect(runClaudeCli).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(runClaudeCli).toHaveBeenCalledTimes(4);
      expect(outcome.result).toBeUndefined();

      // Still alive on the second settle listing: one more interval, then the third shows it gone.
      await vi.advanceTimersByTimeAsync(STOP_SETTLE_POLL_MS);
      expect(runClaudeCli).toHaveBeenCalledTimes(5);
      await expect(pending).resolves.toBe(true);
      expect(outcome.result).toBe(true);

      expect(runClaudeCli.mock.calls.map((call) => call[1])).toEqual([
        ['agents', '--json'],
        ['stop', '8c4cb30b'],
        ['agents', '--json'],
        ['agents', '--json'],
        ['agents', '--json'],
      ]);
      // Gone on the third settle listing: it ends the wait, so no timer is left running.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves true and warns once, naming the 10 s budget, when the entry never leaves the listing', async () => {
      const warn = vi.mocked(console.warn);
      const alive = listing([{ pid: 61392, id: '8c4cb30b', kind: 'background', sessionId: MOVED, state: 'working' }]);
      runClaudeCli.mockImplementation(async (_cliPath, cliArgs) => (cliArgs[0] === 'stop' ? 'stopped 8c4cb30b\n' : alive));

      const outcome: { result?: boolean } = {};
      const pending = stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })
        .then((result) => {
          outcome.result = result;
          return result;
        });

      // One millisecond short of the budget the wait is still going and has said nothing.
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS - 1);
      expect(outcome.result).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/10[,_]?000\s*ms|\b10\s*s(econds)?\b/);

      // The stop ran once, and no step was handed more time than the budget had left.
      const stopCalls = runClaudeCli.mock.calls.filter((call) => call[1][0] === 'stop');
      expect(stopCalls).toHaveLength(1);
      const lastCall = runClaudeCli.mock.calls[runClaudeCli.mock.calls.length - 1];
      expect(lastCall[2]).toBeGreaterThanOrEqual(1);
      expect(lastCall[2]).toBeLessThanOrEqual(STOP_SETTLE_POLL_MS);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('stops every live background session holding the conversation, each by its own short id', async () => {
    runClaudeCli
      .mockResolvedValueOnce(listing([
        { pid: 101, id: 'aaaa1111', kind: 'background', sessionId: MOVED, state: 'working' },
        { pid: 102, id: 'bbbb2222', kind: 'background', sessionId: MOVED, state: 'blocked' },
        { pid: 103, id: 'cccc3333', kind: 'background', sessionId: OTHER, state: 'working' },
      ]))
      .mockResolvedValueOnce('stopped aaaa1111\n')
      .mockResolvedValueOnce('stopped bbbb2222\n')
      .mockResolvedValueOnce(listing([
        { id: 'aaaa1111', kind: 'background', sessionId: MOVED, state: 'stopped' },
        { id: 'bbbb2222', kind: 'background', sessionId: MOVED, state: 'stopped' },
        { pid: 103, id: 'cccc3333', kind: 'background', sessionId: OTHER, state: 'working' },
      ]));

    await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(true);
    expect(runClaudeCli.mock.calls.map((call) => call[1])).toEqual([
      ['agents', '--json'],
      ['stop', 'aaaa1111'],
      ['stop', 'bbbb2222'],
      ['agents', '--json'],
    ]);
  });

  describe('when a CLI call fails', () => {
    const live = listing([{ pid: 61392, id: '8c4cb30b', kind: 'background', sessionId: MOVED, state: 'working' }]);

    // After `claude stop` ran, the conversation is as stopped as it will get: the
    // caller must go on (resume, suspend), so a listing that cannot confirm the end
    // still reads as true, and logs why.
    describe('after claude stop ran', () => {
      it.each([
        ['the settle listing rejects', () => runClaudeCli.mockRejectedValueOnce(new Error('spawn ENOENT'))],
        ['the settle listing prints invalid JSON', () => runClaudeCli.mockResolvedValueOnce('not json')],
        ['the settle listing prints something other than a list', () => runClaudeCli.mockResolvedValueOnce('{"sessions":[]}')],
      ])('resolves true when %s', async (_label, queueSettleListing) => {
        const warn = vi.mocked(console.warn);
        runClaudeCli
          .mockResolvedValueOnce(live)
          .mockResolvedValueOnce('stopped 8c4cb30b\n');
        queueSettleListing();

        await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(true);
        expect(runClaudeCli.mock.calls.map((call) => call[1])).toEqual([
          ['agents', '--json'],
          ['stop', '8c4cb30b'],
          ['agents', '--json'],
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
      });

      it('resolves true when a later stop fails after an earlier one ran', async () => {
        runClaudeCli
          .mockResolvedValueOnce(listing([
            { pid: 101, id: 'aaaa1111', kind: 'background', sessionId: MOVED },
            { pid: 102, id: 'bbbb2222', kind: 'background', sessionId: MOVED },
          ]))
          .mockResolvedValueOnce('stopped aaaa1111\n')
          .mockRejectedValueOnce(new Error('Command failed: claude stop bbbb2222'));

        await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(true);
        expect(runClaudeCli).toHaveBeenCalledTimes(3);
      });
    });

    describe('before any stop ran', () => {
      it.each([
        ['the listing rejects', () => runClaudeCli.mockRejectedValueOnce(new Error('spawn ENOENT'))],
        ['the listing prints invalid JSON', () => runClaudeCli.mockResolvedValueOnce('not json')],
        ['the listing prints something other than a list', () => runClaudeCli.mockResolvedValueOnce('{"sessions":[]}')],
      ])('resolves false, and runs no stop, when %s', async (_label, queueListing) => {
        queueListing();

        await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(false);
        expect(runClaudeCli).toHaveBeenCalledTimes(1);
        expect(runClaudeCli.mock.calls[0][1]).toEqual(['agents', '--json']);
      });

      it('resolves false when the first stop itself fails', async () => {
        runClaudeCli
          .mockResolvedValueOnce(live)
          .mockRejectedValueOnce(new Error('Command failed: claude stop 8c4cb30b'));

        await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(false);
        expect(runClaudeCli).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('a short id that starts with a dash', () => {
    it.each(['-h', '--all'])('is never passed to claude stop (%s), and nothing is stopped', async (dashedId) => {
      runClaudeCli.mockResolvedValueOnce(listing([
        { pid: 61392, id: dashedId, kind: 'background', sessionId: MOVED, state: 'working' },
      ]));

      await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(false);
      expect(runClaudeCli).toHaveBeenCalledTimes(1);
      expect(runClaudeCli.mock.calls.some((call) => call[1].includes(dashedId))).toBe(false);
      expect(runClaudeCli.mock.calls.some((call) => call[1][0] === 'stop')).toBe(false);
    });

    it('is skipped while a plain id holding the same conversation is still stopped', async () => {
      runClaudeCli
        .mockResolvedValueOnce(listing([
          { pid: 101, id: '--all', kind: 'background', sessionId: MOVED },
          { pid: 102, id: '8c4cb30b', kind: 'background', sessionId: MOVED },
        ]))
        .mockResolvedValueOnce('stopped 8c4cb30b\n')
        .mockResolvedValueOnce(listing([
          { id: '8c4cb30b', kind: 'background', sessionId: MOVED, state: 'stopped' },
        ]));

      await expect(stopClaudeBackgroundSession({ agentSessionId: MOVED, cliPath: CLI_PATH })).resolves.toBe(true);
      expect(runClaudeCli.mock.calls.map((call) => call[1])).toEqual([
        ['agents', '--json'],
        ['stop', '8c4cb30b'],
        ['agents', '--json'],
      ]);
    });
  });
});

describe('resolveClaudeResumableSessionId', () => {
  let projectsFolder: string;

  function writeTranscript(agentSessionId: string, records: Array<Record<string, unknown>>): string {
    const filePath = path.join(projectsFolder, `${agentSessionId}.jsonl`);
    fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    return filePath;
  }

  const metadataOnly = (agentSessionId: string) => [
    { type: 'ai-title', aiTitle: 'Background resume rig', sessionId: agentSessionId },
    { type: 'agent-name', agentName: 'Background resume rig', sessionId: agentSessionId },
  ];
  const withTurn = (agentSessionId: string) => [
    { type: 'user', message: { role: 'user', content: 'Reply with the single word ok.' }, sessionId: agentSessionId },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, sessionId: agentSessionId },
  ];

  beforeEach(() => {
    projectsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-claude-bg-'));
    derivedFolder = projectsFolder;
    findClaudeTranscriptFile.mockReset();
    findClaudeTranscriptFile.mockImplementation(async ({ agentSessionId }) => {
      const filePath = path.join(projectsFolder, `${agentSessionId}.jsonl`);
      return fs.existsSync(filePath) ? filePath : null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectsFolder, { recursive: true, force: true });
  });

  it('resumes a fork that took no turn by the conversation it continued', async () => {
    writeTranscript(MOVED, metadataOnly(MOVED));
    writeTranscript(ORIGINAL, [
      ...withTurn(ORIGINAL),
      { type: 'cost-state', totalCostUSD: 0.07 },
      { type: 'continued-in', continuedInSessionId: MOVED, timestamp: '2026-10-31T22:45:31.000Z' },
    ]);
    writeTranscript(OTHER, withTurn(OTHER));

    await expect(resolveClaudeResumableSessionId({ agentSessionId: MOVED, cwd: 'C:\\work' })).resolves.toBe(ORIGINAL);
  });

  it('resumes a fork that has not written its own transcript yet by the conversation it continued', async () => {
    writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: MOVED }]);

    await expect(resolveClaudeResumableSessionId({ agentSessionId: MOVED, cwd: 'C:\\work' })).resolves.toBe(ORIGINAL);
  });

  it('keeps a fork that has taken a turn: its transcript holds the conversation', async () => {
    writeTranscript(MOVED, [...metadataOnly(MOVED), ...withTurn(MOVED)]);
    writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: MOVED }]);

    await expect(resolveClaudeResumableSessionId({ agentSessionId: MOVED, cwd: 'C:\\work' })).resolves.toBe(MOVED);
  });

  // The head read is cut at 64 KB, which can end inside the first turn's record
  // when that prompt is long (a pasted file, a long brief). A record cut in two
  // does not parse, so the head shows no turn. It still shows more than a fork
  // with no turn holds, a title and a name of a few hundred bytes.
  it('keeps a fork whose first turn is longer than the 64 KB read of its head', async () => {
    const headBytes = 64 * 1024;
    const fork = writeTranscript(MOVED, [
      ...metadataOnly(MOVED),
      { type: 'user', message: { role: 'user', content: 'x'.repeat(80 * 1024) }, sessionId: MOVED },
    ]);
    // The premise: the turn runs past the head read, so only a cut record is in it.
    expect(fs.statSync(fork).size).toBeGreaterThan(headBytes);
    writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: MOVED }]);

    await expect(resolveClaudeResumableSessionId({ agentSessionId: MOVED, cwd: 'C:\\work' })).resolves.toBe(MOVED);
  });

  it('keeps the id when nothing proves a predecessor, or the transcript is missing', async () => {
    writeTranscript(MOVED, metadataOnly(MOVED));
    writeTranscript(OTHER, [...withTurn(OTHER), { type: 'continued-in', continuedInSessionId: 'someone-else' }]);
    await expect(resolveClaudeResumableSessionId({ agentSessionId: MOVED, cwd: 'C:\\work' })).resolves.toBe(MOVED);

    await expect(resolveClaudeResumableSessionId({ agentSessionId: ORIGINAL, cwd: 'C:\\work' })).resolves.toBe(ORIGINAL);
  });

  it('follows a fork of a fork back to the conversation with turns', async () => {
    const secondFork = 'a46702f2-f4fa-4fb4-9a74-2f6226497882';
    writeTranscript(secondFork, metadataOnly(secondFork));
    writeTranscript(MOVED, [...metadataOnly(MOVED), { type: 'continued-in', continuedInSessionId: secondFork }]);
    writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: MOVED }]);

    await expect(resolveClaudeResumableSessionId({ agentSessionId: secondFork, cwd: 'C:\\work' })).resolves.toBe(ORIGINAL);
  });

  it('follows at most four predecessors back through a chain of six metadata-only forks', async () => {
    // fork-0 was moved into fork-1, fork-1 into fork-2, and so on up to fork-5, and none
    // has taken a turn. Starting from fork-5, the walk's fourth step lands on fork-1; the
    // fifth would reach fork-0.
    const forkIds = Array.from({ length: 6 }, (_unused, index) => `fork-${index}-0000-4000-8000-000000000000`);
    forkIds.forEach((forkId, index) => {
      const nextForkId = forkIds[index + 1];
      writeTranscript(forkId, [
        ...metadataOnly(forkId),
        ...(nextForkId ? [{ type: 'continued-in', continuedInSessionId: nextForkId }] : []),
      ]);
    });

    await expect(resolveClaudeResumableSessionId({ agentSessionId: forkIds[5], cwd: 'C:\\work' })).resolves.toBe(forkIds[1]);
  });

  it('terminates on a cycle of metadata-only forks that continue in each other', async () => {
    const cycleA = 'cycle-a-0000-4000-8000-000000000000';
    const cycleB = 'cycle-b-0000-4000-8000-000000000000';
    writeTranscript(cycleA, [...metadataOnly(cycleA), { type: 'continued-in', continuedInSessionId: cycleB }]);
    writeTranscript(cycleB, [...metadataOnly(cycleB), { type: 'continued-in', continuedInSessionId: cycleA }]);

    const resolved = await resolveClaudeResumableSessionId({ agentSessionId: cycleB, cwd: 'C:\\work' });

    expect([cycleA, cycleB]).toContain(resolved);
    // A walk with no bound never returns, so a finite lookup count is what proves it stops.
    expect(findClaudeTranscriptFile.mock.calls.length).toBeLessThanOrEqual(PREDECESSOR_HOP_LIMIT);
  });

  it('keeps the id when the locator throws', async () => {
    findClaudeTranscriptFile.mockRejectedValueOnce(new Error('EACCES'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolveClaudeResumableSessionId({ agentSessionId: MOVED, cwd: 'C:\\work' })).resolves.toBe(MOVED);
  });

  // The gate a Command Terminal's end and an Earlier resume put in front of the
  // CLI: file reads only, so it must never run one.
  describe('claudeBackgroundSessionOf', () => {
    beforeEach(() => runClaudeCli.mockClear());

    it('names the session itself when a transcript in its folder continued in it, with no CLI run', async () => {
      writeTranscript(MOVED, [...metadataOnly(MOVED), ...withTurn(MOVED)]);
      writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: MOVED }]);
      writeTranscript(OTHER, withTurn(OTHER));

      await expect(claudeBackgroundSessionOf({ agentSessionId: MOVED, cwd: 'C:\\work' })).resolves.toBe(MOVED);
      expect(runClaudeCli).not.toHaveBeenCalled();
    });

    // A terminal stopped between /bg and the live switch still holds the id the
    // move left, and so does the only Earlier row of a move whose background
    // session wrote no transcript. Red-green: reading only the backward record
    // misses both, and the background session keeps running.
    it('names the session the conversation moved on to, from its own transcript', async () => {
      writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: MOVED }]);

      await expect(claudeBackgroundSessionOf({ agentSessionId: ORIGINAL, cwd: 'C:\\work' })).resolves.toBe(MOVED);
      expect(runClaudeCli).not.toHaveBeenCalled();
    });

    it('follows a conversation moved twice to the session that holds it now, and stops on a cycle', async () => {
      const secondMove = 'a46702f2-f4fa-4fb4-9a74-2f6226497882';
      writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: MOVED }]);
      writeTranscript(MOVED, [...metadataOnly(MOVED), ...withTurn(MOVED), { type: 'continued-in', continuedInSessionId: secondMove }]);
      await expect(claudeBackgroundSessionOf({ agentSessionId: ORIGINAL, cwd: 'C:\\work' })).resolves.toBe(secondMove);

      writeTranscript(secondMove, [...metadataOnly(secondMove), { type: 'continued-in', continuedInSessionId: MOVED }]);
      await expect(claudeBackgroundSessionOf({ agentSessionId: ORIGINAL, cwd: 'C:\\work' })).resolves.toBe(secondMove);
    });

    it('names nothing for a conversation resumed after the move, a /fork copy, an ordinary conversation, or a missing transcript', async () => {
      writeTranscript(MOVED, metadataOnly(MOVED));
      // `--resume` of the conversation the move left appends to it: it holds the conversation again.
      writeTranscript(ORIGINAL, [
        ...withTurn(ORIGINAL),
        { type: 'continued-in', continuedInSessionId: MOVED },
        { type: 'permission-mode', permissionMode: 'default', sessionId: ORIGINAL },
      ]);
      writeTranscript(OTHER, withTurn(OTHER));
      const forkCopy = 'c0f9e5a1-1111-4d5c-9b1e-2a6f0d3c4b5e';
      writeTranscript(forkCopy, metadataOnly(forkCopy));

      await expect(claudeBackgroundSessionOf({ agentSessionId: ORIGINAL, cwd: 'C:\\work' })).resolves.toBeNull();
      await expect(claudeBackgroundSessionOf({ agentSessionId: forkCopy, cwd: 'C:\\work' })).resolves.toBeNull();
      await expect(claudeBackgroundSessionOf({ agentSessionId: OTHER, cwd: 'C:\\work' })).resolves.toBeNull();
      await expect(claudeBackgroundSessionOf({ agentSessionId: 'no-such-conversation', cwd: 'C:\\work' })).resolves.toBeNull();
      expect(runClaudeCli).not.toHaveBeenCalled();
    });

    it('never names an id that is not shaped like one', async () => {
      writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: '--dangerously-skip-permissions' }]);
      await expect(claudeBackgroundSessionOf({ agentSessionId: ORIGINAL, cwd: 'C:\\work' })).resolves.toBeNull();
    });

    // Measured in a /preview on 2.1.316: the background session's transcript
    // appeared 1.7 s after the continued-in record, and a terminal stopped 2 s
    // after /bg had none while the session still ran. Red-green: reading only a
    // transcript the locator finds misses this session, and the reap killed it.
    it('names a background session that has not written its own transcript yet', async () => {
      writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: MOVED }]);

      await expect(claudeBackgroundSessionOf({ agentSessionId: MOVED, cwd: 'C:\\work' })).resolves.toBe(MOVED);
      expect(runClaudeCli).not.toHaveBeenCalled();
    });

    it('reads a locator that throws as nothing', async () => {
      findClaudeTranscriptFile.mockRejectedValueOnce(new Error('EACCES'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(claudeBackgroundSessionOf({ agentSessionId: MOVED, cwd: 'C:\\work' })).resolves.toBeNull();
    });
  });

  // `/bg` and `/fork` fire identical SessionStart hooks (`source: fork`); only
  // the move ends the old transcript with `continued-in` (measured on 2.1.316:
  // after `/fork` the terminal's transcript kept going with no such record).
  describe('claudeConfirmsBackgroundMove', () => {
    it('is true when the terminal\'s transcript continues in the background session', async () => {
      writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: MOVED }]);
      await expect(claudeConfirmsBackgroundMove({ cwd: 'C:\\work', fromAgentSessionId: ORIGINAL, toAgentSessionId: MOVED })).resolves.toBe(true);
    });

    it('is false for a /fork copy: the terminal\'s transcript goes on with no continued-in', async () => {
      writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'last-prompt' }, { type: 'user', message: { content: 'next' } }]);
      await expect(claudeConfirmsBackgroundMove({ cwd: 'C:\\work', fromAgentSessionId: ORIGINAL, toAgentSessionId: MOVED })).resolves.toBe(false);
    });

    it('is false when the record names another session, the transcript is missing, or the locator throws', async () => {
      writeTranscript(ORIGINAL, [...withTurn(ORIGINAL), { type: 'continued-in', continuedInSessionId: OTHER }]);
      await expect(claudeConfirmsBackgroundMove({ cwd: 'C:\\work', fromAgentSessionId: ORIGINAL, toAgentSessionId: MOVED })).resolves.toBe(false);

      await expect(claudeConfirmsBackgroundMove({ cwd: 'C:\\work', fromAgentSessionId: 'no-such-conversation', toAgentSessionId: MOVED })).resolves.toBe(false);

      findClaudeTranscriptFile.mockRejectedValueOnce(new Error('EACCES'));
      await expect(claudeConfirmsBackgroundMove({ cwd: 'C:\\work', fromAgentSessionId: ORIGINAL, toAgentSessionId: MOVED })).resolves.toBe(false);
    });

    it('hands the locator the transcript path the agent reported', async () => {
      writeTranscript(ORIGINAL, [{ type: 'continued-in', continuedInSessionId: MOVED }]);
      const reportedPath = path.join(projectsFolder, `${ORIGINAL}.jsonl`);
      await claudeConfirmsBackgroundMove({ cwd: 'C:\\work', fromAgentSessionId: ORIGINAL, toAgentSessionId: MOVED, transcriptPath: reportedPath });
      expect(findClaudeTranscriptFile).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: ORIGINAL, reportedPath }));
    });
  });

  // The two files under tests/fixtures/claude-background-move/ are sanitized live
  // captures from Claude Code 2.1.316 after `/bg`. The synthetic transcripts above
  // prove the logic; these prove it reads what Claude Code really writes, so a fixture
  // written to match the code cannot hide a wrong record type or field name.
  describe('transcripts captured from Claude Code 2.1.316 after /bg', () => {
    const FIXTURE_FOLDER = path.join(__dirname, '..', 'fixtures', 'claude-background-move');
    const CAPTURED_MOVED = '206fcc54-ddb8-497b-9d57-a0f6defcced9';
    const CAPTURED_FORK = '58bd8a86-0d47-4861-8449-63202d8e6a43';

    beforeEach(() => {
      // The moved conversation's capture is its last record only, so a user record
      // goes before it, the shape of a conversation that took a turn.
      const userRecord = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Reply with the single word ok.' },
        sessionId: CAPTURED_MOVED,
      }) + '\n';
      const movedTail = fs.readFileSync(path.join(FIXTURE_FOLDER, 'moved-transcript-tail.jsonl'));
      fs.writeFileSync(path.join(projectsFolder, `${CAPTURED_MOVED}.jsonl`), Buffer.concat([Buffer.from(userRecord, 'utf8'), movedTail]));
      // The fork's capture is its whole transcript before its first turn: copied as is.
      fs.copyFileSync(path.join(FIXTURE_FOLDER, 'fork-transcript-head.jsonl'), path.join(projectsFolder, `${CAPTURED_FORK}.jsonl`));
    });

    it('confirms the move only into the background session the moved transcript names', async () => {
      await expect(claudeConfirmsBackgroundMove({ cwd: 'C:\\work', fromAgentSessionId: CAPTURED_MOVED, toAgentSessionId: CAPTURED_FORK })).resolves.toBe(true);
      await expect(claudeConfirmsBackgroundMove({ cwd: 'C:\\work', fromAgentSessionId: CAPTURED_MOVED, toAgentSessionId: OTHER })).resolves.toBe(false);
      // The fork's transcript names no successor, so the move does not run backwards.
      await expect(claudeConfirmsBackgroundMove({ cwd: 'C:\\work', fromAgentSessionId: CAPTURED_FORK, toAgentSessionId: CAPTURED_MOVED })).resolves.toBe(false);
    });

    it('resumes the background session that took no turn by the conversation it moved out of', async () => {
      await expect(resolveClaudeResumableSessionId({ agentSessionId: CAPTURED_FORK, cwd: 'C:\\work' })).resolves.toBe(CAPTURED_MOVED);
    });

    it('names the background session from either side of the move', async () => {
      await expect(claudeBackgroundSessionOf({ agentSessionId: CAPTURED_FORK, cwd: 'C:\\work' })).resolves.toBe(CAPTURED_FORK);
      await expect(claudeBackgroundSessionOf({ agentSessionId: CAPTURED_MOVED, cwd: 'C:\\work' })).resolves.toBe(CAPTURED_FORK);
    });

    it('names the background session, and resumes by the moved conversation, before its own transcript is written', async () => {
      fs.rmSync(path.join(projectsFolder, `${CAPTURED_FORK}.jsonl`), { force: true });

      await expect(claudeBackgroundSessionOf({ agentSessionId: CAPTURED_FORK, cwd: 'C:\\work' })).resolves.toBe(CAPTURED_FORK);
      await expect(resolveClaudeResumableSessionId({ agentSessionId: CAPTURED_FORK, cwd: 'C:\\work' })).resolves.toBe(CAPTURED_MOVED);
    });
  });
});
