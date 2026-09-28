import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { PROJECT_SELECTOR_DESCRIPTION, type McpToolResult } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';
import { runSearchEverything } from '../../search/search-core';
import type { SearchHit, Project } from '../../../shared/types';
import { isAnswerCaller } from './caller-url';
import { ANSWER_SEARCH_BUDGET, claimAnswerSearch, publishAnswerSearch } from './answer-search-trace';
import {
  boardRecordTasks,
  indexedConversationNodes,
  searchRelatedWork,
  type RelatedWork,
} from '../../retrieval/related-work';

/**
 * kangentic_search - the single unified retrieval tool for agents. Mirrors the
 * renderer's Ctrl+Shift+F palette: one query returns hits across tasks, backlog,
 * session events, conversation transcripts, and (when scope='all') projects,
 * instead of stitching together kangentic_search_tasks + kangentic_get_session_events.
 *
 * Conversations are searched by keyword by default and by MEANING when mode is
 * 'hybrid' (the "have we solved this before?" recall use case). This folds the
 * former kangentic_recall into one tool, so there is no "which search?" ambiguity:
 * per Anthropic's tool-design guidance, related retrieval operations are one tool
 * with a parameter, not several overlapping tools. Conversation hits carry a
 * sessionId + turnUuid; drill into one with kangentic_get_transcript (aroundUuid).
 *
 * Defaults to `scope: 'current'` because cross-project scope opens every
 * registered project's DB and streams every session's events.jsonl - much
 * heavier than a single-project query. Callers pass `scope: 'all'` to widen. An
 * explicit `project` selector forces scope to 'current' (routing to a specific
 * project while asking for "all projects" is incoherent, and the selector is the
 * stronger signal).
 */
