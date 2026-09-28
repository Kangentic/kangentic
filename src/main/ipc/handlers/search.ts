import { ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { IPC } from '../../../shared/ipc-channels';
import { runSearchEverything } from '../../search/search-core';
import { retrievalService } from '../../retrieval/retrieval-service';
import { searchConversationMemory } from '../../retrieval/memory-search';
import { RetrievalStore } from '../../retrieval/retrieval-store';
import { getProjectDb } from '../../db/database';
import { TaskRepository } from '../../db/repositories/task-repository';
import { graphService } from '../../retrieval/graph/graph-service';
import { buildAnswerPrompt, buildFollowUpPrompt, NO_SOURCES_ANSWER, parseAnswerRefs } from '../../retrieval/answer-prompt';
import { answerSessionPool, type PooledAnswerSession, type PrimedAnswerChat } from '../../retrieval/answer-session-pool';
import { AnswerSessionError } from '../../agent/shared/answer-session/stdin-json-session';
import type { AgentAdapter } from '../../agent/agent-adapter';
import type { AnswerStreamEvent } from '../../agent/shared/auto-name';
import {
  buildAnswerTaskTable,
  mergeAnswerTaskTables,
  refPrefixFor,
  taskRef,
  type AnswerTaskRow,
  type BoardTaskFacts,
} from '../../retrieval/answer-tasks';
import {
  PASSAGES_SHOWN,
  passageKey,
  searchRelatedWork,
  searchRelatedWorkAcross,
  toProjectRelatedWork,
  type ProjectRelatedWork,
  type ProjectRelatedWorkTask,
} from '../../retrieval/related-work';
import { watchAnswerSearches } from '../../agent/mcp-http/answer-search-trace';
import { estimateTokens } from '../../retrieval/token-estimate';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import { broadcast } from '../../pop-out/window-broadcast';
import { resolveEmbeddingModel } from '../../../shared/embedding-models';
import { answerSetupGap, resolveAnswerAgent } from '../../../shared/answer-agent';
import { ensureAnswerHomeDirectory, withAnswerRunDirectory } from '../../agent/shared/answer-run-directory';
import { ANSWER_CALLER_PREFIX, appendAnswerCaller } from '../../agent/mcp-http/caller-url';
import type {
  SearchHit,
  SearchRequest,
  MemoryStatus,
  MemoryGraphSnapshot,
  MemoryGraphProjectSummary,
  MemoryGraphQueryResult,
  MemoryGraphQueryHit,
  MemoryGraphAnswerResult,
  MemoryAnswerContext,
  MemoryAnswerPrewarm,
  MemoryAnswerStreamEvent,
  MemoryRelatedTask,
  Project,
} from '../../../shared/types';

/** Earlier turns a follow-up carries. More than this and the prompt pays for
 *  history the question almost never needs. */
const HISTORY_TURNS = 3;
/** How long a question waits for its embedding before searching by keyword alone. */
const RELATED_EMBED_WAIT_MS = 5_000;
/** A project in a question's scope whose map has not been built yet: it brings
 *  its board tasks and no conversations. */
const EMPTY_PROJECTION = { nodes: [], clusterings: [] };

/** Conversations a graph query may match. See the call site for why it is high. */
const GRAPH_QUERY_LIMIT = 300;

/** Characters of the task's title + description used as the recall query.
 *  Enough to carry the task's meaning; past this the embedding blurs. */
const RELATED_QUERY_BUDGET = 1200;
/** Fetched before this task's own conversations are dropped. */
const RELATED_OVERFETCH = 24;
/** Shown. Short enough to read at a glance while reading the task. */
const RELATED_RESULT_COUNT = 5;
import type { IpcContext } from '../ipc-context';

/**
 * Every board task with its facts, for the Memory Graph's task table. Empty
 * when the project database cannot be read, which leaves the table to the
 * indexed conversations rather than failing the question.
 */
function readBoardTasks(projectId: string): BoardTaskFacts[] {
  try {
    return new RetrievalStore(getProjectDb(projectId)).boardTaskFacts().map((task) => {
      const lastActivityMs = task.lastActivity ? Date.parse(task.lastActivity) : Number.NaN;
      return {
        taskId: task.taskId,
        displayId: task.displayId,
        title: task.title,
        outcome: task.outcome,
        sessions: task.sessions,
        costUsd: task.costUsd,
        durationMs: task.durationMs,
        tokens: task.tokens,
        lastActivityMs: Number.isNaN(lastActivityMs) ? null : lastActivityMs,
        agent: task.agent,
        model: task.model,
        filesChanged: task.filesChanged,
        linesAdded: task.linesAdded,
        linesRemoved: task.linesRemoved,
        prNumber: task.prNumber,
        prState: task.prState,
      };
    });
  } catch {
    return [];
  }
}

/** How a question is answered: which agent, CLI, model, effort and search URL.
 *  A warm session is started under exactly these, summed up as `sessionKey`. */
interface AnswerRun {
  adapter: AgentAdapter;
  /** The adapter's fresh run, bound. */
  answerFromContext: NonNullable<AgentAdapter['answerFromContext']>;
  agentName: string;
  cliPath: string;
  model: string | null;
  effort: string | null;
  retrieval: { url: string; token: string } | undefined;
  sessionKey: string;
  /** The one working directory every answer run starts in (`answer-run-directory.ts`). */
  answerHome: string;
}

/**
 * Resolve the answering agent for a question or a prewarm, through the SHARED
 * rule the renderer uses to decide whether a question runs or goes to Settings
 * first, so the two can never disagree. The rule is explicit: the configured
 * agent and model, with no fallback to the project's agent or to any capable one.
 */
async function resolveAnswerRun(
  context: IpcContext,
  homeProjectId: string,
  chatId: string,
): Promise<{ ok: true; run: AnswerRun } | { ok: false; failure: { ok: false; reason: string; setup?: 'agent' | 'model' } }> {
  const { agentRegistry } = await import('../../agent/agent-registry');
  const config = context.configManager.load();
  const agents = agentRegistry.list().flatMap((name) => {
    const entry = agentRegistry.get(name);
    return entry
      ? [{
        name,
        displayName: entry.displayName,
        supportsAnswerFromContext: typeof entry.answerFromContext === 'function',
        answerCapabilities: entry.answerCapabilities,
      }]
      : [];
  });
  const configuredAgent = config.memory?.answerAgent ?? null;
  const configuredModel = config.memory?.answerModel ?? null;
  const setup = answerSetupGap({ agents, configured: configuredAgent, configuredModel });
  if (setup) {
    return {
      ok: false,
      failure: {
        ok: false,
        setup,
        reason: setup === 'agent'
          ? 'choose an agent in the Knowledge Graph card in Settings > Search'
          : 'choose a model in the Knowledge Graph card in Settings > Search',
      },
    };
  }
  const agentName = resolveAnswerAgent({ agents, configured: configuredAgent })?.name ?? '';
  const adapter = agentRegistry.get(agentName);
  if (!adapter?.answerFromContext) return { ok: false, failure: { ok: false, reason: `unknown agent: ${agentName}` } };
  const info = await adapter.detect(config.agent.cliPaths[agentName] ?? null);
  if (!info.found || !info.path) return { ok: false, failure: { ok: false, reason: `${adapter.displayName} CLI not found` } };

  // Effort only for a run that passes it on: the user's level, else the
  // adapter's recommended default, and either only when the CLI reports it
  // right now. A stale level would fail every question: Grok, Copilot and
  // Antigravity all exit on an unknown one.
  const capabilities = adapter.answerCapabilities;
  let effort: string | null = null;
  if (capabilities?.effort && adapter.discoverCapabilities) {
    const discovered = await adapter.discoverCapabilities(info.path).catch(() => undefined);
    const levels = discovered?.effortLevels ?? [];
    const configuredEffort = config.memory?.answerEffort ?? null;
    if (configuredEffort && levels.includes(configuredEffort)) effort = configuredEffort;
    else if (capabilities.defaultEffort && levels.includes(capabilities.defaultEffort)) effort = capabilities.defaultEffort;
  }

  // The ONE tool the agent may reach: Kangentic's own conversation search,
  // scoped to the home project by the URL. Offered only to an agent whose
  // answer run can use it, and only when the MCP server is up. The URL carries
  // an ANSWER caller segment keyed by the chat: the server hands such a caller
  // exactly `kangentic_search` (`buildAnswerMcpServer`) and publishes its
  // searches to the trace.
  const retrieval = context.mcpServerHandle && capabilities?.search
    ? { url: appendAnswerCaller(context.mcpServerHandle.urlForProject(homeProjectId), chatId), token: context.mcpServerHandle.token }
    : undefined;
  const run = {
    adapter,
    answerFromContext: adapter.answerFromContext.bind(adapter),
    agentName,
    cliPath: info.path,
    model: configuredModel,
    effort,
    retrieval,
    answerHome: await ensureAnswerHomeDirectory(),
  };
  return { ok: true, run: { ...run, sessionKey: JSON.stringify([agentName, info.path, configuredModel, effort, retrieval?.url ?? null]) } };
}

/**
 * The chat's warm session under this run, or null when the agent has none.
 * A prewarm passes the chat's end generation from before it awaited, so a
 * chat that ended meanwhile gets nothing.
 */
function takeAnswerSession(chatId: string, run: AnswerRun, endGeneration?: number): PooledAnswerSession<PrimedAnswerChat> | null {
  const openSession = run.adapter.openAnswerSession?.bind(run.adapter);
  if (!openSession) return null;
  try {
    return answerSessionPool.take(chatId, run.sessionKey, (directory) => openSession({
      cliPath: run.cliPath,
      cwd: run.answerHome,
      runDirectory: directory,
      model: run.model,
      effort: run.effort,
      retrieval: run.retrieval,
    }), { endGeneration });
  } catch (error) {
    // A session that cannot start costs the warm path, not the answer.
    console.warn('[memory-graph] answer session did not start, answering with a fresh run:', error);
    return null;
  }
}

/**
 * What a question's task table depends on besides the data: the projects in
 * scope, whose tickets stand bare, the region granularity, and the map filter.
 * A follow-up under the same signature reuses its session's table.
 */
function answerScopeSignature(projectIds: string[], homeProjectId: string, granularity: string, scopeDocKeys: string[] | null): string {
  const filter = scopeDocKeys ? createHash('sha1').update([...scopeDocKeys].sort().join('\n')).digest('hex') : null;
  return JSON.stringify([projectIds, homeProjectId, granularity, filter]);
}

/**
 * IPC handler for the renderer-side global search palette (Ctrl+Shift+F).
 *
 * Pure-logic search lives in `src/main/search/search-core.ts` so the same
 * code powers the MCP tool `kangentic_search`. This handler is
 * just the IPC<->core adapter: trim the query, decide which projects to
 * scan based on `request.scope`, and delegate.
 */
export function registerSearchHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.SEARCH_EVERYTHING, async (_event, request: SearchRequest): Promise<SearchHit[]> => {
    // Cheap pre-check so the empty-query path (palette open before
    // typing) skips even the global-projects scan.
    if (!(request.query ?? '').trim()) return [];

    const allProjects = context.projectRepo.list();
    const projects: Project[] = request.scope === 'all'
      ? allProjects
      : allProjects.filter((project) => project.id === request.currentProjectId);
    if (projects.length === 0) return [];

    const memoryConfig = context.configManager.load().memory;
    const indexingEnabled = memoryConfig?.indexingEnabled !== false;
    // Smart mode adds the semantic/hybrid path; the embedder is null when the
    // semantic layer is off or unavailable, so the search stays lexical.
    const embedder = request.mode === 'smart' ? retrievalService.getEmbedder(context) : null;

    return runSearchEverything({
      query: request.query ?? '',
      projects,
      includeProjectHits: request.scope === 'all',
      projectsForProjectHits: allProjects,
      conversationSearch: { enabled: indexingEnabled, embedder },
    });
  });

  ipcMain.handle(IPC.MEMORY_STATUS, async (): Promise<MemoryStatus> => {
    return retrievalService.getStatus(context);
  });

  // Opening the Knowledge Graph is the precursor gesture for a question: spawn +
  // init the embedding worker now so the typing that follows covers its cold
  // start. Fire-and-forget; embeds nothing. With a chat, the answering agent's
  // warm session starts too, for an agent that has one. An idle session makes
  // no model call, so this costs a process and nothing else.
  ipcMain.on(IPC.MEMORY_PREWARM, (_event, chat?: MemoryAnswerPrewarm) => {
    retrievalService.prewarmEmbedWorker(context);
    if (!chat?.chatId) return;
    const homeProjectId = chat.projectId ?? context.currentProjectId;
    if (!homeProjectId) return;
    // Read before the await: a chat that ends while its agent is resolved must
    // not get a session afterwards.
    const endGeneration = answerSessionPool.endGeneration(chat.chatId);
    void resolveAnswerRun(context, homeProjectId, chat.chatId)
      .then((resolved) => {
        if (resolved.ok) takeAnswerSession(chat.chatId, resolved.run, endGeneration);
      })
      .catch((error: unknown) => console.warn('[memory-graph] answer prewarm failed:', error));
  });

  // The chat's warm session is no longer needed: the chat ended, or its graph
  // closed. The next question in a kept chat opens a fresh one carrying the
  // chat so far.
  ipcMain.on(IPC.MEMORY_GRAPH_END_CHAT, (_event, chatId: string) => {
    if (typeof chatId === 'string' && chatId) answerSessionPool.end(chatId);
  });

  ipcMain.handle(
    IPC.MEMORY_REBUILD_INDEX,
    async (_event, projectId?: string | null): Promise<void> => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!resolvedProjectId) return;
      const project = context.projectRepo.list().find((entry) => entry.id === resolvedProjectId);
      if (!project) return;
      retrievalService.rebuildProjectIndex(context, project);
    },
  );

  // A projection pass finishing is pushed rather than polled: the pass can take
  // a minute on a cold corpus, and MemoryTab already polls memory status on an
  // interval - a second poller for the same subsystem is what this avoids.
  // `broadcast`, not webContents.send, or a detached pop-out never updates.
  graphService.setOnChanged((projectId: string) => {
    if (context.mainWindow.isDestroyed()) return;
    broadcast(context.mainWindow, IPC.MEMORY_GRAPH_CHANGED, projectId);
  });

  ipcMain.handle(
    IPC.MEMORY_GRAPH_SNAPSHOT,
    async (_event, projectId?: string | null): Promise<MemoryGraphSnapshot | null> => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!resolvedProjectId) return null;
      const model = resolveEmbeddingModel(context.configManager.load().memory?.embeddingModel);
      // Cheap by construction: reads the cache, never runs the pass.
      return graphService.getSnapshot(resolvedProjectId, model.modelTag);
    },
  );

  // Retrieval, deliberately reusing `searchConversationMemory` rather than
  // reimplementing it: it already fuses lexical + semantic and collapses to one
  // hit per conversation, which is exactly one graph node. The only work here is
  // translating chunk ids to node keys.
  ipcMain.handle(
    IPC.MEMORY_GRAPH_QUERY,
    async (_event, query: string, projectId?: string | null): Promise<MemoryGraphQueryResult> => {
      const trimmed = (query ?? '').trim();
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!trimmed || !resolvedProjectId) return { query: trimmed, hits: [], semantic: false };

      const project = context.projectRepo.list().find((entry) => entry.id === resolvedProjectId);
      if (!project) return { query: trimmed, hits: [], semantic: false };

      // The embedder comes from the retrieval service, never a fresh
      // EmbedClient: a live user query preempts the background drain in the
      // shared worker (`.claude/rules/central-embedding-engine.md`).
      const embedder = retrievalService.getEmbedder(context);
      // Deliberately generous. This is the SAME hybrid lexical+semantic retrieval
      // the agents' `kangentic_search` reaches through `runSearchEverything` - not
      // a transcript text scan - but the graph uses it as a FILTER rather than as
      // a top-N list, so a cap of 40 would silently hide matching conversations
      // from the map on any real corpus.
      const hits = await searchConversationMemory({ query: trimmed, projects: [project], embedder, k: GRAPH_QUERY_LIMIT });

      const store = new RetrievalStore(getProjectDb(resolvedProjectId));
      const docKeys = store.docKeysForChunks(hits.map((hit) => hit.chunkId));

      return {
        query: trimmed,
        semantic: embedder !== null,
        hits: hits.flatMap((hit) => {
          const docKey = docKeys.get(hit.chunkId);
          // A hit whose chunk vanished between search and lookup has no node to
          // light, and a card pointing at nothing is worse than one fewer card.
          if (docKey === undefined) return [];
          return [{
            docKey,
            sessionId: hit.sessionId,
            taskId: hit.taskId,
            taskTitle: hit.taskTitle,
            agentName: hit.agentName,
            snippet: hit.snippet,
            score: hit.score,
            matchKind: hit.matchKind,
            matchCount: hit.matchCount,
            turnTs: hit.turnTs,
          }];
        }),
      };
    },
  );

  /**
   * Ask: find the work a question is about, show it, and have an agent answer.
   *
   * The pipeline the user watches:
   * 1. The answering agent is resolved and checked first, so a question that
   *    cannot run costs no retrieval.
   * 2. The related work is found locally (`searchRelatedWork`, well under a
   *    second) inside the map's filters, and pushed as a `set` event BEFORE the
   *    agent starts, so the map lights while the CLI is still booting.
   * 3. The agent reads the whole board, the related work and the chat so far,
   *    answers in prose, and may search again; each search is pushed as a
   *    `search` event from the server side of the tool.
   * 4. The refs it wrote come back as source rows, resolved here because the
   *    ref-to-task mapping is this table's and nothing else should know it.
   *
   * Deliberately NOT routed through `spawnAgent`: this never touches
   * `executeTransition`, `resumeSuspendedSession` or `sessionManager.spawn`, so
   * it creates no PTY and no `sessions` row, and needs no spawn-parity allowlist
   * entry. It is the auto-name spawn wearing a different output shape.
   */
  ipcMain.handle(
    IPC.MEMORY_GRAPH_ANSWER,
    async (
      _event,
      question: string,
      projectId?: string | null,
      // The granularity the user is LOOKING at, so a region named in the answer
      // is a region they can see. Defaulted rather than required: a caller that
      // does not care gets the same default the map opens on.
      granularity = 'balanced',
      // Minted by the renderer, so deltas from a question the user has already
      // moved past are dropped rather than appended to the next one. Defaulted
      // for callers that do not stream (the harness, an older renderer).
      requestId: string = '',
      answerContext: MemoryAnswerContext = {},
    ): Promise<MemoryGraphAnswerResult> => {
      try {
        const trimmed = (question ?? '').trim();
        if (!trimmed) return { ok: false, reason: 'ask a question first' };

        // The projects the question is asked across: the map's Projects filter
        // when the renderer sends one, else the one project the call names.
        const openProjectId = projectId ?? context.currentProjectId;
        const requestedIds = answerContext.projectIds && answerContext.projectIds.length > 0
          ? answerContext.projectIds
          : (openProjectId ? [openProjectId] : []);
        const registered = context.projectRepo.list();
        const scopeProjects = requestedIds.flatMap((id) => {
          const entry = registered.find((candidate) => candidate.id === id);
          return entry ? [entry] : [];
        });
        if (scopeProjects.length === 0) return { ok: false, reason: 'no project open' };
        const acrossProjects = scopeProjects.length > 1;
        // Whose tickets stand bare, and whose index a search covers by default:
        // the open project when it is in scope.
        const homeProject = scopeProjects.find((entry) => entry.id === openProjectId) ?? scopeProjects[0];

        const callerChat = answerContext.chatId || requestId || 'oneshot';
        const resolvedRun = await resolveAnswerRun(context, homeProject.id, callerChat);
        if (!resolvedRun.ok) return resolvedRun.failure;
        const { adapter, answerFromContext, cliPath, model: configuredModel, effort, retrieval } = resolvedRun.run;

        // The board: EVERY task inside the map's filters, not a retrieved
        // subset. This is what makes "what was the most expensive" answerable at
        // all - an agent shown 24 of 347 tasks answers confidently about 24.
        // Read from the cached projection alone (`getProjection`), without the
        // coverage a snapshot also computes, since that grouping over every chunk
        // was most of a 267 ms main-thread read per project.
        //
        // Across projects, each project's table is built on its own (its own
        // regions, its own board) and the tables merged, every ticket outside
        // the open project carrying its project's prefix: ticket numbers repeat
        // between projects. A project whose map has not been built yet still
        // brings its board tasks.
        const scope = answerContext.scopeDocKeys ? new Set(answerContext.scopeDocKeys) : null;

        // The chat's warm session, when the agent has one. Under the scope its
        // first turn was asked in, a follow-up reuses that turn's table (the
        // session already holds it) and sends only what is new; any other
        // scope, or no primed turn yet, sends the whole prompt.
        const scopeSignature = answerScopeSignature(scopeProjects.map((entry) => entry.id), homeProject.id, granularity, answerContext.scopeDocKeys ?? null);
        let pooled = answerContext.chatId ? takeAnswerSession(answerContext.chatId, resolvedRun.run) : null;
        // A session primed under another scope holds another table. Sending this
        // one after it would leave two in its context, so it starts over.
        if (answerContext.chatId && pooled?.primed && pooled.primed.scopeSignature !== scopeSignature) {
          answerSessionPool.discard(pooled);
          pooled = takeAnswerSession(answerContext.chatId, resolvedRun.run);
        }
        const primedTable = pooled?.primed?.table ?? null;

        const takenPrefixes = new Set<string>();
        // Across projects EVERY ticket carries its project, the open one's too.
        // With the open project's left bare, an agent read a Kangentic task
        // about the mobile app as "mobile#432": the prefix looked like a topic.
        // A ref that always names its project leaves nothing to infer.
        const parts = scopeProjects.map((entry) => {
          const projection = graphService.getProjection(entry.id);
          const refPrefix = acrossProjects ? refPrefixFor(entry.name, takenPrefixes) : null;
          if (refPrefix) takenPrefixes.add(refPrefix);
          return { project: entry, projection, refPrefix };
        });
        if (parts.every((part) => !part.projection)) return { ok: false, reason: 'the map is still building' };
        const buildTaskTable = () => {
          const tables = parts.map((part) => {
            const boardTasks = timeSyncWork('answer:board-tasks', () => readBoardTasks(part.project.id));
            return timeSyncWork('answer:table', () => buildAnswerTaskTable(part.projection ?? EMPTY_PROJECTION, granularity, scope, boardTasks));
          });
          return acrossProjects
            ? mergeAnswerTaskTables(parts.map((part, index) => ({
              table: tables[index],
              projectId: part.project.id,
              name: part.project.name,
              refPrefix: part.refPrefix,
            })))
            : tables[0];
        };
        const taskTable = primedTable ?? buildTaskTable();
        const projectNameById = new Map(scopeProjects.map((entry) => [entry.id, entry.name]));
        /** The project fields a wire task carries. The name only across projects,
         *  where it is what a row shows. */
        const projectFields = (taskProjectId: string | undefined): Pick<MemoryRelatedTask, 'projectId' | 'projectName'> => {
          const id = taskProjectId ?? homeProject.id;
          const name = acrossProjects ? projectNameById.get(id) : undefined;
          return { projectId: id, ...(name ? { projectName: name } : {}) };
        };

        // Answered WITHOUT spawning when there is genuinely nothing to answer
        // from. Nothing was sent, so zero tokens is the truth, not a gap.
        if (taskTable.rows.length === 0) {
          return {
            ok: true,
            answer: NO_SOURCES_ANSWER,
            rows: [],
            related: [],
            handedCount: 0,
            promptTokens: 0,
            agentName: adapter.displayName,
          };
        }

        // Refs as the prompt writes them, both ways.
        const refByKey = new Map<string, string>();
        const keyByRef = new Map<string, string>();
        const rowByKey = new Map<string, AnswerTaskRow>();
        taskTable.rows.forEach((row, index) => {
          const ref = taskRef(row, index);
          refByKey.set(row.key, ref);
          keyByRef.set(ref, row.key);
          rowByKey.set(row.key, row);
        });
        // A bare ticket still means the open project's task, as it does
        // everywhere else in the app, so an answer that drops the prefix on one
        // of those still resolves. Never another project's: that ticket is theirs.
        taskTable.rows.forEach((row) => {
          if (!acrossProjects || row.projectId !== openProjectId || row.displayId == null) return;
          const bare = `#${row.displayId}`;
          if (!keyByRef.has(bare)) keyByRef.set(bare, row.key);
        });

        const emit = (event: MemoryAnswerStreamEvent): void => {
          if (context.mainWindow.isDestroyed()) return;
          broadcast(context.mainWindow, IPC.MEMORY_GRAPH_ANSWER_STREAM, { requestId, ...event });
        };

        // The related work, found before the agent starts. A follow-up searches
        // the same subject (the earlier questions ride along) and keeps the
        // tasks the turn before was about, or "of those" has no referent.
        const history = (answerContext.history ?? []).slice(-HISTORY_TURNS);
        const previousTurn = history[history.length - 1];
        const projectNodes = parts.map((part) => ({
          projectId: part.project.id,
          nodes: (part.projection?.nodes ?? []).filter((node) => !scope || scope.has(node.docKey)),
        }));
        const nodesInScope = projectNodes.flatMap((entry) => entry.nodes);
        // A failed search costs the related work, not the answer: the table
        // still settles every board question, and the agent can still search.
        let related: ProjectRelatedWork;
        try {
          const searchInput = {
            question: trimmed,
            anchorQuestions: history.map((turn) => turn.question),
            embedder: retrievalService.getEmbedder(context),
            pinnedKeys: new Set(previousTurn?.taskKeys ?? []),
            embedWaitMs: RELATED_EMBED_WAIT_MS,
          };
          related = acrossProjects
            ? await searchRelatedWorkAcross({ ...searchInput, projects: projectNodes })
            : toProjectRelatedWork(
              await searchRelatedWork({ ...searchInput, projectId: homeProject.id, nodes: nodesInScope }),
              homeProject.id,
            );
        } catch (error) {
          console.warn('[memory-graph] related work search failed, answering from the table:', error);
          related = { ranked: [], handed: [], passages: new Map(), semantic: false, elapsedMs: 0 };
        }
        const toWire = (task: ProjectRelatedWorkTask): MemoryRelatedTask => ({
          key: task.key,
          taskId: task.taskId,
          displayId: task.displayId,
          title: task.title,
          strength: task.strength,
          docKeys: task.docKeys,
          passage: task.sessionId ? { sessionId: task.sessionId, turnUuid: task.turnUuid } : null,
          ...projectFields(task.projectId),
          ...(refByKey.has(task.key) ? { ref: refByKey.get(task.key) } : {}),
        });
        const handedWire = related.handed.map(toWire);
        emit({ kind: 'set', related: handedWire, handedCount: related.handed.length });

        const relatedForPrompt = related.handed.flatMap((task, index) => {
          const ref = refByKey.get(task.key);
          if (!ref) return [];
          return [{
            ref,
            title: task.title,
            strength: task.strength,
            matches: task.matches,
            firstMs: task.firstMs,
            lastMs: task.lastMs,
            passage: index < PASSAGES_SHOWN && task.bestChunkId !== null
              ? related.passages.get(passageKey(task.projectId, task.bestChunkId)) ?? null
              : null,
            facts: rowByKey.get(task.key) ?? null,
          }];
        });
        const canSearch = retrieval !== undefined;
        // The whole prompt: table, rules, related work and the chat so far. What
        // a fresh run gets, and what a session's first turn gets.
        const buildFullPrompt = (): string => timeSyncWork('answer:prompt', () => buildAnswerPrompt(trimmed, {
          tasks: taskTable,
          nowMs: Date.now(),
          related: relatedForPrompt,
          history: history.map((turn) => ({
            question: turn.question,
            answer: turn.answer,
            refs: turn.taskKeys.flatMap((key) => {
              const ref = refByKey.get(key);
              return ref ? [ref] : [];
            }),
          })),
          canSearch,
          ...(acrossProjects
            ? { projects: { names: scopeProjects.map((entry) => entry.name), searchDefault: homeProject.name } }
            : {}),
        }));
        const prompt = primedTable
          ? buildFollowUpPrompt(trimmed, { related: relatedForPrompt, canSearch })
          : buildFullPrompt();
        // What this question cost to ask, reported rather than estimated after
        // the fact, with the same estimator the chunker sizes text with.
        const promptTokens = estimateTokens(prompt);

        // The agent's own searches, shown as they happen: a step line in the
        // chat and rings on the map.
        const docKeysBySession = new Map<string, string[]>();
        for (const node of nodesInScope) {
          if (!node.sessionId) continue;
          const list = docKeysBySession.get(node.sessionId) ?? [];
          list.push(node.docKey);
          docKeysBySession.set(node.sessionId, list);
        }
        const stopTrace = retrieval
          ? watchAnswerSearches(`${ANSWER_CALLER_PREFIX}${callerChat}`, (search) => {
            emit({
              kind: 'search',
              query: search.query,
              docKeys: search.sessionIds.flatMap((sessionId) => docKeysBySession.get(sessionId) ?? []),
            });
          })
          : () => {};

        const onEvent = (event: AnswerStreamEvent): void => {
          if (event.kind === 'text') emit({ kind: 'text', text: event.text });
          else emit({ kind: 'tool', name: event.name });
        };
        // A fresh run starts in the answer home, never the project (whose
        // instruction files cost 18,700 tokens a question on this repo), and
        // writes what it passes by path into a run directory of its own that
        // goes when it ends. See `answer-run-directory.ts` for why the two differ.
        const runFresh = (freshPrompt: string): Promise<string> => withAnswerRunDirectory((runDirectory) => (
          answerFromContext(freshPrompt, cliPath, resolvedRun.run.answerHome, configuredModel, { retrieval, effort, onEvent, runDirectory })
        ));
        let raw: string;
        try {
          if (pooled) {
            try {
              raw = await pooled.session.ask(prompt, onEvent);
              pooled.primed = { scopeSignature, table: taskTable };
              answerSessionPool.touch(pooled);
            } catch (error) {
              // A failed turn leaves the session in a state not worth reusing.
              answerSessionPool.discard(pooled);
              // A process that died before writing anything (it crashed, or
              // lost its connection at start) is retried once as a fresh run,
              // which the reader never sees. Anything else is the answer's
              // real failure and is shown as one.
              if (!(error instanceof AnswerSessionError && error.failure === 'exited' && error.beforeText)) throw error;
              raw = await runFresh(primedTable ? buildFullPrompt() : prompt);
            }
          } else {
            raw = await runFresh(prompt);
          }
        } finally {
          stopTrace();
          // The stream ends whether the call succeeded or threw, so the renderer
          // is never left holding a partial answer it thinks is still growing.
          emit({ kind: 'done' });
        }
        if (!raw) return { ok: false, reason: 'the agent returned nothing' };

        // Rows: the tasks the prose names, in the order named, then the rest of
        // the selection by strength. A bare `#2` counts only when it resolves to
        // a task the answer could be about (see `parseAnswerRefs`).
        const relatedByKey = new Map(related.handed.map((task) => [task.key, task]));
        const { selected, mentioned, text: answer } = parseAnswerRefs(
          raw,
          keyByRef,
          new Set(relatedByKey.keys()),
        );
        const orderedKeys = [
          ...mentioned,
          ...selected
            .filter((key) => !mentioned.includes(key))
            .sort((left, right) => (relatedByKey.get(right)?.strength ?? 0) - (relatedByKey.get(left)?.strength ?? 0)),
        ];
        const rows = orderedKeys.flatMap((key): MemoryRelatedTask[] => {
          const relatedTask = relatedByKey.get(key);
          if (relatedTask) return [toWire(relatedTask)];
          // Selected without the search finding it: a board question ("the
          // longest task") answered from the table alone.
          const row = rowByKey.get(key);
          if (!row) return [];
          return [{
            key: row.key,
            taskId: row.taskId,
            displayId: row.displayId,
            title: row.title,
            strength: 1,
            docKeys: row.docKeys,
            passage: null,
            ...projectFields(row.projectId),
            ...(refByKey.has(row.key) ? { ref: refByKey.get(row.key) } : {}),
          }];
        });

        return {
          ok: true,
          answer,
          rows,
          related: handedWire,
          handedCount: related.handed.length,
          promptTokens,
          agentName: adapter.displayName,
        };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  /**
   * Proactive recall: earlier conversations near THIS task.
   *
   * The graph as built is a place you have to remember to visit. This is the
   * same retrieval pointed the other way - the index finding you while you are
   * reading a task, which is the moment "have I already worked this out?"
   * actually matters.
   *
   * The task's own title and description ARE the query, so there is nothing to
   * type. Its own conversations are excluded: a task's own history is already
   * one click away in the header, and leaving it in would crowd out the prior
   * work this exists to surface.
   */
  ipcMain.handle(
    IPC.MEMORY_RELATED_TO_TASK,
    async (_event, taskId: string, projectId?: string | null): Promise<MemoryGraphQueryHit[]> => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!taskId || !resolvedProjectId) return [];
      const project = context.projectRepo.list().find((entry) => entry.id === resolvedProjectId);
      if (!project) return [];

      const db = getProjectDb(resolvedProjectId);
      const task = new TaskRepository(db).getById(taskId);
      if (!task) return [];

      const query = `${task.title}\n${task.description ?? ''}`.trim().slice(0, RELATED_QUERY_BUDGET);
      if (query.length === 0) return [];

      const embedder = retrievalService.getEmbedder(context);
      const hits = await searchConversationMemory({
        query,
        projects: [project],
        embedder,
        // Over-fetch: this task's own conversations are usually the strongest
        // matches (its description IS the query), so they must be dropped after
        // ranking, not before.
        k: RELATED_OVERFETCH,
      });

      const store = new RetrievalStore(db);
      const docKeys = store.docKeysForChunks(hits.map((hit) => hit.chunkId));

      // One row per TASK, not per session. `searchConversationMemory` collapses
      // to one hit per session, but a task usually has several - so the raw
      // list repeats the same task title back at the user, which reads as a
      // bug. For "what have I already worked on", the task is the unit.
      const seenTaskIds = new Set<string>();

      return hits
        .filter((hit) => {
          if (hit.taskId === taskId) return false;
          // Hits arrive score-ordered, so the first one kept per task is its
          // strongest.
          if (hit.taskId !== null) {
            if (seenTaskIds.has(hit.taskId)) return false;
            seenTaskIds.add(hit.taskId);
          }
          return true;
        })
        .slice(0, RELATED_RESULT_COUNT)
        .flatMap((hit) => {
          const docKey = docKeys.get(hit.chunkId);
          if (docKey === undefined) return [];
          return [{
            docKey,
            sessionId: hit.sessionId,
            taskId: hit.taskId,
            taskTitle: hit.taskTitle,
            agentName: hit.agentName,
            snippet: hit.snippet,
            score: hit.score,
            matchKind: hit.matchKind,
            matchCount: hit.matchCount,
            turnTs: hit.turnTs,
          }];
        });
    },
  );

  /**
   * Every project, for the Knowledge Graph's Projects picker: its name, how many
   * conversations its map would draw, and when its index last took one in.
   *
   * Opens each project's database, which Quick Find's cross-project search
   * already does, and reads an index-only count from each (12ms across 19 real
   * projects, warm). A project whose database cannot be read lists as having
   * nothing indexed rather than failing the whole list.
   */
  ipcMain.handle(IPC.MEMORY_GRAPH_PROJECTS, (): MemoryGraphProjectSummary[] => {
    return context.projectRepo.list().map((project) => {
      try {
        const summary = new RetrievalStore(getProjectDb(project.id)).conversationSummary();
        const lastActivityMs = summary.lastIndexedAt ? Date.parse(summary.lastIndexedAt) : Number.NaN;
        return {
          id: project.id,
          name: project.name,
          conversations: summary.conversations,
          lastActivityMs: Number.isNaN(lastActivityMs) ? null : lastActivityMs,
        };
      } catch {
        return { id: project.id, name: project.name, conversations: 0, lastActivityMs: null };
      }
    });
  });

  ipcMain.handle(
    IPC.MEMORY_GRAPH_REFRESH,
    async (_event, projectId?: string | null): Promise<void> => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!resolvedProjectId) return;
      const model = resolveEmbeddingModel(context.configManager.load().memory?.embeddingModel);
      // Returns immediately. The pass is self-paced in the background, so a
      // handler never performs the scan or the vector math itself.
      graphService.markDirty(resolvedProjectId, model.modelTag, model.dimensions);
    },
  );
}
