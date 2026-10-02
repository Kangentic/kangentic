/**
 * UtilityPtyHostTransport: main's side of the `kangentic-pty-host` utility
 * process. The fork is faked; what is pinned is the lifecycle: the init
 * handshake, request matching and timeouts, a crash that reports, restarts and
 * replays, the in-process fallback past the crash cap, the heartbeat, and a
 * shutdown that never restarts.
 *
 * Tier: Unit.
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeChild extends EventEmitter {
  readonly posted: unknown[] = [];
  readonly kill = vi.fn();
  constructor(readonly pid: number) {
    super();
  }
  postMessage(message: unknown): void {
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
vi.mock('../../src/main/diagnostics/event-loop-lag', () => ({ recordSyncSpan: vi.fn() }));

import { UtilityPtyHostTransport, ptyHostEntryPath } from '../../src/main/pty/host/utility-pty-host-transport';
import type { PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import { resetUtilityCrashTelemetryForTests } from '../../src/main/utility-process/restart-policy';

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
    transport.post({ type: 'setFocused', sessionIds: ['a'] });
    transport.start();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkMock).toHaveBeenCalledWith(
      expect.stringContaining('pty-host.js'),
      [],
      expect.objectContaining({ serviceName: 'kangentic-pty-host', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    expect(latestChild().posted[0]).toEqual({ type: 'init', projectsDir: '/mock/projects' });
    expect(latestChild().postedTypes()).toEqual(['init', 'setFocused']);
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
    transport.post({ type: 'setFocused', sessionIds: [] });
    expect(fallbackPost).toHaveBeenCalledWith({ type: 'setFocused', sessionIds: [] });
    await expect(transport.request('ping', {})).resolves.toBe('pong');
    expect(transport.hostPid).toBeNull();
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
});
