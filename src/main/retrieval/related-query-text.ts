/**
 * The text a related-work search runs on: the question's content words, and
 * the texts its query vectors are embedded from.
 *
 * Pure, and kept apart from `related-work.ts` because both processes need it:
 * main embeds `relatedQueryTexts` before it calls the retrieval worker (only
 * main embeds), and the worker's search reads the same words for its keyword
 * query. One definition keeps the texts main embeds and the texts the search
 * asks for identical.
 */

/**
 * Words that shape a question without saying what it is about. Removed before
 * the keyword search and the content-word embedding, or "most", "tasks" and
 * "touched" would match every conversation in the index.
 */
const QUESTION_WORDS = new Set((
  'a an and are as at be been being but by can could did do does doing done for from had has have how i if in '
  + 'into is it its me most my no not of on or our so than that the their them then there these they this those '
  + 'to was we were what when where which who why will with would you your task tasks work worked related relate '
  + 'about any all many much times time ever more some touched touch change changed changes spend spent cost '
  + 'costs expensive cheapest longest biggest largest used took take show list find tell give'
).split(' '));

/** The words a question is about, lower-cased, in order, without duplicates. */
export function contentWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !QUESTION_WORDS.has(word));
  return [...new Set(words)];
}

/**
 * What the question is embedded as: the question itself, and its content words
 * with the earlier questions' (so a follow-up searches the same subject).
 */
export function relatedQueryTexts(question: string, anchorQuestions: ReadonlyArray<string>): string[] {
  const topic = contentWords(`${question} ${anchorQuestions.join(' ')}`).join(' ');
  return [question.trim(), topic].filter((text, index, all) => text && all.indexOf(text) === index);
}
