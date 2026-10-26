import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess, exec, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as esbuild from 'esbuild';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/activity-engine/background-shell/process-tree';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import type { HostSpawnService, ProcessTableProbe, SpawnServiceHooks } from '../../src/main/pty/host/host-spawn-service';
import type { HostExecResult, PtyHostCliSpawnParams, PtyHostEvent } from '../../src/main/pty/host/protocol';
import type { FromSpawnWorkerMessage, SpawnWorkerData, ToSpawnWorkerMessage } from '../../src/main/pty/host/spawn-worker/protocol';
import { SpawnWorkerHandler, type SpawnWorkerHandlerOptions } from '../../src/main/pty/host/spawn-worker/spawn-worker-handler';
import {
  MAX_WORKER_CRASHES,
  WorkerSpawnService,
  type SpawnWorkerHandle,
} from '../../src/main/pty/host/worker-spawn-service';

// The service stops a dead worker's runs by pid with killChildTreeByPid, which
// would signal a real process group (POSIX) or start taskkill (Windows). Only
// that one export is replaced: HostCliProcesses, which the handler tests run for
// real, imports stopChildTree and childHasExited from the same module. The real
// worker below is bundled by esbuild from disk, so the mock never reaches it.
const { killChildTreeByPidMock } = vi.hoisted(() => ({ killChildTreeByPidMock: vi.fn() }));
vi.mock('../../src/main/shared/child-tree-stop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/shared/child-tree-stop')>()),
  killChildTreeByPid: killChildTreeByPidMock,
}));

