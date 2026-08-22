import { reserveDevPorts, getDevPortsForTask } from '../../dev-ports/dev-port-allocator';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

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

  const rawCount = typeof params.count === 'number' ? params.count : 1;
  if (!Number.isFinite(rawCount) || rawCount < 1 || rawCount > MAX_PORTS_PER_REQUEST) {
    return {
      success: false,
      error: `count must be between 1 and ${MAX_PORTS_PER_REQUEST}. Ask for the ports you are about to bind, not a pool to draw from later.`,
    };
  }

  const ports = await reserveDevPorts(
    context.projectId,
    taskId,
    rawCount,
    context.getDevServerPortRange(),
  );

  if (ports.length === 0) {
    return {
      success: false,
      error: 'No free ports are available in the configured range. Widen it in Settings, or use your project\'s own configured ports.',
    };
  }

  const short = ports.length < rawCount;
  return {
    success: true,
    message: short
      ? `Reserved ${ports.length} of ${rawCount} requested ports: ${ports.join(', ')}. The range ran out - use your project's own configured ports for the rest.`
      : `Reserved ${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')} for this task. Nothing else on this machine will be given them.`,
    data: { ports, requested: rawCount, reserved: ports.length },
  };
};

/** Bounded so a single call cannot drain the range. */
const MAX_PORTS_PER_REQUEST = 10;

/** Read back what a task already holds, without reserving anything more. */
export const handleListDevPorts: CommandHandler = (
  params: Record<string, unknown>,
): CommandResponse => {
  const taskId = typeof params.taskId === 'string' && params.taskId ? params.taskId : null;
  if (!taskId) {
    return { success: false, error: 'taskId is required.' };
  }
  const ports = getDevPortsForTask(taskId);
  return {
    success: true,
    message: ports.length === 0
      ? 'This task has no reserved ports.'
      : `Reserved ports: ${ports.join(', ')}.`,
    data: { ports },
  };
};
