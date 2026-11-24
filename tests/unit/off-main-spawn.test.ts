/**
 * `spawnOffMain` (src/main/utility-process/off-main-spawn.ts): the one way
 * main-process code starts a child with a stream or a stop. With a pty host
 * registered the child starts there, and a start on main's own thread is what
 * held the window for seconds at launch, so the routing is the point. With no
 * host (these tests, startup) it starts here, and a caller must not be able to
 * tell the two apart: the same events, the same streams, the same stop.
 *
 * Real children are this test runner's own Node. Every env is a small
 * synthetic object or the runner's own passed through unread.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setOffMainCliSpawner, type CliChildProcess, type CliStopMode, type OffMainCliOptions } from '../../src/main/utility-process/off-main-cli';
import { spawnOffMain, type OffMainChild } from '../../src/main/utility-process/off-main-spawn';

// Spies that call through, so every test here keeps the real stop behavior and
// one test can read which stop function a mode reached.
const { stopChildTreeSpy, killChildTreeNowSpy } = vi.hoisted(() => ({
  stopChildTreeSpy: vi.fn(),
  killChildTreeNowSpy: vi.fn(),
}));
vi.mock('../../src/main/shared/child-tree-stop', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/shared/child-tree-stop')>();
  stopChildTreeSpy.mockImplementation(original.stopChildTree);
  killChildTreeNowSpy.mockImplementation(original.killChildTreeNow);
  return { ...original, stopChildTree: stopChildTreeSpy, killChildTreeNow: killChildTreeNowSpy };
});

const PIPE_KEY = 'CHROME_CRASHPAD_PIPE_NAME';

afterEach(() => {
  setOffMainCliSpawner(null);
});

function nodeChild(script: string, options: Partial<Parameters<typeof spawnOffMain>[2]> = {}): OffMainChild {
  return spawnOffMain(process.execPath, ['-e', script], { cwd: process.cwd(), ...options });
}

/** What the run did, once it has closed. */
async function finished(run: OffMainChild): Promise<{ stdout: string; stderr: string; events: string[]; code: number | null }> {
  const events: string[] = [];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  run.child.on('spawn', () => events.push('spawn'));
  run.child.on('error', () => events.push('error'));
  run.child.on('exit', () => events.push('exit'));
  run.child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  run.child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  const code = await new Promise<number | null>((resolve) => {
    run.child.on('close', (exitCode: number | null) => {
      events.push('close');
      resolve(exitCode);
    });
  });
  return { stdout: Buffer.concat(stdoutChunks).toString('utf-8'), stderr: Buffer.concat(stderrChunks).toString('utf-8'), events, code };
}

