/**
 * The strings the language restart prompt and the first-launch suggestion draw.
 *
 * Plain descriptors rather than inline macros, because each is drawn through
 * whichever i18n instance the reader needs: the session's language in Settings >
 * Language, and the OS language for the first-launch suggestion, whose reader may
 * not read English. Every one carries the context `Display language prompt`, so
 * its message ID is its own: "Cancel" and "Restart now" also exist in other
 * areas' catalogs, and the renderer merges a locale's areas into one map, where an
 * untranslated copy from another area would otherwise replace the translation
 * here. The extractor reads only a literal context, so each spells it out.
 *
 * tests/unit/i18n-boundaries.test.ts fails when a shipped language does not
 * translate all of them.
 */
import { msg } from '@lingui/core/runtime-macro';

export const LANGUAGE_PROMPT_MESSAGES = {
  /** The suggestion toast's question, drawn twice: as its title in the OS language
   *  and as its body in English. Takes `language`. */
  suggestionQuestion: msg({ message: 'Change the display language to {language}?', context: 'Display language prompt' }),
  /** The suggestion toast's button. */
  changeAndRestart: msg({ message: 'Change and restart', context: 'Display language prompt' }),
  /** The restart prompt's title. Takes `language`. */
  switchTitle: msg({ message: 'Switch to {language}?', context: 'Display language prompt' }),
  restartMessage: msg({ message: 'Kangentic restarts to change the language.', context: 'Display language prompt' }),
  cancel: msg({ message: 'Cancel', context: 'Display language prompt' }),
  restartNow: msg({ message: 'Restart now', context: 'Display language prompt' }),
};
