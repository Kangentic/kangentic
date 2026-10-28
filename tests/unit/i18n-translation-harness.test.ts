import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupI18n } from '@lingui/core';
import { makeConfig } from '@lingui/conf';
import { getCatalogs } from '@lingui/cli/api';
import { formatter } from '@lingui/format-po';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import { generateMessageId } from '@lingui/message-utils/generateMessageId';
import { wcwidthV11 } from '../../src/shared/xterm-unicode11';
import {
  buildIcu, categoryExamples, pluralCategories, prepareMessage, restoreForm, targetKeys,
} from '../../scripts/i18n/messages.mjs';
import { formErrors, validateReply } from '../../scripts/i18n/validate.mjs';
import { glossaryErrors, loadGlossary, relevantTerms } from '../../scripts/i18n/glossary.mjs';
import {
  applyMachineTranslation, applyOutcomes, hasReviewMark, REVIEW_FLAG, selectEntryIds, sharedTranslations,
} from '../../scripts/i18n/catalogs.mjs';
import { createNeighbourFinder, findHint, neighbourMessages, removedEntries } from '../../scripts/i18n/context.mjs';
import { readReplies, requestItem } from '../../scripts/i18n/prompt.mjs';
import { translateEntries } from '../../scripts/i18n/translate-catalog.mjs';
import { parseArgs as parseTranslateArgs } from '../../scripts/i18n/translate.mjs';
import { claudeArgs, claudeEnv } from '../../scripts/i18n/engines/claude.mjs';
import { REFILL_MODEL, translateGemmaPrompt } from '../../scripts/i18n/engines/openai-compatible.mjs';
import {
  errorCategory, formatResults, loadArms, loadSample, parseArgs as parseBakeOffArgs, scoreRecords, WINNER_RULE,
} from '../../scripts/i18n/bake-off/run.mjs';

// The translation harness (scripts/i18n/, docs/contributing/translations.md). Engines
// are never called here: the pipeline runs against a fake one, and catalogs are
// fixture files under the OS temp folder, so nothing touches src/locales.

const EMPTY_GLOSSARY = { keep: [], terms: [] };

/** Render a compiled ICU translation in `locale`, the way the app does. */
function render(locale: string, icu: string, values: Record<string, unknown>): string {
  const i18n = setupI18n({ locale, messages: { [locale]: { message: compileMessage(icu) } } });
  return i18n._('message', values);
}

/** `validateReply` with the defaults most checks share: German, no glossary, no width budget. */
function validateWith(prepared: unknown, reply: unknown, overrides: Record<string, unknown> = {}) {
  return validateReply({
    prepared, reply, locale: 'de', glossary: EMPTY_GLOSSARY, budget: null, widthOfCodepoint: wcwidthV11, ...overrides,
  });
}

type CatalogMessage = { message: string; translation: string; origin: Array<Array<string | null>> };
type EngineItem = { key: string; text?: string; previous?: { english: string; translation: string }; problems?: string[] };
type EngineReply = { key: string; text: string };
type EngineUsage = { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number };
type FakeEngine = {
  translateBatch: (request: { locale: string; items: EngineItem[] }) => Promise<{ replies: Map<string, EngineReply>; usage: EngineUsage }>;
};

const NO_USAGE: EngineUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };

/** A catalog message that lives in `file`. */
function catalogMessage(message: string, file: string): CatalogMessage {
  return { message, translation: '', origin: [[file, null]] };
}

/** Replies to every item with its own masked English, which always passes validation. */
function echoReplies(items: EngineItem[]): Map<string, EngineReply> {
  return new Map(items.map((item): [string, EngineReply] => [item.key, { key: item.key, text: item.text ?? '' }]));
}

/** An engine that echoes every item back, and records the items of each call. */
function echoEngine(calls: EngineItem[][]): FakeEngine {
  return {
    async translateBatch({ items }) {
      calls.push(items);
      return { replies: echoReplies(items), usage: NO_USAGE };
    },
  };
}

/** `translateEntries` into German over every message of a catalog, with the defaults a test rarely changes. */
function runPipeline(messages: Record<string, CatalogMessage>, engine: FakeEngine, overrides: Record<string, unknown> = {}) {
  return translateEntries({
    locale: 'de',
    entries: Object.entries(messages).map(([id, message]) => ({ id, message })),
    allMessages: messages,
    engine,
    glossary: EMPTY_GLOSSARY,
    budgetFor: () => null,
    widthOfCodepoint: wcwidthV11,
    readSource: () => null,
    ...overrides,
  });
}

describe('masking and rebuilding messages', () => {
  it('masks placeholders as numbered tokens and keeps element tags as written', () => {
    const prepared = prepareMessage('Open <0>{projectName}</0> settings');
    expect(prepared.kind).toBe('text');
    expect(prepared.text).toBe('Open <0>{1}</0> settings');
    expect(prepared.tokens).toEqual([{ id: 1, raw: '{projectName}', meaning: 'placeholder "projectName"' }]);
    expect(restoreForm('<0>{1}</0> Einstellungen öffnen', prepared.tokens, false)).toBe('<0>{projectName}</0> Einstellungen öffnen');
  });

  it('masks a quoted ICU literal and restores it quoted, so it still renders as text', () => {
    const prepared = prepareMessage("Insert '{{task_xml}}' here");
    expect(prepared.text).toBe('Insert {1} here');
    const icu = restoreForm('{1} hier einfügen', prepared.tokens, false);
    expect(render('de', icu, {})).toBe('{{task_xml}} hier einfügen');
  });

  it('doubles an apostrophe that would otherwise open an ICU quote', () => {
    const prepared = prepareMessage('Open {column}');
    const icu = restoreForm("Ouvrir l'{1}", prepared.tokens, false);
    expect(render('fr', icu, { column: 'Done' })).toBe("Ouvrir l'Done");
    expect(render('fr', restoreForm("C'est {1}", prepared.tokens, false), { column: 'ok' })).toBe("C'est ok");
  });

  it('hoists a plural into whole sentences and rebuilds every category the language needs', () => {
    const prepared = prepareMessage('Moved {count, plural, one {# task} other {# tasks}} to {column}');
    expect(prepared.kind).toBe('choice');
    expect(prepared.forms).toEqual({ one: 'Moved {1} task to {2}', other: 'Moved {1} tasks to {2}' });
    const keys = targetKeys(prepared, 'pl');
    expect(keys).toEqual(['one', 'few', 'many', 'other']);
    const icu = buildIcu(prepared, {
      one: 'Przeniesiono {1} zadanie do {2}',
      few: 'Przeniesiono {1} zadania do {2}',
      many: 'Przeniesiono {1} zadań do {2}',
      other: 'Przeniesiono {1} zadania do {2}',
    }, keys);
    expect(render('pl', icu, { count: 1, column: 'Gotowe' })).toBe('Przeniesiono 1 zadanie do Gotowe');
    expect(render('pl', icu, { count: 3, column: 'Gotowe' })).toBe('Przeniesiono 3 zadania do Gotowe');
    expect(render('pl', icu, { count: 5, column: 'Gotowe' })).toBe('Przeniesiono 5 zadań do Gotowe');
  });

  it('knows each language plural categories and keeps exact-number cases', () => {
    expect(pluralCategories('zh-CN')).toEqual(['other']);
    expect(pluralCategories('de')).toEqual(['one', 'other']);
    expect(pluralCategories('ru')).toEqual(['one', 'few', 'many', 'other']);
    expect(pluralCategories('pl')).toEqual(['one', 'few', 'many', 'other']);
    expect(categoryExamples('pl').few).toContain(2);
    const withZero = prepareMessage('{count, plural, =0 {No tasks} one {# task} other {# tasks}}');
    expect(targetKeys(withZero, 'ja')).toEqual(['=0', 'other']);
  });

  it('offers the number in a plural whose English never shows it, so a form may add it', () => {
    const prepared = prepareMessage('{count, plural, one {Conflict detected} other {Conflicts detected}}');
    expect(prepared.tokens).toEqual([{ id: 1, raw: '#', meaning: 'the number' }]);
    const verdict = validateReply({
      prepared,
      reply: { forms: { one: 'Обнаружен конфликт', few: 'Обнаружено {1} конфликта', many: 'Обнаружено {1} конфликтов', other: 'Обнаружено {1} конфликта' } },
      locale: 'ru', glossary: EMPTY_GLOSSARY, budget: null, widthOfCodepoint: wcwidthV11,
    });
    expect(verdict.ok).toBe(true);
    expect(render('ru', verdict.icu, { count: 5 })).toBe('Обнаружено 5 конфликтов');
  });

  it('describes a quoted literal without inviting the model to write it out', () => {
    expect(prepareMessage("Use '{{cwd}}' here").tokens).toEqual([{ id: 1, raw: "'{{cwd}}'", meaning: 'the literal text {{cwd}}' }]);
  });

  it('leaves a message with two plurals for a person', () => {
    const prepared = prepareMessage('{tasks, plural, one {# task} other {# tasks}} in {columns, plural, one {# column} other {# columns}}');
    expect(prepared).toEqual({ kind: 'manual', reason: 'more than one plural or select' });
  });
});

