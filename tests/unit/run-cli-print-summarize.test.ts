/**
 * Unit tests for `runCliPrintSummarize` in src/main/agent/shared/auto-name.ts.
 *
 * These tests exercise the spawn-level behavior: OUTPUT_BUDGET termination,
 * timeout path, env merge, extractRaw hook, and non-zero exit code handling.
 *
 * Strategy: mock `node:child_process` spawn so every test controls exactly
 * what data/close/error events the child emits, without launching a real process.
 * The mock returns a minimal EventEmitter-shaped object with stdout, stderr, stdin,
 * and kill stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Hoisted mock for node:child_process
// ---------------------------------------------------------------------------

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// ---------------------------------------------------------------------------
// Helper: build a fake child process
// ---------------------------------------------------------------------------

interface FakeChild {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  _emitter: EventEmitter;
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killMock = vi.fn(function (this: FakeChild) {
    this.killed = true;
  });

  const child: FakeChild = {
    stdout,
    stderr,
    stdin: { end: vi.fn(), on: vi.fn() },
    kill: vi.fn(),
    killed: false,
    on: (event, handler) => emitter.on(event, handler),
    emit: (event, ...args) => emitter.emit(event, ...args),
    _emitter: emitter,
  };

  // Wire kill to set the `killed` flag (the production code checks child.killed)
  child.kill = vi.fn((signal?: string) => {
    void signal;
    child.killed = true;
  });

  return child;
}

// ---------------------------------------------------------------------------
// Import the function under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { runCliPrintSummarize, runCliPrintAnswer } from '../../src/main/agent/shared/auto-name';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  mockSpawn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runCliPrintSummarize - OUTPUT_BUDGET termination (#2)', () => {
  it('kills the child when stdout exceeds 2048 bytes and resolves with the partial output', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    // The promise resolves only after the `close` event fires; we simulate
    // the sequence: large chunk -> kill -> close.
    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: ['--print'],
      prompt: 'test prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
    });

    // Emit enough data to exceed the 2048-byte OUTPUT_BUDGET.
    // We emit a chunk just under the budget, then one that pushes over.
    const smallChunk = Buffer.alloc(2000, 'A');
    const overflowChunk = Buffer.alloc(100, 'B');

    child.stdout.emit('data', smallChunk);
    // After this chunk stdoutSize = 2000, still under budget.
    // After the next chunk: 2100 > 2048, child should be killed and no push.
    child.stdout.emit('data', overflowChunk);

    // The production code sets terminated=true and calls child.kill() but does
    // NOT immediately reject; it waits for the `close` event.
    expect(child.killed).toBe(true);

    // Emit close - production code calls finish() with partial=true and
    // resolves if cleaned output is non-empty.
    child.emit('close', 0);

    const result = await resultPromise;
    // The partial stdout (2000 x 'A') should produce the letter 'A' repeated
    // after cleanSummarizeOutput strips nothing and returns the first line.
    expect(result).toBe('A'.repeat(80)); // capped at TITLE_LIMIT=80
  });

  it('does not accumulate the overflow chunk in stdoutChunks', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'x',
      cwd: '/tmp',
      timeoutMs: 30_000,
    });

    // First chunk: exactly at budget - 1 (still under)
    const firstChunk = Buffer.from('Fix Login Bug');
    child.stdout.emit('data', firstChunk);

    // Second large chunk: pushes over budget; should NOT be accumulated
    const bigChunk = Buffer.alloc(3000, 'Z');
    child.stdout.emit('data', bigChunk);

    child.emit('close', 0);

    const result = await resultPromise;
    // Only the first chunk's content should appear - 'Z' content must NOT be in title
    expect(result).toBe('Fix Login Bug');
    expect(result).not.toContain('Z');
  });
});

describe('runCliPrintSummarize - timeout path (#3)', () => {
  it('rejects with "summarize timed out" when the child stalls past timeoutMs', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 500,
    });

    // Advance past the timeout without emitting close
    vi.advanceTimersByTime(600);

    await expect(resultPromise).rejects.toThrow('summarize timed out');
  });

  it('attempts SIGKILL 1 second after the initial SIGTERM', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 500,
    });

    // Advance to trigger the timeout timer (SIGTERM)
    vi.advanceTimersByTime(600);

    // The first kill call happens at timeout
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Simulate the child NOT dying after SIGTERM (killed stays false)
    child.killed = false;

    // Advance past the 1-second SIGKILL fallback timer
    vi.advanceTimersByTime(1100);

    // SIGKILL should have been sent
    const killCalls = (child.kill as ReturnType<typeof vi.fn>).mock.calls;
    const sigkillCall = killCalls.find(
      (callArgs: string[]) => callArgs[0] === 'SIGKILL',
    );
    expect(sigkillCall).toBeDefined();

    // Consume the rejection so the test doesn't warn about unhandled rejections
    await resultPromise.catch(() => { /* expected */ });
  });
});

