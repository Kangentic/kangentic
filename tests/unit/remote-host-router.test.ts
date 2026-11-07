/**
 * The pty host's router (#913): which of the local core and the SSH link hub gets each message. It
 * runs the real router, hub, link and helper over an in-memory stream, with a stub standing in for
 * the local core, so the routing is the only thing under test.
 *
 * What a user loses if it breaks: a keystroke or a kill sent to the wrong machine, a remote session
 * the core answers for (and invents a ring for), or a quit that tears the host down before the
 * remote agents were told to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { HostRouter, type RoutedCore } from '../../src/main/remote/host-router';
import type { PtyHostEvent, PtyHostSpawnParams } from '../../src/main/pty/host/protocol';
import type { RemoteHostConnection } from '../../src/main/remote/protocol/messages';
import { dialHelper, makeHelperRig, settle, spawnParams, type HelperRig } from './helpers/remote-link-rig';

const connection: RemoteHostConnection = { sshPath: 'ssh', args: ['host-a'], remoteCommand: 'relay', installId: 'install-a', label: 'a test computer' };

interface Rig {
  router: HostRouter;
  core: RoutedCore & { handleCommand: ReturnType<typeof vi.fn>; handleRequest: ReturnType<typeof vi.fn>; attachRendererPort: ReturnType<typeof vi.fn> };
  helperRig: HelperRig;
  /** The daemon the next dial reaches; a test points it at a new one to model the host restarting. */
  target: { current: HelperRig };
  events: PtyHostEvent[];
}

const teardown: Array<() => void> = [];

function makeRig(helperRig: HelperRig = makeHelperRig(2, { homeDirectory: process.cwd(), baseEnv: { SHELL: '/bin/zsh' } })): Rig {
  const core = {
    handleCommand: vi.fn(),
    handleRequest: vi.fn(async () => 'core-answer'),
    attachRendererPort: vi.fn(),
    liveChildCount: 0,
  };
  const events: PtyHostEvent[] = [];
  const target = { current: helperRig };
  const router = new HostRouter({
    core: core as unknown as RoutedCore,
    emit: (event) => events.push(event),
    connectTo: () => async () => dialHelper(target.current),
    reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
  });
  teardown.push(() => router.hub.removeHost('host-a'), () => helperRig.helper.dispose());
  return { router, core: core as Rig['core'], helperRig, target, events };
}

function fullSpawn(sessionId: string, ptyId: number, hostId?: string): PtyHostSpawnParams {
  return { ...spawnParams(sessionId, `task-${sessionId}`, hostId), ptyId, sentAtMs: Date.now() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  vi.useRealTimers();
});

async function addHost(rig: Rig): Promise<void> {
  const added = rig.router.handleRequest('remote', { op: 'addHost', hostId: 'host-a', connection });
  await settle();
  expect(await added).toEqual({ ok: true });
  await settle(300);
}

describe('spawns', () => {
  it('sends a spawn that names a host to the link, and starts the PTY on the host', async () => {
    const rig = makeRig();
    await addHost(rig);

    const spawning = rig.router.handleRequest('spawn', fullSpawn('remote-1', 11, 'host-a'));
    await settle();
    const result = await spawning;

    expect(result).toMatchObject({ ok: true });
    expect(rig.core.handleRequest).not.toHaveBeenCalled();
    expect(rig.helperRig.spawnPty).toHaveBeenCalledTimes(1);
  });

  it('sends a spawn that names no host to the core', async () => {
    const rig = makeRig();
    await addHost(rig);

    await rig.router.handleRequest('spawn', fullSpawn('local-1', 12));

    expect(rig.core.handleRequest).toHaveBeenCalledWith('spawn', expect.objectContaining({ sessionId: 'local-1' }));
    expect(rig.helperRig.spawnPty).not.toHaveBeenCalled();
  });

  it('fails a spawn onto a host it has no connection for, with a sentence, and never asks the core', async () => {
    const rig = makeRig();

    const attempt = rig.router.handleRequest('spawn', fullSpawn('remote-1', 11, 'host-missing'));
    await expect(attempt).rejects.toThrow('no connection set up for host host-missing');
    expect(rig.core.handleRequest).not.toHaveBeenCalled();
  });
});

