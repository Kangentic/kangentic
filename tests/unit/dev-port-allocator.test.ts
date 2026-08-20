import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import type { DevPortLease } from '../../src/shared/types';

/**
 * The allocator's contract, exercised against an in-memory stand-in for the
 * lease table plus REAL sockets.
 *
 * Real sockets rather than a mocked probe on purpose: the whole point of the
 * bind probe is that it disagrees with the lease table when something outside
 * Kangentic holds a port, and a mocked probe can only ever agree with whatever
 * the test already decided.
 */

interface StoredLease extends DevPortLease {}

let leases: StoredLease[] = [];

vi.mock('../../src/main/db/repositories/dev-port-repository', () => ({
  devPortRepository: {
    list: () => [...leases].sort((a, b) => a.port - b.port),
    listForProject: (projectId: string) => leases.filter((l) => l.projectId === projectId),
    getByTaskId: (taskId: string) => leases.find((l) => l.taskId === taskId) ?? null,
    getByPort: (port: number) => leases.find((l) => l.port === port) ?? null,
    claim: (port: number, projectId: string, taskId: string) => {
      // Mirrors INSERT OR IGNORE against both unique constraints.
      if (leases.some((l) => l.port === port || l.taskId === taskId)) return false;
      leases.push({ port, projectId, taskId, allocatedAt: '2026-08-20T00:00:00.000Z', lastSeenAt: null });
      return true;
    },
    markSeen: (port: number) => {
      const lease = leases.find((l) => l.port === port);
      if (lease) lease.lastSeenAt = '2026-08-20T00:00:00.000Z';
    },
    releaseByTaskId: (taskId: string) => {
      leases = leases.filter((l) => l.taskId !== taskId);
    },
    releaseByPort: (port: number) => {
      leases = leases.filter((l) => l.port !== port);
    },
    releaseForProject: (projectId: string) => {
      leases = leases.filter((l) => l.projectId !== projectId);
    },
  },
}));

const {
  allocateDevPort,
  getDevPortForTask,
  isPortFree,
  reclaimStaleDevPorts,
  releaseDevPortForTask,
  DEFAULT_DEV_PORT_RANGE_START,
} = await import('../../src/main/dev-ports/dev-port-allocator');