describe('runCliPrintSummarize - env merge (#4)', () => {
  it('merges adapter-supplied env overrides onto process.env for the spawn call', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
      env: { NO_COLOR: '1', CUSTOM_VAR: 'hello' },
    });

    // Emit a normal close so the promise settles
    child.stdout.emit('data', Buffer.from('Fix Something Important'));
    child.emit('close', 0);

    await resultPromise;

    // Verify spawn was called with a merged env that includes both process.env
    // keys and the adapter's overlay keys.
    const spawnCall = mockSpawn.mock.calls[0];
    const spawnOptions = spawnCall[2] as { env: Record<string, string | undefined> };

    expect(spawnOptions.env).toBeDefined();
    expect(spawnOptions.env['NO_COLOR']).toBe('1');
    expect(spawnOptions.env['CUSTOM_VAR']).toBe('hello');
    // process.env keys should also be present (spot-check one that always exists)
    expect('PATH' in spawnOptions.env || 'USERPROFILE' in spawnOptions.env
      || Object.keys(spawnOptions.env).length > 2).toBe(true);
  });

  it('uses process.env directly (no copy) when no env option is provided', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
      // no env option
    });

    child.stdout.emit('data', Buffer.from('Build Something Better'));
    child.emit('close', 0);

    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const spawnOptions = spawnCall[2] as { env: Record<string, string | undefined> };

    // When no env overlay is provided the production code passes process.env directly.
    expect(spawnOptions.env).toBe(process.env);
  });
});

describe('runCliPrintSummarize - extractRaw hook (#5)', () => {
  it('passes stdout through extractRaw and resolves with the extracted title', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const rawOutput = JSON.stringify({ type: 'assistant', text: 'Refactor Auth Layer' });
    const extractRaw = vi.fn((stdout: string) => {
      const parsed = JSON.parse(stdout) as { text: string };
      return parsed.text;
    });

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
      extractRaw,
    });

    child.stdout.emit('data', Buffer.from(rawOutput));
    child.emit('close', 0);

    const result = await resultPromise;
    expect(extractRaw).toHaveBeenCalledWith(rawOutput);
    expect(result).toBe('Refactor Auth Layer');
  });

  it('rejects when extractRaw throws an error', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const extractionError = new Error('unexpected stream format');
    const extractRaw = vi.fn(() => { throw extractionError; });

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
      extractRaw,
    });

    child.stdout.emit('data', Buffer.from('{"garbage": true}'));
    child.emit('close', 0);

    await expect(resultPromise).rejects.toThrow('unexpected stream format');
  });
});

