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
export interface DictationLanguage {
  code: string;
  label: string;
}

export const DICTATION_LANGUAGES: readonly DictationLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ru', label: 'Russian' },
  { code: 'pl', label: 'Polish' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
];

/** Every language the multilingual models expose (the curated set above). */
export const MULTILINGUAL_LANGUAGE_CODES: readonly string[] = DICTATION_LANGUAGES.map(
  (language) => language.code,
);

/** Display label for a code, falling back to the raw code. */
export function languageLabel(code: string): string {
  return DICTATION_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

/** Filter + order a set of codes into the canonical common-first order. */
export function orderLanguages(codes: readonly string[]): DictationLanguage[] {
  return DICTATION_LANGUAGES.filter((language) => codes.includes(language.code));
}
