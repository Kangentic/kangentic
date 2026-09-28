/**
 * Task digests: the prompt a batch sends, reading the reply, the input each
 * finished task is digested from, one pass over a board, and when passes run.
 *
 * better-sqlite3 cannot load under vitest's system Node, so the pass runs
 * against a scripted `prepare()` that answers by SQL shape and records writes.
 */

import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  buildDigestPrompt,
  digestInputHash,
  parseDigestReply,
  DIGEST_BATCH_SIZE,
  type DigestInput,
} from '../../src/main/retrieval/digest/digest-prompt';
import { changedFilesOf, lastAssistantMessage } from '../../src/main/retrieval/digest/digest-sources';
import { runDigestPass } from '../../src/main/retrieval/digest/digest-pass';
import { createDigestScheduler } from '../../src/main/retrieval/digest/digest-scheduler';

const input = (taskId: string, title = `Task ${taskId}`): DigestInput => ({
  taskId,
  title,
  description: 'Make the relay reconnect after the router restarts.',
  changedFiles: ['src/main/mobile-bridge/relay-client.ts'],
  closingMessages: ['The relay now reconnects with backoff.'],
});

describe('the digest prompt', () => {
  it('labels each task D1, D2, ... and carries what the digest is written from', () => {
    const prompt = buildDigestPrompt([input('a', 'Relay reconnect'), input('b')]);
    expect(prompt).toContain('<task label="D1">\nTitle: Relay reconnect\nDescription: Make the relay');
    expect(prompt).toContain('Files changed: src/main/mobile-bridge/relay-client.ts');
    expect(prompt).toContain('A session ended: The relay now reconnects with backoff.');
    expect(prompt).toContain('<task label="D2">');
  });

  it('reads one digest per label, in whatever light formatting the reply wears', () => {
    const reply = [
      'D1: Made the relay reconnect after a router restart.',
      '**D2**: Fixed the pairing QR code.',
      'D2: a second D2 is ignored',
      'D9: out of range',
      'Some chatter the rules asked it not to write.',
    ].join('\n');
    const digests = parseDigestReply(reply, 3);
    expect([...digests]).toEqual([
      [0, 'Made the relay reconnect after a router restart.'],
      [1, 'Fixed the pairing QR code.'],
    ]);
  });

  it('drops PR and issue numbers, which the answering agent would read as task marks', () => {
    const reply = [
      'D1: Restyled the Backlog edit dialog to match the task detail; merged in PR #306.',
      'D2: Fixed push alerts rendering twice, merged as PR #303, and debounced the idle signal.',
      'D3: Bumped the build tooling and merged dependabot PR #12.',
      'D4: Fixed GitHub issue #88 in the relay (#91) client.',
    ].join('\n');
    expect([...parseDigestReply(reply, 4).values()]).toEqual([
      'Restyled the Backlog edit dialog to match the task detail.',
      'Fixed push alerts rendering twice, and debounced the idle signal.',
      'Bumped the build tooling.',
      'Fixed GitHub issue in the relay client.',
    ]);
  });

  it('cuts a digest that runs long, since it is a summary', () => {
    const digests = parseDigestReply(`D1: ${'word '.repeat(200)}`, 1);
    expect((digests.get(0) ?? '').length).toBeLessThanOrEqual(363);
  });

  it('hashes what the digest was written from, so a change to it rewrites the digest', () => {
    expect(digestInputHash(input('a'))).toBe(digestInputHash(input('a')));
    expect(digestInputHash({ ...input('a'), closingMessages: ['It ended differently.'] })).not.toBe(digestInputHash(input('a')));
  });
});

describe('reading a finished task', () => {
  it('finds the last thing the agent said in a chunk, past any tool call after it', () => {
    const text = [
      'User: fix it',
      'Assistant: Looking.',
      'Tool: Edit {"file_path":"a.ts"}',
      'Assistant: Done: the relay reconnects now.\nIt backs off too.',
      'Tool: Bash {"command":"npm test"}',
      'Tool result: ok',
    ].join('\n');
    expect(lastAssistantMessage(text)).toBe('Done: the relay reconnects now.\nIt backs off too.');
    expect(lastAssistantMessage('User: only a question')).toBeNull();
  });

  it('reads the files a session-changes document lists, without their words', () => {
    expect(changedFilesOf('Files changed:\nsrc/a/relay-client.ts (a relay client)\nREADME.md')).toEqual([
      'src/a/relay-client.ts',
      'README.md',
    ]);
  });
});

