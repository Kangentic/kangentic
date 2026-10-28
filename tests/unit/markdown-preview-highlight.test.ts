/**
 * Which Monaco language colorizes a markdown fence in the Changes panel's
 * document preview.
 *
 * `monacoLanguageForFence` is the pure half of the highlighter: it turns a
 * fence's info string into one of the languages Monaco registered, or null when
 * Monaco has no tokenizer for it. These pin the match order (id, then alias,
 * then file extension), the case and whitespace tolerance, and the null answers.
 *
 * The fixture is a small hand-built list shaped like `monaco.languages.getLanguages()`.
 * Order inside it is deliberate: wherever one rule must beat another, the
 * language the weaker rule would match is listed first, so a lookup that merged
 * the rules into one pass over the list would return the wrong language.
 */
import { describe, it, expect } from 'vitest';
import { monacoLanguageForFence } from '../../src/renderer/components/dialogs/task-detail/changes/markdown-preview-highlight';

type MonacoLanguages = Parameters<typeof monacoLanguageForFence>[0];

const LANGUAGES: MonacoLanguages = [
  // The empty alias is what makes the blank-fence guard observable: without
  // it an empty info string would match this entry and answer 'plaintext'.
  { id: 'plaintext', aliases: ['', 'Plain Text', 'text'], extensions: ['.txt'] },
  // Holds the extension `.md`, listed before the language that owns the alias
  // `md`, so an alias must beat an extension for the answer to be 'markdown'.
  { id: 'mdx', aliases: ['MDX'], extensions: ['.mdx', '.md'] },
  { id: 'markdown', aliases: ['Markdown', 'md'], extensions: ['.markdown'] },
  // Holds the alias `ini`, listed before the language whose id is `ini`, so an
  // id must beat an alias for the answer to be 'ini'.
  { id: 'properties', aliases: ['Properties', 'ini'], extensions: ['.properties'] },
  { id: 'ini', aliases: ['Ini'], extensions: ['.ini'] },
  // No `ts` alias on purpose, so `ts` and `tsx` can only be found by extension.
  { id: 'typescript', aliases: ['TypeScript'], extensions: ['.ts', '.tsx'] },
  { id: 'javascript', aliases: ['JavaScript', 'js'], extensions: ['.js', '.jsx'] },
  { id: 'rust', aliases: ['Rust'], extensions: ['.rs'] },
  // A language with neither aliases nor extensions, as Monaco registers a few.
  { id: 'bare' },
];

describe('monacoLanguageForFence', () => {
  it('finds a language by its id', () => {
    expect(monacoLanguageForFence(LANGUAGES, 'typescript')).toBe('typescript');
    expect(monacoLanguageForFence(LANGUAGES, 'rust')).toBe('rust');
    expect(monacoLanguageForFence(LANGUAGES, 'bare')).toBe('bare');
  });

  it('finds a language by an alias and answers with its id', () => {
    expect(monacoLanguageForFence(LANGUAGES, 'TypeScript')).toBe('typescript');
    expect(monacoLanguageForFence(LANGUAGES, 'js')).toBe('javascript');
    expect(monacoLanguageForFence(LANGUAGES, 'Plain Text')).toBe('plaintext');
  });

  it('finds a language by a file extension written without its dot', () => {
    expect(monacoLanguageForFence(LANGUAGES, 'ts')).toBe('typescript');
    expect(monacoLanguageForFence(LANGUAGES, 'tsx')).toBe('typescript');
    expect(monacoLanguageForFence(LANGUAGES, 'rs')).toBe('rust');
  });

  it('prefers an id match over an alias another language holds', () => {
    // `properties` lists `ini` as an alias and comes first in the list.
    expect(monacoLanguageForFence(LANGUAGES, 'ini')).toBe('ini');
  });

  it('prefers an alias match over an extension another language holds', () => {
    // `mdx` lists `.md` as an extension and comes first in the list.
    expect(monacoLanguageForFence(LANGUAGES, 'md')).toBe('markdown');
  });

  it('ignores the case of the fence, the ids, the aliases and the extensions', () => {
    expect(monacoLanguageForFence(LANGUAGES, 'TYPESCRIPT')).toBe('typescript');
    expect(monacoLanguageForFence(LANGUAGES, 'typescript')).toBe('typescript');
    expect(monacoLanguageForFence(LANGUAGES, 'JS')).toBe('javascript');
    expect(monacoLanguageForFence(LANGUAGES, 'TSX')).toBe('typescript');
    expect(monacoLanguageForFence(LANGUAGES, 'plain text')).toBe('plaintext');
  });

  it('ignores whitespace around the fence', () => {
    expect(monacoLanguageForFence(LANGUAGES, '  typescript  ')).toBe('typescript');
    expect(monacoLanguageForFence(LANGUAGES, '\tts\n')).toBe('typescript');
  });

  it('answers null for a fence Monaco has no tokenizer for', () => {
    expect(monacoLanguageForFence(LANGUAGES, 'cobol')).toBeNull();
    expect(monacoLanguageForFence(LANGUAGES, 'type script')).toBeNull();
  });

  it('answers null for an empty list of languages', () => {
    expect(monacoLanguageForFence([], 'typescript')).toBeNull();
  });

  it('answers null for a blank fence, even when a language lists an empty alias', () => {
    expect(monacoLanguageForFence(LANGUAGES, '')).toBeNull();
    expect(monacoLanguageForFence(LANGUAGES, '   ')).toBeNull();
    expect(monacoLanguageForFence(LANGUAGES, '\n')).toBeNull();
  });
});