/**
 * The pty host starts every child process on its spawn worker's thread, never
 * on the thread that carries terminal input and output (`worker-spawn-service.ts`,
 * `.claude/rules/pty-host-out-of-process.md`). On Windows CreateProcess holds
 * the thread that calls it: 190 to 454 ms a git start under heavy disk IO,
 * which froze every terminal's echo for as long.
 *
 * The first block drives the service against a fake worker. The second drives
 * the worker's message handler on this thread with fake children and probes.
 * The third builds the real worker from its entry, as scripts/build.js does,
 * runs real children through the host core, and counts every process start on
 * this thread: there must be none.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');

/** A worker that records what it is sent and answers when told to. */
class FakeWorker extends EventEmitter implements SpawnWorkerHandle {
  readonly sent: ToSpawnWorkerMessage[] = [];
  terminated = false;
  postMessage(message: ToSpawnWorkerMessage): void {
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  unref(): void {}
  reply(message: FromSpawnWorkerMessage): void {
    this.emit('message', message);
  }
}

function fakeService(overrides: Partial<{ pinRun: SpawnServiceHooks['pinRun']; createFallback: (hooks: SpawnServiceHooks) => HostSpawnService }> = {}) {
  const workers: FakeWorker[] = [];
  const events: PtyHostEvent[] = [];
  const service = new WorkerSpawnService({
    emit: (event) => events.push(event),
    pinRun: overrides.pinRun ?? (() => null),
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    createFallback: overrides.createFallback,
  });
  return { service, workers, events, latest: () => workers[workers.length - 1] };
}

/** What the fallback service was asked, in the order it was asked. */
interface FallbackCalls {
  execCalls: number;
  startedRuns: PtyHostCliSpawnParams[];
  writes: Array<[processId: number, data: string]>;
  endInputs: Array<[processId: number, data: string | undefined]>;
  stops: number[];
  stopAllCalls: number;
  tableReads: number;
  tableDisposes: number;
  disposeCalls: number;
  /** What its process table answers. */
  tableRows: ProcessInfo[];
  /** What it reports as live. */
  liveCliCount: number;
}

function fakeFallback(): HostSpawnService & FallbackCalls {
  const fallback: HostSpawnService & FallbackCalls = {
    execCalls: 0,
    startedRuns: [],
    writes: [],
    endInputs: [],
    stops: [],
    stopAllCalls: 0,
    tableReads: 0,
    tableDisposes: 0,
    disposeCalls: 0,
    tableRows: [],
    liveCliCount: 0,
    exec(): Promise<HostExecResult> {
      fallback.execCalls += 1;
      return Promise.resolve({ ok: true, stdout: 'from fallback', stderr: '' });
    },
    processTableProbe: (): ProcessTableProbe => ({
      listAllProcesses: () => {
        fallback.tableReads += 1;
        return Promise.resolve(fallback.tableRows);
      },
      dispose: () => {
        fallback.tableDisposes += 1;
      },
    }),
    startCli: (params) => {
      fallback.startedRuns.push(params);
    },
    writeCli: (processId, data) => {
      fallback.writes.push([processId, data]);
    },
    endCliInput: (processId, data) => {
      fallback.endInputs.push([processId, data]);
    },
    stopCli: (processId) => {
      fallback.stops.push(processId);
    },
    stopAllCli: () => {
      fallback.stopAllCalls += 1;
    },
    dispose: () => {
      fallback.disposeCalls += 1;
    },
  };
  return fallback;
}

function cliParams(processId: number, overrides: Partial<PtyHostCliSpawnParams> = {}): PtyHostCliSpawnParams {
  return { processId, command: 'claude', args: [], cwd: '/mock', shell: false, env: {}, detached: false, ...overrides };
}

/** The messages of one type the service sent to the worker, narrowed to that type. */
function sentOfType<Type extends ToSpawnWorkerMessage['type']>(worker: FakeWorker, type: Type): Array<Extract<ToSpawnWorkerMessage, { type: Type }>> {
  return worker.sent.filter((message): message is Extract<ToSpawnWorkerMessage, { type: Type }> => message.type === type);
}

describe('WorkerSpawnService against a fake worker', () => {
  beforeEach(() => {
    killChildTreeByPidMock.mockClear();
  });

  afterEach(() => {
    // A test that fails with fake timers on must not leave them for the next.
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts the worker at once and matches each answer to its request', async () => {
    const { service, latest } = fakeService();
    const worker = latest();
    const first = service.exec({ kind: 'execFile', file: 'git', args: ['status'], options: {} });
    const second = service.exec({ kind: 'exec', command: 'gh --version', options: {} });
    const [firstSent, secondSent] = worker.sent.filter((message) => message.type === 'exec');
    expect(firstSent).toMatchObject({ type: 'exec', request: { kind: 'execFile', file: 'git' } });
    if (firstSent.type !== 'exec' || secondSent.type !== 'exec') throw new Error('not exec');
    worker.reply({ type: 'execResult', id: secondSent.id, result: { ok: true, stdout: 'gh 2', stderr: '' } });
    worker.reply({ type: 'execResult', id: firstSent.id, result: { ok: true, stdout: 'clean', stderr: '' } });
    await expect(first).resolves.toEqual({ ok: true, stdout: 'clean', stderr: '' });
    await expect(second).resolves.toEqual({ ok: true, stdout: 'gh 2', stderr: '' });
  });

  it('hands a run\'s events to main as they came and counts it live until it exits', () => {
    const { service, latest, events } = fakeService();
    service.startCli({ processId: 7, command: 'claude', args: [], cwd: '/mock', shell: false, env: {}, detached: false });
    // Live from the post: the worker may have started it already, and a
    // shutdown must wait for it.
    expect(service.liveCliCount).toBe(1);
    latest().reply({ type: 'cliEvent', event: { type: 'cliSpawned', processId: 7, pid: 4242 } });
    expect(service.liveCliCount).toBe(1);
    latest().reply({ type: 'cliEvent', event: { type: 'cliData', processId: 7, stream: 'stdout', data: new Uint8Array([104, 105]) } });
    latest().reply({ type: 'cliEvent', event: { type: 'cliExit', processId: 7, code: 0, signal: null } });
    expect(service.liveCliCount).toBe(0);
    latest().reply({ type: 'cliEvent', event: { type: 'cliClose', processId: 7, code: 0, signal: null } });
    expect(events.map((event) => event.type)).toEqual(['cliSpawned', 'cliData', 'cliExit', 'cliClose']);
  });

  it('pins a run\'s pid before the stop leaves and holds it until the taskkill exits', () => {
    const releases: number[] = [];
    const pinRun = vi.fn((pid: number) => () => releases.push(pid));
    const { service, latest } = fakeService({ pinRun });
    service.startCli({ processId: 1, command: 'claude', args: [], cwd: '/mock', shell: false, env: {}, detached: false });
    latest().reply({ type: 'cliEvent', event: { type: 'cliSpawned', processId: 1, pid: 4242 } });
    service.stopCli(1);
    // Pinned before the stop was posted.
    expect(pinRun).toHaveBeenCalledWith(4242);
    expect(latest().sent.at(-1)).toEqual({ type: 'cliStop', processId: 1 });
    latest().reply({ type: 'treeKillStarted', pid: 4242 });
    // The run closing while taskkill still runs does not release the pin.
    latest().reply({ type: 'cliEvent', event: { type: 'cliClose', processId: 1, code: 1, signal: null } });
    expect(releases).toEqual([]);
    latest().reply({ type: 'treeKillEnded', pid: 4242 });
    expect(releases).toEqual([4242]);
  });

  it('releases the pin when the run closes with no tree kill (POSIX, or a run that had exited)', () => {
    const releases: number[] = [];
    const { service, latest } = fakeService({ pinRun: (pid) => () => releases.push(pid) });
    service.startCli({ processId: 2, command: 'claude', args: [], cwd: '/mock', shell: false, env: {}, detached: true });
    latest().reply({ type: 'cliEvent', event: { type: 'cliSpawned', processId: 2, pid: 5151 } });
    service.stopCli(2);
    latest().reply({ type: 'cliEvent', event: { type: 'cliClose', processId: 2, code: null, signal: 'SIGTERM' } });
    expect(releases).toEqual([5151]);
  });

  it('fails what a dead worker held, ends its runs, and starts a new worker on the next use', async () => {
    const { service, workers, latest, events } = fakeService();
    const pending = service.exec({ kind: 'execFile', file: 'git', args: ['fetch'], options: {} });
    const table = service.processTableProbe().listAllProcesses();
    service.startCli({ processId: 3, command: 'claude', args: [], cwd: '/mock', shell: false, env: {}, detached: false });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    latest().emit('exit', 1);
    // A run the worker had may have run: it answers as failed and never runs again.
    await expect(pending).resolves.toMatchObject({ ok: false, error: { message: 'The pty host spawn worker exited' } });
    await expect(table).resolves.toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['cliError', 'cliClose']);
    void service.exec({ kind: 'execFile', file: 'git', args: ['status'], options: {} });
    expect(workers).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('starts children on its own thread once the worker has died too often', async () => {
    const fallback = fakeFallback();
    const { service, workers, latest } = fakeService({ createFallback: () => fallback });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let crash = 0; crash < MAX_WORKER_CRASHES; crash++) {
      // Each use starts the next worker after the last one died.
      if (crash > 0) void service.exec({ kind: 'execFile', file: 'git', args: [], options: {} });
      latest().emit('exit', 1);
    }
    await expect(service.exec({ kind: 'execFile', file: 'git', args: [], options: {} })).resolves.toMatchObject({ stdout: 'from fallback' });
    expect(fallback.execCalls).toBe(1);
    expect(workers).toHaveLength(MAX_WORKER_CRASHES);
    vi.restoreAllMocks();
  });

  it('falls back at once when the worker cannot start at all', async () => {
    const fallback = fakeFallback();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new WorkerSpawnService({
      emit: () => undefined,
      pinRun: () => null,
      createWorker: () => {
        throw new Error('Cannot find module pty-host-spawn-worker.js');
      },
      createFallback: () => fallback,
    });
    await expect(service.exec({ kind: 'execFile', file: 'git', args: [], options: {} })).resolves.toMatchObject({ stdout: 'from fallback' });
    vi.restoreAllMocks();
  });

  it('learns a run\'s pid from cliStarted alone, keeps it from main, and stops that tree when the worker dies', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, latest, events } = fakeService();
    service.startCli(cliParams(5));
    // No cliSpawned is sent: the pid can only have come from cliStarted.
    latest().reply({ type: 'cliStarted', processId: 5, pid: 6161 });
    // The terminal thread's own message: main never hears it.
    expect(events).toEqual([]);
    expect(killChildTreeByPidMock).not.toHaveBeenCalled();
    latest().emit('exit', 1);
    expect(killChildTreeByPidMock).toHaveBeenCalledTimes(1);
    expect(killChildTreeByPidMock).toHaveBeenCalledWith(6161);
    expect(events).toEqual([
      { type: 'cliError', processId: 5, error: { message: 'The pty host spawn worker exited' } },
      { type: 'cliClose', processId: 5, code: null, signal: null },
    ]);
  });