interface Call { sql: string; args: unknown[] }

/** A board of finished tasks and the digests already written, by SQL shape. */
function fakeBoard(state: { finished: string[]; digests?: Array<{ taskId: string; inputHash: string }> }) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      const answer = (args: unknown[]): unknown[] => {
        calls.push({ sql, args });
        if (sql.includes("WHERE w.role = 'done'")) {
          return state.finished.map((taskId) => ({ taskId, title: `Task ${taskId}`, description: 'Body.' }));
        }
        if (sql.includes('FROM sessions WHERE task_id = ?')) return [{ docId: `agent-${String(args[0])}`, at: '2026-09-20T00:00:00.000Z' }];
        if (sql.includes("corpus = 'conversation'")) return [{ text: 'Assistant: Finished.' }];
        if (sql.includes('SELECT task_id AS taskId, input_hash AS inputHash')) return state.digests ?? [];
        return [];
      };
      return {
        all: (...args: unknown[]) => answer(args),
        get: (...args: unknown[]) => answer(args)[0],
        run: (...args: unknown[]) => {
          calls.push({ sql, args });
          return { changes: 0, lastInsertRowid: 0 };
        },
      };
    },
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
  return { db, calls };
}

const passDeps = (db: Database.Database) => ({ getDb: () => db, now: () => '2026-09-28T00:00:00.000Z', yieldToEventLoop: async () => undefined });
const digestWrites = (calls: Call[]) => calls.filter((call) => call.sql.includes('INSERT INTO memory_task_digests'));

describe('a digest pass', () => {
  it('writes a digest for each finished task the reply covers, ten to a call', async () => {
    const finished = Array.from({ length: 12 }, (_unused, index) => `t${index}`);
    const { db, calls } = fakeBoard({ finished });
    const write = vi.fn(async (prompt: string) => {
      const count = (prompt.match(/<task label=/g) ?? []).length;
      return Array.from({ length: count }, (_unused, index) => `D${index + 1}: Digest ${index + 1}.`).join('\n');
    });

    const result = await runDigestPass('project', { agent: 'claude', model: 'sonnet', write }, { maxBatches: 5, shouldContinue: () => true }, passDeps(db));

    expect(write).toHaveBeenCalledTimes(2);
    expect((write.mock.calls[0][0].match(/<task label=/g) ?? []).length).toBe(DIGEST_BATCH_SIZE);
    expect(result).toMatchObject({ written: 12, remaining: 0, failed: false, unanswered: [] });
    // task_id, digest, input_hash, agent, model, created_at
    expect(digestWrites(calls)[0].args.slice(1, 5)).toEqual(['Digest 1.', expect.any(String), 'claude', 'sonnet']);
  });

  it('leaves a task whose digest is current, and one the skip list holds', async () => {
    const { db } = fakeBoard({ finished: ['kept', 'skipped', 'new'] });
    const current = await (async () => {
      // The hash a current digest was written from, read the way the pass reads it.
      const { readDigestCandidates } = await import('../../src/main/retrieval/digest/digest-sources');
      const candidates = await readDigestCandidates(db, async () => undefined);
      return candidates.find((candidate) => candidate.input.taskId === 'kept')?.hash ?? '';
    })();
    const board = fakeBoard({ finished: ['kept', 'skipped', 'new'], digests: [{ taskId: 'kept', inputHash: current }] });
    const write = vi.fn(async () => 'D1: New digest.');

    const result = await runDigestPass('project', { agent: 'claude', model: null, write }, { maxBatches: 5, shouldContinue: () => true, skip: new Set(['skipped']) }, passDeps(board.db));

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toContain('Title: Task new');
    expect(write.mock.calls[0][0]).not.toContain('Title: Task kept');
    expect(result.written).toBe(1);
  });

  it('reports a task the reply skipped, and stops at a failed call', async () => {
    const { db } = fakeBoard({ finished: ['a', 'b'] });
    const answered = await runDigestPass('project', { agent: 'claude', model: null, write: async () => 'D2: Only the second.' }, { maxBatches: 1, shouldContinue: () => true }, passDeps(db));
    expect(answered.unanswered).toHaveLength(1);

    const failed = await runDigestPass('project', { agent: 'claude', model: null, write: async () => { throw new Error('quota'); } }, { maxBatches: 3, shouldContinue: () => true }, passDeps(fakeBoard({ finished: ['a', 'b'] }).db));
    expect(failed).toMatchObject({ written: 0, remaining: 2, failed: true });
  });
});

