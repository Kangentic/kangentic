import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';

/**
 * What a workflow's own agent may reach on Kangentic's MCP server.
 *
 * That agent plans one workflow and is launched read-only (`readOnly` on the
 * spawn), so on the server it gets every read-only tool and the tools that shape
 * its plan, and nothing else. Starting, pausing, resuming and deleting the
 * workflow stay the user's (Start is the plan's approval), and so does every
 * tool that creates, moves or deletes board work outside the plan.
 *
 * The planning tools are also pinned to the agent's own workflow: their
 * `workflow` and `project` arguments are taken off the schema and filled in from
 * the caller's URL, so the agent never needs its workflow's id, and cannot change
 * another workflow's plan by naming it. The read-only tools are not pinned: like
 * any agent on the project, it can list the project's workflows and read their
 * plans and agents' conversations (`kangentic_get_transcript` with `workflow`).
 * Reading another plan changes nothing, and planning across workflows can need it.
 * `kangentic_get_workflow` only defaults to its own workflow: left out, `workflow`
 * is filled in; named, the call reads the workflow it names.
 */

/** Tools that shape the plan, on top of the read-only ones. */
export const WORKFLOW_AGENT_PLANNING_TOOLS: ReadonlySet<string> = new Set([
  'kangentic_save_workflow',
  'kangentic_add_workflow_task',
  'kangentic_link_workflow_tasks',
  'kangentic_unlink_workflow_tasks',
  'kangentic_set_task_route',
  'kangentic_remove_from_workflow',
  // Reads another project's code: granted by Kangentic, never a write.
  'kangentic_request_project_access',
]);

/** Read-only, but about one workflow, so it reads the agent's own when none is named. */
const OWN_WORKFLOW_READS: ReadonlySet<string> = new Set(['kangentic_get_workflow']);

/**
 * Families left out although some of their tools are read-only. The browser
 * tools drive a task's Browser pane, and this agent has no task.
 */
const EXCLUDED_PREFIXES = ['kangentic_browser_'];

const OWN_WORKFLOW_DESCRIPTION = 'Leave out: these tools act on the workflow you are planning.';

const OWN_WORKFLOW_READ_DESCRIPTION = 'The workflow\'s id, or its exact title (case-insensitive). Leave out to read the workflow you are planning.';

/** The part of a tool's registration this scope reads. */
interface ScopedToolConfig {
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

type ScopedToolCallback = (args: Record<string, unknown>, extra: unknown) => unknown;

/** Whether the workflow agent gets this tool at all. */
export function workflowAgentMayUse(name: string, readOnly: boolean): boolean {
  if (EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  return readOnly || WORKFLOW_AGENT_PLANNING_TOOLS.has(name);
}

function scopedSchema(inputSchema: unknown): unknown {
  if (!(inputSchema instanceof z.ZodObject)) return inputSchema;
  const shape = inputSchema.shape;
  const withoutProject = 'project' in shape ? inputSchema.omit({ project: true }) : inputSchema;
  return withoutProject.extend({ workflow: z.string().optional().describe(OWN_WORKFLOW_DESCRIPTION) });
}

/** A read about one workflow keeps `project`, and its `workflow` becomes optional. */
function ownReadSchema(inputSchema: unknown): unknown {
  if (!(inputSchema instanceof z.ZodObject)) return inputSchema;
  return inputSchema.extend({ workflow: z.string().optional().describe(OWN_WORKFLOW_READ_DESCRIPTION) });
}

/**
 * The server's `registerTool`, wrapped: a tool the agent may not use is never
 * registered, and a tool about its workflow is bound to it. Every
 * `register*Tools` family runs against this unchanged.
 */
export function scopeServerToWorkflowAgent(server: McpServer, workflowId: string): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== 'registerTool') return Reflect.get(target, property, receiver);
      return (name: string, config: ScopedToolConfig, callback: ScopedToolCallback) => {
        const readOnly = config.annotations?.readOnlyHint === true;
        if (!workflowAgentMayUse(name, readOnly)) return null;
        if (OWN_WORKFLOW_READS.has(name)) {
          // Its own workflow lives in its home project, so a default drops any `project` too.
          const defaultedCallback: ScopedToolCallback = (args, extra) => (
            typeof args.workflow === 'string' && args.workflow.trim() !== ''
              ? callback(args, extra)
              : callback({ ...args, workflow: workflowId, project: undefined }, extra)
          );
          return Reflect.apply(target.registerTool, target, [name, { ...config, inputSchema: ownReadSchema(config.inputSchema) }, defaultedCallback]);
        }
        if (!WORKFLOW_AGENT_PLANNING_TOOLS.has(name)) {
          return Reflect.apply(target.registerTool, target, [name, config, callback]);
        }
        const boundCallback: ScopedToolCallback = (args, extra) => callback({ ...args, workflow: workflowId, project: undefined }, extra);
        return Reflect.apply(target.registerTool, target, [name, { ...config, inputSchema: scopedSchema(config.inputSchema) }, boundCallback]);
      };
    },
  });
}