  it('stops no tree for a dead worker\'s run that has no pid yet or has exited already', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, latest, events } = fakeService();
    // Run 1: the worker died in the turn it spawned the child, before cliStarted left.
    service.startCli(cliParams(1));
    // Run 2: its process exited; only its close is still to come.
    service.startCli(cliParams(2));
    latest().reply({ type: 'cliStarted', processId: 2, pid: 6262 });
    latest().reply({ type: 'cliEvent', event: { type: 'cliExit', processId: 2, code: 0, signal: null } });
    latest().emit('exit', 1);
    expect(killChildTreeByPidMock).not.toHaveBeenCalled();
    // Both still end for main: they never reached a cliClose.
    expect(events.filter((event) => event.type === 'cliClose').map((event) => event.processId)).toEqual([1, 2]);
  });

  it.each<[string, (processId: number, pid: number) => FromSpawnWorkerMessage]>([
    ['cliStarted', (processId, pid) => ({ type: 'cliStarted', processId, pid })],
    ['cliSpawned', (processId, pid) => ({ type: 'cliEvent', event: { type: 'cliSpawned', processId, pid } })],
  ])('holds a stop asked for before the pid is known, then pins the pid and sends it once %s arrives', (_name, pidMessage) => {
    const holder: { worker?: FakeWorker } = {};
    const stopsSentWhenPinned: number[] = [];
    const pinRun = vi.fn((_pid: number) => {
      stopsSentWhenPinned.push(sentOfType(holder.worker as FakeWorker, 'cliStop').length);
      return () => undefined;
    });
    const { service, latest } = fakeService({ pinRun });
    holder.worker = latest();
    service.startCli(cliParams(1));
    service.stopCli(1);
    // A second ask while the first waits changes nothing.
    service.stopCli(1);
    expect(latest().sent.map((message) => message.type)).toEqual(['cliSpawn']);
    expect(pinRun).not.toHaveBeenCalled();
    latest().reply(pidMessage(1, 7001));
    expect(pinRun).toHaveBeenCalledTimes(1);
    expect(pinRun).toHaveBeenCalledWith(7001);
    // The pin was taken before the stop left, so a Windows tree kill never runs on an unpinned pid.
    expect(stopsSentWhenPinned).toEqual([0]);
    expect(latest().sent.map((message) => message.type)).toEqual(['cliSpawn', 'cliStop']);
    expect(latest().sent.at(-1)).toEqual({ type: 'cliStop', processId: 1 });
    service.dispose();
  });

  it('keeps a pending stop waiting through a cliSpawned that carries no pid', () => {
    const pinRun = vi.fn((_pid: number) => () => undefined);
    const { service, latest } = fakeService({ pinRun });
    service.startCli(cliParams(1));
    service.stopCli(1);
    latest().reply({ type: 'cliEvent', event: { type: 'cliSpawned', processId: 1, pid: null } });
    expect(sentOfType(latest(), 'cliStop')).toEqual([]);
    expect(pinRun).not.toHaveBeenCalled();
    latest().reply({ type: 'cliStarted', processId: 1, pid: 7002 });
    expect(pinRun).toHaveBeenCalledWith(7002);
    expect(sentOfType(latest(), 'cliStop')).toEqual([{ type: 'cliStop', processId: 1 }]);
    service.dispose();
  });

  it('counts a run from its start until its cliExit, or its cliClose when the start failed', () => {
    const { service, latest } = fakeService();
    for (const processId of [1, 2, 3]) service.startCli(cliParams(processId));
    // Posted and live, whether or not the worker has said anything about them.
    expect(service.liveCliCount).toBe(3);
    // Its pid known (cliStarted) but no cliSpawned yet: still live.
    latest().reply({ type: 'cliStarted', processId: 1, pid: 8001 });
    expect(service.liveCliCount).toBe(3);
    latest().reply({ type: 'cliEvent', event: { type: 'cliExit', processId: 2, code: 0, signal: null } });
    expect(service.liveCliCount).toBe(2);
    // A start that failed reports cliError then cliClose and never a cliExit: the host's shutdown must not wait on it.
    latest().reply({ type: 'cliEvent', event: { type: 'cliError', processId: 3, error: { message: 'spawn ENOENT' } } });
    latest().reply({ type: 'cliEvent', event: { type: 'cliClose', processId: 3, code: null, signal: null } });
    expect(service.liveCliCount).toBe(1);
    latest().reply({ type: 'cliEvent', event: { type: 'cliExit', processId: 1, code: 0, signal: null } });
    expect(service.liveCliCount).toBe(0);
  });

  it('pins every run with a known pid before it sends cliStopAll, and no run without one or past its exit', () => {
    const holder: { worker?: FakeWorker } = {};
    const pinned: number[] = [];
    const stopAllSentWhenPinned: number[] = [];
    const { service, latest } = fakeService({
      pinRun: (pid) => {
        pinned.push(pid);
        stopAllSentWhenPinned.push(sentOfType(holder.worker as FakeWorker, 'cliStopAll').length);
        return () => undefined;
      },
    });
    holder.worker = latest();
    for (const processId of [1, 2, 3, 4]) service.startCli(cliParams(processId));
    // Run 1's pid arrives as cliStarted, run 2's in its cliSpawned, run 3 has none, run 4 has exited.
    latest().reply({ type: 'cliStarted', processId: 1, pid: 8101 });
    latest().reply({ type: 'cliEvent', event: { type: 'cliSpawned', processId: 2, pid: 8102 } });
    latest().reply({ type: 'cliStarted', processId: 4, pid: 8104 });
    latest().reply({ type: 'cliEvent', event: { type: 'cliExit', processId: 4, code: 0, signal: null } });
    service.stopAllCli();
    expect(pinned).toEqual([8101, 8102]);
    expect(stopAllSentWhenPinned).toEqual([0, 0]);
    expect(latest().sent.at(-1)).toEqual({ type: 'cliStopAll' });
    // One message stops them all: no per-run cliStop follows.
    expect(sentOfType(latest(), 'cliStop')).toEqual([]);
    service.dispose();
  });

  it('releases a pin whose taskkill never reports its end after 30 s, and only then', () => {
    vi.useFakeTimers();
    const releases: number[] = [];
    const { service, latest } = fakeService({ pinRun: (pid) => () => releases.push(pid) });
    service.startCli(cliParams(1));
    latest().reply({ type: 'cliStarted', processId: 1, pid: 9001 });
    service.stopCli(1);
    // The tree kill started, so only treeKillEnded or the backstop can release the pin.
    latest().reply({ type: 'treeKillStarted', pid: 9001 });
    vi.advanceTimersByTime(29_999);
    expect(releases).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(releases).toEqual([9001]);
    // A taskkill that reports late releases nothing a second time.
    latest().reply({ type: 'treeKillEnded', pid: 9001 });
    expect(releases).toEqual([9001]);
  });

  it('on dispose answers what is pending, releases held pins and ends the worker', async () => {
    const releases: number[] = [];
    const { service, latest, events } = fakeService({ pinRun: (pid) => () => releases.push(pid) });
    const worker = latest();
    const pendingExec = service.exec({ kind: 'execFile', file: 'git', args: ['fetch'], options: {} });
    const pendingTable = service.processTableProbe().listAllProcesses();
    service.startCli(cliParams(1));
    worker.reply({ type: 'cliStarted', processId: 1, pid: 9101 });
    service.stopCli(1);
    worker.reply({ type: 'treeKillStarted', pid: 9101 });
    expect(releases).toEqual([]);
    expect(worker.terminated).toBe(false);
    service.dispose();
    await expect(pendingExec).resolves.toMatchObject({ ok: false, error: { message: 'The pty host spawn service was disposed' } });
    await expect(pendingTable).resolves.toEqual([]);
    expect(releases).toEqual([9101]);
    expect(worker.terminated).toBe(true);
    expect(service.liveCliCount).toBe(0);
    // The terminated worker's exit is nobody's news: no run is failed, no tree stopped.
    worker.emit('exit', 1);
    expect(events).toEqual([]);
    expect(killChildTreeByPidMock).not.toHaveBeenCalled();
  });

  it('hands the runs it did not start on the worker, and the process table, to the fallback once the worker has died too often', async () => {
    const fallback = fakeFallback();
    fallback.tableRows = [{ pid: 31, ppid: 1, comm: 'node' }];
    fallback.liveCliCount = 2;
    const { service, workers, latest } = fakeService({ createFallback: () => fallback });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let crash = 0; crash < MAX_WORKER_CRASHES; crash++) {
      if (crash > 0) void service.exec({ kind: 'execFile', file: 'git', args: [], options: {} });
      latest().emit('exit', 1);
    }
    const sentBefore = workers.map((worker) => worker.sent.length);

    service.startCli(cliParams(20));
    service.writeCli(20, 'hello');
    service.endCliInput(20, 'tail');
    service.endCliInput(20, undefined);
    service.stopCli(20);
    service.stopAllCli();
    expect(fallback.startedRuns).toEqual([cliParams(20)]);
    expect(fallback.writes).toEqual([[20, 'hello']]);
    expect(fallback.endInputs).toEqual([[20, 'tail'], [20, undefined]]);
    expect(fallback.stops).toEqual([20]);
    expect(fallback.stopAllCalls).toBe(1);
    // No run of the fallback's reaches a worker, dead or new.
    expect(workers).toHaveLength(MAX_WORKER_CRASHES);
    expect(workers.map((worker) => worker.sent.length)).toEqual(sentBefore);
    expect(service.liveCliCount).toBe(2);

    const probe = service.processTableProbe();
    await expect(probe.listAllProcesses()).resolves.toEqual([{ pid: 31, ppid: 1, comm: 'node' }]);
    expect(fallback.tableReads).toBe(1);
    probe.dispose();
    expect(fallback.tableDisposes).toBe(1);

    service.dispose();
    expect(fallback.disposeCalls).toBe(1);
  });

  it('never gives the fallback a run the worker started, even when the fallback exists while the worker\'s exit is still failing that run', () => {
    // The only way both hold at once: the emit of the last allowed crash's
    // exit runs while the runs it is failing are still in the service's map.
    // The run is the worker's to fail, so no input or stop for it may reach a
    // service that never started it.
    const fallback = fakeFallback();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const workers: FakeWorker[] = [];
    let probed = false;
    const service: WorkerSpawnService = new WorkerSpawnService({
      emit: (event) => {
        if (probed || event.type !== 'cliError') return;
        probed = true;
        // Creates the fallback: the worker is gone for good.
        void service.exec({ kind: 'execFile', file: 'git', args: [], options: {} });
        // Run 2 is still the worker's, run 99 never was.
        service.writeCli(2, 'late');
        service.endCliInput(2, 'late');
        service.stopCli(2);
        service.writeCli(99, 'fallback input');
      },
      pinRun: () => null,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      createFallback: () => fallback,
    });
    for (let crash = 0; crash < MAX_WORKER_CRASHES - 1; crash++) {
      workers[workers.length - 1].emit('exit', 1);
      void service.exec({ kind: 'execFile', file: 'git', args: [], options: {} });
    }
    expect(workers).toHaveLength(MAX_WORKER_CRASHES);
    service.startCli(cliParams(1));
    service.startCli(cliParams(2));
    workers[workers.length - 1].emit('exit', 1);
    expect(probed).toBe(true);
    expect(fallback.execCalls).toBe(1);
    expect(fallback.writes).toEqual([[99, 'fallback input']]);
    expect(fallback.endInputs).toEqual([]);
    expect(fallback.stops).toEqual([]);
  });

  it('answers each process table request with the rows of its own listProcessesResult, in any order', async () => {
    const { service, latest } = fakeService();
    const probe = service.processTableProbe();
    const first = probe.listAllProcesses();
    const second = probe.listAllProcesses();
    const [firstRequest, secondRequest] = sentOfType(latest(), 'listProcesses');
    expect(firstRequest.id).not.toBe(secondRequest.id);
    const firstRows: ProcessInfo[] = [{ pid: 10, ppid: 1, comm: 'node' }];
    const secondRows: ProcessInfo[] = [{ pid: 20, ppid: 10, comm: 'git' }, { pid: 21, ppid: 10, comm: 'sh' }];
    latest().reply({ type: 'listProcessesResult', id: secondRequest.id, rows: secondRows });
    latest().reply({ type: 'listProcessesResult', id: firstRequest.id, rows: firstRows });
    await expect(first).resolves.toEqual(firstRows);
    await expect(second).resolves.toEqual(secondRows);
  });

  it('tells the worker to end its process table probe when the probe is disposed', () => {
    const { service, latest } = fakeService();
    service.processTableProbe().dispose();
    expect(latest().sent).toEqual([{ type: 'disposeProcessTable' }]);
  });
});

