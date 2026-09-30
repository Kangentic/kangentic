/**
 * Singleton orchestrator for conversation-memory indexing and the semantic
 * layer. Mirrors `prRefreshScheduler`'s lifecycle contract (deferred off the IPC
 * critical path, project-switch guarded, explicitly torn down on
 * switch/delete/shutdown, all timers `.unref()`'d). Owns:
 *  - the live finalize hooks (SessionManager 'exit' + suspended 'session-changed'),
 *  - a live turn-boundary hook (SessionManager 'activity' -> idle/permission) that
 *    re-indexes the active session so an in-progress conversation is searchable,
 *  - the per-open backfill sweep,
 *  - local model-file download orchestration,
 *  - a serial job chain (one indexing job in flight at a time - INDEXING only;
 *    embedding is owned entirely by `embedEngine`, see embedder/embed-engine.ts),
 *  - config gating and synchronous shutdown (also disposes the embed worker,
 *    via embedEngine.dispose()).
 *
 * Indexing (this file) and embedding (embed-engine.ts) are deliberately split:
 * lifecycle/navigation events here only INDEX (a cheap diff-upsert) and flag a
 * project dirty via `embedEngine.markDirty()`. They never embed inline, so a
 * project switch performs zero synchronous embedding work - the felt hardware
 * spike on switching back to a churning project is impossible by construction.
 * The central engine alone drains pending embeddings, duty-cycle throttled.
 *
 * It reuses the existing SessionManager events rather than patching the four
 * PTY-layer finalize call sites, keeping all agent knowledge behind the adapter
 * boundary.
 */

import { getProjectDb } from '../db/database';
import { RetrievalStore } from './retrieval-store';
import { hasVecSupport } from './vec-support';
import { lastVecLoadError } from './vec-extension';
import { ConversationIndexer } from './conversation/conversation-indexer';
import { sweepTaskRecords } from './task/task-indexer';
import { sweepChangeRecords } from './change/change-indexer';
import { sweepCommitRecords, type CommitSweepResult } from './commit/commit-indexer';
import { indexedCodeBranch, purgeCodeRecords, sweepCodeRecords, type CodeSweepResult } from './code/code-indexer';
import { codeStatus, createBranchSizes } from './code/code-status';
import { resolveProjectDefaultBaseBranch } from '../ipc/helpers/default-base-branch';
import { graphService } from './graph/graph-service';
import { createSummaryScheduler } from './summary/summary-scheduler';
import { readSummaryFingerprint } from './summary/summary-sources';
import { SummaryStore } from './summary/summary-store';
import { resolveAnswerRun } from './answer-run';
import { codeSweepPlan, taskSummariesOn, type CodeSweepPlan } from '../../shared/answer-agent';
import { withAnswerRunDirectory } from '../agent/shared/answer-run-directory';
import { embedEngine } from './embedder/embed-engine';
import { resolveEmbeddingModel, type EmbeddingModelDef } from './embedder/embedding-config';
import { isEmbeddingModelPresent, downloadEmbeddingModel } from './embedder/embedding-model';
import { requiresUserInteraction } from '../../shared/activity-state';
import { timeSyncWork } from '../diagnostics/event-loop-lag';
import { isEmbeddedCorpus, type MemoryCorpus } from './corpora';
import type { IpcContext } from '../ipc/ipc-context';
import type { Embedder } from './types';
import type {
  KnowledgeGraphStatus, KnowledgeGraphSemanticState, KnowledgeGraphModelState, KnowledgeGraphSummaryStatus, KnowledgeGraphCodeStatus, SummaryChoice, Project, ActivityState,
  KnowledgeGraphRebuildPlan, KnowledgeGraphSourceStatus, KnowledgeGraphSourcesStatus,
} from '../../shared/types';

/** Grace period after a finalize event before indexing, so the agent CLI has
 *  flushed its native history file.
 *
 *  Must also OUTLAST one suspend's two reports, or the per-session debounce
 *  below cannot coalesce them. `SessionManager.suspend` emits `session-changed`
 *  immediately and again after `gracefulPtyShutdown`, which is up to
 *  `gracePeriodMs` (1500) + `killPropagationMs` (1500) = 3000ms later when the
 *  agent needs a force-kill. At 2000ms the first timer fired and cleared itself
 *  before the trailing report arrived, so the slow path - the one that most
 *  needs the later, fuller read of the transcript - was the one that still
 *  indexed twice. Kept above that worst case with a margin. */
const FINALIZE_DEBOUNCE_MS = 3500;
/** Grace period after a turn completes (session goes idle / awaits permission)
 *  before a live re-index, so a burst of activity transitions within a turn
 *  coalesces into one index and the CLI has flushed the new turn to disk. */
const LIVE_INDEX_DEBOUNCE_MS = 1500;
/** Grace after a board change before its task records are re-read, so a drag
 *  or a burst of agent edits settles into one sweep. */
const TASK_RECORD_DEBOUNCE_MS = 2000;
/** How long after launch a read of a project's WHOLE default branch waits
 *  (`CommitSweepOptions.allowFullRead`, and a first code fill): past the
 *  startup's own disk and CPU load, where the same commit read stalled main
 *  for up to 1.5 s. */
const BRANCH_FULL_READ_DELAY_MS = 60_000;
/** When whole-branch reads may start. This module loads at launch. */
const branchFullReadsFrom = Date.now() + BRANCH_FULL_READ_DELAY_MS;

const indexer = new ConversationIndexer();

let attached = false;
let disposed = false;
let activeSweepProjectId: string | null = null;
/** Serial job chain: one INDEXING job runs at a time. Embedding is no longer
 *  chained here - it is owned entirely by embedEngine's own drain loop. */
