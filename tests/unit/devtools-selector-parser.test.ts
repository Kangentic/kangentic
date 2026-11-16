/**
 * Unit tests for `parseSelectorSpec` in src/devtools/main/cdp.ts.
 *
 * The parser is the agent-facing entry point for the devtools MCP
 * selector vocabulary. Selector strings come from external input
 * (agent prompts), so the regex grammar needs explicit fixture-style
 * coverage for the edge cases that are easy to break:
 *
 *   - quoted vs. unquoted values (text=Cancel vs text="Cancel")
 *   - single vs. double quotes
 *   - text=, text*=, aria= prefixes
 *   - the :has-text(...) Playwright alias
 *   - whitespace around the spec
 *   - plain CSS fallthrough
 *   - empty values
 *
 * Mocks `electron` because cdp.ts imports its types from there at the
 * top of the module. The module body itself does not touch the runtime
 * Electron API, so a minimal mock keeps the test plain Node.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0') },
}));

import { parseSelectorSpec } from '../../src/devtools/main/cdp';

describe('parseSelectorSpec', () => {
  describe('CSS fallthrough', () => {
    it('treats a plain CSS selector as kind:css', () => {
      expect(parseSelectorSpec('button.primary')).toEqual({
        kind: 'css',
        value: 'button.primary',
      });
    });

    it('treats a multi-segment CSS selector as kind:css', () => {
      expect(parseSelectorSpec('div[data-testid="task-card"] > button')).toEqual({
        kind: 'css',
        value: 'div[data-testid="task-card"] > button',
      });
    });

    it('trims surrounding whitespace before classifying', () => {
      expect(parseSelectorSpec('  .save-btn  ')).toEqual({
        kind: 'css',
        value: '.save-btn',
      });
    });
  });

  describe('text= (exact)', () => {
    it('unquoted text=Cancel', () => {
      expect(parseSelectorSpec('text=Cancel')).toEqual({
        kind: 'text',
        value: 'Cancel',
      });
    });

    it('double-quoted text="Cancel"', () => {
      expect(parseSelectorSpec('text="Cancel"')).toEqual({
        kind: 'text',
        value: 'Cancel',
      });
    });

    it("single-quoted text='Cancel'", () => {
      expect(parseSelectorSpec("text='Cancel'")).toEqual({
        kind: 'text',
        value: 'Cancel',
      });
    });

    it('preserves spaces inside the value', () => {
      expect(parseSelectorSpec('text="Save changes"')).toEqual({
        kind: 'text',
        value: 'Save changes',
      });
    });

    it('preserves spaces inside an unquoted value', () => {
      expect(parseSelectorSpec('text=Save changes')).toEqual({
        kind: 'text',
        value: 'Save changes',
      });
    });
  });

  describe('text*= (substring)', () => {
    it('unquoted text*=Save', () => {
      expect(parseSelectorSpec('text*=Save')).toEqual({
        kind: 'text-contains',
        value: 'Save',
      });
    });

    it('double-quoted text*="Save"', () => {
      expect(parseSelectorSpec('text*="Save"')).toEqual({
        kind: 'text-contains',
        value: 'Save',
      });
    });
  });

  describe('aria= (accessible name)', () => {
    it('unquoted aria=Cancel', () => {
      expect(parseSelectorSpec('aria=Cancel')).toEqual({
        kind: 'aria',
        value: 'Cancel',
      });
    });

    it('double-quoted aria="Cancel"', () => {
      expect(parseSelectorSpec('aria="Cancel"')).toEqual({
        kind: 'aria',
        value: 'Cancel',
      });
    });

    it('preserves spaces in aria= values', () => {
      expect(parseSelectorSpec('aria="Close dialog"')).toEqual({
        kind: 'aria',
        value: 'Close dialog',
      });
    });
  });

  describe(':has-text(...) alias', () => {
    it('aliases :has-text("Save") to kind:text-contains', () => {
      expect(parseSelectorSpec(':has-text("Save")')).toEqual({
        kind: 'text-contains',
        value: 'Save',
      });
    });

    it("aliases :has-text('Save') to kind:text-contains", () => {
      expect(parseSelectorSpec(":has-text('Save')")).toEqual({
        kind: 'text-contains',
        value: 'Save',
      });
    });

    it('keeps the CSS before a trailing :has-text as its scope', () => {
      // It used to be dropped, so a selector scoped to an open dialog matched a
      // same-text button anywhere on the page (GitHub #820).
      expect(parseSelectorSpec('[role=dialog] button:has-text("Save")')).toStrictEqual({
        kind: 'text-contains',
        value: 'Save',
        scope: '[role=dialog] button',
      });
    });

    it.each([
      ['a space', '[role=dialog] :has-text("Save")', '[role=dialog] *'],
      ['a child combinator', 'form > :has-text("Save")', 'form > *'],
      ['a child combinator with no space', 'form>:has-text("Save")', 'form> *'],
      ['a sibling combinator', 'h2 ~ :has-text("Save")', 'h2 ~ *'],
      ['an adjacent-sibling combinator', 'h2 + :has-text("Save")', 'h2 + *'],
    ])('scopes a :has-text after %s to the elements it reaches, never the scope element itself', (_name, selector, scope) => {
      // `[role=dialog] :has-text("Save")` means elements INSIDE the dialog. A
      // scope of `[role=dialog]` alone matched the dialog, whose text contains
      // "Save", and a click landed on its centre.
      expect(parseSelectorSpec(selector)).toStrictEqual({ kind: 'text-contains', value: 'Save', scope });
    });

    it('leaves a :has-text in the middle of a selector unscoped rather than guessing a combinator', () => {
      expect(parseSelectorSpec('div:has-text("Save") > button')).toStrictEqual({
        kind: 'text-contains',
        value: 'Save',
      });
    });
  });

  describe('edge cases', () => {
    it('empty quoted value yields an empty value', () => {
      expect(parseSelectorSpec('text=""')).toEqual({
        kind: 'text',
        value: '',
      });
    });

    it('selector that happens to start with text without = stays CSS', () => {
      expect(parseSelectorSpec('textarea')).toEqual({
        kind: 'css',
        value: 'textarea',
      });
    });

    it('selector starting with aria but no = stays CSS', () => {
      expect(parseSelectorSpec('aria-label')).toEqual({
        kind: 'css',
        value: 'aria-label',
      });
    });

    it('CSS selector with [aria-label="..."] does not match aria= prefix', () => {
      expect(parseSelectorSpec('button[aria-label="Save"]')).toEqual({
        kind: 'css',
        value: 'button[aria-label="Save"]',
      });
    });
  });
});
