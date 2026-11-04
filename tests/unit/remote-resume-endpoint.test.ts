/**
 * The resume layer between the SSH link and the host helper (#913): a connection dies, the
 * two endpoints pick up where each other stopped, and nothing is lost or repeated. Every
 * test runs over in-memory duplex pairs; the real transport is `ssh`'s stdio, exercised by
 * the rig.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { duplexPair, type Duplex } from 'node:stream';
import { ResumeEndpoint, type GapInfo, type ResumeEndpointOptions } from '../../src/main/remote/protocol/resume-endpoint';
import { FrameKind, encodeFrame } from '../../src/main/remote/protocol/frame-codec';

interface Side {
  endpoint: ResumeEndpoint;
  messages: Array<{ json: unknown; raw: string }>;
  detached: string[];
  gaps: GapInfo[];
  attachedCount: number;
}

const sides: Side[] = [];

function makeSide(role: 'link' | 'helper', overrides: Partial<ResumeEndpointOptions> & { vet?: (identity: Record<string, string | number>) => string | null } = {}): Side {
  const { vet, ...options } = overrides;
  const side: Side = { endpoint: undefined as unknown as ResumeEndpoint, messages: [], detached: [], gaps: [], attachedCount: 0 };
  side.endpoint = new ResumeEndpoint(
    {
      onMessage: (json, raw) => side.messages.push({ json, raw: raw.toString('latin1') }),
      onAttached: () => { side.attachedCount += 1; },
      onDetached: (reason) => side.detached.push(reason),
      onGap: (info) => side.gaps.push(info),
      vetPeer: vet ? (peer) => vet(peer.identity) : undefined,
    },
    { role, protocol: { min: 1, max: 1 }, identity: { name: role }, ...options },
  );
  sides.push(side);
  return side;
}

function connect(first: Side, second: Side): [Duplex, Duplex] {
  const [firstStream, secondStream] = duplexPair();
  // duplexPair leaves the far end open when one end is destroyed, which a socket or a pipe would not.
  firstStream.on('close', () => secondStream.destroy());
  secondStream.on('close', () => firstStream.destroy());
  first.endpoint.attach(firstStream);
  second.endpoint.attach(secondStream);
  return [firstStream, secondStream];
}

/** A link between two sides through a pipe that can swallow the next bytes going from first to second. */
function lossyConnect(first: Side, second: Side): { dropNext(count: number): void; streams: [Duplex, Duplex] } {
  const [firstOuter, firstInner] = duplexPair();
  const [secondOuter, secondInner] = duplexPair();
  let toDrop = 0;
  firstInner.on('data', (chunk: Buffer) => {
    let kept = chunk;
    if (toDrop > 0) {
      const cut = Math.min(toDrop, kept.length);
      kept = kept.subarray(cut);
      toDrop -= cut;
    }
    if (kept.length > 0) secondInner.write(kept);
  });
  secondInner.on('data', (chunk: Buffer) => firstInner.write(chunk));
  firstInner.on('close', () => secondInner.destroy());
  secondInner.on('close', () => firstInner.destroy());
  first.endpoint.attach(firstOuter);
  second.endpoint.attach(secondOuter);
  return { dropNext: (count) => { toDrop = count; }, streams: [firstOuter, secondOuter] };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

const indexes = (side: Side): number[] => side.messages.map((message) => (message.json as { n: number }).n);

afterEach(() => {
  vi.useRealTimers();
  for (const side of sides.splice(0)) side.endpoint.detach('test over');
});

describe('delivery', () => {
  it('delivers messages both ways in order, with the raw bytes intact', async () => {
    const link = makeSide('link');
    const helper = makeSide('helper');
    connect(link, helper);
    await settle();
    link.endpoint.send({ n: 1 }, Buffer.from([0, 255, 10, 13]));
    link.endpoint.send({ n: 2 });
    helper.endpoint.send({ n: 3 }, Buffer.from('output'));
    await settle();
    expect(indexes(helper)).toEqual([1, 2]);
    expect(Buffer.from(helper.messages[0].raw, 'latin1')).toEqual(Buffer.from([0, 255, 10, 13]));
    expect(indexes(link)).toEqual([3]);
    expect(link.messages[0].raw).toBe('output');
    expect(link.attachedCount).toBe(1);
    expect(helper.attachedCount).toBe(1);
  });

  it('holds what is sent before a connection exists and delivers it once one is up', async () => {
    const link = makeSide('link');
    const helper = makeSide('helper');
    link.endpoint.send({ n: 1 });
    link.endpoint.send({ n: 2 });
    connect(link, helper);
    await settle();
    expect(indexes(helper)).toEqual([1, 2]);
  });

  it('frees what the peer has acknowledged', async () => {
    const link = makeSide('link');
    const helper = makeSide('helper', { ackEveryBytes: 1 });
    connect(link, helper);
    await settle();
    for (let n = 0; n < 5; n += 1) link.endpoint.send({ n }, Buffer.alloc(100, 1));
    await settle();
    expect(link.endpoint.stats.retainedFrames).toBe(0);
    expect(link.endpoint.stats.retainedBytes).toBe(0);
  });
});

describe('resuming', () => {
  it('picks up after a dead connection with nothing lost or repeated, both ways', async () => {
    const link = makeSide('link');
    const helper = makeSide('helper');
    const [linkStream] = connect(link, helper);
    await settle();
    for (let n = 0; n < 5; n += 1) link.endpoint.send({ n });
    await settle();
    linkStream.destroy();
    await settle();
    expect(link.detached).toHaveLength(1);
    expect(helper.detached).toHaveLength(1);
    for (let n = 5; n < 10; n += 1) link.endpoint.send({ n });
    for (let n = 100; n < 103; n += 1) helper.endpoint.send({ n });
    connect(link, helper);
    await settle();
    expect(indexes(helper)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(indexes(link)).toEqual([100, 101, 102]);
    expect(link.gaps).toEqual([]);
    expect(helper.gaps).toEqual([]);
  });

  it('replays frames that were in flight, and lost, when the connection died', async () => {
    const link = makeSide('link');
    const helper = makeSide('helper');
    const lossy = lossyConnect(link, helper);
    await settle();
    lossy.dropNext(1_000_000);
    for (let n = 0; n < 4; n += 1) link.endpoint.send({ n }, Buffer.alloc(300, n));
    await settle();
    expect(helper.messages).toHaveLength(0);
    lossy.streams[0].destroy();
    await settle();
    connect(link, helper);
    await settle();
    expect(indexes(helper)).toEqual([0, 1, 2, 3]);
  });

  it('ends a connection whose bytes were damaged in the middle, then resumes cleanly', async () => {
    const link = makeSide('link');
    const helper = makeSide('helper');
    const lossy = lossyConnect(link, helper);
    await settle();
    for (let n = 0; n < 6; n += 1) link.endpoint.send({ n }, Buffer.alloc(5000, n));
    await settle();
    lossy.dropNext(40);
    for (let n = 6; n < 20; n += 1) link.endpoint.send({ n }, Buffer.alloc(5000, n));
    await settle();
    expect(helper.detached.some((reason) => reason.includes('damaged'))).toBe(true);
    connect(link, helper);
    await settle();
    expect(indexes(helper)).toEqual(Array.from({ length: 20 }, (_, n) => n));
    for (const message of helper.messages) {
      const n = (message.json as { n: number }).n;
      expect(message.raw).toBe(String.fromCharCode(n).repeat(5000));
    }
  });
});

describe('what cannot be replayed', () => {
  it('turns a resume past the retention limit into a reset the peer reports as a gap', async () => {
    const link = makeSide('link', { retainLimitBytes: 3000 });
    const helper = makeSide('helper');
    const [linkStream] = connect(link, helper);
    await settle();
    link.endpoint.send({ n: 0 }, Buffer.alloc(900, 0));
    await settle();
    linkStream.destroy();
    await settle();
    for (let n = 1; n <= 8; n += 1) link.endpoint.send({ n }, Buffer.alloc(900, n));
    connect(link, helper);
    await settle();
    expect(helper.gaps).toHaveLength(1);
    expect(helper.gaps[0]).toMatchObject({ direction: 'incoming', cause: 'retention' });
    expect(helper.gaps[0].lostTo).toBeGreaterThan(helper.gaps[0].lostFrom);
    expect(link.gaps[0]).toMatchObject({ direction: 'outgoing', cause: 'retention' });
    const received = indexes(helper);
    expect(received[0]).toBe(0);
    expect(received.slice(1)).toEqual(received.slice(1).slice().sort((first, second) => first - second));
    expect(received.at(-1)).toBe(8);
    link.endpoint.send({ n: 9 });
    await settle();
    expect(indexes(helper).at(-1)).toBe(9);
  });

  it('tells a peer that remembers more than this side ever sent where the stream is now', async () => {
    const helper = makeSide('helper');
    const link = makeSide('link');
    connect(link, helper);
    await settle();
    for (let n = 0; n < 3; n += 1) helper.endpoint.send({ n }, Buffer.alloc(200));
    await settle();
    link.endpoint.detach();
    await settle();
    const restartedHelper = makeSide('helper');
    connect(link, restartedHelper);
    await settle();
    expect(link.gaps).toHaveLength(1);
    expect(link.gaps[0]).toMatchObject({ direction: 'incoming', cause: 'peer-ahead' });
    restartedHelper.endpoint.send({ n: 50 });
    await settle();
    expect(indexes(link).at(-1)).toBe(50);
  });
});

describe('refusal', () => {
  it('refuses a peer with no protocol version in common and tells it why', async () => {
    const link = makeSide('link', { protocol: { min: 3, max: 4 } });
    const helper = makeSide('helper', { protocol: { min: 1, max: 2 } });
    connect(link, helper);
    await settle();
    expect(link.attachedCount + helper.attachedCount).toBe(0);
    expect([...link.detached, ...helper.detached].join(' ')).toContain('no protocol version in common');
  });

  it('lets the owner turn a peer away, and the peer hears the reason', async () => {
    const link = makeSide('link');
    const helper = makeSide('helper', { vet: () => 'another installation owns this host' });
    connect(link, helper);
    await settle();
    expect(helper.attachedCount).toBe(0);
    expect(link.detached.join(' ')).toContain('another installation owns this host');
  });

  it('leaves the owner connected when a stranger is turned away', async () => {
    const owner = makeSide('link', { identity: { name: 'owner' } });
    const helper = makeSide('helper', { vet: (identity) => (identity.name === 'owner' ? null : 'another installation owns this host') });
    connect(owner, helper);
    await settle();
    const stranger = makeSide('link', { identity: { name: 'stranger' } });
    connect(stranger, helper);
    await settle();
    expect(stranger.detached.join(' ')).toContain('another installation owns this host');
    expect(helper.endpoint.connected).toBe(true);
    expect(helper.detached).not.toContainEqual(expect.stringContaining('replaced'));
    helper.endpoint.send({ n: 7 });
    await settle();
    expect(indexes(owner)).toEqual([7]);
    expect(stranger.messages).toEqual([]);
  });

  it('replaces an attached connection when a newer one arrives', async () => {
    const link = makeSide('link');
    const helper = makeSide('helper');
    connect(link, helper);
    await settle();
    connect(link, helper);
    await settle();
    expect(link.detached.some((reason) => reason.includes('replaced'))).toBe(true);
    link.endpoint.send({ n: 1 });
    await settle();
    expect(indexes(helper)).toEqual([1]);
  });
});

describe('liveness', () => {
  it('drops a connection the peer has gone silent on', async () => {
    vi.useFakeTimers();
    const link = makeSide('link', { deadAfterMs: 4_000, heartbeatMs: 1_000 });
    const [stream] = duplexPair();
    link.endpoint.attach(stream);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(link.detached.some((reason) => reason.includes('no frame from the peer'))).toBe(true);
  });

  it('keeps a quiet connection alive with heartbeats', async () => {
    vi.useFakeTimers();
    const link = makeSide('link', { deadAfterMs: 4_000, heartbeatMs: 1_000 });
    const helper = makeSide('helper', { deadAfterMs: 4_000, heartbeatMs: 1_000 });
    connect(link, helper);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.detached).toEqual([]);
    expect(helper.detached).toEqual([]);
    expect(link.endpoint.connected).toBe(true);
  });

  it('drops a connection whose send queue stopped draining, keeping what was sent for the next one', async () => {
    const link = makeSide('link', { maxWritableBytes: 100_000 });
    const helper = makeSide('helper');
    const [, helperStream] = connect(link, helper);
    await settle();
    helperStream.pause();
    for (let n = 0; n < 12; n += 1) link.endpoint.send({ n }, Buffer.alloc(100_000, n));
    expect(link.detached.some((reason) => reason.includes('send queue'))).toBe(true);
    expect(link.endpoint.stats.retainedFrames).toBeGreaterThan(0);
  });

  it('does not drop a connection onto which it replays a buffer near the retention limit, under default options', async () => {
    const link = makeSide('link');
    const helper = makeSide('helper');
    // Seven 1 MB frames, below the 8 MB default retention limit, written all at once on attach.
    for (let n = 0; n < 7; n += 1) link.endpoint.send({ n }, Buffer.alloc(1024 * 1024, n));
    const [, helperStream] = connect(link, helper);
    helperStream.pause();
    await settle();
    expect(link.endpoint.connected).toBe(true);
    expect(link.detached).toEqual([]);
    helperStream.resume();
    await settle();
    expect(indexes(helper)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('a scripted peer', () => {
  function scriptedPeer(): { endpointSide: Duplex; peerSide: Duplex } {
    const [endpointSide, peerSide] = duplexPair();
    peerSide.on('data', () => undefined);
    return { endpointSide, peerSide };
  }

  const helloFrame = (offset: number) => encodeFrame({
    kind: FrameKind.hello,
    offset,
    json: { protocol: { min: 1, max: 1 }, role: 'helper', identity: { name: 'peer' } },
  });

  it('takes a replayed message once when the old connection delivered it before the new handshake finished', async () => {
    const received: unknown[] = [];
    const endpoint = new ResumeEndpoint(
      { onMessage: (json) => received.push(json), onAttached: () => undefined, onDetached: () => undefined, onGap: () => undefined },
      { role: 'link', protocol: { min: 1, max: 1 }, identity: { name: 'link' } },
    );
    sides.push({ endpoint, messages: [], detached: [], gaps: [], attachedCount: 0 });
    const first = scriptedPeer();
    endpoint.attach(first.endpointSide);
    first.peerSide.write(helloFrame(0));
    await settle();
    expect(endpoint.connected).toBe(true);

    // B attaches while A is live. Its hello names the offset the endpoint expects at that moment: 0.
    const second = scriptedPeer();
    endpoint.attach(second.endpointSide);
    const message = encodeFrame({ kind: FrameKind.message, offset: 0, json: { n: 1 } });
    first.peerSide.write(message);
    await settle();
    expect(received).toEqual([{ n: 1 }]);
    const offsetAfterDelivery = endpoint.stats.receiveOffset;
    expect(offsetAfterDelivery).toBe(message.length);

    // The peer completes B's handshake and replays from the offset B's hello named.
    second.peerSide.write(helloFrame(0));
    second.peerSide.write(message);
    await settle();
    expect(received).toEqual([{ n: 1 }]);
    expect(endpoint.stats.receiveOffset).toBe(offsetAfterDelivery);
  });
});

describe('handlers that throw', () => {
  function makeThrowing(handlers: Partial<ConstructorParameters<typeof ResumeEndpoint>[0]>) {
    const errors: unknown[] = [];
    const detached: string[] = [];
    let attached = 0;
    const endpoint = new ResumeEndpoint(
      {
        onMessage: () => undefined,
        onAttached: () => { attached += 1; },
        onDetached: (reason) => detached.push(reason),
        onGap: () => undefined,
        onError: (error) => errors.push(error),
        ...handlers,
      },
      { role: 'helper', protocol: { min: 1, max: 1 }, identity: { name: 'helper' }, retainLimitBytes: 3000 },
    );
    sides.push({ endpoint, messages: [], detached: [], gaps: [], attachedCount: 0 });
    return { endpoint, errors, detached, attachedCount: () => attached };
  }

  it('refuses a peer when vetPeer throws, and reports the error', async () => {
    const boom = new Error('vet exploded');
    const rig = makeThrowing({ vetPeer: () => { throw boom; } });
    const link = makeSide('link');
    connect(link, { endpoint: rig.endpoint } as Side);
    await settle();
    expect(rig.errors).toContain(boom);
    expect(rig.attachedCount()).toBe(0);
    expect(rig.endpoint.connected).toBe(false);
    expect(link.detached.join(' ')).toContain('could not check the peer');
  });

  it('survives a throwing onAttached and reports it', async () => {
    const boom = new Error('attached exploded');
    const rig = makeThrowing({ onAttached: () => { throw boom; } });
    const link = makeSide('link');
    connect(link, { endpoint: rig.endpoint } as Side);
    await settle();
    expect(rig.errors).toContain(boom);
    expect(rig.endpoint.connected).toBe(true);
    link.endpoint.send({ n: 1 });
    await settle();
    expect(rig.endpoint.stats.receiveOffset).toBeGreaterThan(0);
  });

  it('survives a throwing onGap and reports it', async () => {
    const boom = new Error('gap exploded');
    const rig = makeThrowing({ onGap: () => { throw boom; } });
    const link = makeSide('link');
    // The helper endpoint has sent more than it retains, so the link asking to resume from 0 is a gap.
    for (let n = 0; n < 8; n += 1) rig.endpoint.send({ n }, Buffer.alloc(900, n));
    connect(link, { endpoint: rig.endpoint } as Side);
    await settle();
    expect(rig.errors).toContain(boom);
    expect(rig.endpoint.connected).toBe(true);
  });
});
