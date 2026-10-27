/**
 * The renderer's catalogs: which PO files load, when, and into which i18n instance.
 *
 * Each area keeps its own PO file per locale (`src/locales/<locale>/<area>.po`,
 * see lingui.config.ts), and @lingui/vite-plugin compiles each to a module that
 * exports `messages`. A locale's messages are every area's merged.
 *
 * English is bundled into the entry and active from this module's first
 * evaluation, so the first render never waits on it, I18nProvider (which renders
 * nothing until a locale is active) can never paint blank, and the web demo,
 * which runs English only, fetches no catalog. Every other locale is one lazy
 * chunk per area, fetched only when that language runs or is offered.
 * `src-main.po` is main's, compiled to JSON by `lingui compile`, and never loads here.
 * See docs/architecture/i18n.md.
 */
import { i18n, setupI18n, type I18n, type Messages } from '@lingui/core';
import { SOURCE_LOCALE, isAppLocale, type AppLocale } from '../../shared/i18n/locales';
import { englishI18n } from '../../shared/i18n/english';
import { guardPlaceholderBackslashes } from '../../shared/i18n/placeholder-backslash-guard';

interface CatalogModule {
  messages: Messages;
}

const englishCatalogs: Record<string, CatalogModule> =
  // @ts-expect-error -- Vite handles import.meta.glob; tsc carries no Vite client types
  import.meta.glob(['../../locales/en/*.po', '!../../locales/en/src-main.po'], { eager: true });
const otherCatalogs: Record<string, () => Promise<CatalogModule>> =
  // @ts-expect-error -- Vite handles import.meta.glob
  import.meta.glob(['../../locales/*/*.po', '!../../locales/en/*.po', '!../../locales/*/src-main.po']);

/** The locale folder a catalog path names (`../../locales/zh-CN/settings.po`). */
export function catalogLocale(catalogPath: string): string {
  const segments = catalogPath.replace(/\\/g, '/').split('/');
  return segments[segments.length - 2] ?? '';
}

function mergeCatalogs(modules: readonly CatalogModule[]): Messages {
  return Object.assign({}, ...modules.map((module) => module.messages)) as Messages;
}

const englishMessages = mergeCatalogs(Object.values(englishCatalogs));
// hmr-safe: this module never re-evaluates inside a hot update. The entry
// (index.tsx) imports it through ./index.ts and accepts nothing, so an edit here
// or to anything it imports reloads the page (measured with hmr-guest-probe), and
// the boot then runs activateLocale again for the session's language.
// Before anything renders: `useLingui()` binds `i18n.t` when its provider renders.
guardPlaceholderBackslashes(i18n);
i18n.load(SOURCE_LOCALE, englishMessages);
i18n.activate(SOURCE_LOCALE);
englishI18n.load(SOURCE_LOCALE, englishMessages);

/** A locale's messages, every area merged. English is already in memory. */
export async function loadLocaleMessages(locale: AppLocale): Promise<Messages> {
  if (locale === SOURCE_LOCALE) return englishMessages;
  const loaders = Object.entries(otherCatalogs)
    .filter(([catalogPath]) => catalogLocale(catalogPath) === locale)
    .map(([, loadCatalog]) => loadCatalog());
  return mergeCatalogs(await Promise.all(loaders));
}

/**
 * Make `locale` the session's language. Called once, before the first render;
 * the language never changes after that without a restart.
 */
export async function activateLocale(locale: AppLocale): Promise<void> {
  // An unknown value (a hand-edited config) keeps English rather than activating a
  // locale with no catalog, which would show message IDs in a production build.
  if (!isAppLocale(locale) || locale === i18n.locale) return;
  const messages = await loadLocaleMessages(locale);
  i18n.loadAndActivate({ locale, messages });
}

/**
 * A second i18n instance for one other locale, beside the session's. The
 * first-launch suggestion draws its toast and restart prompt with one, in the OS
 * language, while the rest of the UI stays English.
 */
export async function createLocaleI18n(locale: AppLocale): Promise<I18n> {
  const messages = await loadLocaleMessages(locale);
  const localeI18n = setupI18n({ locale, messages: { [locale]: messages } });
  guardPlaceholderBackslashes(localeI18n);
  return localeI18n;
}

/** Kept in step with CATALOG_UPDATE_EVENT in scripts/vite-lingui-catalog-hmr.mjs. */
export const CATALOG_UPDATE_EVENT = 'kangentic:catalog-update';

interface CatalogUpdateDetail {
  catalogPath: string;
  messages: Messages;
}

/**
 * Dev only: a PO file edited under a running dev server arrives here through the
 * catalog hot-update plugin instead of reloading the page. `load` emits `change`,
 * so `<Trans>` and `useLingui()` consumers re-render with the new text. Text read
 * through `translateText` (settings labels, hotkey labels) and toasts already up
 * keep the old text until their component next renders.
 */
function applyCatalogUpdate(event: Event): void {
  const detail = (event as CustomEvent<CatalogUpdateDetail>).detail;
  const locale = catalogLocale(detail.catalogPath);
  if (!isAppLocale(locale)) return;
  if (locale === SOURCE_LOCALE) englishI18n.load(SOURCE_LOCALE, detail.messages);
  if (locale === i18n.locale) i18n.load(locale, detail.messages);
}

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  window.addEventListener(CATALOG_UPDATE_EVENT, applyCatalogUpdate);
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose(() => window.removeEventListener(CATALOG_UPDATE_EVENT, applyCatalogUpdate));
}
