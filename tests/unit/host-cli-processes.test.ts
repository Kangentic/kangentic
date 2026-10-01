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

import { afterEach, describe, expect, it } from 'vitest';
import { HostCliProcesses } from '../../src/main/pty/host/host-cli-processes';
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
    const { processes, closed } = runner();
    processes.start(nodeRun(3, 'setInterval(() => {}, 1000);'));
    processes.start(nodeRun(4, 'setInterval(() => {}, 1000);'));
    await new Promise((resolve) => setTimeout(resolve, 300));
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

  it('ignores writes and stops for a run it does not know', () => {
    const { processes, events } = runner();
    processes.write(99, 'late');
    processes.endInput(99, undefined);
    processes.stop(99);
    expect(events).toEqual([]);
  });
});
