/**
 * The retrieval worker's indexing methods: a conversation re-read at a turn or
 * a session's end, the record sweeps a board change or a project open asks
 * for, and Rebuild. Each wraps the indexer that used to run on main.
 *
 * Main still decides when each runs, on its own serial job chain, so two
 * sweeps of one project never interleave; this module only does the work.
 * What the worker cannot know it is sent: the project's root and default
 * branch, whether a whole-branch read may start yet, the source code plan,
 * and the remote servers main's adapters learned at spawn. A long job carries
 * a `jobId`, and `job.cancel` stops it between steps (a project switch).
 */

import type Database from 'better-sqlite3';
import { writeTransaction } from '../../db/transaction';
import { ConversationIndexer, type IndexOutcome } from '../conversation/conversation-indexer';
import { sweepTaskRecords, type TaskSweepResult } from '../task/task-indexer';
import { sweepChangeRecords, type ChangeSweepResult } from '../change/change-indexer';
import { sweepCommitRecords, type CommitSweepResult } from '../commit/commit-indexer';
import { purgeCodeRecords, sweepCodeRecords, type CodeSweepResult } from '../code/code-indexer';
import { RetrievalStore } from '../retrieval-store';
import { SummaryStore } from '../summary/summary-store';
import { hasVecSupport } from '../vec-support';
import { vecLayout } from '../vec-layout';
import { buildMissingIndexesWhenQuiet } from '../index-builds';
import { awaitWriteTurn } from '../write-budget';
import { agentRegistry } from '../../agent/agent-registry';
import { adoptRemoteTargets, type RemoteTargets } from '../remote-targets';
import type { CodeSweepPlan } from '../../../shared/answer-agent';
import type { SummaryChoice } from '../../../shared/types';
import type { WorkerContext } from './methods';

/** Which sweeps one `index.sweep` runs, in this order. */
export interface IndexSweepSteps {
  /** Delete vectors whose chunk is gone or not embedded (left while sqlite-vec
   *  was missing). */
  reconcileVec?: boolean;
  /** Remove deleted sessions' documents: by index state, or by chunks too. */
  purge?: 'state' | 'chunks';
  /** Re-read conversations whose transcript changed (the project-open backfill). */
  conversations?: boolean;
  tasks?: boolean;
  changes?: { projectPath: string | null };
  commits?: { projectPath: string; baseBranch: string; allowFullRead: boolean };
  code?: { plan: CodeSweepPlan; projectPath: string | null; baseBranch: string; allowFullRead: boolean };
}

export interface IndexSweepResult {
  purged: number;
  tasks: TaskSweepResult | null;
  changes: ChangeSweepResult | null;
  commits: CommitSweepResult | null;
  code: CodeSweepResult | null;
}

export interface IndexMethods {
  /** Re-read one session's conversation: at a turn's end, or with its subagent
   *  walk and the files it changed when the session has finished. */
  'index.session': {
    params: {
      projectId: string;
      sessionId: string;
      subagents: boolean;
      changes: { projectPath: string | null } | null;
      remoteTargets: RemoteTargets;
    };
    result: { outcome: IndexOutcome; changesIndexed: number };
  };
  /** Run some of a project's sweeps in order (`IndexSweepSteps`). */
  'index.sweep': {
    params: IndexSweepSteps & { projectId: string; jobId?: string; remoteTargets: RemoteTargets };
    result: IndexSweepResult;
  };
  /** Rebuild: each project forgets what its sources were read from, and its
   *  summaries written some other way are marked for rewriting. */
  'index.rebuild': {
    params: { projectIds: string[]; choice: SummaryChoice | null };
    /** `reset`: the projects whose database opened and was reset. */
    result: { summariesToRewrite: number; reset: string[] };
  };
  /** What Rebuild would mark for rewriting. */
  'index.rebuildPlan': {
    params: { projectIds: string[]; choice: SummaryChoice };
    result: { summariesToRewrite: number };
  };
  /** Stop a running job between its steps. A finished job is not touched. */
  'job.cancel': {
    params: { jobId: string };
    result: void;
  };
  /**
   * Convert a project's legacy raw transcripts (one growing value per session
   * in `session_transcripts`) into pieces in `session_transcript_chunks`, one
   * session at a time. A transcript whose session belongs to another project
   * (misfiled while one writer followed the focused project) moves to that
   * project's database; one whose session is in none stays here.
   */
  'transcripts.convertLegacy': {
    params: { projectId: string; otherProjectIds: string[]; jobId?: string };
    result: { converted: number; moved: number; bytes: number };
  };
  /**
   * Delete the raw transcript pieces of sessions that are gone: no `sessions`
   * row in this project (nor in any other, for pieces a conversion wrote), and
   * nothing written for `TRANSCRIPT_PURGE_GRACE_MS`. A transcript used to go
   * with its session row by trigger, inside main's delete; this frees it a few
   * pieces at a time. Legacy rows are left to `transcripts.convertLegacy`,
   * which runs first.
   */
  'transcripts.purgeDeleted': {
    params: { projectId: string; otherProjectIds: string[]; jobId?: string };
    result: { sessions: number; pieces: number; bytes: number };
  };
  /**
   * Copy the conversation vectors older releases stored at vec0 chunk size
   * 1,024 into a table at 128, switch reads to it, then free the old table
   * (`vec-layout.ts`). Resumes where it stopped; a no-op once done.
   */
  'vec.migrateLayout': {
    params: { projectId: string; jobId?: string };
    result: { copied: number; switched: boolean; freedBlocks: number };
  };
  /**
   * Build the index's own indexes a database lacks (`index-builds.ts`), one at
   * a time, each once no other connection has committed for a while, so its
   * write lock never lands on main's writes. The last step of storage upkeep.
   */
  'index.buildWhenQuiet': {
    params: { projectId: string; jobId?: string };
    result: { built: Array<{ name: string; ms: number; after: 'quiet' | 'cap' }> };
  };
}

