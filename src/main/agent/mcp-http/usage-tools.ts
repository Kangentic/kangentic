import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { PROJECT_SELECTOR_DESCRIPTION, runHandler, withProject } from './handler-helpers';
import type { McpToolResult } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';
import type { CommandContext, CommandResponse } from '../commands';

/**
 * Usage-statistics MCP tools. One read-only tool exposing the same
 * usage-stats service the in-app dashboard reads (tokens, cost, burn rate,
 * by-model / by-agent / by-effort breakdowns, per-project or app-wide, over
 * the shared Live/Today/Week/Month/All time ranges).
 */

function toToolResult(response: CommandResponse): McpToolResult {
  if (!response.success) {
    return { content: [{ type: 'text' as const, text: response.error ?? 'Failed to read usage stats' }], isError: true };
  }
  const text = [response.message ?? '', JSON.stringify(response.data ?? {})].filter(Boolean).join('\n\n');
  return { content: [{ type: 'text' as const, text }] };
}

export function registerUsageTools(server: McpServer, resolver: RequestResolver): void {
  // --- kangentic_get_usage_stats ---
  server.registerTool(
    'kangentic_get_usage_stats',
    {
      description:
        'Aggregated agent-usage statistics: tokens in/out, cost, burn rate ($/hr approximate + tokens/hr), sessions, tool calls, line churn, and by-model / by-agent / by-effort breakdowns - for one project or rolled up across every registered project. Reads the durable usage ledgers, so totals survive task/session deletion; usage from in-flight sessions is excluded until they finalize. Pass includeSeries for bucketed token/cost time series (burn-rate and trend charts).',
      inputSchema: z.object({
        period: z
          .enum(['live', 'today', 'week', 'month', 'all'])
          .optional()
          .describe(
            "Time range. 'live' = the trailing 2 hours; 'today'/'week'/'month' start at the machine's local midnight / Monday / 1st of month. Default: 'all'.",
          ),
        allProjects: z
          .boolean()
          .optional()
          .describe('Roll up across every registered project, with per-project sub-totals. Takes precedence over project.'),
        includeSeries: z
          .boolean()
          .optional()
          .describe('Include the bucketed token/cost time series in the response (larger). Default: false (KPIs + breakdowns only).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ period, allProjects, includeSeries, project }) => {
      if (allProjects) {
        const response = await runHandler(
          'get_usage_stats',
          { period, allProjects: true, includeSeries },
          resolver.defaultContextResolved().context,
        );
        return toToolResult(response);
      }
      return withProject(resolver, project, async (context: CommandContext, resolved) => {
        const response = await runHandler(
          'get_usage_stats',
          { period, includeSeries, projectId: resolved.projectId },
          context,
        );
        return toToolResult(response);
      });
    },
  );
}
