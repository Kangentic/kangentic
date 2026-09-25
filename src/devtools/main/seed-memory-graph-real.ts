/**
 * Dev-only: mirror a slice of the REAL conversation index into an ephemeral
 * preview project, so the Memory Graph can be judged against actual work.
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
 * this is a copy, not a re-embed.
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
import { loadVecExtension } from '../../main/retrieval/vec-extension';
import { RetrievalStore } from '../../main/retrieval/retrieval-store';
import { TaskRepository } from '../../main/db/repositories/task-repository';
import { SessionRepository } from '../../main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../main/db/repositories/swimlane-repository';
import { toForwardSlash } from '../../shared/paths';
import type { DevSeedMemoryGraphRealResult } from '../../shared/types';
import type { IpcContext } from '../../main/ipc/ipc-context';
import { buildMemoryGraphNow } from './build-memory-graph-now';

const WORKTREE_MARKER = '/.kangentic/worktrees/';
/**
 * Documents copied by default.
 *
 * The binding cost is NOT the copy, which is a few seconds - it is the
 * projection built from it, which scans every vector and is roughly linear in
 * CHUNKS. Measured on this corpus: 400 conversations is 37k chunks and ~58s of
 * projection work even unthrottled, so a click sat on a spinner for minutes. 150
 * is about 14k chunks and lands the whole seed-and-build click near 20s, while
 * still being enough conversations for the regions to come out recognisably
 * named (the thing 400 was originally chosen to make judgeable).
 *
 * Raise it via `documentLimit` when specifically testing a large corpus.
 */
const DEFAULT_DOCUMENT_LIMIT = 150;

function samePath(first: string, second: string): boolean {
  try {
    return path.relative(path.resolve(first), path.resolve(second)) === '';
  } catch {
    return false;
  }
}

/** The real (non-ephemeral) project this preview was cloned from, if resolvable.
 *  `getPlatformConfigDir()` deliberately ignores KANGENTIC_DATA_DIR, so it still
 *  points at the real config dir from inside a preview. */
