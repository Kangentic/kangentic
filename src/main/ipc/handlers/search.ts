import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { runSearchEverything } from '../../search/search-core';
import { retrievalService } from '../../retrieval/retrieval-service';
import { searchConversationMemory } from '../../retrieval/memory-search';
import { RetrievalStore } from '../../retrieval/retrieval-store';
import { getProjectDb } from '../../db/database';
import { TaskRepository } from '../../db/repositories/task-repository';
import { graphService } from '../../retrieval/graph/graph-service';
import { buildAnswerPrompt, NO_SOURCES_ANSWER, parseAnswerRefs } from '../../retrieval/answer-prompt';
import {
  buildAnswerTaskTable,
  taskRef,
  type AnswerTaskRow,
  type BoardTaskFacts,
} from '../../retrieval/answer-tasks';
import {
  PASSAGES_SHOWN,
  searchRelatedWork,
  type RelatedWork,
  type RelatedWorkTask,
} from '../../retrieval/related-work';
import { watchAnswerSearches } from '../../agent/mcp-http/answer-search-trace';
import { estimateTokens } from '../../retrieval/token-estimate';
import { broadcast } from '../../pop-out/window-broadcast';
import { resolveEmbeddingModel } from '../../../shared/embedding-models';
import { answerSetupGap, resolveAnswerAgent } from '../../../shared/answer-agent';
import { withAnswerRunDirectory } from '../../agent/shared/answer-run-directory';
import { ANSWER_CALLER_PREFIX, appendAnswerCaller } from '../../agent/mcp-http/caller-url';
import type {
  SearchHit,
  SearchRequest,
  MemoryStatus,
  MemoryGraphSnapshot,
  MemoryGraphQueryResult,
  MemoryGraphQueryHit,
  MemoryGraphAnswerResult,
  MemoryAnswerContext,
  MemoryAnswerStreamEvent,
  MemoryRelatedTask,
  Project,
} from '../../../shared/types';

/** Earlier turns a follow-up carries. More than this and the prompt pays for
 *  history the question almost never needs. */