/** Text per piece a conversion writes: one piece a transaction, each a few
 *  ms (a 256 KB piece measured up to 15 ms). */
const LEGACY_PIECE_CHARS = 64 * 1024;

/**
 * Where a legacy transcript's pieces start and end: every `LEGACY_PIECE_CHARS`
 * UTF-16 code units, one unit earlier where that would split a surrogate pair.
 * A split pair is two lone surrogates, which the UTF-8 encoder stores as
 * U+FFFD, losing the character: on the real install one of 14,638 boundaries
 * fell inside an emoji. Depends only on the text, so a conversion that resumes
 * cuts exactly where the first attempt did.
 */
function legacyPieceBounds(text: string): Array<[start: number, end: number]> {
  const bounds: Array<[number, number]> = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + LEGACY_PIECE_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    bounds.push([start, end]);
    start = end;
  }
  return bounds;
}

/**
 * How long a session with no `sessions` row keeps its transcript after its
 * last piece. A spawn can flush a piece before its row is inserted, and the
 * host's final flush can land after a teardown deleted the row; neither is a
 * deleted session yet. A teardown deletes the row only once its session has
 * stopped, so nothing is still writing past this.
 */
export const TRANSCRIPT_PURGE_GRACE_MS = 10 * 60_000;

/** A purge's delete transaction: pieces up to this many bytes, at least one. */
const PURGE_BYTES_PER_TRANSACTION = 64 * 1024;
const PURGE_PIECES_PER_TRANSACTION = 64;

/** Vectors a copy step reads and writes in one transaction. vec0 reads cost
 *  about 3.8 ms a vector on the real install (95,791 in 6 minutes), so 16 keep
 *  a step near 60 ms, the longest an Ask or search waits behind it. */
const VEC_COPY_BATCH = 16;

/** Jobs a cancel can still reach, and those told to stop. */
const runningJobs = new Set<string>();
const cancelledJobs = new Set<string>();

/** The conversation indexer, one per worker context. */
const indexers = new WeakMap<WorkerContext, ConversationIndexer>();

function indexerFor(context: WorkerContext): ConversationIndexer {
  let indexer = indexers.get(context);
  if (!indexer) {
    indexer = new ConversationIndexer({ getDb: context.getDb });
    indexers.set(context, indexer);
  }
  return indexer;
}

async function runJob<Result>(jobId: string | undefined, job: (shouldContinue: () => boolean) => Promise<Result>): Promise<Result> {
  if (!jobId) return job(() => true);
  runningJobs.add(jobId);
  try {
    return await job(() => !cancelledJobs.has(jobId));
  } finally {
    runningJobs.delete(jobId);
    cancelledJobs.delete(jobId);
  }
}

type IndexHandlers = {
  [Method in keyof IndexMethods]: (
    params: IndexMethods[Method]['params'],
    context: WorkerContext,
  ) => IndexMethods[Method]['result'] | Promise<IndexMethods[Method]['result']>;
};

