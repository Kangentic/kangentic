import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { PROJECT_SELECTOR_DESCRIPTION, type McpToolResult } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';
import { runSearchEverything } from '../../search/search-core';
import type { SearchHit, Project } from '../../../shared/types';
import { isAnswerCaller } from './caller-url';
import { ANSWER_SEARCH_BUDGET, answerSearchProjects, claimAnswerSearch, isAnswerSearchWatched, publishAnswerSearch } from './answer-search-trace';
import { PASSAGES_SHOWN, type RelatedWork, type RelatedWorkTask } from '../../retrieval/related-work';
import { relatedQueryTexts } from '../../retrieval/related-query-text';
import {
  INDEX_RESTARTING,
  rankRelatedWork,
  searchCommitsIn,
  searchConversations,
} from '../../retrieval/retrieval-queries';
import type { RankedRelatedWork } from '../../retrieval/worker/methods';
import { getProjectDb } from '../../db/database';
import { TaskRepository } from '../../db/repositories/task-repository';
import { resolveTask } from '../commands/task-resolver';
import type { CommitHit } from '../../retrieval/commit/commit-search';
import type { BoardTaskFacts } from '../../retrieval/answer-tasks';
import {
  KNOWLEDGE_GRAPH_TASK_FIELDS,
  type KnowledgeGraphTaskFacts,
  type KnowledgeGraphTaskFieldKey,
} from '../../../shared/knowledge-graph-task-fields';