describe('validation', () => {
  const textMessage = prepareMessage('Delete {taskTitle}? <0>Undo</0> is not possible.');
  const validate = (reply: unknown, overrides: Record<string, unknown> = {}) => validateReply({
    prepared: textMessage, reply, locale: 'de', glossary: EMPTY_GLOSSARY, budget: null, widthOfCodepoint: wcwidthV11, ...overrides,
  });

  it('accepts a translation whose tokens and tags round-trip, and returns its ICU', () => {
    const verdict = validate({ text: '{1} löschen? <0>Rückgängig</0> ist nicht möglich.' });
    expect(verdict).toEqual({ ok: true, icu: '{taskTitle} löschen? <0>Rückgängig</0> ist nicht möglich.' });
  });

  it('rejects a lost token, an unknown token, a stray brace and broken tags', () => {
    expect(validate({ text: 'Löschen? <0>Rückgängig</0>.' }).errors).toContain('the tokens must be exactly {1}');
    expect(validate({ text: '{2} löschen? <0>x</0>' }).errors).toContain('{2} is not a token of this message');
    expect(validate({ text: '{1} {löschen}? <0>x</0>' }).errors.join(' ')).toMatch(/a brace outside a token/);
    expect(validate({ text: '{1} löschen? Rückgängig' }).errors).toContain('the tags must be exactly <0> </0>');
    expect(validate({ text: '{1} löschen? </0>x<0>' }).errors).toContain('the tags must open and close in order');
  });

  it('never drops the number from a plural form, but lets a form add it', () => {
    const prepared = prepareMessage('{count, plural, one {One task} other {# tasks}}');
    const noNumber = formErrors({ reference: prepared.forms.other, translated: 'Aufgaben', tokens: prepared.tokens, inPlural: true, label: 'other' });
    expect(noNumber).toContain('the number token is missing in the "other" form');
    const addedNumber = formErrors({ reference: prepared.forms.one, translated: '{1} Aufgabe', tokens: prepared.tokens, inPlural: true, label: 'one' });
    expect(addedNumber).toEqual([]);
  });

  it('asks for every form the target language needs', () => {
    const prepared = prepareMessage('{count, plural, one {# task} other {# tasks}}');
    const verdict = validateReply({
      prepared, reply: { forms: { one: '{1} zadanie', other: '{1} zadania' } }, locale: 'pl', glossary: EMPTY_GLOSSARY, budget: null, widthOfCodepoint: wcwidthV11,
    });
    expect(verdict.errors).toEqual(['the reply is missing the forms few, many']);
  });

  it('counts a CJK character as two columns against a description budget', () => {
    const prepared = prepareMessage('Applies after a restart.');
    const check = (text: string) => validateReply({ prepared, reply: { text }, locale: 'zh-CN', glossary: EMPTY_GLOSSARY, budget: 60, widthOfCodepoint: wcwidthV11 });
    expect(check('重'.repeat(30)).ok).toBe(true);
    expect(check('重'.repeat(31)).errors).toEqual(["it is 62 columns wide, over this description's one-line budget of 60 (a wide CJK character counts two)"]);
  });

  it('rejects an empty, blank or missing text reply with one error', () => {
    const prepared = prepareMessage('Save');
    for (const reply of [{ text: '' }, { text: ' \n\t ' }, {}]) {
      expect(validateWith(prepared, reply).errors).toEqual(['the reply has no "text"']);
    }
  });

  it('surfaces a dropped glossary term through the whole check', () => {
    const glossary = loadGlossary();
    const prepared = prepareMessage('Delete the branch');
    const dropped = validateWith(prepared, { text: 'Zweig löschen' }, { glossary });
    expect(dropped.ok).toBe(false);
    expect(dropped.errors).toContain('translate "branch" as "Branch"');
    expect(validateWith(prepared, { text: 'Branch löschen' }, { glossary })).toEqual({ ok: true, icu: 'Branch löschen' });
  });

  it('asks a select for its own case keys in every language, never for plural categories', () => {
    const prepared = prepareMessage('{gender, select, male {He left} female {She left} other {They left}}');
    for (const locale of ['de', 'ja', 'pl']) expect(targetKeys(prepared, locale)).toEqual(['male', 'female', 'other']);
    const forms = { male: 'Er ging', female: 'Sie ging', other: 'Sie gingen' };
    const verdict = validateWith(prepared, { forms });
    expect(verdict).toEqual({ ok: true, icu: '{gender, select, male {Er ging} female {Sie ging} other {Sie gingen}}' });
    expect(render('de', verdict.icu, { gender: 'female' })).toBe('Sie ging');
    // Polish has four plural categories, and a select must not ask for them.
    expect(validateWith(prepared, { forms }, { locale: 'pl' }).ok).toBe(true);
    expect(validateWith(prepared, { forms: { male: 'Er ging', other: 'Sie gingen' } }).errors).toEqual(['the reply is missing the forms female']);
    expect(validateWith(prepared, { forms: { one: 'Er ging', other: 'Sie gingen' } }).errors).toEqual(['the reply is missing the forms male, female']);
  });

  it('rejects a literal # in a plural form, which ICU would read as the number', () => {
    const prepared = prepareMessage('{count, plural, one {# task} other {# tasks}}');
    const verdict = validateWith(prepared, { forms: { one: '{1} Aufgabe', other: '{1} Aufgaben #' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(['a "#" outside a token in the "other" form; write the number as its token']);
  });

  it('keeps an apostrophe that ends a plural or select case, because the closing brace would read it as a quote', () => {
    const plural = prepareMessage('{count, plural, one {# user} other {# users}}');
    const pluralVerdict = validateWith(plural, { forms: { one: "{1} Nutzer'", other: "{1} Nutzer'" } });
    expect(pluralVerdict.ok).toBe(true);
    expect(render('de', pluralVerdict.icu, { count: 1 })).toBe("1 Nutzer'");
    expect(render('de', pluralVerdict.icu, { count: 5 })).toBe("5 Nutzer'");

    const select = prepareMessage('{gender, select, male {He said bye} female {She said bye} other {They said bye}}');
    const selectVerdict = validateWith(select, { forms: { male: "Er sagte 'Tschüss'", female: "Sie sagte 'Tschüss'", other: "Sie sagten 'Tschüss'" } });
    expect(selectVerdict.ok).toBe(true);
    expect(render('de', selectVerdict.icu, { gender: 'female' })).toBe("Sie sagte 'Tschüss'");
    expect(render('de', selectVerdict.icu, { gender: 'other' })).toBe("Sie sagten 'Tschüss'");
  });

  it('asks for the ordinal categories of a selectordinal, not the cardinal ones', () => {
    const prepared = prepareMessage('{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}');
    expect(prepared.choiceType).toBe('selectordinal');
    expect(targetKeys(prepared, 'en')).toEqual(['one', 'two', 'few', 'other']);
    expect(targetKeys(prepared, 'de')).toEqual(['other']);
    // German cardinals have "one", so a check on the wrong category set would ask for it here.
    const verdict = validateWith(prepared, { forms: { other: '{1}.' } });
    expect(verdict).toEqual({ ok: true, icu: '{place, selectordinal, other {#.}}' });
    expect(render('de', verdict.icu, { place: 3 })).toBe('3.');
  });
});

describe('the glossary', () => {
  const glossary = loadGlossary();

  it('names the kept names and fixed terms a string uses, and ignores a placeholder named like one', () => {
    const terms = relevantTerms('Create a worktree for each branch in Claude Code', 'de', glossary);
    expect(terms.kept).toEqual(expect.arrayContaining(['Claude Code', 'Claude']));
    expect(terms.fixed.map((term: { english: string }) => term.english)).toEqual(['worktree', 'branch']);
    expect(relevantTerms('Rename {1}', 'de', glossary).fixed).toEqual([]);
  });

  it('accepts an inflected fixed term and rejects a dropped name or another word', () => {
    expect(glossaryErrors({ english: 'Delete the branch', translated: 'Usuń gałęzi', locale: 'pl', glossary, label: null })).toEqual([]);
    expect(glossaryErrors({ english: 'Delete the branch', translated: 'Zweig löschen', locale: 'de', glossary, label: null }))
      .toEqual(['translate "branch" as "Branch"']);
    expect(glossaryErrors({ english: 'Ask Claude', translated: 'Спросить Клода', locale: 'ru', glossary, label: null }))
      .toEqual(['keep the name "Claude" exactly as written']);
  });

  const fixedEnglish = (english: string, locale = 'de') => relevantTerms(english, locale, glossary).fixed.map((term: { english: string }) => term.english);

  it('matches a plural or an alias of a fixed term, but not a longer word that starts with it', () => {
    expect(fixedEnglish('Delete the branches')).toEqual(['branch']);
    expect(fixedEnglish('Start branching now')).toEqual([]);
  });

  it('reads a kept name exactly as written and a fixed term in any case', () => {
    expect(relevantTerms('Ask claude', 'de', glossary).kept).toEqual([]);
    expect(relevantTerms('Ask Claude', 'de', glossary).kept).toEqual(['Claude']);
    expect(fixedEnglish('Branch list')).toEqual(['branch']);
  });

  it('triggers a term from its alias, and gives no fixed entry for a language without a translation', () => {
    const entry = { english: 'repository', alsoMatches: ['repo'], note: 'a git repository', translations: { de: 'Repository', pl: { term: 'repozytorium', match: 'repozytor' } } };
    const small = { keep: [], terms: [entry] };
    expect(relevantTerms('Clone the repo', 'de', small).fixed).toEqual([{ english: 'repository', note: 'a git repository', term: 'Repository', match: 'Repository' }]);
    expect(relevantTerms('Clone the repo', 'pl', small).fixed).toEqual([{ english: 'repository', note: 'a git repository', term: 'repozytorium', match: 'repozytor' }]);
    // The alias is what triggers it: without one, "repo" is not the word "repository".
    expect(relevantTerms('Clone the repo', 'de', { keep: [], terms: [{ ...entry, alsoMatches: undefined }] }).fixed).toEqual([]);
    // A language the glossary has no translation for gets no entry, even for the exact word.
    expect(relevantTerms('Clone the repository', 'ja', small).fixed).toEqual([]);
  });

  it('answers the same on every call, and keeps a name and a fixed term of the same spelling apart', () => {
    // The compiled patterns are cached per term and case rule. A cache key without the
    // rule would hand "Branch" the name's case-sensitive pattern; a global-flag pattern
    // would answer true, false, true on repeated calls.
    const clash = { keep: ['Branch'], terms: [{ english: 'Branch', note: 'a git branch', translations: { de: 'Branch' } }] };
    for (let round = 0; round < 3; round += 1) {
      const lowerCase = relevantTerms('the branch list', 'de', clash);
      expect(lowerCase.kept).toEqual([]);
      expect(lowerCase.fixed.map((term: { english: string }) => term.english)).toEqual(['Branch']);
      expect(relevantTerms('The Branch list', 'de', clash).kept).toEqual(['Branch']);
    }
  });
});

describe('which entries the harness touches', () => {
  const messages = {
    empty: { message: 'Save', translation: '' },
    draft: { message: 'Cancel', translation: 'Abbrechen', extra: { flags: [REVIEW_FLAG], translatorComments: [] } },
    reviewed: { message: 'Close', translation: 'Schließen', extra: { flags: [], translatorComments: [] } },
  };

  it('fills empty entries, re-drafts machine drafts only when asked, and never touches a reviewed one', () => {
    expect(selectEntryIds(messages)).toEqual(['empty']);
    expect(selectEntryIds(messages, { redraft: true })).toEqual(['empty', 'draft']);
  });

  it('marks a machine translation for review once', () => {
    const message: { message: string; translation: string; extra?: { flags: string[]; translatorComments: string[] } } = { message: 'Save', translation: '' };
    applyMachineTranslation(message, 'Speichern');
    applyMachineTranslation(message, 'Sichern');
    expect(message.translation).toBe('Sichern');
    expect(message.extra?.flags).toEqual([REVIEW_FLAG]);
    expect(hasReviewMark(message)).toBe(true);
  });

  it('never picks an obsolete entry, drafted or empty, with or without a redraft', () => {
    const withObsolete = {
      ...messages,
      goneEmpty: { message: 'Old', translation: '', obsolete: true },
      goneDraft: { message: 'Older', translation: 'Aelter', obsolete: true, extra: { flags: [REVIEW_FLAG], translatorComments: [] } },
    };
    expect(selectEntryIds(withObsolete)).toEqual(['empty']);
    expect(selectEntryIds(withObsolete, { redraft: true })).toEqual(['empty', 'draft']);
  });

  it('keeps the flags and comments a message already had when it adds the review mark, once', () => {
    const message = { message: 'Save', translation: '', extra: { flags: ['no-wrap'], translatorComments: ['note'] } };
    applyMachineTranslation(message, 'Speichern');
    applyMachineTranslation(message, 'Sichern');
    expect(message.translation).toBe('Sichern');
    expect(message.extra).toEqual({ flags: ['no-wrap', REVIEW_FLAG], translatorComments: ['note'] });
  });

  it('writes only a translated outcome into its message and tallies the rest', () => {
    type CatalogEntry = { message: string; translation: string; extra?: { flags: string[]; translatorComments: string[] } };
    const manualEnglish = '{a, plural, one {#} other {#}} {b, plural, one {#} other {#}}';
    const messages: Record<string, CatalogEntry> = {
      translatedId: { message: 'Save', translation: '' },
      flaggedId: { message: 'Open', translation: '' },
      manualId: { message: manualEnglish, translation: '' },
      invalidId: { message: 'Broken {name', translation: '' },
    };
    const lastReply = { key: 'k1', text: 'Offen' };
    const outcomes = new Map<string, Record<string, unknown>>([
      ['translatedId', { status: 'translated', attempts: 1, icu: 'Speichern', errors: [], firstErrors: [] }],
      ['flaggedId', { status: 'flagged', attempts: 3, errors: ['the tokens must be exactly {1}'], firstErrors: ['x'], lastReply }],
      ['manualId', { status: 'manual', attempts: 0, errors: ['more than one plural or select'] }],
      ['invalidId', { status: 'invalid-source', attempts: 0, errors: ['Expected a closing brace'] }],
    ]);
    const { counts, problems } = applyOutcomes(messages, outcomes);

    expect(messages.translatedId.translation).toBe('Speichern');
    expect(messages.translatedId.extra?.flags).toEqual([REVIEW_FLAG]);
    for (const id of ['flaggedId', 'manualId', 'invalidId']) {
      expect(messages[id].translation, id).toBe('');
      expect(hasReviewMark(messages[id]), id).toBe(false);
      expect(messages[id].extra, id).toBeUndefined();
    }
    expect(counts).toEqual({ translated: 1, flagged: 1, manual: 1, 'invalid-source': 1 });
    expect(problems).toEqual([
      { english: 'Open', status: 'flagged', errors: ['the tokens must be exactly {1}'], lastReply },
      { english: manualEnglish, status: 'manual', errors: ['more than one plural or select'], lastReply: null },
      { english: 'Broken {name', status: 'invalid-source', errors: ['Expected a closing brace'], lastReply: null },
    ]);
  });
});

describe('one message reads one way across a locale', () => {
  // The renderer merges a locale's areas and the last one wins, so a message another area
  // already translates is copied, never drafted again. `otherAreas` is the locale's messages
  // in every other area, `runDrafts` the id to ICU drafts this run already made.
  type AreaCopy = { message: string; translation: string; obsolete?: boolean; extra?: { flags: string[]; translatorComments: string[] } };

  /** A copy a person has reviewed: it carries no `fuzzy` flag. */
  function reviewedCopy(translation: string): AreaCopy {
    return { message: 'Close', translation, extra: { flags: [], translatorComments: [] } };
  }

  /** A machine draft still waiting for review: it carries the `fuzzy` flag. */
  function fuzzyCopy(translation: string): AreaCopy {
    return { message: 'Close', translation, extra: { flags: [REVIEW_FLAG], translatorComments: [] } };
  }

  it('takes a reviewed copy over a draft made earlier in this run, with or without a redraft', () => {
    const otherAreas = [{ closeId: reviewedCopy('Schließen') }];
    const runDrafts = new Map([['closeId', 'Zumachen']]);
    for (const redraft of [false, true]) {
      expect(sharedTranslations(['closeId'], { otherAreas, runDrafts, redraft }).get('closeId'), `redraft ${redraft}`).toBe('Schließen');
    }
  });

  it('takes a reviewed copy over a fuzzy copy in another area, whichever area comes first', () => {
    const runDrafts = new Map<string, string>();
    for (const redraft of [false, true]) {
      const fuzzyFirst = [{ closeId: fuzzyCopy('Schliessen') }, { closeId: reviewedCopy('Schließen') }];
      const reviewedFirst = [{ closeId: reviewedCopy('Schließen') }, { closeId: fuzzyCopy('Schliessen') }];
      expect(sharedTranslations(['closeId'], { otherAreas: fuzzyFirst, runDrafts, redraft }).get('closeId'), `fuzzy first, redraft ${redraft}`).toBe('Schließen');
      expect(sharedTranslations(['closeId'], { otherAreas: reviewedFirst, runDrafts, redraft }).get('closeId'), `reviewed first, redraft ${redraft}`).toBe('Schließen');
    }
  });

  it('uses a draft made earlier in this run when no area has a reviewed copy, including under a redraft', () => {
    const runDrafts = new Map([['closeId', 'Zumachen']]);
    for (const redraft of [false, true]) {
      expect(sharedTranslations(['closeId'], { otherAreas: [{}], runDrafts, redraft }).get('closeId'), `no copy, redraft ${redraft}`).toBe('Zumachen');
      expect(sharedTranslations(['closeId'], { otherAreas: [{ closeId: fuzzyCopy('Schliessen') }], runDrafts, redraft }).get('closeId'), `fuzzy copy, redraft ${redraft}`).toBe('Zumachen');
    }
  });

  it('copies a fuzzy copy from another area, and ignores it when redrafting', () => {
    const otherAreas = [{ closeId: fuzzyCopy('Schliessen') }];
    const runDrafts = new Map<string, string>();
    expect(sharedTranslations(['closeId'], { otherAreas, runDrafts }).get('closeId'), 'redraft left at its default').toBe('Schliessen');
    expect(sharedTranslations(['closeId'], { otherAreas, runDrafts, redraft: false }).get('closeId')).toBe('Schliessen');
    expect(sharedTranslations(['closeId'], { otherAreas, runDrafts, redraft: true }).has('closeId')).toBe(false);
  });

  it('ignores an obsolete copy, reviewed or drafted', () => {
    const otherAreas = [{
      reviewedAlone: { ...reviewedCopy('Schließen'), obsolete: true },
      fuzzyAlone: { ...fuzzyCopy('Schliessen'), obsolete: true },
      reviewedBesideFuzzy: { ...reviewedCopy('Schließen'), obsolete: true },
      reviewedBesideRunDraft: { ...reviewedCopy('Schließen'), obsolete: true },
    }, {
      reviewedBesideFuzzy: fuzzyCopy('Schliessen'),
    }];
    const runDrafts = new Map([['reviewedBesideRunDraft', 'Zumachen']]);
    const shared = sharedTranslations(['reviewedAlone', 'fuzzyAlone', 'reviewedBesideFuzzy', 'reviewedBesideRunDraft'], { otherAreas, runDrafts });
    expect(shared.has('reviewedAlone'), 'an obsolete reviewed copy alone').toBe(false);
    expect(shared.has('fuzzyAlone'), 'an obsolete fuzzy copy alone').toBe(false);
    expect(shared.get('reviewedBesideFuzzy'), 'an obsolete reviewed copy beside a live fuzzy one').toBe('Schliessen');
    expect(shared.get('reviewedBesideRunDraft'), 'an obsolete reviewed copy beside a run draft').toBe('Zumachen');
  });

  it('ignores a copy with an empty translation, reviewed or drafted', () => {
    const otherAreas = [{
      reviewedAlone: reviewedCopy(''),
      fuzzyAlone: fuzzyCopy(''),
      reviewedBesideFuzzy: reviewedCopy(''),
      reviewedBesideRunDraft: reviewedCopy(''),
      reviewedBesideReviewed: reviewedCopy(''),
      fuzzyBesideFuzzy: fuzzyCopy(''),
    }, {
      reviewedBesideFuzzy: fuzzyCopy('Schliessen'),
      reviewedBesideReviewed: reviewedCopy('Schließen'),
      fuzzyBesideFuzzy: fuzzyCopy('Schliessen'),
    }];
    const runDrafts = new Map([['reviewedBesideRunDraft', 'Zumachen']]);
    const ids = ['reviewedAlone', 'fuzzyAlone', 'reviewedBesideFuzzy', 'reviewedBesideRunDraft', 'reviewedBesideReviewed', 'fuzzyBesideFuzzy'];
    const shared = sharedTranslations(ids, { otherAreas, runDrafts });
    expect(shared.has('reviewedAlone'), 'an empty reviewed copy alone').toBe(false);
    expect(shared.has('fuzzyAlone'), 'an empty fuzzy copy alone').toBe(false);
    expect(shared.get('reviewedBesideFuzzy'), 'an empty reviewed copy beside a live fuzzy one').toBe('Schliessen');
    expect(shared.get('reviewedBesideRunDraft'), 'an empty reviewed copy beside a run draft').toBe('Zumachen');
    expect(shared.get('reviewedBesideReviewed'), 'an empty reviewed copy beside a live reviewed one').toBe('Schließen');
    expect(shared.get('fuzzyBesideFuzzy'), 'an empty fuzzy copy beside a live fuzzy one').toBe('Schliessen');
  });

  it('leaves an id with no copy out of the map, and finds a copy in any area', () => {
    const otherAreas = [{ unrelatedId: reviewedCopy('Schließen') }, {}, { laterId: reviewedCopy('Öffnen') }];
    const shared = sharedTranslations(['missingId', 'laterId'], { otherAreas, runDrafts: new Map<string, string>() });
    expect(shared.has('missingId')).toBe(false);
    expect([...shared.keys()]).toEqual(['laterId']);
    expect(shared.get('laterId')).toBe('Öffnen');
    // Nothing to look in and nothing drafted gives an empty map, not a map of undefined.
    expect(sharedTranslations(['missingId'], { otherAreas: [], runDrafts: new Map<string, string>() }).size).toBe(0);
  });
});

describe('context for a string', () => {
  it('offers a reworded string the old translation from the base catalog', () => {
    const base = {
      oldId: { message: 'Delete this task', translation: 'Diese Aufgabe löschen', origin: [['src/a.tsx', null]] },
      keptId: { message: 'Save', translation: 'Speichern', origin: [['src/a.tsx', null]] },
      otherFile: { message: 'Delete this tasks', translation: 'x', origin: [['src/b.tsx', null]] },
    };
    const current = { keptId: base.keptId, newId: { message: 'Delete this task now', translation: '', origin: [['src/a.tsx', null]] } };
    const removed = removedEntries(base, current);
    expect(removed.map((entry: { english: string }) => entry.english)).toEqual(['Delete this task', 'Delete this tasks']);
    expect(findHint(current.newId, removed)).toEqual({ english: 'Delete this task', translation: 'Diese Aufgabe löschen' });
    expect(findHint({ message: 'Something else entirely', origin: [['src/a.tsx', null]] }, removed)).toBeNull();
  });

  it('orders neighbours by where their text sits in the source file', () => {
    const messages = {
      first: { message: 'First label', translation: 'Erstes', origin: [['src/a.tsx', null]] },
      third: { message: 'Third label', translation: '', origin: [['src/a.tsx', null]] },
      second: { message: 'Second label', translation: '', origin: [['src/a.tsx', null]] },
      elsewhere: { message: 'Other file', translation: '', origin: [['src/b.tsx', null]] },
    };
    const source = '<p>First label</p><p>Second label</p><p>Third label</p>';
    const neighbours = neighbourMessages('second', messages, () => source);
    expect(neighbours).toEqual([
      { english: 'First label', translation: 'Erstes' },
      { english: 'Third label', translation: null },
    ]);
  });

  it('offers at most four neighbours on each side of a message', () => {
    const labels = Array.from({ length: 10 }, (_, index) => `Label ${String(index + 1).padStart(2, '0')}`);
    const source = labels.map((label) => `<p>${label}</p>`).join('');
    // Added in reverse, so the catalog order cannot be what the result follows.
    const messages = Object.fromEntries([...labels].reverse().map((label) => [`id ${label}`, catalogMessage(label, 'src/a.tsx')]));
    const around = (label: string) => neighbourMessages(`id ${label}`, messages, () => source).map((neighbour: { english: string }) => neighbour.english);
    expect(around('Label 06')).toEqual(['Label 02', 'Label 03', 'Label 04', 'Label 05', 'Label 07', 'Label 08', 'Label 09', 'Label 10']);
    expect(around('Label 01')).toEqual(['Label 02', 'Label 03', 'Label 04', 'Label 05']);
    expect(around('Label 10')).toEqual(['Label 06', 'Label 07', 'Label 08', 'Label 09']);
  });

  it('sorts a message whose text is not in the source after the found ones, alphabetically', () => {
    const messages = {
      zulu: catalogMessage('Zulu gone', 'src/a.tsx'),
      here: catalogMessage('Found here', 'src/a.tsx'),
      alpha: catalogMessage('Alpha gone', 'src/a.tsx'),
      there: catalogMessage('Found there', 'src/a.tsx'),
    };
    const source = '<p>Found here</p><p>Found there</p>';
    const around = (id: string) => neighbourMessages(id, messages, () => source).map((neighbour: { english: string }) => neighbour.english);
    expect(around('here')).toEqual(['Found there', 'Alpha gone', 'Zulu gone']);
    expect(around('zulu')).toEqual(['Found here', 'Found there', 'Alpha gone']);
  });

  it('works out a file order once per finder, and answers every id of that file from it', () => {
    const messages = {
      first: catalogMessage('First label', 'src/a.tsx'),
      second: catalogMessage('Second label', 'src/a.tsx'),
      third: catalogMessage('Third label', 'src/a.tsx'),
      elsewhere: catalogMessage('Other file', 'src/b.tsx'),
    };
    const source = '<p>First label</p><p>Second label</p><p>Third label</p>';
    const reads: string[] = [];
    const finder = createNeighbourFinder(messages, (file: string) => {
      reads.push(file);
      return source;
    });
    const englishOf = (neighbours: Array<{ english: string }>) => neighbours.map((neighbour) => neighbour.english);
    expect(englishOf(finder('first'))).toEqual(['Second label', 'Third label']);
    expect(englishOf(finder('second'))).toEqual(['First label', 'Third label']);
    expect(englishOf(finder('third'))).toEqual(['First label', 'Second label']);
    expect(reads).toEqual(['src/a.tsx']);
    expect(finder('elsewhere')).toEqual([]);
    expect(reads).toEqual(['src/a.tsx', 'src/b.tsx']);
  });

  it('offers only entries the base had translated and the current catalog lost', () => {
    const origin = [['src/a.tsx', null]];
    const base = {
      gone: { message: 'Gone', translation: 'Weg', origin },
      stillThere: { message: 'Still', translation: 'Noch', origin },
      untranslated: { message: 'Blank', translation: '', origin },
      obsoleteEntry: { message: 'Old', translation: 'Alt', origin, obsolete: true },
      noOrigin: { message: 'Orphan', translation: 'Waise' },
    };
    expect(removedEntries(base, { stillThere: base.stillThere })).toEqual([
      { english: 'Gone', translation: 'Weg', origin },
      { english: 'Orphan', translation: 'Waise', origin: [] },
    ]);
  });

  it('skips a candidate whose length rules it out, and still finds the most similar one listed with it', () => {
    const origin = [['src/a.tsx', null]];
    const message = { message: 'Save all of the selected tasks now', origin };
    const tooShort = { english: 'Save', translation: 'Speichern', origin };
    const farther = { english: 'Save all selected tasks', translation: 'Alle gewählten Aufgaben speichern', origin };
    const closest = { english: 'Save all of the selected tasks', translation: 'Alle ausgewählten Aufgaben speichern', origin };
    const hint = { english: closest.english, translation: closest.translation };
    expect(findHint(message, [tooShort])).toBeNull();
    expect(findHint(message, [tooShort, closest])).toEqual(hint);
    expect(findHint(message, [farther, closest])).toEqual(hint);
    expect(findHint(message, [closest, farther])).toEqual(hint);
  });
});

describe('the pipeline', () => {
  it('retries a failed result with its problems, flags one that keeps failing, and leaves manual ones', async () => {
    const messages = {
      good: { message: 'Delete {taskTitle}', translation: '', origin: [['src/a.tsx', null]] },
      fixed: { message: 'Rename {taskTitle}', translation: '', origin: [['src/a.tsx', null]] },
      broken: { message: 'Move {taskTitle}', translation: '', origin: [['src/a.tsx', null]] },
      manual: { message: '{a, plural, one {#} other {#}} {b, plural, one {#} other {#}}', translation: '', origin: [['src/a.tsx', null]] },
    };
    const seenProblems: string[][] = [];
    const engine = {
      async translateBatch({ items }: { items: Array<{ key: string; text: string; problems?: string[] }> }) {
        const replies = new Map();
        for (const item of items) {
          if (item.problems) seenProblems.push(item.problems);
          const english = item.text;
          let text = 'kaputt';
          if (english === 'Delete {1}') text = '{1} löschen';
          if (english === 'Rename {1}') text = item.problems ? '{1} umbenennen' : 'umbenennen';
          replies.set(item.key, { key: item.key, text });
        }
        return { replies, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, durationMs: 1 } };
      },
    };
    const { outcomes, usage } = await translateEntries({
      locale: 'de',
      entries: Object.entries(messages).map(([id, message]) => ({ id, message })),
      allMessages: messages,
      engine,
      glossary: EMPTY_GLOSSARY,
      budgetFor: () => null,
      widthOfCodepoint: wcwidthV11,
      readSource: () => null,
    });
    expect(outcomes.get('good')).toMatchObject({ status: 'translated', attempts: 1, icu: '{taskTitle} löschen' });
    expect(outcomes.get('fixed')).toMatchObject({ status: 'translated', attempts: 2, icu: '{taskTitle} umbenennen' });
    expect(outcomes.get('broken')).toMatchObject({ status: 'flagged', attempts: 3 });
    expect(outcomes.get('manual')).toMatchObject({ status: 'manual', attempts: 0 });
    expect(seenProblems[0]).toEqual(['the tokens must be exactly {1}']);
    expect(usage.calls).toBe(3);
  });

  it('builds a request item with the forms a language needs and the English for each borrowed one', () => {
    const prepared = prepareMessage('{count, plural, one {# task} other {# tasks}}');
    const item = requestItem({
      key: 'k1', prepared, keys: targetKeys(prepared, 'ru'), locale: 'ru', message: { context: 'board', comments: [], origin: [['src/a.tsx', null]] },
      neighbours: [], hint: null, glossaryTerms: { kept: [], fixed: [] }, budget: null, problems: [],
    });
    expect(item.write).toEqual(['one', 'few', 'many', 'other']);
    expect(item.englishFor).toEqual({ few: '{1} tasks', many: '{1} tasks' });
    expect(item.legend).toEqual({ '{1}': 'the number' });
    expect(item.context).toBe('board');
  });

  it('refuses a reply that is not the reply shape', () => {
    expect(() => readReplies('{"answer": []}')).toThrow('the reply has no "translations" list');
    expect(readReplies({ translations: [{ key: 'k1', text: 'x' }] }).get('k1')).toEqual({ key: 'k1', text: 'x' });
  });

  it('skips reply entries without a string key and refuses text that is not JSON', () => {
    const replies = readReplies({ translations: [{ text: 'no key' }, { key: 7, text: 'numeric key' }, null, 'stray', { key: 'k2', text: 'ok' }] });
    expect([...replies.keys()]).toEqual(['k2']);
    expect(readReplies('{"translations":[{"key":"k1","text":"x"}]}').get('k1')).toEqual({ key: 'k1', text: 'x' });
    expect(() => readReplies('this is not json')).toThrow();
  });

  describe('a request item for a text message', () => {
    const baseInput = {
      key: 'k1', keys: [], locale: 'de', neighbours: [], hint: null, glossaryTerms: { kept: [], fixed: [] }, budget: null, problems: [],
    };
    const bareMessage = { context: '', comments: [], origin: [] };

    it('carries every optional field when its input is supplied', () => {
      const neighbours = [{ english: 'Save', translation: 'Speichern' }];
      const hint = { english: 'Delete task', translation: 'Aufgabe löschen' };
      const item = requestItem({
        ...baseInput,
        prepared: prepareMessage('Delete {taskTitle}'),
        message: { context: 'board', comments: ['a', 'b'], origin: [['src/a.tsx', null]] },
        neighbours,
        hint,
        glossaryTerms: { kept: ['Claude'], fixed: [{ english: 'branch', note: 'a git branch', term: 'Branch', match: 'branch' }] },
        budget: 60,
        problems: ['the tokens must be exactly {1}'],
      });
      expect(item).toStrictEqual({
        key: 'k1',
        text: 'Delete {1}',
        legend: { '{1}': 'placeholder "taskTitle"' },
        context: 'board',
        comment: 'a b',
        file: 'src/a.tsx',
        nearby: neighbours,
        previous: hint,
        glossary: { keep: ['Claude'], terms: [{ english: 'branch', use: 'Branch' }] },
        widthLimit: 60,
        problems: ['the tokens must be exactly {1}'],
      });
    });

    it('carries none of them when the inputs are empty or absent', () => {
      const prepared = prepareMessage('Save');
      expect(requestItem({ ...baseInput, prepared, message: bareMessage })).toStrictEqual({ key: 'k1', text: 'Save' });
      expect(requestItem({ key: 'k1', keys: [], locale: 'de', prepared, message: {} })).toStrictEqual({ key: 'k1', text: 'Save' });
    });

    it('treats a width budget of zero as a budget, and lists only the glossary half it has', () => {
      const prepared = prepareMessage('Save');
      expect(requestItem({ ...baseInput, prepared, message: bareMessage, budget: 0 })).toStrictEqual({ key: 'k1', text: 'Save', widthLimit: 0 });
      const keptOnly = requestItem({ ...baseInput, prepared, message: bareMessage, glossaryTerms: { kept: ['Claude'], fixed: [] } });
      expect(keptOnly.glossary).toStrictEqual({ keep: ['Claude'] });
      const fixedOnly = requestItem({ ...baseInput, prepared, message: bareMessage, glossaryTerms: { kept: [], fixed: [{ english: 'branch', note: 'n', term: 'Branch', match: 'branch' }] } });
      expect(fixedOnly.glossary).toStrictEqual({ terms: [{ english: 'branch', use: 'Branch' }] });
    });
  });

  it('retries after an engine call that throws, and records the failure as the first attempt error', async () => {
    const messages = { delete: catalogMessage('Delete {taskTitle}', 'src/a.tsx') };
    const seenProblems: string[][] = [];
    let callCount = 0;
    const engine: FakeEngine = {
      async translateBatch({ items }) {
        callCount += 1;
        if (callCount === 1) throw new Error('connection reset');
        for (const item of items) if (item.problems) seenProblems.push(item.problems);
        return { replies: new Map(items.map((item): [string, EngineReply] => [item.key, { key: item.key, text: '{1} löschen' }])), usage: NO_USAGE };
      },
    };
    const { outcomes, usage } = await runPipeline(messages, engine);
    expect(outcomes.get('delete')).toMatchObject({ status: 'translated', attempts: 2, icu: '{taskTitle} löschen' });
    expect(outcomes.get('delete').firstErrors).toEqual([expect.stringMatching(/^the engine call failed: connection reset/)]);
    expect(usage.failedCalls).toBe(1);
    expect(seenProblems).toEqual([[expect.stringMatching(/^the engine call failed/)]]);
  });

  it('retries an item the reply left out, and flags it when it never comes back', async () => {
    const messages = {
      answered: catalogMessage('Open file', 'src/a.tsx'),
      dropped: catalogMessage('Close file', 'src/a.tsx'),
    };
    const callSizes: number[] = [];
    const engine: FakeEngine = {
      async translateBatch({ items }) {
        callSizes.push(items.length);
        return { replies: echoReplies(items.filter((item) => item.text === 'Open file')), usage: NO_USAGE };
      },
    };
    const { outcomes } = await runPipeline(messages, engine);
    expect(outcomes.get('answered')).toMatchObject({ status: 'translated', attempts: 1 });
    expect(outcomes.get('dropped')).toMatchObject({ status: 'flagged', attempts: 3, errors: ['the reply had no entry for this key'] });
    // Both in the first call, then only the dropped one for each of the two retries.
    expect(callSizes).toEqual([2, 1, 1]);
  });

  it('never asks the engine for English that is not valid ICU', async () => {
    // An unterminated argument. A lone trailing "{" is not an example: the parser reads it as a literal brace.
    const messages = {
      broken: catalogMessage('Broken {name', 'src/a.tsx'),
      fine: catalogMessage('Open file', 'src/a.tsx'),
    };
    const calls: EngineItem[][] = [];
    const { outcomes } = await runPipeline(messages, echoEngine(calls));
    expect(outcomes.get('broken')).toMatchObject({ status: 'invalid-source', attempts: 0 });
    expect(outcomes.get('broken').errors).toHaveLength(1);
    expect(outcomes.get('fine')).toMatchObject({ status: 'translated', attempts: 1 });
    expect(calls.flat().map((item) => item.text)).toEqual(['Open file']);
  });

  it('gives a failing entry exactly one attempt when retries are off', async () => {
    const messages = { delete: catalogMessage('Delete {taskTitle}', 'src/a.tsx') };
    let callCount = 0;
    const engine: FakeEngine = {
      async translateBatch({ items }) {
        callCount += 1;
        return { replies: new Map(items.map((item): [string, EngineReply] => [item.key, { key: item.key, text: 'löschen' }])), usage: NO_USAGE };
      },
    };
    const { outcomes } = await runPipeline(messages, engine, { maxRetries: 0 });
    expect(callCount).toBe(1);
    expect(outcomes.get('delete')).toMatchObject({ status: 'flagged', attempts: 1, errors: ['the tokens must be exactly {1}'] });
  });

  it('sends batches of at most the batch size, and never mixes source files in one call', async () => {
    // Different English per entry: a placeholder masks to {1}, so two "Delete {x}" would look alike.
    const fileOfText = new Map([
      ['Open file', 'src/a.tsx'],
      ['Rename folder', 'src/b.tsx'],
      ['Save file', 'src/a.tsx'],
      ['Delete folder', 'src/b.tsx'],
      ['Close file', 'src/a.tsx'],
    ]);
    const messages = Object.fromEntries([...fileOfText].map(([english, file], index) => [`id${index}`, catalogMessage(english, file)]));
    const calls: EngineItem[][] = [];
    const { outcomes } = await runPipeline(messages, echoEngine(calls), { batchSize: 2 });
    expect(calls).toHaveLength(3);
    expect(calls.map((items) => items.length).sort()).toEqual([1, 2, 2]);
    for (const items of calls) {
      expect(new Set(items.map((item) => fileOfText.get(item.text ?? ''))).size).toBe(1);
    }
    expect([...outcomes.values()].map((outcome: { status: string }) => outcome.status)).toEqual(Array(5).fill('translated'));
  });

  it('hands the engine the previous wording of a reworded string when removed entries are given', async () => {
    const messages = { reworded: catalogMessage('Delete this task now', 'src/a.tsx') };
    const removed = [{ english: 'Delete this task', translation: 'Diese Aufgabe löschen', origin: [['src/a.tsx', null]] }];
    const withRemoved: EngineItem[][] = [];
    await runPipeline(messages, echoEngine(withRemoved), { removed });
    expect(withRemoved[0][0].previous).toEqual({ english: 'Delete this task', translation: 'Diese Aufgabe löschen' });
    const without: EngineItem[][] = [];
    await runPipeline(messages, echoEngine(without));
    expect(without[0][0]).not.toHaveProperty('previous');
  });

  it('records no first-attempt errors for an entry that passed at once', async () => {
    const messages = { open: catalogMessage('Open file', 'src/a.tsx') };
    const { outcomes } = await runPipeline(messages, echoEngine([]));
    expect(outcomes.get('open')).toMatchObject({ status: 'translated', attempts: 1, firstErrors: [] });
  });
});

describe('the Claude engine', () => {
  it('runs the adapter answer flags with no tools and no MCP servers, never --bare', () => {
    const args = claudeArgs({ settingsPath: 's.json', model: 'claude-opus-5-5', effort: 'medium', system: 'sys', schema: { type: 'object' } });
    expect(args).toEqual(expect.arrayContaining(['--print', '--no-session-persistence', '--strict-mcp-config', '--system-prompt', '--json-schema']));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--bare');
  });

  it('drops a surrounding Claude Code session from the env and turns thinking off at low effort', () => {
    const env = claudeEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: 'p', MAX_THINKING_TOKENS: '9' }, 'low');
    expect(env).toEqual({ PATH: 'p', MAX_THINKING_TOKENS: '0' });
  });

  it('keeps the login folder and unrelated names, drops every session marker, and sets thinking only at low effort', () => {
    const baseEnv = {
      PATH: 'p',
      CLAUDE_CONFIG_DIR: 'login-folder',
      CLAUDE_SOMETHING_ELSE: 'x',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '4242',
      MAX_THINKING_TOKENS: '9',
    };
    const medium = claudeEnv(baseEnv, 'medium');
    expect(medium).toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: 'login-folder', CLAUDE_SOMETHING_ELSE: 'x' });
    expect(claudeEnv(baseEnv, 'low')).toEqual({ ...medium, MAX_THINKING_TOKENS: '0' });
    // The caller's own env is left as it was.
    expect(baseEnv.CLAUDECODE).toBe('1');
    expect(baseEnv.MAX_THINKING_TOKENS).toBe('9');
  });
});

