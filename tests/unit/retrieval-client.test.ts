import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * RetrievalClient lifecycle: the init handshake, calls queued behind `ready`,
 * replies and worker errors, a timed-out call killing a stuck worker, an exit
 * failing every pending call, the respawn event, and a synchronous dispose.
 * 'electron' is mocked with a fork that returns a controllable child, as in
 * line-count-client.test.ts.
 */

const { mockFork } = vi.hoisted(() => ({ mockFork: vi.fn() }));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: mockFork },
}));

import { RetrievalClient, RetrievalUnavailableError, INTERACTIVE_TIMEOUT_MS, READY_TIMEOUT_MS } from '../../src/main/retrieval/retrieval-client';
import { UtilityRestartPolicy } from '../../src/main/utility-process/restart-policy';

interface FakeChild extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

const forkedChildren: FakeChild[] = [];

function lastChild(): FakeChild {
  return forkedChildren[forkedChildren.length - 1];
}

/** The messages a child was sent, by type. */
function sent(child: FakeChild, type: string): Array<Record<string, unknown>> {
  return child.postMessage.mock.calls.map((call) => call[0] as Record<string, unknown>).filter((message) => message.type === type);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Enough microtask turns for a chain of awaits to run to its end, with no timer advanced. */
async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('RetrievalClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forkedChildren.length = 0;
    mockFork.mockImplementation(() => {
      const child = new EventEmitter() as FakeChild;
      child.postMessage = vi.fn();
      child.kill = vi.fn();
      forkedChildren.push(child);
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends init with the projects directory, and holds a call until the worker is ready', async () => {
    const client = new RetrievalClient();
    const call = client.call('projects.summaries', { projectIds: ['project-1'] });
    const child = lastChild();

    expect(sent(child, 'init')).toEqual([expect.objectContaining({ projectsDir: expect.any(String) })]);
    await flush();
    expect(sent(child, 'request')).toEqual([]);

    child.emit('message', { type: 'ready' });
    await flush();
    const [request] = sent(child, 'request');
    expect(request).toMatchObject({ method: 'projects.summaries', params: { projectIds: ['project-1'] } });

    const rows = [{ projectId: 'project-1', conversations: 3, taskRecords: 1, lastIndexedAt: null }];
    child.emit('message', { type: 'reply', id: request.id, ok: true, result: rows });
    await expect(call).resolves.toEqual(rows);
    client.dispose();
  });

  it('rejects with the worker\'s own error when its handler threw', async () => {
    const client = new RetrievalClient();
    const call = client.call('projects.summaries', { projectIds: [] });
    const child = lastChild();
    child.emit('message', { type: 'ready' });
    await flush();
    const [request] = sent(child, 'request');
    child.emit('message', { type: 'reply', id: request.id, ok: false, error: 'no such table: memory_chunks' });
    await expect(call).rejects.toThrow('no such table: memory_chunks');
    client.dispose();
  });

  it('kills a worker that does not answer in time, and counts it as a crash', async () => {
    vi.useFakeTimers();
    const policy = new UtilityRestartPolicy({ service: 'test-retrieval', maxCrashes: 3 });
    const recordCrash = vi.spyOn(policy, 'recordCrash');
    const client = new RetrievalClient(policy);
    const call = client.call('projects.summaries', { projectIds: [] });
    const child = lastChild();
    child.emit('message', { type: 'ready' });
    await flush();

    vi.advanceTimersByTime(INTERACTIVE_TIMEOUT_MS);
    await expect(call).rejects.toBeInstanceOf(RetrievalUnavailableError);
    expect(child.kill).toHaveBeenCalled();

    child.emit('exit', 1);
    expect(recordCrash).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('gives a background job no budget', async () => {
    vi.useFakeTimers();
    const client = new RetrievalClient();
    const call = client.call('projects.summaries', { projectIds: [] }, { timeoutMs: null });
    const child = lastChild();
    child.emit('message', { type: 'ready' });
    await flush();
    vi.advanceTimersByTime(10 * INTERACTIVE_TIMEOUT_MS);
    expect(child.kill).not.toHaveBeenCalled();
    const [request] = sent(child, 'request');
    child.emit('message', { type: 'reply', id: request.id, ok: true, result: [] });
    await expect(call).resolves.toEqual([]);
    client.dispose();
  });

  it('fails every pending call when the worker exits, and announces the next worker', async () => {
    const client = new RetrievalClient(new UtilityRestartPolicy({ service: 'test-retrieval', maxCrashes: 5, backoffMs: [0] }));
    const respawned = vi.fn();
    client.on('respawned', respawned);
    const first = client.call('projects.summaries', { projectIds: [] });
    const firstChild = lastChild();
    firstChild.emit('message', { type: 'ready' });
    await flush();
    expect(respawned).not.toHaveBeenCalled();
    firstChild.emit('exit', 3);
    await expect(first).rejects.toBeInstanceOf(RetrievalUnavailableError);

    const second = client.call('projects.summaries', { projectIds: [] });
    const secondChild = lastChild();
    expect(secondChild).not.toBe(firstChild);
    secondChild.emit('message', { type: 'ready' });
    await flush();
    expect(respawned).toHaveBeenCalledTimes(1);
    const [request] = sent(secondChild, 'request');
    secondChild.emit('message', { type: 'reply', id: request.id, ok: true, result: [] });
    await expect(second).resolves.toEqual([]);
    client.dispose();
  });

  it('latches off after repeated crashes and says why', async () => {
    const client = new RetrievalClient(new UtilityRestartPolicy({ service: 'test-retrieval', maxCrashes: 2, backoffMs: [0] }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const call = client.call('projects.summaries', { projectIds: [] });
      lastChild().emit('exit', 1);
      await expect(call).rejects.toBeInstanceOf(RetrievalUnavailableError);
    }
    await expect(client.call('projects.summaries', { projectIds: [] })).rejects.toBeInstanceOf(RetrievalUnavailableError);
    expect(forkedChildren).toHaveLength(2);
    expect(client.unavailableReason).toMatch(/stopped/);
    client.dispose();
  });

  it('ignores the exit of a worker it already replaced', async () => {
    vi.useFakeTimers();
    const client = new RetrievalClient(new UtilityRestartPolicy({ service: 'test-retrieval', maxCrashes: 5, backoffMs: [0] }));
    const first = client.call('projects.summaries', { projectIds: [] });
    const firstChild = lastChild();
    firstChild.emit('message', { type: 'ready' });
    await flush();
    vi.advanceTimersByTime(INTERACTIVE_TIMEOUT_MS);
    await expect(first).rejects.toBeInstanceOf(RetrievalUnavailableError);
    // The stuck worker's exit is still pending when a new call forks again.
    const second = client.call('projects.summaries', { projectIds: [] });
    const secondChild = lastChild();
    expect(secondChild).not.toBe(firstChild);
    firstChild.emit('exit', 1);
    secondChild.emit('message', { type: 'ready' });
    await flush();
    const [request] = sent(secondChild, 'request');
    secondChild.emit('message', { type: 'reply', id: request.id, ok: true, result: [] });
    await expect(second).resolves.toEqual([]);
    client.dispose();
  });

  it('prints what the worker logged into main\'s log, leaving errors to the dev stderr passthrough', async () => {
    const client = new RetrievalClient();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      void client.call('projects.summaries', { projectIds: [] }).catch(() => undefined);
      lastChild().emit('message', { type: 'log', level: 'log', text: '[knowledge-graph] map rebuilt: 300 conversations' });
      lastChild().emit('message', { type: 'log', level: 'error', text: 'boom' });
      expect(log).toHaveBeenCalledWith('[retrieval-worker] [knowledge-graph] map rebuilt: 300 conversations');
      // Not packaged here: the worker's stderr already reached the terminal.
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      client.dispose();
    }
  });

  it('says when a worker is up and when it goes, once each', async () => {
    const client = new RetrievalClient(new UtilityRestartPolicy({ service: 'test-retrieval', maxCrashes: 5, backoffMs: [0] }));
    const seen: string[] = [];
    client.on('ready', () => seen.push('ready'));
    client.on('down', () => seen.push('down'));
    void client.call('projects.summaries', { projectIds: [] }).catch(() => undefined);
    lastChild().emit('message', { type: 'ready' });
    lastChild().emit('exit', 1);
    // A worker that never said ready was never up, so its exit says nothing.
    void client.call('projects.summaries', { projectIds: [] }).catch(() => undefined);
    lastChild().emit('exit', 1);
    void client.call('projects.summaries', { projectIds: [] }).catch(() => undefined);
    lastChild().emit('message', { type: 'ready' });
    client.dispose();
    expect(seen).toEqual(['ready', 'down', 'ready', 'down']);
  });

  it('relays worker events', async () => {
    const client = new RetrievalClient();
    const events: Array<[string, string]> = [];
    client.on('event', (event, projectId) => events.push([event, projectId]));
    void client.call('projects.summaries', { projectIds: [] }).catch(() => undefined);
    lastChild().emit('message', { type: 'event', event: 'graph-changed', projectId: 'project-1' });
    expect(events).toEqual([['graph-changed', 'project-1']]);
    client.dispose();
  });

  it('closes a project in a running worker, and forks none to do it', async () => {
    const idle = new RetrievalClient();
    await idle.closeProject('project-1');
    expect(forkedChildren).toHaveLength(0);

    const client = new RetrievalClient();
    void client.call('projects.summaries', { projectIds: [] }).catch(() => undefined);
    const child = lastChild();
    child.emit('message', { type: 'ready' });
    await flush();
    const closing = client.closeProject('project-1');
    await flush();
    const request = sent(child, 'request').find((message) => message.method === 'project.close');
    expect(request).toMatchObject({ params: { projectId: 'project-1' } });
    child.emit('message', { type: 'reply', id: request?.id, ok: true, result: undefined });
    await closing;
    expect(child.kill).not.toHaveBeenCalled();
    client.dispose();
  });

  it('shuts down a worker that does not close the project, and waits for it to exit', async () => {
    vi.useFakeTimers();
    const client = new RetrievalClient();
    void client.call('projects.summaries', { projectIds: [] }).catch(() => undefined);
    const child = lastChild();
    child.emit('message', { type: 'ready' });
    await flush();
    let closed = false;
    const closing = client.closeProject('project-1').then(() => { closed = true; });
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).toHaveBeenCalled();
    expect(closed).toBe(false);
    child.emit('exit', 1);
    await closing;
    expect(closed).toBe(true);
    client.dispose();
  });

  it('drops a worker that never says ready, fails the call waiting on it, and forks a new worker for the next call', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A zero backoff, or the fake clock keeps the policy from letting the next call fork.
    const policy = new UtilityRestartPolicy({ service: 'test-retrieval', maxCrashes: 5, backoffMs: [0] });
    const recordCrash = vi.spyOn(policy, 'recordCrash');
    const client = new RetrievalClient(policy);
    try {
      const waiting = client.call('projects.summaries', { projectIds: [] });
      const stuckChild = lastChild();

      // Inside the budget the worker is left alone.
      vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
      expect(stuckChild.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      await expect(waiting).rejects.toBeInstanceOf(RetrievalUnavailableError);
      await expect(waiting).rejects.toThrow('did not start in time');
      expect(stuckChild.kill).toHaveBeenCalledTimes(1);
      expect(sent(stuckChild, 'shutdown')).toHaveLength(1);
      expect(recordCrash).toHaveBeenCalledTimes(1);

      // The next call forks a new worker and gets its answer.
      const next = client.call('projects.summaries', { projectIds: [] });
      expect(forkedChildren).toHaveLength(2);
      const freshChild = lastChild();
      expect(freshChild).not.toBe(stuckChild);
      freshChild.emit('message', { type: 'ready' });
      await flush();
      const [request] = sent(freshChild, 'request');
      freshChild.emit('message', { type: 'reply', id: request.id, ok: true, result: [] });
      await expect(next).resolves.toEqual([]);

      // The dropped worker's exit, whenever it lands, is not a second crash.
      stuckChild.emit('exit', 1);
      expect(recordCrash).toHaveBeenCalledTimes(1);
    } finally {
      client.dispose();
      warn.mockRestore();
    }
  });

  it('leaves a worker that says ready inside its budget running, however long it then lives', async () => {
    vi.useFakeTimers();
    const client = new RetrievalClient();
    // No call budget of its own, so only the ready timer could kill the worker.
    const call = client.call('projects.summaries', { projectIds: [] }, { timeoutMs: null });
    const child = lastChild();

    vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
    child.emit('message', { type: 'ready' });
    await flush();
    vi.advanceTimersByTime(10 * READY_TIMEOUT_MS);

    expect(child.kill).not.toHaveBeenCalled();
    const [request] = sent(child, 'request');
    child.emit('message', { type: 'reply', id: request.id, ok: true, result: [] });
    await expect(call).resolves.toEqual([]);
    client.dispose();
  });

  it('returns from closeProject at once, not after its timeout, when the worker exits while the close is pending', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new RetrievalClient(new UtilityRestartPolicy({ service: 'test-retrieval', maxCrashes: 5, backoffMs: [0] }));
    try {
      void client.call('projects.summaries', { projectIds: [] }).catch(() => undefined);
      const child = lastChild();
      child.emit('message', { type: 'ready' });
      await flush();
      let closed = false;
      const closing = client.closeProject('project-1').then(() => { closed = true; });
      await settleMicrotasks();
      expect(sent(child, 'request').some((message) => message.method === 'project.close')).toBe(true);
      expect(closed).toBe(false);

      child.emit('exit', 1);
      // No timer is advanced: a close that waited out its timeout stays pending here.
      await settleMicrotasks();

      expect(closed).toBe(true);
      // A worker that already exited holds no handle, so there is nothing to stop.
      expect(child.kill).not.toHaveBeenCalled();
      await closing;
    } finally {
      client.dispose();
      warn.mockRestore();
    }
  });

  it('disposes synchronously: kills the worker, fails pending calls, and refuses new ones', async () => {
    const client = new RetrievalClient();
    const call = client.call('projects.summaries', { projectIds: [] });
    const child = lastChild();
    client.dispose();
    expect(child.kill).toHaveBeenCalled();
    expect(sent(child, 'shutdown')).toHaveLength(1);
    await expect(call).rejects.toBeInstanceOf(RetrievalUnavailableError);
    await expect(client.call('projects.summaries', { projectIds: [] })).rejects.toBeInstanceOf(RetrievalUnavailableError);
    // The disposal kill is not a crash.
    child.emit('exit', 0);
    expect(forkedChildren).toHaveLength(1);
  });
});
