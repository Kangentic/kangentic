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
import { ensureRetrievalIndexes } from '../index-builds';
import { agentRegistry } from '../../agent/agent-registry';
import { adoptRemoteTargets, type RemoteTargets } from '../remote-targets';
import type { CodeSweepPlan } from '../../../shared/answer-agent';
import type { SummaryChoice } from '../../../shared/types';
import type { WorkerContext } from './methods';

/** Which sweeps one `index.sweep` runs, in this order. */
export interface IndexSweepSteps {
  /** Build any of the index's own indexes the database lacks (`index-builds.ts`). */
  ensureIndexes?: boolean;
  /** Delete vectors whose chunk is gone (left while sqlite-vec was missing). */
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
}

/** Text per piece a conversion writes: one piece a transaction, each a few
 *  ms (a 256 KB piece measured up to 15 ms). */
const LEGACY_PIECE_CHARS = 64 * 1024;

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
    if (steps.ensureIndexes) {
      try {
        for (const built of ensureRetrievalIndexes(context.getDb(projectId))) {
          console.log(`[retrieval] built ${built.name} for project ${projectId} in ${built.ms} ms`);
        }
      } catch (error) {
        console.warn(`[retrieval] could not build the index's indexes for project ${projectId}:`, error);
      }
    }
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
    const yieldToCalls = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const nextLegacy = source.prepare('SELECT session_id AS sessionId FROM session_transcripts ORDER BY session_id LIMIT 1');
    const hasSession = (db: Database.Database, sessionId: string): boolean =>
      db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !== undefined;
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
            if (hasSession(other, sessionId)) {
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
      const count = Math.ceil(text.length / LEGACY_PIECE_CHARS);
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
        const piece = text.slice(written * LEGACY_PIECE_CHARS, (written + 1) * LEGACY_PIECE_CHARS);
        const seq = base + written;
        // The last piece carries the row's last write, so the transcript's
        // first and last times (MIN and MAX over pieces) survive the move.
        const createdAt = written === count - 1 ? legacy.updatedAt : legacy.createdAt;
        writeTransaction(target, () => {
          insert.run(sessionId, seq, piece.length, Buffer.byteLength(piece), createdAt, piece);
          writeProgress.run(progressKey, JSON.stringify({ base, written: written + 1 }));
        })();
        written += 1;
        await yieldToCalls();
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
      await yieldToCalls();
    }
    return result;
  }),
};
