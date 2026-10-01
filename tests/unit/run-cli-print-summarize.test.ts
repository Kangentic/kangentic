/**
 * Unit tests for the headless CLI runner (src/main/agent/shared/cli-print.ts),
 * through its title shape (`runCliPrintSummarize`) and its answer shape
 * (`runCliPrintAnswer`).
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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  /** A real emitter, as the child's stdin is: an `error` nobody listens for throws. */
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
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

  const child: FakeChild = {
    stdout,
    stderr,
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
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

import { runCliPrintSummarize } from '../../src/main/agent/shared/auto-name';
import { runCliForChat, spawnCli, stopAllCliRuns, stopCliRunsForChat } from '../../src/main/agent/shared/cli-print';
import { runCliPrintAnswer } from '../../src/main/agent/shared/cli-answer';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// A fake child with a pid, spawned on POSIX, is a process-group leader to
// `stopCli`, which would signal `-pid`: never let that reach a real process.
let processKill: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  mockSpawn.mockClear();
  processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  processKill.mockRestore();
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
  function startStalledRun(cliPath = '/usr/bin/fake'): Promise<string> {
    return runCliPrintSummarize({ cliPath, args: [], prompt: 'prompt', cwd: '/tmp', timeoutMs: 500 });
  }

  it('rejects only once the stopped child closes, so its run directory is free to remove', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    const settled = vi.fn();
    const resultPromise = startStalledRun();
    resultPromise.then(settled, settled);

    vi.advanceTimersByTime(600);
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).not.toHaveBeenCalled();

    child.emit('close', null);
    await expect(resultPromise).rejects.toThrow('the agent timed out');
  });

  it('rejects as timed out even when the child wrote output before it was stopped', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = startStalledRun();

    child.stdout.emit('data', Buffer.from('Half An Answ'));
    vi.advanceTimersByTime(600);
    child.emit('close', null);

    await expect(resultPromise).rejects.toThrow('the agent timed out');
  });

  it('rejects after the exit wait when the stopped child never closes', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = startStalledRun();

    vi.advanceTimersByTime(600 + 3_100);

    await expect(resultPromise).rejects.toThrow('the agent timed out');
  });

  it('sends SIGKILL a second after SIGTERM while the child is still running, although child.killed is already true', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = startStalledRun();

    vi.advanceTimersByTime(600);
    // Node sets `killed` as soon as a signal is sent, whether or not the process exited.
    expect(child.killed).toBe(true);
    vi.advanceTimersByTime(1_100);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null);
    await resultPromise.catch(() => { /* expected */ });
  });

  it('sends no SIGKILL once the child has exited', async () => {
    const child = makeFakeChild() as FakeChild & { exitCode: number | null };
    child.exitCode = null;
    mockSpawn.mockReturnValue(child);
    const resultPromise = startStalledRun();

    vi.advanceTimersByTime(600);
    child.exitCode = 1;
    vi.advanceTimersByTime(1_100);

    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    child.emit('close', 1);
    await resultPromise.catch(() => { /* expected */ });
  });

  describe('a CLI on POSIX', () => {
    const originalPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('runs as the leader of its own process group, and a stop signals the whole group', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const child = makeFakeChild() as FakeChild & { pid: number };
      child.pid = 4242;
      mockSpawn.mockReturnValue(child);
      const resultPromise = startStalledRun();

      // One field read out, never the options object: it carries process.env,
      // which a failed matcher would print into the log.
      expect((mockSpawn.mock.calls[0][2] as { detached?: boolean }).detached).toBe(true);
      vi.advanceTimersByTime(600);
      expect(processKill).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(child.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_100);
      expect(processKill).toHaveBeenCalledWith(-4242, 'SIGKILL');

      child.emit('close', null);
      await resultPromise.catch(() => { /* expected */ });
    });

    it('falls back to the CLI itself when its group cannot be signalled', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      processKill.mockImplementation(() => { throw new Error('ESRCH'); });
      const child = makeFakeChild() as FakeChild & { pid: number };
      child.pid = 4242;
      mockSpawn.mockReturnValue(child);
      const resultPromise = startStalledRun();

      vi.advanceTimersByTime(600);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      child.emit('close', null);
      await resultPromise.catch(() => { /* expected */ });
    });

    it('is never detached on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);
      const resultPromise = startStalledRun();

      expect('detached' in (mockSpawn.mock.calls[0][2] as object)).toBe(false);
      child.emit('close', 0);
      await resultPromise.catch(() => { /* expected */ });
    });
  });

  describe('a CLI launched through cmd.exe', () => {
    const originalPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('takes the whole process tree with taskkill instead of killing cmd.exe alone', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const child = makeFakeChild() as FakeChild & { pid: number };
      child.pid = 4242;
      const taskkill = { on: vi.fn(), unref: vi.fn() };
      taskkill.on.mockReturnValue(taskkill);
      mockSpawn.mockImplementation((command: string) => (command === 'taskkill' ? taskkill : child));
      const resultPromise = startStalledRun('C:\\tools\\fake.cmd');

      vi.advanceTimersByTime(600);

      // The taskkill calls alone: a matcher over every call would print the
      // CLI's own spawn options, process.env included, on a failure.
      const taskkills = mockSpawn.mock.calls.filter(([command]) => command === 'taskkill');
      expect(taskkills.map(([, args]) => args)).toEqual([['/pid', '4242', '/T', '/F']]);
      expect((taskkills[0][2] as { windowsHide?: boolean }).windowsHide).toBe(true);
      expect(taskkill.unref).toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      child.emit('close', null);
      await expect(resultPromise).rejects.toThrow('the agent timed out');
    });
  });

  describe('a CLI that is a plain executable on Windows', () => {
    const originalPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('takes the whole process tree with taskkill too, since it can start children of its own', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const child = makeFakeChild() as FakeChild & { pid: number };
      child.pid = 4243;
      const taskkill = { on: vi.fn(), unref: vi.fn() };
      taskkill.on.mockReturnValue(taskkill);
      mockSpawn.mockImplementation((command: string) => (command === 'taskkill' ? taskkill : child));
      const resultPromise = startStalledRun('C:\\tools\\fake.exe');

      vi.advanceTimersByTime(600);

      // Read off the taskkill calls alone: a failure prints what it compared, and
      // the CLI's own spawn call carries the whole process environment.
      const taskkills = mockSpawn.mock.calls.filter(([command]) => command === 'taskkill');
      expect(taskkills).toHaveLength(1);
      expect(taskkills[0][1]).toEqual(['/pid', '4243', '/T', '/F']);
      expect(taskkills[0][2]).toEqual(expect.objectContaining({ windowsHide: true }));
      expect(taskkill.unref).toHaveBeenCalled();
      // child.kill ends the one process and leaves whatever it started running.
      expect(child.kill).not.toHaveBeenCalled();
      child.emit('close', null);
      await expect(resultPromise).rejects.toThrow('the agent timed out');
    });
  });
});