/** Occupy a real loopback port for the duration of a test. */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address from the probe server');
  }
  return {
    port: address.port,
    release: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let opened: Array<() => Promise<void>> = [];

beforeEach(() => {
  leases = [];
  opened = [];
});

afterEach(async () => {
  for (const release of opened) await release();
  opened = [];
});

describe('isPortFree', () => {
  it('reports false for a port something is actually listening on', async () => {
    const held = await occupyPort();
    opened.push(held.release);
    expect(await isPortFree(held.port)).toBe(false);
  });

  it('reports true once that port is released', async () => {
    const held = await occupyPort();
    const { port } = held;
    await held.release();
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('allocateDevPort', () => {
  it('leases the first port in the range', async () => {
    const port = await allocateDevPort('proj-1', 'task-1');
    expect(port).toBe(DEFAULT_DEV_PORT_RANGE_START);
  });

  it('is idempotent per task, so repeated spawns keep one stable port', async () => {
    const first = await allocateDevPort('proj-1', 'task-1');
    const second = await allocateDevPort('proj-1', 'task-1');
    expect(second).toBe(first);
    expect(leases).toHaveLength(1);
  });

  it('gives two tasks different ports', async () => {
    const a = await allocateDevPort('proj-1', 'task-a');
    const b = await allocateDevPort('proj-1', 'task-b');
    expect(a).not.toBe(b);
  });

  it('does not hand out a port another PROJECT already leased', async () => {
    // The reason the table is global: a per-project table could not see this.
    await allocateDevPort('proj-1', 'task-1');
    const other = await allocateDevPort('proj-2', 'task-2');
    expect(other).not.toBe(DEFAULT_DEV_PORT_RANGE_START);
  });

  it('skips a port an unrelated process holds, even with no lease for it', async () => {
    const held = await occupyPort();
    opened.push(held.release);
    // Scan a one-port range that is genuinely occupied: the lease table is
    // empty, so only the bind probe can save us here.
    const port = await allocateDevPort('proj-1', 'task-1', {
      rangeStart: held.port,
      rangeEnd: held.port,
    });
    expect(port).toBeNull();
  });

  it('returns null when the range is exhausted rather than throwing', async () => {
    await allocateDevPort('proj-1', 'task-1', { rangeStart: 4500, rangeEnd: 4500 });
    const second = await allocateDevPort('proj-1', 'task-2', { rangeStart: 4500, rangeEnd: 4500 });
    expect(second).toBeNull();
  });

  it('reclaims a dead lease only once the range is exhausted, then succeeds', async () => {
    // Self-healing where it matters, and nowhere else: reclaiming is the exact
    // thing worth doing when there are no ports left, so that is when it runs.
    await allocateDevPort('dead-project', 'ghost-task', { rangeStart: 4500, rangeEnd: 4500 });
    expect(leases).toHaveLength(1);

    const port = await allocateDevPort('proj-1', 'task-2', {
      rangeStart: 4500,
      rangeEnd: 4500,
      isLeaseReclaimable: (lease) => lease.projectId === 'dead-project',
    });

    expect(port).toBe(4500);
    expect(leases).toHaveLength(1);
    expect(leases[0].taskId).toBe('task-2');
  });

  it('does not reclaim a lease the caller still considers live', async () => {
    await allocateDevPort('proj-1', 'task-1', { rangeStart: 4500, rangeEnd: 4500 });
    const port = await allocateDevPort('proj-1', 'task-2', {
      rangeStart: 4500,
      rangeEnd: 4500,
      isLeaseReclaimable: () => false,
    });
    expect(port).toBeNull();
    expect(leases[0].taskId).toBe('task-1');
  });

  it('does not reclaim when no predicate is supplied', async () => {
    // The safe default for a caller that cannot judge liveness.
    await allocateDevPort('proj-1', 'task-1', { rangeStart: 4500, rangeEnd: 4500 });
    const port = await allocateDevPort('proj-1', 'task-2', { rangeStart: 4500, rangeEnd: 4500 });
    expect(port).toBeNull();
    expect(leases).toHaveLength(1);
  });

  it('falls back to the default range when given a reversed one', async () => {
    const port = await allocateDevPort('proj-1', 'task-1', { rangeStart: 5000, rangeEnd: 4000 });
    expect(port).toBe(DEFAULT_DEV_PORT_RANGE_START);
  });
});

describe('getDevPortForTask', () => {
  it('is a pure read that never allocates', async () => {
    expect(getDevPortForTask('task-1')).toBeNull();
    expect(leases).toHaveLength(0);

    await allocateDevPort('proj-1', 'task-1');
    expect(getDevPortForTask('task-1')).toBe(DEFAULT_DEV_PORT_RANGE_START);
    expect(leases).toHaveLength(1);
  });
});

describe('releaseDevPortForTask', () => {
  it('frees the port for the next task', async () => {
    const first = await allocateDevPort('proj-1', 'task-1');
    releaseDevPortForTask('task-1');
    const second = await allocateDevPort('proj-1', 'task-2');
    expect(second).toBe(first);
  });
});

describe('reclaimStaleDevPorts', () => {
  it('reclaims a lease whose task is gone and whose port is silent', async () => {
    await allocateDevPort('proj-1', 'ghost-task');
    const reclaimed = await reclaimStaleDevPorts(() => false);
    expect(reclaimed).toEqual([DEFAULT_DEV_PORT_RANGE_START]);
    expect(leases).toHaveLength(0);
  });

  it('keeps a lease whose task is still alive', async () => {
    await allocateDevPort('proj-1', 'live-task');
    const reclaimed = await reclaimStaleDevPorts(() => true);
    expect(reclaimed).toEqual([]);
    expect(leases).toHaveLength(1);
  });

  it('keeps a lease whose port is still listening even when the task is gone', async () => {
    // The dev-server-restarting case inverted: something IS on the port, so
    // reclaiming it would hand a live server's port to another task. Both
    // conditions are required, which is what this pins.
    const held = await occupyPort();
    opened.push(held.release);
    leases.push({
      port: held.port,
      projectId: 'proj-1',
      taskId: 'gone-task',
      allocatedAt: '2026-08-20T00:00:00.000Z',
      lastSeenAt: null,
    });

    const reclaimed = await reclaimStaleDevPorts(() => false);
    expect(reclaimed).toEqual([]);
    expect(leases).toHaveLength(1);
  });
});