describe('the command lines', () => {
  describe('translate', () => {
    it('defaults the concurrency, batch size and model by engine', () => {
      expect(parseTranslateArgs([])).toMatchObject({
        engine: 'claude', concurrency: 4, batchSize: 30, model: 'claude-opus-5-5', limit: null, redraft: false, dryRun: false, locales: [], areas: [],
      });
      expect(parseTranslateArgs(['--engine', 'local'])).toMatchObject({ engine: 'local', concurrency: 1, batchSize: 10, model: 'gemma-4-26b-a4b' });
    });

    it('takes an explicit value over the default, and trims a list', () => {
      expect(parseTranslateArgs(['--engine', 'local', '--concurrency', '3', '--batch-size', '5', '--model', 'custom', '--limit', '7', '--redraft', '--dry-run']))
        .toMatchObject({ concurrency: 3, batchSize: 5, model: 'custom', limit: 7, redraft: true, dryRun: true });
      expect(parseTranslateArgs(['--locales', ' de , ja ']).locales).toEqual(['de', 'ja']);
    });

    it('refuses an argument it does not understand rather than falling back to a default', () => {
      const refused: Array<[string[], string]> = [
        [['--engine', 'other'], '--engine: other is not claude or local'],
        [['--limit', '0'], '--limit: 0 is not a positive whole number'],
        [['--batch-size', '1.5'], '--batch-size: 1.5 is not a positive whole number'],
        [['--concurrency', 'abc'], '--concurrency: abc is not a positive whole number'],
        [['--engine=local'], 'Unknown option --engine=local'],
        [['--out', '--dry-run'], '--out needs a value'],
        [['--redraft', '--locales'], '--locales needs a value'],
        [['de'], 'Unexpected argument de'],
      ];
      for (const [argv, message] of refused) expect(() => parseTranslateArgs(argv), argv.join(' ')).toThrow(message);
    });
  });

  describe('the bake-off', () => {
    it('reads the command as a bare argument, before or between the flags', () => {
      expect(parseBakeOffArgs(['translate', '--arm', 'x', '--write'])).toMatchObject({
        command: 'translate', arm: 'x', write: true, concurrency: 1, limit: null,
      });
      expect(parseBakeOffArgs(['--arm', 'x', 'translate']).command).toBe('translate');
      expect(parseBakeOffArgs([]).command).toBeNull();
    });

    it('refuses a second bare argument, a zero limit and an option it does not have', () => {
      const refused: Array<[string[], string]> = [
        [['translate', 'score'], 'Unexpected argument score'],
        [['translate', '--limit', '0'], '--limit: 0 is not a positive whole number'],
        [['translate', '--engine', 'local'], 'Unknown option --engine'],
        [['translate', '--arm'], '--arm needs a value'],
      ];
      for (const [argv, message] of refused) expect(() => parseBakeOffArgs(argv), argv.join(' ')).toThrow(message);
    });
  });
});

