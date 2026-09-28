import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { buildDigestPrompt, DIGEST_BATCH_SIZE, parseDigestReply } from './digest-prompt';
import { readDigestCandidates } from './digest-sources';
import { DigestStore } from './digest-store';

/** Writes one batch's digests: the answering agent's read-only answer run. */
export interface DigestWriter {
  agent: string;
  model: string | null;
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

  let attempted = 0;
  for (let batchIndex = 0; batchIndex < options.maxBatches && attempted < stale.length; batchIndex += 1) {
    if (!options.shouldContinue()) break;
    const batch = stale.slice(attempted, attempted + DIGEST_BATCH_SIZE);
    attempted += batch.length;
    let reply: string;
    try {
      reply = await writer.write(buildDigestPrompt(batch.map((candidate) => candidate.input)));
    } catch (error) {
      console.warn('[retrieval] a digest batch failed:', error);
      result.failed = true;
      attempted -= batch.length;
      break;
    }
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
          createdAt: deps.now(),
        });
        result.written += 1;
      } catch (error) {
        console.warn(`[retrieval] digest for ${candidate.input.taskId} failed to save:`, error);
      }
    });
  }
  result.remaining = stale.length - attempted;
  return result;
}
