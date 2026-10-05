import { describe, it, expect } from 'vitest';
import { toPreviewCase } from '../../src/renderer/hooks/useDictation';

/**
 * toPreviewCase recases dictation text that is in the streaming Zipformer's
 * shape (all caps, no sentence punctuation) to sentence case, so the live
 * preview already reads like the refined text that replaces it on release.
 * Everything else is returned untouched: a model that cases or punctuates its
 * own text must not have its "I", names, or acronyms flattened, and a script
 * with no letter case must not have a Latin acronym lowercased inside it.
 */
describe('toPreviewCase', () => {
  describe('recases text in the streaming Zipformer shape', () => {
    it('lowercases an all-caps phrase and capitalizes its first letter', () => {
      expect(toPreviewCase('FIX THE SPACING')).toBe('Fix the spacing');
    });

    it('recases a contraction, since an apostrophe is not sentence punctuation', () => {
      expect(toPreviewCase("I'M HERE")).toBe("I'm here");
    });

    it('recases an all-caps Cyrillic phrase', () => {
      expect(toPreviewCase('ПРИВЕТ МИР')).toBe('Привет мир');
    });

    it('recases an all-caps Greek phrase', () => {
      expect(toPreviewCase('ΓΕΙΑ ΣΟΥ')).toBe('Γεια σου');
    });
  });

  describe('leaves text from a model that cases or punctuates its own output', () => {
    it('keeps mixed-case text that holds a sentence break', () => {
      expect(toPreviewCase('I met Alice. Hello')).toBe('I met Alice. Hello');
    });

    it('keeps mixed-case text with no punctuation at all', () => {
      // No punctuation to hide behind: only the lowercase-letter guard keeps the
      // "I" and the name from being flattened.
      expect(toPreviewCase('I met Alice')).toBe('I met Alice');
    });

    it('keeps a refined acronym, because its final period means a punctuating model wrote it', () => {
      expect(toPreviewCase('API.')).toBe('API.');
    });

    it('keeps an all-caps question, because its question mark is sentence punctuation', () => {
      expect(toPreviewCase('IS IT READY?')).toBe('IS IT READY?');
    });
  });

  describe('leaves a script with no letter case alone', () => {
    it('keeps a Latin acronym inside Chinese text', () => {
      expect(toPreviewCase('我想用GPU')).toBe('我想用GPU');
    });

    it('keeps it when the Chinese text ends in a full-width period', () => {
      expect(toPreviewCase('我想用GPU。')).toBe('我想用GPU。');
    });
  });

  describe('passes through text with nothing to recase', () => {
    it('returns an empty string unchanged', () => {
      expect(toPreviewCase('')).toBe('');
    });

    it('returns digits unchanged', () => {
      expect(toPreviewCase('123')).toBe('123');
    });
  });
});