describe('the TranslateGemma baseline prompt', () => {
  it('renders the chat template text with the language code the template knows', () => {
    const prompt = translateGemmaPrompt(' Delete {1}? ', 'zh-CN');
    expect(prompt.startsWith('<start_of_turn>user\nYou are a professional English (en) to Chinese (zh-Hans) translator.')).toBe(true);
    expect(prompt.endsWith('into Chinese:\n\n\nDelete {1}?<end_of_turn>\n<start_of_turn>model\n')).toBe(true);
    expect(translateGemmaPrompt('x', 'pl')).toContain('English (en) to Polish (pl) translator');
  });
});

describe('the bake-off', () => {
  it('ships a sample of about 200 strings that all parse, across every kind', () => {
    const sample = loadSample();
    expect(sample.length).toBe(200);
    expect(new Set(sample.map((entry: { id: string }) => entry.id)).size).toBe(sample.length);
    for (const entry of sample) expect(() => prepareMessage(entry.message), entry.id).not.toThrow();
    expect(new Set(sample.map((entry: { kind: string }) => entry.kind))).toEqual(
      new Set(['label', 'description', 'placeholder', 'plural', 'tags', 'long', 'glossary', 'literal', 'hotkey']),
    );
  });

  it('files each validation error under one failure category', () => {
    expect(errorCategory('the tokens must be exactly {1}')).toBe('placeholders');
    expect(errorCategory('the tags must be exactly <0> </0>')).toBe('tags');
    expect(errorCategory('the reply is missing the forms few, many')).toBe('plural-forms');
    expect(errorCategory('translate "branch" as "Branch"')).toBe('glossary');
    expect(errorCategory('it is 62 columns wide, over this description')).toBe('width');
    expect(errorCategory('the rebuilt message is not valid ICU: x')).toBe('icu');
  });

  it('picks the best eligible arm that passes everywhere, and the faster one within the tie margin', () => {
    const sample = [{ id: 's1', kind: 'label', message: 'Save' }, { id: 's2', kind: 'label', message: 'Open' }];
    const arm = (name: string, passes: [boolean, boolean], wallMs: number) => ({
      arm: name,
      locales: {
        de: {
          wallMs,
          usage: { outputTokens: 100 },
          entries: {
            s1: { status: passes[0] ? 'translated' : 'flagged', attempts: 1, firstErrors: [], errors: passes[0] ? [] : ['the tokens must be exactly {1}'] },
            s2: { status: passes[1] ? 'translated' : 'flagged', attempts: 2, firstErrors: ['the tags must be exactly <0> </0>'], errors: passes[1] ? [] : ['x'] },
          },
        },
      },
    });
    const scores = (accuracy: number) => ({ accuracy, fluency: accuracy, critical: false });
    const verdicts = {
      judge: 'claude-opus-5-5',
      locales: { de: {
        s1: { best: scores(5), close: scores(5), failing: scores(5), reference: scores(5) },
        s2: { best: scores(5), close: scores(4.8), failing: scores(5), reference: scores(5) },
      } },
    };
    const arms = [
      { name: 'best', eligible: true, role: 'candidate' },
      { name: 'close', eligible: true, role: 'candidate' },
      { name: 'failing', eligible: true, role: 'candidate' },
      { name: 'reference', eligible: false, role: 'reference' },
    ];
    const records = [arm('best', [true, true], 9000), arm('close', [true, true], 3000), arm('failing', [true, false], 1000), arm('reference', [true, true], 500)];
    const results = scoreRecords({ records, verdicts, arms, sample, locales: ['de'] });
    // "failing" passes half, under the 95% gate; "reference" is not eligible; "close"
    // trails "best" by 0.1, inside the margin, and is three times faster.
    expect(WINNER_RULE.tieMargin).toBeGreaterThan(0.1);
    expect(results.winner).toBe('close');
    const failing = results.arms.find((result: { arm: string }) => result.arm === 'failing');
    expect(failing.overall.worstLocaleFinalPass).toBe(0.5);
    expect(failing.firstTryFailures).toEqual({ tags: 1 });
    expect(failing.finalFailures).toEqual({ reply: 1 });
    expect(failing.perString.de.s2).toEqual([0, 2, 5, 5, 0]);

    // Written with each string's scores on one line, and still the same data.
    const written = formatResults(results);
    expect(written).toContain('"s2": [0, 2, 5, 5, 0]');
    expect(JSON.parse(written)).toEqual(results);
  });

  it('files an engine failure under engine and anything it has no rule for under reply', () => {
    expect(errorCategory('the engine call failed: boom')).toBe('engine');
    expect(errorCategory('the reply had no entry for this key')).toBe('reply');
    expect(errorCategory('the reply has no "text"')).toBe('reply');
    expect(errorCategory('something no rule was written for')).toBe('reply');
  });

  it('files the validator own wording under its category, so rewording a message breaks here', () => {
    const textMessage = prepareMessage('Delete {taskTitle}? <0>Undo</0> is not possible.');
    const pluralMessage = prepareMessage('{count, plural, one {# task} other {# tasks}}');
    const glossary = loadGlossary();
    const realErrors = (prepared: unknown, reply: unknown, overrides: Record<string, unknown> = {}): string[] => {
      const verdict = validateWith(prepared, reply, overrides);
      expect(verdict.ok).toBe(false);
      return verdict.errors;
    };
    const cases: Array<[string, string[]]> = [
      ['placeholders', [
        ...realErrors(textMessage, { text: 'Löschen? <0>Rückgängig</0>.' }),
        ...realErrors(textMessage, { text: '{2} löschen? <0>x</0>' }),
        ...formErrors({ reference: '{1} tasks', translated: 'Aufgaben', tokens: pluralMessage.tokens, inPlural: true, label: 'other' }),
      ]],
      ['tags', [
        ...realErrors(textMessage, { text: '{1} löschen? Rückgängig' }),
        ...realErrors(textMessage, { text: '{1} löschen? </0>x<0>' }),
      ]],
      ['plural-forms', realErrors(pluralMessage, { forms: { one: '{1} zadanie', other: '{1} zadania' } }, { locale: 'pl' })],
      ['glossary', [
        ...realErrors(prepareMessage('Delete the branch'), { text: 'Zweig löschen' }, { glossary }),
        ...realErrors(prepareMessage('Ask Claude'), { text: 'Спросить Клода' }, { glossary, locale: 'ru' }),
      ]],
      ['width', realErrors(prepareMessage('Applies after a restart.'), { text: '重'.repeat(31) }, { locale: 'zh-CN', budget: 60 })],
      ['icu', [
        ...realErrors(textMessage, { text: '{1} {löschen}? <0>x</0>' }),
        ...realErrors(pluralMessage, { forms: { one: '{1} Aufgabe', other: '{1} Aufgaben #' } }),
      ]],
    ];
    for (const [category, errors] of cases) {
      expect(errors.length, category).toBeGreaterThan(0);
      for (const error of errors) expect(errorCategory(error), error).toBe(category);
    }
  });

  describe('the final-pass gate', () => {
    const sampleOf = (size: number) => Array.from({ length: size }, (_, index) => ({ id: `s${index + 1}`, kind: 'label', message: `Label ${index + 1}` }));
    /** One German record per arm: string `s<n>` is translated when `passes[n - 1]`, else flagged. */
    const recordOf = (name: string, passes: boolean[]) => ({
      arm: name,
      locales: {
        de: {
          wallMs: 1000,
          usage: { outputTokens: 10 },
          entries: Object.fromEntries(passes.map((passed, index) => [`s${index + 1}`, {
            status: passed ? 'translated' : 'flagged', attempts: 1, firstErrors: [], errors: passed ? [] : ['the tokens must be exactly {1}'],
          }])),
        },
      },
    });
    /** Top judge scores for every arm and string, so a missing score never is what keeps an arm from winning. */
    const verdictsFor = (sample: Array<{ id: string }>, names: string[]) => ({
      judge: 'claude-opus-5-5',
      locales: { de: Object.fromEntries(sample.map((entry) => [entry.id, Object.fromEntries(names.map((name) => [name, { accuracy: 5, fluency: 5, critical: false }]))])) },
    });
    const candidates = (...names: string[]) => names.map((name) => ({ name, eligible: true, role: 'candidate' }));

    it('names no winner when every eligible arm is under the gate, and one when they all pass', () => {
      const sample = sampleOf(2);
      const arms = candidates('first', 'second');
      const verdicts = verdictsFor(sample, ['first', 'second']);
      const underGate = scoreRecords({ records: [recordOf('first', [true, false]), recordOf('second', [false, false])], verdicts, arms, sample, locales: ['de'] });
      expect(underGate.winner).toBeNull();
      // Same arms and scores with every string passing: the gate was the only thing in the way.
      const passing = scoreRecords({ records: [recordOf('first', [true, true]), recordOf('second', [true, true])], verdicts, arms, sample, locales: ['de'] });
      expect(passing.winner).not.toBeNull();
    });

    it('lets an arm through at exactly the minimum pass rate and not below it', () => {
      expect(WINNER_RULE.minimumFinalPass).toBe(0.95);
      const sample = sampleOf(20);
      const arms = candidates('edge');
      const verdicts = verdictsFor(sample, ['edge']);
      const withFailures = (failures: number) => recordOf('edge', Array.from({ length: 20 }, (_, index) => index >= failures));
      expect(scoreRecords({ records: [withFailures(1)], verdicts, arms, sample, locales: ['de'] }).winner).toBe('edge');
      expect(scoreRecords({ records: [withFailures(2)], verdicts, arms, sample, locales: ['de'] }).winner).toBeNull();
    });
  });

  it('writes results that read back as the same data, even when a string holds a comma or a bracket', () => {
    const value = {
      strings: ['a,b', 'c, d', '[x,y]'],
      note: 'see [ a,b ] here',
      nested: [[1, 2], [3]],
      scores: { s1: [0, 2, 5, 5, 0] },
      none: [],
      objects: [{ name: 'x', tags: ['p', 'q'] }, { name: 'y', tags: [] }],
    };
    const written = formatResults(value);
    expect(JSON.parse(written)).toEqual(value);
    expect(written).toContain('["a,b", "c, d", "[x,y]"]');
    expect(written).toContain('"s1": [0, 2, 5, 5, 0]');
    expect(written).toContain('"note": "see [ a,b ] here"');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('records the refill model the same as its arm in arms.json', () => {
    const arm = loadArms().arms.find((candidate: { name: string }) => candidate.name === REFILL_MODEL.name);
    expect(arm).toBeDefined();
    expect(arm.huggingFace).toBe(REFILL_MODEL.huggingFace);
    expect(arm.file).toBe(REFILL_MODEL.file);
    // Only an eligible arm can become the refill engine.
    expect(arm.eligible).toBe(true);
  });
});

describe('the review mark in Lingui', () => {
  // If a Lingui update ever drops a fuzzy entry's translation, as gettext's own
  // compiler does, every machine draft would show English. This fails first.
  it('keeps the fuzzy flag through a read, an extract merge and a write, and still serves the translation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-review-mark-'));
    try {
      const write = (relative: string, content: string) => {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
      };
      const header = (locale: string) => `msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=utf-8\\n"\n"Language: ${locale}\\n"\n\n`;
      write('src/area/a.ts', '');
      write('locales/en/area.po', `${header('en')}#: src/area/a.ts\nmsgid "Save"\nmsgstr "Save"\n\n#: src/area/a.ts\nmsgid "Cancel"\nmsgstr "Cancel"\n`);
      write('locales/de/area.po', `${header('de')}#: src/area/a.ts\n#, fuzzy\nmsgid "Save"\nmsgstr "Speichern"\n\n#: src/area/a.ts\nmsgid "Cancel"\nmsgstr ""\n`);
      const config = makeConfig({
        rootDir: root,
        locales: ['en', 'de'],
        sourceLocale: 'en',
        fallbackLocales: { default: 'en' },
        catalogs: [{ path: '<rootDir>/locales/{locale}/area', include: ['<rootDir>/src/area/'] }],
        format: formatter({ origins: true, lineNumbers: false }),
      }, { skipValidation: true });
      const [catalog] = await getCatalogs(config);
      const saveId = generateMessageId('Save');
      const cancelId = generateMessageId('Cancel');

      const german = await catalog.read('de');
      expect(hasReviewMark(german[saveId])).toBe(true);
      const { messages: served } = await catalog.getTranslations('de', { sourceLocale: 'en', fallbackLocales: config.fallbackLocales });
      expect(served[saveId]).toBe('Speichern');

      const extracted = {
        [saveId]: { message: 'Save', origin: [['src/area/a.ts', 1]], comments: [], context: undefined },
        [cancelId]: { message: 'Cancel', origin: [['src/area/a.ts', 2]], comments: [], context: undefined },
      };
      const merged = catalog.merge({ en: await catalog.read('en'), de: german }, extracted, {});
      expect(hasReviewMark(merged.de[saveId])).toBe(true);

      applyMachineTranslation(german[cancelId], 'Abbrechen');
      await catalog.write('de', german);
      const written = fs.readFileSync(path.join(root, 'locales/de/area.po'), 'utf8');
      expect(written.match(/#, fuzzy/g)).toHaveLength(2);
      const reread = await catalog.read('de');
      expect(reread[cancelId].translation).toBe('Abbrechen');
      expect(hasReviewMark(reread[cancelId])).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
