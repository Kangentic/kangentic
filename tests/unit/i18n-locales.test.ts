/**
 * The display-language decisions that need no window: which catalog an OS
 * language maps to, when the first-launch suggestion shows, which language a
 * session starts in, what main's two `language:*` handlers do, and main's
 * translator loading its compiled catalogs. See docs/architecture/i18n.md.
 *
 * Tier: Unit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { msg } from '@lingui/core/runtime-macro';
import {
  APP_LOCALES,
  LOCALE_ARGUMENT_PREFIX,
  LOCALE_NATIVE_NAMES,
  SHIPPED_LOCALES,
  computeLanguageSuggestion,
  isAppLocale,
  localeDisplayCode,
  matchSystemLocale,
  readLocaleArgument,
  resolveActiveLocale,
} from '../../src/shared/i18n/locales';
import { englishText } from '../../src/shared/i18n/english';
import { readLanguageInfo, saveLanguageForRestart, type LanguageConfigStore } from '../../src/main/i18n/language-handlers';
import { getActiveLocale, initMainI18n, localeArgument, translateText } from '../../src/main/i18n/main-i18n';
import { DEFAULT_CONFIG, type AppConfig } from '../../src/shared/types';
import linguiConfig from '../../lingui.config';

describe('the locale list', () => {
  it('is the 15 VS Code languages, English first, each with its own name', () => {
    expect(APP_LOCALES).toEqual(['en', 'zh-CN', 'zh-TW', 'fr', 'de', 'it', 'es', 'ja', 'ko', 'ru', 'pt-BR', 'tr', 'pl', 'cs', 'hu']);
    expect(Object.keys(LOCALE_NATIVE_NAMES).sort()).toEqual([...APP_LOCALES].sort());
    expect(LOCALE_NATIVE_NAMES['zh-CN']).toBe('中文(简体)');
    expect(LOCALE_NATIVE_NAMES['pt-BR']).toBe('Português (Brasil)');
    expect(localeDisplayCode('zh-CN')).toBe('zh-cn');
  });

  it('is the list lingui.config.ts extracts for, with English the source and the fallback', () => {
    expect(linguiConfig.locales).toEqual([...APP_LOCALES]);
    expect(linguiConfig.sourceLocale).toBe('en');
    expect(linguiConfig.fallbackLocales).toEqual({ default: 'en' });
  });

  it('ships English, and only languages it has a catalog for', () => {
    expect(SHIPPED_LOCALES).toContain('en');
    for (const locale of SHIPPED_LOCALES) expect(isAppLocale(locale)).toBe(true);
  });
});

describe('matchSystemLocale', () => {
  it.each([
    [['zh-Hans-CN'], 'zh-CN'],
    [['zh-CN'], 'zh-CN'],
    [['zh-SG'], 'zh-CN'],
    [['zh'], 'zh-CN'],
    [['zh-Hant-TW'], 'zh-TW'],
    [['zh-Hant'], 'zh-TW'],
    [['zh-TW'], 'zh-TW'],
    [['zh-HK'], 'zh-TW'],
    [['zh-MO'], 'zh-TW'],
    [['zh-Hans-HK'], 'zh-CN'],
    [['pt-PT'], 'pt-BR'],
    [['pt-BR'], 'pt-BR'],
    [['es-419'], 'es'],
    [['es-MX'], 'es'],
    [['en-GB'], 'en'],
    [['fr-CA'], 'fr'],
    [['de_DE'], 'de'],
    [['JA-jp'], 'ja'],
  ] as const)('%j maps to %s', (preferred, expected) => {
    expect(matchSystemLocale(preferred)).toBe(expected);
  });

  it('takes the first preferred language a catalog covers', () => {
    expect(matchSystemLocale(['nl-NL', 'de-DE', 'fr-FR'])).toBe('de');
    expect(matchSystemLocale(['en-US', 'zh-CN'])).toBe('en');
  });

  it('is null when no catalog covers any of them', () => {
    expect(matchSystemLocale(['nl-NL', 'sv-SE'])).toBeNull();
    expect(matchSystemLocale([])).toBeNull();
    expect(matchSystemLocale([''])).toBeNull();
  });

  it('skips a language outside the candidates for a later one inside them', () => {
    expect(matchSystemLocale(['ru-RU', 'de-DE'], ['en', 'de'])).toBe('de');
    expect(matchSystemLocale(['ru-RU', 'ja-JP'], ['en', 'de'])).toBeNull();
  });
});

describe('computeLanguageSuggestion', () => {
  const shipped = ['en', 'zh-CN'] as const;

  it('offers a shipped OS language other than English, once, while the user has never chosen', () => {
    expect(computeLanguageSuggestion({
      systemLanguages: ['zh-Hans-CN'], displayLanguage: undefined, hasAnsweredLanguageSuggestion: false, shippedLocales: shipped,
    })).toBe('zh-CN');
  });

  it('offers nothing once answered, once a language was chosen, for English, or for a language that does not ship', () => {
    const base = { systemLanguages: ['zh-CN'], displayLanguage: undefined, hasAnsweredLanguageSuggestion: false, shippedLocales: shipped };
    expect(computeLanguageSuggestion({ ...base, hasAnsweredLanguageSuggestion: true })).toBeNull();
    expect(computeLanguageSuggestion({ ...base, displayLanguage: 'en' })).toBeNull();
    expect(computeLanguageSuggestion({ ...base, systemLanguages: ['en-US'] })).toBeNull();
    expect(computeLanguageSuggestion({ ...base, systemLanguages: ['ja-JP'] })).toBeNull();
    expect(computeLanguageSuggestion({ ...base, systemLanguages: ['nl-NL'] })).toBeNull();
  });

  it('offers the most preferred shipped language, past one with no translation yet', () => {
    const base = { displayLanguage: undefined, hasAnsweredLanguageSuggestion: false, shippedLocales: ['en', 'de'] as const };
    expect(computeLanguageSuggestion({ ...base, systemLanguages: ['ru-RU', 'de-DE'] })).toBe('de');
    // English before a shipped language is the user's choice of English.
    expect(computeLanguageSuggestion({ ...base, systemLanguages: ['en-US', 'de-DE'] })).toBeNull();
    expect(computeLanguageSuggestion({ ...base, systemLanguages: ['ru-RU', 'en-US', 'de-DE'] })).toBeNull();
  });

  it('offers nothing with the languages this build ships today, whatever the OS', () => {
    expect(computeLanguageSuggestion({
      systemLanguages: APP_LOCALES.filter((locale) => !SHIPPED_LOCALES.includes(locale)),
      displayLanguage: undefined,
      hasAnsweredLanguageSuggestion: false,
    })).toBeNull();
  });
});

describe('resolveActiveLocale', () => {
  it('starts in the saved language when it ships, and in English otherwise', () => {
    expect(resolveActiveLocale('zh-CN', ['en', 'zh-CN'])).toBe('zh-CN');
    expect(resolveActiveLocale('ja', ['en', 'zh-CN'])).toBe('en');
    expect(resolveActiveLocale('klingon', ['en', 'zh-CN'])).toBe('en');
    expect(resolveActiveLocale(undefined)).toBe('en');
  });
});

describe('readLocaleArgument', () => {
  // Preload hands `process.argv` to this to learn the session's language before the
  // renderer's first render. A window that names no usable language must read English
  // (the source every catalog falls back to), never an unknown code that would load no
  // catalog and show raw message IDs in a production build.
  it('names the wire format main writes and preload reads', () => {
    expect(LOCALE_ARGUMENT_PREFIX).toBe('--kangentic-locale=');
  });

  it('reads the language the command line names, among the other arguments a window carries', () => {
    expect(readLocaleArgument([
      'electron',
      '--kangentic-error-reporting',
      '--kangentic-locale=zh-CN',
      '--kangentic-ephemeral',
    ])).toBe('zh-CN');
    expect(readLocaleArgument(['--kangentic-locale=pt-BR'])).toBe('pt-BR');
  });

  it('reads English for a language no catalog exists for', () => {
    expect(readLocaleArgument(['--kangentic-locale=klingon'])).toBe('en');
  });

  it('reads English when the command line names no language', () => {
    expect(readLocaleArgument([])).toBe('en');
    expect(readLocaleArgument(['electron', '--kangentic-error-reporting'])).toBe('en');
  });

  it('reads English when the prefix carries an empty code', () => {
    expect(readLocaleArgument(['--kangentic-locale='])).toBe('en');
  });
});

describe('the language handlers', () => {
  function configStore(saveResult = true): LanguageConfigStore & { saved: Partial<AppConfig>[] } {
    const saved: Partial<AppConfig>[] = [];
    return {
      saved,
      load: () => ({ ...DEFAULT_CONFIG }),
      save: (partial) => {
        saved.push(partial);
        return saveResult;
      },
    };
  }

  it('readLanguageInfo reports the session language, the shipped list, and the suggestion from current config', () => {
    const info = readLanguageInfo({
      activeLocale: 'en',
      config: { ...DEFAULT_CONFIG },
      systemLanguages: ['zh-Hans-CN'],
      shippedLocales: ['en', 'zh-CN'],
    });
    expect(info).toEqual({ locale: 'en', shippedLocales: ['en', 'zh-CN'], suggestion: 'zh-CN' });
    expect(readLanguageInfo({
      activeLocale: 'en',
      config: { ...DEFAULT_CONFIG, hasAnsweredLanguageSuggestion: true },
      systemLanguages: ['zh-Hans-CN'],
      shippedLocales: ['en', 'zh-CN'],
    }).suggestion).toBeNull();
  });

  it('saveLanguageForRestart saves the language and answers the suggestion', () => {
    const store = configStore();
    expect(saveLanguageForRestart(store, 'zh-CN', ['en', 'zh-CN'])).toBe('zh-CN');
    expect(store.saved).toEqual([{ displayLanguage: 'zh-CN', hasAnsweredLanguageSuggestion: true }]);
  });

  it('saveLanguageForRestart refuses a language that does not ship, and a save that did not land', () => {
    expect(() => saveLanguageForRestart(configStore(), 'ja', ['en'])).toThrow(/shipped language/);
    expect(() => saveLanguageForRestart(configStore(), 42, ['en'])).toThrow(/shipped language/);
    expect(() => saveLanguageForRestart(configStore(false), 'en', ['en'])).toThrow(/could not be saved/);
  });
});

describe("main's translator", () => {
  const temporaryDirectories: string[] = [];
  const label = msg`Toggle settings`;
  const plural = msg`${{ count: 3 }} tasks`;

  function catalogDirectory(catalogs: Record<string, Record<string, string>>): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-main-i18n-'));
    temporaryDirectories.push(directory);
    for (const [locale, messages] of Object.entries(catalogs)) {
      fs.writeFileSync(path.join(directory, `${locale}.json`), JSON.stringify({ messages }));
    }
    return directory;
  }

  afterEach(() => {
    initMainI18n({ displayLanguage: 'en', catalogDirectory: catalogDirectory({}) });
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('starts in a shipped language from its compiled catalog and tells each window', () => {
    const directory = catalogDirectory({ en: {}, 'zh-CN': { [label.id]: '切换设置' } });
    expect(initMainI18n({ displayLanguage: 'zh-CN', catalogDirectory: directory, shippedLocales: ['en', 'zh-CN'] })).toBe('zh-CN');
    expect(getActiveLocale()).toBe('zh-CN');
    expect(localeArgument()).toBe('--kangentic-locale=zh-CN');
    expect(translateText(label)).toBe('切换设置');
    // Text an agent reads stays English whatever the session's language.
    expect(englishText(label)).toBe('Toggle settings');
  });

  it("tells each window the language it started in, in the form preload's readLocaleArgument reads back", () => {
    initMainI18n({
      displayLanguage: 'zh-CN',
      shippedLocales: ['en', 'zh-CN'],
      catalogDirectory: catalogDirectory({ en: {}, 'zh-CN': {} }),
    });
    expect(readLocaleArgument([localeArgument()])).toBe('zh-CN');

    // A language that fell back to English tells its windows English, not the saved choice.
    initMainI18n({
      displayLanguage: 'zh-CN',
      shippedLocales: ['en', 'zh-CN'],
      catalogDirectory: catalogDirectory({ en: {} }),
    });
    expect(readLocaleArgument([localeArgument()])).toBe('en');
  });

  it('falls back to English when the language has no compiled catalog', () => {
    const directory = catalogDirectory({ en: {} });
    expect(initMainI18n({ displayLanguage: 'zh-CN', catalogDirectory: directory, shippedLocales: ['en', 'zh-CN'] })).toBe('en');
    expect(translateText(label)).toBe('Toggle settings');
  });

  it('renders a descriptor its catalog lacks from its own English, placeholders filled', () => {
    initMainI18n({ displayLanguage: undefined, catalogDirectory: catalogDirectory({}) });
    expect(translateText(plural)).toBe('3 tasks');
    expect(englishText(plural)).toBe('3 tasks');
    expect(translateText('a plain string passes through')).toBe('a plain string passes through');
  });
});
