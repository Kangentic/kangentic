/**
 * Curated dictation language set for the multilingual models, ordered
 * common-first by the current user base (US/UK English, Brazil Portuguese,
 * Colombia Spanish, Italy, France) then the other high-resource languages that
 * Whisper transcribes well. Multilingual Whisper technically covers ~99
 * languages, but the long tail is low-accuracy on the small builds we run, so
 * this is the offered subset. Codes are Whisper / BCP-47 language codes.
 *
 * Single source of truth: the model registry stamps `MULTILINGUAL_LANGUAGE_CODES`
 * onto the multilingual models, and the settings UI renders + orders the dropdown
 * from this list. Add an entry here to offer a new language (and confirm the
 * model supports it).
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { LocalizedText } from './i18n/text';

export interface DictationLanguage {
  code: string;
  /** Resolved where it shows (`translateText`). */
  label: MessageDescriptor;
}

export const DICTATION_LANGUAGES: readonly DictationLanguage[] = [
  { code: 'en', label: msg({ message: 'English', context: 'spoken language' }) },
  { code: 'pt', label: msg({ message: 'Portuguese', context: 'spoken language' }) },
  { code: 'es', label: msg({ message: 'Spanish', context: 'spoken language' }) },
  { code: 'it', label: msg({ message: 'Italian', context: 'spoken language' }) },
  { code: 'fr', label: msg({ message: 'French', context: 'spoken language' }) },
  { code: 'de', label: msg({ message: 'German', context: 'spoken language' }) },
  { code: 'nl', label: msg({ message: 'Dutch', context: 'spoken language' }) },
  { code: 'ru', label: msg({ message: 'Russian', context: 'spoken language' }) },
  { code: 'pl', label: msg({ message: 'Polish', context: 'spoken language' }) },
  { code: 'uk', label: msg({ message: 'Ukrainian', context: 'spoken language' }) },
  { code: 'tr', label: msg({ message: 'Turkish', context: 'spoken language' }) },
  { code: 'zh', label: msg({ message: 'Chinese', context: 'spoken language' }) },
  { code: 'ja', label: msg({ message: 'Japanese', context: 'spoken language' }) },
  { code: 'ko', label: msg({ message: 'Korean', context: 'spoken language' }) },
  { code: 'ar', label: msg({ message: 'Arabic', context: 'spoken language' }) },
];

/** Every language the multilingual models expose (the curated set above).
 *  Whisper and Nemotron 3.5 both cover all of it. */
export const MULTILINGUAL_LANGUAGE_CODES: readonly string[] = DICTATION_LANGUAGES.map(
  (language) => language.code,
);

/** The part of the curated set NVIDIA Parakeet TDT 0.6B v3 transcribes. It
 *  covers 25 European languages, so it has none of zh, ja, ko, ar or tr. The
 *  registry stamps this onto the model, and the Best preset reads it to pick a
 *  refinement model per language. */
export const PARAKEET_V3_LANGUAGE_CODES: readonly string[] = ['en', 'pt', 'es', 'it', 'fr', 'de', 'nl', 'ru', 'pl', 'uk'];

/** The part of the curated set Cohere Transcribe transcribes: 12 of its 14
 *  languages (it also has Greek and Vietnamese), so none of ru, uk or tr. */
export const COHERE_TRANSCRIBE_LANGUAGE_CODES: readonly string[] = ['en', 'pt', 'es', 'it', 'fr', 'de', 'nl', 'pl', 'zh', 'ja', 'ko', 'ar'];

/** Display label for a code, falling back to the raw code. */
export function languageLabel(code: string): LocalizedText {
  return DICTATION_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

/** Filter + order a set of codes into the canonical common-first order. */
export function orderLanguages(codes: readonly string[]): DictationLanguage[] {
  return DICTATION_LANGUAGES.filter((language) => codes.includes(language.code));
}
