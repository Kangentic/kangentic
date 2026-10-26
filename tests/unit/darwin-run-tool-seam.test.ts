/**
 * The seam that moves the macOS reap's `lsappinfo` start off the pty host's
 * terminal thread (.claude/rules/pty-host-out-of-process.md, "The host's I/O
 * thread starts no process").
 *
 * Three links carry it, and the other suites pin only the ends:
 *   1. `runToolThrough` (host-spawn-service.ts) turns the reader's `runTool`
 *      call into a spawn-service `execFile` request and answers as the
 *      reader's own `runTool` does: stdout on a clean run, null otherwise.
 *   2. `DarwinTaggedProcessReader` calls the injected `runTool` for its window
 *      list instead of starting the tool itself.
 *   3. `createTaggedProcessReader('darwin', { runTool })` hands the option on.
 *      `pty-host-boundary.test.ts` pins that the entry's SOURCE names
 *      `runToolThrough`, and `task-process-readers.test.ts` drives the reader
 *      with `runLsappinfo`, so a broken link 2 or 3 would pass both and put
 *      the process start back on the thread that carries every terminal.
 *
 * Reader construction is not platform-gated, so this runs on every OS. A fake
 * kernel stands in for koffi/libproc.
 *
 * Tier: Unit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DarwinKernel, DarwinReaderOptions } from '../../src/main/pty/process-tag/darwin-reader';
import { DarwinTaggedProcessReader } from '../../src/main/pty/process-tag/darwin-reader';
import { createTaggedProcessReader } from '../../src/main/pty/process-tag/reader-factory';
import { runToolThrough, type HostSpawnService } from '../../src/main/pty/host/host-spawn-service';
import type { HostExecRequest, HostExecResult } from '../../src/main/pty/host/protocol';

const TASK = 'task-seam-1';

/** What the factory-built reader gets, so a scan needs no koffi. Off by default. */
const factoryHarness = vi.hoisted(() => ({
  kernel: null as unknown as DarwinKernel | null,
  constructed: [] as Array<{ runTool: unknown }>,
}));

vi.mock('../../src/main/pty/process-tag/darwin-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/pty/process-tag/darwin-reader')>();
  class RecordingDarwinReader extends actual.DarwinTaggedProcessReader {
    constructor(options: DarwinReaderOptions = {}) {
      factoryHarness.constructed.push({ runTool: options.runTool });
      // Only the kernel and uid are supplied here. `runTool` passes through
      // exactly as the factory handed it over.
      super(factoryHarness.kernel
        ? { ...options, uid: 501, loadKernel: async () => factoryHarness.kernel as DarwinKernel }
        : options);
    }
  }
  return { ...actual, DarwinTaggedProcessReader: RecordingDarwinReader };
});

/** A kernel record: path, argv, then the environment, as `summarizeProcArgs` reads it. */
function taggedProcArgs(): Buffer {
  const argc = Buffer.alloc(4);
  argc.writeInt32LE(2, 0);
  const text = `/usr/local/bin/node\0\0\0\0\0\0node\0server.js\0KANGENTIC_TASK_ID=${TASK}\0HOME=/Users/dev\0${'\0'.repeat(100)}`;
  return Buffer.concat([argc, Buffer.from(text, 'latin1')]);
}

/** One process of the caller's own, tagged, so the scan has to ask for the window list. */
function kernelWithOneTaggedProcess(): DarwinKernel {
  return {
    listPids: () => [501],
    processRow: () => ({ pid: 501, ppid: 1, uid: 501, startKey: '1790000001.000000' }),
    workingDirectory: () => '/Users/dev/project',
    procArgs: () => taggedProcArgs(),
  };
}

const WINDOW_LISTING = '    pid = 501 type="Foreground" flavor=3\n';

describe('DarwinTaggedProcessReader runTool option', () => {
  it('asks the injected runTool for the window list, with lsappinfo, the list verb and a finite timeout', async () => {
    const runTool = vi.fn(async (): Promise<string | null> => WINDOW_LISTING);
    const reader = new DarwinTaggedProcessReader({ uid: 501, loadKernel: async () => kernelWithOneTaggedProcess(), runTool });

    const scan = await reader.scan();

    expect(runTool).toHaveBeenCalledTimes(1);
    const [command, args, timeoutMs] = runTool.mock.calls[0] as unknown as [string, string[], number];
    expect(command).toBe('/usr/bin/lsappinfo');
    expect(args).toEqual(['list']);
    expect(timeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(timeoutMs)).toBe(true);
    // What the injected tool printed is what protected the process.
    expect(scan.processes.find((entry) => entry.pid === 501)?.role).toBe('visible-app');
  });

  it('fails the scan as the window list when the injected runTool answers null', async () => {
    const runTool = vi.fn(async (): Promise<string | null> => null);
    const reader = new DarwinTaggedProcessReader({ uid: 501, loadKernel: async () => kernelWithOneTaggedProcess(), runTool });
    await expect(reader.scan()).rejects.toThrow(/lsappinfo/);
    // It is the injected tool's null that failed the scan, not a start of the real one.
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit runLsappinfo win over runTool', async () => {
    const runTool = vi.fn(async (): Promise<string | null> => WINDOW_LISTING);
    const runLsappinfo = vi.fn(async (): Promise<string | null> => '');
    const reader = new DarwinTaggedProcessReader({ uid: 501, loadKernel: async () => kernelWithOneTaggedProcess(), runTool, runLsappinfo });

    const scan = await reader.scan();

    expect(runLsappinfo).toHaveBeenCalledTimes(1);
    expect(runTool).not.toHaveBeenCalled();
    expect(scan.processes.find((entry) => entry.pid === 501)?.role).toBeUndefined();
  });
});