let jobChain: Promise<void> = Promise.resolve();
const pendingTimers = new Set<NodeJS.Timeout>();
/** Per-session trailing-debounce timers for live (turn-boundary) re-indexing. */
const liveIndexTimers = new Map<string, NodeJS.Timeout>();
/** Per-session trailing-debounce timers for finalize (suspend / exit) indexing. */
const finalizeIndexTimers = new Map<string, NodeJS.Timeout>();
/** Per-project trailing-debounce timers for task-record re-reads. */
const taskRecordTimers = new Map<string, NodeJS.Timeout>();
/** Per-project timers for a whole-branch commit read put off past startup. */
const deferredBranchTimers = new Map<string, NodeJS.Timeout>();

// Model-file download state (downloading the local embedding model to disk).
// The embed WORKER and its warm-hold / crash / device state live in
// embedEngine, not here.
let modelDownloadState: 'idle' | 'downloading' | 'error' = 'idle';
let modelDownloadProgress = 0;
/** Which model id is currently downloading (a switch mid-download retriggers). */
let downloadingModelId: string | null = null;

/**
 * True when the currently open project's DB has sqlite-vec loaded. Read LIVE from
 * the connection - the extension is loaded by the project-DB initializer on every
 * `getProjectDb` open (see `setProjectDbInitializer(loadVecExtension)` in
 * index.ts) - rather than from a cached flag. A cached flag was wrong: it was only
 * set by `startForProject`, which runs from the `project:open` IPC handler but NOT
 * from `openProjectByPath` (the lighter path used by cold start and the ephemeral
 * dev preview). On those paths the DB is vec-capable yet the flag stayed false, so
 * the status reported "unavailable" while the model downloaded fine. embedEngine's
 * drain and query paths already gate on the live `hasVecSupport(db)`; this aligns
 * the status surface with them.
 */
function currentProjectHasVec(context: IpcContext): boolean {
  const projectId = context.currentProjectId;
  if (!projectId) return false;
  try {
    return hasVecSupport(getProjectDb(projectId));
  } catch {
    return false;
  }
}

function isIndexingEnabled(context: IpcContext): boolean {
  try {
    return context.configManager.load().knowledgeGraph?.indexingEnabled !== false;
  } catch {
    return true;
  }
}

function isSemanticEnabled(context: IpcContext): boolean {
  try {
    return context.configManager.load().knowledgeGraph?.enabled === true;
  } catch {
    return false;
  }
}

/** The user-selected embedding model (or the default). */
function selectedModel(context: IpcContext): EmbeddingModelDef {
  try {
    return resolveEmbeddingModel(context.configManager.load().knowledgeGraph?.localModel);
  } catch {
    return resolveEmbeddingModel(undefined);
  }
}

/** Human-readable name for the execution provider the worker reported ready on. */
function humanizeBackend(device: string | null | undefined): string | undefined {
  switch (device) {
    case 'dml': return 'DirectML (GPU)';
    case 'webgpu': return 'WebGPU (GPU)';
    case 'cpu': return 'CPU';
    default: return device ?? undefined;
  }
}

function chain(job: () => Promise<unknown>): void {
  jobChain = jobChain.then(() => job()).then(
    () => undefined,
    (error) => {
      console.warn('[retrieval] job failed:', error);
    },
  );
}

/** `chain`, for a caller that waits on the job and handles its failure. */
function onChain(job: () => Promise<unknown>): Promise<void> {
  const run = jobChain.then(() => job()).then(() => undefined);
  jobChain = run.catch(() => undefined);
  return run;
}

function scheduleFinalizeIndex(context: IpcContext, sessionId: string): void {
  if (disposed || !isIndexingEnabled(context)) return;
  // Per-session TRAILING debounce, like scheduleLiveIndex below. One suspend
  // now reports twice - once when the status is marked, once after the graceful
  // PTY shutdown, so the UI does not wait seconds to drop the session - and a
  // suspend followed by an exit already reported twice before that. Without a
  // per-session timer each report booked its own indexing pass over the same
  // transcript. Keeping only the LAST one is also the more correct read: the
  // later a finalize runs, the more of the agent's final flush it sees.
  const existing = finalizeIndexTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(existing);
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    finalizeIndexTimers.delete(sessionId);
    if (disposed || !isIndexingEnabled(context)) return;
    // Transient (command-terminal) sessions have no DB row; skip them.
    if (context.sessionManager.getSession(sessionId)?.transient) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) return;
    chain(async () => {
      await indexer.indexSession(projectId, sessionId);
      // Subagent token usage is walked HERE and in the project-open sweep, never
      // on the live turn-boundary path: a running fan-out rewrites its subagent
      // directory on every driver turn, so doing it there would re-walk on each
      // one. The session has just finished, so this is the walk that actually
      // captures the whole fan-out.
      await indexer.indexSubagentUsage(projectId, sessionId);
      // The files the finished session changed, read from what was just
      // indexed. Only conversations re-indexed since their last read are read.
      await sweepChangeRecords(projectId, projectPathFor(context, projectId), () => !disposed);
      // Flag the project dirty; embedEngine's own drain loop embeds the
      // freshly indexed chunks in the background, duty-cycle throttled. This
      // does NOT embed inline - that is the whole point of the split.
      embedEngine.markDirty(projectId);
    });
  }, FINALIZE_DEBOUNCE_MS);
  timer.unref();
  pendingTimers.add(timer);
  finalizeIndexTimers.set(sessionId, timer);
}

