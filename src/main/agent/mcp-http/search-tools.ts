import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { PROJECT_SELECTOR_DESCRIPTION, type McpToolResult } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';
import { runSearchEverything } from '../../search/search-core';
import type { SearchHit, Project } from '../../../shared/types';

/**
 * Cross-source unified-search tool. Mirrors the renderer's Ctrl+Shift+F
 * palette so external agents can issue one query and get back hits
 * across tasks, backlog, session events, and (when scope='all') projects
 * instead of stitching together kangentic_search_tasks +
 * kangentic_get_session_events. (kangentic_search_tasks itself already
 * spans board + backlog within a single project; this tool additionally
 * covers session events and cross-project search.)
 *
 * Defaults to `scope: 'current'` because cross-project scope opens every
 * registered project's DB and streams every session's events.jsonl - much
 * heavier than a single-project query. Callers must pass `scope: 'all'`
 * explicitly to widen.
 *
 * When the caller passes an explicit `project` selector, scope is forced
 * to 'current' regardless of the `scope` argument: routing to a specific
 * project and asking for "all projects" at the same time is incoherent,
 * and the explicit selector is the stronger signal.
 */
export function registerSearchTools(
  server: McpServer,
  resolver: RequestResolver,
): void {
  server.registerTool(
    'kangentic_search_everything',
    {
      description: 'Unified keyword search across the active project (or all registered projects) covering: board tasks (active + archived, title and description), backlog items (title and description), session events (the structured tool_start/tool_end/idle stream from agent runs), and project names/paths. Returns a per-kind grouped result with snippets so an agent can pinpoint the matching task, backlog item, session event, or project in one call instead of issuing kangentic_search_tasks + kangentic_get_session_events separately. (kangentic_search_tasks already spans board + backlog within a single project; reach for this tool when you also need session events or cross-project scope.) Per-kind hit caps prevent runaway results: 30 tasks, 20 backlog, 50 session events, 10 projects. Defaults to scoping the search to the active project; pass `scope: "all"` to widen across every registered project. Passing `project` forces scope to "current" since explicit project routing already specifies the target.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search keyword or phrase (case-insensitive). Empty queries return no results.'),
        scope: z.enum(['current', 'all']).optional().describe('"current" (default) searches only the active or `project`-routed project. "all" widens to every registered project on this machine and additionally surfaces project-name hits so an agent can discover routing targets. Ignored (forced to "current") when `project` is set.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, scope, project }): Promise<McpToolResult> => {
      const resolved = resolver.resolveProject(project);
      if ('error' in resolved) {
        return {
          content: [{ type: 'text' as const, text: resolved.error }],
          isError: true,
        };
      }

      // Explicit project selector overrides scope: searching "all
      // projects" while routing to a specific one is incoherent. Keying
      // off resolved.isDefault (instead of the raw selector string)
      // means an empty-string selector is treated as "default" by both
      // the resolver and this branch.
      const effectiveScope: 'current' | 'all' = resolved.isDefault ? (scope ?? 'current') : 'current';

      const allProjects = resolver.listProjectsRaw();
      let projectsToScan: Project[];
      if (effectiveScope === 'all') {
        projectsToScan = allProjects;
      } else {
        const targetProject = allProjects.find((entry) => entry.id === resolved.projectId);
        projectsToScan = targetProject ? [targetProject] : [];
      }

      if (projectsToScan.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No projects available to search.` }],
          isError: true,
        };
      }

      const hits = await runSearchEverything({
        query,
        projects: projectsToScan,
        includeProjectHits: effectiveScope === 'all',
        projectsForProjectHits: allProjects,
      });

      return {
        content: [{ type: 'text' as const, text: formatHits(query, hits, effectiveScope) }],
      };
    },
  );
}

/**
 * Render hits as a single grouped text block. Mirrors the palette's
 * group-by-kind layout so the agent sees the same structure the user
 * does. Each row carries the identifiers an agent needs to follow up
 * with kangentic_find_task, kangentic_get_session_events, etc.
 */
function formatHits(query: string, hits: SearchHit[], scope: 'current' | 'all'): string {
  if (hits.length === 0) {
    return `No hits matching "${query}".`;
  }

  // Partition by kind up front so each section's map() callback gets a
  // fully narrowed hit and doesn't need a redundant kind re-check.
  const tasks: Extract<SearchHit, { kind: 'task' }>[] = [];
  const backlog: Extract<SearchHit, { kind: 'backlog' }>[] = [];
  const sessionEvents: Extract<SearchHit, { kind: 'session_event' }>[] = [];
  const projects: Extract<SearchHit, { kind: 'project' }>[] = [];
  for (const hit of hits) {
    switch (hit.kind) {
      case 'task': tasks.push(hit); break;
      case 'backlog': backlog.push(hit); break;
      case 'session_event': sessionEvents.push(hit); break;
      case 'project': projects.push(hit); break;
    }
  }

  const summary = `Found ${hits.length} hit(s) for "${query}" (scope: ${scope}; tasks: ${tasks.length}, backlog: ${backlog.length}, session_event: ${sessionEvents.length}, project: ${projects.length})`;

  const sections: string[] = [];

  if (tasks.length > 0) {
    const lines = tasks.map((hit) => {
      const archivedTag = hit.archived ? ' [archived]' : '';
      return `- [#${hit.displayId}] ${hit.taskTitle}${archivedTag} (project: ${hit.projectName}, taskId: ${hit.taskId}, match: ${hit.snippetField}) - ${hit.snippet}`;
    });
    sections.push(`## Tasks\n${lines.join('\n')}`);
  }

  if (backlog.length > 0) {
    const lines = backlog.map((hit) =>
      `- ${hit.backlogTitle} (project: ${hit.projectName}, backlogId: ${hit.backlogId}, match: ${hit.snippetField}) - ${hit.snippet}`,
    );
    sections.push(`## Backlog\n${lines.join('\n')}`);
  }

  if (sessionEvents.length > 0) {
    const lines = sessionEvents.map((hit) =>
      `- [${hit.eventType}] ${hit.taskTitle} via ${hit.agentName} (project: ${hit.projectName}, taskId: ${hit.taskId}, sessionId: ${hit.sessionId}) - ${hit.snippet}`,
    );
    sections.push(`## Session Events\n${lines.join('\n')}`);
  }

  if (projects.length > 0) {
    const lines = projects.map((hit) =>
      `- ${hit.projectName} (id: ${hit.projectId}, path: ${hit.projectPath}) - ${hit.snippet}`,
    );
    sections.push(`## Projects\n${lines.join('\n')}`);
  }

  return `${summary}\n\n${sections.join('\n\n')}`;
}
