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
import { applyMachineTranslation, hasReviewMark, REVIEW_FLAG, selectEntryIds } from '../../scripts/i18n/catalogs.mjs';
import { findHint, neighbourMessages, removedEntries } from '../../scripts/i18n/context.mjs';
import { readReplies, requestItem } from '../../scripts/i18n/prompt.mjs';
import { translateEntries } from '../../scripts/i18n/translate-catalog.mjs';
import { claudeArgs, claudeEnv } from '../../scripts/i18n/engines/claude.mjs';
import { translateGemmaPrompt } from '../../scripts/i18n/engines/openai-compatible.mjs';
import { errorCategory, loadSample, scoreRecords, WINNER_RULE } from '../../scripts/i18n/bake-off/run.mjs';

// The translation harness (scripts/i18n/, docs/contributing/translations.md). Engines
// are never called here: the pipeline runs against a fake one, and catalogs are
// fixture files under the OS temp folder, so nothing touches src/locales.

const EMPTY_GLOSSARY = { keep: [], terms: [] };

/** Render a compiled ICU translation in `locale`, the way the app does. */
function render(locale: string, icu: string, values: Record<string, unknown>): string {
  const i18n = setupI18n({ locale, messages: { [locale]: { message: compileMessage(icu) } } });
  return i18n._('message', values);
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
