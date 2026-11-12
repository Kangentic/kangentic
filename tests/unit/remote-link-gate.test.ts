/**
 * The Phase 1 gate for #913: a PTY runs in the helper, the link survives the connection
 * dying, and what the drop lost is rebuilt. The real `PtyHostClient` sits on a `RemoteLink`,
 * which dials a real `HelperServer` around the real, unchanged `PtyHostCore` over in-memory
 * duplex pairs, with a fake node-pty. The same path over a real `ssh` is the rig's gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Duplex } from 'node:stream';
import type * as nodePty from 'node-pty';
import { HelperServer } from '../../src/main/remote/helper/helper-server';
import { RemoteLink, type RemoteLinkState } from '../../src/main/remote/link/remote-link';
import { PtyHostClient } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostEvent } from '../../src/main/pty/host/protocol';
import { createFakeRendererPort, receivedOutput, type FakeRendererPort } from './helpers/fake-renderer-port';
import { createFakePty, dialHelper as dial, spawnParams, type FakePty } from './helpers/remote-link-rig';

const IDENTITY = { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' };
const FAST_RECONNECT = { initialDelayMs: 100, maxDelayMs: 400 };

interface Rig {
  helper: HelperServer;
  link: RemoteLink;
  client: PtyHostClient;
  renderer: FakeRendererPort;
  fakes: FakePty[];
  linkStreams: Duplex[];
  states: Array<{ state: RemoteLinkState; detail: string | null }>;
  events: PtyHostEvent[];
  lost: string[][];
  adoptable: string[][];
}

const teardown: Array<() => void> = [];

function makeHelper(fakes: FakePty[], endpoint?: ConstructorParameters<typeof HelperServer>[0]['endpoint']): HelperServer {
  const helper = new HelperServer({
    coreDeps: {
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      platform: 'linux',
      spawnPty: vi.fn(() => {
        const next = fakes.shift();
        if (!next) throw new Error('no fake PTY queued');
        return next.pty;
      }) as unknown as typeof nodePty.spawn,
    },
    endpoint,
  });
  teardown.push(() => helper.dispose());
  return helper;
}

function makeRig(options: { fakeCount?: number; helperEndpoint?: ConstructorParameters<typeof HelperServer>[0]['endpoint'] } = {}): Rig {
  const fakes = Array.from({ length: options.fakeCount ?? 1 }, (_, index) => createFakePty(4242 + index));
  const rig = {
    helper: makeHelper(fakes, options.helperEndpoint),
    fakes: [...fakes],
    linkStreams: [] as Duplex[],
    states: [] as Rig['states'],
    events: [] as PtyHostEvent[],
    lost: [] as string[][],
    adoptable: [] as string[][],
  } as Rig;
  rig.link = new RemoteLink({ identity: IDENTITY, connect: async () => dial(rig), reconnect: FAST_RECONNECT });
  rig.link.setHandlers({
    onStateChanged: (state, detail) => rig.states.push({ state, detail }),
    onSessionsLost: (ids) => rig.lost.push(ids),
    onAdoptable: (records) => rig.adoptable.push(records.map((record) => record.sessionId)),
  });
  rig.client = new PtyHostClient(rig.link);
  rig.client.setEventHandler((event) => rig.events.push(event));
  rig.renderer = createFakeRendererPort();
  rig.link.attachRendererPort(1, rig.renderer.port);
  teardown.push(() => rig.link.stop());
  return rig;
}

async function settle(milliseconds = 60): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

async function spawnSession(rig: Rig, sessionId: string, taskId: string) {
  const spawning = rig.client.spawn(spawnParams(sessionId, taskId));
  await settle();
  const outcome = await spawning;
  if (!outcome.ok) throw outcome.error;
  return outcome.pty;
}

const outputOf = (rig: Rig, sessionId: string): string =>
  receivedOutput(rig.renderer).filter((entry) => entry.sessionId === sessionId).map((entry) => entry.data).join('');

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  vi.useRealTimers();
});

describe('a PTY in the helper, through the link', () => {
  it('spawns, shows output on the renderer, and survives the connection dying', async () => {
    const rig = makeRig();
    rig.link.start();
    await settle();
    expect(rig.link.state).toBe('connected');
    rig.client.post({ type: 'setRendererFocus', rendererId: 1, sessionIds: ['s1'] });

    const exits: number[] = [];
    const pty = await spawnSession(rig, 's1', 'task-1');
    rig.client.onPtyExit(pty.ptyId, (exitCode) => exits.push(exitCode));
    expect(pty.pid).toBe(4242);
    rig.fakes[0].feed('hello');
    await settle();
    expect(outputOf(rig, 's1')).toBe('hello');

    // The connection dies. The agent does not.
    rig.linkStreams.at(-1)?.destroy();
    await settle(10);
    expect(rig.link.state).toBe('reconnecting');
    expect(rig.helper.liveSessionCount).toBe(1);
    expect(rig.fakes[0].kill).not.toHaveBeenCalled();
    rig.fakes[0].feed(' while down');

    // The link redials. Output from the gap is still on the host, in the core's ring.
    await settle(400);
    expect(rig.link.state).toBe('connected');
    expect(exits).toEqual([]);
    const scrollback = rig.client.getScrollback('s1', false);
    await settle();
    expect(await scrollback).toContain('hello while down');
    expect(rig.helper.snapshot().ownerEpoch).toBe(2);
  });

  it('delivers an exit that happened while the connection was down, once', async () => {
    const rig = makeRig();
    rig.link.start();
    await settle();
    const pty = await spawnSession(rig, 's1', 'task-1');
    const exits: number[] = [];
    rig.client.onPtyExit(pty.ptyId, (exitCode) => exits.push(exitCode));

    rig.linkStreams.at(-1)?.destroy();
    await settle(10);
    rig.fakes[0].exit(7);
    await settle(400);
    expect(rig.link.state).toBe('connected');
    expect(exits).toEqual([7]);
    await settle(2000);
    expect(exits).toEqual([7]);
  });

  it('rebuilds an exit the stream itself lost, from the helper\'s snapshot', async () => {
    // A retention limit of one frame: while the link is away, newer events push the exit out.
    const rig = makeRig({ fakeCount: 2, helperEndpoint: { retainLimitBytes: 1 } });
    rig.link.start();
    await settle();
    const first = await spawnSession(rig, 's1', 'task-1');
    await spawnSession(rig, 's2', 'task-2');
    const exits: number[] = [];
    rig.client.onPtyExit(first.ptyId, (exitCode) => exits.push(exitCode));

    rig.linkStreams.at(-1)?.destroy();
    await settle(10);
    rig.fakes[0].exit(3);
    for (let chunk = 0; chunk < 5; chunk += 1) rig.fakes[1].feed(`more ${chunk}`);
    await settle(400);
    expect(rig.link.state).toBe('connected');
    expect(exits).toEqual([3]);
  });

  it('reports sessions lost when the helper it comes back to holds nothing', async () => {
    const rig = makeRig();
    rig.link.start();
    await settle();
    await spawnSession(rig, 's1', 'task-1');

    rig.linkStreams.at(-1)?.destroy();
    await settle(10);
    rig.helper = makeHelper([]);
    await settle(400);
    expect(rig.link.state).toBe('connected');
    expect(rig.lost).toEqual([['s1']]);
  });

  it('refuses a second spawn for a task that already has a live PTY', async () => {
    const rig = makeRig({ fakeCount: 2 });
    rig.link.start();
    await settle();
    await spawnSession(rig, 's1', 'task-1');
    const second = rig.client.spawn(spawnParams('s2', 'task-1'));
    await settle();
    const outcome = await second;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.message).toContain('already has a live PTY');
  });
});

describe('quit', () => {
  it('lets go and ends nothing: the agent is not hung up, typed into or killed, and keeps running on the host', async () => {
    const rig = makeRig();
    rig.link.start();
    await settle();
    await spawnSession(rig, 's1', 'task-1');

    rig.link.shutdown();
    await settle(2_000);

    expect(rig.fakes[0].kill).not.toHaveBeenCalled();
    expect(rig.fakes[0].write).not.toHaveBeenCalled();
    expect(rig.link.state).toBe('stopped');
  });

  it('ignores a suspend from an earlier owner epoch', async () => {
    const rig = makeRig();
    rig.link.start();
    await settle();
    await spawnSession(rig, 's1', 'task-1');

    const answer = rig.link.requestHelper('suspendAll', { ownerEpoch: 99, sessions: [{ sessionId: 's1', consoleCloseIsGraceful: true }] });
    await settle();
    expect(await answer).toEqual({ suspended: 0, ignored: true });
    expect(rig.fakes[0].kill).not.toHaveBeenCalled();
  });

  it('lets go of the connection after a bounded wait when the helper never answers', async () => {
    const rig = makeRig();
    rig.link.start();
    await settle();
    rig.linkStreams.at(-1)?.destroy();
    await settle(10);

    rig.link.shutdown(500);
    await settle(600);
    expect(rig.link.state).toBe('stopped');
  });
});

describe('who owns the helper', () => {
  it('turns another installation away and leaves the owner connected', async () => {
    const owner = makeRig();
    owner.link.start();
    await settle();
    await spawnSession(owner, 's1', 'task-1');

    const strangerStates: Array<string | null> = [];
    const stranger = new RemoteLink({
      identity: { installId: 'install-b', bootId: 'boot-9', label: 'another computer' },
      connect: async () => dial(owner),
      reconnect: FAST_RECONNECT,
    });
    stranger.setHandlers({ onStateChanged: (_state, detail) => strangerStates.push(detail) });
    teardown.push(() => stranger.stop());
    stranger.start();
    await settle(300);

    expect(strangerStates.join(' ')).toContain('in use by another Kangentic installation (a test computer)');
    expect(stranger.state).not.toBe('connected');
    expect(owner.link.state).toBe('connected');
    expect(owner.helper.liveSessionCount).toBe(1);
  });

  it('lets the same installation take over after a restart, and reports what it left running', async () => {
    const first = makeRig();
    first.link.start();
    await settle();
    await spawnSession(first, 's1', 'task-1');
    // The old process is gone. Two live processes of one installation would only take the host back and forth.
    first.link.stop();
    await settle(10);

    const restarted = new RemoteLink({
      identity: { ...IDENTITY, bootId: 'boot-2' },
      connect: async () => dial(first),
      reconnect: FAST_RECONNECT,
    });
    const adoptable: string[][] = [];
    restarted.setHandlers({ onAdoptable: (records) => adoptable.push(records.map((record) => record.sessionId)) });
    teardown.push(() => restarted.stop());
    restarted.start();
    await settle(300);

    expect(restarted.state).toBe('connected');
    expect(adoptable).toEqual([['s1']]);
    expect(first.helper.liveSessionCount).toBe(1);
  });
});
