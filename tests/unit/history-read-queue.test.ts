import { describe, expect, it } from 'vitest';
import { createHistoryReadQueue } from '../../src/main/retrieval/worker/history-read-queue';

/**
 * The worker's queue for Conversation viewer history reads: one read at a
 * time, `busy` past the depth or wait cap or the whole-call deadline so no read
 * can run into main's call timer (which kills the worker), and a newer request
 * from the same window superseding its queued older one.
 */

const NO_DEADLINE = { maxTotalMs: 60_000 };

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('createHistoryReadQueue', () => {
  it('runs one read at a time', async () => {
    const queue = createHistoryReadQueue({ maxDepth: 8, maxWaitMs: 60_000, ...NO_DEADLINE });
    let running = 0;
    let mostAtOnce = 0;
    const job = async () => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return 'read';
    };
    const outcomes = await Promise.all([queue.run('a', job), queue.run('b', job), queue.run('c', job)]);
    expect(mostAtOnce).toBe(1);
    expect(outcomes).toEqual([
      { ran: true, value: 'read' },
      { ran: true, value: 'read' },
      { ran: true, value: 'read' },
    ]);
  });

  it('lets a newer request from the same window supersede its queued older one', async () => {
    const queue = createHistoryReadQueue({ maxDepth: 8, maxWaitMs: 60_000, ...NO_DEADLINE });
    const blocker = deferred<string>();
    const first = queue.run('other-window', () => blocker.promise);
    const older = queue.run('window-1', async () => 'older');
    const newer = queue.run('window-1', async () => 'newer');
    blocker.resolve('blocker');
    expect(await first).toEqual({ ran: true, value: 'blocker' });
    expect(await older).toEqual({ ran: false, reason: 'superseded' });
    expect(await newer).toEqual({ ran: true, value: 'newer' });
  });

  it('answers busy past the depth cap without queuing the read', async () => {
    const queue = createHistoryReadQueue({ maxDepth: 2, maxWaitMs: 60_000, ...NO_DEADLINE });
    const blocker = deferred<string>();
    let ranExtra = false;
    const held = [queue.run('a', () => blocker.promise), queue.run('b', async () => 'b')];
    const refused = await queue.run('c', async () => { ranExtra = true; return 'c'; });
    expect(refused).toEqual({ ran: false, reason: 'busy' });
    blocker.resolve('a');
    await Promise.all(held);
    expect(ranExtra).toBe(false);
  });

  it('answers busy, unread, for a request that waited past the wait cap', async () => {
    let clock = 0;
    const queue = createHistoryReadQueue({ maxDepth: 8, maxWaitMs: 5_000, ...NO_DEADLINE, now: () => clock });
    const blocker = deferred<string>();
    let ranLate = false;
    const first = queue.run('a', () => blocker.promise);
    const late = queue.run('b', async () => { ranLate = true; return 'b'; });
    clock = 6_000;
    blocker.resolve('a');
    await first;
    expect(await late).toEqual({ ran: false, reason: 'busy' });
    expect(ranLate).toBe(false);
  });

  it('answers busy at the deadline for a read that runs long, and for the reads behind it', async () => {
    const queue = createHistoryReadQueue({ maxDepth: 8, maxWaitMs: 60_000, maxTotalMs: 30 });
    const blocker = deferred<string>();
    let ranBehind = false;
    const longRead = queue.run('a', () => blocker.promise);
    const behind = queue.run('b', async () => { ranBehind = true; return 'b'; });
    // Neither waits on the long read: each answers when its own deadline passes.
    expect(await longRead).toEqual({ ran: false, reason: 'busy' });
    expect(await behind).toEqual({ ran: false, reason: 'busy' });
    // Once the long read ends, a read already answered never runs.
    blocker.resolve('a');
    const after = await queue.run('c', async () => 'c');
    expect(after).toEqual({ ran: true, value: 'c' });
    expect(ranBehind).toBe(false);
  });
});