describe('stopAllCliRuns', () => {
  const originalPlatform = process.platform;

  /** A child `spawnCli` can track: a pid, and `once`, which the tracker forgets it through. */
  function makeTrackableChild(pid: number): FakeChild & { pid: number } {
    const child = makeFakeChild() as FakeChild & { pid: number; once: (event: string, handler: (...args: unknown[]) => void) => void };
    child.pid = pid;
    child.once = (event, handler) => { child._emitter.once(event, handler); };
    return child;
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockSpawn.mockReset();
    // The tracker is module state, and earlier tests in this file leave CLIs
    // that never emitted `exit` in it. Stop those now, against the stubbed
    // process.kill, so what is counted below is this test's own children.
    stopAllCliRuns();
    processKill.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('stops every CLI spawnCli started that has not exited, once, and leaves alone one that exited or never started', () => {
    const running = makeTrackableChild(5001);
    const exited = makeTrackableChild(5002);
    const failedToStart = makeTrackableChild(5003);
    mockSpawn.mockReturnValueOnce(running).mockReturnValueOnce(exited).mockReturnValueOnce(failedToStart);
    spawnCli('/usr/bin/fake', [], '/tmp');
    spawnCli('/usr/bin/fake', [], '/tmp');
    spawnCli('/usr/bin/fake', [], '/tmp');
    // Only the event: the exit code is left unset, so a CLI the tracker still
    // held would be stopped, and the test cannot pass on `stopCli`'s own check.
    exited.emit('exit', 0, null);
    // The caller's own handler, as runCliPrint has: an `error` with no listener throws.
    failedToStart.on('error', () => undefined);
    failedToStart.emit('error', new Error('spawn ENOENT'));

    stopAllCliRuns();

    // The group of the one still running, and nobody else's.
    expect(processKill.mock.calls).toEqual([[-5001, 'SIGTERM']]);

    // Forgotten once stopped: a second call at quit does not signal it again.
    processKill.mockClear();
    stopAllCliRuns();
    expect(processKill).not.toHaveBeenCalled();
  });

  it('stops only the runs started for the chat that ended, including one spawned after an await', async () => {
    const forChat = makeTrackableChild(5101);
    const forChatLater = makeTrackableChild(5102);
    const forOtherChat = makeTrackableChild(5103);
    const unowned = makeTrackableChild(5104);
    mockSpawn
      .mockReturnValueOnce(forChat)
      .mockReturnValueOnce(forChatLater)
      .mockReturnValueOnce(forOtherChat)
      .mockReturnValueOnce(unowned);
    await runCliForChat('chat-a', async () => {
      spawnCli('/usr/bin/fake', [], '/tmp');
      // An adapter awaits its run directory and its prompt file before it spawns.
      await Promise.resolve();
      spawnCli('/usr/bin/fake', [], '/tmp');
    });
    await runCliForChat('chat-b', async () => { spawnCli('/usr/bin/fake', [], '/tmp'); });
    spawnCli('/usr/bin/fake', [], '/tmp');

    stopCliRunsForChat('chat-a');

    expect(processKill.mock.calls).toEqual([[-5101, 'SIGTERM'], [-5102, 'SIGTERM']]);
    processKill.mockClear();
    // The rest are still tracked, for the quit path.
    stopAllCliRuns();
    expect(processKill.mock.calls).toEqual([[-5103, 'SIGTERM'], [-5104, 'SIGTERM']]);
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

    // When no env overlay is provided the production code passes process.env
    // directly. Compared as a boolean so a failure never prints either env.
    expect(spawnOptions.env === process.env).toBe(true);
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

    await expect(resultPromise).rejects.toThrow('the agent exited 2: fatal: not a git repo');
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

    await expect(resultPromise).rejects.toThrow('the agent exited 1');
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
    expect(rejection.message).toBe('the agent exited 3');
  });

  it('truncates very long stderr in the error message', async () => {
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
    expect(rejection.message).toBe(`the agent exited 1: ${'E'.repeat(237)}...`);
  });

  it('shows the line that names the error, not the banner above it', async () => {
    // Codex prints its version, workdir, model and sandbox before the 401 that
    // explains the failure; the first 200 characters named everything but it.
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintSummarize({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'prompt',
      cwd: '/tmp',
      timeoutMs: 30_000,
    });

    child.stderr.emit('data', Buffer.from([
      'Reading prompt from stdin...',
      'OpenAI Codex v0.154.0',
      '--------',
      'workdir: /tmp/answer',
      'model: gpt-5.5',
      'sandbox: read-only',
      'ERROR: Reconnecting... 5/5',
      'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
    ].join('\n')));
    child.emit('close', 1);

    const rejection = await resultPromise.catch((error: Error) => error);
    expect(rejection.message).toBe(
      'the agent exited 1: ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
    );
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

/**
 * The streamed text (`onChunk`).
 *
 * A pipe read can end between the bytes of one character. The returned value is
 * assembled from the raw buffers and was always whole, but each chunk forwarded
 * to a streaming consumer was decoded alone, so a split character reached the
 * screen as U+FFFD.
 */
describe('runCliPrintAnswer - the streamed text', () => {
  it('forwards a character split across stdout chunks whole, and the buffered answer agrees', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    const chunks: string[] = [];

    const resultPromise = runCliPrintAnswer({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'question',
      cwd: '/tmp',
      onChunk: (text) => chunks.push(text),
    });

    const whole = 'Route: café → done';
    const bytes = Buffer.from(whole, 'utf-8');
    // One read ends after the first byte of the two-byte character, the next
    // after the second byte of the three-byte one.
    const firstSplit = bytes.indexOf(Buffer.from('é', 'utf-8')) + 1;
    const secondSplit = bytes.indexOf(Buffer.from('→', 'utf-8')) + 2;
    child.stdout.emit('data', bytes.subarray(0, firstSplit));
    child.stdout.emit('data', bytes.subarray(firstSplit, secondSplit));
    child.stdout.emit('data', bytes.subarray(secondSplit));
    child.emit('close', 0);

    expect(await resultPromise).toBe(whole);
    expect(chunks.join('')).toBe(whole);
    expect(chunks.join('')).not.toContain('�');
  });

  it('holds back a chunk that is only the start of a character, rather than forwarding a replacement', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    const chunks: string[] = [];

    const resultPromise = runCliPrintAnswer({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'question',
      cwd: '/tmp',
      onChunk: (text) => chunks.push(text),
    });

    const arrow = Buffer.from('→', 'utf-8');
    child.stdout.emit('data', arrow.subarray(0, 1));
    // Nothing to show yet: the character is not whole.
    expect(chunks).toEqual([]);
    child.stdout.emit('data', arrow.subarray(1));
    expect(chunks).toEqual(['→']);

    child.emit('close', 0);
    expect(await resultPromise).toBe('→');
  });
});

/**
 * A CLI that exits before it reads its stdin (a rejected flag, a failed login)
 * closes the pipe under a prompt tens of thousands of characters long, and the
 * write fails as an EPIPE event on the stream. An `error` event nobody listens
 * for is thrown, which in the main process is an uncaught exception.
 */
describe('runCliPrintAnswer - a CLI that closes stdin before reading the prompt', () => {
  it('survives the EPIPE, and settles from close with the CLI\'s exit code and stderr', async () => {
    const child = makeFakeChild();
    // What the stream had listening at the moment the prompt was written: the
    // listener has to be there before the write, since the error comes after it.
    let errorListenersAtWrite = -1;
    child.stdin.end.mockImplementation(() => {
      errorListenersAtWrite = child.stdin.listenerCount('error');
    });
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliPrintAnswer({
      cliPath: '/usr/bin/fake',
      args: ['--bogus'],
      prompt: 'a very long prompt',
      cwd: '/tmp',
    });
    expect(child.stdin.end).toHaveBeenCalledWith('a very long prompt');
    expect(errorListenersAtWrite).toBeGreaterThan(0);

    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => child.stdin.emit('error', brokenPipe)).not.toThrow();

    child.stderr.emit('data', Buffer.from('error: unknown option --bogus'));
    child.emit('close', 2);
    // The exit code and stderr report the failure; the broken pipe adds nothing.
    await expect(resultPromise).rejects.toThrow('the agent exited 2: error: unknown option --bogus');
  });
});

/**
 * A CLI past its output budget is stopped once. Every chunk that lands after
 * the budget used to stop it again, and for a Windows `.cmd` shim each stop is a
 * `taskkill` process of its own.
 */
describe('runCliPrintAnswer - stopping a CLI that passes its output budget', () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  /** Emits `chunkCount` chunks of 80 bytes against a budget of 100: the second one crosses it. */
  function emitChunksPastBudget(child: FakeChild, chunkCount: number): void {
    for (let chunk = 0; chunk < chunkCount; chunk += 1) child.stdout.emit('data', Buffer.alloc(80, 'z'));
  }

  it('sends SIGTERM once, however many chunks arrive after the budget', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = runCliPrintAnswer({ cliPath: '/usr/bin/fake', args: [], prompt: 'question', cwd: '/tmp', outputBudget: 100 });

    // One chunk under the budget, then six past it.
    emitChunksPastBudget(child, 7);

    expect(child.kill.mock.calls.filter(([signal]) => signal === 'SIGTERM')).toHaveLength(1);
    child.emit('close', 0);
    // Only the chunk under the budget was kept.
    expect(await resultPromise).toHaveLength(80);
  });

  it('starts one taskkill for a CLI launched through cmd.exe, not one per chunk', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const child = makeFakeChild() as FakeChild & { pid: number };
    child.pid = 4242;
    const taskkill = { on: vi.fn(), unref: vi.fn() };
    taskkill.on.mockReturnValue(taskkill);
    mockSpawn.mockImplementation((command: string) => (command === 'taskkill' ? taskkill : child));
    const resultPromise = runCliPrintAnswer({ cliPath: 'C:\\tools\\fake.cmd', args: [], prompt: 'question', cwd: '/tmp', outputBudget: 100 });

    emitChunksPastBudget(child, 7);

    const taskkills = mockSpawn.mock.calls.filter(([command]) => command === 'taskkill');
    expect(taskkills).toHaveLength(1);
    expect(taskkills[0][1]).toEqual(['/pid', '4242', '/T', '/F']);
    child.emit('close', 0);
    expect(await resultPromise).toHaveLength(80);
  });
});