describe('spawnOffMain with no pty host registered', () => {
  it('runs the child here with piped stdio: stdin in, both outputs back as Buffers, exit then close', async () => {
    const run = nodeChild(`
      let input = '';
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => {
        process.stdout.write('answer: ' + input.toUpperCase());
        process.stderr.write('a warning');
        process.exitCode = 3;
      });
    `);
    run.child.stdin.write('what changed');
    run.child.stdin.end(' today');

    const result = await finished(run);

    expect(result.stdout).toBe('answer: WHAT CHANGED TODAY');
    expect(result.stderr).toBe('a warning');
    expect(result.events).toEqual(['spawn', 'exit', 'close']);
    expect(result.code).toBe(3);
    expect(run.child.exitCode).toBe(3);
    expect(typeof run.child.pid).toBe('number');
    // An error from this child is its own, never a lost host.
    expect(run.hosted).toBe(false);
  }, 20_000);

  it('gives a run with ignored stdio streams that never emit, and still reports its exit', async () => {
    // More than a pipe holds: with a pipe nobody reads this run would never end.
    const run = nodeChild('process.stdout.write("x".repeat(400000)); process.exitCode = 4;', { stdio: 'ignore' });
    expect(run.child.stdin.write('dropped')).toBe(false);

    const result = await finished(run);

    expect(result.stdout).toBe('');
    expect(result.code).toBe(4);
  }, 20_000);

  it('opens a file as the run\'s stdin, whole', async () => {
    const inputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'off-main-spawn-stdin-'));
    try {
      const inputFile = path.join(inputDirectory, 'input.bin');
      fs.writeFileSync(inputFile, 'y'.repeat(300_000));
      const run = nodeChild(
        'let total = 0; process.stdin.on("data", (chunk) => { total += chunk.length; }); process.stdin.on("end", () => process.stdout.write(String(total)));',
        { stdinFile: inputFile },
      );

      expect((await finished(run)).stdout).toBe('300000');
    } finally {
      fs.rmSync(inputDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it('reports a program that cannot start as error then close, never as a throw', async () => {
    const run = spawnOffMain(path.join(os.tmpdir(), 'no-such-off-main-spawn-binary'), [], { cwd: process.cwd() });

    const result = await finished(run);

    expect(result.events).toEqual(['error', 'close']);
    expect(run.child.pid).toBeUndefined();
  }, 20_000);

  it('reports a start that throws (a stdin file that is not there) the same way', async () => {
    const run = nodeChild('process.exit(0)', { stdinFile: path.join(os.tmpdir(), 'no-such-off-main-spawn-stdin-file') });

    const result = await finished(run);

    expect(result.events).toEqual(['error', 'close']);
    expect(() => run.stop()).not.toThrow();
  }, 20_000);

  it('does not throw for a failed start nobody listens to', async () => {
    const run = spawnOffMain(path.join(os.tmpdir(), 'no-such-off-main-spawn-binary'), [], { cwd: process.cwd() });

    await new Promise<void>((resolve) => run.child.on('close', () => resolve()));
  }, 20_000);

  it.each<CliStopMode | undefined>([undefined, 'treeNow', 'process'])('stops a run that would not end by itself (mode %s)', async (mode) => {
    const run = nodeChild('setInterval(() => process.stdout.write("."), 50);', { detached: process.platform !== 'win32' });
    await new Promise<void>((resolve) => run.child.stdout.once('data', () => resolve()));

    run.stop(mode);
    await new Promise<void>((resolve) => run.child.on('close', () => resolve()));

    // Killed, not a clean exit: a signal on POSIX, a non-zero code on Windows.
    expect(run.child.signalCode !== null || run.child.exitCode !== 0).toBe(true);
  }, 20_000);

  it.each<[CliStopMode | undefined, number, number]>([
    [undefined, 1, 0],
    ['treeNow', 0, 1],
    ['process', 0, 0],
  ])('reaches the stop function its mode names (mode %s: tree stops %i, immediate tree kills %i)', async (mode, treeStops, immediateKills) => {
    const run = nodeChild('setInterval(() => process.stdout.write("."), 50);', { detached: process.platform !== 'win32' });
    await new Promise<void>((resolve) => run.child.stdout.once('data', () => resolve()));
    stopChildTreeSpy.mockClear();
    killChildTreeNowSpy.mockClear();

    run.stop(mode);
    await new Promise<void>((resolve) => run.child.on('close', () => resolve()));

    // 'process' ends the one process and starts no tree stop, so no taskkill on Windows.
    expect(stopChildTreeSpy).toHaveBeenCalledTimes(treeStops);
    expect(killChildTreeNowSpy).toHaveBeenCalledTimes(immediateKills);
  }, 20_000);

  it('never hands the child Crashpad\'s pipe name, from the caller\'s env or from main\'s own', async () => {
    const script = `process.stdout.write(String(Object.keys(process.env).some((name) => name.toUpperCase() === '${PIPE_KEY}')));`;
    vi.stubEnv(PIPE_KEY, '\\\\.\\pipe\\crashpad_1_MAIN');
    try {
      const inherited = await finished(nodeChild(script));
      const passed = await finished(nodeChild(script, { env: { ...process.env, [PIPE_KEY]: '\\\\.\\pipe\\crashpad_2_CALLER' } }));

      expect(inherited.stdout).toBe('false');
      expect(passed.stdout).toBe('false');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 20_000);
});

describe('spawnOffMain with a pty host registered', () => {
  interface Received {
    command: string;
    args: string[];
    options: OffMainCliOptions;
  }

  function hostedChild(): CliChildProcess & { stops: Array<CliStopMode | undefined> } {
    const stops: Array<CliStopMode | undefined> = [];
    return Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      stdout: Object.assign(new EventEmitter(), { resume: () => undefined }),
      stderr: Object.assign(new EventEmitter(), { resume: () => undefined }),
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
      kill: () => true,
      stopTree: (mode?: CliStopMode) => { stops.push(mode); },
      stops,
    });
  }

  function registerHost(hosted: CliChildProcess): Received[] {
    const received: Received[] = [];
    setOffMainCliSpawner((command, args, options) => {
      received.push({ command, args, options });
      return hosted;
    });
    return received;
  }

  it('starts the child in the host and returns the host\'s run, starting nothing here', () => {
    const hosted = hostedChild();
    const received = registerHost(hosted);

    // A program that does not exist: started here, it would fail the test with an error event.
    const run = spawnOffMain('/nonexistent/hosted-only-binary', ['--version'], { cwd: '/mock/repo', env: { KANGENTIC_RUN: 'yes', [PIPE_KEY]: 'pipe' } });

    expect(run.child).toBe(hosted);
    expect(run.hosted).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].command).toBe('/nonexistent/hosted-only-binary');
    expect(received[0].args).toEqual(['--version']);
    // A plain run asks for nothing beyond the four fields every run carries.
    expect(received[0].options).toEqual({ cwd: '/mock/repo', shell: false, detached: false, env: { KANGENTIC_RUN: 'yes' } });
  });

  it('asks the host for what the caller asked: no pipes, a shown window, a run the app leaves alone, a file as stdin', () => {
    const received = registerHost(hostedChild());

    spawnOffMain('sh', [], {
      cwd: '/mock/repo',
      env: {},
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      outlivesApp: true,
      stdinFile: '/mock/input.bin',
      userCommand: true,
    });

    expect(received[0].options).toEqual({
      cwd: '/mock/repo',
      env: {},
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      outlivesApp: true,
      stdinFile: '/mock/input.bin',
      userCommand: true,
    });
  });

  it('stops the host\'s run in the mode asked for', () => {
    const hosted = hostedChild();
    registerHost(hosted);
    const run = spawnOffMain('git', ['cat-file', '--batch'], { cwd: '/mock/repo', env: {} });

    run.stop();
    run.stop('treeNow');
    run.stop('process');

    expect(hosted.stops).toEqual([undefined, 'treeNow', 'process']);
  });
});
