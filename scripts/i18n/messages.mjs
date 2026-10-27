/**
 * Lingui messages as the translation harness hands them to a model, and the
 * model's reply back as ICU.
 *
 * A model never sees ICU syntax. Every placeholder (`{projectName}`), the plural
 * number (`#`), a formatted argument (`{count, number}`) and a quoted ICU literal
 * (`'{{task_xml}}'`) becomes a numbered token like `{1}`, with a legend saying
 * what each one is. Lingui's `<0>...</0>` element tags are already opaque, so they
 * pass through as written. A message with one plural or select is hoisted into
 * whole sentences, one per category the target language needs, because many
 * languages inflect the words around the number too. Choosing which sentence
 * goes with which number is ICU's job, so the reply is rebuilt into a plural
 * whose every case is a full sentence.
 *
 * A message with two or more plurals or selects is left for a person: hoisting
 * both would multiply the forms, and those messages are rare.
 */
import { parse } from '@messageformat/parser';

/** CLDR's category order, which is how a rebuilt plural lists its cases. */
const CLDR_CATEGORY_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
const CHOICE_TYPES = new Set(['plural', 'selectordinal', 'select']);
/** Lingui's element tags in a message: `<0>`, `</0>`, `<0/>`. */
const ELEMENT_TAG = /<\/?\d+\/?>/g;
/** A model-facing token in masked text. */
const TOKEN = /\{(\d+)\}/g;

/** The plural categories `locale` uses, in CLDR order (zh-CN: other; pl: one, few, many, other). */
export function pluralCategories(locale, type = 'cardinal') {
  const categories = new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories;
  return CLDR_CATEGORY_ORDER.filter((category) => categories.includes(category));
}

/**
 * A few numbers that fall in each of `locale`'s categories, so a model knows what
 * `few` or `many` means in that language. French, Spanish, Italian and Portuguese
 * reach `many` only at a million, and Czech only on decimals, so those are probed
 * after the small integers.
 */
export function categoryExamples(locale, type = 'cardinal') {
  const rules = new Intl.PluralRules(locale, { type });
  const examples = {};
  const add = (number) => {
    const category = rules.select(number);
    examples[category] ??= [];
    if (examples[category].length < 4 && !examples[category].includes(number)) examples[category].push(number);
  };
  for (let number = 0; number <= 200; number += 1) add(number);
  for (const number of [1000000, 2000000, 0.5, 1.5, 2.5]) {
    if (!examples[rules.select(number)]) add(number);
  }
  return examples;
}

function isChoice(token) {
  return CHOICE_TYPES.has(token.type);
}

function countChoices(tokens) {
  let count = 0;
  for (const token of tokens) {
    if (isChoice(token)) {
      count += 1;
      for (const choiceCase of token.cases) count += countChoices(choiceCase.tokens);
    }
  }
  return count;
}

/** ICU text for a literal that holds braces or `#`: quoted, with its own apostrophes doubled. */
export function quoteLiteral(text) {
  return `'${text.replace(/'/g, "''")}'`;
}

/** The ICU source of a formatted argument such as `{count, number}`. */
function functionSource(token) {
  const parameter = token.param ? token.param.map((part) => (part.type === 'content' ? part.value : '')).join('') : '';
  return parameter ? `{${token.arg}, ${token.key}, ${parameter.trim()}}` : `{${token.arg}, ${token.key}}`;
}

/** Numbered tokens for one message, shared by all its forms: the same source gets the same number. */
class TokenTable {
  constructor() {
    this.byRaw = new Map();
    this.entries = [];
  }

  add(raw, meaning) {
    const existing = this.byRaw.get(raw);
    if (existing) return existing.id;
    const entry = { id: this.entries.length + 1, raw, meaning };
    this.byRaw.set(raw, entry);
    this.entries.push(entry);
    return entry.id;
  }
}

