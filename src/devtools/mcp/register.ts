import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestResolver } from '../../main/agent/mcp-http/project-resolver';
import { registerDevtoolsPreviewTools } from './preview-tools';

/**
 * Single entry point used by `src/main/agent/mcp-http-server.ts` from
 * inside an `if (__KANGENTIC_DEV__) { ... }` guard. Registers every
 * dev-only `kangentic_devtools_*` tool on the given McpServer instance.
 *
 * Production builds drop this entire module via dead-code elimination
 * because the import in mcp-http-server.ts is gated.
 */
export function registerDevtoolsMcpTools(server: McpServer, resolver: RequestResolver): void {
  registerDevtoolsPreviewTools(server, resolver);
}
