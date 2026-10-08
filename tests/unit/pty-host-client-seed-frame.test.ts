/**
 * The phone's seed frame can be taken at a shorter history depth when the full
 * one does not fit the wire. The depth only reaches the pty host if
 * `PtyHostClient.getSeedFrame` puts `scrollbackLines` into the request it sends,
 * and the host core's own tests bypass the client, so nothing else pins it.
 *
 * Red-green: drop `scrollbackLines` from the `getSeedFrame` request in
 * `PtyHostClient` and the first two tests fail.
 */

import { describe, expect, it, vi } from 'vitest';
import { PtyHostClient } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { SeedFrameResult } from '../../src/main/pty/host/protocol';

const seedResult: SeedFrameResult = { frame: 'GRID', barrierOffset: 42, settleMs: 5, serializeMs: 2 };

function fakeTransport() {
  const request = vi.fn(async () => seedResult);
  const transport: PtyHostTransport = {
    post: () => undefined,
    request: request as unknown as PtyHostTransport['request'],
    setEventListener: () => undefined,
    hostPid: 1234,
    shutdown: () => undefined,
  };
  return { client: new PtyHostClient(transport), request };
}

describe('PtyHostClient.getSeedFrame', () => {
  it('forwards a history depth of 0 (the grid alone) in the request, and returns the host result', async () => {
    const { client, request } = fakeTransport();

    const result = await client.getSeedFrame('sess-1', true, 0);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('getSeedFrame', { sessionId: 'sess-1', settle: true, scrollbackLines: 0 });
    expect(result).toEqual(seedResult);
  });

  it('forwards a positive history depth unchanged', async () => {
    const { client, request } = fakeTransport();

    await client.getSeedFrame('sess-1', false, 320);

    expect(request).toHaveBeenCalledWith('getSeedFrame', { sessionId: 'sess-1', settle: false, scrollbackLines: 320 });
  });

  it('leaves the depth undefined when none is given, so the host uses its default depth', async () => {
    const { client, request } = fakeTransport();

    await client.getSeedFrame('sess-1', true);

    const [, params] = request.mock.calls[0] as unknown as [string, { scrollbackLines?: number }];
    expect(params.scrollbackLines).toBeUndefined();
  });
});
