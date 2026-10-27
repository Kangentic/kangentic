/**
 * The translation pipeline for one locale, independent of the engine and of
 * where the messages come from (a PO catalog, or the bake-off sample).
 *
 * Each message is masked (messages.mjs), sent with its context in batches of
 * messages from the same source file, and validated (validate.mjs). A failed
 * result goes back to the engine with its problems, up to `maxRetries` more
 * times. One that still fails is flagged and stays untranslated, so the UI shows
 * its English rather than a broken sentence.
 */
import PQueue from 'p-queue';
import { prepareMessage, targetKeys } from './messages.mjs';
import { validateReply } from './validate.mjs';
import { relevantTerms } from './glossary.mjs';
import { findHint, firstOriginFile, neighbourMessages } from './context.mjs';
import { requestItem } from './prompt.mjs';

export const DEFAULT_MAX_RETRIES = 2;

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * Translate `entries` into `locale`.
 *
 * - `entries`: `[{ id, message }]`, the catalog messages to translate.
 * - `allMessages`: the whole catalog, for neighbours.
 * - `engine.translateBatch({ locale, items })` resolves `{ replies: Map<key, reply>, usage }`.
 * - `budgetFor(message)`: the message's one-line budget in columns, or null.
 * - `readSource(file)`: a source file's text, for neighbours.
 * - `removed`: base-branch entries for the reworded-string hint, or null.
 *
 * Resolves `{ outcomes, usage }`. `outcomes` maps each id to
 * `{ status, attempts, icu?, errors, firstErrors, lastReply? }`, where status is
 * `translated`, `flagged`, `manual` (left for a person) or `invalid-source` (the
 * English is not valid ICU, which extraction would have caught). `firstErrors` is
 * what the first attempt got wrong, empty when it passed.
 */
export async function translateEntries({
  locale,
  entries,
  allMessages,
  engine,
  glossary,
  budgetFor,
  widthOfCodepoint,
  readSource,
  removed = null,
  maxRetries = DEFAULT_MAX_RETRIES,
  batchSize = 30,
  concurrency = 1,
  onBatchDone = () => {},
}) {
  const outcomes = new Map();
  const usage = { calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
  const work = [];
  for (const { id, message } of entries) {
    let prepared;
    try {
      prepared = prepareMessage(message.message ?? '');
    } catch (error) {
      outcomes.set(id, { status: 'invalid-source', attempts: 0, errors: [error instanceof Error ? error.message : String(error)] });
      continue;
    }
    if (prepared.kind === 'manual') {
      outcomes.set(id, { status: 'manual', attempts: 0, errors: [prepared.reason] });
      continue;
    }
    const visibleEnglish = prepared.kind === 'text' ? prepared.text : Object.values(prepared.forms).join('\n');
    work.push({
      id,
      message,
      prepared,
      keys: targetKeys(prepared, locale),
      budget: budgetFor(message),
      glossaryTerms: relevantTerms(visibleEnglish, locale, glossary),
      neighbours: neighbourMessages(id, allMessages, readSource),
      hint: removed ? findHint(message, removed) : null,
    });
  }

  const byFile = new Map();
  for (const item of work) {
    const file = firstOriginFile(item.message) ?? '';
    byFile.set(file, [...(byFile.get(file) ?? []), item]);
  }
  const batches = [...byFile.values()].flatMap((items) => chunk(items, batchSize));

  const runBatch = async (batch) => {
    let pending = batch.map((item) => ({ item, problems: [], firstErrors: [], attempts: 0, lastReply: undefined }));
    for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt += 1) {
      const keyed = pending.map((entry, index) => ({ ...entry, key: `k${index + 1}` }));
      const items = keyed.map(({ item, key, problems }) => requestItem({
        key,
        prepared: item.prepared,
        keys: item.keys,
        locale,
        message: item.message,
        neighbours: item.neighbours,
        hint: item.hint,
        glossaryTerms: item.glossaryTerms,
        budget: item.budget,
        problems,
      }));
      let replies = new Map();
      let callError = null;
      try {
        const result = await engine.translateBatch({ locale, items });
        replies = result.replies;
        usage.calls += 1;
        usage.inputTokens += result.usage?.inputTokens ?? 0;
        usage.outputTokens += result.usage?.outputTokens ?? 0;
        usage.costUsd += result.usage?.costUsd ?? 0;
        usage.durationMs += result.usage?.durationMs ?? 0;
      } catch (error) {
        usage.failedCalls += 1;
        callError = error instanceof Error ? error.message : String(error);
      }
      const stillPending = [];
      for (const entry of keyed) {
        const attempts = entry.attempts + 1;
        const reply = replies.get(entry.key);
        let verdict;
        if (callError) verdict = { ok: false, errors: [`the engine call failed: ${callError}`] };
        else if (!reply) verdict = { ok: false, errors: ['the reply had no entry for this key'] };
        else verdict = validateReply({ prepared: entry.item.prepared, reply, locale, glossary, budget: entry.item.budget, widthOfCodepoint });
        if (verdict.ok) {
          outcomes.set(entry.item.id, { status: 'translated', attempts, icu: verdict.icu, errors: [], firstErrors: entry.firstErrors });
        } else {
          const firstErrors = attempts === 1 ? verdict.errors : entry.firstErrors;
          stillPending.push({ item: entry.item, problems: verdict.errors, firstErrors, attempts, lastReply: reply ?? entry.lastReply });
        }
      }
      pending = stillPending;
    }
    for (const entry of pending) {
      outcomes.set(entry.item.id, { status: 'flagged', attempts: entry.attempts, errors: entry.problems, firstErrors: entry.firstErrors, lastReply: entry.lastReply });
    }
    onBatchDone({ done: batch.length });
  };

  const queue = new PQueue({ concurrency });
  await Promise.all(batches.map((batch) => queue.add(() => runBatch(batch))));
  return { outcomes, usage };
}