/**
 * Debounced live re-index at a turn boundary. Fired when a session transitions
 * to "requires user interaction" (idle / permission) - i.e. the agent finished a
 * message and paused - so the current conversation becomes searchable within
 * ~1.5s instead of only after the session finalizes. This is a per-session
 * TRAILING debounce: rapid transitions within one turn reset the timer, so an
 * active session is indexed once per settled turn, never per event. It stays
 * cheap because `indexSession` diff-upserts (an unchanged transcript is a
 * no-op) and embedding the new chunks happens later, in the background, via
 * embedEngine's own duty-cycle-throttled drain loop - never inline here.
 *
 * Deliberately does NOT walk subagent usage. That no-op property is what makes
 * this path cheap, and it does not hold for a live fan-out: the subagents write
 * to their own files continuously, so their directory signature changes on every
 * driver turn and each one would pay a full re-walk. Finalize and the sweep own
 * that walk.
 */
function scheduleLiveIndex(context: IpcContext, sessionId: string): void {
  if (disposed || !isIndexingEnabled(context)) return;
  const existing = liveIndexTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    liveIndexTimers.delete(sessionId);
    if (disposed || !isIndexingEnabled(context)) return;
    // Transient (command-terminal) sessions have no DB row; skip them.
    if (context.sessionManager.getSession(sessionId)?.transient) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) return;
    chain(async () => {
      await indexer.indexSession(projectId, sessionId);
      embedEngine.markDirty(projectId);
    });
  }, LIVE_INDEX_DEBOUNCE_MS);
  timer.unref();
  liveIndexTimers.set(sessionId, timer);
}

/** False once a project is deleted. A context that cannot say counts it as
 *  present, so a missing repository never silently stops indexing. */
function projectStillExists(context: IpcContext, projectId: string): boolean {
  try {
    return context.projectRepo.getById(projectId) != null;
  } catch {
    return true;
  }
}

/** A project's root, so a changed file in its main checkout reads repo-relative. */
function projectPathFor(context: IpcContext, projectId: string): string | null {
  try {
    return context.projectRepo.getById(projectId)?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * A project's commits on its default branch, brought up to date. The branch is
 * the one a task's worktree branches from (board default, config default,
 * `main`). One `git rev-parse` when the branch has not moved. A read of the
 * whole branch waits until a minute after launch, then runs on its own.
 */
async function sweepProjectCommits(
  context: IpcContext,
  projectId: string,
  projectPath: string | null,
  shouldContinue: () => boolean,
): Promise<CommitSweepResult> {
  if (!projectPath) return { indexed: 0, removed: 0, relinked: 0, deferred: false };
  const result = await sweepCommitRecords(projectId, projectPath, baseBranchFor(context, projectPath), {
    shouldContinue,
    allowFullRead: Date.now() >= branchFullReadsFrom,
  });
  if (result.deferred) sweepAgainAfterStartup(context, projectId);
  return result;
}

/** What a sweep does with the source code index (`codeSweepPlan`). */
function codePlan(context: IpcContext): CodeSweepPlan {
  return codeSweepPlan(() => context.configManager.load().knowledgeGraph);
}

/**
 * A project's source code, brought up to date with its default branch while
 * source code is switched on, and cleared when it is switched off. One
 * `git rev-parse` when the branch has not moved; the first fill waits until a
 * minute after launch, like a whole-branch commit read.
 */
async function sweepProjectCode(
  context: IpcContext,
  projectId: string,
  projectPath: string | null,
  shouldContinue: () => boolean,
): Promise<CodeSweepResult> {
  const none: CodeSweepResult = { indexed: 0, removed: 0, deferred: false };
  const plan = codePlan(context);
  if (plan === 'clear') return purgeCodeRecords(projectId) ? { ...none, removed: 1 } : none;
  if (plan === 'keep' || !projectPath) return none;
  const result = await sweepCodeRecords(projectId, projectPath, baseBranchFor(context, projectPath), {
    shouldContinue,
    allowFullRead: Date.now() >= branchFullReadsFrom,
  });
  if (result.deferred) sweepAgainAfterStartup(context, projectId);
  return result;
}

/** The branch a project's commits and code are read from: the one a task's
 *  worktree branches from (board default, config default, `main`). */
function baseBranchFor(context: IpcContext, projectPath: string): string {
  try {
    return resolveProjectDefaultBaseBranch(context, projectPath);
  } catch {
    // An unreadable config keeps the `main` default, as a worktree would.
    return 'main';
  }
}

/** Queue the record sweeps again once whole-branch reads may run: a read put
 *  off at startup then happens on its own. */
function sweepAgainAfterStartup(context: IpcContext, projectId: string): void {
  if (deferredBranchTimers.has(projectId) || disposed) return;
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    deferredBranchTimers.delete(projectId);
    queueRecordSweeps(context, projectId);
  }, Math.max(0, branchFullReadsFrom - Date.now()));
  timer.unref();
  pendingTimers.add(timer);
  deferredBranchTimers.set(projectId, timer);
}

/** Resolves once whole-branch reads may run. The summary pass waits on it, so
 *  the first summaries after launch are written with their commits rather than
 *  written without and rewritten a minute later. */
function untilBranchFullReads(): Promise<void> {
  const waitMs = branchFullReadsFrom - Date.now();
  if (waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    timer.unref();
  });
}

/**
 * Re-read a project's task records, session changes, commits and source code
 * on the serial job chain, and flag the project for the embedding drain when
 * anything changed. A sweep with nothing to do reads a few small tables and
 * writes nothing (the commits and code cost a `git rev-parse` each), so this
 * is safe to ask for whenever the board or a conversation may have moved.
 */