describe('runCliPrintSummarize - non-zero exit code (#6)', () => {
  it('rejects with a message including the exit code and trimmed stderr', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
    });

    // No stdout - empty output
    child.stderr.emit('data', Buffer.from('  fatal: not a git repo  '));
    child.emit('close', 2);

    await expect(resultPromise).rejects.toThrow('summarize CLI exited 2: fatal: not a git repo');
  });

  it('rejects with only the exit code when stderr is empty', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
    });

    child.emit('close', 1);

    await expect(resultPromise).rejects.toThrow('summarize CLI exited 1');
  });

  it('does not append a colon when stderr is whitespace-only', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
    });

    child.stderr.emit('data', Buffer.from('   \n  '));
    child.emit('close', 3);

    // trimmed stderr is empty, so no ': ' suffix
    const rejection = await resultPromise.catch((error: Error) => error);
    expect(rejection.message).toBe('summarize CLI exited 3');
  });

  it('truncates very long stderr to 200 characters in the error message', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
    });

    const longStderr = 'E'.repeat(500);
    child.stderr.emit('data', Buffer.from(longStderr));
    child.emit('close', 1);

    const rejection = await resultPromise.catch((error: Error) => error);
    // Production code: .trim().slice(0, 200)
    const expectedSuffix = 'E'.repeat(200);
    expect(rejection.message).toBe(`summarize CLI exited 1: ${expectedSuffix}`);
  });
});

/**
 * The ANSWER shape.
 *
 * The same spawn with two things changed, and both of them would silently
 * destroy an answer if they were not: the title cleanup keeps only the first
 * non-empty line and strips fenced code, and the title output budget is 2KB
 * where an answer over two dozen excerpts runs to several paragraphs.
 */
describe('runCliPrintAnswer - the answer shape', () => {
  it('keeps every paragraph, and the fenced code inside them', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintAnswer({
      cliPath: '/usr/bin/fake',
      args: ['--print'],
      prompt: 'question and excerpts',
      cwd: '/tmp',
    });

    const answer = 'The sphere fit was dropped [2].\n\n'
      + 'It circumscribes, so:\n\n```ts\nfitDefaultView(points, fov, viewport, direction)\n```\n\n'
      + 'That keeps the air identical [1][4].';
    child.stdout.emit('data', Buffer.from(answer));
    child.emit('close', 0);

    const result = await resultPromise;
    // Verbatim but for the trim. The summarize shape would have returned
    // "The sphere fit was dropped [2]" alone, with the code fence deleted.
    expect(result).toBe(answer);
    expect(result).toContain('```ts');
    expect(result.split('\n\n')).toHaveLength(4);
  });

  it('accepts an answer far past the title output budget', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintAnswer({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'question',
      cwd: '/tmp',
    });

    // Eight times the 2048-byte title budget, which would have terminated the
    // child a paragraph in.
    const long = 'x'.repeat(16_384);
    child.stdout.emit('data', Buffer.from(long));
    expect(child.killed).toBe(false);
    child.emit('close', 0);

    expect(await resultPromise).toBe(long);
  });

  it('still terminates a runaway agent, just later', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintAnswer({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'question',
      cwd: '/tmp',
    });

    // Under the budget first, then over it - the shape the accumulator sees in
    // practice, and the only one that leaves partial output to resolve with.
    child.stdout.emit('data', Buffer.alloc(30_000, 'y'));
    expect(child.killed).toBe(false);
    child.stdout.emit('data', Buffer.alloc(5_000, 'y'));
    // The budget is a bound, not a removal: an agent that narrates its way
    // through two dozen excerpts is cut off rather than left to run.
    expect(child.killed).toBe(true);
    child.emit('close', 0);
    expect(await resultPromise).toHaveLength(30_000);
  });

  it('lets a caller override the budgets it defaults', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintAnswer({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'question',
      cwd: '/tmp',
      outputBudget: 100,
    });

    child.stdout.emit('data', Buffer.alloc(80, 'z'));
    expect(child.killed).toBe(false);
    child.stdout.emit('data', Buffer.alloc(80, 'z'));
    expect(child.killed).toBe(true);
    child.emit('close', 0);
    expect(await resultPromise).toHaveLength(80);
  });
});
