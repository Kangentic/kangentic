import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Checkpoint ownership: while a retrieval worker is up, main's own WAL
 * auto-checkpoint is off and the worker is asked for a PASSIVE checkpoint of
 * every open project database on an interval; when it goes down, main takes
 * checkpoints back at once.
 */

const database = vi.hoisted(() => ({
  setWalAutoCheckpoint: vi.fn(),
  openProjectDbIds: vi.fn(() => ['project-1', 'project-2']),
}));
vi.mock('../../src/main/db/database', () => database);
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: {} }));

import { attachCheckpointDriver, CHECKPOINT_INTERVAL_MS } from '../../src/main/retrieval/checkpoint-driver';

class FakeClient extends EventEmitter {
  call = vi.fn(async () => []);
}

describe('checkpoint driver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    database.openProjectDbIds.mockReturnValue(['project-1', 'project-2']);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns main\'s auto-checkpoint off while the worker is up and asks it to checkpoint every open database', async () => {
    const client = new FakeClient();
    const stop = attachCheckpointDriver(client as never);
    client.emit('ready');
    expect(database.setWalAutoCheckpoint).toHaveBeenLastCalledWith(0);
    expect(client.call).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHECKPOINT_INTERVAL_MS);
    expect(client.call).toHaveBeenCalledWith('db.checkpoint', { projectIds: ['project-1', 'project-2'] }, { timeoutMs: null });
    await vi.advanceTimersByTimeAsync(CHECKPOINT_INTERVAL_MS);
    expect(client.call).toHaveBeenCalledTimes(2);
    stop();
  });

  it('gives checkpoints back to main when the worker goes down, and stops asking it', () => {
    const client = new FakeClient();
    attachCheckpointDriver(client as never);
    client.emit('ready');
    client.emit('down');
    expect(database.setWalAutoCheckpoint).toHaveBeenLastCalledWith(null);
    vi.advanceTimersByTime(3 * CHECKPOINT_INTERVAL_MS);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('skips a tick while the last checkpoint is still running, then asks again once it settles', async () => {
    const client = new FakeClient();
    let settle: () => void = () => undefined;
    client.call.mockImplementationOnce(() => new Promise<never[]>((resolve) => { settle = () => resolve([]); }));
    const stop = attachCheckpointDriver(client as never);
    client.emit('ready');

    vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS);
    expect(client.call).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3 * CHECKPOINT_INTERVAL_MS);
    expect(client.call).toHaveBeenCalledTimes(1);

    settle();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS);
    expect(client.call).toHaveBeenCalledTimes(2);
    stop();
  });

  it('asks again after a checkpoint call fails', async () => {
    const client = new FakeClient();
    client.call.mockImplementationOnce(async () => { throw new Error('worker restarting'); });
    const stop = attachCheckpointDriver(client as never);
    client.emit('ready');

    vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS);
    expect(client.call).toHaveBeenCalledTimes(2);
    stop();
  });

  it('asks for nothing while no project database is open', () => {
    database.openProjectDbIds.mockReturnValue([]);
    const client = new FakeClient();
    const stop = attachCheckpointDriver(client as never);
    client.emit('ready');
    vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS);
    expect(client.call).not.toHaveBeenCalled();
    stop();
  });
});
