import * as os from 'node:os';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { runSearchEverything } from '../../search/search-core';
import { retrievalService } from '../../retrieval/retrieval-service';
import { searchConversationMemory } from '../../retrieval/memory-search';
import { RetrievalStore } from '../../retrieval/retrieval-store';
import { getProjectDb } from '../../db/database';
import { TaskRepository } from '../../db/repositories/task-repository';
import { graphService } from '../../retrieval/graph/graph-service';
import {
  buildAnswerPrompt, NO_SOURCES_ANSWER, parseAnswerView, parseGrounds, parseSelectedRefs,
} from '../../retrieval/answer-prompt';
import { compareByField, taskFieldByKey } from '../../../shared/memory-task-fields';
import { buildAnswerTaskTable } from '../../retrieval/answer-tasks';
import { estimateTokens } from '../../retrieval/token-estimate';
import { broadcast } from '../../pop-out/window-broadcast';
import { resolveEmbeddingModel } from '../../../shared/embedding-models';
import { resolveAnswerAgent } from '../../../shared/answer-agent';
import type {
  SearchHit,
  SearchRequest,
  MemoryStatus,
  MemoryGraphSnapshot,
  MemoryGraphQueryResult,
  MemoryGraphQueryHit,
  MemoryGraphAnswerResult,
  MemoryAnswerStreamEvent,
  Project,
} from '../../../shared/types';

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
   * Ask: an agent answers a question FROM the retrieved conversations.
   *
   * The half of this surface search cannot do. Search is a retrieval tool and
   * answers a retrieval question; asked a real question ("why did we drop the
   * sphere fit?") it correctly returns every conversation about sphere fits and
   * leaves the reading to you. There is no relevance floor that would fix that,
   * because the score the UI could threshold on is RRF, which is purely ordinal
   * and carries no similarity at all.
   *
   * So the retrieval is IDENTICAL to the map's own search - the same
   * `searchConversationMemory`, the same fusion, the same one-hit-per-
   * conversation collapse - and the only new thing is that the passages behind
   * those hits go to an agent with the question and a rule that it may use
   * nothing else.
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

        // The agent is resolved and CHECKED before any retrieval runs. Doing the
        // search first would spend real work on a question that cannot be
        // answered, and then report the CLI failure as if the search had failed.
        //
        // Resolved through the SHARED chain the renderer uses to decide whether
        // to offer Ask and whose name to print, so the button can never name one
        // agent while a different one replies.
        const resolved = resolveAnswerAgent({
          agents: agentRegistry.list().flatMap((name) => {
            const entry = agentRegistry.get(name);
            return entry
              ? [{
                name,
                displayName: entry.displayName,
                supportsAnswerFromContext: typeof entry.answerFromContext === 'function',
              }]
              : [];
          }),
          configured: config.memory?.answerAgent ?? null,
          projectAgent: project.default_agent,
        });
        if (!resolved) return { ok: false, reason: 'no installed agent can answer questions' };
        const agentName = resolved.name;
        const adapter = agentRegistry.get(agentName);
        if (!adapter?.answerFromContext) {
          return { ok: false, reason: `unknown agent: ${agentName}` };
        }
        const info = await adapter.detect(config.agent.cliPaths[agentName] ?? null);
        if (!info.found || !info.path) {
          return { ok: false, reason: `${adapter.displayName} CLI not found` };
        }

        // The board half: EVERY task, not a retrieved subset. This is what makes
        // "which tasks are X" and "what was the most expensive" answerable at
        // all - an agent shown 24 of 347 tasks answers confidently about 24.
        // Read from the cached projection, which is a cheap read by contract.
        //
        // The TRANSCRIPT half is no longer retrieved here. It used to be - our
        // search chose 24 passages before the agent saw the question, and the
        // agent answered from whatever it was handed with no way to recover
        // when the retrieval had misjudged. The agent now holds the search tool
        // itself (`retrieval` below) and pulls passages only when the table
        // cannot answer, with a query it chose, and again if the first miss.
        const model = resolveEmbeddingModel(config.memory?.embeddingModel);
        const snapshot = graphService.getSnapshot(resolvedProjectId, model.modelTag);
        const projection = snapshot.projection;
        const taskTable = projection ? buildAnswerTaskTable(projection, granularity) : null;

        // Answered WITHOUT spawning when there is genuinely nothing to answer
        // from: no map means no table and no index to search.
        if (!taskTable || !projection) return { ok: false, reason: 'the map is still building' };
        if (taskTable.rows.length === 0) {
          return {
            ok: true,
            answer: NO_SOURCES_ANSWER,
            selectedDocKeys: [],
            taskRefs: [],
            view: null,
            grounds: null,
            // Nothing was sent, so nothing was spent. Zero is the truth here,
            // not a missing measurement.
            promptTokens: 0,
            taskCount: 0,
            agentName: adapter.displayName,
          };
        }

        // The model is only meaningful for the agent it was chosen against, and
        // the setting is cleared when the agent changes - but a config written
        // by an older build, or hand-edited, can still pair them wrongly. Passed
        // only when the RESOLVED agent is the one the setting names, so a stale
        // pairing falls back to the agent's default instead of a bad flag.
        const configuredAnswerModel = config.memory?.answerModel ?? null;
        const answerModel = config.memory?.answerAgent === agentName ? configuredAnswerModel : null;

        const prompt = buildAnswerPrompt(trimmed, { tasks: taskTable, nowMs: Date.now() });
        // What this question actually cost to ask, reported rather than
        // estimated after the fact. Ask spends most of its tokens BEFORE the
        // agent does anything - a complete task table plus a passage budget -
        // and none of that was observable from outside, so "make it cheaper"
        // had no number to move. Same estimator the chunker sizes text with,
        // so this figure and the index's own token accounting agree.
        const promptTokens = estimateTokens(prompt);

        // A NEUTRAL directory, not the project.
        //
        // Measured: spawning in the project made the CLI load its CLAUDE.md and
        // every always-on rule - 18,700 tokens on this repo, on every question,
        // none of which Ask uses. The prompt is self-contained by construction
        // and the rules say to answer only from what is in it.
        //
        // So this is not merely cheaper, it is more correct: project context is
        // exactly the outside knowledge the prompt forbids drawing on, and
        // handing it over while forbidding its use is a contradiction the
        // measured "capital of France" leak was the visible edge of.
        //
        // Safe because the answer call has no tools, so there is nothing in a
        // working directory for it to reach. Verified against the real CLI:
        // running outside a project needs no trust prompt in print mode.
        // The ONE tool the agent may reach: Kangentic's own conversation search,
        // scoped to this project by the URL. Offered only when the MCP server is
        // up; without it the agent answers from the table alone, which is a
        // degraded answer rather than a failed one.
        const retrieval = context.mcpServerHandle
          ? { url: context.mcpServerHandle.urlForProject(resolvedProjectId), token: context.mcpServerHandle.token }
          : undefined;

        // Progress goes out as it happens: text as the agent writes it, and a
        // tool call as it starts, so a multi-turn answer reads as work in
        // progress rather than a longer spinner. `broadcast` rather than
        // `webContents.send`, or a detached window never sees a word.
        const emit = (event: MemoryAnswerStreamEvent): void => {
          if (context.mainWindow.isDestroyed()) return;
          broadcast(context.mainWindow, IPC.MEMORY_GRAPH_ANSWER_STREAM, { requestId, ...event });
        };

        let raw: string;
        try {
          raw = await adapter.answerFromContext(prompt, info.path, os.tmpdir(), answerModel, {
            retrieval,
            onEvent: (event) => {
              if (event.kind === 'text') emit({ kind: 'text', text: event.text });
              else emit({ kind: 'tool', name: event.name });
            },
          });
        } finally {
          // The stream ends whether the call succeeded or threw, so the renderer
          // is never left holding a partial answer it thinks is still growing.
          emit({ kind: 'done' });
        }
        if (!raw) return { ok: false, reason: 'the agent returned nothing' };

        // A selection answer carries its refs on a trailing line. Resolved back
        // to docKeys HERE rather than in the renderer, because the ref-to-task
        // mapping is this table's row order and nothing else should have to know
        // that. An out-of-range ref is dropped rather than failing the answer:
        // the prose is still worth showing.
        //
        // The view is parsed FIRST so its line is stripped before the ref scan
        // runs: `VIEW: cost_usd desc` contains no `T<n>`, but a future column
        // could, and a protocol line is not prose the reader should see either.
        const { view, text: withoutView } = parseAnswerView(raw);
        // Grounds come out BEFORE the ref scan, for the same reason the view
        // does: a quoted table row legitimately contains `T12`, and counting a
        // ref the answer only quoted would scope the map to a task the prose
        // never actually named.
        const { grounds, text: withoutGrounds } = parseGrounds(withoutView);
        const { refs, mentioned, text: answer } = parseSelectedRefs(withoutGrounds);
        const docKeysForRefs = (rowRefs: ReadonlyArray<number>): string[] => {
          const taskIds = new Set(rowRefs
            .map((ref) => taskTable.rows[ref - 1]?.taskId ?? null)
            .filter((taskId): taskId is string => taskId !== null));
          if (taskIds.size === 0) return [];
          return projection.nodes
            .filter((node) => node.taskId !== null && taskIds.has(node.taskId))
            .map((node) => node.docKey);
        };
        const selectedDocKeys = docKeysForRefs(refs);

        // Every task the answer NAMED, so `T133` in prose is a control rather
        // than dead text. Separate from the selection on purpose: naming a task
        // while explaining something is not the same as saying the map should
        // scope to it, and conflating them would re-scope the map on every
        // answer that happens to mention a task.
        const taskRefs = mentioned.flatMap((ref) => {
          const row = taskTable.rows[ref - 1];
          if (!row) return [];
          const docKeys = docKeysForRefs([ref]);
          if (docKeys.length === 0) return [];
          // EVERY fact the prompt showed, not a hand-picked four. `title` and
          // `taskId` are the row's own; the rest is the same `MemoryTaskFacts`
          // the table was generated from, spread wholesale so a new column
          // cannot reach the agent without also reaching the rail.
          const { taskId: _taskId, title, ...facts } = row;
          return [{ ref, title, docKeys, ...facts }];
        });

        // Ordered as the answer asked. Falls back to the order the tasks were
        // NAMED IN, which `parseSelectedRefs` preserves - the one order that
        // can never look wrong, because it is the order the reader has already
        // seen in the prose above the rail.
        const orderField = view?.order ? taskFieldByKey(view.order.key) : null;
        if (orderField && view?.order) {
          taskRefs.sort(compareByField(orderField, view.order.direction));
        }

        return {
          ok: true,
          answer,
          selectedDocKeys,
          taskRefs,
          view,
          grounds,
          promptTokens,
          taskCount: taskTable.rows.length,
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
