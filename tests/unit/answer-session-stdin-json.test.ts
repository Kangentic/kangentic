/**
 * The warm answering process: one JSON line in per turn, stream-json lines out,
 * a turn ending on its result line. Driven against a fake child so each
 * boundary is exact: a line split across chunks, a second ask while one is in
 * flight, the process dying before and after text, an agent error, a timeout,
 * and a dispose from the quit path.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  AnswerSessionError,
  openStdinJsonSession,
  type StdinJsonSessionOptions,
} from '../../src/main/agent/shared/answer-session/stdin-json-session';
import { createAnswerStreamReducer, extractStreamedAnswer } from '../../src/main/agent/shared/cli-answer';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly written: string[] = [];
  killed = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.written.push(chunk.toString('utf-8')));
  }

  kill(): boolean {
    this.killed = true;
    this.exit(null, 'SIGTERM');
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  /** Write stdout lines, each with its newline. */
  say(...lines: string[]): void {
    this.stdout.write(lines.map((line) => `${line}\n`).join(''));
  }
}

const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (text: string, isError = false) => JSON.stringify({ type: 'result', result: text, is_error: isError });

function open(overrides: Partial<StdinJsonSessionOptions> = {}): { child: FakeChild; session: ReturnType<typeof openStdinJsonSession> } {
  const child = new FakeChild();
  const session = openStdinJsonSession({
    cliPath: '/bin/claude',
    args: ['--print'],
    cwd: '/scratch',
    formatTurn: (prompt) => JSON.stringify({ type: 'user', text: prompt }),
    createReducer: createAnswerStreamReducer,
    isTurnEnd: (line) => line.includes('"type":"result"'),
    extractAnswer: extractStreamedAnswer,
    spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    ...overrides,
  });
  queueMicrotask(() => child.emit('spawn'));
  return { child, session };
}

