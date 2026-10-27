/**
 * The main process's translator: native menus, message boxes and notifications.
 *
 * Main reads the display language once at startup and keeps it for the session;
 * a change applies through a restart (`language-handlers.ts`). Its catalogs are
 * the merged JSON `lingui compile` writes beside the bundle
 * (`.vite/build/locales/<locale>.json`, see `catalogsMergePath` in
 * lingui.config.ts), since esbuild cannot import the PO files the renderer loads.
 * See docs/architecture/i18n.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { i18n, type Messages } from '@lingui/core';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import {
  LOCALE_ARGUMENT_PREFIX,
  SOURCE_LOCALE,
  resolveActiveLocale,
  type AppLocale,
} from '../../shared/i18n/locales';
import { englishI18n } from '../../shared/i18n/english';
import { resolveText, type LocalizedText, type TextValues } from '../../shared/i18n/text';

// A descriptor the compiled catalog lacks (a dev session before `lingui compile`)
// falls back to its own English, which needs compiling to fill placeholders.
i18n.setMessagesCompiler(compileMessage);
englishI18n.setMessagesCompiler(compileMessage);
// Active from the first import, so a translation that runs before startup
// finishes reads English instead of throwing ("without setting a locale").
i18n.activate(SOURCE_LOCALE);

let activeLocale: AppLocale = SOURCE_LOCALE;

/** Where `lingui compile` writes the merged catalogs: beside the main bundle. */
export function defaultCatalogDirectory(): string {
  return path.join(__dirname, 'locales');
}

/**
 * One locale's compiled catalog, or null when the file is missing or unreadable.
 * `lingui compile --namespace json` writes `{ "messages": { <id>: <compiled> } }`.
 */
export function readCompiledCatalog(catalogDirectory: string, locale: AppLocale): Messages | null {
  const filePath = path.join(catalogDirectory, `${locale}.json`);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'messages' in parsed) {
      const messages = (parsed as { messages: unknown }).messages;
      if (messages && typeof messages === 'object') return messages as Messages;
    }
    return null;
  } catch {
    return null;
  }
}

export interface InitMainI18nOptions {
  /** `AppConfig.displayLanguage`. */
  displayLanguage: unknown;
  catalogDirectory?: string;
  shippedLocales?: readonly AppLocale[];
}

/**
 * Load and activate the session's language. Called once in `app.whenReady`,
 * before any window exists, since each window is told the language on its
 * command line. A language whose catalog is missing starts in English, and the
 * log line says which branch it took.
 */
export function initMainI18n(options: InitMainI18nOptions): AppLocale {
  const catalogDirectory = options.catalogDirectory ?? defaultCatalogDirectory();
  const englishMessages = readCompiledCatalog(catalogDirectory, SOURCE_LOCALE);
  if (englishMessages) englishI18n.load(SOURCE_LOCALE, englishMessages);

  let locale = resolveActiveLocale(options.displayLanguage, options.shippedLocales);
  let messages = locale === SOURCE_LOCALE ? englishMessages : readCompiledCatalog(catalogDirectory, locale);
  if (!messages && locale !== SOURCE_LOCALE) {
    console.warn(`[I18N] No compiled catalog for ${locale} in ${catalogDirectory}; starting in English.`);
    locale = SOURCE_LOCALE;
    messages = englishMessages;
  }
  i18n.loadAndActivate({ locale, messages: messages ?? {} });
  activeLocale = locale;
  console.log(`[I18N] locale=${locale} catalog=${messages ? 'compiled' : 'none (source English)'}`);
  return locale;
}

/** The language this session runs in. */
export function getActiveLocale(): AppLocale {
  return activeLocale;
}

/** Translate UI text main shows the user (a menu label, a dialog, a notification). */
export function translateText(text: LocalizedText, values?: TextValues): string {
  return resolveText(i18n, text, values);
}

/** The `additionalArguments` entry that tells a window the session's language. */
export function localeArgument(): string {
  return `${LOCALE_ARGUMENT_PREFIX}${activeLocale}`;
}
