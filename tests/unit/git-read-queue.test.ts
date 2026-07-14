import { describe, it, expect } from 'vitest';
import { viaGitRead, GitReadPriority, GIT_READ_CONCURRENCY } from '../../src/main/git/git-read-queue';

/** A manually-released gate: the job blocks until the test calls release(). */
function createGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function pollUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('pollUntil timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('viaGitRead concurrency cap', () => {
  it('never admits more than GIT_READ_CONCURRENCY jobs at once', async () => {
    const gates = Array.from({ length: 5 }, () => createGate());
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;

    const jobs = gates.map((gate) =>
      viaGitRead(async () => {
        started += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate.promise;
        inFlight -= 1;
        return 'done';
      }),
    );

    // Only the first N are admitted; the rest wait in the queue.
    await pollUntil(() => started === GIT_READ_CONCURRENCY);
    expect(started).toBe(GIT_READ_CONCURRENCY);

    // Releasing one slot admits exactly one more job.
    gates[0].release();
    await pollUntil(() => started === GIT_READ_CONCURRENCY + 1);
    expect(maxInFlight).toBe(GIT_READ_CONCURRENCY);

    for (const gate of gates) gate.release();
    const results = await Promise.all(jobs);
    expect(results).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(maxInFlight).toBe(GIT_READ_CONCURRENCY);
  });

  it('runs USER-priority jobs before queued BACKGROUND jobs (pins the p-queue inversion)', async () => {
    // Saturate both slots with gated jobs.
    const blockers = Array.from({ length: GIT_READ_CONCURRENCY }, () => createGate());
    const blockerJobs = blockers.map((gate) => viaGitRead(() => gate.promise));

    const order: string[] = [];
    // Enqueue BACKGROUND first, then USER: despite FIFO arrival, USER must
    // run first. p-queue treats HIGHER numbers as higher priority, so this
    // test fails if GitReadPriority is ever inverted to match GitQueuePriority.
    const backgroundJob = viaGitRead(async () => {
      order.push('background');
    }, { priority: GitReadPriority.BACKGROUND });
    const userJob = viaGitRead(async () => {
      order.push('user');
    });

    for (const gate of blockers) gate.release();
    await Promise.all([...blockerJobs, backgroundJob, userJob]);

    expect(order).toEqual(['user', 'background']);
  });

  it('propagates a job rejection to its caller and keeps later jobs running', async () => {
    await expect(viaGitRead(async () => {
      throw new Error('git exploded');
    })).rejects.toThrow('git exploded');

    await expect(viaGitRead(async () => 'still alive')).resolves.toBe('still alive');
  });
});
