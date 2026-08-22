import { reserveDevPorts, getDevPortsForTask } from '../../dev-ports/dev-port-allocator';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

/** Bounded so a single call cannot drain the range. */
const MAX_PORTS_PER_REQUEST = 10;

/**
 * Reserve free dev-server ports.
 *
 * Kangentic does NOT decide what a project's ports should be - the project
 * already does, in angular.json, a vite config, a compose file. What it can do
 * that a project cannot is see across every task and every project on the
 * machine, so two agents starting servers at the same moment do not pick the
 * same number.
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
      error: 'No free ports are available in the configured range. Widen it in Settings, or use your project\'s own configured ports.',
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

/** Read back what a task already holds, without reserving anything more. */
export const handleListDevPorts: CommandHandler = (
  params: Record<string, unknown>,
): CommandResponse => {
  const taskId = typeof params.taskId === 'string' && params.taskId ? params.taskId : null;
  if (!taskId) {
    return { success: false, error: 'taskId is required. Resolve it with kangentic_get_current_task first.' };
  }
  const ports = getDevPortsForTask(taskId);
  return {
    success: true,
    message: ports.length === 0
      ? 'This task has no reserved ports. That is the normal state - reserve some with kangentic_reserve_dev_ports when you are about to start a server.'
      : `Reserved ports: ${ports.join(', ')}.`,
    data: { ports },
  };
};
