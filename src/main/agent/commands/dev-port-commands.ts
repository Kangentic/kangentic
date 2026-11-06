import {
  reserveDevPorts,
  getDevPortsForTask,
  describeDevPorts,
  type DevPortStatus,
} from '../../dev-ports/dev-port-allocator';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import { TaskRepository } from '../../db/repositories/task-repository';
import { HOST_NOT_AVAILABLE } from '../../remote/host-transfer';
import { getPortForwardPlan } from '../../remote/port-forward-plan';
import type { PortForwardStatus } from '../../remote/protocol/messages';
import { resolveTask } from './task-resolver';

/** Bounded so a single call cannot drain the range. */
const MAX_PORTS_PER_REQUEST = 10;

/**
 * Bounded because checking PROBES, and probing a FREE port momentarily binds it
 * (see isPortFree's race note). NOT for time: 20 ports measures at ~15ms, so
 * this is a blast-radius cap, not a latency one. A caller should be naming the
 * ports it is about to bind, and twenty is already generous for that.
 */
const MAX_PORTS_PER_QUERY = 20;

const MAX_PORT_NUMBER = 65535;

/**
 * The task a port call is about: the one `taskId` names (a `#N` display id or
 * a UUID), else the caller's own (task #952). Always the task's UUID, the key
 * the ledger is held under: a display id used as the key reserved ports under
 * a task that does not exist.
 */
function resolvePortTask(params: Record<string, unknown>, context: CommandContext): { taskId: string } | { error: string } {
  // `resolveTask` reads a `#N` display id as well as a bare one.
  const named = typeof params.taskId === 'string' && params.taskId.trim() ? params.taskId.trim() : null;
  const lookup = named ?? context.callerTaskId ?? null;
  if (!lookup) return { error: 'taskId is required here: this call comes from no task. Resolve it with kangentic_get_current_task first.' };
  const task = resolveTask(new TaskRepository(context.getProjectDb()), lookup);
  if (!task) {
    return { error: named ? `No task found for "${named}" in this project.` : 'Your own task is not in this project. Pass taskId, or the project your task is in.' };
  }
  return { taskId: task.id };
}

/**
 * Reserve free dev-server ports.
 *
 * Kangentic does NOT decide what a project's ports should be - the project
 * already does, in angular.json, a vite config, a compose file. What it can do
 * that a project cannot is see across every task and every project at once, so
 * two agents starting servers at the same moment do not pick the same number.
 *
 * So this is a question, not an assignment: "give me N ports nothing else is
 * using." Nothing is reserved until something asks, and a caller that already
 * knows its ports never needs to.
 */
