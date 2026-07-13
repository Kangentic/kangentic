import { isRecord, parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type JsonValue, type BoardToolResponsePayload } from '@kangentic/protocol';
import { commandHandlers } from '../../agent/commands';
import { buildCommandContextForProject } from '../../agent/mcp-project-context';
import type { IpcContext } from '../../ipc/ipc-context';
import { isBoardToolAllowedForVerb } from './board-tool-allowlist';
import { toWireJson } from './wire-mappers';

/**
 * Routes a phone's board-tool-read/board-tool-write request straight into
 * the same `commandHandlers` registry (src/main/agent/commands/index.ts)
 * the MCP HTTP server also dispatches into - the exact same handlers and
 * board-mutation side-effect fan-out (buildCommandContextForProject's
 * callbacks, which also feed the consolidated board-changed bus). This is
 * NOT the MCP protocol: no agent, LLM, or JSON-RPC round-trip happens
 * anywhere in this call - it is a direct function call, the same as every
 * other capability handler, reusing `commandHandlers` instead of
 * re-deriving the `register*Tools` layer's zod schemas / defaulting / rate
 * limiting / LLM-facing prose formatting. `tool` is the internal
 * commandHandlers key (e.g. 'create_task'), not the public
 * 'kangentic_create_task' MCP name - see board-tool-allowlist.ts's doc
 * comment for why, and for why move_task/list_tasks/list_columns/
 * list_backlog are excluded here (covered by the dedicated move-task/
 * read-board verbs instead, so there is exactly one path per capability).
 */
export async function handleBoardTool(
  request: CapabilityRequestMessage,
  context: IpcContext,
): Promise<CapabilityResponseMessage> {
  const verb = request.verb as 'board-tool-read' | 'board-tool-write';
  const payload = parseCapabilityRequestPayload(verb, request.payload);

  if (!isBoardToolAllowedForVerb(payload.tool, verb)) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `Tool not allowed for ${verb}: ${payload.tool}` };
  }
  if (!isRecord(payload.params)) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: '"params" must be an object' };
  }

  const projectId = (typeof payload.params.project === 'string' ? payload.params.project : undefined)
    ?? context.currentProjectId
    ?? undefined;
  if (!projectId) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No project is currently open and no project was specified' };
  }
  const commandContext = buildCommandContextForProject(context, projectId);
  if (!commandContext) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such project: ${projectId}` };
  }

  const handler = commandHandlers[payload.tool];
  const response = await handler(payload.params, commandContext);

  if (!response.success) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: response.error ?? response.message ?? 'Tool call failed' };
  }

  const responsePayload: BoardToolResponsePayload = { result: response.data as unknown as JsonValue };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
}
