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
import fs from 'node:fs';
import os from 'node:os';
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

/** A host's stderr tail whose text a test sets, one per fork, in fork order. */
interface FakeStderrTail {
  text: string;
  /** What `whenDrained` hands back: null while nothing is still arriving. */
  drain: Promise<void> | null;
  /** Watchdog lines a trim took out of `text`, so a test can stand for one. */
  droppedWatchdogLines: number;
  snapshot(): string;
  watchdogLineCount(): number;
  watchdogLinesSeen(): number;
  whenDrained(timeoutMs: number): Promise<void> | null;
}

const { forks, forkMock, stderrTails } = vi.hoisted(() => {
  const forkList: FakeChild[] = [];
  return {
    forks: forkList,
    forkMock: vi.fn(),
    stderrTails: [] as FakeStderrTail[],
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: forkMock },
}));
// The real text helpers (`watchdogLine` names the held step), with a tail a test fills
// in place of the piped stderr.
vi.mock('../../src/main/utility-process/stderr-tail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/stderr-tail')>();
  return {
    ...actual,
    UTILITY_PROCESS_STDIO: ['ignore', 'pipe', 'pipe'],
    StderrTail: class implements FakeStderrTail {
      text = '';
      drain: Promise<void> | null = null;
      droppedWatchdogLines = 0;
      constructor() {
        stderrTails.push(this);
      }
      snapshot(): string {
        return this.text;
      }
      watchdogLineCount(): number {
        return actual.watchdogLineCount(this.text);
      }
      watchdogLinesSeen(): number {
        return this.droppedWatchdogLines + actual.watchdogLineCount(this.text);
      }
      whenDrained(): Promise<void> | null {
        return this.drain;
      }
    },
    captureWorkerStderr: vi.fn(),
  };
});
// The packaged mapping, so the entry-path test can tell the two trees apart.
vi.mock('../../src/main/utility-process/paths', () => ({ unpacked: (target: string) => target.replace('app.asar', 'app.asar.unpacked') }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../src/main/diagnostics/event-loop-lag', () => ({ recordRelayedSyncSpan: vi.fn(), relayLagRecord: vi.fn() }));

import { WATCHDOG_CHECK_INTERVAL_MS, WATCHDOG_HELD_CHECKS } from '../../src/main/utility-process/event-loop-watchdog';
import { HEARTBEAT_LATE_TIMER_MS, LATE_BEAT_SETTLE_MS, UtilityPtyHostTransport, ptyHostEntryPath, ptyHostSpawnWorkerPath } from '../../src/main/pty/host/utility-pty-host-transport';
import { reportHandledError } from '../../src/main/analytics/error-reporting';
import { recordRelayedSyncSpan, relayLagRecord } from '../../src/main/diagnostics/event-loop-lag';
import type { PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { MessagePortMain } from 'electron';
import { UtilityRestartPolicy, resetUtilityCrashTelemetryForTests } from '../../src/main/utility-process/restart-policy';
import { PtyHostExitedError, PtyHostTimeoutError } from '../../src/main/pty/host/pty-host-request-errors';
import { reportPtyHostStallFromLastRun, resetPtyHostReports } from '../../src/main/pty/host/pty-host-report';
import type { StopProcessRequest, StopProcessResult, TaggedReapRequest, TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';

const REAP_REQUEST: TaggedReapRequest = { tasks: [], mainPid: 1, stop: true };
const EMPTY_REAP: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, failureCause: null, entries: [] };
const STOP_REQUEST: StopProcessRequest = { pid: 4242, startKey: 'start-4242', mainPid: 1 };
const STOP_ANSWER: StopProcessResult = { outcome: 'stopped', failureCode: null, failurePass: null, failureCause: null, failureReason: null };

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
    // The stall report latches once per run, at module scope.
    resetPtyHostReports();
    stderrTails.length = 0;
    vi.mocked(reportHandledError).mockClear();
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

  it('hands the host\'s own stalls to the lag monitor as the pty host\'s, and no listener sees them', () => {
    // The host's rings die with it. Main's lag journal is how its stalls are
    // still readable after a restart, and it learns of them only through this.
    const { transport, events } = makeTransport();
    transport.start();
    const spike = { kind: 'spike' as const, at: '2026-11-23T19:22:34.471Z', lagMs: 95 };

    latestChild().emit('message', { type: 'lag-record', record: spike });
    latestChild().emit('message', { type: 'slow-span', label: 'pty:spawn', ms: 23 });

    expect(relayLagRecord).toHaveBeenCalledWith('pty-host', spike);
    expect(recordRelayedSyncSpan).toHaveBeenCalledWith('pty-host:pty:spawn', 23);
    expect(events).toEqual([]);
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

  it('reports the first host crash of a run, since each one ends every terminal and the latch alone would hide it', () => {
    vi.mocked(reportHandledError).mockClear();
    const { transport } = makeTransport();
    transport.start();
    latestChild().emit('message', { type: 'ready' });
    latestChild().emit('exit', 1);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, tags, , fingerprint] = vi.mocked(reportHandledError).mock.calls[0];
    expect((error as Error).message).toBe('kangentic-pty-host worker exited (exit code 1)');
    expect(tags).toMatchObject({ service: 'kangentic-pty-host', phase: 'first' });
    expect(fingerprint).toEqual(['utility-process-first-crash', 'kangentic-pty-host', 'exit']);
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

  // Sentry DESKTOP-43 carried only the 11 s threshold: a host that came back at 12 s and one
  // that never answered looked the same, and nothing said what held it. The report now waits
  // for the stall to end, and carries the host's stderr with its watchdog's line.
  describe('the heartbeat stall report', () => {
    const WATCHDOG_LINE = '[pty-host] event loop held 5 s in pty:headless-parse';
    const EARLIER_STDERR = 'an earlier line';
    const HOST_STDERR = `${EARLIER_STDERR}\n${WATCHDOG_LINE}`;

    /** The host's watchdog writes its line while the stall holds the loop. */
    function watchdogWritesDuringStall(): void {
      stderrTails[stderrTails.length - 1].text = HOST_STDERR;
    }

    function stallReports(): Array<{ tags: Record<string, string>; contexts: Record<string, Record<string, unknown>>; fingerprint: string[] | undefined }> {
      return vi.mocked(reportHandledError).mock.calls
        .filter(([, tags]) => tags?.code === 'heartbeat_stall')
        .map(([, tags, contexts, fingerprint]) => ({ tags: tags ?? {}, contexts: contexts ?? {}, fingerprint }));
    }

    /** A ready host with stderr in its tail, its first ping sent and still waiting. */
    async function hostWithPingSent(stallAtQuitFilePath?: string): Promise<{ transport: UtilityPtyHostTransport; child: FakeChild; pingId: number }> {
      const transport = new UtilityPtyHostTransport({ projectsDir: '/mock/projects', stallAtQuitFilePath });
      transport.setEventListener(() => undefined);
      transport.setLifecycleListener({ onHostDown: vi.fn(), onHostUp: vi.fn() });
      transport.start();
      const child = latestChild();
      stderrTails[stderrTails.length - 1].text = EARLIER_STDERR;
      child.emit('message', { type: 'ready' });
      await vi.advanceTimersByTimeAsync(5_000);
      return { transport, child, pingId: lastRequestId(child) };
    }

    /**
     * Sleeps past the ping's send (fake t=5 s), then lets the 11 s threshold timer fire
     * `lateMs` late. Date.now at the fire is start + 11 s + lateMs, so timerLateMs is lateMs.
     * The ping's own 15 s timeout (fake t=20 s) has not fired yet when this returns.
     */
    async function thresholdTimerFiresLate(lateMs: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(5_000);
      vi.setSystemTime(Date.now() + lateMs);
      await vi.advanceTimersByTimeAsync(6_000);
    }

    it('says how late a host that came back answered, with its stderr and the step that held it', async () => {
      const { transport, child, pingId } = await hostWithPingSent();
      // A spawn waiting behind the stall is named; the ping itself is not.
      void transport.request('spawn', {} as never).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(6_000);
      watchdogWritesDuringStall();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stallReports(), 'nothing is sent until the stall ends').toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_000);
      reply(child, pingId, null);
      await vi.advanceTimersByTimeAsync(0);

      const reports = stallReports();
      expect(reports).toHaveLength(1);
      const [report] = reports;
      expect(report.tags).toMatchObject({ source: 'pty_host', code: 'heartbeat_stall', outcome: 'answered' });
      expect(report.fingerprint).toEqual(['pty-host', 'heartbeat-stall']);
      expect(report.contexts.pty_host).toMatchObject({
        unansweredMs: 11_000,
        outcome: 'answered',
        answeredAfterMs: 12_000,
        neverAnswered: false,
        inFlight: ['spawn'],
        heldStep: WATCHDOG_LINE,
      });
      expect(report.contexts.utility_process).toEqual({ service: 'kangentic-pty-host', stderrTail: HOST_STDERR });
    });

    it('says a host never answered when the ping runs out its budget, with its stderr', async () => {
      await hostWithPingSent();
      await vi.advanceTimersByTimeAsync(6_000);
      watchdogWritesDuringStall();
      await vi.advanceTimersByTimeAsync(10_000);

      const reports = stallReports();
      expect(reports).toHaveLength(1);
      expect(reports[0].tags.outcome).toBe('no_answer');
      expect(reports[0].contexts.pty_host).toMatchObject({ answeredAfterMs: null, neverAnswered: true, heldStep: WATCHDOG_LINE });
      expect(reports[0].contexts.utility_process.stderrTail).toBe(HOST_STDERR);
    });

    it('says the host exited, with the stderr the exit took from the transport, read once its pipe drained', async () => {
      const { child } = await hostWithPingSent();
      await vi.advanceTimersByTimeAsync(11_000);
      // The dying host's last stderr lands after its exit (Electron drains the pipe after it).
      let finishDrain = (): void => undefined;
      // Held here: the exit restarts the host at once, and the new host gets a tail of its own.
      const dyingTail = stderrTails[stderrTails.length - 1];
      dyingTail.drain = new Promise<void>((resolve) => {
        finishDrain = resolve;
      });
      // The exit drops the transport's own tail before the ping's rejection runs.
      child.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(stallReports(), 'the report waits for the pipe').toHaveLength(0);
      dyingTail.text = HOST_STDERR;
      finishDrain();
      await vi.advanceTimersByTimeAsync(0);

      const reports = stallReports();
      expect(reports).toHaveLength(1);
      expect(reports[0].tags.outcome).toBe('host_exited');
      expect(reports[0].contexts.pty_host).toMatchObject({ neverAnswered: true, heldStep: WATCHDOG_LINE });
      expect(reports[0].contexts.utility_process.stderrTail).toBe(HOST_STDERR);
    });

    it('names no held step from a watchdog line written before this stall', async () => {
      // A hold long before (a spawn an hour earlier) is still the tail's newest line. With no new
      // line, main's own loop was held or the host's watchdog never ran: naming the old step
      // would blame the wrong work.
      const { transport } = makeTransport();
      transport.start();
      const child = latestChild();
      stderrTails[stderrTails.length - 1].text = HOST_STDERR;
      child.emit('message', { type: 'ready' });
      await vi.advanceTimersByTimeAsync(5_000 + 16_000);

      const reports = stallReports();
      expect(reports).toHaveLength(1);
      expect(reports[0].contexts.pty_host).toMatchObject({ heldStep: null });
      expect(reports[0].contexts.utility_process.stderrTail).toBe(HOST_STDERR);
    });

    it('names the timer overshoot when the clock jumped past the threshold', async () => {
      // A loop held by main itself shows as a timer that fires late. Losing timerLateMs would
      // leave a stall on main's own loop indistinguishable from one on the host's.
      const { child, pingId } = await hostWithPingSent();
      await vi.advanceTimersByTimeAsync(10_999);
      vi.setSystemTime(Date.now() + 700);
      await vi.advanceTimersByTimeAsync(1);
      reply(child, pingId, null);
      await vi.advanceTimersByTimeAsync(0);

      const reports = stallReports();
      expect(reports).toHaveLength(1);
      expect(reports[0].contexts.pty_host).toMatchObject({ timerLateMs: 700 });
    });

    describe('a beat that spans a sleep', () => {
      const SLEPT_MS = 16 * 60 * 60 * 1_000;

      it('reports nothing when the threshold timer fires hours late', async () => {
        // DESKTOP-43 on 0.60.0. The machine slept with a beat in flight. On wake the threshold
        // timer and the ping's timeout were both overdue, and a sleep was reported as every
        // terminal frozen. A beat that never watched the host says nothing about it.
        await hostWithPingSent();
        await vi.advanceTimersByTimeAsync(5_000);
        vi.setSystemTime(Date.now() + SLEPT_MS);
        await vi.advanceTimersByTimeAsync(11_000);

        expect(stallReports()).toHaveLength(0);
      });

      it('still reports a host that stays frozen on the next beat after the wake', async () => {
        // Voiding must not hide a real freeze. The next beat's timer fires on time.
        await hostWithPingSent();
        await vi.advanceTimersByTimeAsync(5_000);
        vi.setSystemTime(Date.now() + SLEPT_MS);
        // The voided ping runs out its budget, the next tick sends a fresh beat, and that beat
        // passes its threshold and its own budget with no answer.
        await vi.advanceTimersByTimeAsync(10_000 + 5_000 + 15_000);

        const reports = stallReports();
        expect(reports).toHaveLength(1);
        expect(reports[0].tags.outcome).toBe('no_answer');
        expect(reports[0].contexts.pty_host).toMatchObject({ neverAnswered: true, timerLateMs: 0 });
      });

      it('reports and warns of nothing when a voided beat\'s ping is answered after the wake, and says it was not measured', async () => {
        // The ping's .then would otherwise report an "answered" stall for a beat that only slept.
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const { child, pingId } = await hostWithPingSent();
        await thresholdTimerFiresLate(SLEPT_MS);
        expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/a heartbeat spanned 57600 s with main not running; not measured/));

        reply(child, pingId, null);
        await vi.advanceTimersByTimeAsync(0);

        expect(stallReports()).toHaveLength(0);
        expect(console.warn).not.toHaveBeenCalledWith(expect.stringMatching(/answered a heartbeat after/));
        expect(console.warn).not.toHaveBeenCalledWith(expect.stringMatching(/has not answered a heartbeat/));
      });

      it('records nothing at quit while a voided beat\'s ping is still pending', async () => {
        // A quit during the wake must not write a stall-at-quit record for a beat that slept.
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-voided-at-quit-'));
        try {
          const stallAtQuitFilePath = path.join(directory, 'pty-host-stall-at-quit.json');
          vi.spyOn(console, 'info').mockImplementation(() => undefined);
          const { transport, child } = await hostWithPingSent(stallAtQuitFilePath);
          await thresholdTimerFiresLate(SLEPT_MS);

          transport.shutdown();
          child.emit('exit', 0);
          await vi.advanceTimersByTimeAsync(0);

          expect(fs.existsSync(stallAtQuitFilePath)).toBe(false);
          expect(stallReports()).toHaveLength(0);
          reportPtyHostStallFromLastRun(stallAtQuitFilePath);
          expect(stallReports()).toHaveLength(0);
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      });

      it('voids a beat whose threshold timer is late by more than 60 s and still reports one late by less', async () => {
        // HEARTBEAT_UNMEASURED_LATE_MS is 4 * the 15 s request timeout = 60 s. timerLateMs is
        // Date.now() - start - 11 s, so a clock jump of J ms during the beat makes it J ms late.
        // Both beats carry a watchdog line, so the 61 s void stands on its own and is not the
        // late-timer rule below (a late beat with no line is voided whatever its lateness).
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const over = await hostWithPingSent();
        await thresholdTimerFiresLate(61_000);
        watchdogWritesDuringStall();
        reply(over.child, over.pingId, null);
        await vi.advanceTimersByTimeAsync(LATE_BEAT_SETTLE_MS);
        expect(stallReports(), '61 s late is voided').toHaveLength(0);
        over.transport.shutdown();

        vi.mocked(reportHandledError).mockClear();
        resetPtyHostReports();
        const under = await hostWithPingSent();
        await thresholdTimerFiresLate(59_000);
        watchdogWritesDuringStall();
        reply(under.child, under.pingId, null);
        await vi.advanceTimersByTimeAsync(LATE_BEAT_SETTLE_MS);

        const reports = stallReports();
        expect(reports, '59 s late is still measured').toHaveLength(1);
        expect(reports[0].tags.outcome).toBe('answered');
        expect(reports[0].contexts.pty_host).toMatchObject({ timerLateMs: 59_000 });
      });
    });

    // DESKTOP-43 on 0.62.0: the threshold timer fired 18.7 s late, under the 60 s void, and the
    // host's watchdog (which prints at 5 s of a held loop) wrote nothing. Main's own loop was held,
    // so its overdue timers ran before the host's answer was read. That beat measured main.
    describe('a beat whose threshold timer fired late on main', () => {
      const DESKTOP_43_LATE_MS = 18_658;

      it('reports nothing when the host wrote no watchdog line during the beat', async () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await hostWithPingSent();
        await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);
        // The ping's own 15 s timeout fires, then the settle passes.
        await vi.advanceTimersByTimeAsync(4_000 + LATE_BEAT_SETTLE_MS);

        expect(stallReports()).toHaveLength(0);
        expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/fired 19 s late with no hold in the host/));
      });

      it('reports a host the watchdog says was held too', async () => {
        await hostWithPingSent();
        await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);
        watchdogWritesDuringStall();
        await vi.advanceTimersByTimeAsync(4_000 + LATE_BEAT_SETTLE_MS);

        const reports = stallReports();
        expect(reports).toHaveLength(1);
        expect(reports[0].tags.outcome).toBe('no_answer');
        expect(reports[0].contexts.pty_host).toMatchObject({ timerLateMs: DESKTOP_43_LATE_MS, heldStep: WATCHDOG_LINE });
      });

      it('reads a watchdog line that arrives after the overdue timers ran', async () => {
        // Main resumes: its overdue threshold timer and the ping's timeout run before libuv reads
        // the host's pending stderr. Deciding at the timeout would miss the line.
        await hostWithPingSent();
        await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(stallReports(), 'the decision waits for the settle').toHaveLength(0);
        watchdogWritesDuringStall();
        await vi.advanceTimersByTimeAsync(LATE_BEAT_SETTLE_MS);

        const reports = stallReports();
        expect(reports).toHaveLength(1);
        expect(reports[0].contexts.pty_host).toMatchObject({ heldStep: WATCHDOG_LINE });
      });

      it('records nothing at quit for a late beat with no watchdog line', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-late-at-quit-'));
        try {
          const stallAtQuitFilePath = path.join(directory, 'pty-host-stall-at-quit.json');
          const { transport, child } = await hostWithPingSent(stallAtQuitFilePath);
          await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);

          transport.shutdown();
          child.emit('exit', 0);
          await vi.advanceTimersByTimeAsync(LATE_BEAT_SETTLE_MS);

          expect(fs.existsSync(stallAtQuitFilePath)).toBe(false);
          expect(stallReports()).toHaveLength(0);
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      });

      /** A host whose tail already holds a watchdog line when the beat is sent. */
      async function hostWithOldWatchdogLine(): Promise<{ child: FakeChild }> {
        const { transport } = makeTransport();
        transport.start();
        const child = latestChild();
        stderrTails[stderrTails.length - 1].text = HOST_STDERR;
        child.emit('message', { type: 'ready' });
        await vi.advanceTimersByTimeAsync(5_000);
        return { child };
      }

      it('parity: the late-timer threshold is the watchdog\'s own hold threshold, which main cannot import', () => {
        expect(HEARTBEAT_LATE_TIMER_MS).toBe(WATCHDOG_CHECK_INTERVAL_MS * WATCHDOG_HELD_CHECKS);
      });

      describe('a host that exited', () => {
        async function lateBeatWithHeldDrain(): Promise<{ dyingTail: FakeStderrTail; finishDrain: () => void }> {
          const { child } = await hostWithPingSent();
          await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);
          let finishDrain = (): void => undefined;
          const dyingTail = stderrTails[stderrTails.length - 1];
          dyingTail.drain = new Promise<void>((resolve) => {
            finishDrain = resolve;
          });
          child.emit('exit', 1);
          await vi.advanceTimersByTimeAsync(0);
          return { dyingTail, finishDrain };
        }

        it('reports nothing, before or after the pipe drains, when the host wrote no watchdog line', async () => {
          const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
          const { finishDrain } = await lateBeatWithHeldDrain();
          await vi.advanceTimersByTimeAsync(LATE_BEAT_SETTLE_MS);
          expect(stallReports(), 'waiting on the drain').toHaveLength(0);

          finishDrain();
          await vi.advanceTimersByTimeAsync(0);

          expect(stallReports()).toHaveLength(0);
          expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/fired 19 s late with no hold in the host/));
        });

        it('waits for the drain, not the settle, and reports once a watchdog line landed during it', async () => {
          const { dyingTail, finishDrain } = await lateBeatWithHeldDrain();
          dyingTail.text = HOST_STDERR;
          await vi.advanceTimersByTimeAsync(LATE_BEAT_SETTLE_MS);
          expect(stallReports(), 'the settle alone does not decide it').toHaveLength(0);

          finishDrain();
          await vi.advanceTimersByTimeAsync(0);

          const reports = stallReports();
          expect(reports).toHaveLength(1);
          expect(reports[0].tags.outcome).toBe('host_exited');
          expect(reports[0].contexts.pty_host).toMatchObject({ heldStep: WATCHDOG_LINE });
        });
      });

      describe('a quit during the settle', () => {
        let directory: string;
        let stallAtQuitFilePath: string;

        beforeEach(() => {
          directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-settle-quit-'));
          stallAtQuitFilePath = path.join(directory, 'pty-host-stall-at-quit.json');
        });

        afterEach(() => {
          fs.rmSync(directory, { recursive: true, force: true });
        });

        it('records the stall with its own outcome for the next launch and sends nothing, when the host held', async () => {
          const { transport } = await hostWithPingSent(stallAtQuitFilePath);
          await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);
          watchdogWritesDuringStall();
          // The ping's own timeout ends the beat, which then waits out its settle.
          await vi.advanceTimersByTimeAsync(4_000);
          expect(stallReports(), 'still settling').toHaveLength(0);

          transport.shutdown();
          await vi.advanceTimersByTimeAsync(LATE_BEAT_SETTLE_MS);

          expect(stallReports()).toHaveLength(0);
          expect(JSON.parse(fs.readFileSync(stallAtQuitFilePath, 'utf8'))).toMatchObject({ outcome: 'no_answer' });
        });

        it('records nothing when the host wrote no watchdog line', async () => {
          vi.spyOn(console, 'info').mockImplementation(() => undefined);
          const { transport } = await hostWithPingSent(stallAtQuitFilePath);
          await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);
          await vi.advanceTimersByTimeAsync(4_000);

          transport.shutdown();
          await vi.advanceTimersByTimeAsync(LATE_BEAT_SETTLE_MS);

          expect(stallReports()).toHaveLength(0);
          expect(fs.existsSync(stallAtQuitFilePath)).toBe(false);
        });
      });

      describe('a watchdog line from before the beat', () => {
        it('does not count as a hold during it', async () => {
          const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
          await hostWithOldWatchdogLine();
          await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);
          await vi.advanceTimersByTimeAsync(4_000 + LATE_BEAT_SETTLE_MS);

          expect(stallReports()).toHaveLength(0);
          expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/no hold in the host/));
        });

        it('still reports when a second line arrives during the beat', async () => {
          await hostWithOldWatchdogLine();
          await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);
          stderrTails[stderrTails.length - 1].text = `${HOST_STDERR}\n${WATCHDOG_LINE}`;
          await vi.advanceTimersByTimeAsync(4_000 + LATE_BEAT_SETTLE_MS);

          expect(stallReports()).toHaveLength(1);
        });

        it('still reports when the new line landed as a trim dropped the old one', async () => {
          // The retained count stays 1, so only the never-decreasing count sees the new line.
          await hostWithOldWatchdogLine();
          await thresholdTimerFiresLate(DESKTOP_43_LATE_MS);
          const tail = stderrTails[stderrTails.length - 1];
          tail.text = WATCHDOG_LINE;
          tail.droppedWatchdogLines = 1;
          await vi.advanceTimersByTimeAsync(4_000 + LATE_BEAT_SETTLE_MS);

          expect(stallReports()).toHaveLength(1);
        });
      });

      describe('the late-timer boundary', () => {
        it('still reports a beat late by exactly HEARTBEAT_LATE_TIMER_MS with no watchdog line', async () => {
          await hostWithPingSent();
          await thresholdTimerFiresLate(HEARTBEAT_LATE_TIMER_MS);
          await vi.advanceTimersByTimeAsync(4_000 + LATE_BEAT_SETTLE_MS);

          expect(stallReports()).toHaveLength(1);
        });

        it('voids a beat late by one ms more with no watchdog line', async () => {
          vi.spyOn(console, 'info').mockImplementation(() => undefined);
          await hostWithPingSent();
          await thresholdTimerFiresLate(HEARTBEAT_LATE_TIMER_MS + 1);
          await vi.advanceTimersByTimeAsync(4_000 + LATE_BEAT_SETTLE_MS);

          expect(stallReports()).toHaveLength(0);
        });
      });

      it('reports nothing for a late beat the host answered with no watchdog line, and says so', async () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const { child, pingId } = await hostWithPingSent();
        await thresholdTimerFiresLate(8_000);
        reply(child, pingId, null);
        await vi.advanceTimersByTimeAsync(LATE_BEAT_SETTLE_MS);

        expect(stallReports()).toHaveLength(0);
        expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/fired 8 s late with no hold in the host/));
      });

      it('still reports an on-time beat the host never answered, with no watchdog line', async () => {
        await hostWithPingSent();
        await vi.advanceTimersByTimeAsync(16_000);

        const reports = stallReports();
        expect(reports).toHaveLength(1);
        expect(reports[0].tags.outcome).toBe('no_answer');
        expect(reports[0].contexts.pty_host).toMatchObject({ timerLateMs: 0, heldStep: null });
      });
    });

    it('lists the requests waiting beside the ping once each, sorted', async () => {
      // A report that repeated or shuffled the methods would group differently run to run.
      const { transport, child, pingId } = await hostWithPingSent();
      for (const method of ['spawn', 'getDiagnostics', 'spawn', 'exec'] as const) {
        void transport.request(method, {} as never).catch(() => undefined);
      }
      await vi.advanceTimersByTimeAsync(11_000);
      reply(child, pingId, null);
      await vi.advanceTimersByTimeAsync(0);

      const reports = stallReports();
      expect(reports).toHaveLength(1);
      expect(reports[0].contexts.pty_host.inFlight).toEqual(['exec', 'getDiagnostics', 'spawn']);
    });

    it('reports no stall when the host answers a stalled ping with an error of its own', async () => {
      // Only a lost host or a spent budget ends a stall; a plain error reply is neither, and a
      // stall report claiming an outcome for it would be invented. The failed ping itself is
      // reported on its own, as `session_manager` / `heartbeat_ping`.
      const { child, pingId } = await hostWithPingSent();
      await vi.advanceTimersByTimeAsync(11_000);
      child.emit('message', { type: 'reply', id: pingId, ok: false, error: { message: 'x', name: 'Error' } });
      await vi.advanceTimersByTimeAsync(0);

      expect(stallReports()).toHaveLength(0);
    });

    describe('at quit', () => {
      let directory: string;
      let stallAtQuitFilePath: string;

      beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-stall-at-quit-'));
        stallAtQuitFilePath = path.join(directory, 'pty-host-stall-at-quit.json');
      });

      afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
      });

      it('records a stall the app quits on for the next launch, sends nothing from the quit, and never reports the quit\'s exit', async () => {
        // Nothing sent from the quit path lands (synchronous-shutdown.md, rule 3), so a quit
        // writes the stall to disk and the next launch reports it.
        const { transport, child } = await hostWithPingSent(stallAtQuitFilePath);
        await vi.advanceTimersByTimeAsync(6_000);
        watchdogWritesDuringStall();
        await vi.advanceTimersByTimeAsync(5_000);

        transport.shutdown();
        child.emit('exit', 0);
        await vi.advanceTimersByTimeAsync(0);
        expect(stallReports(), 'the quit path sends nothing').toHaveLength(0);

        reportPtyHostStallFromLastRun(stallAtQuitFilePath);
        const reports = stallReports();
        expect(reports).toHaveLength(1);
        expect(reports[0].tags.outcome).toBe('shutdown');
        expect(reports[0].contexts.pty_host).toMatchObject({ neverAnswered: true, heldStep: WATCHDOG_LINE });
        expect(reports[0].contexts.utility_process.stderrTail).toBe(HOST_STDERR);
        expect(fs.existsSync(stallAtQuitFilePath), 'read once, then gone').toBe(false);
      });

      it('writes nothing for a quit with no stall', async () => {
        const { transport } = await hostWithPingSent(stallAtQuitFilePath);
        await vi.advanceTimersByTimeAsync(2_000);
        transport.shutdown();
        expect(fs.existsSync(stallAtQuitFilePath)).toBe(false);
      });

      it('still shuts the host down when the stall cannot be written', async () => {
        // A failed disk write must never block the quit: losing the try/catch would throw out of
        // shutdown() and the host would never be told to exit.
        const blocker = path.join(directory, 'not-a-directory');
        fs.writeFileSync(blocker, 'file');
        const { transport, child } = await hostWithPingSent(path.join(blocker, 'pty-host-stall-at-quit.json'));
        await vi.advanceTimersByTimeAsync(11_000);

        expect(() => transport.shutdown()).not.toThrow();
        expect(child.postedTypes()).toContain('shutdown');
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/could not record a heartbeat stall/), expect.anything());
      });

      it('never reports or records a stall that only begins after the quit started', async () => {
        // The quit saw no stall yet, so the host's exit that follows is the quit's. Without the
        // guard in endStall the late stall would report a host_exited the quit caused.
        const { transport, child } = await hostWithPingSent(stallAtQuitFilePath);
        await vi.advanceTimersByTimeAsync(3_000);
        transport.shutdown();
        await vi.advanceTimersByTimeAsync(9_000);
        child.emit('exit', 0);
        await vi.advanceTimersByTimeAsync(0);

        expect(stallReports()).toHaveLength(0);
        expect(fs.existsSync(stallAtQuitFilePath)).toBe(false);
      });
    });

    it('sends nothing for a ping answered inside the threshold, and once per run for repeated stalls', async () => {
      const { child, pingId } = await hostWithPingSent();
      await vi.advanceTimersByTimeAsync(10_000);
      reply(child, pingId, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(stallReports()).toHaveLength(0);

      // Two stalls in a row, each answered late.
      for (let stall = 0; stall < 2; stall++) {
        await vi.advanceTimersByTimeAsync(5_000);
        const nextPing = lastRequestId(child);
        await vi.advanceTimersByTimeAsync(12_000);
        reply(child, nextPing, null);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(stallReports()).toHaveLength(1);
    });
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
