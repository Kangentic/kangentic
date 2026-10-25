import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChildProcess, exec } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as esbuild from 'esbuild';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import type { HostSpawnService, SpawnServiceHooks } from '../../src/main/pty/host/host-spawn-service';
import type { HostExecResult, PtyHostEvent } from '../../src/main/pty/host/protocol';
import type { FromSpawnWorkerMessage, SpawnWorkerData, ToSpawnWorkerMessage } from '../../src/main/pty/host/spawn-worker/protocol';
import {
  MAX_WORKER_CRASHES,
  WorkerSpawnService,
  type SpawnWorkerHandle,
} from '../../src/main/pty/host/worker-spawn-service';

/**
 * The pty host starts every child process on its spawn worker's thread, never
 * on the thread that carries terminal input and output (`worker-spawn-service.ts`,
 * `.claude/rules/pty-host-out-of-process.md`). On Windows CreateProcess holds
 * the thread that calls it: 190 to 454 ms a git start under heavy disk IO,
 * which froze every terminal's echo for as long.
 *
 * The first block drives the service against a fake worker. The second builds
 * the real worker from its entry, as scripts/build.js does, runs real children
 * through the host core, and counts every process start on this thread: there
 * must be none.
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

function fakeFallback(): HostSpawnService & { execCalls: number } {
  return {
    execCalls: 0,
    exec(): Promise<HostExecResult> {
      this.execCalls += 1;
      return Promise.resolve({ ok: true, stdout: 'from fallback', stderr: '' });
    },
    processTableProbe: () => ({ listAllProcesses: () => Promise.resolve([]), dispose: () => undefined }),
    startCli: () => undefined,
    writeCli: () => undefined,
    endCliInput: () => undefined,
    stopCli: () => undefined,
    stopAllCli: () => undefined,
    liveCliCount: 0,
    dispose: () => undefined,
  };
}

describe('WorkerSpawnService against a fake worker', () => {
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
    expect(service.liveCliCount).toBe(0);
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
