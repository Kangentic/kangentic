import { buildSummaryPrompt, SUMMARY_BATCH_SIZE, parseSummaryReply, describeReplyGaps, type SummaryReplyGaps } from './summary-prompt';
import type { SummaryCandidate } from './summary-sources';
import type { SummaryPassStore, SummaryRow } from './summary-pass-store';
import { retrievalClient } from '../retrieval-client';

/** Writes one batch's summaries: the Knowledge Graph's agent's read-only answer run. */
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
  /**
   * True when a call failed and no batch of the pass came back answered: the
   * agent itself is what failed, and it is shared by every project, so the
   * caller holds every project back, not only this one. A failed read or save,
   * or a call failing beside another that answered, leaves it false: `failed`
   * alone backs off this project.
   */
  callFailed: boolean;
}

export interface SummaryPassDeps {
  store: SummaryPassStore;
  now: () => string;
}

/** The pass's reads and writes, run by the retrieval worker. A pass is a
 *  background job, so neither has a call budget. */
const workerSummaryPassStore: SummaryPassStore = {
  candidates: (projectId, skip) => retrievalClient.call('summary.candidates', { projectId, skip: [...skip] }, { timeoutMs: null }),
  save: (projectId, rows) => retrievalClient.call('summary.save', { projectId, rows: [...rows] }, { timeoutMs: null }),
};

const defaultDeps: SummaryPassDeps = {
  store: workerSummaryPassStore,
  now: () => new Date().toISOString(),
};

/**
 * One line for a batch the reply did not fully cover: which labels it left out,
 * wrote twice or left blank, each with its task id, and the first lines that
 * carry no label. Those tell a format miss from a refusal, which the count of
 * unanswered tasks alone cannot. The `[retrieval]` tag is not a Sentry
 * breadcrumb tag (`shared/sentry-breadcrumbs.ts`), so the reply's text, written
 * from the tasks' own, stays in the local log.
 */
function logReplyGaps(projectId: string, batch: ReadonlyArray<SummaryCandidate>, gaps: SummaryReplyGaps, then?: string): void {
  const named = (positions: ReadonlyArray<number>): string => positions
    .map((position) => `D${position + 1}=${batch[position]?.input.taskId ?? '?'}`)
    .join(', ');
  const parts = [`tasks=${batch.length}`, `lines=${gaps.lines}`];
  if (gaps.missing.length > 0) parts.push(`left out ${named(gaps.missing)}`);
  if (gaps.writtenTwice.length > 0) parts.push(`wrote twice ${named(gaps.writtenTwice)}`);
  if (gaps.blank.length > 0) parts.push(`blank ${named(gaps.blank)}`);
  if (gaps.unlabelled.length > 0) parts.push(`unlabelled: ${gaps.unlabelled.map((line) => JSON.stringify(line)).join(' | ')}`);
  if (then) parts.push(then);
  console.log(`[retrieval] summary reply project=${projectId} ${parts.join('; ')}`);
}

/** One batch's prompt answered, or null when its call failed. */
interface BatchReply {
  batch: SummaryCandidate[];
  reply: string | null;
}

/**
 * `work` over the items, at most `limit` at once, asking `shouldContinue`
 * before each one. The results of the items it got to, in item order.
 */