function resolveSourceProject(): { id: string; name: string; dbPath: string } | null {
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
    const match = rows.find((row) => samePath(row.path, parentRoot));
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

export interface SeedMemoryGraphRealOptions {
  documentLimit?: number;
}

/**
 * Copy the most recent `documentLimit` indexed conversations - chunks, vectors,
 * index state, and the tasks/sessions they hang off - from the real parent
 * project into the currently open (preview) project.
 */
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

export function seedMemoryGraphFromRealIndex(
  context: IpcContext,
  options: SeedMemoryGraphRealOptions = {},
): DevSeedMemoryGraphRealResult {
  const projectId = context.currentProjectId;
  const projectPath = context.currentProjectPath;
  if (!projectId || !projectPath) throw new Error('Open a project first to mirror the real index');

  const source = resolveSourceProject();
  if (!source) {
    throw new Error('Could not resolve the real parent project for this preview (no matching project in the real index.db)');
  }

  const documentLimit = options.documentLimit ?? DEFAULT_DOCUMENT_LIMIT;
  const sourceDb = new Database(source.dbPath, { readonly: true, fileMustExist: true });
  const sourceHasVec = loadVecExtension(sourceDb);

  try {
    const dimensionsRow = sourceDb
      .prepare(`SELECT value FROM memory_meta WHERE key = 'vec_dims'`)
      .get() as { value: string } | undefined;
    const dimensions = dimensionsRow ? Number(dimensionsRow.value) : 0;
    if (!sourceHasVec || !dimensions) {
      throw new Error('The real project has no embedded index to mirror (semantic search may never have run there)');
    }

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

    if (documents.length === 0) throw new Error('The real project has no embedded conversations to mirror');

    // Carry the source task's OUTCOME, not just its title. Without it every
    // mirrored task lands in To Do and the graph's Outcome colouring is
    // uniformly "active", which makes that mode impossible to judge.
    //
    // `display_id` rides along for the same reason: it is the `#N` the board
    // prints on a card, and the memory surface labels a task with it. A preview
    // that allocated its own 1..N would show numbers that look like tickets and
    // point at nothing, which is worse than showing none.
    const sourceTaskById = new Map<
      string,
      { title: string; archived: boolean; laneRole: string | null; displayId: number | null }
    >();
    for (const row of sourceDb
      .prepare(
        `SELECT t.id, t.title, t.archived_at AS archivedAt, t.display_id AS displayId, w.role AS laneRole
         FROM tasks t LEFT JOIN swimlanes w ON w.id = t.swimlane_id`,
      )
      .all() as Array<{
        id: string; title: string; archivedAt: string | null;
        displayId: number | null; laneRole: string | null;
      }>) {
      sourceTaskById.set(row.id, {
        title: row.title,
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
    for (const row of sourceDb
      .prepare(
        `SELECT id, session_type, applied_model, model_display_name, applied_effort,
                total_cost_usd, total_duration_ms, total_input_tokens, total_output_tokens,
                tool_call_count
         FROM sessions`,
      )
      .all() as Array<{
        id: string;
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
      sessionFactsById.set(row.id, {
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
      });
    }

    const targetDb = getProjectDb(projectId);
    const store = new RetrievalStore(targetDb);
    store.ensureVecTable(dimensions);
    if (!store.hasVec) throw new Error('sqlite-vec is unavailable in this preview, so vectors cannot be mirrored');
    store.setMeta('vec_dims', String(dimensions));

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
        description: 'Mirrored from the real conversation index by the Test Harness.',
        swimlane_id: lane.id,
      });
      if (source?.archived) taskRepo.archive(created.id);
      previewTaskIdBySourceTaskId.set(key, created.id);
      return created.id;
    };

    const readChunks = sourceDb.prepare(
      `SELECT id, seq, role, text, content_hash AS contentHash, token_estimate AS tokenEstimate,
              ts_start AS tsStart, ts_end AS tsEnd, turn_uuid_start AS turnUuidStart, turn_uuid_end AS turnUuidEnd
       FROM memory_chunks
       WHERE corpus = 'conversation' AND doc_id = ? AND embedded_model IS NOT NULL
       ORDER BY seq ASC`,
    );
    const readVector = sourceDb.prepare('SELECT embedding FROM memory_chunks_vec WHERE rowid = ?');

    let copiedChunks = 0;
    for (const document of documents) {
      const previewTaskId = ensureTask(document.taskId);
      const previewSessionId = crypto.randomUUID();
      const sourceFacts = document.sessionId ? sessionFactsById.get(document.sessionId) : undefined;
      sessionRepo.insert({
        id: previewSessionId,
        task_id: previewTaskId,
        session_type: sourceFacts?.sessionType ?? 'claude_agent',
        isolated_swimlane_id: null,
        agent_session_id: document.docId,
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

      const sourceChunks = readChunks.all(document.docId) as Array<{
        id: number;
        seq: number;
        role: string;
        text: string;
        contentHash: string;
        tokenEstimate: number;
        tsStart: number | null;
        tsEnd: number | null;
        turnUuidStart: string | null;
        turnUuidEnd: string | null;
      }>;
      if (sourceChunks.length === 0) continue;

      store.upsertDocument(
        {
          corpus: 'conversation',
          docId: document.docId,
          sessionId: previewSessionId,
          taskId: previewTaskId,
          agentSessionId: document.docId,
          metaJson: JSON.stringify({ devSeed: 'memory-graph-real', sourceProject: source.name }),
        },
        sourceChunks.map((chunk) => ({
          seq: chunk.seq,
          text: chunk.text,
          contentHash: chunk.contentHash,
          tokenEstimate: chunk.tokenEstimate,
          role: chunk.role,
          tsStart: chunk.tsStart,
          tsEnd: chunk.tsEnd,
          turnUuidStart: chunk.turnUuidStart,
          turnUuidEnd: chunk.turnUuidEnd,
        })),
      );

      // Vectors are matched by CONTENT HASH, not by position: `upsertDocument`
      // assigns fresh rowids in the target DB, and a chunk skipped for any
      // reason would silently shift every later vector onto the wrong chunk.
      const sourceVectorByHash = new Map<string, Buffer>();
      for (const chunk of sourceChunks) {
        const row = readVector.get(chunk.id) as { embedding: Buffer } | undefined;
        if (row) sourceVectorByHash.set(chunk.contentHash, row.embedding);
      }

      const storedChunks = store.getChunksForDoc('conversation', document.docId);
      const writes: Array<{ chunkId: number; vector: Float32Array; contentHash: string }> = [];
      for (const stored of storedChunks) {
        const embedding = sourceVectorByHash.get(stored.contentHash);
        if (!embedding) continue;
        const vector = new Float32Array(embedding.byteLength / 4);
        vector.set(new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4));
        writes.push({ chunkId: stored.id, vector, contentHash: stored.contentHash });
      }
      store.writeEmbeddings(writes, `mirrored@${dimensions}`);
      copiedChunks += writes.length;

      store.setIndexState({
        corpus: 'conversation',
        docId: document.docId,
        sessionId: previewSessionId,
        sourcePath: null,
        sourceMtimeMs: null,
        sourceSize: null,
        entryCount: sourceChunks.length,
        chunkCount: writes.length,
        // The mirrored transcript file does not exist in the preview, which is
        // exactly the real corpus's dominant state and worth exercising.
        status: 'missing-source',
        indexedAt: now,
      });
    }

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
    const restampTickets = targetDb.transaction(() => {
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

    return {
      sourceProject: source.name,
      documents: documents.length,
      chunks: copiedChunks,
      tasks: previewTaskIdBySourceTaskId.size,
      dimensions,
    };
  } finally {
    sourceDb.close();
  }
}

let devIpcRegistered = false;

export function registerSeedMemoryGraphRealDevIpc(getContext: () => IpcContext | null): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(
    IPC.DEV_SEED_MEMORY_GRAPH_REAL,
    async (_event, options: SeedMemoryGraphRealOptions): Promise<DevSeedMemoryGraphRealResult> => {
      const context = getContext();
      if (!context) throw new Error('IPC not initialized');
      const seeded = seedMemoryGraphFromRealIndex(context, options ?? {});
      // Build the map before returning, so the click lands on the surface rather
      // than on a "Building the map" spinner. See `build-memory-graph-now.ts` for
      // why this is safe to run unthrottled here and nowhere else.
      if (context.currentProjectId) await buildMemoryGraphNow(context.currentProjectId);
      return seeded;
    },
  );
}