/**
 * kangentic_search - the single unified retrieval tool for agents. Mirrors the
 * renderer's Ctrl+Shift+F palette: one query returns hits across tasks, backlog,
 * session events, conversation transcripts, and (when scope='all') projects,
 * instead of stitching together kangentic_search_tasks + kangentic_get_session_events.
 *
 * Conversations are searched by MEANING and keyword by default (mode 'hybrid',
 * the "have we solved this before?" recall use case) and literally with mode
 * 'keyword'. This folds the former kangentic_recall into one tool, so there is
 * no "which search?" ambiguity:
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
   *  published to the Knowledge Graph trace (`answer-search-trace.ts`). */
  callerSessionId?: string,
): void {
  server.registerTool(
    'kangentic_search',
    {
      description: 'The single unified search tool: one query across the active project (or all registered projects with scope:"all") covering board tasks (active + archived, title and description), backlog items, session events (the tool_start/tool_end/idle stream from agent runs), past agent conversations, commits on the default branch (by subject, body, or a sha prefix, each with the task it came from), and project names/paths. Returns a per-kind grouped result with snippets, so you pinpoint the matching task, backlog item, session event, conversation turn, commit, or project in one call. Conversations are matched by MEANING and keyword by default (mode:"hybrid"), the "have we solved this / seen this before?" recall path; mode:"keyword" matches literal words only. Conversation hits carry a sessionId + turnUuid; follow up with kangentic_get_transcript (aroundUuid) to read the surrounding turns. Pass taskId to restrict CONVERSATION and COMMIT hits to one task\'s history (resolve the display "#N" to its internal id first with kangentic_find_task or kangentic_get_current_task). Per-kind hit caps: 30 tasks, 20 backlog, 50 session events, 10 projects, 20 conversations, 10 commits per project. Pass groupBy:"task" to rank TASKS by how much their conversations, records, and commits are about the query, each with its facts (cost, time, tokens, outcome, PR) and, for the strongest, its summary and best passage: for counting or ranking work on a topic. Pass relatedToTask to rank the tasks most like one task, for "has anything like this been done before?". (kangentic_search_tasks already spans board + backlog within one project; reach for this tool for session events, conversations, commits, meaning, or cross-project scope.) Defaults to the active project; pass scope:"all" to widen across every registered project. Passing project forces scope to "current" since explicit routing already specifies the target.',
      inputSchema: z.object({
        query: z.string().min(1).optional().describe('Search keyword or phrase, or - in mode:"hybrid" - a natural-language description of what you are looking for (case-insensitive). Required unless relatedToTask is set. A "#<number>" query (e.g. "#42") is a ticket lookup instead of a text search: it returns only board tasks whose display ID prefix-matches the number ("#4" matches #4, #40, #400), skipping the backlog, session-event, conversation, commit, and project kinds entirely. A bare number with no "#" stays a text search.'),
        scope: z.enum(['current', 'all']).optional().describe('"current" (default) searches only the active or `project`-routed project. "all" widens to every registered project on this machine and additionally surfaces project-name hits so an agent can discover routing targets. Ignored (forced to "current") when `project` is set.'),
        mode: z.enum(['keyword', 'hybrid']).optional().describe('How CONVERSATIONS are matched (tasks, backlog, session events, and projects are always keyword). "hybrid" (default) fuses keyword + semantic embedding so past conversations match by meaning, not just literal words - use it for "have we done X before?" recall. "keyword" is exact/lexical only and slightly faster. Both fall back to keyword automatically when the conversation embedding layer is off.'),
        taskId: z.string().optional().describe('Restrict CONVERSATION and COMMIT hits to this one task\'s history (the internal task id, not the display "#N" - resolve it first with kangentic_find_task or kangentic_get_current_task). Task/backlog/session-event/project hits are unaffected.'),
        groupBy: z.enum(['kind', 'task']).optional().describe('"kind" (default) returns hits grouped by kind, as described above. "task" instead ranks the TASKS whose conversations, task records, and commits are about the query: every matching passage rolled up per task, strongest first, each with how many passages matched, the dates they span, and its facts; the strongest also carry their summary and best passage. Use it for "which tasks touched X?", "how many times did we change Y?" or "what is most related to Z?", where a list of snippets cannot be counted or ranked. One project at a time, so not with scope:"all" or taskId.'),
        relatedToTask: z.string().optional().describe('Rank the OTHER tasks most like this one by its title and description: its prior and related work, strongest first, up to 12 task rows like groupBy:"task". "#N", "N", or the task id. The opposite of taskId, which narrows a search to one task. A query, if given, focuses the ranking. One project at a time.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, scope, mode, taskId, groupBy, relatedToTask, project }): Promise<McpToolResult> => {
      // A call that cannot run is refused before it spends an answer run's
      // search budget, with what to change.
      const refusal = searchArgumentRefusal({ query, scope, project, taskId, groupBy, relatedToTask });
      if (refusal) return { content: [{ type: 'text' as const, text: refusal }], isError: true };

      const answerCaller = Boolean(callerSessionId && isAnswerCaller(callerSessionId));
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

      // An answer run reads only the projects its question was asked across,
      // whatever scope or project the agent passes: the user chose them, and
      // the Privacy tab names what an answer sends. One no question is watching
      // any more (it outlived its question) reads only the project its URL
      // names: no question means no scope, and no scope is not every project.
      let askedAcross: ReadonlySet<string> | null = null;
      if (answerCaller && callerSessionId) {
        if (isAnswerSearchWatched(callerSessionId)) {
          askedAcross = answerSearchProjects(callerSessionId);
        } else {
          const urlProject = resolver.resolveProject(undefined);
          askedAcross = new Set('error' in urlProject ? [] : [urlProject.projectId]);
        }
      }
      const allProjects = resolver.listProjectsRaw()
        .filter((entry) => !askedAcross || askedAcross.has(entry.id));
      let projectsToScan: Project[];
      if (effectiveScope === 'all') {
        projectsToScan = allProjects;
      } else {
        const targetProject = allProjects.find((entry) => entry.id === resolved.projectId);
        projectsToScan = targetProject ? [targetProject] : [];
      }

      if (projectsToScan.length === 0) {
        const text = askedAcross
          ? `This question is asked across ${allProjects.map((entry) => entry.name).join(', ')}. Search only those.`
          : `No projects available to search.`;
        return { content: [{ type: 'text' as const, text }], isError: true };
      }

      // An answer run's question has a search budget, spent only by a search
      // that runs. Past it, the tool says so in words the agent acts on (answer
      // now), rather than failing, so a run that over-searches still ends in an
      // answer. A related-task search claims its own, once it has found the task.
      if (callerSessionId && answerCaller && !relatedToTask && !claimAnswerSearch(callerSessionId)) {
        return answerBudgetSpent();
      }

      // mode gates only the CONVERSATION corpus: 'hybrid' (default) pulls the
      // embedder so past conversations rank by meaning; 'keyword' passes null so
      // they stay lexical. A null embedder (semantic layer off) degrades to
      // keyword transparently either way. The MCP tool uses a generous embed
      // budget (agents tolerate latency; the palette does not).
      const effectiveMode = mode ?? 'hybrid';
      const embedder = effectiveMode === 'keyword' ? null : resolver.getMemoryEmbedder();
      const indexingEnabled = resolver.isMemoryIndexingEnabled();

      if (relatedToTask) {
        return searchRelatedToTask({
          relatedToTask,
          query,
          project: projectsToScan[0],
          indexingEnabled,
          embedder,
          callerSessionId: answerCaller ? callerSessionId : undefined,
        });
      }
      // Unreachable past the refusal above; it narrows the type.
      if (query === undefined) return { content: [{ type: 'text' as const, text: SEARCH_NEEDS_QUERY }], isError: true };

      if (groupBy === 'task') {
        return searchByTask({
          query,
          projectId: projectsToScan[0].id,
          indexingEnabled,
          embedder,
          callerSessionId: answerCaller ? callerSessionId : undefined,
        });
      }

      const hits = await runSearchEverything({
        query,
        projects: projectsToScan,
        includeProjectHits: effectiveScope === 'all',
        projectsForProjectHits: allProjects,
        conversationSearch: {
          enabled: indexingEnabled,
          embedder,
          embedWaitMs: 5000,
          taskId,
          search: searchConversations,
        },
      });

      // Commits, read from the index like the conversations, and skipped for a
      // "#N" ticket lookup, which asks for board tasks only.
      const commits = indexingEnabled && !TICKET_QUERY.test(query.trim())
        ? await searchCommitsIn(projectsToScan, query, taskId)
        : [];

      const notes: string[] = [];
      if (!indexingEnabled) {
        notes.push('Conversations and commits were not searched: the index is off in Settings > Knowledge Graph.');
      } else if (effectiveMode === 'hybrid' && !embedder) {
        notes.push('Conversations were matched by keyword only, because the Knowledge Graph\'s local model is off or not ready.');
      }

      if (callerSessionId && answerCaller) {
        const sessionIds = [...new Set(hits.flatMap((hit) => (hit.kind === 'conversation' ? [hit.sessionId] : [])))];
        const taskIds = [...new Set(commits.flatMap((hit) => (hit.taskId ? [hit.taskId] : [])))];
        publishAnswerSearch(callerSessionId, { query, sessionIds, taskIds });
      }

      return {
        content: [{ type: 'text' as const, text: formatHits(query, hits, commits, notes, effectiveScope) }],
      };
    },
  );
}

/** A "#N" ticket lookup, which `runSearchEverything` answers with board tasks only. */
const TICKET_QUERY = /^#\d+$/;

const SEARCH_NEEDS_QUERY = 'Pass query to search, or relatedToTask to rank the work related to one task.';

/**
 * Why a call's arguments cannot run together, or null when they can. Checked
 * before anything is spent, an answer run's search budget included. A `project`
 * forces scope to "current", so scope:"all" only counts without one.
 */
export function searchArgumentRefusal(input: {
  query: string | undefined;
  scope?: 'current' | 'all';
  project?: string;
  taskId: string | undefined;
  groupBy: 'kind' | 'task' | undefined;
  relatedToTask: string | undefined;
}): string | null {
  if (!input.query && !input.relatedToTask) return SEARCH_NEEDS_QUERY;
  const allProjects = input.scope === 'all' && !input.project;
  if (input.relatedToTask) {
    if (input.taskId) return 'relatedToTask ranks the tasks like one task, and taskId searches inside one task. Pass one of them.';
    if (input.groupBy === 'kind') return 'relatedToTask always returns task rows. Drop groupBy.';
    if (allProjects) return RELATED_TO_TASK_ONE_PROJECT;
  }
  if (input.groupBy === 'task') {
    if (allProjects) return GROUP_BY_TASK_ONE_PROJECT;
    if (input.taskId) return GROUP_BY_TASK_NOT_ONE_TASK;
  }
  return null;
}

const RELATED_TO_TASK_ONE_PROJECT = 'relatedToTask ranks ONE project\'s tasks. Drop scope:"all", or pass project to name the task\'s board.';
const GROUP_BY_TASK_ONE_PROJECT = 'groupBy:"task" ranks the tasks of ONE project. Drop scope:"all", or pass project to name the one you want.';
const GROUP_BY_TASK_NOT_ONE_TASK = 'groupBy:"task" ranks every task, so it cannot be narrowed to one with taskId. Drop taskId to rank tasks, or drop groupBy to search that task\'s conversations.';

/**
 * `groupBy: "task"`: the tasks whose conversations are about the query, ranked
 * by the same rollup the Knowledge Graph's Ask uses (`related-work.ts`), so a
 * count or a superlative over a topic is a lookup rather than a pile of
 * snippets the agent has to tally itself.
 *
 * Its refusals (scope:"all", taskId) are `searchArgumentRefusal`'s, made before
 * anything is spent.
 */
async function searchByTask(input: {
  query: string;
  projectId: string;
  indexingEnabled: boolean;
  embedder: ReturnType<RequestResolver['getMemoryEmbedder']>;
  callerSessionId: string | undefined;
}): Promise<McpToolResult> {
  if (!input.indexingEnabled) {
    return { content: [{ type: 'text' as const, text: 'Conversation indexing is off, so there are no conversations to rank tasks by.' }] };
  }

  // An answer run already holds every task's facts in its table and the handed
  // tasks' summaries in its related work, so its rows stay lean.
  const ranked = await rankRelatedWork({
    projectId: input.projectId,
    question: input.query,
    embedder: input.embedder,
    vectorTexts: relatedQueryTexts(input.query, []),
    embedWaitMs: 5000,
    withExtras: !input.callerSessionId,
  });
  if (!ranked) return indexRestarting();
  const { related } = ranked;

  if (input.callerSessionId) {
    publishAnswerSearch(input.callerSessionId, { query: input.query, sessionIds: handedSessionIds(ranked, related.handed) });
    return { content: [{ type: 'text' as const, text: formatRelatedTasks(input.query, related) }] };
  }

  const header = `${related.handed.length} of ${related.ranked.length} related task(s) for "${input.query}", strongest first.`;
  return {
    content: [{
      type: 'text' as const,
      text: formatRankedTasksForAgents(header, related.handed, related, ranked),
    }],
  };
}

/** The worker could not answer: said so, in words the agent acts on. */
function indexRestarting(): McpToolResult {
  return { content: [{ type: 'text' as const, text: INDEX_RESTARTING }], isError: true };
}

/** What an answer run's search returns once its question's budget is spent. */
function answerBudgetSpent(): McpToolResult {
  return {
    content: [{
      type: 'text' as const,
      text: `This question has used its ${ANSWER_SEARCH_BUDGET} searches. Do not search again: answer now from what you have already found.`,
    }],
  };
}

/** The sessions a set of ranked tasks' conversations open, for the answer trace. */
function handedSessionIds(ranked: Pick<RankedRelatedWork, 'sessionIdByDocKey'>, handed: ReadonlyArray<RelatedWorkTask>): string[] {
  return [...new Set(handed.flatMap((task) => task.docKeys
    .map((docKey) => ranked.sessionIdByDocKey.get(docKey))
    .filter((sessionId): sessionId is string => Boolean(sessionId))))];
}

/**
 * Characters of the task's title and description a relatedToTask ranking reads,
 * the same budget the task window's prior work uses: enough to carry the task's
 * meaning, and past it the embedding blurs.
 */
const RELATED_TO_TASK_TEXT_CHARS = 1_200;
/** Rows relatedToTask returns, every one with its summary and passage. */
export const RELATED_TO_TASK_ROWS = 12;

/**
 * `relatedToTask`: the tasks most like one task, its prior and related work,
 * ranked by the same rollup as groupBy:"task". The task itself is left out of
 * the ranking entirely (its conversations and its record), so strength is
 * measured against the best OTHER task.
 *
 * The task is embedded once, as one query vector, rather than as the question
 * and its content words: each vector costs one scan of every conversation
 * vector on main, so one vector keeps this at the cost of a single search.
 */
async function searchRelatedToTask(input: {
  relatedToTask: string;
  query: string | undefined;
  project: Project;
  indexingEnabled: boolean;
  embedder: ReturnType<RequestResolver['getMemoryEmbedder']>;
  callerSessionId: string | undefined;
}): Promise<McpToolResult> {
  const reference = input.relatedToTask.trim().replace(/^#/, '');
  let task: ReturnType<typeof resolveTask>;
  try {
    task = resolveTask(new TaskRepository(getProjectDb(input.project.id)), reference);
  } catch {
    task = undefined;
  }
  if (!task) {
    return {
      content: [{
        type: 'text' as const,
        text: `No task "${input.relatedToTask}" in project "${input.project.name}". Pass the "#N" on its card or its id from kangentic_find_task, and pass project if it is on another board.`,
      }],
      isError: true,
    };
  }
  const label = `#${task.display_id} ${task.title}`;
  if (!input.indexingEnabled) {
    return { content: [{ type: 'text' as const, text: `The index is off (Settings > Knowledge Graph), so there is nothing to rank the work related to ${label} by.` }] };
  }
  // Claimed here, past the two answers that ran no search, so a mistyped task
  // costs an answer run none of its budget.
  if (input.callerSessionId && !claimAnswerSearch(input.callerSessionId)) return answerBudgetSpent();

  const focus = input.query?.trim() ?? '';
  const text = `${focus ? `${focus}. ` : ''}${task.title}\n${task.description ?? ''}`.slice(0, RELATED_TO_TASK_TEXT_CHARS);
  // The task is left out of its own ranking, conversations and record both.
  const ranked = await rankRelatedWork({
    projectId: input.project.id,
    question: text,
    keywordText: `${focus} ${task.title}`,
    excludeTaskId: task.id,
    embedder: input.embedder,
    vectorTexts: [text],
    embedWaitMs: 5000,
    rows: RELATED_TO_TASK_ROWS,
    withExtras: !input.callerSessionId,
  });
  if (!ranked) return indexRestarting();
  const { related } = ranked;
  const handed = related.handed.slice(0, RELATED_TO_TASK_ROWS);

  if (input.callerSessionId) {
    publishAnswerSearch(input.callerSessionId, { query: `related to #${task.display_id}`, sessionIds: handedSessionIds(ranked, handed) });
  }
  if (handed.length === 0) {
    return { content: [{ type: 'text' as const, text: `Nothing in the index is related to ${label}.` }] };
  }
  if (input.callerSessionId) {
    return { content: [{ type: 'text' as const, text: formatRelatedTasks(`related to ${label}`, { ...related, handed }) }] };
  }
  const header = `${handed.length} task(s) most related to ${label}, strongest first (the task itself left out).`;
  return {
    content: [{
      type: 'text' as const,
      text: formatRankedTasksForAgents(header, handed, related, ranked),
    }],
  };
}

/** Each ranked task's facts, and the strongest ones' summaries, by task id.
 *  Read in the worker with the ranking (`related.rank`); either read failing
 *  leaves the rows without it. */
type RankedTaskExtras = Pick<RankedRelatedWork, 'factsByTaskId' | 'summaryByTaskId'>;

/** Characters a ranked-task response stops at; the rest are counted, not shown. */
export const RANKED_TASKS_RESPONSE_CHARS = 30_000;
/** Room kept for the closing lines (the count of rows left out, the transcript hint). */
const RANKED_TASKS_TAIL_RESERVE = 300;

const FACT_FIELD = new Map(KNOWLEDGE_GRAPH_TASK_FIELDS.map((field) => [field.key, field]));

/**
 * A task's facts on one line, as the app shows them: "$4.12, 2h 10m, 3.1M
 * tokens, 4 conversations, 12 files, +340/-80 lines, Done, PR 417 merged".
 * A fact never recorded is left out rather than printed as zero.
 */
export function factsInline(board: BoardTaskFacts): string {
  const facts: KnowledgeGraphTaskFacts = { ...board, region: null };
  const shown = (key: KnowledgeGraphTaskFieldKey, suffix = ''): string | null => {
    const value = FACT_FIELD.get(key)?.display(facts);
    return value ? `${value}${suffix}` : null;
  };
  const lines = [shown('lines_added'), shown('lines_removed')].filter((part): part is string => part !== null).join('/');
  return [
    shown('cost_usd'),
    shown('duration'),
    shown('tokens', ' tokens'),
    shown('sessions', facts.sessions === 1 ? ' conversation' : ' conversations'),
    shown('files', facts.filesChanged === 1 ? ' file' : ' files'),
    lines ? `${lines} lines` : null,
    shown('outcome'),
    shown('pr'),
  ].filter((part): part is string => part !== null).join(', ');
}

/**
 * Ranked tasks for an agent, strongest first. The first `PASSAGES_SHOWN` carry
 * their facts, summary and best passage with every id to follow up by; the rest
 * are one line each, facts and task id only (a search with taskId still reaches
 * their conversations). Stops at `RANKED_TASKS_RESPONSE_CHARS` and counts the rest.
 */
export function formatRankedTasksForAgents(
  header: string,
  handed: ReadonlyArray<RelatedWorkTask>,
  related: Pick<RelatedWork, 'passages' | 'semantic'>,
  extras: RankedTaskExtras,
): string {
  if (handed.length === 0) return `${header}\nNo tasks matched.`;
  const keywordOnly = related.semantic ? '' : ' Matched by keyword only, because the Knowledge Graph\'s local model is off or not ready.';
  const intro = `${header} strength is relative to the best match (1.00), and matches counts the passages that matched.`
    + ` The first ${PASSAGES_SHOWN} carry a summary where one was written and their best passage.${keywordOnly}`;
  const blocks: string[] = [];
  // The closing lines count toward the cap too, so it holds for the whole response.
  let used = intro.length + RANKED_TASKS_TAIL_RESERVE;
  let shownCount = 0;
  for (const [index, task] of handed.entries()) {
    const name = task.displayId != null ? `#${task.displayId} ${task.title}` : `${task.title} (a conversation with no task)`;
    const facts = task.taskId ? extras.factsByTaskId.get(task.taskId) : undefined;
    const factLine = facts ? factsInline(facts) : '';
    const span = `${isoDate(task.firstMs)} to ${isoDate(task.lastMs)}`;
    const match = `strength ${task.strength.toFixed(2)}, ${task.matches} ${task.matches === 1 ? 'match' : 'matches'}, ${span}`;
    let block: string;
    if (index < PASSAGES_SHOWN) {
      const ids = [
        ...(task.taskId ? [`taskId: ${task.taskId}`] : []),
        ...(task.sessionId ? [`sessionId: ${task.sessionId}`] : []),
        ...(task.turnUuid ? [`turnUuid: ${task.turnUuid}`] : []),
      ].join(', ');
      const summary = task.taskId ? extras.summaryByTaskId.get(task.taskId) : undefined;
      const passage = task.bestChunkId !== null ? related.passages.get(task.bestChunkId) : undefined;
      block = [
        `- ${name} (${match}${ids ? `, ${ids}` : ''})`,
        ...(factLine ? [`  facts: ${factLine}`] : []),
        ...(summary ? [`  summary: ${summary}`] : []),
        ...(passage ? [`  passage: "${passage}"`] : []),
      ].join('\n');
    } else {
      block = `- ${name} (${match}${task.taskId ? `, taskId: ${task.taskId}` : ''})${factLine ? ` - ${factLine}` : ''}`;
    }
    if (used + block.length + 1 > RANKED_TASKS_RESPONSE_CHARS) break;
    blocks.push(block);
    used += block.length + 1;
    shownCount += 1;
  }
  const hidden = handed.length - shownCount;
  const tail = [
    ...(hidden > 0 ? [`${hidden} more related task(s) not shown. Add words to the query to narrow it.`] : []),
    'Read the turns around a task\'s best passage with kangentic_get_transcript: { sessionId, aroundUuid: <turnUuid>, context: 3 }',
  ];
  return `${intro}\n\n${blocks.join('\n')}\n${tail.join('\n')}`;
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
function formatHits(
  query: string,
  hits: SearchHit[],
  commits: ReadonlyArray<CommitHit & { projectName: string }>,
  notes: ReadonlyArray<string>,
  scope: 'current' | 'all',
): string {
  const noteBlock = notes.length > 0 ? `\n${notes.join('\n')}` : '';
  if (hits.length === 0 && commits.length === 0) {
    return `No hits matching "${query}".${noteBlock}`;
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

  const summary = `Found ${hits.length + commits.length} hit(s) for "${query}" (scope: ${scope}; tasks: ${tasks.length}, backlog: ${backlog.length}, session_event: ${sessionEvents.length}, project: ${projects.length}, conversation: ${conversations.length}, commit: ${commits.length})`;

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

  if (commits.length > 0) {
    const lines = commits.map((hit) => {
      const from = hit.displayId != null && hit.taskTitle
        ? `from #${hit.displayId} ${hit.taskTitle} (project: ${hit.projectName}, taskId: ${hit.taskId})`
        : `no task linked (project: ${hit.projectName})`;
      return `- ${hit.sha.slice(0, 10)} ${isoDate(hit.committedMs)} ${hit.subject} - ${from}`;
    });
    // A heuristic link, said as one: the subject's first writer, not a merge record.
    const hint = 'A commit is linked to the task whose conversation first wrote its subject.';
    sections.push(`## Commits\n${lines.join('\n')}\n${hint}`);
  }

  return `${summary}\n\n${sections.join('\n\n')}${noteBlock}`;
}
