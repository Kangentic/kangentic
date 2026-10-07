/**
 * The pty host core (src/main/pty/host/pty-host-core.ts) and main's client
 * (pty-host-client.ts), driven directly over a mocked node-pty.
 *
 * The host owns every PTY and the per-chunk work on its output, so these pin
 * what main relies on it for: output reaches main only for a focused or tapped
 * session, the utility process merges its "output happened" events instead of
 * sending one per chunk, a spawn failure hands back the carry-over, a PTY whose
 * program is the app's own executable is refused as a failed spawn, and a
 * RemotePty behaves like a dead node-pty once the host reports the exit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as nodePty from 'node-pty';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import { setMainExecutable } from '../../src/main/pty/host/host-exec';
import { InProcessPtyHostTransport, PtyHostClient, RemotePty, type PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostCommand, PtyHostEvent, PtyHostRawSpawnParams, PtyHostSpawnParams } from '../../src/main/pty/host/protocol';
import { HostUnavailableError } from '../../src/main/utility-process/off-main-pty';
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
    agentSessionIdKnown: false,
    ...overrides,
  };
}

function rawSpawnParams(overrides: Partial<PtyHostRawSpawnParams> = {}): PtyHostRawSpawnParams {
  return {
    ptyId: 9,
    file: 'claude',
    args: ['--safe-mode'],
    cwd: '/mock/scratch',
    env: {},
    cols: 120,
    rows: 40,
    name: 'xterm-256color',
    ...overrides,
  };
}

function makeCore(options: { coalesceMs?: number; agent?: AgentParser; fake?: FakePty } = {}) {
  const events: PtyHostEvent[] = [];
  const fake = options.fake ?? createFakePty();
  const appended: Array<{ sessionId: string; chunk: string }> = [];
  const spawnPty = vi.fn((_file: string, _args: string[], _options: object) => fake.pty);
  const core = new PtyHostCore({
    emit: (event) => events.push(event),
    resolveAgent: () => options.agent,
    transcriptSinkFor: () => ({ appendChunk: (sessionId, chunk) => appended.push({ sessionId, chunk }) }),
    coalesceMs: options.coalesceMs ?? 0,
    spawnPty: spawnPty as unknown as typeof nodePty.spawn,
  });
  return { core, events, fake, appended, spawnPty };
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
    // The offset counts every character the parser received, tapped or not:
    // 'unwatched' + 'focused' + 'tapped' is 22.
    expect(events).toContainEqual({ type: 'tap', sessionId: 'session-1', data: 'tapped', endOffset: 22 });
    expect(events).not.toContainEqual({ type: 'data', sessionId: 'session-1', data: 'tapped' });
  });

  it('answers getSeedFrame with the parsed frame and the parser offset its snapshot covers', async () => {
    // The headless parser's write barrier runs on real timers.
    vi.useRealTimers();
    const { core, fake } = makeCore();
    core.spawn(spawnParams());
    fake.feed('hello ');
    fake.feed('world');
    const seed = await core.handleRequest('getSeedFrame', { sessionId: 'session-1', settle: false });
    expect(seed.barrierOffset).toBe('hello world'.length);
    expect(seed.frame).toContain('hello world');
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

  it('reports nothing for a session main removed while its PTY still runs, and leaves no merge window behind', async () => {
    const coalesceEntries = (core: PtyHostCore) => (core as unknown as { coalesce: Map<string, unknown> }).coalesce;
    const outputSeenEvents = (events: PtyHostEvent[]) => events.filter((event) => event.type === 'outputSeen');
    const { core, events, fake } = makeCore({ coalesceMs: 250 });
    core.spawn(spawnParams());

    // Control: while main holds the session its output is reported and a merge
    // window opens, so the silence below cannot be a dead feed.
    fake.feed('output before the removal');
    expect(outputSeenEvents(events)).toHaveLength(1);
    expect(coalesceEntries(core).has('session-1')).toBe(true);

    // main removed the row while a young agent's PTY waits out its kill grace.
    core.handleCommand({ type: 'removeSession', sessionId: 'session-1' });
    expect(coalesceEntries(core).has('session-1')).toBe(false);
    events.length = 0;

    fake.feed('exit screen painted after the removal');
    expect(outputSeenEvents(events)).toEqual([]);
    // A window opened here would never be closed: dropSession already ran.
    expect(coalesceEntries(core).has('session-1')).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    expect(outputSeenEvents(events)).toEqual([]);
    expect(coalesceEntries(core).has('session-1')).toBe(false);
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

  it('carries the previous ring over, and keeps the old session until main removes it', () => {
    const { core } = makeCore();
    core.handleCommand({ type: 'initSession', sessionId: 'old-session', scrollback: 'old bytes', cols: 120 });

    core.spawn(spawnParams({ carryoverFromSessionId: 'old-session' }));

    expect(core.getRawScrollback('session-1')).toBe('old bytes');
    // Kept: a spawn cancelled in the round trip must leave the old session as
    // it was, so main drops it only once it knows the spawn stands.
    expect(core.getRawScrollback('old-session')).toBe('old bytes');
    core.handleCommand({ type: 'removeSession', sessionId: 'old-session' });
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

    const result = core.spawn(spawnParams({ carryoverFromSessionId: 'old-session' }));

    expect(result).toMatchObject({ ok: false, previousScrollback: 'previous bytes', error: { message: 'spawn failed', code: 'ENOENT' } });
  });

  describe('a PTY whose program is this app\'s own executable', () => {
    // With the RunAsNode fuse off, a packaged Kangentic.exe started as a child
    // boots a second app, so the host refuses it for a PTY as it does for a
    // one-shot run. A user's shell setting (a session's program) or an agent
    // CLI path override (a probe's) is the way a request gets here. The refusal
    // is a failed spawn, never a throw out of the core, and node-pty is never
    // asked.
    const REFUSAL = 'The pty host does not launch its own executable';
    const MAIN_BINARY = '/opt/Kangentic/kangentic';
    afterEach(() => setMainExecutable(undefined));

    it('refuses a session spawn of this process\'s executable as a failed spawn, with the carry-over handed back, and never calls node-pty', () => {
      const { core, spawnPty } = makeCore();
      core.handleCommand({ type: 'initSession', sessionId: 'old-session', scrollback: 'previous bytes', cols: 120 });

      const result = core.spawn(spawnParams({ file: process.execPath, carryoverFromSessionId: 'old-session' }));

      expect(result).toMatchObject({ ok: false, error: { message: REFUSAL }, previousScrollback: 'previous bytes' });
      expect(spawnPty).not.toHaveBeenCalled();
      expect(core.livePtyCount).toBe(0);
    });

    it('refuses a raw spawn of this process\'s executable as a failed spawn and never calls node-pty', () => {
      const { core, spawnPty } = makeCore();

      const result = core.spawnRaw(rawSpawnParams({ file: process.execPath }));

      expect(result).toMatchObject({ ok: false, error: { message: REFUSAL } });
      expect(spawnPty).not.toHaveBeenCalled();
      expect(core.livePtyCount).toBe(0);
    });

    it('refuses main\'s executable, as main reported it in the init, for a raw spawn and a session spawn', () => {
      const { core, spawnPty } = makeCore();

      // Control: before main reports its executable nothing marks this path as
      // the app's, so the same spawn goes through. The refusals below are the
      // report's doing.
      expect(core.spawnRaw(rawSpawnParams({ ptyId: 1, file: MAIN_BINARY }))).toMatchObject({ ok: true });
      expect(spawnPty).toHaveBeenCalledTimes(1);

      setMainExecutable(MAIN_BINARY);
      expect(core.spawnRaw(rawSpawnParams({ ptyId: 2, file: MAIN_BINARY }))).toMatchObject({ ok: false, error: { message: REFUSAL } });
      expect(core.spawn(spawnParams({ ptyId: 3, sessionId: 'session-main-binary', file: MAIN_BINARY }))).toMatchObject({ ok: false, error: { message: REFUSAL } });
      expect(spawnPty).toHaveBeenCalledTimes(1);
    });

    it('still spawns an unrelated program, for a session and for a raw PTY, with this process\'s and main\'s executables known', () => {
      setMainExecutable(MAIN_BINARY);
      const { core, spawnPty } = makeCore();

      expect(core.spawn(spawnParams({ file: 'bash' }))).toEqual({ ok: true, pid: 4242 });
      expect(core.spawnRaw(rawSpawnParams({ file: 'claude' }))).toEqual({ ok: true, pid: 4242 });

      expect(spawnPty).toHaveBeenCalledTimes(2);
      expect(spawnPty.mock.calls.map((call) => call[0])).toEqual(['bash', 'claude']);
    });
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

  it('runs a probe\'s raw PTY in the host: raw output, write and kill by ptyId, and one exit', async () => {
    const fake = createFakePty(777);
    const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
    (transport.core as unknown as { spawnPty: unknown }).spawnPty = () => fake.pty;
    const client = new PtyHostClient(transport);

    const raw = await client.spawnRaw('claude', ['--safe-mode'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/mock/scratch', env: {} });
    expect(raw.pid).toBe(777);
    const output: string[] = [];
    raw.onData((data) => output.push(data));
    const exitListener = vi.fn();
    raw.onExit(exitListener);

    // Raw: every chunk as it came, with none of the session pipeline's merging.
    fake.feed('❯ ');
    fake.feed('Select model');
    expect(output).toEqual(['❯ ', 'Select model']);
    raw.write('/model');
    expect(fake.write).toHaveBeenCalledWith('/model');
    raw.kill();
    raw.kill();
    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(transport.core.livePtyCount).toBe(1);

    fake.exit(0);
    expect(exitListener).toHaveBeenCalledWith({ exitCode: 0 });
    expect(transport.core.livePtyCount).toBe(0);
  });

  it('a raw spawn that throws in the host rejects with that error, not as an unreachable host', async () => {
    const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
    (transport.core as unknown as { spawnPty: unknown }).spawnPty = () => {
      throw Object.assign(new Error('File not found: agy'), { code: 'ENOENT' });
    };
    const client = new PtyHostClient(transport);
    const { HostUnavailableError } = await import('../../src/main/utility-process/off-main-pty');
    const failure = client.spawnRaw('agy', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/mock', env: {} });
    await expect(failure).rejects.toMatchObject({ message: 'File not found: agy', code: 'ENOENT' });
    await expect(failure).rejects.not.toBeInstanceOf(HostUnavailableError);
  });

  /** A transport whose host never answers a request: it exited, or timed out. */
  function unansweredTransport(cause: unknown) {
    const posted: PtyHostCommand[] = [];
    const requestedPtyIds: number[] = [];
    const transport: PtyHostTransport = {
      post: (command) => { posted.push(command); },
      request: ((_method: string, params: { ptyId: number }) => {
        requestedPtyIds.push(params.ptyId);
        return Promise.reject(cause);
      }) as unknown as PtyHostTransport['request'],
      setEventListener: () => undefined,
      hostPid: null,
      shutdown: () => undefined,
    };
    return { transport, posted, requestedPtyIds };
  }

  const spawnInput = {
    sessionId: 'session-1',
    projectId: 'project-1',
    agentName: null,
    transient: false,
    file: 'bash',
    args: [] as string[],
    cwd: '/mock/project',
    env: {},
    cols: 100,
    rows: 40,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
  };

  it('a spawn the host never answers resolves as a failed spawn, and kills the PTY it may still start', async () => {
    const { transport, posted, requestedPtyIds } = unansweredTransport(new Error('The pty host exited'));
    const client = new PtyHostClient(transport);

    // Resolves, never throws: a throw skipped the session's spawn-failure path
    // and left a promoted queue row `queued` for good.
    const outcome = await client.spawn(spawnInput);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a failed spawn');
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toBe('The pty host exited');
    expect(outcome.previousScrollback).toBe('');
    // The kill names the very ptyId the request carried, so a host that runs
    // the request late finds that PTY and ends it.
    expect(requestedPtyIds).toHaveLength(1);
    expect(posted).toEqual([{ type: 'kill', ptyId: requestedPtyIds[0] }]);

    // The next attempt uses a fresh id, and is killed under that one.
    await client.spawn(spawnInput);
    expect(requestedPtyIds[1]).not.toBe(requestedPtyIds[0]);
    expect(posted[1]).toEqual({ type: 'kill', ptyId: requestedPtyIds[1] });
  });

  it('wraps a spawn rejection that is not an Error, so the failure path always gets one', async () => {
    const { transport } = unansweredTransport('request timed out');
    const client = new PtyHostClient(transport);

    const outcome = await client.spawn(spawnInput);

    if (outcome.ok) throw new Error('expected a failed spawn');
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toBe('request timed out');
  });

  it('a raw spawn the host never answers rejects as an unreachable host, and kills the PTY it may still start', async () => {
    const { transport, posted, requestedPtyIds } = unansweredTransport(new Error('The pty host did not answer spawnRaw in time'));
    const client = new PtyHostClient(transport);

    const failure = client.spawnRaw('agy', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/mock', env: {} });

    // HostUnavailableError is the signal for the caller to spawn locally.
    await expect(failure).rejects.toBeInstanceOf(HostUnavailableError);
    await expect(failure).rejects.toThrow('The pty host did not answer spawnRaw in time');
    expect(requestedPtyIds).toHaveLength(1);
    expect(posted).toEqual([{ type: 'kill', ptyId: requestedPtyIds[0] }]);
  });
});
