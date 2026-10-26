import {
  AGENT_UNAVAILABLE_ERROR_CODE,
  COMMAND_TERMINAL_LIMIT_ERROR_CODE,
  COMMAND_TERMINAL_START_FAILED_ERROR_CODE,
  CONVERSATION_GONE_ERROR_CODE,
  CONVERSATION_OPEN_ERROR_CODE,
  NOT_COMMAND_TERMINAL_ERROR_CODE,
  UNKNOWN_PROJECT_ERROR_CODE,
  UNKNOWN_SESSION_ERROR_CODE,
  parseCapabilityRequestPayload,
  type CapabilityErrorCode,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type CommandTerminalEarlierResponsePayload,
  type CommandTerminalStartResponsePayload,
  type CommandTerminalStopResponsePayload,
} from '@kangentic/protocol';
import {
  CommandTerminalStartError,
  startCommandTerminal,
  type CommandTerminalStartErrorCode,
} from '../../ipc/handlers/transient-sessions';
import { AgentCliNotFoundError } from '../../agent/shared/agent-cli-not-found';
import { commandTerminalDisplayName, commandTerminalHistoryName, commandTerminalSlotNumber } from '../../../shared/command-terminal-name';
import type { IpcContext } from '../../ipc/ipc-context';
import { resolveKnownProject } from './known-project';
import { toWireJson } from './wire-mappers';

/**
 * A refusal the phone shows by its code, one plain line per code, never by
 * parsing `error`. Returned rather than thrown: the router turns a throw into
 * a response with `error` only (capability-router.ts), which would drop it.
 */
function refuseWithCode(request: CapabilityRequestMessage, code: CapabilityErrorCode, error: string): CapabilityResponseMessage {
  return { type: 'capability-response', requestId: request.requestId, ok: false, error, code };
}

/**
 * The code a phone reads for each start refusal. A Record, so a refusal added
 * to `CommandTerminalStartErrorCode` fails typecheck here until it is mapped.
 * `slot-taken` cannot reach a phone (its start asks for no slot) and maps to
 * the generic failure. So does `spawn-failed`, a shell that did not start on
 * the desktop, which the phone can only report. The two conversation codes
 * come only from a `resume`.
 */
const START_REFUSAL_CODES: Record<CommandTerminalStartErrorCode, CapabilityErrorCode> = {
  'unknown-project': UNKNOWN_PROJECT_ERROR_CODE,
  'command-terminal-limit': COMMAND_TERMINAL_LIMIT_ERROR_CODE,
  'slot-taken': COMMAND_TERMINAL_START_FAILED_ERROR_CODE,
  'spawn-failed': COMMAND_TERMINAL_START_FAILED_ERROR_CODE,
  'conversation-gone': CONVERSATION_GONE_ERROR_CODE,
  'conversation-open': CONVERSATION_OPEN_ERROR_CODE,
};

/**
 * `command-terminal`: a phone starts, resumes or stops a Command Terminal, the
 * agent the desktop's Ctrl+Shift+P panel runs at a project's root, and lists
 * the ended conversations it can resume. Start and resume run the very
 * function the desktop's own Add terminal and Earlier list do
 * (`startCommandTerminal`), in its unattended form: same cap, slot, agent,
 * model, effort and default-branch checkout, with the git steps unable to
 * prompt or stall the answer. All of it works whether or not the project is
 * open on the desktop. Stop ends only a Command Terminal, through the same
 * `endCommandTerminal` the desktop's Stop uses.
 */
export async function handleCommandTerminal(
  request: CapabilityRequestMessage,
  context: IpcContext,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('command-terminal', request.payload);

  if (payload.action === 'stop') {
    const outcome = context.sessionManager.endCommandTerminal(payload.sessionId);
    if (outcome === 'not-found') {
      return refuseWithCode(request, UNKNOWN_SESSION_ERROR_CODE, `No live Command Terminal: ${payload.sessionId}`);
    }
    if (outcome === 'not-command-terminal') {
      console.warn(`[mobile-bridge] Command Terminal stop refused for ${payload.sessionId.slice(0, 8)}: not a Command Terminal`);
      return refuseWithCode(request, NOT_COMMAND_TERMINAL_ERROR_CODE, 'That session is not a Command Terminal.');
    }
    console.log(`[mobile-bridge] Command Terminal stopped from a phone: ${payload.sessionId.slice(0, 8)}`);
    const stopPayload: CommandTerminalStopResponsePayload = { ok: true };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(stopPayload) };
  }

  const project = resolveKnownProject(context, payload.projectId);
  if (!project) {
    return refuseWithCode(request, UNKNOWN_PROJECT_ERROR_CODE, `No such project: ${payload.projectId}`);
  }

  if (payload.action === 'list-earlier') {
    // The desktop panel's Earlier list, read from the same record: only
    // conversations that can still be resumed, none a live terminal holds.
    const entries = (await context.commandTerminalHistory?.list(project.projectId)) ?? [];
    const earlierPayload: CommandTerminalEarlierResponsePayload = {
      ok: true,
      projectId: project.projectId,
      conversations: entries.map((entry) => ({
        agentSessionId: entry.agentSessionId,
        // The words the desktop's row reads.
        name: commandTerminalHistoryName(entry),
        endedAt: entry.endedAt,
      })),
    };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(earlierPayload) };
  }

  const resumeAgentSessionId = payload.action === 'resume' ? payload.agentSessionId : undefined;
  try {
    // Answered once the session exists, before the agent has drawn anything:
    // the phone opens the terminal's screen now and watches it arrive.
    const result = await startCommandTerminal(context, {
      projectId: project.projectId,
      unattended: true,
      ...(resumeAgentSessionId !== undefined ? { resumeAgentSessionId } : {}),
    });
    const slotNumber = commandTerminalSlotNumber(result.slot);
    if (slotNumber === null) throw new Error(`Command Terminal started with an unnumbered slot: ${result.slot}`);
    const verb = resumeAgentSessionId !== undefined ? 'resumed' : 'started';
    console.log(`[mobile-bridge] Command Terminal ${verb} from a phone: ${result.session.id.slice(0, 8)} in slot ${slotNumber}`);
    const startPayload: CommandTerminalStartResponsePayload = {
      ok: true,
      sessionId: result.session.id,
      slot: slotNumber,
      name: commandTerminalDisplayName(result.session.commandTerminalLabel, result.slot),
    };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(startPayload) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mobile-bridge] Command Terminal ${payload.action} refused in ${payload.projectId.slice(0, 8)}: ${message}`);
    if (error instanceof CommandTerminalStartError) return refuseWithCode(request, START_REFUSAL_CODES[error.code], message);
    if (error instanceof AgentCliNotFoundError) return refuseWithCode(request, AGENT_UNAVAILABLE_ERROR_CODE, message);
    return refuseWithCode(request, COMMAND_TERMINAL_START_FAILED_ERROR_CODE, message);
  }
}
