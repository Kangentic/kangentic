/**
 * A session language every message is translated into, for tests that prove a
 * reader stays English while the UI does not.
 *
 * The shipped catalogs are untranslated today (every msgstr is empty), so
 * `translateText` and `englishText` return the same English and no test can tell
 * them apart. This builds a catalog from the real English one, so it covers every
 * message a test could reach without recomputing a single id, and puts a marker in
 * front of each. A reader on the UI's translator then returns the marker, and a
 * reader on `englishText` / `englishI18n` returns plain English.
 *
 * Messages are compiled, either a string or an array of parts, so putting the
 * marker first is a prefix on the string or one more leading part. That keeps
 * ICU placeholders and plurals working without a messages compiler on the
 * instance (a compiler would re-read a plain string as ICU).
 */
import { i18n, type Messages } from '@lingui/core';
import { loadLocaleMessages } from '../../../src/renderer/i18n/catalogs';
import type { AppLocale } from '../../../src/shared/i18n/locales';

/** The locale the pseudo catalog is activated under. Any non-English app locale works. */
export const PSEUDO_LOCALE: AppLocale = 'de';

/** What every pseudo-translated message starts with. */
export const PSEUDO_MARKER = '[de] ';

type CompiledMessage = Messages[string];

function markMessage(message: CompiledMessage): CompiledMessage {
  if (typeof message === 'string') return PSEUDO_MARKER + message;
  if (Array.isArray(message)) return [PSEUDO_MARKER, ...message] as CompiledMessage;
  throw new Error('A compiled catalog message is neither a string nor an array of parts; teach pseudo-locale.ts about its shape.');
}

/** Make the pseudo language the UI's (the global `i18n`), as a session in that language would be. */
export async function activatePseudoLocale(): Promise<void> {
  const english = await loadLocaleMessages('en');
  const messages: Messages = {};
  for (const [id, message] of Object.entries(english)) messages[id] = markMessage(message);
  i18n.loadAndActivate({ locale: PSEUDO_LOCALE, messages });
}

/** Put the UI back on English, as the vitest setup leaves it. */
export function restoreEnglishLocale(): void {
  i18n.activate('en');
}