async function inTurns<Item, Result>(
  items: ReadonlyArray<Item>,
  limit: number,
  shouldContinue: () => boolean,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Array<Result | undefined> = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length && shouldContinue()) {
      const position = next;
      next += 1;
      results[position] = await work(items[position]);
    }
  };
  if (items.length > 0) await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results.filter((result): result is Result => result !== undefined);
}

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
 * A batch whose reply carries no usable label at all is asked again one task
 * per call, `maxBatches` calls at a time, while another batch of the same pass
 * came back labelled: one extra call per task of an unusable reply, none while
 * replies are usable, and none when every reply missed.
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
  const result: SummaryPassResult = { written: 0, remaining: 0, unanswered: [], failed: false, callFailed: false };
  let stale: SummaryCandidate[];
  try {
    stale = await deps.store.candidates(projectId, [...(options.skip ?? [])]);
  } catch (error) {
    console.warn('[retrieval] summary pass could not read the board:', error);
    result.failed = true;
    return result;
  }

  const batches: SummaryCandidate[][] = [];
  for (let start = 0; batches.length < options.maxBatches && start < stale.length; start += SUMMARY_BATCH_SIZE) {
    batches.push(stale.slice(start, start + SUMMARY_BATCH_SIZE));
  }
  if (!options.shouldContinue()) {
    result.remaining = stale.length;
    return result;
  }
  const ask = async (batch: SummaryCandidate[]): Promise<BatchReply> => {
    try {
      return { batch, reply: await writer.write(buildSummaryPrompt(batch.map((candidate) => candidate.input))) };
    } catch (error) {
      console.warn('[retrieval] a summary batch failed:', error);
      return { batch, reply: null };
    }
  };
  const outcomes = await Promise.all(batches.map(ask));
  // Parsed once per reply here; the write loop below parses the ones it keeps.
  const labelled = outcomes.map((outcome) => (
    outcome.reply !== null && parseSummaryReply(outcome.reply, outcome.batch.length).size > 0
  ));
  // A reply with no usable label at all (a refusal, or every line in some
  // other format) says nothing about any one of its tasks, so each is asked
  // once on its own: one task the agent will not summarize then does not cost
  // the rest of its batch until the next launch. Only while another batch of
  // this pass came back labelled, which shows the writer can answer. A CLI that
  // prints a login or quota message instead of failing, or a model that ignores
  // the format, misses every batch, and asking each task alone would only
  // multiply the calls that cannot work.
  const writerAnswered = labelled.includes(true);
  const replies: BatchReply[] = [];
  const askAlone: SummaryCandidate[] = [];
  for (const [position, outcome] of outcomes.entries()) {
    if (writerAnswered && outcome.reply !== null && outcome.batch.length > 1 && !labelled[position]) {
      const gaps = describeReplyGaps(outcome.reply, outcome.batch.length);
      if (gaps) logReplyGaps(projectId, outcome.batch, gaps, 'asking each task alone');
      askAlone.push(...outcome.batch);
    } else {
      replies.push(outcome);
    }
  }
  // A task not asked because the pass stopped was not answered, so it stays
  // for a later pass rather than count as passed over.
  replies.push(...await inTurns(askAlone, options.maxBatches, options.shouldContinue, (candidate) => ask([candidate])));

  let attempted = 0;
  const rows: SummaryRow[] = [];
  for (const { batch, reply } of replies) {
    if (reply === null) {
      result.failed = true;
      continue;
    }
    attempted += batch.length;
    const summaries = parseSummaryReply(reply, batch.length);
    const gaps = summaries.size < batch.length ? describeReplyGaps(reply, batch.length) : null;
    if (gaps) logReplyGaps(projectId, batch, gaps);
    batch.forEach((candidate, position) => {
      const summary = summaries.get(position);
      if (!summary) {
        result.unanswered.push(candidate.input.taskId);
        return;
      }
      rows.push({
        taskId: candidate.input.taskId,
        summary,
        inputHash: candidate.hash,
        agent: writer.agent,
        model: writer.model,
        effort: writer.effort,
        createdAt: deps.now(),
      });
    });
  }
  if (rows.length > 0) {
    try {
      result.written = await deps.store.save(projectId, rows);
    } catch (error) {
      console.warn('[retrieval] summaries failed to save:', error);
      result.failed = true;
    }
  }
  // A failed call holds every project back only while no batch of the pass came
  // back labelled, the same proof the retry above reads: a call that throws
  // beside a login or quota message says the agent itself is failing. One call
  // failing beside one that answered says the agent works (a timeout, or one
  // batch's input), so this project backs off alone and the rest go on.
  result.callFailed = !writerAnswered && outcomes.some((outcome) => outcome.reply === null);
  result.remaining = stale.length - attempted;
  return result;
}
