/**
 * Dev-only: mirror the REAL conversation index (all of it by default) into an ephemeral
 * preview project, so the Knowledge Graph can be judged against actual work.
 *
 * Why this exists alongside the synthetic seeder: synthetic data proves the
 * plumbing and gives tests a planted ground truth, but its text is deliberately
 * meaningless, which makes every product question unanswerable. You cannot tell
 * whether the layout groups things sensibly, whether a cluster label is any
 * good, or whether a result card is worth clicking, when every card reads
 * "agent conversation 82, chunk 4. cli permission agent claude agent". Real
 * titles and real text are the only way to see whether the surface is useful.
 *
 * No inference is involved: the source project's embeddings already exist, so
 * this is a copy, not a re-embed. All but the newest chunks, which are left
 * for the embedding drain (`EMBEDDING_BACKLOG_CHUNKS`).
 *
 * The board half (tasks, sessions, churn, ticket numbers) is written here on
 * main and committed first; the index half, chunks and vectors, is copied by
 * the retrieval worker (`dev.mirrorIndex`), the only process that loads
 * sqlite-vec. This side reads the source through a plain connection and never
 * touches a vector.
 *
 * Build-excluded from production (`__KANGENTIC_DEV__`); see
 * `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getProjectDb } from '../../main/db/database';
import { getPlatformConfigDir } from '../../main/config/paths';
import { parseLabels } from '../../main/retrieval/task/task-record';
import { embedEngine } from '../../main/retrieval/embedder/embed-engine';
import { retrievalService } from '../../main/retrieval/retrieval-service';
import { retrievalClient } from '../../main/retrieval/retrieval-client';
import { TaskRepository } from '../../main/db/repositories/task-repository';
import { SessionRepository } from '../../main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../main/db/repositories/swimlane-repository';
import { isSamePath, toForwardSlash } from '../../shared/paths';
import type { DevSeedKnowledgeGraphRealResult, DevSeedKnowledgeGraphRealUnavailable } from '../../shared/types';
import type { IpcContext } from '../../main/ipc/ipc-context';
import type { MirrorDocument } from '../worker/dev-index-methods';
import { EMBEDDING_BACKLOG_CHUNKS, pendingChunkCounts } from './seed-knowledge-graph-vectors';
import { writeTransaction } from '../../main/db/transaction';

const WORKTREE_MARKER = '/.kangentic/worktrees/';
/**
 * Documents copied by default: all of them. SQLite reads a negative LIMIT as
 * no limit.
 *
 * The default used to be the newest 150, because the projection built from the
 * copy scans every vector and 400 conversations once cost ~58s of it. The
 * projection is faster now: the whole index (995 conversations, 89,205 chunks)
 * seeds and builds in about 35s (33.5s and 36.6s measured). And a partial mirror is not the index a user asks
 * against: a topic question in the Knowledge Graph ranked only the newest 150
 * conversations, so its answers could not be compared with the real app's.
 *
 * Pass a smaller `documentLimit` for a quicker seed when the corpus size is not
 * what is being tested.
 */
const DEFAULT_DOCUMENT_LIMIT = -1;

/** The real (non-ephemeral) project this preview was cloned from, if resolvable,
 *  or the real project `selector` names (by id, or by name ignoring case).
 *  `getPlatformConfigDir()` deliberately ignores KANGENTIC_DATA_DIR, so it still
 *  points at the real config dir from inside a preview. */
function resolveSourceProject(selector?: string): { id: string; name: string; dbPath: string } | null {
  const normalizedCwd = toForwardSlash(path.resolve(process.cwd()));
  const markerIndex = normalizedCwd.indexOf(WORKTREE_MARKER);
  const parentRoot = markerIndex === -1 ? normalizedCwd : normalizedCwd.slice(0, markerIndex);

  const configDir = getPlatformConfigDir();
  const globalDbPath = path.join(configDir, 'index.db');
  if (!fs.existsSync(globalDbPath)) return null;

  const globalDb = new Database(globalDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = globalDb.prepare('SELECT id, name, path FROM projects').all() as Array<{
      id: string;
      name: string;
      path: string;
    }>;
    const wanted = selector?.trim().toLowerCase();
    const match = wanted
      ? rows.find((row) => row.id === selector || row.name.toLowerCase() === wanted)
      : rows.find((row) => isSamePath(row.path, parentRoot));
    if (!match) return null;
    const dbPath = path.join(configDir, 'projects', `${match.id}.db`);
    return fs.existsSync(dbPath) ? { id: match.id, name: match.name, dbPath } : null;
  } finally {
    globalDb.close();
  }
}

