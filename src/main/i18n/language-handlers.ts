/**
 * What the two `language:*` IPC handlers do, kept out of `src/main/index.ts` so it
 * can be tested without Electron. index.ts registers them beside the Graphics
 * acceleration handler, which shares the restart path.
 */
import type { AppConfig, LanguageInfo } from '../../shared/types';
import {
  SHIPPED_LOCALES,
  computeLanguageSuggestion,
  isAppLocale,
  type AppLocale,
} from '../../shared/i18n/locales';

export interface LanguageConfigStore {
  load(): AppConfig;
  save(partial: Partial<AppConfig>): boolean;
}

export interface ReadLanguageInfoInput {
  activeLocale: AppLocale;
  config: AppConfig;
  /** `app.getPreferredSystemLanguages()`. */
  systemLanguages: readonly string[];
  shippedLocales?: readonly AppLocale[];
}

/** `language:getInfo`. The suggestion reads the current config on every call. */
export function readLanguageInfo(input: ReadLanguageInfoInput): LanguageInfo {
  const shippedLocales = input.shippedLocales ?? SHIPPED_LOCALES;
  return {
    locale: input.activeLocale,
    shippedLocales: [...shippedLocales],
    suggestion: computeLanguageSuggestion({
      systemLanguages: input.systemLanguages,
      displayLanguage: input.config.displayLanguage,
      hasAnsweredLanguageSuggestion: input.config.hasAnsweredLanguageSuggestion,
      shippedLocales,
    }),
  };
}

/**
 * The save half of `language:setAndRestart`. Throws, so the invoke rejects and the
 * app stays up, when the language does not ship or the write did not reach disk:
 * a restart after a failed save would come back in the old language with the
 * failure toast lost in the quit. Choosing a language also answers the
 * first-launch suggestion.
 */
export function saveLanguageForRestart(
  configStore: LanguageConfigStore,
  locale: unknown,
  shippedLocales: readonly AppLocale[] = SHIPPED_LOCALES,
): AppLocale {
  if (!isAppLocale(locale) || !shippedLocales.includes(locale)) {
    throw new Error(`setLanguageAndRestart expects a shipped language, got ${JSON.stringify(locale)}`);
  }
  if (!configStore.save({ displayLanguage: locale, hasAnsweredLanguageSuggestion: true })) {
    throw new Error('The display language could not be saved');
  }
  return locale;
}