/**
 * What the worker does with each message, driven on this thread: a fake child
 * stands in for the process (so nothing starts) and a fake probe for the
 * process table. The entry only wires the handler to the worker's port.
 */
describe('SpawnWorkerHandler on the test thread', () => {
  // Matches nothing a test starts, so the own-executable refusal stays out of the way.
  const NOT_THIS_PROCESS = '/nonexistent/kangentic-host-binary';

  /** Lets a promise's continuation (the handler's `.then`) run. */
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  function handlerWith(options: SpawnWorkerHandlerOptions = {}) {
    const posted: FromSpawnWorkerMessage[] = [];
    const handler = new SpawnWorkerHandler((message) => posted.push(message), { ownExecutable: NOT_THIS_PROCESS, ...options });
    return { handler, posted };
  }

  function fakeChild(pid: number | undefined) {
    return Object.assign(new EventEmitter(), {
      pid,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() }),
      kill: vi.fn(),
    });
  }

  /** The `taskkill` process a Windows tree kill starts: records the listeners `spawnTreeKill` attaches. */
  interface FakeTaskkill {
    listeners: Map<string, () => void>;
    on(event: string, listener: () => void): FakeTaskkill;
    unref(): FakeTaskkill;
  }

  function fakeTaskkill(): FakeTaskkill {
    const listeners = new Map<string, () => void>();
    const taskkill: FakeTaskkill = {
      listeners,
      on: (event, listener) => {
        listeners.set(event, listener);
        return taskkill;
      },
      unref: () => taskkill,
    };
    return taskkill;
  }

  function spawnReturning(...children: Array<ReturnType<typeof fakeChild>>): typeof spawn {
    const queue = [...children];
    return (() => queue.shift()) as unknown as typeof spawn;
  }

  function fakeProbe(listAllProcesses: () => Promise<ProcessInfo[]>) {
    return {
      isAlive: () => true,
      listAllProcesses: vi.fn(listAllProcesses),
      listDescendants: () => Promise.resolve([]),
      dispose: vi.fn(),
    } satisfies ProcessTreeProbe;
  }

  /** Runs `body` with `process.platform` reporting `platform`, then restores it. */
  function withPlatform(platform: NodeJS.Platform, body: () => void): void {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      body();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  }

  /** The kinds of what was posted, a `cliEvent` by the kind of its event. */
  function kindsOf(posted: FromSpawnWorkerMessage[]): string[] {
    return posted.map((message) => (message.type === 'cliEvent' ? message.event.type : message.type));
  }

  describe('the process table', () => {
    it('posts listProcessesResult with the probe\'s rows for each request, building the probe once', async () => {
      const rows: ProcessInfo[] = [{ pid: 10, ppid: 1, comm: 'node' }, { pid: 11, ppid: 10, comm: 'git' }];
      const probe = fakeProbe(() => Promise.resolve(rows));
      const createProbe = vi.fn(() => probe);
      const { handler, posted } = handlerWith({ createProbe });
      handler.handle({ type: 'listProcesses', id: 4 });
      handler.handle({ type: 'listProcesses', id: 5 });
      await settle();
      expect(posted).toEqual([
        { type: 'listProcessesResult', id: 4, rows },
        { type: 'listProcessesResult', id: 5, rows },
      ]);
      expect(createProbe).toHaveBeenCalledTimes(1);
    });

    it('posts an empty table when the probe rejects, as the probe itself answers a failure', async () => {
      const probe = fakeProbe(() => Promise.reject(new Error('powershell timed out')));
      const { handler, posted } = handlerWith({ createProbe: () => probe });
      handler.handle({ type: 'listProcesses', id: 6 });
      await settle();
      expect(posted).toEqual([{ type: 'listProcessesResult', id: 6, rows: [] }]);
    });

    it('disposes the probe on disposeProcessTable and builds a new one for the next table', async () => {
      const probe = fakeProbe(() => Promise.resolve([]));
      const createProbe = vi.fn(() => probe);
      const { handler } = handlerWith({ createProbe });
      handler.handle({ type: 'listProcesses', id: 1 });
      await settle();
      expect(probe.dispose).not.toHaveBeenCalled();
      handler.handle({ type: 'disposeProcessTable' });
      expect(probe.dispose).toHaveBeenCalledTimes(1);
      handler.handle({ type: 'listProcesses', id: 2 });
      await settle();
      expect(createProbe).toHaveBeenCalledTimes(2);
    });

    it('treats disposeProcessTable before any table as nothing to do', () => {
      const createProbe = vi.fn(() => fakeProbe(() => Promise.resolve([])));
      const { handler, posted } = handlerWith({ createProbe });
      expect(() => handler.handle({ type: 'disposeProcessTable' })).not.toThrow();
      expect(createProbe).not.toHaveBeenCalled();
      expect(posted).toEqual([]);
    });
  });

  describe('a CLI run', () => {
    it('posts cliStarted with the child\'s pid in the call that spawned it, before the child\'s spawn event', () => {
      const child = fakeChild(4321);
      const { handler, posted } = handlerWith({ spawnChild: spawnReturning(child) });
      handler.handle({ type: 'cliSpawn', params: cliParams(3) });
      // Nothing has awaited and the child's spawn event has not fired: this
      // is what the terminal thread has if the worker dies right here.
      expect(posted).toEqual([{ type: 'cliStarted', processId: 3, pid: 4321 }]);
      child.emit('spawn');
      expect(posted).toEqual([
        { type: 'cliStarted', processId: 3, pid: 4321 },
        { type: 'cliEvent', event: { type: 'cliSpawned', processId: 3, pid: 4321 } },
      ]);
    });

    it('posts no cliStarted for a child that has no pid, whose failure then arrives as an event', () => {
      const child = fakeChild(undefined);
      const { handler, posted } = handlerWith({ spawnChild: spawnReturning(child) });
      handler.handle({ type: 'cliSpawn', params: cliParams(3) });
      expect(posted).toEqual([]);
      child.emit('error', new Error('spawn agent-cli ENOENT'));
      expect(kindsOf(posted)).toEqual(['cliError']);
    });

    it('posts cliError then cliClose, and no cliStarted, for a spawn that throws', () => {
      const spawnChild = (() => {
        throw new Error('spawn EACCES');
      }) as unknown as typeof spawn;
      const { handler, posted } = handlerWith({ spawnChild });
      handler.handle({ type: 'cliSpawn', params: cliParams(9) });
      expect(kindsOf(posted)).toEqual(['cliError', 'cliClose']);
      expect(posted[0]).toMatchObject({ type: 'cliEvent', event: { type: 'cliError', processId: 9, error: { message: 'spawn EACCES' } } });
      expect(posted[1]).toEqual({ type: 'cliEvent', event: { type: 'cliClose', processId: 9, code: null, signal: null } });
    });

    it('posts each of a run\'s events as a cliEvent, and posts no host event that is not a cli one', () => {
      const child = fakeChild(77);
      const { handler, posted } = handlerWith({ spawnChild: spawnReturning(child) });
      handler.handle({ type: 'cliSpawn', params: cliParams(8) });
      posted.length = 0;
      child.emit('spawn');
      child.stdout.emit('data', Buffer.from('out'));
      child.stderr.emit('data', Buffer.from('err'));
      child.emit('error', new Error('boom'));
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      expect(posted.every((message) => message.type === 'cliEvent')).toBe(true);
      expect(kindsOf(posted)).toEqual(['cliSpawned', 'cliData', 'cliData', 'cliError', 'cliExit', 'cliClose']);
      const streams = posted.flatMap((message) => (message.type === 'cliEvent' && message.event.type === 'cliData' ? [message.event.stream] : []));
      expect(streams).toEqual(['stdout', 'stderr']);

      // HostCliProcesses emits only cli events, so a stray one can only be
      // injected at the callback the handler gave it. It must not be relayed
      // as a cliEvent: the message type promises a cli* event.
      const relay = (handler as unknown as { cliProcesses: { emit(event: PtyHostEvent): void } }).cliProcesses;
      const postedBefore = posted.length;
      relay.emit({ type: 'ptyIdle', sessionId: 'session-1' });
      expect(posted).toHaveLength(postedBefore);
    });

    it('routes cliWrite to the run\'s stdin and cliEndInput to ending it, with the data only when given', () => {
      const first = fakeChild(101);
      const second = fakeChild(102);
      const { handler } = handlerWith({ spawnChild: spawnReturning(first, second) });
      handler.handle({ type: 'cliSpawn', params: cliParams(1) });
      handler.handle({ type: 'cliSpawn', params: cliParams(2) });
      handler.handle({ type: 'cliWrite', processId: 1, data: 'prompt' });
      expect(first.stdin.write).toHaveBeenCalledWith('prompt');
      expect(second.stdin.write).not.toHaveBeenCalled();
      handler.handle({ type: 'cliEndInput', processId: 1, data: 'tail' });
      expect(first.stdin.end).toHaveBeenCalledWith('tail');
      handler.handle({ type: 'cliEndInput', processId: 2 });
      expect(second.stdin.end).toHaveBeenCalledTimes(1);
      expect(second.stdin.end).toHaveBeenCalledWith();
    });

    it('tells the terminal thread when a Windows tree kill starts, before taskkill spawns, and when taskkill exits', () => {
      withPlatform('win32', () => {
        const child = fakeChild(4321);
        const taskkill = fakeTaskkill();
        const postedWhenTaskkillSpawned: string[][] = [];
        const posted: FromSpawnWorkerMessage[] = [];
        const spawnChild = ((command: string) => {
          if (command !== 'taskkill') return child;
          postedWhenTaskkillSpawned.push(kindsOf(posted));
          return taskkill;
        }) as unknown as typeof spawn;
        const handler = new SpawnWorkerHandler((message) => posted.push(message), { ownExecutable: NOT_THIS_PROCESS, spawnChild });
        handler.handle({ type: 'cliSpawn', params: cliParams(1) });
        posted.length = 0;
        handler.handle({ type: 'cliStop', processId: 1 });
        expect(posted).toEqual([{ type: 'treeKillStarted', pid: 4321 }]);
        // The pin was announced before taskkill could open the pid.
        expect(postedWhenTaskkillSpawned).toEqual([['treeKillStarted']]);
        taskkill.listeners.get('exit')?.();
        expect(posted).toEqual([{ type: 'treeKillStarted', pid: 4321 }, { type: 'treeKillEnded', pid: 4321 }]);
      });
    });

    it('starts a tree kill of every run on cliStopAll', () => {
      withPlatform('win32', () => {
        const taskkill = fakeTaskkill();
        const queue = [fakeChild(4401), fakeChild(4402)];
        const spawnChild = ((command: string) => (command === 'taskkill' ? taskkill : queue.shift())) as unknown as typeof spawn;
        const posted: FromSpawnWorkerMessage[] = [];
        const handler = new SpawnWorkerHandler((message) => posted.push(message), { ownExecutable: NOT_THIS_PROCESS, spawnChild });
        handler.handle({ type: 'cliSpawn', params: cliParams(1) });
        handler.handle({ type: 'cliSpawn', params: cliParams(2) });
        posted.length = 0;
        handler.handle({ type: 'cliStopAll' });
        expect(posted).toEqual([
          { type: 'treeKillStarted', pid: 4401 },
          { type: 'treeKillStarted', pid: 4402 },
        ]);
      });
    });
  });

  it('throws on a message type it does not know', () => {
    const { handler, posted } = handlerWith();
    expect(() => handler.handle({ type: 'cliBogus' } as unknown as ToSpawnWorkerMessage)).toThrow(/unknown spawn worker message/);
    expect(posted).toEqual([]);
  });
});