describe('commands after a spawn', () => {
  it('follow the PTY: a remote PTY\'s write reaches the host, a local PTY\'s reaches the core', async () => {
    const rig = makeRig();
    await addHost(rig);
    const spawning = rig.router.handleRequest('spawn', fullSpawn('remote-1', 11, 'host-a'));
    await settle();
    await spawning;

    rig.router.handleCommand({ type: 'write', ptyId: 11, data: 'hello' });
    rig.router.handleCommand({ type: 'write', ptyId: 99, data: 'local' });
    await settle();

    expect(rig.helperRig.fakes[0].write).toHaveBeenCalledWith('hello');
    expect(rig.core.handleCommand).toHaveBeenCalledTimes(1);
    expect(rig.core.handleCommand).toHaveBeenCalledWith({ type: 'write', ptyId: 99, data: 'local' });
  });

  it('go to both for what every host must hear: what a renderer shows, and a session\'s removal', async () => {
    const rig = makeRig();
    await addHost(rig);

    rig.router.handleCommand({ type: 'setRendererFocus', rendererId: 1, sessionIds: ['a'] });
    rig.router.handleCommand({ type: 'removeSession', sessionId: 'a' });

    expect(rig.core.handleCommand).toHaveBeenCalledTimes(2);
  });

  it('a request for a remote session follows it to its host, and any other goes to the core', async () => {
    const rig = makeRig();
    await addHost(rig);
    const spawning = rig.router.handleRequest('spawn', fullSpawn('remote-1', 11, 'host-a'));
    await settle();
    await spawning;

    const local = await rig.router.handleRequest('getRawScrollback', { sessionId: 'local-1' });
    expect(local).toBe('core-answer');
    expect(rig.core.handleRequest).toHaveBeenCalledWith('getRawScrollback', { sessionId: 'local-1' });

    const remote = rig.router.handleRequest('getRawScrollback', { sessionId: 'remote-1' });
    await settle();
    await remote;
    expect(rig.core.handleRequest).toHaveBeenCalledTimes(1);
  });
});

describe('the remote request', () => {
  it('asks the helper on a host for what main cannot know of it', async () => {
    const rig = makeRig();
    await addHost(rig);

    const asked = rig.router.handleRequest('remote', { op: 'helper', hostId: 'host-a', method: 'hostInfo', params: {} });
    await settle();

    expect(await asked).toMatchObject({ shellName: 'zsh', shellPath: '/bin/zsh' });
  });

  it('gives the link the wait a long request names', async () => {
    const rig = makeRig();
    await addHost(rig);
    const link = rig.router.hub.linkOf('host-a');
    if (!link) throw new Error('no link');
    const requestHelper = vi.spyOn(link, 'requestHelper').mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });

    await rig.router.handleRequest('remote', { op: 'helper', hostId: 'host-a', method: 'runCommand', params: { file: 'true', args: [], timeoutMs: 7_200_000 }, timeoutMs: 7_210_000 });

    expect(requestHelper).toHaveBeenCalledWith('runCommand', expect.anything(), 7_210_000);
  });

  it('refuses to ask a host it holds no link for', async () => {
    const rig = makeRig();
    await expect(rig.router.handleRequest('remote', { op: 'helper', hostId: 'nobody', method: 'hostInfo', params: {} })).rejects.toThrow('no connection set up');
  });

  it('stops dialing a host that was removed and forgets its routes', async () => {
    const rig = makeRig();
    await addHost(rig);

    await rig.router.handleRequest('remote', { op: 'removeHost', hostId: 'host-a' });

    expect(rig.router.hub.linkOf('host-a')).toBeUndefined();
    await expect(rig.router.handleRequest('spawn', fullSpawn('remote-1', 11, 'host-a'))).rejects.toThrow('no connection set up');
  });
});

