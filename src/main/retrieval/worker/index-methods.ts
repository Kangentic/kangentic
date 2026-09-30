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

import { ConversationIndexer, type IndexOutcome } from '../conversation/conversation-indexer';
import { sweepTaskRecords, type TaskSweepResult } from '../task/task-indexer';
import { sweepChangeRecords, type ChangeSweepResult } from '../change/change-indexer';
import { sweepCommitRecords, type CommitSweepResult } from '../commit/commit-indexer';
import { purgeCodeRecords, sweepCodeRecords, type CodeSweepResult } from '../code/code-indexer';
import { RetrievalStore } from '../retrieval-store';
import { SummaryStore } from '../summary/summary-store';
import { hasVecSupport } from '../vec-support';
import { agentRegistry } from '../../agent/agent-registry';
import { adoptRemoteTargets, type RemoteTargets } from '../remote-targets';
import type { CodeSweepPlan } from '../../../shared/answer-agent';
import type { SummaryChoice } from '../../../shared/types';
import type { WorkerContext } from './methods';

/** Which sweeps one `index.sweep` runs, in this order. */
export interface IndexSweepSteps {
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
}

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
};