interface SourceDocument {
  docId: string;
  sessionId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  sessionType: string | null;
  chunkCount: number;
  lastTs: number | null;
}

export interface SeedKnowledgeGraphRealOptions {
  documentLimit?: number;
  /**
   * Mirror a different real project (its id, or its name) instead of the one
   * this preview was cloned from, into whichever preview project is open. How a
   * second project is seeded to check the Knowledge Graph across projects.
   * Passed at run time, so no real project's name is written into the repo.
   */
  sourceProject?: string;
  /**
   * How many of the newest chunks to copy without their vectors, for the
   * embedding drain. `EMBEDDING_BACKLOG_CHUNKS` by default; 0 copies every
   * vector, and a count above the index's size leaves all of it pending, the
   * backlog a model switch creates.
   */
  embeddingBacklog?: number;
}

/** Thrown when there is no real index here to copy; the handler turns it into
 *  an `unavailable` answer, and the harness falls back to the synthetic seed. */
class NoRealIndexError extends Error {}

/** What the mirror needs from a source session row to make a preview node
 *  look like the real thing in the detail panel. */
interface SourceSessionFacts {
  readonly sessionType: string;
  readonly model: string | null;
  readonly effort: string | null;
  /** What the work cost. Carried for the same reason the lane role and the
   *  model are: the hover cards report duration, cost and tokens now, and a
   *  fixture that cannot express a field leaves it looking permanently broken. */
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCalls: number | null;
}

/**
 * Copy the most recent `documentLimit` indexed conversations (all of them by
 * default) - chunks, vectors,
 * index state, and the tasks/sessions they hang off - from the real parent
 * project into the currently open (preview) project.
 */
