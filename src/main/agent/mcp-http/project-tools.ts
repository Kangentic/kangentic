/**
 * Cross-project discovery tools. `kangentic_list_projects` lets an agent
 * enumerate every known Kangentic project (read from the global DB)
 * without guessing project names or IDs.
 *
 * The list is the only way an agent bound to project A can discover
 * that project B exists so it can pass `project: "B"` to the other
 * MCP tools.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { RequestResolver } from './project-resolver';

export function registerProjectTools(server: McpServer, resolver: RequestResolver): void {
  server.registerTool(
    'kangentic_list_projects',
    {
      description: 'List every Kangentic project registered on this machine. Returns name, id, on-disk path, and last-opened timestamp for each project, plus an isActive flag marking the project the MCP client is bound to. Use the returned name or id as the `project` argument on any other kangentic_* tool to route that call to a different project.',
      inputSchema: z.object({}),
    },
    async () => {
      const projects = resolver.listProjects();
      if (projects.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No projects registered.' }],
        };
      }
      const lines = projects.map((project) => {
        const activeTag = project.isActive ? ' [active]' : '';
        return `- ${project.name}${activeTag} (id: ${project.id}, path: ${project.path}, lastOpened: ${project.lastOpened})`;
      });
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
