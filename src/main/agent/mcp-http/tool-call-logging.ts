/**
 * Diagnostic logging for MCP tool-call arguments received by the HTTP server.
 *
 * Extracted from mcp-http-server.ts so that the logging logic can be imported
 * and unit-tested without pulling in the heavy server module graph
 * (@modelcontextprotocol/sdk, all register*Tools, devtools/mcp/register).
 *
 * This module has NO runtime dependencies beyond the Node.js built-ins
 * already available in the main process. Keep it that way.
 */

/**
 * Description length (characters) at or above which a create_task /
 * update_task whose received arguments are MISSING `labels` is logged at
 * warn level. This is the empirical signature of the upstream "labels
 * dropped on a large description" bug (task #229): roughly 1KB.
 */
export const LARGE_DESCRIPTION_WARN_THRESHOLD = 1000;

/** The two tools whose received arguments this module inspects. */
export type InspectedToolName = 'kangentic_create_task' | 'kangentic_update_task';

/**
 * Per-request record of what `logMcpToolArguments` noticed about the RAW
 * arguments, so the tool layer can tell the calling agent something the
 * console warn alone never reached it with.
 *
 * `labelsAbsentWithLargeDescription` maps a tool name to the description
 * length that triggered it. Keyed by tool because one batch body can carry
 * both a create and an update. Note the keying is per TOOL, not per message:
 * a batch carrying two creates, only one of which tripped, reports the notice
 * on both. Distinguishing them would need request-id keying through the SDK,
 * and a batch of same-tool calls is not a shape any client emits today.
 *
 * The distinction this exists to preserve is ABSENT vs EMPTY: by the time
 * arguments reach a handler, Kangentic has normalized a missing field to null
 * and "the client never sent labels" is indistinguishable from "the caller
 * deliberately sent none". Only the raw body knows, which is why the signal
 * has to ride from here rather than be re-derived downstream.
 */
export interface ToolArgumentNotices {
  labelsAbsentWithLargeDescription: Partial<Record<InspectedToolName, number>>;
}

/** Build an empty notices record for one HTTP request. */
export function createToolArgumentNotices(): ToolArgumentNotices {
  return { labelsAbsentWithLargeDescription: {} };
}

/**
 * Diagnostic for the "labels dropped on a large description" bug
 * (task #229). Logs the arguments that actually arrived in the request body
 * for kangentic_create_task / kangentic_update_task, BEFORE Kangentic's tool
 * callback normalizes a missing field to null. If `labels` is absent from
 * the received arguments while the description is large, the drop happened
 * upstream in the MCP client's tool-call emission, not in Kangentic, and no
 * handler or transport change can recover it.
 *
 * The body may be a single JSON-RPC message object OR a batch (array of
 * messages). Both are handled: arrays are iterated, non-arrays are wrapped
 * in a single-element list.
 *
 * Silent skip conditions (no log, no throw):
 *   - message is not a non-null object
 *   - message.method !== 'tools/call'
 *   - params is missing or not an object
 *   - params.name is neither 'kangentic_create_task' nor 'kangentic_update_task'
 */
export function logMcpToolArguments(parsedBody: unknown, notices?: ToolArgumentNotices): void {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if ((message as { method?: unknown }).method !== 'tools/call') continue;
    const params = (message as { params?: unknown }).params;
    if (!params || typeof params !== 'object') continue;
    const toolName = (params as { name?: unknown }).name;
    if (toolName !== 'kangentic_create_task' && toolName !== 'kangentic_update_task') continue;
    const rawArguments = (params as { arguments?: unknown }).arguments;
    const argumentsObject = rawArguments && typeof rawArguments === 'object'
      ? (rawArguments as Record<string, unknown>)
      : {};
    const argumentKeys = Object.keys(argumentsObject);
    const hasLabels = 'labels' in argumentsObject;
    const description = argumentsObject.description;
    const descriptionLength = typeof description === 'string' ? description.length : 0;
    if (!hasLabels && descriptionLength >= LARGE_DESCRIPTION_WARN_THRESHOLD) {
      // Record before logging so a console failure cannot cost the caller the
      // in-response notice, which is the only form of this signal an agent
      // ever sees.
      if (notices) notices.labelsAbsentWithLargeDescription[toolName] = descriptionLength;
      console.warn(
        `[mcp-http] ${toolName}: 'labels' absent in received arguments alongside a ${descriptionLength}-char description. ` +
        'If labels were expected on this call, this is the known large-payload drop upstream of Kangentic ' +
        '(MCP client tool-call emission); set labels via a separate labels-only kangentic_update_task. ' +
        `Received argument keys: [${argumentKeys.join(', ')}].`,
      );
    } else {
      console.log(
        `[mcp-http] ${toolName}: received argument keys [${argumentKeys.join(', ')}], hasLabels=${hasLabels}, descriptionLength=${descriptionLength}`,
      );
    }
  }
}