function queueRecordSweeps(context: IpcContext, projectId: string): void {
  if (disposed || !isIndexingEnabled(context)) return;
  chain(async () => {
    // Checked when the job runs, not when it was queued: a board-change or
    // startup timer can fire after the project was deleted, and opening its
    // database would create an empty one again.
    if (!projectStillExists(context, projectId)) return;
    const projectPath = projectPathFor(context, projectId);
    const tasks = await sweepTaskRecords(projectId, () => !disposed);
    const changes = await sweepChangeRecords(projectId, projectPath, () => !disposed);
    const commits = await sweepProjectCommits(context, projectId, projectPath, () => !disposed);
    const code = await sweepProjectCode(context, projectId, projectPath, () => !disposed);
    if (tasks.indexed > 0 || tasks.removed > 0 || changes.indexed > 0 || code.indexed > 0) embedEngine.markDirty(projectId);
    if (tasks.indexed > 0 || tasks.removed > 0 || changes.indexed > 0
      || commits.indexed > 0 || commits.removed > 0 || commits.relinked > 0
      || code.indexed > 0 || code.removed > 0) {
      // An open Knowledge Graph re-reads its snapshot, so the Index panel
      // counts what was just indexed. The map itself does not move.
      graphService.notifyChanged(projectId);
    }
  });
}

/** Task summaries are wanted: switched on (they are opt-in), with indexing and
 *  semantic search on, since the Knowledge Graph needs both. */
function summariesEnabled(context: IpcContext): boolean {
  try {
    const config = context.configManager.load().knowledgeGraph;
    return config?.indexingEnabled !== false && config?.enabled === true && taskSummariesOn(config);
  } catch {
    return false;
  }
}

/**
 * Writes task summaries in the background with the search agent and its model,
 * at the adapter's recommended effort whatever the chosen one (`agentJobChoice`).
 * With no agent chosen it resolves no writer and does nothing. A summary batch
 * runs with no tool at all; it summarizes what it is handed.
 */
const summaryScheduler = createSummaryScheduler<IpcContext>({
  isEnabled: summariesEnabled,
  // A deleted project reads no fingerprint and gets no writer, so its pass does
  // nothing: a board-change timer or a retry can fire after the delete, and
  // opening its database would create an empty one again.
  readFingerprint: (context, projectId) => (
    projectStillExists(context, projectId) ? readSummaryFingerprint(getProjectDb(projectId)) : null
  ),
  resolveWriter: async (context, projectId) => {
    if (!projectStillExists(context, projectId)) return null;
    const resolved = await resolveAnswerRun(context, projectId, 'summary', { withSearch: false, job: 'summary' });
    summaryChoice = resolved.ok ? { agent: resolved.run.agentName, model: resolved.run.model, effort: resolved.run.effort } : null;
    if (!resolved.ok) return null;
    const run = resolved.run;
    return {
      agent: run.agentName,
      model: run.model,
      effort: run.effort,
      write: (prompt) => withAnswerRunDirectory((runDirectory) => (
        run.answerFromContext(prompt, run.cliPath, run.answerHome, run.model, { effort: run.effort, runDirectory })
      )),
    };
  },
  // A summary is part of its task's record, so the record re-reads, and the
  // map's region names read summaries. Renamed at once when the backfill has
  // caught up, and otherwise at most every few minutes.
  onWritten: (context, projectId, caughtUp) => {
    queueRecordSweeps(context, projectId);
    graphService.requestRegionNames(projectId, caughtUp);
  },
  // The files a task changed and its commits are part of what its summary is
  // written from. Cheap once caught up; on a cold start (which skips the
  // project-open sweep) it is what keeps the first summaries from being written
  // without them.
  //
  // On the job chain, like every other sweep: two commit sweeps of one project
  // interleaving at their awaits let the older one delete what the newer one
  // wrote. The startup wait sits between the two, off the chain, so it holds
  // up no other indexing.
  beforePass: async (context, projectId) => {
    const projectPath = projectPathFor(context, projectId);
    await onChain(() => sweepChangeRecords(projectId, projectPath, () => !disposed));
    await untilBranchFullReads();
    await onChain(() => sweepProjectCommits(context, projectId, projectPath, () => !disposed));
  },
});

/**
 * What a summary would be written with now: the search agent, its model and the
 * recommended effort main resolves for a summary, or null while summaries are off
 * or wait for a choice. Kept
 * here because a caught-up board never resolves a writer (the fingerprint skip),
 * so a settings change refreshes it (`refreshSummaryChoice`) rather than waiting
 * for a pass. The status poll reads it without resolving anything.
 */
let summaryChoice: SummaryChoice | null = null;
let summaryChoiceRefresh: Promise<void> | null = null;
/** Bumped by each refresh, so one started under older settings cannot land
 *  after a newer one and leave its stale choice in place. */
let summaryChoiceGeneration = 0;

/**
 * What a summary would be written with now, for Rebuild and its plan, or null
 * while summaries are off or wait for a choice (nothing to rewrite then).
 * Resolved through the writer's own rule so the two can never disagree.
 */
async function resolveRewriteChoice(context: IpcContext): Promise<SummaryChoice | null> {
  if (disposed || !summariesEnabled(context)) return null;
  const homeProjectId = context.currentProjectId ?? context.projectRepo.list()[0]?.id;
  if (!homeProjectId) return null;
  const resolved = await resolveAnswerRun(context, homeProjectId, 'summary', { withSearch: false, job: 'summary' }).catch(() => null);
  if (!resolved?.ok) return null;
  const choice = { agent: resolved.run.agentName, model: resolved.run.model, effort: resolved.run.effort };
  summaryChoice = choice;
  return choice;
}

/**
 * Re-resolve `summaryChoice` from the current settings. One at a time, except
 * after a settings change (`force`): a refresh already in flight read the old
 * settings, so a new one starts and the old one's result is dropped.
 */
