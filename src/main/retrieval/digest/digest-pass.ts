import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { buildDigestPrompt, DIGEST_BATCH_SIZE, parseDigestReply } from './digest-prompt';
import { readDigestCandidates } from './digest-sources';
import { DigestStore } from './digest-store';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';

/** Writes one batch's digests: the digest agent's read-only answer run. */
export interface DigestWriter {
  agent: string;
  model: string | null;
  /** The effort level the run passes, recorded with each digest. */
  effort: string | null;
  write: (prompt: string) => Promise<string>;
}

export interface DigestPassResult {
  /** Digests written this pass. */
  written: number;
  /** Tasks still without a current digest after it. */
  remaining: number;
  /** Tasks the agent was asked about and did not answer for. */
  unanswered: string[];
  /** True when a call failed, so the caller backs off rather than retrying. */
  failed: boolean;
}

export interface DigestPassDeps {
  getDb: (projectId: string) => Database.Database;
  now: () => string;
  yieldToEventLoop: () => Promise<void>;
}

const defaultDeps: DigestPassDeps = {
  getDb: getProjectDb,
  now: () => new Date().toISOString(),
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
};

/**
 * Write the digests of up to `maxBatches` batches of finished tasks whose
 * digest is missing or out of date, most recent work first. Never throws.
 *
 * The batches of one pass run AT ONCE. A call's time is the model writing
 * about 75 tokens per digest, so a bigger batch is barely faster per task
 * (measured on Sonnet 5.5 at low effort: ten tasks 6.6 s, thirty 15.9 s),
 * while three calls side by side write thirty in 7.7 s. A failed call costs
 * only its own batch: the others' digests are kept, and its tasks stay for a
 * later pass.
 *
 * `skip` holds tasks an earlier pass asked about and got no digest for, so one
 * the agent keeps passing over costs a call once, not every pass.
 */
export async function runDigestPass(
  projectId: string,
  writer: DigestWriter,
  options: { maxBatches: number; shouldContinue: () => boolean; skip?: ReadonlySet<string> },
  deps: DigestPassDeps = defaultDeps,
): Promise<DigestPassResult> {
  const result: DigestPassResult = { written: 0, remaining: 0, unanswered: [], failed: false };
  let db: Database.Database;
  let store: DigestStore;
  let stale: Awaited<ReturnType<typeof readDigestCandidates>>;
  try {
    db = deps.getDb(projectId);
    store = new DigestStore(db);
    store.removeOrphans();
    const hashes = store.inputHashes();
    const skip = options.skip ?? new Set<string>();
    stale = (await readDigestCandidates(db, deps.yieldToEventLoop))
      .filter((candidate) => hashes.get(candidate.input.taskId) !== candidate.hash && !skip.has(candidate.input.taskId))
      .sort((left, right) => right.lastActivityMs - left.lastActivityMs);
  } catch (error) {
    console.warn('[retrieval] digest pass could not read the board:', error);
    result.failed = true;
    return result;
  }

  const batches: Array<typeof stale> = [];
  for (let start = 0; batches.length < options.maxBatches && start < stale.length; start += DIGEST_BATCH_SIZE) {
    batches.push(stale.slice(start, start + DIGEST_BATCH_SIZE));
  }
  if (!options.shouldContinue()) {
    result.remaining = stale.length;
    return result;
  }
  const replies = await Promise.all(batches.map(async (batch) => {
    try {
      return { batch, reply: await writer.write(buildDigestPrompt(batch.map((candidate) => candidate.input))) };
    } catch (error) {
      console.warn('[retrieval] a digest batch failed:', error);
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
      const digests = parseDigestReply(reply, batch.length);
      batch.forEach((candidate, position) => {
        const digest = digests.get(position);
        if (!digest) {
          result.unanswered.push(candidate.input.taskId);
          return;
        }
        try {
          store.write({
            taskId: candidate.input.taskId,
            digest,
            inputHash: candidate.hash,
            agent: writer.agent,
            model: writer.model,
            effort: writer.effort,
            createdAt: deps.now(),
          });
          result.written += 1;
        } catch (error) {
          console.warn(`[retrieval] digest for ${candidate.input.taskId} failed to save:`, error);
        }
      });
    }
  });
  try {
    timeSyncWork('digests:write', () => writeReplies());
  } catch (error) {
    console.warn('[retrieval] digests failed to save:', error);
    result.failed = true;
  }
  result.remaining = stale.length - attempted;
  return result;
}