const HISTORY_TURNS = 3;
/** How long a question waits for its embedding before searching by keyword alone. */
const RELATED_EMBED_WAIT_MS = 5_000;

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
      };
    });
  } catch {
    return [];
  }
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
  // start. Fire-and-forget; embeds nothing.
  ipcMain.on(IPC.MEMORY_PREWARM, () => {
    retrievalService.prewarmEmbedWorker(context);
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

        const resolvedProjectId = projectId ?? context.currentProjectId;
        if (!resolvedProjectId) return { ok: false, reason: 'no project open' };
        const project = context.projectRepo.list().find((entry) => entry.id === resolvedProjectId);
        if (!project) return { ok: false, reason: 'no project open' };

        const { agentRegistry } = await import('../../agent/agent-registry');
        const config = context.configManager.load();

        // Resolved through the SHARED rule the renderer uses to decide whether
        // a question runs or goes to Settings > Search first, so the two can
        // never disagree. The rule is explicit: the configured agent and model,
        // with no fallback to the project's agent or to any capable one.
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
            setup,
            reason: setup === 'agent'
              ? 'choose an agent in the Knowledge Graph card in Settings > Search'
              : 'choose a model in the Knowledge Graph card in Settings > Search',
          };
        }
        const resolved = resolveAnswerAgent({ agents, configured: configuredAgent });
        const agentName = resolved?.name ?? '';
        const adapter = agentRegistry.get(agentName);
        if (!adapter?.answerFromContext) {
          return { ok: false, reason: `unknown agent: ${agentName}` };
        }
        const info = await adapter.detect(config.agent.cliPaths[agentName] ?? null);
        if (!info.found || !info.path) {
          return { ok: false, reason: `${adapter.displayName} CLI not found` };
        }

        // The board: EVERY task inside the map's filters, not a retrieved
        // subset. This is what makes "what was the most expensive" answerable at
        // all - an agent shown 24 of 347 tasks answers confidently about 24.
        // Read from the cached projection, which is a cheap read by contract.
        const model = resolveEmbeddingModel(config.memory?.embeddingModel);
        const snapshot = graphService.getSnapshot(resolvedProjectId, model.modelTag);
        const projection = snapshot.projection;
        if (!projection) return { ok: false, reason: 'the map is still building' };
        const scope = answerContext.scopeDocKeys ? new Set(answerContext.scopeDocKeys) : null;
        const taskTable = buildAnswerTaskTable(projection, granularity, scope, readBoardTasks(resolvedProjectId));

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

        const emit = (event: MemoryAnswerStreamEvent): void => {
          if (context.mainWindow.isDestroyed()) return;
          broadcast(context.mainWindow, IPC.MEMORY_GRAPH_ANSWER_STREAM, { requestId, ...event });
        };

        // The related work, found before the agent starts. A follow-up searches
        // the same subject (the earlier questions ride along) and keeps the
        // tasks the turn before was about, or "of those" has no referent.
        const history = (answerContext.history ?? []).slice(-HISTORY_TURNS);
        const previousTurn = history[history.length - 1];
        const nodesInScope = projection.nodes.filter((node) => !scope || scope.has(node.docKey));
        // A failed search costs the related work, not the answer: the table
        // still settles every board question, and the agent can still search.
        let related: RelatedWork;
        try {
          related = await searchRelatedWork({
            question: trimmed,
            anchorQuestions: history.map((turn) => turn.question),
            projectId: resolvedProjectId,
            nodes: nodesInScope,
            embedder: retrievalService.getEmbedder(context),
            pinnedKeys: new Set(previousTurn?.taskKeys ?? []),
            embedWaitMs: RELATED_EMBED_WAIT_MS,
          });
        } catch (error) {
          console.warn('[memory-graph] related work search failed, answering from the table:', error);
          related = { ranked: [], handed: [], passages: new Map(), semantic: false, elapsedMs: 0 };
        }
        const toWire = (task: RelatedWorkTask): MemoryRelatedTask => ({
          key: task.key,
          taskId: task.taskId,
          displayId: task.displayId,
          title: task.title,
          strength: task.strength,
          docKeys: task.docKeys,
          passage: task.sessionId ? { sessionId: task.sessionId, turnUuid: task.turnUuid } : null,
        });
        const handedWire = related.handed.map(toWire);
        emit({ kind: 'set', related: handedWire, handedCount: related.handed.length });

        // The ONE tool the agent may reach: Kangentic's own conversation search,
        // scoped to this project by the URL. Offered only to an agent whose
        // answer run can use it, and only when the MCP server is up.
        //
        // The URL carries an ANSWER caller segment, keyed by the chat: the
        // server hands such a caller exactly `kangentic_search`
        // (`buildAnswerMcpServer`) and publishes its searches to the trace.
        const capabilities = adapter.answerCapabilities;
        // Effort only for a run that passes it on: the user's level, else the
        // adapter's recommended default, and either only when the CLI reports
        // it right now. A stale level would fail every question: Grok, Copilot
        // and Antigravity all exit on an unknown one.
        let effort: string | null = null;
        if (capabilities?.effort && adapter.discoverCapabilities) {
          const discovered = await adapter.discoverCapabilities(info.path).catch(() => undefined);
          const levels = discovered?.effortLevels ?? [];
          const configuredEffort = config.memory?.answerEffort ?? null;
          if (configuredEffort && levels.includes(configuredEffort)) effort = configuredEffort;
          else if (capabilities.defaultEffort && levels.includes(capabilities.defaultEffort)) effort = capabilities.defaultEffort;
        }
        const callerChat = answerContext.chatId || requestId || 'oneshot';
        const retrieval = context.mcpServerHandle && capabilities?.search
          ? {
            url: appendAnswerCaller(context.mcpServerHandle.urlForProject(resolvedProjectId), callerChat),
            token: context.mcpServerHandle.token,
          }
          : undefined;

        const prompt = buildAnswerPrompt(trimmed, {
          tasks: taskTable,
          nowMs: Date.now(),
          related: related.handed.flatMap((task, index) => {
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
                ? related.passages.get(task.bestChunkId) ?? null
                : null,
              facts: rowByKey.get(task.key) ?? null,
            }];
          }),
          history: history.map((turn) => ({
            question: turn.question,
            answer: turn.answer,
            refs: turn.taskKeys.flatMap((key) => {
              const ref = refByKey.get(key);
              return ref ? [ref] : [];
            }),
          })),
          canSearch: retrieval !== undefined,
        });
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

        // A NEUTRAL directory, not the project, and a fresh one per question.
        // Measured: spawning in the project made the CLI load its CLAUDE.md and
        // every always-on rule - 18,700 tokens on this repo per question; Grok
        // loaded about 100k tokens of instruction files for a one-word reply.
        // Fresh per question because runs write into it: a prompt file for a CLI
        // that reads one, a per-run MCP config with the live token.
        const answerFromContext = adapter.answerFromContext.bind(adapter);
        const cliPath = info.path;
        let raw: string;
        try {
          raw = await withAnswerRunDirectory((runDirectory) => answerFromContext(prompt, cliPath, runDirectory, configuredModel, {
            retrieval,
            effort,
            onEvent: (event) => {
              if (event.kind === 'text') emit({ kind: 'text', text: event.text });
              else emit({ kind: 'tool', name: event.name });
            },
          }));
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