function refreshSummaryChoice(context: IpcContext, options: { force?: boolean } = {}): void {
  if (disposed || (summaryChoiceRefresh && !options.force)) return;
  summaryChoiceGeneration += 1;
  const generation = summaryChoiceGeneration;
  const projectId = context.currentProjectId;
  if (!projectId || !summariesEnabled(context)) {
    summaryChoice = null;
    summaryChoiceRefresh = null;
    return;
  }
  summaryChoiceRefresh = resolveAnswerRun(context, projectId, 'summary', { withSearch: false, job: 'summary' })
    .then((resolved) => {
      if (generation !== summaryChoiceGeneration) return;
      summaryChoice = resolved.ok ? { agent: resolved.run.agentName, model: resolved.run.model, effort: resolved.run.effort } : null;
    })
    .catch(() => {
      if (generation === summaryChoiceGeneration) summaryChoice = null;
    })
    .finally(() => {
      if (generation === summaryChoiceGeneration) summaryChoiceRefresh = null;
    });
}

/**
 * The open project's summaries for the Task summaries card's status row and
 * Rewrite: a few index reads (under 0.1 ms each measured) and the scheduler's
 * own state. Read on the Knowledge Graph tab's status poll while semantic search is on,
 * with the switch off too: switching summaries on starts writing at once, so the
 * card gives the backfill's size before it is on.
 */
function summaryStatusFor(context: IpcContext): KnowledgeGraphSummaryStatus | undefined {
  const projectId = context.currentProjectId;
  if (!projectId || !isIndexingEnabled(context) || !isSemanticEnabled(context)) return undefined;
  try {
    const db = getProjectDb(projectId);
    const counts = new RetrievalStore(db).summaryCounts();
    const summaries = new SummaryStore(db);
    const scheduler = summaryScheduler.status(projectId);
    // Never resolved yet this run (or waiting on a choice): resolve it for the
    // next poll. A settings change refreshes it too.
    if (summaryChoice === null) refreshSummaryChoice(context);
    const skipped = summaryScheduler.skipped(projectId);
    const awaitingRewrite = summaries.awaitingRewrite();
    // What is left to write at the run's own rate: unwritten tasks the agent
    // has not passed over, and summaries marked for rewriting.
    const remaining = Math.max(0, counts.finishedTasks - counts.written - skipped) + awaitingRewrite;
    const perMinute = summaryScheduler.writtenPerMinute(projectId);
    return {
      ...counts,
      skipped,
      state: scheduler.state,
      retryInMs: scheduler.retryAtMs === null ? null : Math.max(0, scheduler.retryAtMs - Date.now()),
      minutesLeft: perMinute && remaining > 0 ? remaining / perMinute : null,
      writtenWith: summaries.writtenWith(),
      choice: summaryChoice,
      awaitingRewrite,
    };
  } catch {
    return undefined;
  }
}

/**
 * How long the Index card keeps a project's corpus totals before reading them
 * again. The totals are the Index panel's own read (`corpusTotals`, so the two
 * show the same counts), about 15 ms on a 94k-chunk index, and they move only
 * as documents are indexed. Keyed on the index's size instead, as the Index
 * panel is, they were read again after every embedding batch: 51 to 71 ms on
 * main on nearly every 1.5 s poll while embedding ran (the size check alone is
 * two full index counts). What moves by the second, the passages still
 * waiting, is read on every poll by a query that costs what is waiting.
 */
const SOURCE_TOTALS_TTL_MS = 30_000;
const sourceTotalsCache = new Map<string, { readAt: number; totals: ReturnType<RetrievalStore['corpusTotals']> }>();

/**
 * The open project's always-indexed sources for their lines in the Index card:
 * conversations, tasks, commits. "Caught up" is decided here: an embedded
 * source waits while any passage lacks a vector for the current model, a
 * keyword-only one never does.
 */
function sourcesStatusFor(context: IpcContext): KnowledgeGraphSourcesStatus | undefined {
  const projectId = context.currentProjectId;
  if (!projectId || !isIndexingEnabled(context)) return undefined;
  try {
    const store = new RetrievalStore(getProjectDb(projectId));
    const now = Date.now();
    let cached = sourceTotalsCache.get(projectId);
    if (!cached || now - cached.readAt > SOURCE_TOTALS_TTL_MS) {
      cached = { readAt: now, totals: timeSyncWork('status:source-totals', () => store.corpusTotals()) };
      sourceTotalsCache.set(projectId, cached);
    }
    const totals = cached.totals;
    const semanticOn = isSemanticEnabled(context);
    const waitingByCorpus = semanticOn
      ? timeSyncWork('status:source-waiting', () => store.countChunksNeedingEmbedding(selectedModel(context).modelTag))
      : new Map<string, number>();
    const perMinute = embedEngine.chunksPerMinute;
    const sourceOf = (corpus: MemoryCorpus): KnowledgeGraphSourceStatus => {
      const row = totals.find((entry) => entry.corpus === corpus);
      const count = row?.documents ?? 0;
      const waiting = isEmbeddedCorpus(corpus) ? waitingByCorpus.get(corpus) ?? 0 : 0;
      if (waiting === 0) return { count, percent: null, minutesLeft: null };
      // The totals can trail a fresh index by up to the cache's age, so the
      // share is held under 100 while anything still waits.
      const chunks = Math.max(row?.chunks ?? 0, waiting);
      return {
        count,
        percent: Math.min(99, Math.floor(((chunks - waiting) / chunks) * 100)),
        minutesLeft: perMinute ? waiting / perMinute : null,
      };
    };
    return { conversations: sourceOf('conversation'), tasks: sourceOf('task'), commits: sourceOf('commit') };
  } catch {
    return undefined;
  }
}

/** Default branch sizes for the Source code card, read in the background. */
const codeBranchSizes = createBranchSizes();