export function registerSearchTools(
  server: McpServer,
  resolver: RequestResolver,
  /** The caller segment of the request's URL. An answer caller's searches are
   *  published to the Memory Graph trace (`answer-search-trace.ts`). */
  callerSessionId?: string,
): void {
  server.registerTool(
    'kangentic_search',
    {
      description: 'The single unified search tool: one query across the active project (or all registered projects with scope:"all") covering board tasks (active + archived, title and description), backlog items, session events (the tool_start/tool_end/idle stream from agent runs), past agent conversations, and project names/paths. Returns a per-kind grouped result with snippets, so you pinpoint the matching task, backlog item, session event, conversation turn, or project in one call instead of issuing kangentic_search_tasks + kangentic_get_session_events separately. Conversations are matched by KEYWORD by default; pass mode:"hybrid" to also match them by MEANING (semantic embedding) - this is the "have we solved this / seen this before?" recall path over past conversations. Conversation hits carry a sessionId + turnUuid; follow up with kangentic_get_transcript (aroundUuid) to read the surrounding turns. Pass taskId to restrict CONVERSATION hits to one task\'s history - e.g. "what was discussed in task #286 about X, and how does it affect the current work?" (resolve the display "#N" to its internal id first with kangentic_find_task or kangentic_get_current_task; other hit kinds are unaffected by taskId). (kangentic_search_tasks already spans board + backlog within one project; reach for this tool when you also need session events, past conversations, semantic matching, or cross-project scope.) Per-kind hit caps: 30 tasks, 20 backlog, 50 session events, 10 projects, 20 conversations. Pass groupBy:"task" to rank TASKS by how much their conversations are about the query, for counting or ranking work on a topic. Defaults to the active project; pass scope:"all" to widen across every registered project. Passing project forces scope to "current" since explicit routing already specifies the target.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search keyword or phrase, or - in mode:"hybrid" - a natural-language description of what you are looking for (case-insensitive). Empty queries return no results. A "#<number>" query (e.g. "#42") is a ticket lookup instead of a text search: it returns only board tasks whose display ID prefix-matches the number ("#4" matches #4, #40, #400), skipping the backlog, session-event, conversation, and project kinds entirely. A bare number with no "#" stays a text search.'),
        scope: z.enum(['current', 'all']).optional().describe('"current" (default) searches only the active or `project`-routed project. "all" widens to every registered project on this machine and additionally surfaces project-name hits so an agent can discover routing targets. Ignored (forced to "current") when `project` is set.'),
        mode: z.enum(['keyword', 'hybrid']).optional().describe('How CONVERSATIONS are matched (tasks, backlog, session events, and projects are always keyword). "hybrid" (default) fuses keyword + semantic embedding so past conversations match by meaning, not just literal words - use it for "have we done X before?" recall. "keyword" is exact/lexical only and slightly faster. Both fall back to keyword automatically when the conversation embedding layer is off.'),
        taskId: z.string().optional().describe('Restrict CONVERSATION hits to this one task\'s history (the internal task id, not the display "#N" - resolve it first with kangentic_find_task or kangentic_get_current_task). Task/backlog/session-event/project hits are unaffected.'),
        groupBy: z.enum(['kind', 'task']).optional().describe('"kind" (default) returns hits grouped by kind, as described above. "task" instead ranks the TASKS whose past conversations are about the query: every matching passage rolled up per task, strongest first, each with how many passages matched, the dates they span, and its best passage. Use it for "which tasks touched X?", "how many times did we change Y?" or "what is most related to Z?", where a list of snippets cannot be counted or ranked. One project at a time, so not with scope:"all" or taskId.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, scope, mode, taskId, groupBy, project }): Promise<McpToolResult> => {
      // An answer run's question has a search budget. Past it, the tool says
      // so in words the agent acts on (answer now), rather than failing, so a
      // run that over-searches still ends in an answer.
      if (callerSessionId && isAnswerCaller(callerSessionId) && !claimAnswerSearch(callerSessionId)) {
        return {
          content: [{
            type: 'text' as const,
            text: `This question has used its ${ANSWER_SEARCH_BUDGET} searches. Do not search again: answer now from what you have already found.`,
          }],
        };
      }
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

      // mode gates only the CONVERSATION corpus: 'hybrid' (default) pulls the
      // embedder so past conversations rank by meaning; 'keyword' passes null so
      // they stay lexical. A null embedder (semantic layer off) degrades to
      // keyword transparently either way. The MCP tool uses a generous embed
      // budget (agents tolerate latency; the palette does not).
      const effectiveMode = mode ?? 'hybrid';
      const embedder = effectiveMode === 'keyword' ? null : resolver.getMemoryEmbedder();

      if (groupBy === 'task') {
        return searchByTask({
          query,
          projectId: projectsToScan[0].id,
          allProjects: effectiveScope === 'all',
          taskId,
          indexingEnabled: resolver.isMemoryIndexingEnabled(),
          embedder,
          callerSessionId,
        });
      }

      const hits = await runSearchEverything({
        query,
        projects: projectsToScan,
        includeProjectHits: effectiveScope === 'all',
        projectsForProjectHits: allProjects,
        conversationSearch: {
          enabled: resolver.isMemoryIndexingEnabled(),
          embedder,
          embedWaitMs: 5000,
          taskId,
        },
      });

      if (callerSessionId && isAnswerCaller(callerSessionId)) {
        const sessionIds = [...new Set(hits.flatMap((hit) => (hit.kind === 'conversation' ? [hit.sessionId] : [])))];
        publishAnswerSearch(callerSessionId, { query, sessionIds });
      }

      return {
        content: [{ type: 'text' as const, text: formatHits(query, hits, effectiveScope) }],
      };
    },
  );
}

/**
 * `groupBy: "task"`: the tasks whose conversations are about the query, ranked
 * by the same rollup the Memory Graph's Ask uses (`related-work.ts`), so a
 * count or a superlative over a topic is a lookup rather than a pile of
 * snippets the agent has to tally itself.
 *
 * Refusals say what to change, so the agent can correct the call and retry.
 */
