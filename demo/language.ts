/**
 * The web build's answer to Restart now on a display language. The desktop saves the language and
 * restarts, and every window comes back in it. A page cannot restart, so the frame loads the picked
 * catalog into the renderer's own i18n instance and switches in place, with nothing reloaded.
 *
 * It is the renderer's own boot path, run late: `activateLocale` loads the locale's area chunks
 * and activates them, and `<html lang>` follows, as src/renderer/index.tsx sets it before the
 * first render (CJK glyph choice depends on it). One Vite build bundles both, so this module and
 * the renderer share one `@lingui/core` and one catalogs module. `useLingui()` and `<Trans>`
 * consumers re-render on the change, and so does everything they render.
 *
 * demo/boot.js calls it from its `language.setLanguageAndRestart` wrapper, through the loader
 * demo/language-entry.ts defines, so no frame fetches it until a visitor confirms a switch.
 */
import { i18n } from '@lingui/core';
import { activateLocale } from '../src/renderer/i18n';
import type { AppLocale } from '../src/shared/i18n/locales';

export async function switchLanguage(locale: AppLocale): Promise<void> {
  await activateLocale(locale);
  document.documentElement.lang = i18n.locale;
}