/**
 * The open project's source code for the Source code card's status line. Off,
 * the size of its default branch and how long embedding it would take here;
 * on, how far the index has got. Three index counts, plus a background branch
 * reading at most once a minute while nothing is indexed. Read on the Search
 * tab's status poll, only while semantic search is on.
 */
function codeStatusFor(context: IpcContext): KnowledgeGraphCodeStatus | undefined {
  const projectId = context.currentProjectId;
  if (!projectId || !isIndexingEnabled(context) || !isSemanticEnabled(context)) return undefined;
  try {
    const on = codePlan(context) === 'index';
    const store = new RetrievalStore(getProjectDb(projectId));
    const progress = on
      ? store.corpusProgress('code', selectedModel(context).modelTag)
      : { documents: 0, chunks: 0, embedded: 0 };
    const projectPath = projectPathFor(context, projectId);
    // Git only while nothing is indexed: the index knows its own size after.
    const branchSize = progress.documents === 0 && projectPath
      ? codeBranchSizes.get(projectId, projectPath, baseBranchFor(context, projectPath))
      : undefined;
    return codeStatus({
      on,
      progress,
      indexedBranch: indexedCodeBranch(store),
      branchSize: projectPath ? branchSize : null,
      chunksPerMinute: embedEngine.chunksPerMinute,
    });
  } catch {
    return undefined;
  }
}

/** A board change re-reads its project's records once the burst settles. */
function scheduleTaskRecordSweep(context: IpcContext, projectId: string): void {
  if (disposed) return;
  const existing = taskRecordTimers.get(projectId);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(existing);
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    taskRecordTimers.delete(projectId);
    queueRecordSweeps(context, projectId);
    // A task that just reached Done gets its summary.
    summaryScheduler.request(context, projectId);
  }, TASK_RECORD_DEBOUNCE_MS);
  timer.unref();
  pendingTimers.add(timer);
  taskRecordTimers.set(projectId, timer);
}

/** Ensure the selected model is downloaded when semantic is enabled. Runs the
 *  download once per model; progress is exposed via getStatus(). */
function ensureModelDownload(context: IpcContext): void {
  if (disposed || !isSemanticEnabled(context)) return;
  const model = selectedModel(context);
  if (isEmbeddingModelPresent(model)) return;
  if (modelDownloadState === 'downloading' && downloadingModelId === model.id) return;
  modelDownloadState = 'downloading';
  downloadingModelId = model.id;
  modelDownloadProgress = 0;
  downloadEmbeddingModel(model, (progress) => {
    modelDownloadProgress = progress.totalBytes > 0 ? progress.downloadedBytes / progress.totalBytes : 0;
  }).then(
    () => {
      modelDownloadState = 'idle';
      modelDownloadProgress = 1;
      // The model just landed - flag the current project dirty so embedEngine's
      // background drain embeds the already-indexed chunks without waiting for
      // the next project open. This is a markDirty, not an inline embed: the
      // drain is duty-cycle throttled, so even this one-time backfill is paced.
      const projectId = context.currentProjectId;
      if (projectId) embedEngine.markDirty(projectId);
    },
    (error) => {
      console.warn('[retrieval] embedding model download failed:', error);
      modelDownloadState = 'error';
    },
  );
}