async function searchByTask(input: {
  query: string;
  projectId: string;
  allProjects: boolean;
  taskId: string | undefined;
  indexingEnabled: boolean;
  embedder: ReturnType<RequestResolver['getMemoryEmbedder']>;
  callerSessionId: string | undefined;
}): Promise<McpToolResult> {
  if (input.allProjects) {
    return {
      content: [{ type: 'text' as const, text: 'groupBy:"task" ranks the tasks of ONE project. Drop scope:"all", or pass project to name the one you want.' }],
      isError: true,
    };
  }
  if (input.taskId) {
    return {
      content: [{ type: 'text' as const, text: 'groupBy:"task" ranks every task, so it cannot be narrowed to one with taskId. Drop taskId to rank tasks, or drop groupBy to search that task\'s conversations.' }],
      isError: true,
    };
  }
  if (!input.indexingEnabled) {
    return { content: [{ type: 'text' as const, text: 'Conversation indexing is off, so there are no conversations to rank tasks by.' }] };
  }

  const nodes = indexedConversationNodes(input.projectId);
  const related = await searchRelatedWork({
    question: input.query,
    projectId: input.projectId,
    nodes,
    // Unscoped: every board task is in reach of its own record, so a task
    // with no indexed conversation still ranks.
    recordOnlyTasks: boardRecordTasks(input.projectId),
    embedder: input.embedder,
    embedWaitMs: 5000,
  });

  if (input.callerSessionId && isAnswerCaller(input.callerSessionId)) {
    const sessionByDocKey = new Map(nodes.map((node) => [node.docKey, node.sessionId]));
    const sessionIds = [...new Set(related.handed.flatMap((task) => task.docKeys
      .map((docKey) => sessionByDocKey.get(docKey))
      .filter((sessionId): sessionId is string => Boolean(sessionId))))];
    publishAnswerSearch(input.callerSessionId, { query: input.query, sessionIds });
  }

  return { content: [{ type: 'text' as const, text: formatRelatedTasks(input.query, related) }] };
}

function isoDate(epochMs: number | null): string {
  return epochMs === null ? '?' : new Date(epochMs).toISOString().slice(0, 10);
}

/** The ranked tasks as one text block, strongest first. */
export function formatRelatedTasks(query: string, related: RelatedWork): string {
  if (related.handed.length === 0) return `No tasks have conversations matching "${query}".`;
  const keywordOnly = related.semantic ? '' : ' Matched by keyword only, because the embedding layer is off.';
  const header = `${related.handed.length} of ${related.ranked.length} related task(s) for "${query}", strongest first.`
    + ' strength is relative to the best match (1.00), and matches counts the passages that matched.'
    + keywordOnly;
  const lines = related.handed.map((task) => {
    const name = task.displayId != null ? `#${task.displayId} ${task.title}` : `${task.title} (a conversation with no task)`;
    const facts = [
      `strength ${task.strength.toFixed(2)}`,
      `${task.matches} ${task.matches === 1 ? 'match' : 'matches'}`,
      `${isoDate(task.firstMs)} to ${isoDate(task.lastMs)}`,
      ...(task.taskId ? [`taskId: ${task.taskId}`] : []),
      ...(task.sessionId ? [`sessionId: ${task.sessionId}`] : []),
      ...(task.turnUuid ? [`turnUuid: ${task.turnUuid}`] : []),
    ].join(', ');
    const passage = task.bestChunkId !== null ? related.passages.get(task.bestChunkId) : undefined;
    return `- ${name} (${facts})${passage ? ` - "${passage}"` : ''}`;
  });
  const hint = 'Read the turns around a task\'s best passage with kangentic_get_transcript: { sessionId, aroundUuid: <turnUuid>, context: 3 }';
  return `${header}\n\n${lines.join('\n')}\n${hint}`;
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
  const conversations: Extract<SearchHit, { kind: 'conversation' }>[] = [];
  for (const hit of hits) {
    switch (hit.kind) {
      case 'task': tasks.push(hit); break;
      case 'backlog': backlog.push(hit); break;
      case 'session_event': sessionEvents.push(hit); break;
      case 'project': projects.push(hit); break;
      case 'conversation': conversations.push(hit); break;
    }
  }

  const summary = `Found ${hits.length} hit(s) for "${query}" (scope: ${scope}; tasks: ${tasks.length}, backlog: ${backlog.length}, session_event: ${sessionEvents.length}, project: ${projects.length}, conversation: ${conversations.length})`;

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

  if (conversations.length > 0) {
    const lines = conversations.map((hit) =>
      `- [${hit.score.toFixed(3)}] ${hit.taskTitle} via ${hit.agentName} (project: ${hit.projectName}, sessionId: ${hit.sessionId}, turnUuid: ${hit.turnUuid ?? 'n/a'}) - ${hit.snippet}`,
    );
    // Citation-first drill-down: read the neighborhood of a cited turn rather
    // than the whole transcript.
    const hint = 'Read the turns around a hit with kangentic_get_transcript: { sessionId, aroundUuid: <turnUuid>, context: 3 }';
    sections.push(`## Conversations\n${lines.join('\n')}\n${hint}`);
  }

  return `${summary}\n\n${sections.join('\n\n')}`;
}
