/**
 * UtilityPtyHostTransport: main's side of the `kangentic-pty-host` utility
 * process. The fork is faked; what is pinned is the lifecycle: the init
 * handshake, request matching and timeouts, the rejection types that tell a
 * slow host from a lost one, the budget a queued reap or Stop gets back when its
 * batch starts, a crash that reports, restarts and replays, the in-process
 * fallback past the crash cap, the heartbeat, and a shutdown that never
 * restarts.
 *
 * Tier: Unit.
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeChild extends EventEmitter {
  readonly posted: unknown[] = [];
  /** The ports each message transferred, by the message's index in `posted`. */
  readonly transfers = new Map<number, unknown[]>();
  readonly kill = vi.fn();
  constructor(readonly pid: number) {
    super();
  }
  postMessage(message: unknown, transfer?: unknown[]): void {
    if (transfer) this.transfers.set(this.posted.length, transfer);
    this.posted.push(message);
  }
  /** Messages after the init handshake, by type. */
  postedTypes(): string[] {
    return this.posted.map((message) => (message as { type: string }).type);
  }
}

const { forks, forkMock } = vi.hoisted(() => {
  const forkList: FakeChild[] = [];
  return {
    forks: forkList,
    forkMock: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: forkMock },
}));
vi.mock('../../src/main/utility-process/stderr-tail', () => ({
  UTILITY_PROCESS_STDIO: ['ignore', 'pipe', 'pipe'],
  StderrTail: class { snapshot(): string { return ''; } },
  captureWorkerStderr: vi.fn(),
  summarizeStderrTail: (text: string) => text,
}));
// The packaged mapping, so the entry-path test can tell the two trees apart.
vi.mock('../../src/main/utility-process/paths', () => ({ unpacked: (target: string) => target.replace('app.asar', 'app.asar.unpacked') }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../src/main/diagnostics/event-loop-lag', () => ({ recordRelayedSyncSpan: vi.fn() }));

import { UtilityPtyHostTransport, ptyHostEntryPath, ptyHostSpawnWorkerPath } from '../../src/main/pty/host/utility-pty-host-transport';
import type { PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { MessagePortMain } from 'electron';
import { UtilityRestartPolicy, resetUtilityCrashTelemetryForTests } from '../../src/main/utility-process/restart-policy';
import { PtyHostExitedError, PtyHostTimeoutError } from '../../src/main/pty/host/pty-host-request-errors';
import type { StopProcessRequest, StopProcessResult, TaggedReapRequest, TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';

const REAP_REQUEST: TaggedReapRequest = { tasks: [], mainPid: 1, stop: true };
const EMPTY_REAP: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] };
const STOP_REQUEST: StopProcessRequest = { pid: 4242, startKey: 'start-4242', mainPid: 1 };
const STOP_ANSWER: StopProcessResult = { outcome: 'stopped', failureCode: null, failurePass: null, failureReason: null };

function latestChild(): FakeChild {
  const child = forks[forks.length - 1];
  if (!child) throw new Error('no fork yet');
  return child;
}

function reply(child: FakeChild, id: number, result: unknown): void {
  child.emit('message', { type: 'reply', id, ok: true, result });
}

function lastRequestId(child: FakeChild): number {
  const requests = child.posted.filter((message) => (message as { type: string }).type === 'request');
  return (requests[requests.length - 1] as { id: number }).id;
}

function makeTransport() {
  const transport = new UtilityPtyHostTransport({ projectsDir: '/mock/projects' });
  const events: unknown[] = [];
  transport.setEventListener((event) => events.push(event));
  const lifecycle = { onHostDown: vi.fn(), onHostUp: vi.fn() };
  transport.setLifecycleListener(lifecycle);
  return { transport, events, lifecycle };
}

describe('UtilityPtyHostTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forks.length = 0;
    forkMock.mockReset();
    forkMock.mockImplementation(() => {
      const child = new FakeChild(1000 + forks.length);
      forks.push(child);
      return child;
    });
    resetUtilityCrashTelemetryForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forks once as kangentic-pty-host with the shared stdio, and sends init before anything else', () => {
    const { transport } = makeTransport();
    transport.post({ type: 'setRendererFocus', rendererId: 1, sessionIds: ['a'] });
    transport.start();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkMock).toHaveBeenCalledWith(
      expect.stringContaining('pty-host.js'),
      [],
      expect.objectContaining({ serviceName: 'kangentic-pty-host', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    // Main's executable rides the init, so the host refuses to launch it too
    // (on macOS the host's own execPath is the Helper bundle's), and so does
    // the spawn worker's bundle, which the host cannot resolve itself.
    expect(latestChild().posted[0]).toEqual({
      type: 'init',
      projectsDir: '/mock/projects',
      mainExecutable: process.execPath,
      spawnWorkerPath: expect.stringMatching(/pty-host-spawn-worker\.js$/),
    });
    expect(latestChild().postedTypes()).toEqual(['init', 'setRendererFocus']);
    expect(transport.hostPid).toBe(1000);
  });

  it('matches a reply to its request, rebuilds an error reply with its code, and routes events to the listener', async () => {
    const { transport, events } = makeTransport();
    const pong = transport.request('ping', {});
    const child = latestChild();
    reply(child, lastRequestId(child), 'pong');
    await expect(pong).resolves.toBe('pong');

    const failing = transport.request('getRawScrollback', { sessionId: 's' });
    child.emit('message', { type: 'reply', id: lastRequestId(child), ok: false, error: { message: 'gone', code: 'ESRCH' } });
    await expect(failing).rejects.toMatchObject({ message: 'gone', code: 'ESRCH' });

    child.emit('message', { type: 'outputSeen', sessionId: 's', chunks: 3 });
    expect(events).toEqual([{ type: 'outputSeen', sessionId: 's', chunks: 3 }]);
  });

  it('rejects a request the host never answers', async () => {
    const { transport } = makeTransport();
    const stuck = transport.request('getOutputPeek', { sessionId: 's' });
    const assertion = expect(stuck).rejects.toThrow(/did not answer getOutputPeek/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('on a crash rejects what was pending, reports the loss, restarts at once, and announces the restart once ready', async () => {
    const { transport, lifecycle } = makeTransport();
    transport.start();
    const first = latestChild();
    first.emit('message', { type: 'ready' });
    expect(lifecycle.onHostUp).toHaveBeenCalledWith(false);

    const pending = transport.request('ping', {});
    const assertion = expect(pending).rejects.toThrow(/exited/);
    first.emit('exit', 1);
    await assertion;
    expect(lifecycle.onHostDown).toHaveBeenCalledTimes(1);

    // Posted while the host is down: delivered to the new one, after init.
    transport.post({ type: 'setTapped', sessionIds: ['b'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(forks).toHaveLength(2);
    const second = latestChild();
    expect(second.postedTypes()).toEqual(['init', 'setTapped']);
    second.emit('message', { type: 'ready' });
    expect(lifecycle.onHostUp).toHaveBeenLastCalledWith(true);
    expect(transport.hostPid).toBe(1001);
  });

  it('announces a restart when the first host exited before it ever said ready', async () => {
    const { transport, lifecycle } = makeTransport();
    transport.start();
    const first = latestChild();
    // Commands posted straight to it died with it; the app never saw it up.
    first.emit('exit', 1);
    expect(lifecycle.onHostDown).toHaveBeenCalledTimes(1);
    expect(lifecycle.onHostUp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(forks).toHaveLength(2);
    latestChild().emit('message', { type: 'ready' });

    // Exactly one announcement, and it is a restart. Keying "restarted" on a
    // host having said ready once reported false here, so main never replayed
    // its focus and tap sets and never resumed the sessions the loss ended.
    expect(lifecycle.onHostUp).toHaveBeenCalledTimes(1);
    expect(lifecycle.onHostUp).toHaveBeenCalledWith(true);
  });

  it('does not replay to the restarted host a request whose caller already timed out while the host was down', async () => {
    // A request the caller was told failed may be retried, and an exec that
    // writes (`git worktree remove --force`) would then run twice. Red-green:
    // drop the `!this.pending.has(queued.id)` skip in `ensureChild` and the new
    // host is also handed the expired request, which is a second `request`.
    const { transport } = makeTransport();
    transport.start();
    latestChild().emit('message', { type: 'ready' });
    latestChild().emit('exit', 1);
    // The first restart is immediate. The second crash's backoff is 1 s, and
    // the restart timer polls the policy every 250 ms until it allows a fork:
    // that is the window the host is down for.
    await vi.advanceTimersByTimeAsync(0);
    expect(forks).toHaveLength(2);
    latestChild().emit('exit', 1);

    // Issued while the restart timer is set, so both are queued, not posted.
    const expired = transport.request('getOutputPeek', { sessionId: 'expired' }, { timeoutMs: 100 });
    const survivor = transport.request('getDiagnostics', {});
    const expiredAssertion = expect(expired).rejects.toThrow(/did not answer getOutputPeek/);
    await vi.advanceTimersByTimeAsync(100);
    await expiredAssertion;
    expect(forks).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(forks).toHaveLength(3);
    const restarted = latestChild();
    expect(restarted.postedTypes()).toEqual(['init', 'request']);
    expect(restarted.posted[1]).toMatchObject({ type: 'request', method: 'getDiagnostics' });

    // The survivor is still tracked: the replayed request is answered normally.
    reply(restarted, lastRequestId(restarted), { sessions: [] });
    await expect(survivor).resolves.toEqual({ sessions: [] });
  });

  it('ignores messages and exits from a host it has already replaced', async () => {
    const { transport, events, lifecycle } = makeTransport();
    transport.start();
    const first = latestChild();
    first.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    first.emit('message', { type: 'outputSeen', sessionId: 'stale', chunks: 1 });
    first.emit('exit', 1);
    expect(events).toEqual([]);
    expect(lifecycle.onHostDown).toHaveBeenCalledTimes(1);
  });

  it('falls back to the in-process core after five crashes, instead of leaving the app without terminals', async () => {
    const { transport, lifecycle } = makeTransport();
    const fallbackPost = vi.fn();
    const fallback: PtyHostTransport = {
      post: fallbackPost,
      request: vi.fn(async () => 'pong') as unknown as PtyHostTransport['request'],
      setEventListener: vi.fn(),
      attachRendererPort: vi.fn(),
      hostPid: null,
      shutdown: vi.fn(),
    };
    transport.setFallbackFactory(() => fallback);
    transport.start();
    for (let crash = 0; crash < 5; crash++) {
      latestChild().emit('exit', 1);
      // The policy's backoff (0, 1, 5, 15, 15 s) gates each restart.
      await vi.advanceTimersByTimeAsync(16_000);
    }
    expect(forks).toHaveLength(5);
    expect(lifecycle.onHostUp).toHaveBeenLastCalledWith(true);
    expect(fallback.setEventListener).toHaveBeenCalled();
    transport.post({ type: 'setRendererFocus', rendererId: 1, sessionIds: [] });
    expect(fallbackPost).toHaveBeenCalledWith({ type: 'setRendererFocus', rendererId: 1, sessionIds: [] });
    await expect(transport.request('ping', {})).resolves.toBe('pong');
    expect(transport.hostPid).toBeNull();
  });

  describe('a renderer\'s port', () => {
    const fakePort = (label: string) => ({ label }) as unknown as MessagePortMain;

    it('is transferred with its attach message, in order with the commands around it', () => {
      const { transport } = makeTransport();
      transport.start();
      const port = fakePort('renderer-7');
      transport.post({ type: 'setTapped', sessionIds: [] });
      transport.attachRendererPort(7, port);
      transport.post({ type: 'setRendererFocus', rendererId: 7, sessionIds: ['a'] });

      const child = latestChild();
      expect(child.postedTypes()).toEqual(['init', 'setTapped', 'attachRendererPort', 'setRendererFocus']);
      expect(child.posted[2]).toEqual({ type: 'attachRendererPort', rendererId: 7 });
      expect(child.transfers.get(2)).toEqual([port]);
      expect(child.transfers.size).toBe(1);
    });

    it('keeps its port while the host is down and hands both to the replacement', async () => {
      const { transport } = makeTransport();
      transport.start();
      latestChild().emit('message', { type: 'ready' });
      latestChild().emit('exit', 1);
      const port = fakePort('renderer-8');
      transport.attachRendererPort(8, port);
      await vi.advanceTimersByTimeAsync(1_000);

      const replacement = latestChild();
      const attachIndex = replacement.posted.findIndex((message) => (message as { type: string }).type === 'attachRendererPort');
      expect(attachIndex).toBeGreaterThan(0);
      expect(replacement.transfers.get(attachIndex)).toEqual([port]);
    });

    it('goes to the in-process fallback once the host has given up', async () => {
      const { transport } = makeTransport();
      const fallbackAttach = vi.fn();
      const fallback: PtyHostTransport = {
        post: vi.fn(),
        request: vi.fn(async () => 'pong') as unknown as PtyHostTransport['request'],
        setEventListener: vi.fn(),
        attachRendererPort: fallbackAttach,
        hostPid: null,
        shutdown: vi.fn(),
      };
      transport.setFallbackFactory(() => fallback);
      transport.start();
      for (let crash = 0; crash < 5; crash++) {
        latestChild().emit('exit', 1);
        await vi.advanceTimersByTimeAsync(16_000);
      }
      const port = fakePort('renderer-9');
      transport.attachRendererPort(9, port);

      expect(fallbackAttach).toHaveBeenCalledWith(9, port);
    });
  });

  it('logs a host that stops answering heartbeats', async () => {
    const { transport } = makeTransport();
    transport.start();
    latestChild().emit('message', { type: 'ready' });
    await vi.advanceTimersByTimeAsync(5_000 + 11_000);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/has not answered a heartbeat/));
  });

  it('forks from the unpacked tree on Windows and Linux, and from inside the asar on macOS', () => {
    // macOS: node-pty rewrites app.asar to app.asar.unpacked to find its
    // spawn-helper, which an already unpacked path would double.
    const bundleDirectory = '/mock/Kangentic.app/Contents/Resources/app.asar/.vite/build';
    expect(ptyHostEntryPath(bundleDirectory, 'darwin')).toBe(path.join(bundleDirectory, 'pty-host.js'));
    for (const platform of ['win32', 'linux'] as const) {
      expect(ptyHostEntryPath(bundleDirectory, platform)).toContain('app.asar.unpacked');
    }
  });

  it('starts the spawn worker from the unpacked tree on every platform', () => {
    // A worker thread loads its file with Node's own loader, which reads no asar.
    const bundleDirectory = '/mock/Kangentic.app/Contents/Resources/app.asar/.vite/build';
    expect(ptyHostSpawnWorkerPath(bundleDirectory)).toBe(
      path.join('/mock/Kangentic.app/Contents/Resources/app.asar.unpacked/.vite/build', 'pty-host-spawn-worker.js'),
    );
  });

  it('reports a fork that threw as fork_failed, not as an exit, and retries on the next restart poll', async () => {
    // A fork that throws never produced a process, so it has no exit code and
    // must not reach telemetry as an exit. Red-green: revert the catch to
    // `recordCrash(null)` and the cause defaults to 'exit'.
    const recordCrashSpy = vi.spyOn(UtilityRestartPolicy.prototype, 'recordCrash');
    forkMock.mockImplementationOnce(() => {
      throw new Error('spawn ENOENT');
    });
    const { transport } = makeTransport();

    transport.start();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forks).toHaveLength(0);
    expect(recordCrashSpy).toHaveBeenCalledTimes(1);
    expect(recordCrashSpy).toHaveBeenCalledWith(null, undefined, { cause: 'fork_failed' });
    expect(console.warn).toHaveBeenCalledWith('[pty-host] fork failed:', expect.any(Error));

    // The failure counts as one crash, so the restart timer forks again.
    await vi.advanceTimersByTimeAsync(0);
    expect(forks).toHaveLength(1);
  });

  it('shutdown posts shutdown, and the exit that follows neither restarts nor reports a loss', async () => {
    const { transport, lifecycle } = makeTransport();
    transport.start();
    const child = latestChild();
    transport.shutdown();
    expect(child.postedTypes()).toContain('shutdown');
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(forks).toHaveLength(1);
    expect(lifecycle.onHostDown).not.toHaveBeenCalled();
  });

  // A caller tells a slow host from a lost one by type, never by message: the
  // task reap reports them as `host_timeout` and `host_exited` (DESKTOP-1X).
  describe('typed rejections', () => {
    it('rejects a request a running host never answers with PtyHostTimeoutError, keeping its message', async () => {
      const { transport } = makeTransport();
      const stuck = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 15_000 });
      const assertion = expect(stuck).rejects.toBeInstanceOf(PtyHostTimeoutError);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      await expect(stuck).rejects.toThrow('The pty host did not answer reapTaggedProcesses in time');
    });

    it('rejects what was pending with PtyHostExitedError when the host exits', async () => {
      const { transport } = makeTransport();
      transport.start();
      const pending = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 15_000 });
      const assertion = expect(pending).rejects.toBeInstanceOf(PtyHostExitedError);
      latestChild().emit('exit', 1);
      await assertion;
    });

    it('rejects a request whose budget ran out while the host was down with PtyHostExitedError: no running host ever had it', async () => {
      const { transport } = makeTransport();
      transport.start();
      latestChild().emit('exit', 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(forks).toHaveLength(2);
      // The second crash's restart waits out a 1 s backoff, so the request is queued, not posted.
      latestChild().emit('exit', 1);
      const queued = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 100 });
      const assertion = expect(queued).rejects.toBeInstanceOf(PtyHostExitedError);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(forks).toHaveLength(2);
    });

    it('rejects a host error reply as a plain error, even one whose text reads like a timeout', async () => {
      const { transport } = makeTransport();
      const failing = transport.request('stopReportedProcess', STOP_REQUEST, { timeoutMs: 15_000 });
      const child = latestChild();
      child.emit('message', { type: 'reply', id: lastRequestId(child), ok: false, error: { message: 'The pty host did not answer stopReportedProcess in time' } });
      const error = await failing.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PtyHostTimeoutError);
      expect(error).not.toBeInstanceOf(PtyHostExitedError);
    });
  });

  // The host runs one reap batch at a time (TaggedReaper), and one Stop at a
  // time. Main's clock used to start at the send, so a reap queued behind a
  // running batch spent its own budget waiting (DESKTOP-1X). The host now says
  // when each batch starts, and main restarts the budget of every request of
  // that method still waiting.
  describe('a reap or Stop queued behind a running batch', () => {
    it('does not time out while the batch ahead of it is still inside its own budget', async () => {
      const { transport, events } = makeTransport();
      const first = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 15_000 });
      const child = latestChild();
      const firstId = lastRequestId(child);
      child.emit('message', { type: 'batch-started', method: 'reapTaggedProcesses' });
      await vi.advanceTimersByTimeAsync(1_000);
      const second = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 15_000 });
      const secondId = lastRequestId(child);
      let secondSettled = false;
      second.then(() => { secondSettled = true; }, () => { secondSettled = true; });

      // The first batch finishes inside its budget, and the host starts the second's.
      await vi.advanceTimersByTimeAsync(13_000);
      reply(child, firstId, EMPTY_REAP);
      child.emit('message', { type: 'batch-started', method: 'reapTaggedProcesses' });
      await expect(first).resolves.toEqual(EMPTY_REAP);

      // 19 s after its send, past the 16 s mark where the old clock rejected it.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(secondSettled).toBe(false);
      reply(child, secondId, EMPTY_REAP);
      await expect(second).resolves.toEqual(EMPTY_REAP);
      // A control message: the client's event listener never sees it.
      expect(events).toEqual([]);
    });

    it('times out a queued reap one full budget after its own batch started when that batch overruns', async () => {
      const { transport } = makeTransport();
      const first = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 15_000 });
      const child = latestChild();
      const firstId = lastRequestId(child);
      child.emit('message', { type: 'batch-started', method: 'reapTaggedProcesses' });
      await vi.advanceTimersByTimeAsync(1_000);
      const second = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 15_000 });
      let secondSettled = false;
      second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
      const secondAssertion = expect(second).rejects.toBeInstanceOf(PtyHostTimeoutError);

      await vi.advanceTimersByTimeAsync(13_000);
      reply(child, firstId, EMPTY_REAP);
      child.emit('message', { type: 'batch-started', method: 'reapTaggedProcesses' });
      await first;
      // The second's batch started at 14 s and never finishes.
      await vi.advanceTimersByTimeAsync(14_999);
      expect(secondSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await secondAssertion;
    });

    it('restarts only the budgets of the method whose batch started', async () => {
      const { transport } = makeTransport();
      const reap = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 15_000 });
      const stop = transport.request('stopReportedProcess', STOP_REQUEST, { timeoutMs: 15_000 });
      const child = latestChild();
      const stopId = lastRequestId(child);
      const reapAssertion = expect(reap).rejects.toBeInstanceOf(PtyHostTimeoutError);
      await vi.advanceTimersByTimeAsync(10_000);
      child.emit('message', { type: 'batch-started', method: 'stopReportedProcess' });
      // The reap's budget still runs from its send; the Stop's restarted at 10 s.
      await vi.advanceTimersByTimeAsync(5_000);
      await reapAssertion;
      reply(child, stopId, STOP_ANSWER);
      await expect(stop).resolves.toEqual(STOP_ANSWER);
    });
  });

  // A timed-out request is not cancelled: the host may still finish a reap and
  // kill what it found. Its answer used to be dropped, so those kills reached
  // no report and no toast.
  describe('the answer to a request main stopped waiting for', () => {
    it('reaches the caller\'s onLateResult once, when the host answers after the budget ran out', async () => {
      const { transport, events } = makeTransport();
      const lateResults: unknown[] = [];
      const request = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 15_000, onLateResult: (result) => { lateResults.push(result); } });
      const child = latestChild();
      const requestId = lastRequestId(child);
      const assertion = expect(request).rejects.toBeInstanceOf(PtyHostTimeoutError);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(lateResults).toEqual([]);

      reply(child, requestId, EMPTY_REAP);
      reply(child, requestId, EMPTY_REAP);
      expect(lateResults).toEqual([EMPTY_REAP]);
      expect(events).toEqual([]);
    });

    it('passes on no late error reply, and nothing after the host that owed the answer exited', async () => {
      const { transport } = makeTransport();
      transport.start();
      const onLateResult = vi.fn();
      const failing = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 100, onLateResult });
      const firstChild = latestChild();
      const failingId = lastRequestId(firstChild);
      const orphaned = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 100, onLateResult });
      const orphanedId = lastRequestId(firstChild);
      const assertions = [expect(failing).rejects.toBeInstanceOf(PtyHostTimeoutError), expect(orphaned).rejects.toBeInstanceOf(PtyHostTimeoutError)];
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all(assertions);

      firstChild.emit('message', { type: 'reply', id: failingId, ok: false, error: { message: 'the scan failed' } });
      // The host that ran the second exits before answering. The restarted one
      // never ran it, so an answer under its id is not the second's.
      firstChild.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(forks).toHaveLength(2);
      reply(latestChild(), orphanedId, EMPTY_REAP);
      expect(onLateResult).not.toHaveBeenCalled();
    });

    it('keeps no late callback for a request that never reached a running host', async () => {
      const { transport } = makeTransport();
      transport.start();
      latestChild().emit('exit', 1);
      await vi.advanceTimersByTimeAsync(0);
      latestChild().emit('exit', 1);
      const onLateResult = vi.fn();
      const queued = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 100, onLateResult });
      const assertion = expect(queued).rejects.toBeInstanceOf(PtyHostExitedError);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      // The restart does not post it (its caller was told it failed), so no host owes an answer.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(forks).toHaveLength(3);
      expect(latestChild().postedTypes()).toEqual(['init']);
      // A fresh transport's first request is id 1. An answer under it is not this request's.
      reply(latestChild(), 1, EMPTY_REAP);
      expect(onLateResult).not.toHaveBeenCalled();
    });

    it('contains a late callback that throws: the reply does not throw, a warning is logged, and the transport keeps serving requests', async () => {
      const { transport } = makeTransport();
      const onLateResult = vi.fn(() => { throw new Error('the caller could not handle the answer'); });
      const request = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 100, onLateResult });
      const child = latestChild();
      const requestId = lastRequestId(child);
      const assertion = expect(request).rejects.toBeInstanceOf(PtyHostTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      expect(() => reply(child, requestId, EMPTY_REAP)).not.toThrow();
      expect(onLateResult).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith('[pty-host] a late answer could not be handled:', expect.any(Error));

      const next = transport.request('ping', {});
      reply(child, lastRequestId(child), 'pong');
      await expect(next).resolves.toBe('pong');
    });

    it('keeps at most 64 late callbacks and drops the oldest first', async () => {
      const { transport } = makeTransport();
      const requestCount = 65;
      const lateCallbacks: Array<ReturnType<typeof vi.fn>> = [];
      const requestIds: number[] = [];
      const assertions: Array<Promise<void>> = [];
      for (let index = 0; index < requestCount; index++) {
        const onLateResult = vi.fn();
        lateCallbacks.push(onLateResult);
        const request = transport.request('reapTaggedProcesses', REAP_REQUEST, { timeoutMs: 100, onLateResult });
        requestIds.push(lastRequestId(latestChild()));
        // Attached before the timers run, so no rejection is ever unhandled.
        assertions.push(expect(request).rejects.toBeInstanceOf(PtyHostTimeoutError));
      }
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all(assertions);

      const child = latestChild();
      reply(child, requestIds[0], EMPTY_REAP);
      reply(child, requestIds[requestCount - 1], EMPTY_REAP);
      reply(child, requestIds[1], EMPTY_REAP);

      // The 65th timeout pushed the map past 64 and evicted the first request's callback, and only that one.
      expect(lateCallbacks[0]).not.toHaveBeenCalled();
      expect(lateCallbacks[requestCount - 1]).toHaveBeenCalledTimes(1);
      expect(lateCallbacks[requestCount - 1]).toHaveBeenCalledWith(EMPTY_REAP);
      expect(lateCallbacks[1]).toHaveBeenCalledTimes(1);
    });
  });
});
