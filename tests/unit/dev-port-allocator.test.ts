import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import type { DevPortLease } from '../../src/shared/types';

/**
 * The reservation contract, exercised against an in-memory stand-in for the
 * lease table plus REAL sockets.
 *
 * Real sockets rather than a mocked probe on purpose: the whole point of the
 * bind probe is that it disagrees with the lease table when something outside
 * Kangentic holds a port, and a mocked probe can only ever agree with whatever
 * the test already decided.
 *
 * The mock below MIRRORS DevPortRepository, which is the standing hazard with
 * this shape of test: relax a constraint here and the suite passes against its
 * own copy while the real schema still rejects the write. The one constraint
 * that actually moved - a task may now hold SEVERAL ports - is therefore also
 * asserted against real SQLite in `dev-port-schema.test.ts`, not here.
 */

interface StoredLease extends DevPortLease {}

let leases: StoredLease[] = [];

vi.mock('../../src/main/db/repositories/dev-port-repository', () => ({
  devPortRepository: {
    listForTask: (taskId: string) =>
      leases.filter((l) => l.taskId === taskId).sort((a, b) => a.port - b.port),
    getByTaskId: (taskId: string) =>
      leases.filter((l) => l.taskId === taskId).sort((a, b) => a.port - b.port)[0] ?? null,
    getByPort: (port: number) => leases.find((l) => l.port === port) ?? null,
    claim: (port: number, projectId: string, taskId: string) => {
      // Mirrors INSERT OR IGNORE against the PORT primary key, and only that.
      // task_id is deliberately NOT unique: a project that runs an API and a
      // frontend needs two.
      if (leases.some((l) => l.port === port)) return false;
      leases.push({ port, projectId, taskId, allocatedAt: '2026-08-20T00:00:00.000Z' });
      return true;
    },
    releaseByTaskId: (taskId: string) => {
      leases = leases.filter((l) => l.taskId !== taskId);
    },
  },
}));