describe('createTaggedProcessReader forwards runTool to the macOS reader', () => {
  beforeEach(() => {
    factoryHarness.constructed.length = 0;
    factoryHarness.kernel = kernelWithOneTaggedProcess();
  });

  afterEach(() => {
    factoryHarness.kernel = null;
  });

  it('builds the darwin reader with the very function it was given, and a scan runs lsappinfo through it', async () => {
    const runTool = vi.fn(async (): Promise<string | null> => WINDOW_LISTING);

    const reader = createTaggedProcessReader('darwin', { runTool });

    expect(factoryHarness.constructed).toHaveLength(1);
    expect(factoryHarness.constructed[0].runTool).toBe(runTool);
    const scan = await reader!.scan();
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]).toEqual(['/usr/bin/lsappinfo', ['list'], expect.any(Number)]);
    expect(scan.processes.find((entry) => entry.pid === 501)?.role).toBe('visible-app');
  });

  it('passes no runTool when the caller gave none, so the reader keeps its own', () => {
    createTaggedProcessReader('darwin');
    expect(factoryHarness.constructed).toHaveLength(1);
    expect(factoryHarness.constructed[0].runTool).toBeUndefined();
  });
});

describe('runToolThrough', () => {
  let requests: HostExecRequest[];
  let answer: HostExecResult;

  /** Only `exec` is read: the helper must not touch the CLI or process-table halves. */
  function fakeService(): HostSpawnService {
    return {
      exec: async (request: HostExecRequest) => {
        requests.push(request);
        return answer;
      },
    } as unknown as HostSpawnService;
  }

  beforeEach(() => {
    requests = [];
    answer = { ok: true, stdout: 'listing', stderr: '' };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends one execFile request carrying the command, its arguments and the timeout, and answers its stdout', async () => {
    const runTool = runToolThrough(fakeService());

    const output = await runTool('/usr/bin/lsappinfo', ['list'], 1234);

    expect(output).toBe('listing');
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.kind).toBe('execFile');
    if (request.kind !== 'execFile') throw new Error('expected an execFile request');
    expect(request.file).toBe('/usr/bin/lsappinfo');
    expect(request.args).toEqual(['list']);
    expect(request.options.timeout).toBe(1234);
    // A run past its timeout is SIGKILLed, as the reader's own runTool does.
    expect(request.options.killSignal).toBe('SIGKILL');
    expect(request.options.windowsHide).toBe(true);
  });

  it('lifts execFile\'s 1 MiB stdout cap, which would fail a long listing and read as the tool being unavailable', async () => {
    await runToolThrough(fakeService())('/usr/bin/lsappinfo', ['list'], 1000);
    const request = requests[0];
    if (request.kind !== 'execFile') throw new Error('expected an execFile request');
    expect(request.options.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  it('runs the tool in the C locale and without Crashpad\'s pipe name', async () => {
    vi.stubEnv('CHROME_CRASHPAD_PIPE_NAME', '\\\\.\\pipe\\crashpad_seam_test');
    vi.stubEnv('LC_ALL', 'en_US.UTF-8');

    await runToolThrough(fakeService())('/usr/bin/lsappinfo', ['list'], 1000);

    const request = requests[0];
    if (request.kind !== 'execFile') throw new Error('expected an execFile request');
    expect(request.options.env?.LC_ALL).toBe('C');
    expect(Object.keys(request.options.env ?? {}).map((key) => key.toUpperCase())).not.toContain('CHROME_CRASHPAD_PIPE_NAME');
  });

  it('answers an empty stdout as an empty answer, not as a failure', async () => {
    answer = { ok: true, stdout: '', stderr: '' };
    expect(await runToolThrough(fakeService())('/usr/bin/lsappinfo', ['list'], 1000)).toBe('');
  });

  it('answers null when the run failed: a non-zero exit, a timeout kill or a spawn error', async () => {
    answer = {
      ok: false,
      error: { message: 'Command failed', exitCode: 1, killed: false, signal: null, stdout: 'partial', stderr: '' },
    };
    expect(await runToolThrough(fakeService())('/usr/bin/lsappinfo', ['list'], 1000)).toBeNull();

    answer = {
      ok: false,
      error: { message: 'timed out', exitCode: null, killed: true, signal: 'SIGKILL', stdout: '', stderr: '' },
    };
    expect(await runToolThrough(fakeService())('/usr/bin/lsappinfo', ['list'], 1000)).toBeNull();
  });
});
