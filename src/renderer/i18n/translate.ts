import { i18n } from '@lingui/core';
import { resolveText, type LocalizedText, type TextValues } from '../../shared/i18n/text';

/**
 * Resolve a `LocalizedText` a registry or shared list carries, in the session's
 * language, where it renders. Lingui's own macros (`<Trans>`, `useLingui`, `msg`)
 * need nothing from here.
 *
 * Deliberately free of `import.meta.glob`, so a module that Playwright or the
 * capture rig loads outside Vite can import it. The locale is active by the time
 * anything renders: src/renderer/i18n/catalogs.ts activates English when it loads,
 * and the vitest setup loads it before every test.
 */
export function translateText(text: LocalizedText, values?: TextValues): string {
  return resolveText(i18n, text, values);
}