export const handleReserveDevPorts: CommandHandler = async (
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> => {
  const resolved = resolvePortTask(params, context);
  if ('error' in resolved) return { success: false, error: resolved.error };
  const { taskId } = resolved;

  // Rejected rather than coerced, and the offending value is named. Flooring
  // 2.5 to 2 would hand back one fewer port than asked for with nothing in the
  // response to say why, and a caller that binds three servers would then
  // collide on the third.
  const count = params.count === undefined ? 1 : params.count;
  if (
    typeof count !== 'number'
    || !Number.isInteger(count)
    || count < 1
    || count > MAX_PORTS_PER_REQUEST
  ) {
    return {
      success: false,
      error: `count must be a whole number between 1 and ${MAX_PORTS_PER_REQUEST}; got ${JSON.stringify(count)}. Ask for the ports you are about to bind, not a pool to draw from later.`,
    };
  }

  // A port must be free where the server binds it and where its forward does, and this computer's probe sees only
  // the second. A host that cannot say reserves nothing: an unknown is not a free port.
  const plan = getPortForwardPlan();
  const onHost = plan?.hostOfProject(context.projectId) != null;
  let takenOnHost: Set<number> | null = null;
  if (onHost) {
    const read = await readHostListening(context);
    if ('error' in read) return { success: false, error: `No ports were reserved, because the host's listening ports could not be read: ${read.error}` };
    takenOnHost = read.ports;
  }

  const range = context.getDevServerPortRange();
  const ports = await reserveDevPorts(
    context.projectId,
    taskId,
    count,
    takenOnHost ? { ...range, takenOnHost } : range,
  );

  if (ports.length === 0) {
    return {
      success: false,
      error: 'No free ports are available in the configured range. Use your project\'s own configured ports instead - retrying will not help, since nothing releases a port until its task or project is deleted. The range is `devServer.portRangeStart` / `devServer.portRangeEnd` in the global config.json; there is no Settings UI for it.',
    };
  }

  // A project on an SSH host runs its server there. The number is reserved on the user's computer (the
  // ledger and the bind probe are theirs), and Kangentic carries it from the host to the same number here
  // once a server listens on it there (`port-forward-plan.ts`), so localhost and the Browser pane reach it.
  if (onHost) await plan?.syncNow();
  const hostNote = onHost
    ? ' This project runs on a remote host: start your server there on exactly this port. Kangentic forwards it to the same port on the user\'s computer as soon as the server is listening (within a few seconds), so http://localhost:<port> on their computer and the Browser pane reach it. Confirm with kangentic_check_dev_ports.'
    : '';
  const exclusive = onHost
    ? 'They are free on the host and on the user\'s computer, and no other task will be given them.'
    : 'Nothing else on this machine will be given them.';
  return {
    success: true,
    message: (ports.length < count
      ? `Reserved ${ports.length} of ${count} requested ports: ${ports.join(', ')}. The range ran out - use your project's own configured ports for the rest.`
      : `Reserved ${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')} for this task. ${exclusive}`) + hostNote,
    data: { ports, requested: count, reserved: ports.length, location: onHost ? 'host' : 'local', ...(onHost ? { onRemoteHost: true } : {}) },
  };
};

/** The ports a server on the project's host listens on, or why that could not be read. Never an empty list for "unknown". */
async function readHostListening(context: CommandContext): Promise<{ ports: Set<number> } | { error: string }> {
  const access = context.hostAccess?.() ?? null;
  if (!access) return { error: HOST_NOT_AVAILABLE };
  try {
    return { ports: new Set(await access.listeningPorts()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** One forwarded port, in the words the agent should act on. */
function describeForward(forward: PortForwardStatus): string {
  if (forward.state === 'forwarding') {
    return `${forward.port} (forwarding: http://localhost:${forward.port} on the user's computer reaches your server at http://localhost:${forward.port} on the host)`;
  }
  if (forward.state === 'blocked') return `${forward.port} (blocked: ${forward.detail ?? 'ssh could not forward it'})`;
  return `${forward.port} (waiting: nothing is listening on the host yet)`;
}

/**
 * One port on a project whose servers run on a host. The host says whether a server is up: on this computer the
 * port may be held by the forward's own `ssh`, which keeps listening after the server stops. A host that could not
 * be read leaves the answer unknown, never free.
 */
function describeHostStatus(status: DevPortStatus, onHost: boolean | null): string {
  if (onHost === null) return `${status.port} (unknown: the host's listening ports could not be read)`;
  const notForwarded = 'not reserved, so it is not forwarded and the Browser pane cannot reach it';
  if (status.reservation === 'this-task') {
    return onHost ? `${status.port} (yours, server running on the host)` : `${status.port} (yours, nothing listening on the host - free to start on)`;
  }
  if (status.reservation === 'other-task') {
    return onHost ? `${status.port} (reserved by another task, server running on the host - do not use)` : `${status.port} (reserved by another task - do not use)`;
  }
  if (onHost) return `${status.port} (a server is running on the host, ${notForwarded})`;
  if (status.listening) return `${status.port} (IN USE on the user's computer by something outside Kangentic, so a forward of it would fail)`;
  return `${status.port} (free on the host and the user's computer - not reserved, nothing listening)`;
}

/** One port's two-source answer, in the words the agent should act on. */
function describeStatus(status: DevPortStatus): string {
  if (status.reservation === 'this-task') {
    return status.listening
      ? `${status.port} (yours, server running)`
      : `${status.port} (yours, nothing listening - free to start on)`;
  }
  if (status.reservation === 'other-task') {
    return status.listening
      ? `${status.port} (reserved by another task, server running - do not use)`
      : `${status.port} (reserved by another task - do not use)`;
  }
  return status.listening
    ? `${status.port} (IN USE by something outside Kangentic - not reserved here, but taken)`
    : `${status.port} (free - not reserved, nothing listening)`;
}

/**
 * Report what a task holds AND what the machine says about it.
 *
 * Reading the ledger alone answers "what did Kangentic hand out", which is
 * silent about the case that actually bites: a dev server the user started
 * outside Kangentic entirely, on a port the ledger has never heard of. So every
 * port reported here is probed, and `ports` lets a caller ask about numbers it
 * did not get from Kangentic - the project's own configured 4200, say - which
 * is the only way to find that out short of trying to bind and failing.
 *
 * Reserves nothing, ever. A caller that finds a port taken reserves a different
 * one with kangentic_reserve_dev_ports.
 */
export const handleCheckDevPorts: CommandHandler = async (
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> => {
  const resolved = resolvePortTask(params, context);
  if ('error' in resolved) return { success: false, error: resolved.error };
  const { taskId } = resolved;

  const requested = params.ports === undefined ? [] : params.ports;
  if (!Array.isArray(requested)) {
    return {
      success: false,
      error: `ports must be an array of port numbers; got ${JSON.stringify(requested)}. Omit it to report only this task's own reservations.`,
    };
  }
  if (requested.length > MAX_PORTS_PER_QUERY) {
    return {
      success: false,
      error: `ports may name at most ${MAX_PORTS_PER_QUERY} ports; got ${requested.length}. Each one is probed, so ask about the ports you are about to bind.`,
    };
  }
  for (const port of requested) {
    if (
      typeof port !== 'number'
      || !Number.isInteger(port)
      || port < 1
      || port > MAX_PORT_NUMBER
    ) {
      return {
        success: false,
        error: `ports must contain whole numbers between 1 and ${MAX_PORT_NUMBER}; got ${JSON.stringify(port)}.`,
      };
    }
  }

  const held = getDevPortsForTask(taskId);
  // Deduplicated so asking about a port you already hold does not probe twice,
  // and so the response has one row per port rather than two disagreeing ones.
  const toProbe = [...new Set([...held, ...(requested as number[])])].sort((a, b) => a - b);

  if (toProbe.length === 0) {
    return {
      success: true,
      message: 'This task has no reserved ports. That is the normal state - reserve some with kangentic_reserve_dev_ports when you are about to start a server, or pass `ports` here to check whether specific ones are free.',
      data: { ports: [], statuses: [] },
    };
  }

  // On a project that runs on an SSH host a port has two ends, and the server's is the host's.
  const plan = getPortForwardPlan();
  const hostId = plan?.hostOfProject(context.projectId) ?? null;
  const hostRead = hostId ? await readHostListening(context) : null;
  const listeningOnHost = (port: number): boolean | null => {
    if (!hostRead || 'error' in hostRead) return null;
    return hostRead.ports.has(port);
  };

  const statuses = await describeDevPorts(taskId, toProbe);
  const mine = statuses.filter((status) => status.reservation === 'this-task');
  const others = statuses.filter((status) => status.reservation !== 'this-task');
  const describe = (status: DevPortStatus): string => (hostId ? describeHostStatus(status, listeningOnHost(status.port)) : describeStatus(status));

  const lines: string[] = [];
  if (mine.length > 0) {
    lines.push(`Reserved by this task: ${mine.map(describe).join(', ')}.`);
  } else {
    lines.push('This task has no reserved ports, which is the normal state.');
  }
  if (others.length > 0) {
    lines.push(`Also checked: ${others.map(describe).join(', ')}.`);
  }

  // Whether each of the task's ports reaches the user's computer.
  const forwards = hostId && plan ? await plan.statusOf(hostId) : [];
  const forwardsOfMine = forwards.filter((forward) => mine.some((status) => status.port === forward.port));
  if (hostId && forwardsOfMine.length > 0) {
    lines.push(`Forwarded from the host to the user's computer: ${forwardsOfMine.map(describeForward).join(', ')}.`);
  }
  if (hostRead && 'error' in hostRead) lines.push(`The host's listening ports could not be read: ${hostRead.error}`);

  return {
    success: true,
    message: lines.join(' '),
    // `ports` stays the task's own reservations so a caller reading just that
    // field gets what it always got; `statuses` is the two-source answer.
    data: {
      ports: held,
      location: hostId ? 'host' : 'local',
      ...(hostId
        ? {
            // `host` null means it could not be read, never that nothing listens.
            statuses: statuses.map((status) => ({ ...status, listening: { local: status.listening, host: listeningOnHost(status.port) } })),
            forwards: forwardsOfMine.map((forward) => ({
              ...forward,
              localUrl: `http://localhost:${forward.port}`,
              hostUrl: `http://localhost:${forward.port}`,
            })),
          }
        : { statuses }),
    },
  };
};
