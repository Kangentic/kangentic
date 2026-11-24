/**
 * The pty host's agent CLI runs (`src/main/pty/host/host-cli-processes.ts`),
 * against real child processes: what `spawnCli` used to get from a local
 * `child_process.spawn` must arrive as events in the same order, and a stop
 * must end the run.
 *
 * The children are this test runner's own Node, so the runner's executable is
 * not the host's "own executable" here: each test passes a path that matches
 * nothing, except the one that checks the refusal.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSyncSpanLabelSink } from '../../src/main/diagnostics/event-loop-lag';
import { HostCliProcesses, leadingExecutable } from '../../src/main/pty/host/host-cli-processes';
import { setMainExecutable } from '../../src/main/pty/host/host-exec';
import type { PtyHostCliSpawnParams, PtyHostEvent } from '../../src/main/pty/host/protocol';

const NOT_THIS_PROCESS = '/nonexistent/kangentic-host-binary';

const live: HostCliProcesses[] = [];

afterEach(() => {
  for (const processes of live.splice(0)) processes.stopAll();
});

function runner(ownExecutable = NOT_THIS_PROCESS) {
  const events: PtyHostEvent[] = [];
  const waiters: Array<{ processId: number; resolve: () => void }> = [];
  const processes = new HostCliProcesses((event) => {
    events.push(event);
    if (event.type !== 'cliClose') return;
    for (const waiter of waiters.filter((entry) => entry.processId === event.processId)) waiter.resolve();
  }, undefined, ownExecutable);
  live.push(processes);
  const closed = (processId: number) => new Promise<void>((resolve) => {
    if (events.some((event) => event.type === 'cliClose' && event.processId === processId)) resolve();
    else waiters.push({ processId, resolve });
  });
  return { processes, events, closed };
}

function nodeRun(processId: number, script: string): PtyHostCliSpawnParams {
  return {
    processId,
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    shell: false,
    env: { ...process.env } as Record<string, string>,
    detached: process.platform !== 'win32',
  };
}

/**
 * A Windows stop is `taskkill /PID <run> /T /F`, which opens the pid about
 * 550 ms after it starts. The host pins the run's pid with a handle of its own
 * until taskkill exits, so a run that exits by itself meanwhile cannot hand its
 * pid to a stranger first (src/main/shared/child-tree-stop.ts).
 */