describe('runCliPrintSummarize - a prompt delivered through a file', () => {
  // For a CLI that reads its prompt from a file and not from stdin (Grok's
  // `--prompt-file`, Aider's `--message-file`). An answer prompt runs to about
  // 50k characters, past the Windows command-line limit, so it cannot ride argv.
  it('writes the prompt into cwd, names it after the flag, closes stdin empty, and removes it', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-prompt-file-test-'));
    try {
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const resultPromise = runCliPrintAnswer({
        cliPath: '/usr/bin/fake',
        args: ['--flag'],
        prompt: 'a very long prompt',
        cwd: directory,
        promptVia: 'file',
        promptFileFlag: '--prompt-file',
      });

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs.slice(0, 2)).toEqual(['--flag', '--prompt-file']);
      const promptPath = spawnArgs[2];
      expect(path.dirname(promptPath)).toBe(directory);
      expect(fs.readFileSync(promptPath, 'utf-8')).toBe('a very long prompt');
      // Nothing on stdin: the file IS the prompt.
      expect(child.stdin.end).toHaveBeenCalledWith();

      child.stdout.emit('data', Buffer.from('the answer'));
      child.emit('close', 0);
      expect(await resultPromise).toBe('the answer');
      // Gone once the call ends: it carries the user's history.
      expect(fs.existsSync(promptPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('words an answer failure for the answer, and keeps what the CLI said', async () => {
    // The Knowledge Graph prints this verbatim under the question the user asked.
    // The runner once named every failure "summarize CLI exited", a feature they
    // had not used.
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = runCliPrintAnswer({ cliPath: '/usr/bin/fake', args: [], prompt: 'q', cwd: '/tmp' });
    child.stderr.emit('data', Buffer.from('Error: Model "x" from --model flag is not available.'));
    child.emit('close', 1);
    await expect(resultPromise).rejects.toThrow(
      'the agent exited 1: Error: Model "x" from --model flag is not available.',
    );
  });

  it('refuses a file delivery with no flag to name the file', async () => {
    await expect(runCliPrintAnswer({
      cliPath: '/usr/bin/fake',
      args: [],
      prompt: 'x',
      cwd: os.tmpdir(),
      promptVia: 'file',
    })).rejects.toThrow(/promptFileFlag/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
