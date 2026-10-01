/**
 * The pty host core (src/main/pty/host/pty-host-core.ts) and main's client
 * (pty-host-client.ts), driven directly over a mocked node-pty.
 *
 * The host owns every PTY and the per-chunk work on its output, so these pin
 * what main relies on it for: output reaches main only for a focused or tapped
 * session, the utility process merges its "output happened" events instead of
 * sending one per chunk, a spawn failure hands back the carry-over, and a
 * RemotePty behaves like a dead node-pty once the host reports the exit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as nodePty from 'node-pty';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import { InProcessPtyHostTransport, PtyHostClient, RemotePty } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostEvent, PtyHostSpawnParams } from '../../src/main/pty/host/protocol';
import type { AgentParser } from '../../src/shared/types';

interface FakePty {
  pty: nodePty.IPty;
  feed(data: string): void;
  exit(exitCode: number): void;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function createFakePty(pid = 4242): FakePty {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
  const write = vi.fn();
  const kill = vi.fn();
  const pty = {
    pid,
    cols: 120,
    rows: 30,
    onData: (listener: (data: string) => void) => {
      dataListener = listener;
      return { dispose: () => { dataListener = null; } };
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: () => { exitListener = null; } };
    },
    write,
    resize: vi.fn(),
    kill,
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as nodePty.IPty;
  return {
    pty,
    feed: (data) => dataListener?.(data),
    exit: (exitCode) => exitListener?.({ exitCode }),
    write,
    kill,
  };
}

function spawnParams(overrides: Partial<PtyHostSpawnParams> = {}): PtyHostSpawnParams {
  return {
    ptyId: 1,
    sessionId: 'session-1',
    projectId: 'project-1',
    agentName: null,
    transient: false,
    file: 'bash',
    args: [],
    cwd: '/mock/project',
    env: {},
    cols: 120,
    rows: 30,
    carryoverFromSessionId: null,
    dropSessionIds: [],
    agentSessionIdKnown: false,
    ...overrides,
  };
}

function makeCore(options: { coalesceMs?: number; agent?: AgentParser; fake?: FakePty } = {}) {
  const events: PtyHostEvent[] = [];
  const fake = options.fake ?? createFakePty();
  const appended: Array<{ sessionId: string; chunk: string }> = [];
  const core = new PtyHostCore({
    emit: (event) => events.push(event),
    resolveAgent: () => options.agent,
    transcriptSinkFor: () => ({ appendChunk: (sessionId, chunk) => appended.push({ sessionId, chunk }) }),
    coalesceMs: options.coalesceMs ?? 0,
    spawnPty: (() => fake.pty) as unknown as typeof nodePty.spawn,
  });
  return { core, events, fake, appended };
}

/** Let the 16ms flush run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20);
}

describe('PtyHostCore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a session\'s output to main only while it is focused or tapped', async () => {
    const { core, events, fake } = makeCore();
    core.spawn(spawnParams());

    fake.feed('unwatched');
    await flush();
    expect(events.filter((event) => event.type === 'data' || event.type === 'tap')).toEqual([]);

    core.handleCommand({ type: 'setFocused', sessionIds: ['session-1'] });
    fake.feed('focused');
    await flush();
    expect(events).toContainEqual({ type: 'data', sessionId: 'session-1', data: 'focused' });

    core.handleCommand({ type: 'setFocused', sessionIds: [] });
    core.handleCommand({ type: 'setTapped', sessionIds: ['session-1'] });
    fake.feed('tapped');
    await flush();
    expect(events).toContainEqual({ type: 'tap', sessionId: 'session-1', data: 'tapped' });
    expect(events).not.toContainEqual({ type: 'data', sessionId: 'session-1', data: 'tapped' });
  });

  it('merges outputSeen per window in the utility process, with a leading event', async () => {
    const { core, events, fake } = makeCore({ coalesceMs: 250 });
    core.spawn(spawnParams());

    for (let chunk = 0; chunk < 10; chunk += 1) fake.feed(`chunk ${chunk}`);
    const seenNow = events.filter((event) => event.type === 'outputSeen');
    // The first chunk is reported at once; the rest wait for the window.
    expect(seenNow).toEqual([{ type: 'outputSeen', sessionId: 'session-1', chunks: 1 }]);

    await vi.advanceTimersByTimeAsync(250);
    const seenAfter = events.filter((event) => event.type === 'outputSeen');
    expect(seenAfter).toEqual([
      { type: 'outputSeen', sessionId: 'session-1', chunks: 1 },
      { type: 'outputSeen', sessionId: 'session-1', chunks: 9 },
    ]);
  });

  it('reports PTY activity on the leading edge of a window and once more if it continued', async () => {
    const activityAgent = {
      detectFirstOutput: () => false,
      runtime: { activity: { kind: 'pty' } },
    } as unknown as AgentParser;
    const { core, events, fake } = makeCore({ coalesceMs: 250, agent: activityAgent });
    core.spawn(spawnParams({ agentName: 'fake' }));

    fake.feed('first line');
    expect(events.filter((event) => event.type === 'ptyData')).toHaveLength(1);
    fake.feed('second line');
    fake.feed('third line');
    expect(events.filter((event) => event.type === 'ptyData')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(events.filter((event) => event.type === 'ptyData')).toHaveLength(2);
  });

  it('sends one event per chunk in-process (coalesceMs 0)', () => {
    const { core, events, fake } = makeCore({ coalesceMs: 0 });
    core.spawn(spawnParams());
    fake.feed('a');
    fake.feed('b');
    expect(events.filter((event) => event.type === 'outputSeen')).toHaveLength(2);
  });

  it('captures an agent session id from output once, then stops scanning', () => {
    const scanningAgent = {
      detectFirstOutput: () => false,
      runtime: { sessionId: { fromOutput: (text: string) => text.match(/id=(\S+)/)?.[1] ?? null } },
    } as unknown as AgentParser;
    const { core, events, fake } = makeCore({ agent: scanningAgent });
    core.spawn(spawnParams({ agentName: 'fake' }));

    fake.feed('id=first-id\n');
    fake.feed('id=second-id\n');
    expect(events.filter((event) => event.type === 'agentSessionId')).toEqual([
      { type: 'agentSessionId', sessionId: 'session-1', capturedId: 'first-id' },
    ]);
  });

  it('writes the transcript itself and flushes it before reporting the exit', () => {
    const { core, events, fake, appended } = makeCore();
    core.spawn(spawnParams());
    fake.feed('plain transcript text');

    fake.exit(0);

    expect(appended).toEqual([{ sessionId: 'session-1', chunk: 'plain transcript text' }]);
    expect(events[events.length - 1]).toEqual({ type: 'exit', ptyId: 1, sessionId: 'session-1', exitCode: 0 });
  });

  it('keeps no transcript for a Command Terminal', () => {
    const { core, fake, appended } = makeCore();
    core.spawn(spawnParams({ transient: true }));
    fake.feed('command terminal output');
    fake.exit(0);
    expect(appended).toEqual([]);
  });

  it('carries the previous ring over, then drops the old session', () => {
    const { core } = makeCore();
    core.handleCommand({ type: 'initSession', sessionId: 'old-session', scrollback: 'old bytes', cols: 120 });

    core.spawn(spawnParams({ carryoverFromSessionId: 'old-session', dropSessionIds: ['old-session'] }));

    expect(core.getRawScrollback('session-1')).toBe('old bytes');
    expect(core.getRawScrollback('old-session')).toBe('');
  });

  it('hands the carry-over back when the spawn throws, so main can show it with the diagnostic', () => {
    const events: PtyHostEvent[] = [];
    const core = new PtyHostCore({
      emit: (event) => events.push(event),
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      spawnPty: (() => {
        const error = new Error('spawn failed') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }) as unknown as typeof nodePty.spawn,
    });
    core.handleCommand({ type: 'initSession', sessionId: 'old-session', scrollback: 'previous bytes', cols: 120 });

    const result = core.spawn(spawnParams({ carryoverFromSessionId: 'old-session', dropSessionIds: ['old-session'] }));

    expect(result).toMatchObject({ ok: false, previousScrollback: 'previous bytes', error: { message: 'spawn failed', code: 'ENOENT' } });
  });

  it('drops a second kill of the same PTY (a double ConPTY kill corrupts its heap)', () => {
    const { core, fake } = makeCore();
    core.spawn(spawnParams());
    core.handleCommand({ type: 'kill', ptyId: 1 });
    core.handleCommand({ type: 'kill', ptyId: 1 });
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it('shutdown flushes the transcripts and kills nothing: main posts the kills, a young one after its grace', () => {
    const { core, fake, appended } = makeCore();
    core.spawn(spawnParams());
    fake.feed('unflushed text');

    core.handleCommand({ type: 'shutdown' });

    expect(appended).toEqual([{ sessionId: 'session-1', chunk: 'unflushed text' }]);
    expect(fake.kill).not.toHaveBeenCalled();
    expect(core.livePtyCount).toBe(1);
    fake.exit(0);
    expect(core.livePtyCount).toBe(0);
  });
});

describe('PtyHostClient and RemotePty', () => {
  it('spawns through the transport and routes the exit to the PTY\'s own listener', async () => {
    const fake = createFakePty(555);
    const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
    // Spawn through the core's injected factory: replace it for this test.
    (transport.core as unknown as { spawnPty: unknown }).spawnPty = () => fake.pty;
    const client = new PtyHostClient(transport);

    const outcome = await client.spawn({
      sessionId: 'session-1',
      projectId: 'project-1',
      agentName: null,
      transient: false,
      file: 'bash',
      args: [],
      cwd: '/mock/project',
      env: {},
      cols: 100,
      rows: 40,
      carryoverFromSessionId: null,
      dropSessionIds: [],
      agentSessionIdKnown: false,
    });
    if (!outcome.ok) throw new Error('spawn failed');
    const remote = outcome.pty;
    expect(remote.pid).toBe(555);
    expect(remote.cols).toBe(100);

    remote.write('hello');
    expect(fake.write).toHaveBeenCalledWith('hello');

    const exitListener = vi.fn();
    client.onPtyExit(remote.ptyId, exitListener);
    fake.exit(3);
    expect(exitListener).toHaveBeenCalledWith(3);
    expect(remote.hasExited).toBe(true);
  });

  it('a RemotePty throws ESRCH on kill and refuses a resize once the host reported the exit, like node-pty', () => {
    const transport = { post: vi.fn() } as unknown as InProcessPtyHostTransport;
    const remote = new RemotePty(1, 99, 80, 24, transport);

    remote.resize(100, 30);
    expect(remote.cols).toBe(100);
    remote.kill();
    expect(transport.post).toHaveBeenCalledWith({ type: 'kill', ptyId: 1 });

    remote.markExited();
    expect(() => remote.kill()).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(() => remote.resize(80, 24)).toThrow();
    // A write to a dead PTY is dropped, never sent.
    vi.mocked(transport.post).mockClear();
    remote.write('ignored');
    expect(transport.post).not.toHaveBeenCalled();
  });
});