export const indexHandlers: IndexHandlers = {
  'index.session': async ({ projectId, sessionId, subagents, changes, remoteTargets }, context) => {
    adoptRemoteTargets(agentRegistry, remoteTargets);
    const indexer = indexerFor(context);
    const outcome = await indexer.indexSession(projectId, sessionId);
    if (subagents) await indexer.indexSubagentUsage(projectId, sessionId);
    const changed = changes ? await sweepChangeRecords(projectId, changes.projectPath) : null;
    return { outcome, changesIndexed: changed?.indexed ?? 0 };
  },

  'index.sweep': ({ projectId, jobId, remoteTargets, ...steps }, context) => runJob(jobId, async (shouldContinue) => {
    const result: IndexSweepResult = { purged: 0, tasks: null, changes: null, commits: null, code: null };
    if (steps.conversations) adoptRemoteTargets(agentRegistry, remoteTargets);
    const indexer = indexerFor(context);
    if (steps.reconcileVec) {
      try {
        const db = context.getDb(projectId);
        if (hasVecSupport(db)) new RetrievalStore(db).reconcileVecOrphans();
      } catch {
        // No vec table here: nothing can be orphaned in it.
      }
    }
    if (steps.purge && shouldContinue()) {
      result.purged = await indexer.purgeDeletedSessions(projectId, shouldContinue, { fromChunks: steps.purge === 'chunks' });
    }
    if (steps.conversations && shouldContinue()) await indexer.sweepProject(projectId, shouldContinue);
    if (steps.tasks && shouldContinue()) result.tasks = await sweepTaskRecords(projectId, shouldContinue);
    if (steps.changes && shouldContinue()) result.changes = await sweepChangeRecords(projectId, steps.changes.projectPath, shouldContinue);
    if (steps.commits && shouldContinue()) {
      const { projectPath, baseBranch, allowFullRead } = steps.commits;
      result.commits = await sweepCommitRecords(projectId, projectPath, baseBranch, { shouldContinue, allowFullRead });
    }
    if (steps.code && shouldContinue()) {
      const { plan, projectPath, baseBranch, allowFullRead } = steps.code;
      const none: CodeSweepResult = { indexed: 0, removed: 0, deferred: false };
      if (plan === 'clear') result.code = purgeCodeRecords(projectId, context.getDb) ? { ...none, removed: 1 } : none;
      else if (plan === 'keep' || !projectPath) result.code = none;
      else result.code = await sweepCodeRecords(projectId, projectPath, baseBranch, { shouldContinue, allowFullRead });
    }
    return result;
  }),

  'index.rebuild': ({ projectIds, choice }, context) => {
    let summariesToRewrite = 0;
    const reset: string[] = [];
    for (const projectId of projectIds) {
      try {
        const db = context.getDb(projectId);
        new RetrievalStore(db).resetIndexState();
        if (choice) summariesToRewrite += new SummaryStore(db).markForRewrite(choice);
        reset.push(projectId);
      } catch (error) {
        console.warn(`[retrieval] rebuild could not reset project=${projectId}:`, error);
      }
    }
    return { summariesToRewrite, reset };
  },

  'index.rebuildPlan': ({ projectIds, choice }, context) => {
    let summariesToRewrite = 0;
    for (const projectId of projectIds) {
      try {
        summariesToRewrite += new SummaryStore(context.getDb(projectId)).countNotWrittenWith(choice);
      } catch (error) {
        console.warn(`[retrieval] rebuild plan could not read project=${projectId}:`, error);
      }
    }
    return { summariesToRewrite };
  },

  'job.cancel': ({ jobId }) => {
    if (runningJobs.has(jobId)) cancelledJobs.add(jobId);
  },

  'transcripts.convertLegacy': ({ projectId, otherProjectIds, jobId }, context) => runJob(jobId, async (shouldContinue) => {
    const result = { converted: 0, moved: 0, bytes: 0 };
    let source: Database.Database;
    try {
      source = context.getDb(projectId);
    } catch {
      return result;
    }
    const nextLegacy = source.prepare('SELECT session_id AS sessionId FROM session_transcripts ORDER BY session_id LIMIT 1');
    const hasSession = (db: Database.Database, sessionId: string): boolean =>
      db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !== undefined;
    // The worker opens with migrations off, so another project main has not
    // opened since the upgrade has no pieces table yet. Writing there threw
    // and stopped the whole upkeep at that row, on every open.
    const canHoldPieces = (db: Database.Database): boolean =>
      (db.prepare(`SELECT COUNT(*) AS found FROM sqlite_master WHERE type = 'table' AND name IN ('session_transcript_chunks', 'memory_meta')`)
        .get() as { found: number }).found === 2;
    while (shouldContinue()) {
      const next = nextLegacy.get() as { sessionId: string } | undefined;
      if (!next) break;
      const { sessionId } = next;
      // The project the session is in: this one, else the other project
      // that has it, else this one (a transcript is never dropped).
      let target = source;
      if (!hasSession(source, sessionId)) {
        for (const otherId of otherProjectIds) {
          try {
            const other = context.getDb(otherId);
            if (hasSession(other, sessionId) && canHoldPieces(other)) {
              target = other;
              break;
            }
          } catch {
            // That project's database is gone; look in the next.
          }
        }
      }
      // A read takes no lock. The value can be 19 MB (28 ms to read).
      const legacy = source.prepare('SELECT transcript, created_at AS createdAt, updated_at AS updatedAt FROM session_transcripts WHERE session_id = ?')
        .get(sessionId) as { transcript: string; createdAt: string; updatedAt: string } | undefined;
      if (!legacy) continue;
      const text = legacy.transcript;
      const bounds = legacyPieceBounds(text);
      const count = bounds.length;
      // Where this row's pieces go, recorded before the first is written so
      // a conversion cut short resumes where it stopped instead of writing
      // them twice. They take seqs below every piece the session already has
      // there: after the switch pieces start at 0, and a session misfiled
      // across two projects may already have another row's pieces below 0.
      // (That split cannot be put back in time order; it is kept whole.)
      const progressKey = `transcript_legacy:${projectId}:${sessionId}`;
      const readProgress = target.prepare('SELECT value FROM memory_meta WHERE key = ?');
      const writeProgress = target.prepare(
        'INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      const saved = readProgress.get(progressKey) as { value: string } | undefined;
      let base: number;
      let written: number;
      if (saved) {
        ({ base, written } = JSON.parse(saved.value) as { base: number; written: number });
      } else {
        const lowest = (target.prepare('SELECT MIN(seq) AS lowest FROM session_transcript_chunks WHERE session_id = ?')
          .get(sessionId) as { lowest: number | null }).lowest;
        base = Math.min(lowest ?? 0, 0) - count;
        written = 0;
        writeTransaction(target, () => {
          writeProgress.run(progressKey, JSON.stringify({ base, written }));
        })();
      }
      const insert = target.prepare(
        'INSERT INTO session_transcript_chunks (session_id, seq, chars, bytes, created_at, text) VALUES (?, ?, ?, ?, ?, ?)',
      );
      while (written < count && shouldContinue()) {
        const piece = text.slice(bounds[written][0], bounds[written][1]);
        const seq = base + written;
        // The last piece carries the row's last write, so the transcript's
        // first and last times (MIN and MAX over pieces) survive the move.
        const createdAt = written === count - 1 ? legacy.updatedAt : legacy.createdAt;
        const pieceBytes = Buffer.byteLength(piece);
        writeTransaction(target, () => {
          insert.run(sessionId, seq, piece.length, pieceBytes, createdAt, piece);
          writeProgress.run(progressKey, JSON.stringify({ base, written: written + 1 }));
        })();
        written += 1;
        await awaitWriteTurn(target);
      }
      if (written < count) break;
      // Freeing a 19 MB value's pages took 18 ms (measured); one at a time.
      writeTransaction(source, () => {
        source.prepare('DELETE FROM session_transcripts WHERE session_id = ?').run(sessionId);
      })();
      writeTransaction(target, () => {
        target.prepare('DELETE FROM memory_meta WHERE key = ?').run(progressKey);
      })();
      result.converted += 1;
      if (target !== source) result.moved += 1;
      result.bytes += Buffer.byteLength(text);
      await awaitWriteTurn(source);
    }
    return result;
  }),

  'transcripts.purgeDeleted': ({ projectId, otherProjectIds, jobId }, context) => runJob(jobId, async (shouldContinue) => {
    const result = { sessions: 0, pieces: 0, bytes: 0 };
    let db: Database.Database;
    try {
      db = context.getDb(projectId);
    } catch {
      return result;
    }
    // The distinct sessions first, off the primary key's index, then one
    // probe of `sessions` each.
    const unowned = (db.prepare(`
      SELECT session_id AS sessionId FROM (SELECT DISTINCT session_id FROM session_transcript_chunks) AS transcript
       WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = transcript.session_id)
    `).all() as Array<{ sessionId: string }>).map((row) => row.sessionId);
    if (unowned.length === 0) return result;
    const cutoff = new Date(Date.now() - TRANSCRIPT_PURGE_GRACE_MS).toISOString();
    const extent = db.prepare('SELECT MIN(seq) AS lowest, MAX(created_at) AS lastAt FROM session_transcript_chunks WHERE session_id = ?');
    const page = db.prepare(`SELECT seq, bytes FROM session_transcript_chunks WHERE session_id = ? ORDER BY seq LIMIT ${PURGE_PIECES_PER_TRANSACTION}`);
    const remove = db.prepare('DELETE FROM session_transcript_chunks WHERE session_id = ? AND seq BETWEEN ? AND ?');
    // Live pieces (seq 0 up) only ever go to their session's own project, so
    // with no row here that session is gone. A conversion's pieces (below 0)
    // can sit in another project's database than the session's row: the
    // conversion leaves one in place when that project could not take it. So
    // only those are looked up elsewhere, and while another project cannot be
    // read, they stay.
    let others: Database.Database[] | null = null;
    let othersUnreadable = false;
    for (const sessionId of unowned) {
      if (!shouldContinue()) return result;
      const { lowest, lastAt } = extent.get(sessionId) as { lowest: number | null; lastAt: string | null };
      if (lowest === null || lastAt === null || lastAt >= cutoff) continue;
      if (lowest < 0) {
        if (othersUnreadable) continue;
        let ownedElsewhere: boolean;
        try {
          others ??= otherProjectIds.map((otherId) => context.getDb(otherId));
          ownedElsewhere = others.some((other) => other.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !== undefined);
        } catch {
          othersUnreadable = true;
          continue;
        }
        if (ownedElsewhere) continue;
      }
      for (;;) {
        if (!shouldContinue()) return result;
        const pieces = page.all(sessionId) as Array<{ seq: number; bytes: number }>;
        if (pieces.length === 0) break;
        let taken = 1;
        let bytes = pieces[0].bytes;
        while (taken < pieces.length && bytes + pieces[taken].bytes <= PURGE_BYTES_PER_TRANSACTION) {
          bytes += pieces[taken].bytes;
          taken += 1;
        }
        // A piece appended after the read takes a seq above this range, so the
        // delete takes exactly the pieces read.
        writeTransaction(db, () => {
          remove.run(sessionId, pieces[0].seq, pieces[taken - 1].seq);
        })();
        result.pieces += taken;
        result.bytes += bytes;
        await awaitWriteTurn(db);
      }
      result.sessions += 1;
    }
    return result;
  }),

  'vec.migrateLayout': ({ projectId, jobId }, context) => runJob(jobId, async (shouldContinue) => {
    const result = { copied: 0, switched: false, freedBlocks: 0 };
    let db: Database.Database;
    try {
      db = context.getDb(projectId);
    } catch {
      return result;
    }
    if (!hasVecSupport(db)) return result;
    const store = new RetrievalStore(db);
    const started = performance.now();
    store.beginConversationVecCopy();
    for (;;) {
      if (!shouldContinue()) return result;
      const covered = store.copyConversationVecBatch(VEC_COPY_BATCH);
      if (covered === 0) break;
      result.copied += covered;
      await awaitWriteTurn(db);
    }
    if (shouldContinue() && vecLayoutCopying(db)) {
      store.finishConversationVecCopy();
      result.switched = true;
    }
    while (shouldContinue() && store.freeLegacyConversationVecStep()) {
      result.freedBlocks += 1;
      await awaitWriteTurn(db);
    }
    if (result.copied > 0 || result.freedBlocks > 0) {
      console.log(`[retrieval] conversation vectors moved to chunk size 128: ${result.copied} copied, ${result.freedBlocks} old blocks freed, ${Math.round(performance.now() - started)} ms`);
    }
    return result;
  }),

  'index.buildWhenQuiet': ({ projectId, jobId }, context) => runJob(jobId, async (shouldContinue) => {
    let db: Database.Database;
    try {
      db = context.getDb(projectId);
    } catch {
      return { built: [] };
    }
    const built = await buildMissingIndexesWhenQuiet(db, {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => performance.now(),
      shouldContinue,
    });
    for (const index of built) {
      const when = index.after === 'quiet' ? 'once no other writer had committed for 2 s' : 'after the 10 minute wait for quiet ran out';
      console.log(`[retrieval] built ${index.name} for project ${projectId} in ${index.ms} ms, ${when}`);
    }
    return { built };
  }),
};

/** True while this connection's conversation vectors are being copied. */
function vecLayoutCopying(db: Database.Database): boolean {
  return vecLayout(db).copyTarget !== null;
}
