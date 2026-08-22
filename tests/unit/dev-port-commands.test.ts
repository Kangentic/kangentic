import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';

/**
 * The two dev-port MCP handlers.
 *
 * These are almost entirely a REFUSAL surface, which is why they are tested
 * apart from the allocator: an MCP error is the only thing the calling agent
 * gets back, so a refusal has to name the offending value and say what to do
 * instead, or the agent retries the identical call forever. The allocator is
 * stubbed here on purpose - what is under test is the contract at the boundary,
 * not port scanning (dev-port-allocator.test.ts owns that against real
 * sockets).
 */

interface DevPortStatus {
  port: number;
  reservation: 'this-task' | 'other-task' | null;
  listening: boolean;
}

const reserveDevPorts = vi.fn<(projectId: string, taskId: string, count: number, options?: unknown) => Promise<number[]>>();
const getDevPortsForTask = vi.fn<(taskId: string) => number[]>();
const describeDevPorts = vi.fn<(taskId: string, ports: number[]) => Promise<DevPortStatus[]>>();

vi.mock('../../src/main/dev-ports/dev-port-allocator', () => ({
  reserveDevPorts: (...args: Parameters<typeof reserveDevPorts>) => reserveDevPorts(...args),
  getDevPortsForTask: (...args: Parameters<typeof getDevPortsForTask>) => getDevPortsForTask(...args),
  describeDevPorts: (...args: Parameters<typeof describeDevPorts>) => describeDevPorts(...args),
}));

/** Shorthand for one probed port. */
function status(
  port: number,
  reservation: DevPortStatus['reservation'],
  listening: boolean,
): DevPortStatus {
  return { port, reservation, listening };
}

const { handleReserveDevPorts, handleCheckDevPorts } = await import(
  '../../src/main/agent/commands/dev-port-commands'
);

const context = {
  projectId: 'proj-1',
  getDevServerPortRange: () => ({ rangeStart: 7300, rangeEnd: 7499 }),
} as unknown as CommandContext;

beforeEach(() => {
  reserveDevPorts.mockReset();
  getDevPortsForTask.mockReset();
  describeDevPorts.mockReset();
  reserveDevPorts.mockResolvedValue([7300]);
  getDevPortsForTask.mockReturnValue([]);
  describeDevPorts.mockResolvedValue([]);
});

