/**
 * Reports a defect thrown by an MCP tool, for every tool on every server
 * (`mcp-http-server.ts`'s three builders). The SDK catches each callback throw
 * into a tool error the agent reads (`createToolError`), so before this a broken
 * tool reached nobody but the agent.
 *
 * Two places catch: a tool's callback, wrapped here through a `registerTool`
 * proxy (the shape `scopeServerToWorkflowAgent` uses), and `runHandler`
 * (`handler-helpers.ts`), which turns a command handler's throw into
 * `{ success: false }` and so never lets it reach the callback's wrap.
 *
 * What is sent follows `handled-report.ts`: a fixed message, the original frames,
 * and the tool or command name as a tag (both are fixed `kangentic_*` and handler
 * names). Skipped: `WorkflowRequestError` and every refusal, Zod's `InvalidParams`
 * (the SDK throws it before the callback runs), aborts, the network and a quit. A
 * callback's error is rethrown unchanged, so the agent sees what it saw before.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createChokepointReporter, type ChokepointReporter } from '../../analytics/handled-report';

/** One reporter for the tool callbacks, one for the command handlers behind them. */
export const mcpToolReporter: ChokepointReporter = createChokepointReporter('mcp_tool');
export const mcpCommandReporter: ChokepointReporter = createChokepointReporter('mcp_command');
/** The HTTP request itself failing, around the SDK (`mcp-http-server.ts`). */
export const mcpRequestReporter: ChokepointReporter = createChokepointReporter('mcp_request');

type ToolCallback = (...callbackArgs: unknown[]) => unknown;

/** Run one tool callback, report a throw, and rethrow it. */
export async function runReportedTool(toolName: string, callback: ToolCallback, callbackArgs: unknown[]): Promise<unknown> {
  try {
    return await callback(...callbackArgs);
  } catch (error) {
    mcpToolReporter.report(error, { tags: { tool: toolName } });
    throw error;
  }
}

/**
 * The server, with every callback `registerTool` is given wrapped by
 * `runReportedTool`. Register tools on the returned proxy; the server itself is
 * unchanged.
 */
export function withToolReporting(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== 'registerTool') return Reflect.get(target, property, receiver);
      return (name: string, config: unknown, callback: ToolCallback) => {
        const reported: ToolCallback = (...callbackArgs) => runReportedTool(name, callback, callbackArgs);
        return Reflect.apply(target.registerTool, target, [name, config, reported]);
      };
    },
  });
}
