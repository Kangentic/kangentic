import {
  reserveDevPorts,
  getDevPortsForTask,
  describeDevPorts,
  type DevPortStatus,
} from '../../dev-ports/dev-port-allocator';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

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
  const taskId = typeof params.taskId === 'string' && params.taskId ? params.taskId : null;
  if (!taskId) {
    return { success: false, error: 'taskId is required. Resolve it with kangentic_get_current_task first.' };
  }

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

  const ports = await reserveDevPorts(
    context.projectId,
    taskId,
    count,
    context.getDevServerPortRange(),
  );

  if (ports.length === 0) {
    return {
      success: false,
      error: 'No free ports are available in the configured range. Use your project\'s own configured ports instead - retrying will not help, since nothing releases a port until its task or project is deleted. The range is `devServer.portRangeStart` / `devServer.portRangeEnd` in the global config.json; there is no Settings UI for it.',
    };
  }

  return {
    success: true,
    message: ports.length < count
      ? `Reserved ${ports.length} of ${count} requested ports: ${ports.join(', ')}. The range ran out - use your project's own configured ports for the rest.`
      : `Reserved ${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')} for this task. Nothing else on this machine will be given them.`,
    data: { ports, requested: count, reserved: ports.length },
  };
};

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
): Promise<CommandResponse> => {
  const taskId = typeof params.taskId === 'string' && params.taskId ? params.taskId : null;
  if (!taskId) {
    return { success: false, error: 'taskId is required. Resolve it with kangentic_get_current_task first.' };
  }

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

  const statuses = await describeDevPorts(taskId, toProbe);
  const mine = statuses.filter((status) => status.reservation === 'this-task');
  const others = statuses.filter((status) => status.reservation !== 'this-task');

  const lines: string[] = [];
  if (mine.length > 0) {
    lines.push(`Reserved by this task: ${mine.map(describeStatus).join(', ')}.`);
  } else {
    lines.push('This task has no reserved ports, which is the normal state.');
  }
  if (others.length > 0) {
    lines.push(`Also checked: ${others.map(describeStatus).join(', ')}.`);
  }

  return {
    success: true,
    message: lines.join(' '),
    // `ports` stays the task's own reservations so a caller reading just that
    // field gets what it always got; `statuses` is the two-source answer.
    data: { ports: held, statuses },
  };
};