describe('handleReserveDevPorts', () => {
  it('reserves one port by default', async () => {
    const result = await handleReserveDevPorts({ taskId: 'task-1' }, context);
    expect(result.success).toBe(true);
    expect(reserveDevPorts).toHaveBeenCalledWith('proj-1', 'task-1', 1, { rangeStart: 7300, rangeEnd: 7499 });
    expect(result.data).toEqual({ ports: [7300], requested: 1, reserved: 1 });
  });

  it('passes the caller\'s project, never a value from the arguments', async () => {
    // The ledger is machine-global, so a taskId alone would let a caller in one
    // project book ports against another. projectId comes from the MCP URL path.
    await handleReserveDevPorts({ taskId: 'task-1', projectId: 'somewhere-else' }, context);
    expect(reserveDevPorts).toHaveBeenCalledWith('proj-1', 'task-1', 1, expect.anything());
  });

  it('forwards the configured range rather than assuming the default', async () => {
    const narrow = {
      projectId: 'proj-1',
      getDevServerPortRange: () => ({ rangeStart: 9000, rangeEnd: 9010 }),
    } as unknown as CommandContext;
    await handleReserveDevPorts({ taskId: 'task-1', count: 2 }, narrow);
    expect(reserveDevPorts).toHaveBeenCalledWith('proj-1', 'task-1', 2, { rangeStart: 9000, rangeEnd: 9010 });
  });

  it('names the tool that resolves a missing taskId', async () => {
    const result = await handleReserveDevPorts({}, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('kangentic_get_current_task');
    expect(reserveDevPorts).not.toHaveBeenCalled();
  });

  it('reserves several at once and reports them all', async () => {
    reserveDevPorts.mockResolvedValue([7300, 7301, 7302]);
    const result = await handleReserveDevPorts({ taskId: 'task-1', count: 3 }, context);
    expect(result.success).toBe(true);
    expect(result.message).toContain('7300, 7301, 7302');
    expect(result.data).toEqual({ ports: [7300, 7301, 7302], requested: 3, reserved: 3 });
  });

  it('says so when the range ran out mid-request, and still returns what it got', async () => {
    // A SHORT result is a success, not an error: the caller uses its own
    // configured ports for the rest. The message has to say that, or an agent
    // reads three ports where two were handed out.
    reserveDevPorts.mockResolvedValue([7300, 7301]);
    const result = await handleReserveDevPorts({ taskId: 'task-1', count: 3 }, context);
    expect(result.success).toBe(true);
    expect(result.message).toContain('2 of 3');
    expect(result.data).toEqual({ ports: [7300, 7301], requested: 3, reserved: 2 });
  });

  it('refuses an exhausted range with an action, not just a diagnosis', async () => {
    reserveDevPorts.mockResolvedValue([]);
    const result = await handleReserveDevPorts({ taskId: 'task-1' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Settings');
    expect(result.error).toContain('own configured ports');
  });

  describe('count validation', () => {
    // Rejected outright rather than coerced, and the value named. A silently
    // floored 2.5 hands back one fewer port than asked for with nothing in the
    // response to say why, and the caller collides on the third server.
    const rejected: Array<[string, unknown]> = [
      ['a fraction', 2.5],
      ['zero', 0],
      ['negative', -1],
      ['over the cap', 11],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a numeric string', '3'],
      ['null', null],
    ];

    for (const [label, value] of rejected) {
      it(`refuses ${label} and reserves nothing`, async () => {
        const result = await handleReserveDevPorts({ taskId: 'task-1', count: value }, context);
        expect(result.success).toBe(false);
        expect(result.error).toContain('between 1 and 10');
        expect(reserveDevPorts).not.toHaveBeenCalled();
      });
    }

    it('names the offending value so the agent can see what it sent', async () => {
      const result = await handleReserveDevPorts({ taskId: 'task-1', count: 2.5 }, context);
      expect(result.error).toContain('2.5');
    });

    it('accepts both ends of the range', async () => {
      await handleReserveDevPorts({ taskId: 'task-1', count: 1 }, context);
      await handleReserveDevPorts({ taskId: 'task-1', count: 10 }, context);
      expect(reserveDevPorts).toHaveBeenCalledTimes(2);
    });
  });
});

describe('handleCheckDevPorts', () => {
  it('probes what the task holds, and never reserves', async () => {
    getDevPortsForTask.mockReturnValue([7300, 7301]);
    describeDevPorts.mockResolvedValue([status(7300, 'this-task', true), status(7301, 'this-task', false)]);

    const result = await handleCheckDevPorts({ taskId: 'task-1' }, context);

    expect(result.success).toBe(true);
    expect(describeDevPorts).toHaveBeenCalledWith('task-1', [7300, 7301]);
    expect(reserveDevPorts).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      ports: [7300, 7301],
      statuses: [status(7300, 'this-task', true), status(7301, 'this-task', false)],
    });
  });

  it('tells an agent holding nothing that this is normal, and what to call', async () => {
    // Empty is the usual state now that nothing is reserved up front. A bare
    // "no ports" reads like a failure and invites a pointless retry.
    const result = await handleCheckDevPorts({ taskId: 'task-1' }, context);
    expect(result.success).toBe(true);
    expect(result.message).toContain('normal state');
    expect(result.message).toContain('kangentic_reserve_dev_ports');
    expect(describeDevPorts).not.toHaveBeenCalled();
  });

  it('requires a taskId', async () => {
    const result = await handleCheckDevPorts({}, context);
    expect(result.success).toBe(false);
    expect(getDevPortsForTask).not.toHaveBeenCalled();
  });

  describe('the four-way answer', () => {
    // One case per branch. The fourth is the one the ledger alone could never
    // give, and the reason this tool probes at all.
    it('reports a port in use OUTSIDE Kangentic as taken', async () => {
      describeDevPorts.mockResolvedValue([status(4200, null, true)]);
      const result = await handleCheckDevPorts({ taskId: 'task-1', ports: [4200] }, context);
      expect(result.success).toBe(true);
      expect(result.message).toContain('IN USE by something outside Kangentic');
    });

    it('reports an unreserved, unlistened port as free', async () => {
      describeDevPorts.mockResolvedValue([status(3000, null, false)]);
      const result = await handleCheckDevPorts({ taskId: 'task-1', ports: [3000] }, context);
      expect(result.message).toContain('free');
    });

    it('says a port is yours with a server already on it', async () => {
      getDevPortsForTask.mockReturnValue([7300]);
      describeDevPorts.mockResolvedValue([status(7300, 'this-task', true)]);
      const result = await handleCheckDevPorts({ taskId: 'task-1' }, context);
      expect(result.message).toContain('yours, server running');
    });

    it('says a port is yours with nothing on it, so a restart is safe', async () => {
      getDevPortsForTask.mockReturnValue([7300]);
      describeDevPorts.mockResolvedValue([status(7300, 'this-task', false)]);
      const result = await handleCheckDevPorts({ taskId: 'task-1' }, context);
      expect(result.message).toContain('free to start on');
    });

    it('warns off another task\'s reservation without naming the task', async () => {
      describeDevPorts.mockResolvedValue([status(7305, 'other-task', true)]);
      const result = await handleCheckDevPorts({ taskId: 'task-1', ports: [7305] }, context);
      expect(result.message).toContain('do not use');
      expect(result.message).not.toContain('task-2');
    });
  });

  describe('the ports argument', () => {
    it('probes the task\'s own reservations AND the ports asked about', async () => {
      getDevPortsForTask.mockReturnValue([7300]);
      await handleCheckDevPorts({ taskId: 'task-1', ports: [4200, 3000] }, context);
      expect(describeDevPorts).toHaveBeenCalledWith('task-1', [3000, 4200, 7300]);
    });

    it('deduplicates a port the task already holds', async () => {
      // Otherwise it is probed twice and reported as two disagreeing rows.
      getDevPortsForTask.mockReturnValue([7300]);
      await handleCheckDevPorts({ taskId: 'task-1', ports: [7300] }, context);
      expect(describeDevPorts).toHaveBeenCalledWith('task-1', [7300]);
    });

    it('keeps data.ports as the task\'s own reservations, not everything probed', async () => {
      // A caller reading just that field gets what it always got.
      getDevPortsForTask.mockReturnValue([7300]);
      describeDevPorts.mockResolvedValue([status(4200, null, true), status(7300, 'this-task', true)]);
      const result = await handleCheckDevPorts({ taskId: 'task-1', ports: [4200] }, context);
      expect((result.data as { ports: number[] }).ports).toEqual([7300]);
    });

    it('refuses more than 20, because every one is probed', async () => {
      const tooMany = Array.from({ length: 21 }, (unused, index) => 3000 + index);
      const result = await handleCheckDevPorts({ taskId: 'task-1', ports: tooMany }, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('at most 20');
      expect(describeDevPorts).not.toHaveBeenCalled();
    });

    it('accepts exactly 20', async () => {
      const atCap = Array.from({ length: 20 }, (unused, index) => 3000 + index);
      const result = await handleCheckDevPorts({ taskId: 'task-1', ports: atCap }, context);
      expect(result.success).toBe(true);
    });

    it('refuses a non-array and says how to omit it', async () => {
      const result = await handleCheckDevPorts({ taskId: 'task-1', ports: 4200 }, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('array');
      expect(describeDevPorts).not.toHaveBeenCalled();
    });

    const badPorts: Array<[string, unknown]> = [
      ['a fraction', 80.5],
      ['zero', 0],
      ['negative', -1],
      ['above the port range', 65536],
      ['a numeric string', '4200'],
      ['null', null],
    ];

    for (const [label, value] of badPorts) {
      it(`refuses ${label} and probes nothing`, async () => {
        const result = await handleCheckDevPorts({ taskId: 'task-1', ports: [value] }, context);
        expect(result.success).toBe(false);
        expect(result.error).toContain('between 1 and 65535');
        expect(describeDevPorts).not.toHaveBeenCalled();
      });
    }

    it('names the offending entry so the agent can see what it sent', async () => {
      const result = await handleCheckDevPorts({ taskId: 'task-1', ports: [4200, 80.5] }, context);
      expect(result.error).toContain('80.5');
    });
  });
});
