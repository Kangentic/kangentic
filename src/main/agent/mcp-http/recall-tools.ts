import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { PROJECT_SELECTOR_DESCRIPTION, type McpToolResult } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';
import { searchConversationMemory, type TranscriptSearchHit } from '../../retrieval/memory-search';
import type { Project } from '../../../shared/types';

/**
 * kangentic_recall - the citation-first memory primitive for agents.
 *
 * Distinct from kangentic_search_everything (which spans many sources): recall
 * is the "have we solved this before?" tool. It runs hybrid (lexical +
 * semantic) retrieval over past agent CONVERSATIONS and returns COMPACT
 * citations - one line per hit with the sessionId + turnUuid - so step one stays
 * cheap in tokens. The agent inspects the citations, then fetches full context
 * only for the ones it wants via kangentic_get_transcript with aroundUuid.
 *
 * Semantic ranking is available when conversation memory has its embedding layer
 * enabled; otherwise recall degrades to lexical (keyword) ranking transparently.
 */

/** How many raw hits to fetch before applying the optional post-filters. */
const OVERFETCH_CAP = 50;
const SNIPPET_MAX = 160;

export function registerRecallTools(server: McpServer, resolver: RequestResolver): void {
  server.registerTool(
    'kangentic_recall',
    {
      description:
        'Recall past agent conversations by meaning or keyword - the "have we solved this before?" tool. Runs hybrid (semantic + keyword) retrieval over the structured transcripts of prior sessions and returns COMPACT citations: one line per hit with a relevance score, the task/agent/date, and a sessionId + turnUuid. This is step one of a citation-first flow - it stays token-cheap. To read the full context around a hit, call kangentic_get_transcript with the hit\'s sessionId and aroundUuid (plus an optional context window). Defaults to the active project; pass scope:"all" to recall across every project (cross-project knowledge transfer). Filter with taskId, agent, since/until. Semantic ranking is used when the conversation-memory embedding layer is enabled; otherwise recall falls back to keyword ranking. Requires conversation-memory indexing to be on.',
      inputSchema: z.object({
        query: z.string().min(1).describe('What to recall, in natural language or keywords (e.g. "how we fixed the false-idle subagent bug").'),
        scope: z.enum(['current', 'all']).optional().describe('"current" (default) recalls within the active or project-routed project; "all" recalls across every registered project. Forced to "current" when project is set.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
        k: z.number().int().min(1).max(50).optional().describe('Max citations to return. Default 8 - recall is deliberately small; widen only when scanning broadly.'),
        mode: z.enum(['hybrid', 'lexical', 'semantic']).optional().describe('"hybrid" (default) fuses keyword + semantic; "lexical" = keyword only; "semantic" = embedding only. Non-lexical modes fall back to keyword when the embedding layer is unavailable.'),
        taskId: z.string().optional().describe('Restrict to conversations belonging to this task (numeric display id or UUID as it appears on hits).'),
        agent: z.string().optional().describe('Restrict to a specific agent by display name substring (e.g. "Claude", "Codex").'),
        since: z.string().optional().describe('ISO date/time floor on the matched turn (inclusive).'),
        until: z.string().optional().describe('ISO date/time ceiling on the matched turn (inclusive).'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, scope, project, k, mode, taskId, agent, since, until }): Promise<McpToolResult> => {
      if (!resolver.isMemoryIndexingEnabled()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Conversation memory indexing is disabled. Enable it in Settings -> Memory to use recall.',
            },
          ],
        };
      }

      const resolved = resolver.resolveProject(project);
      if ('error' in resolved) {
        return { content: [{ type: 'text' as const, text: resolved.error }], isError: true };
      }
      const effectiveScope: 'current' | 'all' = resolved.isDefault ? (scope ?? 'current') : 'current';
      const allProjects = resolver.listProjectsRaw();
      let projectsToScan: Project[];
      if (effectiveScope === 'all') {
        projectsToScan = allProjects;
      } else {
        const target = allProjects.find((entry) => entry.id === resolved.projectId);
        projectsToScan = target ? [target] : [];
      }
      if (projectsToScan.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No projects available to recall from.' }], isError: true };
      }

      const limit = k ?? 8;
      const effectiveMode = mode ?? 'hybrid';
      // 'lexical' never embeds; the others use the embedder when available and
      // fall back to lexical transparently (embedder null => lexical-only).
      const embedder = effectiveMode === 'lexical' ? null : resolver.getMemoryEmbedder();

      const sinceMs = since ? Date.parse(since) : NaN;
      const untilMs = until ? Date.parse(until) : NaN;
      const agentNeedle = agent?.trim().toLowerCase();

      const rawHits = await searchConversationMemory({
        query,
        projects: projectsToScan,
        k: OVERFETCH_CAP,
        embedWaitMs: 5000,
        embedder,
      });

      const filtered = rawHits.filter((hit) => {
        if (taskId && hit.taskId !== taskId) return false;
        if (agentNeedle && !hit.agentName.toLowerCase().includes(agentNeedle)) return false;
        if (!Number.isNaN(sinceMs) && (hit.turnTs ?? 0) < sinceMs) return false;
        if (!Number.isNaN(untilMs) && (hit.turnTs ?? Number.MAX_SAFE_INTEGER) > untilMs) return false;
        return true;
      });

      return {
        content: [{ type: 'text' as const, text: formatRecall(query, effectiveScope, effectiveMode, filtered.slice(0, limit)) }],
      };
    },
  );
}

function formatRecall(
  query: string,
  scope: 'current' | 'all',
  mode: string,
  hits: TranscriptSearchHit[],
): string {
  if (hits.length === 0) {
    return `Recall: no past conversations matched "${query}" (scope: ${scope}, mode: ${mode}).`;
  }
  const header = `Recall: ${hits.length} hit(s) for "${query}" (scope: ${scope}, mode: ${mode})`;
  const lines = hits.map((hit, index) => {
    const date = hit.turnTs ? new Date(hit.turnTs).toISOString().slice(0, 10) : 'unknown';
    const snippet = hit.snippet.length > SNIPPET_MAX ? `${hit.snippet.slice(0, SNIPPET_MAX)}…` : hit.snippet;
    return [
      `${index + 1}. [${hit.score.toFixed(3)}] ${hit.taskTitle} · ${hit.agentName} · ${date}`,
      `   sessionId: ${hit.sessionId}  turnUuid: ${hit.turnUuid ?? 'n/a'}  (${hit.role})`,
      `   > ${snippet}`,
    ].join('\n');
  });
  const footer = [
    'Fetch full context for a hit with kangentic_get_transcript:',
    '  { sessionId: "<id>", aroundUuid: "<turnUuid>", context: 3 }',
  ].join('\n');
  return `${header}\n\n${lines.join('\n')}\n\n${footer}`;
}
