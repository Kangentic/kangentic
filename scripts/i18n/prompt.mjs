/**
 * What the harness sends a translation engine: one system prompt per language,
 * and a JSON list of strings with their context. Every engine that takes
 * instructions gets the same prompt; only TranslateGemma, which takes no
 * instructions, has its own (engines/openai-compatible.mjs).
 */
import { categoryExamples, isPluralChoice, pluralType, referenceForm } from './messages.mjs';
import { firstOriginFile } from './context.mjs';

/** Language names a model reads best, for the locales whose Intl name is ambiguous. */
const LANGUAGE_NAMES = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese (Taiwan)',
  'pt-BR': 'Brazilian Portuguese',
};

export function languageName(locale) {
  return LANGUAGE_NAMES[locale] ?? new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
}

/** The reply every engine returns, as JSON Schema (Claude's `--json-schema`, an OpenAI-style `response_format`). */
export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          text: { type: 'string' },
          forms: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

export function systemPrompt(locale) {
  const language = languageName(locale);
  return [
    `You translate the user interface of Kangentic, a desktop app where developers run AI coding agents as tasks on a kanban board, from English into ${language} (${locale}).`,
    '',
    'The user message is a JSON list of UI strings. Reply with JSON only: {"translations": [...]}, one entry per item, with the item\'s "key". An item with "text" gets {"key", "text"}. An item with "forms" gets {"key", "forms"} holding every key listed in its "write".',
    '',
    'Rules:',
    '1. A token like {1} stands for a value the app fills in, and "legend" says what it is. Write the token itself, never what it stands for, as many times as the English has it. Move it wherever the grammar needs it. In "forms", the token for the number may be added to a form whose English leaves it out.',
    '2. Tags like <0> and </0> wrap words that become a link or bold text. Keep each pair, around the words that mean the same thing.',
    '3. Plain text only: no braces except tokens, no quotes around the whole string, no notes or alternatives.',
    '4. "forms" holds one English sentence per plural category, and "write" lists the categories this language needs. Write the whole sentence for each, correct for the numbers in "examples". A key like =0 is that exact number. A category the English lacks translates the English "other" sentence.',
    '5. "glossary": keep each "keep" name exactly as written, and use the given word for each "terms" entry, inflected as the sentence needs.',
    `6. Write the concise, neutral register of ${language} software, as VS Code reads in ${language}. Buttons and menu items are short commands. Follow ${language} capitalization conventions, not the English title case. Do not add or drop meaning, and stay about as long as the English.`,
    '7. "widthLimit" means the text must fit on one line of that many columns, where a CJK character takes two. Shorten the wording if needed.',
    '8. "context", "comment", "file" and "nearby" say where the string appears, and "nearby" shows strings next to it with translations already chosen, so match their terms. "previous" is an earlier version of this string with its translation: keep its wording wherever the meaning is unchanged.',
    '9. "problems" lists what was wrong with your last answer for this item. Fix every one.',
  ].join('\n');
}

/**
 * One item of the user message.
 *
 * - `prepared`: from `prepareMessage`.
 * - `keys`: the forms to write, from `targetKeys` (a choice message only).
 * - `message`: the catalog message (context, extracted comments, origin).
 * - `neighbours`, `hint`, `glossaryTerms`, `budget`, `problems`: context, any may be empty.
 */
export function requestItem({ key, prepared, keys, locale, message, neighbours, hint, glossaryTerms, budget, problems }) {
  const item = { key };
  if (prepared.kind === 'text') {
    item.text = prepared.text;
  } else {
    item.forms = prepared.forms;
    item.write = keys;
    const examples = categoryExamples(locale, pluralType(prepared));
    if (isPluralChoice(prepared)) item.examples = Object.fromEntries(keys.filter((formKey) => !formKey.startsWith('=')).map((formKey) => [formKey, examples[formKey] ?? []]));
    const borrowed = keys.filter((formKey) => !(formKey in prepared.forms));
    if (borrowed.length > 0) item.englishFor = Object.fromEntries(borrowed.map((formKey) => [formKey, referenceForm(prepared, formKey)]));
  }
  if (prepared.tokens.length > 0) item.legend = Object.fromEntries(prepared.tokens.map((token) => [`{${token.id}}`, token.meaning]));
  if (message.context) item.context = message.context;
  if (message.comments?.length) item.comment = message.comments.join(' ');
  const file = firstOriginFile(message);
  if (file) item.file = file;
  if (neighbours?.length) item.nearby = neighbours;
  if (hint) item.previous = hint;
  if (glossaryTerms && (glossaryTerms.kept.length > 0 || glossaryTerms.fixed.length > 0)) {
    item.glossary = {};
    if (glossaryTerms.kept.length > 0) item.glossary.keep = glossaryTerms.kept;
    if (glossaryTerms.fixed.length > 0) item.glossary.terms = glossaryTerms.fixed.map((term) => ({ english: term.english, use: term.term }));
  }
  if (budget !== null && budget !== undefined) item.widthLimit = budget;
  if (problems?.length) item.problems = problems;
  return item;
}

export function userPrompt(items) {
  return JSON.stringify(items, null, 1);
}

/**
 * The replies in an engine's JSON answer, by key. Throws when the answer is not
 * the reply shape, so the engine call counts as failed for every item.
 */
export function readReplies(answer) {
  const parsed = typeof answer === 'string' ? JSON.parse(answer) : answer;
  if (!parsed || !Array.isArray(parsed.translations)) throw new Error('the reply has no "translations" list');
  const replies = new Map();
  for (const entry of parsed.translations) {
    if (entry && typeof entry.key === 'string') replies.set(entry.key, entry);
  }
  return replies;
}
