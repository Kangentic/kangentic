/**
 * Checks on every translation the harness drafts, before it is written. A result
 * that fails goes back to the engine with the errors (see translate-catalog.mjs),
 * and one that still fails is left untranslated and reported. An invalid
 * translation is never written: a broken ICU message fails the catalog compile,
 * and a lost placeholder shows the user a sentence with a hole in it.
 */
import { parse } from '@messageformat/parser';
import { compileMessageOrThrow } from '@lingui/message-utils/compileMessage';
import { buildIcu, pluralCategories, referenceForm, splitMasked, targetKeys } from './messages.mjs';
import { glossaryErrors } from './glossary.mjs';

/** The number token's ids in a message (`#` inside a plural). */
function numberTokenIds(tokens) {
  return new Set(tokens.filter((token) => token.raw === '#').map((token) => token.id));
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function sameCounts(left, right) {
  if (left.size !== right.size) return false;
  for (const [value, count] of left) if (right.get(value) !== count) return false;
  return true;
}

/** Whether a form's element tags open and close in nested order. */
function tagsNest(tags) {
  const open = [];
  for (const tag of tags) {
    if (/^<\d+\/>$/.test(tag)) continue;
    const closing = tag.startsWith('</');
    const name = tag.replace(/[</>]/g, '');
    if (!closing) open.push(name);
    else if (open.pop() !== name) return false;
  }
  return open.length === 0;
}

/**
 * Errors in one masked form against the English sentence it translates: tokens
 * and tags must round-trip, and no ICU syntax may appear outside a token. The
 * number may be added to a form whose English has none ("one task" can read "1
 * task"), but never dropped.
 */
export function formErrors({ reference, translated, tokens, inPlural, label }) {
  const errors = [];
  const where = label ? ` in the "${label}" form` : '';
  const numberIds = numberTokenIds(tokens);
  const knownIds = new Set(tokens.map((token) => token.id));
  const referencePieces = splitMasked(reference);
  const translatedPieces = splitMasked(translated);
  const placeholders = (pieces) => pieces.filter((piece) => piece.kind === 'token' && !numberIds.has(piece.value)).map((piece) => piece.value);
  const tags = (pieces) => pieces.filter((piece) => piece.kind === 'tag').map((piece) => piece.value);

  for (const piece of translatedPieces) {
    if (piece.kind === 'token' && !knownIds.has(piece.value)) errors.push(`{${piece.value}} is not a token of this message${where}`);
    if (piece.kind === 'text' && /[{}]/.test(piece.value)) errors.push(`a brace outside a token${where}; keep only the {N} tokens`);
    if (piece.kind === 'text' && inPlural && piece.value.includes('#')) errors.push(`a "#" outside a token${where}; write the number as its token`);
  }
  if (!sameCounts(countBy(placeholders(referencePieces)), countBy(placeholders(translatedPieces)))) {
    const expected = placeholders(referencePieces).map((id) => `{${id}}`).join(' ') || 'none';
    errors.push(`the tokens must be exactly ${expected}${where}`);
  }
  const referenceHasNumber = referencePieces.some((piece) => piece.kind === 'token' && numberIds.has(piece.value));
  const translatedHasNumber = translatedPieces.some((piece) => piece.kind === 'token' && numberIds.has(piece.value));
  if (referenceHasNumber && !translatedHasNumber) errors.push(`the number token is missing${where}`);
  const referenceTags = tags(referencePieces);
  const translatedTags = tags(translatedPieces);
  if (!sameCounts(countBy(referenceTags), countBy(translatedTags))) {
    errors.push(`the tags must be exactly ${referenceTags.join(' ') || 'none'}${where}`);
  } else if (!tagsNest(translatedTags)) {
    errors.push(`the tags must open and close in order${where}`);
  }
  return errors;
}

/** Display width with East Asian wide characters counted as two columns. */
export function displayWidthOf(text, widthOfCodepoint) {
  let width = 0;
  for (const character of text) width += widthOfCodepoint(character.codePointAt(0));
  return width;
}

/** A form as a reader sees it, for measuring: tokens and tags replaced by a short stand-in. */
function visibleText(masked) {
  return splitMasked(masked).map((piece) => (piece.kind === 'text' ? piece.value : piece.kind === 'token' ? 'xxxx' : '')).join('');
}

/**
 * Validate one engine reply for `prepared`. Returns `{ ok: true, icu }` with the
 * ICU translation to write, or `{ ok: false, errors }` with messages written for
 * the engine to fix on a retry.
 *
 * - `reply`: `{ text }` for a text message, `{ forms: { key: text } }` for a choice.
 * - `budget`: the description's one-line budget in columns, or null.
 * - `widthOfCodepoint`: `wcwidthV11` (src/shared/xterm-unicode11.ts).
 *
 * The glossary is checked against each form's masked English, so a placeholder
 * named `{branch}` never reads as the word "branch".
 */
export function validateReply({ prepared, reply, locale, glossary, budget, widthOfCodepoint }) {
  const errors = [];
  const keys = targetKeys(prepared, locale);
  /** @type {Array<{ label: string | null, reference: string, translated: string }>} */
  const forms = [];
  if (prepared.kind === 'text') {
    if (typeof reply?.text !== 'string' || reply.text.trim() === '') return { ok: false, errors: ['the reply has no "text"'] };
    forms.push({ label: null, reference: prepared.text, translated: reply.text });
  } else {
    const replied = reply?.forms ?? {};
    const missing = keys.filter((key) => typeof replied[key] !== 'string' || replied[key].trim() === '');
    if (missing.length > 0) return { ok: false, errors: [`the reply is missing the forms ${missing.join(', ')}`] };
    for (const key of keys) forms.push({ label: key, reference: referenceForm(prepared, key), translated: replied[key] });
  }

  const inPlural = prepared.kind === 'choice' && prepared.choiceType !== 'select';
  for (const form of forms) {
    errors.push(...formErrors({ ...form, tokens: prepared.tokens, inPlural }));
    errors.push(...glossaryErrors({ english: form.reference, translated: form.translated, locale, glossary, label: form.label }));
    if (budget !== null && budget !== undefined) {
      const width = displayWidthOf(visibleText(form.translated), widthOfCodepoint);
      if (width > budget) {
        errors.push(`it is ${width} columns wide, over this description's one-line budget of ${budget} (a wide CJK character counts two)`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  let icu;
  try {
    icu = buildIcu(prepared, prepared.kind === 'text' ? reply.text : reply.forms, keys);
    compileMessageOrThrow(icu);
    const type = prepared.kind === 'choice' && prepared.choiceType === 'selectordinal' ? 'ordinal' : 'cardinal';
    parse(icu, type === 'ordinal' ? { ordinal: pluralCategories(locale, 'ordinal') } : { cardinal: pluralCategories(locale) });
  } catch (error) {
    return { ok: false, errors: [`the rebuilt message is not valid ICU: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return { ok: true, icu };
}