/** Mask the literal runs of one content value: a word holding a brace, or `#` inside a plural. */
function maskContent(value, tokenTable, inPlural) {
  const special = inPlural ? /\S*[{}#]\S*/g : /\S*[{}]\S*/g;
  return value.replace(special, (run) => `{${tokenTable.add(quoteLiteral(run), `the literal text ${run}`)}}`);
}

function maskTokens(tokens, tokenTable, inPlural) {
  return tokens.map((token) => {
    switch (token.type) {
      case 'content':
        return maskContent(token.value, tokenTable, inPlural);
      case 'argument':
        return `{${tokenTable.add(`{${token.arg}}`, `placeholder "${token.arg}"`)}}`;
      case 'function':
        return `{${tokenTable.add(functionSource(token), `formatted value "${token.arg}"`)}}`;
      case 'octothorpe':
        return `{${tokenTable.add('#', 'the number')}}`;
      default:
        throw new Error(`Unexpected nested ${token.type} in a hoisted message`);
    }
  }).join('');
}

/**
 * What a model is asked to translate for one Lingui message.
 *
 * - `{ kind: 'text', text, tokens }` for a message with no plural or select.
 * - `{ kind: 'choice', choiceType, argument, offset, forms, tokens }` for one with
 *   exactly one, where `forms` maps each source case key (`one`, `other`, `=0`,
 *   `male`) to its whole sentence.
 * - `{ kind: 'manual', reason }` for one the harness leaves to a person.
 *
 * Throws when `message` is not valid ICU.
 */
export function prepareMessage(message) {
  const ast = parse(message);
  if (countChoices(ast) > 1) return { kind: 'manual', reason: 'more than one plural or select' };
  const tokenTable = new TokenTable();
  const choiceIndex = ast.findIndex(isChoice);
  if (choiceIndex === -1) {
    return { kind: 'text', text: maskTokens(ast, tokenTable, false), tokens: tokenTable.entries };
  }
  const choice = ast[choiceIndex];
  const prefix = ast.slice(0, choiceIndex);
  const suffix = ast.slice(choiceIndex + 1);
  const inPlural = choice.type !== 'select';
  // A plural always offers the number, even when its English never shows it
  // ("Conflicts detected"): Russian and Polish often write "3 конфликта" where
  // English has none, and without a token a model invents one.
  if (inPlural) tokenTable.add('#', 'the number');
  const forms = {};
  for (const choiceCase of choice.cases) {
    forms[choiceCase.key] = maskTokens([...prefix, ...choiceCase.tokens, ...suffix], tokenTable, inPlural);
  }
  return {
    kind: 'choice',
    choiceType: choice.type,
    argument: choice.arg,
    offset: choice.pluralOffset,
    forms,
    tokens: tokenTable.entries,
  };
}

/**
 * The case keys a translation of `prepared` must fill in `locale`: the source's
 * exact keys (`=0`) plus every category the language uses for a plural, or the
 * source's own keys for a select.
 */
export function targetKeys(prepared, locale) {
  if (prepared.kind !== 'choice') return [];
  const sourceKeys = Object.keys(prepared.forms);
  if (prepared.choiceType === 'select') return sourceKeys;
  const exactKeys = sourceKeys.filter((key) => key.startsWith('='));
  const type = prepared.choiceType === 'selectordinal' ? 'ordinal' : 'cardinal';
  return [...exactKeys, ...pluralCategories(locale, type)];
}

/** The English sentence a target case is translated from: the same key, else `other`. */
export function referenceForm(prepared, key) {
  return prepared.forms[key] ?? prepared.forms.other;
}

/** The pieces of masked text: `{ kind: 'text' | 'token' | 'tag', value }` in order. */
export function splitMasked(masked) {
  const pieces = [];
  const pattern = new RegExp(`${TOKEN.source}|${ELEMENT_TAG.source}`, 'g');
  let lastIndex = 0;
  for (const match of masked.matchAll(pattern)) {
    if (match.index > lastIndex) pieces.push({ kind: 'text', value: masked.slice(lastIndex, match.index) });
    pieces.push(match[1] !== undefined ? { kind: 'token', value: Number(match[1]) } : { kind: 'tag', value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < masked.length) pieces.push({ kind: 'text', value: masked.slice(lastIndex) });
  return pieces;
}

/**
 * Escape a run of translated text for ICU. A brace is never allowed in it (the
 * validator rejects one first). An apostrophe is doubled where ICU would read it
 * as the start of a quote: before a brace, another apostrophe, or `#` in a plural,
 * including the first character of whatever follows the run.
 */
function escapeText(text, nextRaw, inPlural) {
  const quoteOpeners = inPlural ? "{}'#" : "{}'";
  let escaped = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = index + 1 < text.length ? text[index + 1] : nextRaw.charAt(0);
    escaped += character === "'" && quoteOpeners.includes(nextCharacter) ? "''" : character;
  }
  return escaped;
}

/**
 * Turn one masked translation back into ICU text. Throws on a token number the
 * message never had; the validator checks everything else first.
 */
export function restoreForm(masked, tokens, inPlural) {
  const byId = new Map(tokens.map((token) => [token.id, token]));
  const pieces = splitMasked(masked);
  const raws = pieces.map((piece) => {
    if (piece.kind === 'tag') return piece.value;
    if (piece.kind === 'token') {
      const token = byId.get(piece.value);
      if (!token) throw new Error(`token {${piece.value}} is not in this message`);
      return token.raw;
    }
    return null;
  });
  return pieces.map((piece, index) => {
    if (piece.kind !== 'text') return raws[index];
    const nextRaw = raws.slice(index + 1).find((raw) => raw !== null) ?? '';
    return escapeText(piece.value, nextRaw, inPlural);
  }).join('');
}

/**
 * The ICU translation for `prepared`: the restored text, or a rebuilt plural or
 * select whose every case is a whole restored sentence. `translation` is a string
 * for a text message and a `{ key: masked }` map for a choice.
 */
export function buildIcu(prepared, translation, keys) {
  if (prepared.kind === 'text') return restoreForm(translation, prepared.tokens, false);
  const inPlural = prepared.choiceType !== 'select';
  const offset = prepared.offset ? `offset:${prepared.offset} ` : '';
  const cases = keys.map((key) => `${key} {${restoreForm(translation[key], prepared.tokens, inPlural)}}`);
  return `{${prepared.argument}, ${prepared.choiceType}, ${offset}${cases.join(' ')}}`;
}
