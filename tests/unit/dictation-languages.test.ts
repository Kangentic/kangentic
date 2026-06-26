import { describe, it, expect } from 'vitest';
import {
  DICTATION_LANGUAGES,
  MULTILINGUAL_LANGUAGE_CODES,
  orderLanguages,
  languageLabel,
} from '../../src/shared/dictation-languages';

describe('MULTILINGUAL_LANGUAGE_CODES', () => {
  it('is derived from DICTATION_LANGUAGES (every code appears in the language list)', () => {
    // MULTILINGUAL_LANGUAGE_CODES is DICTATION_LANGUAGES.map(l => l.code), so the
    // two arrays must be identical in length and content order.
    expect([...MULTILINGUAL_LANGUAGE_CODES]).toEqual(
      DICTATION_LANGUAGES.map((language) => language.code),
    );
  });

  it('contains the expected common-first codes', () => {
    // The curated set is ordered: EN, PT, ES, IT, FR, DE, ... The first five
    // reflect the primary user base (US/UK, Brazil, Colombia, Italy, France).
    const codes = [...MULTILINGUAL_LANGUAGE_CODES];
    expect(codes).toContain('en');
    expect(codes).toContain('pt');
    expect(codes).toContain('es');
    expect(codes).toContain('fr');
    expect(codes).toContain('de');
  });

  it('English is listed first (most common language in the user base)', () => {
    expect(MULTILINGUAL_LANGUAGE_CODES[0]).toBe('en');
  });
});

describe('orderLanguages', () => {
  it('returns matching entries in the canonical DICTATION_LANGUAGES order, not input order', () => {
    // Input is deliberately reversed relative to the canonical order.
    // orderLanguages must sort by DICTATION_LANGUAGES position, not input position.
    const codes = ['fr', 'en']; // 'en' is before 'fr' in canonical order
    const ordered = orderLanguages(codes);
    expect(ordered.map((language) => language.code)).toEqual(['en', 'fr']);
  });

  it('filters out codes not in DICTATION_LANGUAGES', () => {
    const codes = ['en', 'xyz', 'fr'];
    const ordered = orderLanguages(codes);
    expect(ordered.map((language) => language.code)).not.toContain('xyz');
    expect(ordered).toHaveLength(2);
  });

  it('returns full DictationLanguage objects with code and label', () => {
    const ordered = orderLanguages(['en']);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].code).toBe('en');
    expect(ordered[0].label).toBe('English');
  });

  it('returns an empty array when no input codes are in the canonical list', () => {
    expect(orderLanguages(['xyz', 'abc'])).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(orderLanguages([])).toEqual([]);
  });

  it('preserves canonical order across a larger subset', () => {
    // Provide es, de, pt in reverse canonical order (canonical: en, pt, es, ..., de).
    // Expected output must follow canonical order: pt, es, de.
    const codes = ['de', 'es', 'pt'];
    const ordered = orderLanguages(codes);
    expect(ordered.map((language) => language.code)).toEqual(['pt', 'es', 'de']);
  });

  it('includes every known code when passed the full MULTILINGUAL_LANGUAGE_CODES array', () => {
    const ordered = orderLanguages([...MULTILINGUAL_LANGUAGE_CODES]);
    expect(ordered).toHaveLength(MULTILINGUAL_LANGUAGE_CODES.length);
    expect(ordered.map((language) => language.code)).toEqual([...MULTILINGUAL_LANGUAGE_CODES]);
  });
});

describe('languageLabel', () => {
  it('returns the display label for a known code', () => {
    expect(languageLabel('en')).toBe('English');
    expect(languageLabel('fr')).toBe('French');
    expect(languageLabel('de')).toBe('German');
    expect(languageLabel('zh')).toBe('Chinese');
    expect(languageLabel('ja')).toBe('Japanese');
  });

  it('falls back to the raw code for an unknown code', () => {
    // A stale or unsupported code that is not in DICTATION_LANGUAGES should
    // surface the raw code string rather than undefined or an empty string.
    expect(languageLabel('xyz')).toBe('xyz');
    expect(languageLabel('tlh')).toBe('tlh');
  });

  it('is case-sensitive: a mis-cased code falls back to the raw code', () => {
    // The canonical codes are lower-case BCP-47. Upper-case 'EN' is not a match.
    expect(languageLabel('EN')).toBe('EN');
  });
});