describe('host CLI runs: the Windows stop pins the run\'s pid', () => {
  it('passes the host\'s pin to the tree stop, for the run\'s own pid, before taskkill starts', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const order: string[] = [];
      const taskkillHandle = { on: () => taskkillHandle, unref: () => taskkillHandle };
      const run = Object.assign(new EventEmitter(), {
        pid: 4321,
        exitCode: null,
        signalCode: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
        kill: vi.fn(),
      });
      const spawnChild = ((command: string, args: readonly string[]) => {
        if (command !== 'taskkill') return run;
        order.push(`taskkill ${args.join(' ')}`);
        return taskkillHandle;
      }) as unknown as typeof spawn;
      const pinRoot = vi.fn((pid: number) => {
        order.push(`pin ${pid}`);
        return () => undefined;
      });
      const processes = new HostCliProcesses(() => undefined, spawnChild, NOT_THIS_PROCESS, pinRoot);
      processes.start(nodeRun(1, 'setInterval(() => {}, 1000)'));
      processes.stop(1);
      expect(order).toEqual(['pin 4321', 'taskkill /pid 4321 /T /F']);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

/**
 * CreateProcess runs on the thread that flushes every terminal, so the start is
 * a `timeSyncWork` span named for the program (`cli:spawn:<program>`): a stall
 * report then says which run's start held the loop. The child is a stand-in
 * that never runs, so this holds on every platform and leaves nothing to stop.
 */
describe('host CLI runs: the spawn is timed as a span named for the program', () => {
  afterEach(() => setSyncSpanLabelSink(null));

  /** Starts `params` and returns what the sink and the spawn call saw, in order. */
  function startRecording(params: PtyHostCliSpawnParams): Array<string | null> {
    // The sink hears a span's label as it opens and null as it closes (nothing
    // encloses it here), so the call into child_process sits between the two.
    const order: Array<string | null> = [];
    setSyncSpanLabelSink((label) => order.push(label));
    const spawnChild = (() => {
      order.push('child_process.spawn');
      return Object.assign(new EventEmitter(), {
        pid: 4321,
        exitCode: null,
        signalCode: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
        kill: vi.fn(),
      });
    }) as unknown as typeof spawn;
    new HostCliProcesses(() => undefined, spawnChild, NOT_THIS_PROCESS).start(params);
    return order;
  }

  const fakeRun: PtyHostCliSpawnParams = {
    processId: 1,
    command: 'agent-cli',
    args: ['-p', 'hello'],
    cwd: '/mock/project',
    shell: false,
    env: {},
    detached: false,
  };

  it('labels a direct run with the program it starts', () => {
    expect(startRecording(fakeRun)).toEqual(['cli:spawn:agent-cli', 'child_process.spawn', null]);
  });

  it('labels a shell run with the executable its command line starts, not the whole line', () => {
    expect(startRecording({ ...fakeRun, command: '"agent-cli" -p "a prompt that names git"', args: [], shell: true }))
      .toEqual(['cli:spawn:agent-cli', 'child_process.spawn', null]);
  });
});

function text(events: PtyHostEvent[], stream: 'stdout' | 'stderr'): string {
  return events
    .filter((event): event is Extract<PtyHostEvent, { type: 'cliData' }> => event.type === 'cliData' && event.stream === stream)
    .map((event) => Buffer.from(event.data).toString('utf-8'))
    .join('');
}

describe('host CLI runs', () => {
  it('pipes stdin in and both outputs back, then reports exit and close after the last data', async () => {
    const { processes, events, closed } = runner();
    processes.start(nodeRun(1, `
      let input = '';
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => {
        process.stdout.write('answer: ' + input.toUpperCase());
        process.stderr.write('a warning');
        process.exitCode = 3;
      });
    `));
    processes.write(1, 'what changed');
    processes.endInput(1, ' today');
    await closed(1);

    expect(text(events, 'stdout')).toBe('answer: WHAT CHANGED TODAY');
    expect(text(events, 'stderr')).toBe('a warning');
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('cliSpawned');
    expect(types.indexOf('cliExit')).toBeGreaterThan(types.lastIndexOf('cliData'));
    expect(types[types.length - 1]).toBe('cliClose');
    const spawned = events[0] as Extract<PtyHostEvent, { type: 'cliSpawned' }>;
    expect(typeof spawned.pid).toBe('number');
    expect(events.find((event) => event.type === 'cliExit')).toMatchObject({ code: 3 });
    expect(processes.liveCount).toBe(0);
  }, 20_000);

  it('stops a run that would not end on its own, and counts it live until then', async () => {
    const { processes, events, closed } = runner();
    processes.start(nodeRun(2, 'setInterval(() => process.stdout.write("."), 50);'));
    await new Promise<void>((resolve) => {
      const check = () => (events.some((event) => event.type === 'cliData') ? resolve() : setTimeout(check, 20));
      check();
    });
    expect(processes.liveCount).toBe(1);
    processes.stop(2);
    await closed(2);
    expect(processes.liveCount).toBe(0);
    const exit = events.find((event) => event.type === 'cliExit') as Extract<PtyHostEvent, { type: 'cliExit' }>;
    // Killed, not a clean exit: a signal on POSIX, taskkill's exit code on Windows.
    expect(exit.signal !== null || exit.code !== 0).toBe(true);
  }, 20_000);

  it('stops every run at shutdown', async () => {
    const { processes, events, closed } = runner();
    processes.start(nodeRun(3, 'setInterval(() => {}, 1000);'));
    processes.start(nodeRun(4, 'setInterval(() => {}, 1000);'));
    // Both started, rather than a fixed pause a loaded runner can outlast.
    await new Promise<void>((resolve) => {
      const check = () => (events.filter((event) => event.type === 'cliSpawned').length === 2 ? resolve() : setTimeout(check, 20));
      check();
    });
    processes.stopAll();
    await Promise.all([closed(3), closed(4)]);
    expect(processes.liveCount).toBe(0);
  }, 20_000);

  it('reports a run that cannot start as an error, then close', async () => {
    const { processes, events, closed } = runner();
    processes.start({ ...nodeRun(5, ''), command: '/nonexistent/agent-cli-binary', args: [] });
    await closed(5);
    expect(events.find((event) => event.type === 'cliError')).toBeDefined();
    expect(events.some((event) => event.type === 'cliSpawned')).toBe(false);
  }, 20_000);

  it('refuses to start its own executable, which with RunAsNode off is a second app', () => {
    const { processes, events } = runner(process.execPath);
    processes.start(nodeRun(6, 'process.exit(0)'));
    expect(events.map((event) => event.type)).toEqual(['cliError', 'cliClose']);
    expect(events[0]).toMatchObject({ error: { message: 'The pty host does not launch its own executable' } });
    expect(processes.liveCount).toBe(0);
  });

  it('starts a shell run whose arguments only name its own executable', async () => {
    // A `.cmd` shim's run goes through the shell as one command line, and a
    // title prompt passed as an argument can be a user's text about this app.
    const ownExecutable = process.platform === 'win32' ? 'C:\\Program Files\\Kangentic\\Kangentic.exe' : '/opt/Kangentic/kangentic';
    const { processes, events, closed } = runner(ownExecutable);
    processes.start({
      processId: 7,
      command: `"${process.execPath}" -e "process.stdout.write('ran')" "why does Kangentic.exe crash at ${ownExecutable}"`,
      args: [],
      cwd: process.cwd(),
      shell: true,
      env: { ...process.env } as Record<string, string>,
      detached: false,
    });
    await closed(7);
    expect(events.some((event) => event.type === 'cliError')).toBe(false);
    expect(text(events, 'stdout')).toBe('ran');
  }, 20_000);

  it('refuses a shell run whose executable is its own', () => {
    const { processes, events } = runner(process.execPath);
    processes.start({ ...nodeRun(8, ''), command: `"${process.execPath}" -e "0"`, args: [], shell: true });
    expect(events.map((event) => event.type)).toEqual(['cliError', 'cliClose']);
  });

  it('reads the executable a shell command line starts', () => {
    expect(leadingExecutable('"C:\\npm\\agent.cmd" -p "Kangentic.exe"')).toBe('C:\\npm\\agent.cmd');
    expect(leadingExecutable('  "/usr/local/bin/agent" --flag')).toBe('/usr/local/bin/agent');
    expect(leadingExecutable('agent -p title')).toBe('agent');
    // The single quotes `quoteArg` writes for a POSIX shell, with a space in the
    // path: the first-word fallback would stop at `'/opt/app`.
    expect(leadingExecutable("'/opt/app dir/kangentic' --version")).toBe('/opt/app dir/kangentic');
  });

  describe('main\'s executable, as reported in the host\'s init', () => {
    // On macOS the host runs from the Helper bundle, so its own execPath is never
    // the app binary a run could name. A runner built with no executable argument
    // reads `ownExecutables()` at each start, so it sees what main reported after
    // the runner was built.
    const mainBinary = path.resolve('/mock/Kangentic.app/Contents/MacOS/Kangentic');
    const REFUSAL = 'The pty host does not launch its own executable';
    const SPAWN_REACHED = 'the spawn was reached';
    afterEach(() => setMainExecutable(undefined));

    /** A runner with the production default (no third argument) over a spawn that
     *  fails with a distinctive error, so a refusal and a reached spawn differ. */
    function defaultRunner() {
      const events: PtyHostEvent[] = [];
      const spawnChild = vi.fn(() => {
        throw new Error(SPAWN_REACHED);
      });
      const processes = new HostCliProcesses((event) => events.push(event), spawnChild as unknown as typeof spawn);
      live.push(processes);
      return { processes, events, spawnChild };
    }

    function runOf(processId: number, command: string, shell: boolean): PtyHostCliSpawnParams {
      return { processId, command, args: [], cwd: process.cwd(), shell, env: {}, detached: false };
    }

    it('refuses main\'s executable, as a command and as the head of a shell command line, without spawning', () => {
      // Red-green: if the runner compared only this process's execPath (the
      // pre-init default), both starts would reach the spawn.
      const { processes, events, spawnChild } = defaultRunner();
      setMainExecutable(mainBinary);

      processes.start(runOf(1, mainBinary, false));
      processes.start(runOf(2, `"${mainBinary}" --version`, true));

      expect(events.map((event) => event.type)).toEqual(['cliError', 'cliClose', 'cliError', 'cliClose']);
      for (const event of events.filter((entry) => entry.type === 'cliError')) {
        expect(event).toMatchObject({ error: { message: REFUSAL } });
      }
      expect(spawnChild).not.toHaveBeenCalled();
      expect(processes.liveCount).toBe(0);
    });

    it('reads main\'s executable at each start, so a start before it was reported is not refused', () => {
      const { processes, events, spawnChild } = defaultRunner();

      processes.start(runOf(3, mainBinary, false));
      expect(spawnChild).toHaveBeenCalledTimes(1);
      expect(events[0]).toMatchObject({ error: { message: SPAWN_REACHED } });

      setMainExecutable(mainBinary);
      processes.start(runOf(4, mainBinary, false));
      expect(spawnChild).toHaveBeenCalledTimes(1);
      expect(events[2]).toMatchObject({ error: { message: REFUSAL } });
    });
  });

  it('ignores writes and stops for a run it does not know', () => {
    const { processes, events } = runner();
    processes.write(99, 'late');
    processes.endInput(99, undefined);
    processes.stop(99);
    expect(events).toEqual([]);
  });
});

/**
 * What main's own children need of a run that an agent CLI never did: a script
 * nobody reads, a command the user started to outlast the app, input too large
 * for a pipe write, and a stop that is not the tree stop with a grace. Each of
 * these ran on main's thread until the run moved here, and a move must not
 * change what the run does.
 */
describe('host runs: no pipes, a file as stdin, and a run the app leaves alone', () => {
  function spawnedCount(events: PtyHostEvent[]): number {
    return events.filter((event) => event.type === 'cliSpawned').length;
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    await new Promise<void>((resolve) => {
      const check = () => (condition() ? resolve() : setTimeout(check, 20));
      check();
    });
  }

  it('gives a run with ignored stdio no pipes: it runs to its exit and none of its output crosses', async () => {
    const { processes, events, closed } = runner();
    // More than a pipe holds, so a run with an unread pipe would block here.
    processes.start({ ...nodeRun(20, 'process.stdout.write("x".repeat(400000)); process.exitCode = 4;'), stdio: 'ignore' });
    await closed(20);

    expect(events.some((event) => event.type === 'cliData')).toBe(false);
    expect(events.find((event) => event.type === 'cliExit')).toMatchObject({ code: 4 });
    // A write to a run with no stdin is dropped, as one to an unknown run is.
    expect(() => processes.write(20, 'late')).not.toThrow();
  }, 20_000);

  it('opens a file as the run\'s stdin, whole, with no pipe write', async () => {
    const inputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-cli-stdin-'));
    try {
      const inputFile = path.join(inputDirectory, 'input.bin');
      fs.writeFileSync(inputFile, 'y'.repeat(300_000));
      const { processes, events, closed } = runner();
      processes.start({
        ...nodeRun(21, 'let total = 0; process.stdin.on("data", (chunk) => { total += chunk.length; }); process.stdin.on("end", () => process.stdout.write(String(total)));'),
        stdinFile: inputFile,
      });
      await closed(21);

      expect(text(events, 'stdout')).toBe('300000');
    } finally {
      fs.rmSync(inputDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it('reports a stdin file that is not there as a run that could not start', async () => {
    const { processes, events, closed } = runner();
    processes.start({ ...nodeRun(22, 'process.exit(0)'), stdinFile: path.join(os.tmpdir(), 'no-such-host-cli-stdin-file') });
    await closed(22);

    expect(events.map((event) => event.type)).toEqual(['cliError', 'cliClose']);
    expect(processes.liveCount).toBe(0);
  });

  it('leaves a run that outlives the app running at shutdown, never waits for it, and still stops it when asked', async () => {
    const { processes, events, closed } = runner();
    processes.start({ ...nodeRun(23, 'setInterval(() => {}, 1000);'), outlivesApp: true });
    processes.start(nodeRun(24, 'setInterval(() => {}, 1000);'));
    try {
      await waitFor(() => spawnedCount(events) === 2);
      // Only the ordinary run is one a shutdown waits for.
      expect(processes.liveCount).toBe(1);

      processes.stopAll();
      await closed(24);

      expect(events.some((event) => event.type === 'cliExit' && event.processId === 23)).toBe(false);
      expect(processes.liveCount).toBe(0);
    } finally {
      processes.stop(23);
    }
    await closed(23);
  }, 20_000);

  it('waits at shutdown for a run that outlives the app once main asked for it to stop', async () => {
    // An aborted script at a quit: a host that exits before the stop has ended
    // the tree takes its own `taskkill` down with it.
    const { processes, events, closed } = runner();
    processes.start({ ...nodeRun(25, 'setInterval(() => {}, 1000);'), outlivesApp: true });
    await waitFor(() => spawnedCount(events) === 1);
    expect(processes.liveCount).toBe(0);

    processes.stop(25, 'treeNow');
    // Read in the same turn as the stop: the process cannot have been reaped yet.
    expect(processes.liveCount).toBe(1);

    await closed(25);
    expect(processes.liveCount).toBe(0);
  }, 20_000);
});

/**
 * The stop modes over a stand-in child, so no real pid or process group is
 * signalled: `process.kill` is captured, and `taskkill` is the injected spawn.
 */
describe('host runs: how a stop ends the run', () => {
  const RUN_PID = 4321;

  function standInRun(exited: boolean) {
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), {
      pid: RUN_PID,
      exitCode: exited ? 0 : null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
      kill,
      unref: () => undefined,
    });
    const started: string[] = [];
    const taskkillHandle = { on: () => taskkillHandle, unref: () => taskkillHandle };
    const spawnChild = ((command: string, args: readonly string[]) => {
      if (command !== 'taskkill') return child;
      started.push(`taskkill ${args.join(' ')}`);
      return taskkillHandle;
    }) as unknown as typeof spawn;
    const processes = new HostCliProcesses(() => undefined, spawnChild, NOT_THIS_PROCESS);
    processes.start({ ...nodeRun(1, ''), detached: true });
    return { processes, kill, started };
  }

  function onPlatform<Result>(platform: NodeJS.Platform, work: () => Result): Result {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      return work();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  }

  afterEach(() => vi.restoreAllMocks());

  it('ends the one process and starts no taskkill when asked for the process alone', () => {
    onPlatform('win32', () => {
      const { processes, kill, started } = standInRun(false);

      processes.stop(1, 'process');

      expect(kill).toHaveBeenCalledTimes(1);
      expect(started).toEqual([]);
    });
  });

  it('takes the whole tree at once on Windows, for a run that has not exited', () => {
    onPlatform('win32', () => {
      const { processes, started } = standInRun(false);

      processes.stop(1, 'treeNow');

      expect(started).toEqual([`taskkill /pid ${RUN_PID} /T /F`]);
    });
  });

  it('kills the process group at once on POSIX, with no SIGTERM first', () => {
    onPlatform('linux', () => {
      const signals = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const { processes } = standInRun(false);

      processes.stop(1, 'treeNow');

      expect(signals.mock.calls).toEqual([[-RUN_PID, 'SIGKILL']]);
    });
  });

  it('reaches what an exited run left holding its output open (POSIX), which the stop with a grace never does', () => {
    onPlatform('linux', () => {
      const signals = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const { processes } = standInRun(true);

      // The run exited and its output is still open: the default stop has nothing to stop.
      processes.stop(1);
      expect(signals).not.toHaveBeenCalled();

      processes.stop(1, 'treeNow');
      expect(signals.mock.calls).toEqual([[-RUN_PID, 'SIGKILL']]);
    });
  });

  it('never tree-kills by a pid whose run already exited on Windows, where the pid may name a stranger', () => {
    onPlatform('win32', () => {
      const { processes, started } = standInRun(true);

      processes.stop(1, 'treeNow');

      expect(started).toEqual([]);
    });
  });
});
