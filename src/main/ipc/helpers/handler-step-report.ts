/**
 * A step inside an IPC handler that failed while the handler carried on.
 *
 * The IPC wrap (`analytics/ipc-handler-report.ts`) reports what a handler THROWS. A handler
 * that catches a step's failure, logs it and goes on answers the renderer as though the whole
 * request worked, so neither the wrap nor the user hears of it: a project relocated with every
 * worktree's git left broken, MCP tools missing from a project's agents, a promoted task with no
 * agent, a base branch that was never recorded. Those steps report here.
 *
 * Tags are `area` (which handler family: `projects`, `backlog`, `archive`, `relocate`, `branch`,
 * `handoff`, `command_terminal`, ...) and `step` (which step), both fixed words. Never a channel
 * argument, a task or project name, a branch or a path.
 *
 * Where a handler has a reporter of its own (`taskMoveReporter`, `sessionHandlersReporter`,
 * `recoveryReporter`), a new step goes there under a `stage` tag. This one is for the handler
 * families that have none, so that a swallowed step does not mint a reporter per file.
 *
 * A step that is swallowed and then followed by something destructive is not a case for this
 * reporter alone: stop before the destructive step, or rethrow into the handler's own rollback so
 * the wrap reports it and the user sees the failure.
 */

import { createChokepointReporter, type ChokepointReporter } from '../../analytics/handled-report';

export const handlerStepReporter: ChokepointReporter = createChokepointReporter('handler_step');

// The guard for a catch whose common failure is another program's plain Error. It lives
// beside the reporter it guards (`analytics/handled-report.ts`), and is exported from here
// too, where the handlers that use it already import.
export { isDefectOrEnvironmentFailure } from '../../analytics/handled-report';
