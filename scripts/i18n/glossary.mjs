/**
 * The translation glossary (`scripts/i18n/glossary.json`): names kept exactly as
 * written in every language, and terms with one fixed translation per language.
 *
 * A fixed term's translation is a string, or `{ "term": ..., "match": ... }` for a
 * language that inflects it: `match` is the part every inflected form contains
 * (Polish "gałąź" reads "gałęzi" in the genitive, so it matches "gał"). The check
 * is case-insensitive for fixed terms and exact for kept names.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GLOSSARY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'glossary.json');

export function loadGlossary(glossaryPath = GLOSSARY_PATH) {
  return JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One compiled pattern per term and case rule, reused for every string in a run. */
const wordPatterns = new Map();

/** Whether `english` uses the whole word or phrase `term` (a plural `s` counts). */
function usesWord(english, term, flags) {
  const cacheKey = `${flags}:${term}`;
  let pattern = wordPatterns.get(cacheKey);
  if (!pattern) {
    pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}s?(?![\\p{L}\\p{N}])`, `u${flags}`);
    wordPatterns.set(cacheKey, pattern);
  }
  return pattern.test(english);
}

/** The kept names and fixed terms one English text uses, with what `locale` must say for each. */
export function relevantTerms(english, locale, glossary) {
  const kept = glossary.keep.filter((name) => usesWord(english, name, ''));
  const fixed = [];
  for (const entry of glossary.terms) {
    const translation = entry.translations[locale];
    if (translation === undefined) continue;
    if (![entry.english, ...(entry.alsoMatches ?? [])].some((form) => usesWord(english, form, 'i'))) continue;
    const term = typeof translation === 'string' ? translation : translation.term;
    const match = typeof translation === 'string' ? translation : translation.match;
    fixed.push({ english: entry.english, note: entry.note, term, match });
  }
  return { kept, fixed };
}

/** Errors when a translation drops a kept name or uses something else for a fixed term. */
export function glossaryErrors({ english, translated, locale, glossary, label }) {
  const where = label ? ` in the "${label}" form` : '';
  const { kept, fixed } = relevantTerms(english, locale, glossary);
  const errors = [];
  for (const name of kept) {
    if (!translated.includes(name)) errors.push(`keep the name "${name}" exactly as written${where}`);
  }
  for (const entry of fixed) {
    if (!translated.toLowerCase().includes(entry.match.toLowerCase())) {
      errors.push(`translate "${entry.english}" as "${entry.term}"${where}`);
    }
  }
  return errors;
}
