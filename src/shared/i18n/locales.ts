/**
 * The display languages Kangentic can show, and how an OS language maps onto them.
 *
 * Pure data and pure functions, with no Lingui import: main, preload, the renderer
 * and `lingui.config.ts` all read this one list. See docs/architecture/i18n.md.
 */

/**
 * Every locale with a catalog, in the order VS Code lists its language packs.
 * English is the source language; `lingui extract` keeps a PO file for each of
 * the others, so `src/locales/<locale>/` exists for all of them.
 */
export const APP_LOCALES = [
  'en',
  'zh-CN',
  'zh-TW',
  'fr',
  'de',
  'it',
  'es',
  'ja',
  'ko',
  'ru',
  'pt-BR',
  'tr',
  'pl',
  'cs',
  'hu',
] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

/** The language the source is written in and every catalog falls back to. */
export const SOURCE_LOCALE: AppLocale = 'en';

/**
 * Each language's own name, never translated, as VS Code shows it in its
 * language picker. The picker prints it beside the lowercase code.
 */
export const LOCALE_NATIVE_NAMES: Readonly<Record<AppLocale, string>> = {
  en: 'English',
  'zh-CN': '中文(简体)',
  'zh-TW': '中文(繁體)',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  es: 'Español',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
  'pt-BR': 'Português (Brasil)',
  tr: 'Türkçe',
  pl: 'Polski',
  cs: 'Čeština',
  hu: 'Magyar',
};

/**
 * The languages a user can pick, and the only ones the first-launch suggestion
 * offers. A locale joins this list once its catalog is translated (#919); until
 * then its PO files exist but every entry falls back to English, so offering it
 * would switch the user to an English UI.
 */
export const SHIPPED_LOCALES: readonly AppLocale[] = ['en'];

/**
 * The command-line argument main gives every window (`additionalArguments`) to
 * carry the session's language, so preload can hand it to the renderer
 * synchronously, before its first render.
 */
export const LOCALE_ARGUMENT_PREFIX = '--kangentic-locale=';

const APP_LOCALE_SET: ReadonlySet<string> = new Set(APP_LOCALES);

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && APP_LOCALE_SET.has(value);
}

/**
 * The locale a window's command line names (`LOCALE_ARGUMENT_PREFIX`, which
 * main's `localeArgument()` appends), or English when it names none or an
 * unknown one. Preload reads it from `process.argv`.
 */
export function readLocaleArgument(commandLine: readonly string[]): AppLocale {
  const localeArgument = commandLine.find((argument) => argument.startsWith(LOCALE_ARGUMENT_PREFIX));
  const localeCode = localeArgument?.slice(LOCALE_ARGUMENT_PREFIX.length);
  return isAppLocale(localeCode) ? localeCode : SOURCE_LOCALE;
}

/** The lowercase code the picker prints after a language's name (`zh-cn`). */
export function localeDisplayCode(locale: AppLocale): string {
  return locale.toLowerCase();
}

/** Regions that read Traditional Chinese, by the region subtag an OS reports. */
const TRADITIONAL_CHINESE_REGIONS: ReadonlySet<string> = new Set(['tw', 'hk', 'mo']);

/**
 * Map one BCP 47 tag (`zh-Hans-CN`, `pt-PT`, `en_US`) onto a catalog locale, or
 * null when no catalog covers it. Chinese splits by script, then by region, since
 * a Hong Kong reader reads Traditional; every Portuguese maps to pt-BR and every
 * Spanish to es, the one catalog each language has.
 */
function mapLanguageTag(tag: string): AppLocale | null {
  const subtags = tag.trim().replace(/_/g, '-').toLowerCase().split('-').filter((subtag) => subtag !== '');
  const language = subtags[0];
  if (!language) return null;
  if (language === 'zh') {
    const rest = subtags.slice(1);
    if (rest.includes('hant')) return 'zh-TW';
    if (rest.includes('hans')) return 'zh-CN';
    return rest.some((subtag) => TRADITIONAL_CHINESE_REGIONS.has(subtag)) ? 'zh-TW' : 'zh-CN';
  }
  if (language === 'pt') return 'pt-BR';
  return APP_LOCALES.find((locale) => locale.toLowerCase() === language) ?? null;
}

/**
 * The catalog locale for the OS's preferred languages
 * (`app.getPreferredSystemLanguages()`, most preferred first): the first one
 * `candidates` holds, or null when none is. By default a candidate is any locale
 * with a catalog.
 */
export function matchSystemLocale(
  preferredLanguages: readonly string[],
  candidates: readonly AppLocale[] = APP_LOCALES,
): AppLocale | null {
  for (const tag of preferredLanguages) {
    const locale = mapLanguageTag(tag);
    if (locale && candidates.includes(locale)) return locale;
  }
  return null;
}

/**
 * The language a session runs in: the saved choice when it is a shipped
 * language, otherwise English. A config naming a language this build does not
 * ship (hand-edited, or written by a newer build) starts in English rather than
 * in an untranslated UI.
 */
export function resolveActiveLocale(
  displayLanguage: unknown,
  shippedLocales: readonly AppLocale[] = SHIPPED_LOCALES,
): AppLocale {
  return isAppLocale(displayLanguage) && shippedLocales.includes(displayLanguage)
    ? displayLanguage
    : SOURCE_LOCALE;
}

export interface LanguageSuggestionInput {
  /** `app.getPreferredSystemLanguages()`, most preferred first. */
  systemLanguages: readonly string[];
  /** `AppConfig.displayLanguage`: unset until the user picks a language. */
  displayLanguage: unknown;
  /** `AppConfig.hasAnsweredLanguageSuggestion`. */
  hasAnsweredLanguageSuggestion: boolean | undefined;
  shippedLocales?: readonly AppLocale[];
}

/**
 * The language the first-launch toast offers, or null for no toast. Kangentic
 * always starts in English and never switches on its own: it offers the OS
 * language once, only while the user has never picked a language and never
 * answered the offer. The OS language is the most preferred one that ships, so
 * a preferred language with no translation yet does not hide a shipped one
 * after it. English counts as shipped, so a user who prefers English before
 * any shipped language is offered nothing.
 */
export function computeLanguageSuggestion(input: LanguageSuggestionInput): AppLocale | null {
  if (input.hasAnsweredLanguageSuggestion === true) return null;
  if (input.displayLanguage !== undefined && input.displayLanguage !== null) return null;
  const shippedLocales = input.shippedLocales ?? SHIPPED_LOCALES;
  const match = matchSystemLocale(input.systemLanguages, [SOURCE_LOCALE, ...shippedLocales]);
  if (!match || match === SOURCE_LOCALE) return null;
  return match;
}
