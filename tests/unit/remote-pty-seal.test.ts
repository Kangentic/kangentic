/**
 * `RemotePty.sealUserInput()`: the command every main-side teardown posts
 * before it drops a session's PTY handle.
 *
 * A renderer's keystrokes reach the pty host on the renderer's own port, not
 * through main, so only this command (posted over main's ordered channel to the
 * host) tells the host to stop writing them into an agent that is exiting.
 * `tests/unit/terminal-input-path.test.ts` scans for the call site; this file
 * pins what the call does: the command's shape, that it names the PTY's own
 * id, and that it is silent once the PTY has exited.
 *
 * The exit is driven the way `PtyHostClient` drives it: an `exit` event from
 * the host, or the host being lost. Both end in `RemotePty.markExited()`.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { PtyHostClient, RemotePty, type PtyHostLifecycleListener, type PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostCommand, PtyHostEvent, PtyHostSpawnParams, PtyHostSpawnResult } from '../../src/main/pty/host/protocol';

interface FakeTransport {
  transport: PtyHostTransport;
  /** Every command the client or a handle posted, in order. */
  post: Mock<(command: PtyHostCommand) => void>;
  /** Deliver an event as the host would. */
  emitEvent(event: PtyHostEvent): void;
  /** Report the host as down, as the utility transport does when it dies. */
  hostDown(): void;
}

function makeFakeTransport(): FakeTransport {
  const post = vi.fn<(command: PtyHostCommand) => void>();
  const listeners: { event: ((event: PtyHostEvent) => void) | null; lifecycle: PtyHostLifecycleListener | null } = {
    event: null,
    lifecycle: null,
  };
  let nextPid = 4000;
  const request = vi.fn(async (method: string): Promise<PtyHostSpawnResult> => {
    if (method !== 'spawn') throw new Error(`unexpected request: ${method}`);
    nextPid += 1;
    return { ok: true, pid: nextPid };
  });
  const transport: PtyHostTransport = {
    post,
    attachRendererPort: vi.fn(),
    request: request as unknown as PtyHostTransport['request'],
    setEventListener: (listener) => {
      listeners.event = listener;
    },
    setLifecycleListener: (listener) => {
      listeners.lifecycle = listener;
    },
    hostPid: null,
    shutdown: vi.fn(),
  };
  return {
    transport,
    post,
    emitEvent: (event) => listeners.event?.(event),
    hostDown: () => listeners.lifecycle?.onHostDown(),
  };
}

function spawnParams(sessionId: string): Omit<PtyHostSpawnParams, 'ptyId'> {
  return {
    sessionId,
    projectId: 'project-1',
    agentName: null,
    transient: false,
    file: 'bash',
    args: [],
    cwd: '/mock/project',
    env: {},
    cols: 80,
    rows: 24,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
  };
}

async function spawnRemotePty(client: PtyHostClient, sessionId: string): Promise<RemotePty> {
  const outcome = await client.spawn(spawnParams(sessionId));
  if (!outcome.ok) throw new Error(`spawn of ${sessionId} failed: ${outcome.error.message}`);
  return outcome.pty;
}

describe('RemotePty.sealUserInput', () => {
  it('posts a sealUserInput command carrying its own ptyId, and nothing else', () => {
    const post = vi.fn<(command: PtyHostCommand) => void>();
    const remote = new RemotePty(7, 4242, 80, 24, { post });

    remote.sealUserInput();

    expect(post.mock.calls).toEqual([[{ type: 'sealUserInput', ptyId: 7 }]]);
  });

  it('posts nothing once the PTY is marked exited', () => {
    const post = vi.fn<(command: PtyHostCommand) => void>();
    const remote = new RemotePty(7, 4242, 80, 24, { post });
    remote.markExited();

    remote.sealUserInput();

    expect(post).not.toHaveBeenCalled();
  });

  describe('on a handle the client spawned', () => {
    it('names the ptyId the client assigned to that PTY, not another one it holds', async () => {
      const { transport, post } = makeFakeTransport();
      const client = new PtyHostClient(transport);
      const first = await spawnRemotePty(client, 'session-1');
      const second = await spawnRemotePty(client, 'session-2');
      expect(second.ptyId).not.toBe(first.ptyId);
      post.mockClear();

      second.sealUserInput();

      expect(post.mock.calls).toEqual([[{ type: 'sealUserInput', ptyId: second.ptyId }]]);
    });

    it('posts nothing after the host reports the PTY\'s exit, while a sibling PTY still seals', async () => {
      const { transport, post, emitEvent } = makeFakeTransport();
      const client = new PtyHostClient(transport);
      const exiting = await spawnRemotePty(client, 'session-1');
      const sibling = await spawnRemotePty(client, 'session-2');

      emitEvent({ type: 'exit', ptyId: exiting.ptyId, sessionId: 'session-1', exitCode: 0 });
      expect(exiting.hasExited).toBe(true);
      post.mockClear();

      exiting.sealUserInput();
      expect(post).not.toHaveBeenCalled();

      sibling.sealUserInput();
      expect(post.mock.calls).toEqual([[{ type: 'sealUserInput', ptyId: sibling.ptyId }]]);
    });

    it('posts nothing after the host is lost, which ends every PTY it held', async () => {
      const { transport, post, hostDown } = makeFakeTransport();
      const client = new PtyHostClient(transport);
      const remote = await spawnRemotePty(client, 'session-1');

      hostDown();
      expect(remote.hasExited).toBe(true);
      post.mockClear();

      remote.sealUserInput();

      expect(post).not.toHaveBeenCalled();
    });
  });
});