export const retrievalService = {
  /** Subscribe to session lifecycle + turn-boundary events, and start the
   *  central embedding engine's drain loop. Idempotent; call once at startup. */
  attach(context: IpcContext): void {
    embedEngine.attach(context);
    // Embedded task records move the Index's embedded shares, which an open
    // graph only learns by re-reading its snapshot.
    embedEngine.setOnRecordsEmbedded((projectId) => graphService.notifyChanged(projectId));
    // The Index says how many finished tasks the agent passed over, which only
    // the scheduler knows.
    graphService.setSummariesSkipped((projectId) => summaryScheduler.skipped(projectId));
    // Region names read summaries only while they are switched on; off, the
    // map's names are its titles' alone.
    graphService.setSummaryNamesOn(() => {
      try {
        return taskSummariesOn(context.configManager.load().knowledgeGraph);
      } catch {
        return false;
      }
    });
    graphService.setProjectExists((projectId) => projectStillExists(context, projectId));
    if (attached) return;
    attached = true;
    context.sessionManager.on('exit', (sessionId: string) => {
      scheduleFinalizeIndex(context, sessionId);
    });
    context.sessionManager.on('session-changed', (sessionId: string, session: { status: string }) => {
      // Suspend flushes the agent's native history just like a clean exit.
      if (session.status === 'suspended') scheduleFinalizeIndex(context, sessionId);
    });
    context.sessionManager.on('activity', (sessionId: string, activity: ActivityState) => {
      // A turn just completed: the agent produced a message and is now idle
      // (waiting for the user) or paused for permission. Live-index that session
      // so the ongoing conversation is searchable without waiting for it to end.
      if (requiresUserInteraction(activity)) scheduleLiveIndex(context, sessionId);
    });
    // Task records follow the board. The bus hears agent and MCP edits and
    // every move; a plain desktop edit of a task's text is caught by the
    // refresh a question asks for (`refreshTaskRecords`).
    context.boardEvents.onBoardChanged((event) => {
      if (event.change === 'swimlane-updated') return;
      scheduleTaskRecordSweep(context, event.projectId);
    });
  },

  /** Run a deferred, project-switch-guarded backfill sweep for a project, then
   *  flag it dirty so embedEngine's background drain embeds its chunks. Called
   *  on every PROJECT_OPEN and after a memory-config change. Never embeds
   *  inline - a project open performs zero synchronous embedding work. */
  startForProject(context: IpcContext, project: Project): void {
    if (disposed) return;
    this.attach(context);
    activeSweepProjectId = project.id;
    setImmediate(() => {
      if (disposed) return;
      if (context.currentProjectId !== project.id) return;
      if (!isIndexingEnabled(context)) return;

      // Reconcile any vec rows orphaned while the extension was unavailable.
      try {
        const db = getProjectDb(project.id);
        if (hasVecSupport(db)) new RetrievalStore(db).reconcileVecOrphans();
      } catch {
        // sqlite-vec unavailable for this DB; the engine runs lexical-only.
      }

      if (isSemanticEnabled(context)) ensureModelDownload(context);

      chain(async () => {
        const stillThisProject = (): boolean =>
          !disposed && context.currentProjectId === project.id && activeSweepProjectId === project.id;
        await indexer.sweepProject(project.id, stillThisProject);
        // The board's own records, the files each conversation changed, and
        // the default branch's commits: each cheap once caught up, and
        // complete on the first open.
        await sweepTaskRecords(project.id, stillThisProject);
        await sweepChangeRecords(project.id, project.path, stillThisProject);
        await sweepProjectCommits(context, project.id, project.path, stillThisProject);
        await sweepProjectCode(context, project.id, project.path, stillThisProject);
        // Covers project open, the startup backlog, AND crash-resume: the
        // sweep re-indexed whatever changed, and this flags it for the
        // background drain regardless of whether anything actually changed
        // (markDirty is cheap and idempotent).
        embedEngine.markDirty(project.id);
        // Summaries read the changes just indexed; the first open backfills.
        summaryScheduler.request(context, project.id);
      });
    });
  },

  /** Re-read a project's task records and session changes now (queued behind
   *  any indexing job). Asked for when a question starts, which catches a
   *  desktop edit the board event bus does not carry and a conversation the
   *  turn-boundary index just re-read; nothing waits on it. */
  refreshRecords(context: IpcContext, projectId: string): void {
    queueRecordSweeps(context, projectId);
  },

  /** The embedder for the search path, or null for lexical-only. Consulted by
   *  the search IPC handler / MCP recall tool when the caller asks for semantic
   *  or hybrid results. Interactive queries through this path always preempt
   *  the background drain in the shared worker. */
  getEmbedder(context: IpcContext): Embedder | null {
    return embedEngine.getEmbedder(context);
  },

  /** Re-evaluate the embed-worker warm-hold, and (when semantic just became
   *  viable) flag the current project dirty. Call after a change to
   *  `knowledgeGraph.enabled`/model/acceleration or to the current project
   *  (open/close), since those paths have no embed() call of their own to
   *  piggyback the gate on. */
  reconcileEmbedWorker(context: IpcContext): void {
    embedEngine.reconcile(context);
    // The same Knowledge Graph settings decide summaries: choosing the search agent, or
    // turning summaries on, starts the backfill without a re-open, and what a
    // summary is written with may have changed.
    const projectId = context.currentProjectId;
    summaryChoice = null;
    refreshSummaryChoice(context, { force: true });
    if (projectId) summaryScheduler.request(context, projectId);
    // Switching source code on fills the code index, and off clears it.
    if (projectId) queueRecordSweeps(context, projectId);
  },

  /**
   * What the Index card's Rebuild would spend: the task summaries in every
   * project written with anything but what a summary would be written with
   * now. Resolved here, as Rebuild resolves it, so the count the confirm names
   * is exactly what Rebuild marks. One small read per project.
   */
  async rebuildPlan(context: IpcContext): Promise<KnowledgeGraphRebuildPlan> {
    const choice = await resolveRewriteChoice(context);
    if (!choice) return { summariesToRewrite: 0 };
    let summariesToRewrite = 0;
    for (const project of context.projectRepo.list()) {
      try {
        summariesToRewrite += new SummaryStore(getProjectDb(project.id)).countNotWrittenWith(choice);
      } catch (error) {
        console.warn(`[retrieval] rebuild plan could not read project=${project.id}:`, error);
      }
    }
    return { summariesToRewrite };
  },

  /**
   * The Index card's Rebuild: everything, in every project. Each project
   * forgets what its sources were read from (`resetIndexState`: never the
   * chunks or their vectors, so nothing indexed is lost and unchanged text
   * keeps its vector), and its summaries written with another agent or model
   * are marked for rewriting, each keeping its text until the new one lands.
   *
   * Only the open project is read again now. A sweep runs for the open project
   * alone (`startForProject` stops any other), so the rest are read again on
   * their next open, from the state cleared here. The same holds for their
   * rewrites, which their next summary pass picks up.
   */
  async rebuildEverything(context: IpcContext): Promise<KnowledgeGraphRebuildPlan> {
    if (disposed) return { summariesToRewrite: 0 };
    const choice = await resolveRewriteChoice(context);
    let summariesToRewrite = 0;
    for (const project of context.projectRepo.list()) {
      try {
        const db = getProjectDb(project.id);
        new RetrievalStore(db).resetIndexState();
        if (choice) summariesToRewrite += new SummaryStore(db).markForRewrite(choice);
        // Nothing on the board moved, so the fingerprint would call it caught up.
        summaryScheduler.invalidate(project.id);
      } catch (error) {
        console.warn(`[retrieval] rebuild could not reset project=${project.id}:`, error);
      }
    }
    console.log(`[retrieval] rebuild projects=${context.projectRepo.list().length} summaries marked for rewrite=${summariesToRewrite}`);
    const openProjectId = context.currentProjectId;
    const openProject = openProjectId ? context.projectRepo.getById(openProjectId) : null;
    if (openProject) {
      this.stop(openProject.id);
      this.startForProject(context, openProject);
      summaryScheduler.request(context, openProject.id);
    }
    return { summariesToRewrite };
  },

  /**
   * One task's summary, for the Knowledge Graph's selected conversation. Null
   * while task summaries are switched off, so the panel reads as it did before
   * summaries, and null when the task has none. One indexed read.
   */
  taskSummary(context: IpcContext, projectId: string, taskId: string): string | null {
    try {
      if (!taskSummariesOn(context.configManager.load().knowledgeGraph)) return null;
      return new SummaryStore(getProjectDb(projectId)).summariesFor([taskId]).get(taskId) ?? null;
    } catch {
      return null;
    }
  },

  /** Spawn + init the embed worker ahead of a question (Knowledge Graph open),
   *  embedding nothing. A no-op when semantic is off, the model is absent, or
   *  the worker has crashed past its cap. */
  prewarmEmbedWorker(context: IpcContext): void {
    if (disposed) return;
    embedEngine.prewarm(context);
  },

  /** Current conversation-memory status for the Search settings
   *  tab's index progress and model status line. */
  getStatus(context: IpcContext): KnowledgeGraphStatus {
    const indexingEnabled = isIndexingEnabled(context);
    const semanticOn = isSemanticEnabled(context);
    const model = selectedModel(context);

    // Self-heal: when semantic is enabled but the model isn't present, make sure
    // its download is running. This is what actually kicks the download after
    // the user flips the toggle, since the Knowledge Graph tab polls getStatus. Skipped while already downloading (guarded inside) and after an
    // error (no retry spam - the user re-toggles to retry).
    if (indexingEnabled && semanticOn && !isEmbeddingModelPresent(model) && modelDownloadState !== 'error') {
      ensureModelDownload(context);
    } else if (indexingEnabled && semanticOn && isEmbeddingModelPresent(model) && !embedEngine.workerCrashed) {
      // Model already on disk: flag the current project dirty too, so enabling
      // semantic (or switching model / acceleration) drains the already-indexed
      // chunks in the background without waiting for a project re-open or a
      // rebuild. Cheap and idempotent - the engine self-clears a project from
      // its dirty set once nothing remains, so this is a no-op safety net once
      // caught up, continuously re-armed by every getStatus poll.
      const projectId = context.currentProjectId;
      if (projectId) embedEngine.markDirty(projectId);
    }

    const modelPresent = isEmbeddingModelPresent(model);
    const isDownloadingThis = modelDownloadState === 'downloading' && downloadingModelId === model.id;

    let semantic: KnowledgeGraphSemanticState;
    let workerError: string | undefined;
    if (!indexingEnabled || !semanticOn) {
      // Genuinely off: the user has not enabled semantic search.
      semantic = 'disabled';
    } else if (modelDownloadState === 'error') {
      semantic = 'error';
    } else if (isDownloadingThis || !modelPresent) {
      // Enabled, but the model is still downloading / not ready yet.
      semantic = 'downloading';
    } else if (embedEngine.workerCrashed) {
      // The restart policy gave up. Carry its reason so the Knowledge Graph tab can say
      // why instead of only that it failed.
      semantic = 'error';
      workerError = embedEngine.workerCrashReason ?? undefined;
    } else if (!currentProjectHasVec(context)) {
      semantic = 'lexical';
    } else {
      semantic = 'hybrid';
    }

    let modelState: KnowledgeGraphModelState;
    if (modelDownloadState === 'error') modelState = 'error';
    else if (modelPresent) modelState = 'ready';
    else if (isDownloadingThis || semanticOn) modelState = 'downloading';
    else modelState = 'absent';

    const showProgress = isDownloadingThis;
    return {
      indexingEnabled,
      semantic,
      activeBackend: humanizeBackend(embedEngine.activeDevice),
      modelProgress: showProgress ? modelDownloadProgress : undefined,
      vecError: semantic === 'lexical' ? lastVecLoadError() ?? undefined : undefined,
      workerError,
      model: {
        id: model.id,
        displayName: model.displayName,
        tier: model.tier,
        approxSizeMb: model.approxSizeMb,
        dimensions: model.dimensions,
        state: modelState,
        progress: showProgress ? modelDownloadProgress : undefined,
      },
      summaries: summaryStatusFor(context),
      code: codeStatusFor(context),
      sources: sourcesStatusFor(context),
    };
  },

  /** Stop the active sweep for a project (or unconditionally with no arg).
   *  The in-flight sweep observes the guard and returns promptly. */
  stop(projectId?: string): void {
    if (projectId != null && projectId !== activeSweepProjectId) return;
    activeSweepProjectId = null;
  },

  /** Clear one project's entire conversation index (Privacy "clear index"). */
  purgeProjectIndex(projectId: string): void {
    try {
      new RetrievalStore(getProjectDb(projectId)).purgeAll();
    } catch (error) {
      console.warn('[retrieval] purge failed:', error);
    }
    // Or the Index card counts what was just cleared for up to 30 s.
    sourceTotalsCache.delete(projectId);
  },

  /** Synchronous shutdown: stop scheduling, drop pending timers, dispose the
   *  embedding engine (which synchronously kills the embed worker), mark
   *  disposed. In-flight work is abandoned; the next open recovers it. */
  dispose(): void {
    disposed = true;
    activeSweepProjectId = null;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    for (const timer of liveIndexTimers.values()) clearTimeout(timer);
    liveIndexTimers.clear();
    for (const timer of finalizeIndexTimers.values()) clearTimeout(timer);
    finalizeIndexTimers.clear();
    for (const timer of taskRecordTimers.values()) clearTimeout(timer);
    taskRecordTimers.clear();
    deferredBranchTimers.clear();
    summaryScheduler.dispose();
    embedEngine.dispose();
  },
};
