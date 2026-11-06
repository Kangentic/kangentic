import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setPortForwardPlan, type PortForwardPlan } from '../../src/main/remote/port-forward-plan';
import type { PortForwardStatus } from '../../src/main/remote/protocol/messages';
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

/**
 * The project's tasks, by what a caller may name them: `task-1` is #1, and
 * `caller-task` is the task whose agent makes the call. resolveTask's own
 * display-id-or-UUID rule, `#` included, is pinned in task-resolver's tests.
 */
const TASKS_BY_NAME: Record<string, { id: string }> = {
  'task-1': { id: 'task-1' },
  '1': { id: 'task-1' },
  '#1': { id: 'task-1' },
  'caller-task': { id: 'caller-task' },
};
vi.mock('../../src/main/agent/commands/task-resolver', () => ({
  resolveTask: (_repository: unknown, taskId: string) => TASKS_BY_NAME[taskId],
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
  getProjectDb: () => ({}),
  getProjectPath: () => '/projects/local',
  getDevServerPortRange: () => ({ rangeStart: 7300, rangeEnd: 7499 }),
} as unknown as CommandContext;

/** The same project, asked by the agent of `caller-task`. */
const callerContext = { ...context, callerTaskId: 'caller-task' } as unknown as CommandContext;

beforeEach(() => {
  reserveDevPorts.mockReset();
  getDevPortsForTask.mockReset();
  describeDevPorts.mockReset();
  reserveDevPorts.mockResolvedValue([7300]);
  getDevPortsForTask.mockReturnValue([]);
  describeDevPorts.mockResolvedValue([]);
});

describe('dev ports on a project that runs on an SSH host', () => {
  const syncNow = vi.fn(async () => undefined);
  const statusOf = vi.fn(async (): Promise<PortForwardStatus[]> => []);
  const listeningPorts = vi.fn(async (): Promise<number[]> => []);
  const hostContext = { ...context, hostAccess: () => ({ hostId: 'host-a', listeningPorts }) } as unknown as CommandContext;

  beforeEach(() => {
    syncNow.mockClear();
    statusOf.mockReset();
    statusOf.mockResolvedValue([]);
    listeningPorts.mockReset();
    listeningPorts.mockResolvedValue([]);
    setPortForwardPlan({
      hostOfProject: (projectId: string) => (projectId === 'proj-1' ? 'host-a' : null),
      syncNow,
      statusOf,
    } as unknown as PortForwardPlan);
  });

  afterEach(() => setPortForwardPlan(null));

  it('tells the agent to start its server on the host, that the port will reach the user\'s computer, and to confirm it', async () => {
    const result = await handleReserveDevPorts({ taskId: 'task-1' }, hostContext);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Reserved port 7300');
    expect(result.message).toContain('forwards it to the same port on the user\'s computer');
    expect(result.message).toContain('kangentic_check_dev_ports');
    expect(result.data).toMatchObject({ ports: [7300], onRemoteHost: true, location: 'host' });
    // The forward is asked for before the answer, so the agent's first check already sees it.
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it('never hands out a port a server on the host listens on', async () => {
    listeningPorts.mockResolvedValue([7300, 7301]);

    await handleReserveDevPorts({ taskId: 'task-1' }, hostContext);

    const options = reserveDevPorts.mock.calls[0][3] as { takenOnHost: ReadonlySet<number>; rangeStart: number };
    expect([...options.takenOnHost]).toEqual([7300, 7301]);
    expect(options.rangeStart).toBe(7300);
  });

  it('says the ports are free on both sides, and no longer that they are free on one machine', async () => {
    const result = await handleReserveDevPorts({ taskId: 'task-1' }, hostContext);

    expect(result.message).toContain('free on the host and on the user\'s computer');
    expect(result.message).not.toContain('on this machine');
  });

  it('reserves nothing when the host cannot say what it is listening on', async () => {
    listeningPorts.mockRejectedValue(new Error('the link is down'));

    const result = await handleReserveDevPorts({ taskId: 'task-1' }, hostContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('the link is down');
    expect(reserveDevPorts).not.toHaveBeenCalled();
  });

  it('reserves nothing when the project has no way to its host', async () => {
    const result = await handleReserveDevPorts({ taskId: 'task-1' }, context);

    expect(result.success).toBe(false);
    expect(reserveDevPorts).not.toHaveBeenCalled();
  });

  it('says nothing of a host for a project on this computer', async () => {
    const result = await handleReserveDevPorts({ taskId: 'task-1' }, { ...context, projectId: 'local-1' } as unknown as CommandContext);

    expect(result.message).not.toContain('remote host');
    expect(result.data).toEqual({ ports: [7300], requested: 1, reserved: 1, location: 'local' });
    expect(syncNow).not.toHaveBeenCalled();
  });

  it('reports where each of the task\'s ports stands when it is checked', async () => {
    getDevPortsForTask.mockReturnValue([7300, 7301, 7302]);
    describeDevPorts.mockResolvedValue([status(7300, 'this-task', true), status(7301, 'this-task', false), status(7302, 'this-task', false)]);
    statusOf.mockResolvedValue([
      { port: 7300, state: 'forwarding' },
      { port: 7301, state: 'waiting' },
      { port: 7302, state: 'blocked', detail: 'Port 7302 is already in use on this computer.' },
    ]);
    listeningPorts.mockResolvedValue([7300]);

    const result = await handleCheckDevPorts({ taskId: 'task-1' }, hostContext);

    expect(result.message).toContain('7300 (forwarding: http://localhost:7300 on the user\'s computer reaches your server at http://localhost:7300 on the host)');
    expect(result.message).toContain('7301 (waiting: nothing is listening on the host yet)');
    expect(result.message).toContain('7302 (blocked: Port 7302 is already in use on this computer.)');
    const forwards = (result.data as { forwards: Array<Record<string, unknown>> }).forwards;
    expect(forwards).toHaveLength(3);
    expect(forwards[0]).toMatchObject({ localUrl: 'http://localhost:7300', hostUrl: 'http://localhost:7300' });
  });

  it('returns both ends of a port, and judges a server by the host, since a forward keeps listening here after it stops', async () => {
    getDevPortsForTask.mockReturnValue([7300]);
    // The forward's own ssh holds 7300 on this computer, and nothing listens on the host any more.
    describeDevPorts.mockResolvedValue([status(7300, 'this-task', true)]);

    const result = await handleCheckDevPorts({ taskId: 'task-1' }, hostContext);

    expect(result.message).toContain('7300 (yours, nothing listening on the host - free to start on)');
    const statuses = (result.data as { statuses: Array<{ listening: unknown }> }).statuses;
    expect(statuses[0].listening).toEqual({ local: true, host: false });
    expect(result.data).toMatchObject({ location: 'host' });
  });

  it('tells an agent a server it started on a port it did not reserve is out of the Browser pane\'s reach', async () => {
    describeDevPorts.mockResolvedValue([status(4200, null, false)]);
    listeningPorts.mockResolvedValue([4200]);

    const result = await handleCheckDevPorts({ taskId: 'task-1', ports: [4200] }, hostContext);

    expect(result.message).toContain('4200 (a server is running on the host, not reserved, so it is not forwarded');
  });

  it('calls a port free only when both sides are', async () => {
    describeDevPorts.mockResolvedValue([status(4200, null, false), status(4201, null, true)]);
    listeningPorts.mockResolvedValue([]);

    const result = await handleCheckDevPorts({ taskId: 'task-1', ports: [4200, 4201] }, hostContext);

    expect(result.message).toContain('4200 (free on the host and the user\'s computer');
    expect(result.message).toContain('4201 (IN USE on the user\'s computer');
  });

  it('never reads a host it could not ask as free', async () => {
    getDevPortsForTask.mockReturnValue([7300]);
    describeDevPorts.mockResolvedValue([status(7300, 'this-task', false)]);
    listeningPorts.mockRejectedValue(new Error('the link is down'));

    const result = await handleCheckDevPorts({ taskId: 'task-1' }, hostContext);

    expect(result.message).toContain('7300 (unknown');
    expect(result.message).toContain('the link is down');
    expect(result.message).not.toContain('free to start on');
    const statuses = (result.data as { statuses: Array<{ listening: unknown }> }).statuses;
    expect(statuses[0].listening).toEqual({ local: false, host: null });
  });

  it('adds nothing about forwarding when a local project is checked', async () => {
    getDevPortsForTask.mockReturnValue([7300]);
    describeDevPorts.mockResolvedValue([status(7300, 'this-task', true)]);

    const result = await handleCheckDevPorts({ taskId: 'task-1' }, { ...context, projectId: 'local-1' } as unknown as CommandContext);

    expect(result.message).not.toContain('Forwarded');
    expect(result.data).not.toHaveProperty('forwards');
    expect(statusOf).not.toHaveBeenCalled();
  });
});

describe('handleReserveDevPorts', () => {
  it('reserves one port by default', async () => {
    const result = await handleReserveDevPorts({ taskId: 'task-1' }, context);
    expect(result.success).toBe(true);
    expect(reserveDevPorts).toHaveBeenCalledWith('proj-1', 'task-1', 1, { rangeStart: 7300, rangeEnd: 7499 });
    expect(result.data).toEqual({ ports: [7300], requested: 1, reserved: 1, location: 'local' });
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
      getProjectDb: () => ({}),
      getProjectPath: () => '/projects/local',
      getDevServerPortRange: () => ({ rangeStart: 9000, rangeEnd: 9010 }),
    } as unknown as CommandContext;
    await handleReserveDevPorts({ taskId: 'task-1', count: 2 }, narrow);
    expect(reserveDevPorts).toHaveBeenCalledWith('proj-1', 'task-1', 2, { rangeStart: 9000, rangeEnd: 9010 });
  });

  it('names the tool that resolves a missing taskId, for a caller with no task', async () => {
    const result = await handleReserveDevPorts({}, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('kangentic_get_current_task');
    expect(reserveDevPorts).not.toHaveBeenCalled();
  });

  // Task #952: an agent asked with its own task's display id, which the ledger
  // took as the key, so the ports were held by no task. And it had to look its
  // own task up first.
  it('reserves under the task\'s UUID when it is named by display id, with or without #', async () => {
    await handleReserveDevPorts({ taskId: '1' }, context);
    await handleReserveDevPorts({ taskId: '#1' }, context);
    expect(reserveDevPorts.mock.calls.map((call) => call[1])).toEqual(['task-1', 'task-1']);
  });

  it('defaults to the caller\'s own task, and a named task still wins', async () => {
    await handleReserveDevPorts({}, callerContext);
    await handleReserveDevPorts({ taskId: 'task-1' }, callerContext);
    expect(reserveDevPorts.mock.calls.map((call) => call[1])).toEqual(['caller-task', 'task-1']);
  });

  it('refuses a task that is not in this project, naming what it was given', async () => {
    const result = await handleReserveDevPorts({ taskId: '99' }, context);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('"99"') });
    expect(reserveDevPorts).not.toHaveBeenCalled();
  });

  it('reserves several at once and reports them all', async () => {
    reserveDevPorts.mockResolvedValue([7300, 7301, 7302]);
    const result = await handleReserveDevPorts({ taskId: 'task-1', count: 3 }, context);
    expect(result.success).toBe(true);
    expect(result.message).toContain('7300, 7301, 7302');
    expect(result.data).toEqual({ ports: [7300, 7301, 7302], requested: 3, reserved: 3, location: 'local' });
  });

  it('says so when the range ran out mid-request, and still returns what it got', async () => {
    // A SHORT result is a success, not an error: the caller uses its own
    // configured ports for the rest. The message has to say that, or an agent
    // reads three ports where two were handed out.
    reserveDevPorts.mockResolvedValue([7300, 7301]);
    const result = await handleReserveDevPorts({ taskId: 'task-1', count: 3 }, context);
    expect(result.success).toBe(true);
    expect(result.message).toContain('2 of 3');
    expect(result.data).toEqual({ ports: [7300, 7301], requested: 3, reserved: 2, location: 'local' });
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
  it('reads the caller\'s own task when none is named, and resolves a display id to the UUID', async () => {
    await handleCheckDevPorts({}, callerContext);
    await handleCheckDevPorts({ taskId: '1' }, context);
    expect(getDevPortsForTask.mock.calls.map((call) => call[0])).toEqual(['caller-task', 'task-1']);
  });

  it('probes what the task holds, and never reserves', async () => {
    getDevPortsForTask.mockReturnValue([7300, 7301]);
    describeDevPorts.mockResolvedValue([status(7300, 'this-task', true), status(7301, 'this-task', false)]);

    const result = await handleCheckDevPorts({ taskId: 'task-1' }, context);

    expect(result.success).toBe(true);
    expect(describeDevPorts).toHaveBeenCalledWith('task-1', [7300, 7301]);
    expect(reserveDevPorts).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      ports: [7300, 7301],
      location: 'local',
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