const {
  reserveDevPorts,
  describeDevPorts,
  getDevPortForTask,
  getDevPortsForTask,
  isPortFree,
  releaseDevPortForTask,
  DEFAULT_DEV_PORT_RANGE_START,
  DEFAULT_DEV_PORT_RANGE_END,
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

describe('reserveDevPorts', () => {
  it('reserves nothing until asked, then hands out from the start of the range', async () => {
    // The design inversion in one assertion: an untouched task holds nothing.
    expect(getDevPortsForTask('task-1')).toEqual([]);
    expect(leases).toHaveLength(0);

    const ports = await reserveDevPorts('proj-1', 'task-1', 1);
    expect(ports).toEqual([DEFAULT_DEV_PORT_RANGE_START]);
  });

  it('reserves several at once, contiguously when the range is empty', async () => {
    // The case a single-port allocator could not serve: an API, a frontend and
    // a mock server, all needed before any of them starts.
    const ports = await reserveDevPorts('proj-1', 'task-1', 3);
    expect(ports).toEqual([
      DEFAULT_DEV_PORT_RANGE_START,
      DEFAULT_DEV_PORT_RANGE_START + 1,
      DEFAULT_DEV_PORT_RANGE_START + 2,
    ]);
    expect(leases).toHaveLength(3);
  });

  it('returns already-held ports rather than reserving more', async () => {
    const first = await reserveDevPorts('proj-1', 'task-1', 2);
    const second = await reserveDevPorts('proj-1', 'task-1', 2);
    expect(second).toEqual(first);
    expect(leases).toHaveLength(2);
  });

  it('tops up to the new count when a task asks for more than it holds', async () => {
    await reserveDevPorts('proj-1', 'task-1', 1);
    const topped = await reserveDevPorts('proj-1', 'task-1', 3);
    expect(topped).toHaveLength(3);
    expect(topped[0]).toBe(DEFAULT_DEV_PORT_RANGE_START);
    expect(new Set(topped).size).toBe(3);
  });

  it('never reserves below what a task already holds', async () => {
    // Asking for fewer is not a release. An agent that reserved 3 and later
    // asks for 1 must not have two of its running servers quietly unbooked.
    await reserveDevPorts('proj-1', 'task-1', 3);
    const narrowed = await reserveDevPorts('proj-1', 'task-1', 1);
    expect(narrowed).toEqual([DEFAULT_DEV_PORT_RANGE_START]);
    expect(getDevPortsForTask('task-1')).toHaveLength(3);
  });

  it('gives two tasks disjoint ports', async () => {
    const a = await reserveDevPorts('proj-1', 'task-a', 2);
    const b = await reserveDevPorts('proj-1', 'task-b', 2);
    expect(a.some((port) => b.includes(port))).toBe(false);
  });

  it('does not hand out a port another PROJECT already reserved', async () => {
    // The reason the table is global: a per-project table could not see this.
    await reserveDevPorts('proj-1', 'task-1', 1);
    const other = await reserveDevPorts('proj-2', 'task-2', 1);
    expect(other).not.toContain(DEFAULT_DEV_PORT_RANGE_START);
  });

  it('skips a port an unrelated process holds, even with no lease for it', async () => {
    const held = await occupyPort();
    opened.push(held.release);
    // Scan a one-port range that is genuinely occupied: the lease table is
    // empty, so only the bind probe can save us here.
    const ports = await reserveDevPorts('proj-1', 'task-1', 1, {
      rangeStart: held.port,
      rangeEnd: held.port,
    });
    expect(ports).toEqual([]);
  });

  it('returns a SHORT list when the range runs out, rather than throwing', async () => {
    // The caller's contract: a short result means "use your own configured
    // ports for the rest", never an error.
    const ports = await reserveDevPorts('proj-1', 'task-1', 3, {
      rangeStart: 4500,
      rangeEnd: 4501,
    });
    expect(ports).toEqual([4500, 4501]);
  });

  it('returns an empty list when the range is fully taken', async () => {
    await reserveDevPorts('proj-1', 'task-1', 1, { rangeStart: 4500, rangeEnd: 4500 });
    const second = await reserveDevPorts('proj-1', 'task-2', 1, { rangeStart: 4500, rangeEnd: 4500 });
    expect(second).toEqual([]);
    expect(leases).toHaveLength(1);
  });

  it('does not steal an exhausted range back from its holder', async () => {
    // There is no reclaim path by design. An exhausted range stays exhausted
    // until a task or project is deleted, and this pins that it does not
    // silently repossess a live reservation instead.
    await reserveDevPorts('proj-1', 'task-1', 1, { rangeStart: 4500, rangeEnd: 4500 });
    await reserveDevPorts('proj-1', 'task-2', 1, { rangeStart: 4500, rangeEnd: 4500 });
    expect(leases).toHaveLength(1);
    expect(leases[0].taskId).toBe('task-1');
  });

  it('treats a count below one as one', async () => {
    const ports = await reserveDevPorts('proj-1', 'task-1', 0);
    expect(ports).toEqual([DEFAULT_DEV_PORT_RANGE_START]);
  });

  it('falls back to the default range when given a reversed one', async () => {
    const ports = await reserveDevPorts('proj-1', 'task-1', 1, { rangeStart: 5000, rangeEnd: 4000 });
    expect(ports).toEqual([DEFAULT_DEV_PORT_RANGE_START]);
  });

  it('defaults to a range that misses every common framework port', async () => {
    // 4200 (Angular) shipped as the default and put a task's Browser pane on
    // the user's own running dashboard. The range is load-bearing, not taste.
    const collisions = [3000, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 9000, 9229];
    for (const port of collisions) {
      expect(port < DEFAULT_DEV_PORT_RANGE_START || port > DEFAULT_DEV_PORT_RANGE_END).toBe(true);
    }
  });
});

describe('getDevPortsForTask', () => {
  it('is a pure read that never reserves', async () => {
    expect(getDevPortsForTask('task-1')).toEqual([]);
    expect(leases).toHaveLength(0);

    await reserveDevPorts('proj-1', 'task-1', 2);
    expect(getDevPortsForTask('task-1')).toHaveLength(2);
    expect(leases).toHaveLength(2);
  });
});

describe('getDevPortForTask', () => {
  it('reports the LOWEST reserved port, which is what {{port}} resolves to', async () => {
    await reserveDevPorts('proj-1', 'task-1', 3);
    expect(getDevPortForTask('task-1')).toBe(DEFAULT_DEV_PORT_RANGE_START);
  });

  it('is null for a task holding nothing, so {{port}} resolves empty', async () => {
    // Empty is the NORMAL state now that nothing is reserved up front. The
    // resolver documents what empty means for a flag-shaped template.
    expect(getDevPortForTask('task-1')).toBeNull();
  });
});

describe('release', () => {
  it('frees every one of a task\'s ports for the next task', async () => {
    const first = await reserveDevPorts('proj-1', 'task-1', 2);
    releaseDevPortForTask('task-1');
    const second = await reserveDevPorts('proj-1', 'task-2', 2);
    expect(second).toEqual(first);
  });

});

describe('describeDevPorts', () => {
  it('reports a port IN USE outside Kangentic, which the ledger cannot see', async () => {
    // The whole reason this function exists. Nothing has reserved this port,
    // so a ledger read reports nothing at all - only the probe knows.
    const held = await occupyPort();
    opened.push(held.release);

    const [status] = await describeDevPorts('task-1', [held.port]);
    expect(status).toEqual({ port: held.port, reservation: null, listening: true });
  });

  it('reports a genuinely free port', async () => {
    const held = await occupyPort();
    const { port } = held;
    await held.release();

    const [status] = await describeDevPorts('task-1', [port]);
    expect(status).toEqual({ port, reservation: null, listening: false });
  });

  it('distinguishes the asking task\'s own reservation from another task\'s', async () => {
    const [mine] = await reserveDevPorts('proj-1', 'task-1', 1);
    const [theirs] = await reserveDevPorts('proj-1', 'task-2', 1);

    const statuses = await describeDevPorts('task-1', [mine, theirs]);
    expect(statuses.map((status) => status.reservation)).toEqual(['this-task', 'other-task']);
  });

  it('never names the other task, only that the port is spoken for', async () => {
    const [theirs] = await reserveDevPorts('proj-1', 'task-2', 1);
    const [status] = await describeDevPorts('task-1', [theirs]);
    expect(JSON.stringify(status)).not.toContain('task-2');
  });

  it('reports a reservation whose server is DOWN as reserved but not listening', async () => {
    // The restart case: the port is still yours, there is just nothing on it.
    const [mine] = await reserveDevPorts('proj-1', 'task-1', 1);
    const [status] = await describeDevPorts('task-1', [mine]);
    expect(status).toEqual({ port: mine, reservation: 'this-task', listening: false });
  });

  it('reserves nothing and releases nothing', async () => {
    const held = await occupyPort();
    opened.push(held.release);
    await describeDevPorts('task-1', [held.port, 7300, 7301]);
    expect(leases).toHaveLength(0);
  });

  it('returns one row per port, in the order asked', async () => {
    const statuses = await describeDevPorts('task-1', [7302, 7300, 7301]);
    expect(statuses.map((status) => status.port)).toEqual([7302, 7300, 7301]);
  });

  it('returns an empty list for an empty request without probing', async () => {
    expect(await describeDevPorts('task-1', [])).toEqual([]);
  });
});