describe('the digest scheduler', () => {
  function harness(results: Array<{ written: number; remaining: number; failed?: boolean }>) {
    const timers: Array<{ delayMs: number; fire: () => void }> = [];
    const runPass = vi.fn(async () => {
      const next = results.shift() ?? { written: 0, remaining: 0 };
      return { unanswered: [], failed: false, ...next };
    });
    const onWritten = vi.fn();
    let enabled = true;
    let writer: object | null = { agent: 'claude', model: null, write: async () => '' };
    const scheduler = createDigestScheduler<string>({
      isEnabled: () => enabled,
      resolveWriter: async () => writer as never,
      onWritten,
      runPass: runPass as never,
      setTimer: (fire, delayMs) => {
        timers.push({ delayMs, fire });
        return { cancel: () => undefined };
      },
    });
    return {
      scheduler, runPass, onWritten, timers,
      disable: () => { enabled = false; },
      clearWriter: () => { writer = null; },
    };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('runs another pass after a short gap while digests remain, and re-reads the records after each write', async () => {
    const { scheduler, runPass, onWritten, timers } = harness([{ written: 30, remaining: 40 }, { written: 30, remaining: 0 }]);
    scheduler.request('context', 'project');
    await settle();
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(onWritten).toHaveBeenCalledWith('context', 'project');
    expect(timers.map((timer) => timer.delayMs)).toEqual([15_000]);

    timers[0].fire();
    await settle();
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(1);
  });

  it('brings what a digest is written from up to date before each pass reads its tasks', async () => {
    const order: string[] = [];
    const runPass = vi.fn(async () => {
      order.push('pass');
      return { written: 0, remaining: 0, unanswered: [], failed: false };
    });
    const scheduler = createDigestScheduler<string>({
      isEnabled: () => true,
      resolveWriter: async () => ({ agent: 'claude', model: null, write: async () => '' }),
      onWritten: () => undefined,
      beforePass: async () => { order.push('changes'); },
      runPass: runPass as never,
      setTimer: () => ({ cancel: () => undefined }),
    });
    scheduler.request('context', 'project');
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['changes', 'pass']);
  });

  it('backs off after a failed call instead of retrying at once', async () => {
    const { scheduler, timers } = harness([{ written: 0, remaining: 20, failed: true }]);
    scheduler.request('context', 'project');
    await settle();
    expect(timers.map((timer) => timer.delayMs)).toEqual([5 * 60_000]);
  });

  it('does nothing while no answering agent is chosen, or when digests are off', async () => {
    const off = harness([]);
    off.disable();
    off.scheduler.request('context', 'project');
    const noAgent = harness([]);
    noAgent.clearWriter();
    noAgent.scheduler.request('context', 'project');
    await settle();
    expect(off.runPass).not.toHaveBeenCalled();
    expect(noAgent.runPass).not.toHaveBeenCalled();
  });

  it('runs one pass at a time, taking a project asked for meanwhile next', async () => {
    const { scheduler, runPass } = harness([{ written: 0, remaining: 0 }, { written: 0, remaining: 0 }]);
    scheduler.request('context', 'first');
    scheduler.request('context', 'second');
    await settle();
    await settle();
    expect(runPass.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['first', 'second']);
  });
});
