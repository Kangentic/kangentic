import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { buildSummaryPrompt, SUMMARY_BATCH_SIZE, parseSummaryReply } from './summary-prompt';
import { readSummaryCandidates } from './summary-sources';
import { SummaryStore } from './summary-store';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';

/** Writes one batch's summaries: the search agent's read-only answer run. */
export interface SummaryWriter {
  agent: string;
  model: string | null;
  /** The effort level the run passes, recorded with each summary. */
  effort: string | null;
  write: (prompt: string) => Promise<string>;
}

export interface SummaryPassResult {
  /** Summaries written this pass. */
  written: number;
  /** Tasks still without a current summary after it. */
  remaining: number;
  /** Tasks the agent was asked about and did not answer for. */
  unanswered: string[];
  /** True when a call failed, so the caller backs off rather than retrying. */
  failed: boolean;
}

export interface SummaryPassDeps {
  getDb: (projectId: string) => Database.Database;
  now: () => string;
  yieldToEventLoop: () => Promise<void>;
}

const defaultDeps: SummaryPassDeps = {
  getDb: getProjectDb,
  now: () => new Date().toISOString(),
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
};

/**
 * Write the summaries of up to `maxBatches` batches of finished tasks whose
 * summary is missing or out of date, most recent work first. Never throws.
 *
 * The batches of one pass run AT ONCE. A call's time is the model writing
 * about 75 tokens per summary, so a bigger batch is barely faster per task
 * (measured on Sonnet 5.5 at low effort: ten tasks 6.6 s, thirty 15.9 s),
 * while three calls side by side write thirty in 7.7 s. A failed call costs
 * only its own batch: the others' summaries are kept, and its tasks stay for a
 * later pass.
 *
 * `skip` holds tasks an earlier pass asked about and got no summary for, so one
 * the agent keeps passing over costs a call once, not every pass.
 */
export async function runSummaryPass(
  projectId: string,
  writer: SummaryWriter,
  options: { maxBatches: number; shouldContinue: () => boolean; skip?: ReadonlySet<string> },
  deps: SummaryPassDeps = defaultDeps,
): Promise<SummaryPassResult> {
  const result: SummaryPassResult = { written: 0, remaining: 0, unanswered: [], failed: false };
  let db: Database.Database;
  let store: SummaryStore;
  let stale: Awaited<ReturnType<typeof readSummaryCandidates>>;
  try {
    db = deps.getDb(projectId);
    store = new SummaryStore(db);
    store.removeOrphans();
    const hashes = store.inputHashes();
    const skip = options.skip ?? new Set<string>();
    stale = (await readSummaryCandidates(db, deps.yieldToEventLoop))
      .filter((candidate) => hashes.get(candidate.input.taskId) !== candidate.hash && !skip.has(candidate.input.taskId))
      .sort((left, right) => right.lastActivityMs - left.lastActivityMs);
  } catch (error) {
    console.warn('[retrieval] summary pass could not read the board:', error);
    result.failed = true;
    return result;
  }

  const batches: Array<typeof stale> = [];
  for (let start = 0; batches.length < options.maxBatches && start < stale.length; start += SUMMARY_BATCH_SIZE) {
    batches.push(stale.slice(start, start + SUMMARY_BATCH_SIZE));
  }
  if (!options.shouldContinue()) {
    result.remaining = stale.length;
    return result;
  }
  const replies = await Promise.all(batches.map(async (batch) => {
    try {
      return { batch, reply: await writer.write(buildSummaryPrompt(batch.map((candidate) => candidate.input))) };
    } catch (error) {
      console.warn('[retrieval] a summary batch failed:', error);
      return { batch, reply: null };
    }
  }));

  let attempted = 0;
  // The pass's writes in ONE transaction. Each commit appends every page it
  // touched to the WAL, so thirty separate ones write the same table and index
  // pages thirty times over (see timed-slices.ts for the measured cost).
  const writeReplies = db.transaction(() => {
    for (const { batch, reply } of replies) {
      if (reply === null) {
        result.failed = true;
        continue;
      }
      attempted += batch.length;
      const summaries = parseSummaryReply(reply, batch.length);
      batch.forEach((candidate, position) => {
        const summary = summaries.get(position);
        if (!summary) {
          result.unanswered.push(candidate.input.taskId);
          return;
        }
        try {
          store.write({
            taskId: candidate.input.taskId,
            summary,
            inputHash: candidate.hash,
            agent: writer.agent,
            model: writer.model,
            effort: writer.effort,
            createdAt: deps.now(),
          });
          result.written += 1;
        } catch (error) {
          console.warn(`[retrieval] summary for ${candidate.input.taskId} failed to save:`, error);
        }
      });
    }
  });
  try {
    timeSyncWork('summaries:write', () => writeReplies());
  } catch (error) {
    console.warn('[retrieval] summaries failed to save:', error);
    result.failed = true;
  }
  result.remaining = stale.length - attempted;
  return result;
}
