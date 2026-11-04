/**
 * Carrying a remote project's dev-server port to this computer (#913), with a fake `ssh` and a fake
 * helper. What a user loses if a test here fails: a server they started on the host is unreachable at
 * localhost and in the Browser pane; an `ssh` is left running after its port is no longer wanted (or after
 * the app quits); a port someone else holds is reported as forwarded; or the forward quietly stays down
 * after a dropped network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { forwardArguments, PortForwarder } from '../../src/main/remote/link/port-forward';

const CONNECTION = {
  sshPath: '/usr/bin/ssh',
  args: ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-i', '/keys/host', 'dev@build-box'],
};

class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4000;
  stopped = false;
  end(code: number, stderrText = ''): void {
    if (stderrText) this.stderr.write(stderrText);
    this.exitCode = code;
    this.emit('close', code, null);
  }
}

interface Rig {
  forwarder: PortForwarder;
  children: FakeChild[];
  spawnCalls: Array<{ file: string; args: string[] }>;
  listening: Set<number>;
  localBound: Set<number>;
  stops: Array<{ child: FakeChild; immediately: boolean }>;
  requests: number;
}

function makeRig(): Rig {
  const rig: Rig = {
    children: [],
    spawnCalls: [],
    listening: new Set(),
    localBound: new Set(),
    stops: [],
    requests: 0,
    forwarder: undefined as unknown as PortForwarder,
  };
  rig.forwarder = new PortForwarder({
    requestListening: async () => {
      rig.requests += 1;
      return [...rig.listening];
    },
    spawnProcess: ((file: string, args: string[]) => {
      rig.spawnCalls.push({ file, args });
      const child = new FakeChild();
      rig.children.push(child);
      // ssh opens its local listener a moment after it starts.
      setTimeout(() => {
        if (child.exitCode === null && !child.stopped) rig.localBound.add(Number(args[args.indexOf('-L') + 1].split(':')[1]));
      }, 300);
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn,
    isLocalPortBound: async (port) => rig.localBound.has(port),
    stopProcess: (child, immediately) => {
      const fake = child as unknown as FakeChild;
      fake.stopped = true;
      rig.stops.push({ child: fake, immediately });
    },
    pollMs: 2000,
    retryInitialMs: 2000,
    retryMaxMs: 8000,
  });
  rig.forwarder.addHost('host-a', CONNECTION);
  return rig;
}

async function advance(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the ssh command for a forward', () => {
  it('keeps the link\'s options and key, binds 127.0.0.1 explicitly, reaches localhost on the host, and sends no command', () => {
    expect(forwardArguments(CONNECTION.args, 7300)).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-i', '/keys/host',
      '-N', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:7300:localhost:7300', 'dev@build-box',
    ]);
  });
});

describe('forwarding a wanted port', () => {
  it('starts ssh only once a server listens on the host, then reports it forwarding when the local port opens', async () => {
    const rig = makeRig();
    rig.forwarder.setPorts('host-a', [7300]);
    rig.forwarder.linkState('host-a', 'connected');

    await advance(100);
    expect(rig.spawnCalls).toEqual([]);
    expect(rig.forwarder.list('host-a')).toEqual([{ port: 7300, state: 'waiting' }]);

    rig.listening.add(7300);
    await advance(2100);
    expect(rig.spawnCalls).toHaveLength(1);
    expect(rig.spawnCalls[0].args).toContain('127.0.0.1:7300:localhost:7300');

    await advance(600);
    expect(rig.forwarder.list('host-a')).toEqual([{ port: 7300, state: 'forwarding' }]);
  });

  it('does not poll the host while the link is down, and starts as soon as it is up', async () => {
    const rig = makeRig();
    rig.listening.add(7300);
    rig.forwarder.setPorts('host-a', [7300]);
    await advance(5000);
    expect(rig.requests).toBe(0);

    rig.forwarder.linkState('host-a', 'connected');
    await advance(50);
    expect(rig.spawnCalls).toHaveLength(1);
  });

  it('stops asking the host once every wanted port is forwarded', async () => {
    const rig = makeRig();
    rig.listening.add(7300);
    rig.forwarder.setPorts('host-a', [7300]);
    rig.forwarder.linkState('host-a', 'connected');
    await advance(1000);
    const asked = rig.requests;

    await advance(20_000);
    expect(rig.requests).toBe(asked);
  });

  it('remembers what was wanted before the host was added', async () => {
    const rig = makeRig();
    rig.forwarder.setPorts('host-b', [7301]);
    rig.listening.add(7301);
    rig.forwarder.addHost('host-b', CONNECTION);
    rig.forwarder.linkState('host-b', 'connected');
    await advance(50);
    expect(rig.spawnCalls.some((call) => call.args.includes('127.0.0.1:7301:localhost:7301'))).toBe(true);
  });
});

describe('a port someone else holds here', () => {
  it('is blocked with a sentence and never starts ssh, then tries again after a backoff', async () => {
    const rig = makeRig();
    rig.localBound.add(7300);
    rig.listening.add(7300);
    rig.forwarder.setPorts('host-a', [7300]);
    rig.forwarder.linkState('host-a', 'connected');
    await advance(100);

    expect(rig.spawnCalls).toEqual([]);
    expect(rig.forwarder.list('host-a')[0]).toMatchObject({ port: 7300, state: 'blocked' });
    expect(rig.forwarder.list('host-a')[0].detail).toMatch(/already in use on this computer/);

    rig.localBound.delete(7300);
    await advance(2100);
    expect(rig.spawnCalls).toHaveLength(1);
  });
});

describe('a forward that ends', () => {
  it('says why in ssh\'s own words, then retries with a growing backoff', async () => {
    const rig = makeRig();
    rig.listening.add(7300);
    rig.forwarder.setPorts('host-a', [7300]);
    rig.forwarder.linkState('host-a', 'connected');
    await advance(100);
    rig.localBound.delete(7300);
    rig.children[0].end(255, 'channel_setup_fwd_listener: cannot listen to port: 7300\n');
    await advance(10);

    expect(rig.forwarder.list('host-a')[0]).toEqual({ port: 7300, state: 'blocked', detail: 'channel_setup_fwd_listener: cannot listen to port: 7300' });

    await advance(2100);
    await advance(2100);
    expect(rig.spawnCalls).toHaveLength(2);
  });

  it('comes back after the network drops a working forward', async () => {
    const rig = makeRig();
    rig.listening.add(7300);
    rig.forwarder.setPorts('host-a', [7300]);
    rig.forwarder.linkState('host-a', 'connected');
    await advance(1000);
    expect(rig.forwarder.list('host-a')[0].state).toBe('forwarding');

    rig.localBound.delete(7300);
    rig.children[0].end(255, 'Connection timed out during banner exchange');
    await advance(2100);
    await advance(2100);
    expect(rig.spawnCalls).toHaveLength(2);
  });
});

describe('ending forwards', () => {
  it('stops the ssh of a port that is no longer wanted, and no other', async () => {
    const rig = makeRig();
    rig.listening.add(7300);
    rig.listening.add(7301);
    rig.forwarder.setPorts('host-a', [7300, 7301]);
    rig.forwarder.linkState('host-a', 'connected');
    await advance(1000);
    expect(rig.children).toHaveLength(2);

    rig.forwarder.setPorts('host-a', [7301]);
    expect(rig.stops).toHaveLength(1);
    expect(rig.stops[0].child).toBe(rig.children[0]);
    expect(rig.forwarder.list('host-a').map((entry) => entry.port)).toEqual([7301]);
    // Its exit is not a failure, and nothing is restarted.
    rig.children[0].end(143);
    await advance(10_000);
    expect(rig.spawnCalls).toHaveLength(2);
  });

  it('stops every ssh when the host is removed, and when the process ends', async () => {
    const rig = makeRig();
    rig.listening.add(7300);
    rig.forwarder.setPorts('host-a', [7300]);
    rig.forwarder.linkState('host-a', 'connected');
    await advance(1000);

    rig.forwarder.removeHost('host-a');
    expect(rig.stops).toHaveLength(1);
    expect(rig.forwarder.list('host-a')).toEqual([]);

    rig.forwarder.addHost('host-c', CONNECTION);
    rig.forwarder.setPorts('host-c', [7302]);
    rig.listening.add(7302);
    rig.forwarder.linkState('host-c', 'connected');
    await advance(1000);
    rig.forwarder.dispose();
    expect(rig.stops.filter((stop) => stop.immediately)).toHaveLength(1);
  });

  it('leaves a running forward alone when the link drops, and starts no new one until it is back', async () => {
    const rig = makeRig();
    rig.listening.add(7300);
    rig.forwarder.setPorts('host-a', [7300]);
    rig.forwarder.linkState('host-a', 'connected');
    await advance(1000);

    rig.forwarder.linkState('host-a', 'reconnecting');
    expect(rig.stops).toEqual([]);
    expect(rig.forwarder.list('host-a')[0].state).toBe('forwarding');
  });
});