export async function seedKnowledgeGraphFromRealIndex(
  context: IpcContext,
  options: SeedKnowledgeGraphRealOptions = {},
): Promise<DevSeedKnowledgeGraphRealResult> {
  const projectId = context.currentProjectId;
  const projectPath = context.currentProjectPath;
  if (!projectId || !projectPath) throw new Error('Open a project first to mirror the real index');

  const source = resolveSourceProject(options.sourceProject);
  if (!source) {
    throw new NoRealIndexError(options.sourceProject
      ? `No real project matches "${options.sourceProject}" (by id or name) in the real index.db`
      : 'No real parent project for this preview in the real index.db');
  }
  const documentLimit = options.documentLimit ?? DEFAULT_DOCUMENT_LIMIT;
  // A plain connection: the board half reads rows, never a vector.
  const sourceDb = new Database(source.dbPath, { readonly: true, fileMustExist: true });

  try {
    const dimensionsRow = sourceDb
      .prepare(`SELECT value FROM memory_meta WHERE key = 'vec_dims'`)
      .get() as { value: string } | undefined;
    const dimensions = dimensionsRow ? Number(dimensionsRow.value) : 0;
    // Either name: older releases' table, or the one the copy moves it to.
    const sourceHasVec = sourceDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('memory_chunks_vec', 'memory_vec_conversation')")
      .get() !== undefined;
    if (!sourceHasVec || !dimensions) {
      throw new NoRealIndexError('The real project has no embedded index to mirror (semantic search may never have run there)');
    }
    // The copies keep the source's own model tag. A made-up tag reads to the
    // embedding drain as another model's rows, so every preview re-embedded the
    // whole mirror in the background (89k chunks, hours at the duty cycle), and a
    // drain that never finishes hid the Index's caught-up push. Where the source
    // is itself mid-switch, its most common tag wins, as the real index would.
    const sourceTagRow = sourceDb
      .prepare(
        `SELECT embedded_model AS tag FROM memory_chunks
         WHERE embedded_model IS NOT NULL AND corpus = 'conversation'
         GROUP BY embedded_model ORDER BY COUNT(*) DESC LIMIT 1`,
      )
      .get() as { tag: string } | undefined;
    const mirroredTag = sourceTagRow?.tag ?? `mirrored@${dimensions}`;

    // Most RECENT conversations, so the mirror reflects what you have been
    // working on lately rather than an arbitrary slice.
    const documents = sourceDb
      .prepare(
        `SELECT c.doc_id AS docId,
                MAX(c.session_id) AS sessionId,
                MAX(c.task_id) AS taskId,
                COUNT(*) AS chunkCount,
                MAX(c.ts_end) AS lastTs
         FROM memory_chunks c
         WHERE c.corpus = 'conversation' AND c.embedded_model IS NOT NULL
         GROUP BY c.doc_id
         ORDER BY COALESCE(MAX(c.ts_end), 0) DESC
         LIMIT ?`,
      )
      .all(documentLimit) as SourceDocument[];

    if (documents.length === 0) throw new NoRealIndexError('The real project has no embedded conversations to mirror');

    // Carry the source task's OUTCOME, not just its title. Without it every
    // mirrored task lands in To Do and the graph's Outcome colouring is
    // uniformly "active", which makes that mode impossible to judge.
    //
    // `display_id` rides along for the same reason: it is the `#N` the board
    // prints on a card, and the memory surface labels a task with it. A preview
    // that allocated its own 1..N would show numbers that look like tickets and
    // point at nothing, which is worse than showing none.
    // The description and labels ride along too: they are the `task` corpus,
    // what a question finds a task by when its conversations say little, and
    // a placeholder description would leave that corpus nothing to search.
    const sourceTaskById = new Map<
      string,
      {
        title: string; description: string; labels: string[]; archived: boolean;
        laneRole: string | null; displayId: number | null;
      }
    >();
    for (const row of sourceDb
      .prepare(
        `SELECT t.id, t.title, t.description, t.labels, t.archived_at AS archivedAt, t.display_id AS displayId, w.role AS laneRole
         FROM tasks t LEFT JOIN swimlanes w ON w.id = t.swimlane_id`,
      )
      .all() as Array<{
        id: string; title: string; description: string | null; labels: string | null; archivedAt: string | null;
        displayId: number | null; laneRole: string | null;
      }>) {
      sourceTaskById.set(row.id, {
        title: row.title,
        description: row.description ?? '',
        labels: parseLabels(row.labels),
        archived: row.archivedAt !== null,
        laneRole: row.laneRole,
        displayId: row.displayId,
      });
    }
    // Model and effort ride along with the session type, for the same reason
    // the lane role had to: a fixture that cannot express the field being
    // verified is worth as much as no fixture. 1174 of 1636 real sessions carry
    // an applied model, so dropping them left the panel's Model / Effort rows
    // permanently hidden in preview and unjudgeable.
    const sessionFactsById = new Map<string, SourceSessionFacts>();
    // Also by task, so a board task whose conversations were never indexed still
    // arrives with what its sessions cost.
    const sessionFactsByTaskId = new Map<string, SourceSessionFacts[]>();
    for (const row of sourceDb
      .prepare(
        `SELECT id, task_id, session_type, applied_model, model_display_name, applied_effort,
                total_cost_usd, total_duration_ms, total_input_tokens, total_output_tokens,
                tool_call_count
         FROM sessions`,
      )
      .all() as Array<{
        id: string;
        task_id: string | null;
        session_type: string;
        applied_model: string | null;
        model_display_name: string | null;
        applied_effort: string | null;
        total_cost_usd: number | null;
        total_duration_ms: number | null;
        total_input_tokens: number | null;
        total_output_tokens: number | null;
        tool_call_count: number | null;
      }>) {
      const facts: SourceSessionFacts = {
        sessionType: row.session_type,
        // Same preference the graph query uses, so preview and production
        // resolve a session's model identically.
        model: row.applied_model ?? row.model_display_name,
        effort: row.applied_effort,
        costUsd: row.total_cost_usd,
        durationMs: row.total_duration_ms,
        inputTokens: row.total_input_tokens,
        outputTokens: row.total_output_tokens,
        toolCalls: row.tool_call_count,
      };
      sessionFactsById.set(row.id, facts);
      if (row.task_id) {
        const list = sessionFactsByTaskId.get(row.task_id) ?? [];
        list.push(facts);
        sessionFactsByTaskId.set(row.task_id, list);
      }
    }

    const targetDb = getProjectDb(projectId);
    // `documents` is newest first, so the backlog is the newest chunks.
    const pendingByDocument = pendingChunkCounts(
      documents.map((document) => document.chunkCount),
      options.embeddingBacklog ?? EMBEDDING_BACKLOG_CHUNKS,
    );

    const targetLanes = new SwimlaneRepository(targetDb).list();
    const todoSwimlane = targetLanes.find((lane) => lane.role === 'todo');
    const doneSwimlane = targetLanes.find((lane) => lane.role === 'done');
    if (!todoSwimlane) throw new Error('No To Do column to hang mirrored conversations off');

    const taskRepo = new TaskRepository(targetDb);
    const sessionRepo = new SessionRepository(targetDb);
    const now = new Date().toISOString();

    // One preview task per source task, so provenance edges and card titles are
    // the REAL ones. Conversations whose task is gone get a shared holder.
    const previewTaskIdBySourceTaskId = new Map<string, string>();
    const ensureTask = (sourceTaskId: string | null): string => {
      const key = sourceTaskId ?? '__orphaned__';
      const existing = previewTaskIdBySourceTaskId.get(key);
      if (existing) return existing;
      const source = sourceTaskId ? sourceTaskById.get(sourceTaskId) : undefined;
      const title = source?.title ?? (sourceTaskId ? 'Untitled task' : 'Conversations with no task');
      // Reproduce the outcome: Done tasks land in Done, archived tasks are
      // marked archived, everything else stays To Do.
      const lane = source?.laneRole === 'done' && doneSwimlane ? doneSwimlane : todoSwimlane;
      const created = taskRepo.create({
        title,
        description: source?.description || 'Mirrored from the real conversation index by the Test Harness.',
        labels: source?.labels ?? [],
        swimlane_id: lane.id,
      });
      if (source?.archived) taskRepo.archive(created.id);
      previewTaskIdBySourceTaskId.set(key, created.id);
      return created.id;
    };

    /** One exited preview session carrying a source session's facts. */
    const mirrorSession = (
      previewTaskId: string,
      sourceFacts: SourceSessionFacts | undefined,
      agentSessionId: string | null,
    ): string => {
      const previewSessionId = crypto.randomUUID();
      sessionRepo.insert({
        id: previewSessionId,
        task_id: previewTaskId,
        session_type: sourceFacts?.sessionType ?? 'claude_agent',
        isolated_swimlane_id: null,
        agent_session_id: agentSessionId,
        command: '',
        cwd: projectPath,
        permission_mode: null,
        prompt: null,
        status: 'exited',
        exit_code: 0,
        started_at: now,
        suspended_at: now,
        exited_at: now,
        suspended_by: null,
      });
      if (sourceFacts?.model || sourceFacts?.effort) {
        sessionRepo.updateAppliedSettings(previewSessionId, {
          model: sourceFacts.model,
          effort: sourceFacts.effort,
        });
      }
      if (sourceFacts?.costUsd != null || sourceFacts?.durationMs != null) {
        sessionRepo.updateMetrics(previewSessionId, {
          totalCostUsd: sourceFacts.costUsd ?? 0,
          totalInputTokens: sourceFacts.inputTokens ?? 0,
          totalOutputTokens: sourceFacts.outputTokens ?? 0,
          modelId: null,
          modelDisplayName: sourceFacts.model,
          totalDurationMs: sourceFacts.durationMs,
          toolCallCount: sourceFacts.toolCalls ?? 0,
          toolBreakdown: null,
          compactionCount: 0,
        });
      }
      return previewSessionId;
    };

    // A preview task and session for each conversation, committed before the
    // worker copies its chunks: a chunk whose session row does not exist yet is
    // what the record sweep's purge of deleted sessions removes.
    const mirrorPlan: MirrorDocument[] = documents.map((document, documentIndex) => {
      const previewTaskId = ensureTask(document.taskId);
      const sourceFacts = document.sessionId ? sessionFactsById.get(document.sessionId) : undefined;
      const previewSessionId = mirrorSession(previewTaskId, sourceFacts, document.docId);
      return { docId: document.docId, previewSessionId, previewTaskId, pending: pendingByDocument[documentIndex] };
    });

    // Every other board task too, with its sessions' facts and no conversation.
    // A preview holding only the tasks whose conversations were mirrored is a
    // board with half its history missing, which misstates exactly the questions
    // that count or rank work: on this project four of the tasks that added an
    // agent have no indexed conversation at all.
    for (const sourceTaskId of sourceTaskById.keys()) {
      if (previewTaskIdBySourceTaskId.has(sourceTaskId)) continue;
      const previewTaskId = ensureTask(sourceTaskId);
      for (const facts of sessionFactsByTaskId.get(sourceTaskId) ?? []) {
        mirrorSession(previewTaskId, facts, null);
      }
    }

    // Each task's git churn and linked pull request, so Ask can answer "how
    // many files changed" in a preview. Churn is recorded on ONE session per
    // task, which the mirror may not have copied, so it is rolled up per source
    // task (lines summed, files by their largest capture, as the task summary
    // does) and written onto one mirrored session of the preview task.
    const sourceChurn = sourceDb
      .prepare(
        `SELECT task_id AS taskId, SUM(lines_added) AS linesAdded,
                SUM(lines_removed) AS linesRemoved, MAX(files_changed) AS filesChanged
         FROM sessions WHERE task_id IS NOT NULL GROUP BY task_id`,
      )
      .all() as Array<{ taskId: string; linesAdded: number | null; linesRemoved: number | null; filesChanged: number | null }>;
    const sourcePullRequests = sourceDb
      .prepare('SELECT id, pr_number AS prNumber, pr_state AS prState FROM tasks WHERE pr_number IS NOT NULL')
      .all() as Array<{ id: string; prNumber: number; prState: string | null }>;
    const writeChurn = targetDb.prepare(
      `UPDATE sessions SET lines_added = ?, lines_removed = ?, files_changed = ?
       WHERE id = (SELECT id FROM sessions WHERE task_id = ? ORDER BY started_at LIMIT 1)`,
    );
    const writePullRequest = targetDb.prepare('UPDATE tasks SET pr_number = ?, pr_state = ? WHERE id = ?');
    const copyTaskFacts = writeTransaction(targetDb, () => {
      for (const churn of sourceChurn) {
        const previewTaskId = previewTaskIdBySourceTaskId.get(churn.taskId);
        if (!previewTaskId) continue;
        if (churn.linesAdded === null && churn.linesRemoved === null && churn.filesChanged === null) continue;
        writeChurn.run(churn.linesAdded, churn.linesRemoved, churn.filesChanged, previewTaskId);
      }
      for (const pullRequest of sourcePullRequests) {
        const previewTaskId = previewTaskIdBySourceTaskId.get(pullRequest.id);
        if (previewTaskId) writePullRequest.run(pullRequest.prNumber, pullRequest.prState, previewTaskId);
      }
    });
    copyTaskFacts();

    // Re-stamp the mirrored tasks with the SOURCE board's ticket numbers.
    //
    // Done after every task exists, and in two passes, because `display_id`
    // carries a unique index: preview allocation hands out 1..N in creation
    // order, so writing a source id straight over one would collide with
    // whichever mirrored task currently holds that number and has not been
    // rewritten yet. Parking the whole set negative is a bijection, so the
    // index holds throughout, and it leaves the real ids free to land in any
    // order. Tasks with no source ticket (the orphaned-conversations holder)
    // come back on the high side rather than staying negative.
    const restampTickets = writeTransaction(targetDb, () => {
      targetDb.exec('UPDATE tasks SET display_id = -display_id WHERE display_id > 0');
      const setTicket = targetDb.prepare('UPDATE tasks SET display_id = ? WHERE id = ?');
      let highest = 0;
      for (const [sourceTaskId, previewTaskId] of previewTaskIdBySourceTaskId) {
        const displayId = sourceTaskById.get(sourceTaskId)?.displayId ?? null;
        if (displayId === null) continue;
        setTicket.run(displayId, previewTaskId);
        if (displayId > highest) highest = displayId;
      }
      for (const row of targetDb
        .prepare('SELECT id FROM tasks WHERE display_id < 0 ORDER BY display_id DESC')
        .all() as Array<{ id: string }>) {
        highest += 1;
        setTicket.run(highest, row.id);
      }
      // The allocator self-heals off MAX(display_id), but the high-water mark
      // is what it reads first, so leave it above everything just stamped.
      targetDb
        .prepare(`INSERT INTO project_meta (key, value) VALUES ('display_id_high_water', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(String(highest));
    });
    restampTickets();

    const copied = await retrievalClient.call('dev.mirrorIndex', {
      projectId,
      sourceDbPath: source.dbPath,
      sourceName: source.name,
      dimensions,
      modelTag: mirroredTag,
      documents: mirrorPlan,
    }, { timeoutMs: null });

    return {
      sourceProject: source.name,
      documents: documents.length,
      chunks: copied.chunks,
      tasks: previewTaskIdBySourceTaskId.size,
      dimensions,
      modelTag: mirroredTag,
      pendingChunks: copied.pendingChunks,
    };
  } finally {
    sourceDb.close();
  }
}

let devIpcRegistered = false;

export function registerSeedKnowledgeGraphRealDevIpc(getContext: () => IpcContext | null): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(
    IPC.DEV_SEED_KNOWLEDGE_GRAPH_REAL,
    async (
      _event,
      options: SeedKnowledgeGraphRealOptions,
    ): Promise<DevSeedKnowledgeGraphRealResult | DevSeedKnowledgeGraphRealUnavailable> => {
      const context = getContext();
      if (!context) throw new Error('IPC not initialized');
      let seeded: DevSeedKnowledgeGraphRealResult;
      try {
        seeded = await seedKnowledgeGraphFromRealIndex(context, options ?? {});
      } catch (error) {
        if (error instanceof NoRealIndexError) return { unavailable: error.message };
        throw error;
      }
      const projectId = context.currentProjectId;
      if (projectId) {
        // Build the map before returning, so the click lands on the surface
        // rather than on a "Building the map" spinner. See `buildGraphNow` in
        // `dev-index-methods.ts` for why this is safe to run unthrottled here
        // and nowhere else. The pending chunks join it as the drain embeds
        // them (marked dirty below).
        await retrievalClient.call('dev.buildGraphNow', { projectId }, { timeoutMs: null });
        // The mirrored tasks' own records, the `task` corpus, indexed now so a
        // first question searches them; the embedding drain picks them up in
        // the background, as it would on a real install.
        await retrievalClient.call('index.sweep', { projectId, tasks: true, remoteTargets: [] }, { timeoutMs: null });
        embedEngine.markDirty(projectId);
        // The project-open sweep read the branch's commits against an index
        // with no conversations yet, so none found its task. Read them again
        // now that the mirrored conversations are here (a real install indexes
        // conversations first, on the same chain).
        await retrievalClient.call('dev.purgeCorpora', { projectId, corpora: ['commit'] }, { timeoutMs: null });
        retrievalService.refreshRecords(context, projectId);
      }
      return seeded;
    },
  );
}