/** Let the PassThrough deliver what was written. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// These pin the session's own lifecycle, not how a stop reaches the process. On
// Windows `stopCli` takes the tree with a real `taskkill` by pid, which would
// run against the fake child's made-up pid, so the POSIX path stands in on
// every OS and a stop lands on the fake's own `kill`.
const originalPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

describe('openStdinJsonSession', () => {
  it('writes one line per turn and resolves at the result line, streaming as it goes', async () => {
    const { child, session } = open();
    await session.ready;
    const events: unknown[] = [];
    const answer = session.ask('the question', (event) => events.push(event));
    await flush();
    expect(child.written).toEqual([`${JSON.stringify({ type: 'user', text: 'the question' })}\n`]);
    expect(session.busy).toBe(true);

    child.say(delta('Three '), delta('tasks.'), assistant('Three tasks.'), result('Three tasks.'));
    await expect(answer).resolves.toBe('Three tasks.');
    // Deltas once each; the complete turn that repeats them is dropped.
    expect(events).toEqual([{ kind: 'text', text: 'Three ' }, { kind: 'text', text: 'tasks.' }]);
    expect(session.busy).toBe(false);
  });

  it('reassembles a line split across stdout chunks', async () => {
    const { child, session } = open();
    const answer = session.ask('q');
    await flush();
    const whole = `${result('Split across chunks.')}\n`;
    child.stdout.write(whole.slice(0, 17));
    await flush();
    expect(session.busy).toBe(true);
    child.stdout.write(whole.slice(17));
    await expect(answer).resolves.toBe('Split across chunks.');
  });

  // A pipe read can end anywhere, including between the bytes of one character.
  // Decoding each read alone turned the two halves into U+FFFD, and the damage
  // was kept in the turn's lines and so in the final answer.
  it.each([
    ['a two-byte character', 'é', 1],
    ['a three-byte character after its first byte', '→', 1],
    ['a three-byte character after its second byte', '→', 2],
  ])('keeps %s whole when a stdout read ends inside it', async (_label, character, bytesBeforeSplit) => {
    const { child, session } = open();
    const answer = session.ask('q');
    await flush();
    const answerText = `Route: caf${character} done`;
    const bytes = Buffer.from(`${result(answerText)}\n`, 'utf-8');
    const splitAt = bytes.indexOf(Buffer.from(character, 'utf-8')) + bytesBeforeSplit;

    child.stdout.write(bytes.subarray(0, splitAt));
    await flush();
    // Nothing is a whole line yet.
    expect(session.busy).toBe(true);
    child.stdout.write(bytes.subarray(splitAt));

    const resolved = await answer;
    expect(resolved).toBe(answerText);
    expect(resolved).not.toContain('�');
  });

  it('streams a character split across stdout reads whole in the text event', async () => {
    const { child, session } = open();
    const events: unknown[] = [];
    const answer = session.ask('q', (event) => events.push(event));
    await flush();
    const streamedText = 'Ship → done';
    const bytes = Buffer.from(`${delta(streamedText)}\n${result(streamedText)}\n`, 'utf-8');
    const splitAt = bytes.indexOf(Buffer.from('→', 'utf-8')) + 2;

    child.stdout.write(bytes.subarray(0, splitAt));
    await flush();
    child.stdout.write(bytes.subarray(splitAt));

    await expect(answer).resolves.toBe(streamedText);
    expect(events).toEqual([{ kind: 'text', text: streamedText }]);
  });

  it('answers turn after turn, each with its own reducer', async () => {
    const { child, session } = open();
    const first = session.ask('one');
    await flush();
    child.say(delta('ONE'), result('ONE'));
    await expect(first).resolves.toBe('ONE');

    // Without a fresh reducer the second turn's complete line would be
    // dropped as a repeat of partials it never saw.
    const events: unknown[] = [];
    const second = session.ask('two', (event) => events.push(event));
    await flush();
    child.say(assistant('TWO'), result('TWO'));
    await expect(second).resolves.toBe('TWO');
    expect(events).toEqual([{ kind: 'text', text: 'TWO' }]);
    expect(child.written).toHaveLength(2);
  });

  it('refuses a second question while one is in flight', async () => {
    const { session } = open();
    void session.ask('first').catch(() => undefined);
    await expect(session.ask('second')).rejects.toMatchObject({ failure: 'busy' });
  });

  it('reports a process that died before any text as retryable, and after text as not', async () => {
    const before = open();
    const beforeAnswer = before.session.ask('q');
    await flush();
    before.child.stderr.write('Error: connection refused\n');
    await flush();
    before.child.exit(1);
    const beforeError = await beforeAnswer.catch((error: unknown) => error);
    expect(beforeError).toBeInstanceOf(AnswerSessionError);
    expect(beforeError).toMatchObject({ failure: 'exited', beforeText: true });
    expect((beforeError as Error).message).toContain('connection refused');
    expect(before.session.alive).toBe(false);

    const after = open();
    const afterAnswer = after.session.ask('q');
    await flush();
    after.child.say(delta('Half an ans'));
    await flush();
    after.child.exit(1);
    await expect(afterAnswer).rejects.toMatchObject({ failure: 'exited', beforeText: false });
  });

  it('turns an error result into an agent failure', async () => {
    const { child, session } = open();
    const answer = session.ask('q');
    await flush();
    child.say(result('Model not available', true));
    await expect(answer).rejects.toMatchObject({ failure: 'agent', message: 'Model not available' });
    // The process is still fine: the next question can run.
    expect(session.alive).toBe(true);
  });

  it('times a turn out and ends the process', async () => {
    vi.useFakeTimers();
    const { child, session } = open({ turnTimeoutMs: 1_000 });
    const answer = session.ask('q');
    vi.advanceTimersByTime(1_001);
    await expect(answer).rejects.toMatchObject({ failure: 'timeout' });
    expect(child.killed).toBe(true);
    expect(session.alive).toBe(false);
  });

  it('disposes once: stdin closed, process killed, the turn in flight rejected', async () => {
    const { child, session } = open();
    const answer = session.ask('q');
    await flush();
    session.dispose();
    session.dispose();
    // `disposed`, not `exited`: a stop someone asked for is never retried.
    await expect(answer).rejects.toMatchObject({ failure: 'disposed' });
    expect(child.killed).toBe(true);
    expect(child.stdin.writableEnded).toBe(true);
    expect(session.alive).toBe(false);
    await expect(session.exited).resolves.toBeUndefined();
    await expect(session.ask('again')).rejects.toMatchObject({ failure: 'disposed' });
  });

  it('cuts a turn that runs past its output budget', async () => {
    const { child, session } = open({ turnOutputBudget: 200 });
    const answer = session.ask('q');
    await flush();
    child.say(delta('x'.repeat(300)));
    await expect(answer).rejects.toMatchObject({ failure: 'budget' });
    expect(child.killed).toBe(true);
  });
});