describe('forwarding a host\'s dev-server ports', () => {
  it('asks the host which ports listen over its link, starts an ssh for a wanted one, and ends it when the host is removed', async () => {
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-router-proc-'));
    fs.mkdirSync(path.join(proc, 'net'));
    // 127.0.0.1:7300 listening.
    fs.writeFileSync(path.join(proc, 'net', 'tcp'), '  sl  local_address rem_address   st\n   0: 0100007F:1C84 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0\n');
    const spawned: Array<{ file: string; args: string[] }> = [];
    const stopped: unknown[] = [];
    const bound = new Set<number>();
    const helperRig = makeHelperRig(1, { homeDirectory: proc, baseEnv: { SHELL: '/bin/zsh' }, procDirectory: proc });
    const core = { handleCommand: vi.fn(), handleRequest: vi.fn(), attachRendererPort: vi.fn(), liveChildCount: 0 };
    const router = new HostRouter({
      core: core as unknown as RoutedCore,
      emit: () => undefined,
      connectTo: () => async () => dialHelper(helperRig),
      reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
      forwarding: {
        spawnProcess: ((file: string, args: string[]) => {
          spawned.push({ file, args });
          bound.add(7300);
          return Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null, pid: 1 });
        }) as unknown as typeof spawn,
        isLocalPortBound: async (port) => bound.has(port),
        stopProcess: (child) => stopped.push(child),
        pollMs: 500,
      },
    });
    teardown.push(() => router.hub.removeHost('host-a'), () => helperRig.helper.dispose(), () => fs.rmSync(proc, { recursive: true, force: true }));

    await router.handleRequest('remote', { op: 'setForwards', hostId: 'host-a', ports: [7300] });
    const added = router.handleRequest('remote', { op: 'addHost', hostId: 'host-a', connection });
    await settle();
    await added;
    // The helper reads the kernel's table with real file I/O, which fake timers do not advance.
    for (let attempt = 0; attempt < 40 && spawned.length === 0; attempt += 1) {
      await settle(250);
      await fs.promises.stat(proc);
    }
    await settle(1000);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(['-N', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:7300:localhost:7300', 'host-a']);
    expect(await router.handleRequest('remote', { op: 'listForwards', hostId: 'host-a' })).toEqual([{ port: 7300, state: 'forwarding' }]);

    await router.handleRequest('remote', { op: 'removeHost', hostId: 'host-a' });
    expect(stopped).toHaveLength(1);
    expect(await router.handleRequest('remote', { op: 'listForwards', hostId: 'host-a' })).toEqual([]);
  });
});

describe('a link coming back', () => {
  it('reports a connection state as its own event, never as an exit', async () => {
    const rig = makeRig();
    await addHost(rig);

    expect(rig.events.some((event) => event.type === 'remoteLink' && event.hostId === 'host-a' && event.state === 'connected')).toBe(true);
    expect(rig.events.some((event) => event.type === 'exit')).toBe(false);
  });

  it('reports sessions the host no longer holds as lost, with the host', async () => {
    const rig = makeRig();
    await addHost(rig);
    const spawning = rig.router.handleRequest('spawn', fullSpawn('remote-1', 11, 'host-a'));
    await settle();
    await spawning;

    // The host was restarted: the daemon there is new and holds nothing. The connection drops and the
    // same link redials, into the new daemon.
    const restarted = makeHelperRig(1, { homeDirectory: process.cwd() });
    teardown.push(() => restarted.helper.dispose());
    rig.target.current = restarted;
    rig.helperRig.linkStreams[0].destroy();
    await settle(1_000);

    expect(rig.events).toContainEqual({ type: 'remoteSessions', hostId: 'host-a', lost: ['remote-1'], adoptable: [] });
    expect(rig.events.some((event) => event.type === 'exit')).toBe(false);
  });

  it('reports a live session on the host that the app holds no row for as adoptable', async () => {
    const rig = makeRig();
    await addHost(rig);
    const spawning = rig.router.handleRequest('spawn', fullSpawn('remote-1', 11, 'host-a'));
    await settle();
    await spawning;

    // The app restarted: a new router (a new boot) reconnects to the same daemon, which still runs the agent.
    const reborn = makeRig(rig.helperRig);
    await addHost(reborn);

    const adoptable = reborn.events.find((event) => event.type === 'remoteSessions' && event.adoptable.length > 0);
    expect(adoptable).toMatchObject({ hostId: 'host-a', lost: [] });
    expect(adoptable?.type === 'remoteSessions' && adoptable.adoptable.map((record) => record.sessionId)).toEqual(['remote-1']);
  });
});

describe('quitting', () => {
  it('sends each host its one plan and keeps the host process up until the link let go', async () => {
    const rig = makeRig();
    await addHost(rig);
    const spawning = rig.router.handleRequest('spawn', fullSpawn('remote-1', 11, 'host-a'));
    await settle();
    await spawning;

    rig.router.handleCommand({
      type: 'remoteQuitPlan',
      hostId: 'host-a',
      sessions: [{ sessionId: 'remote-1', exitSequence: ['\x03'], consoleCloseIsGraceful: false }],
    });
    rig.router.beginShutdown(1_300);

    expect(rig.core.handleCommand).toHaveBeenCalledWith({ type: 'shutdown' });
    expect(rig.router.liveChildCount).toBeGreaterThan(0);

    await settle(2_000);

    expect(rig.helperRig.fakes[0].write).toHaveBeenCalledWith('\x03');
    expect(rig.router.liveChildCount).toBe(0);
  });

  it('counts the core\'s PTYs too, so the host process waits for either', async () => {
    const rig = makeRig();
    rig.core.liveChildCount = 2;
    expect(rig.router.liveChildCount).toBe(2);
  });
});