describe('the real spawn worker, through the host core', () => {
  let bundleDirectory: string;
  let workerPath: string;

  beforeAll(async () => {
    const buildSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build.js'), 'utf-8');
    const externals = [...(buildSource.match(/external:\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    bundleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-spawn-worker-'));
    workerPath = path.join(bundleDirectory, 'pty-host-spawn-worker.js');
    await esbuild.build({
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      external: externals,
      conditions: ['require'],
      define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: '""', MAIN_WINDOW_VITE_NAME: '"main_window"', __KANGENTIC_DEV__: 'false' },
      entryPoints: [path.join(REPO_ROOT, 'src/main/pty/host/spawn-worker/spawn-worker-entry.ts')],
      outfile: workerPath,
      logLevel: 'silent',
    });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(bundleDirectory, { recursive: true, force: true });
  });

  it('runs one-shot and CLI children on the worker, and starts none on the terminal thread', async () => {
    // Every child_process API ends in ChildProcess.prototype.spawn. The worker
    // has its own copy of the module, so only a start on this thread lands here.
    const prototype = ChildProcess.prototype as ChildProcess & { spawn: (...args: unknown[]) => unknown };
    const originalSpawn = prototype.spawn;
    let startsOnThisThread = 0;
    prototype.spawn = function countedSpawn(this: ChildProcess, ...args: unknown[]) {
      startsOnThisThread += 1;
      return originalSpawn.apply(this, args);
    };
    const events: PtyHostEvent[] = [];
    let service: WorkerSpawnService | null = null;
    const core = new PtyHostCore({
      emit: (event) => events.push(event),
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createSpawnService: (hooks) => {
        service = new WorkerSpawnService({
          ...hooks,
          createWorker: (data: SpawnWorkerData) => new Worker(workerPath, { workerData: data }),
        });
        return service;
      },
    });
    try {
      // A shell builtin, so the command is no one's executable.
      const result = await core.handleRequest('exec', { kind: 'exec', command: 'echo spawn-worker-ok', options: {} });
      expect(result).toMatchObject({ ok: true });
      expect((result as HostExecResult & { ok: true }).stdout).toContain('spawn-worker-ok');

      core.handleCommand({
        type: 'cliSpawn',
        params: { processId: 11, command: 'echo cli-run-ok', args: [], cwd: REPO_ROOT, shell: true, env: { ...process.env } as Record<string, string>, detached: false },
      });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'cliClose' && event.processId === 11)).toBe(true), { timeout: 10_000 });
      const output = events
        .filter((event): event is Extract<PtyHostEvent, { type: 'cliData' }> => event.type === 'cliData')
        .map((event) => Buffer.from(event.data).toString('utf8'))
        .join('');
      expect(output).toContain('cli-run-ok');
      expect(events.filter((event) => event.processId === 11 && event.type.startsWith('cli')).map((event) => event.type)).toEqual(
        expect.arrayContaining(['cliSpawned', 'cliExit', 'cliClose']),
      );
      expect(core.liveChildCount).toBe(0);
      expect(startsOnThisThread).toBe(0);

      // Not vacuous: a start made on this thread is counted.
      await new Promise((resolve) => exec('echo local', resolve));
      expect(startsOnThisThread).toBe(1);
    } finally {
      prototype.spawn = originalSpawn;
      (service as WorkerSpawnService | null)?.dispose();
    }
  }, 30_000);
});
