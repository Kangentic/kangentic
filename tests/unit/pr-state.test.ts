import { describe, it, expect } from 'vitest';
import { prStatePresentation } from '../../src/renderer/lib/pr-state';
import type { PRState } from '../../src/shared/types';

describe('prStatePresentation', () => {
  describe('named states - label strings', () => {
    it('open state returns label "open"', () => {
      const result = prStatePresentation('open');
      expect(result.label).toBe('open');
    });

    it('draft state returns label "draft"', () => {
      const result = prStatePresentation('draft');
      expect(result.label).toBe('draft');
    });

    it('merged state returns label "merged"', () => {
      const result = prStatePresentation('merged');
      expect(result.label).toBe('merged');
    });

    it('closed state returns label "closed"', () => {
      const result = prStatePresentation('closed');
      expect(result.label).toBe('closed');
    });
  });

  describe('named states - badgeClass hue tokens', () => {
    it('open state badgeClass includes emerald (green hue)', () => {
      const result = prStatePresentation('open');
      expect(result.badgeClass).toContain('emerald');
      expect(result.badgeClass.length).toBeGreaterThan(0);
    });

    it('draft state badgeClass includes fg-muted (gray/muted hue)', () => {
      const result = prStatePresentation('draft');
      expect(result.badgeClass).toContain('fg-muted');
      expect(result.badgeClass.length).toBeGreaterThan(0);
    });

    it('merged state badgeClass includes purple', () => {
      const result = prStatePresentation('merged');
      expect(result.badgeClass).toContain('purple');
      expect(result.badgeClass.length).toBeGreaterThan(0);
    });

    it('closed state badgeClass includes red', () => {
      const result = prStatePresentation('closed');
      expect(result.badgeClass).toContain('red');
      expect(result.badgeClass.length).toBeGreaterThan(0);
    });
  });

  describe('named states - exact return values', () => {
    it('open returns the exact expected object', () => {
      expect(prStatePresentation('open')).toEqual({
        label: 'open',
        badgeClass: 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20',
      });
    });

    it('draft returns the exact expected object', () => {
      expect(prStatePresentation('draft')).toEqual({
        label: 'draft',
        badgeClass: 'bg-fg-muted/10 text-fg-muted ring-1 ring-fg-muted/20',
      });
    });

    it('merged returns the exact expected object', () => {
      expect(prStatePresentation('merged')).toEqual({
        label: 'merged',
        badgeClass: 'bg-purple-400/10 text-purple-400 ring-1 ring-purple-400/20',
      });
    });

    it('closed returns the exact expected object', () => {
      expect(prStatePresentation('closed')).toEqual({
        label: 'closed',
        badgeClass: 'bg-red-400/10 text-red-400 ring-1 ring-red-400/20',
      });
    });
  });

  describe('null / undefined / unknown - no-badge contract', () => {
    it('null returns empty label and empty badgeClass', () => {
      expect(prStatePresentation(null)).toEqual({ label: '', badgeClass: '' });
    });

    it('undefined returns empty label and empty badgeClass', () => {
      expect(prStatePresentation(undefined)).toEqual({ label: '', badgeClass: '' });
    });

    it('an arbitrary out-of-union string returns empty label and empty badgeClass', () => {
      // Cast to satisfy the type checker while exercising the default branch.
      expect(prStatePresentation('unknown-state' as PRState)).toEqual({ label: '', badgeClass: '' });
    });
  });

  describe('return shape invariants across all named states', () => {
    const allNamedStates: PRState[] = ['open', 'draft', 'merged', 'closed'];

    for (const state of allNamedStates) {
      it(`${state} result has exactly the keys "label" and "badgeClass"`, () => {
        const result = prStatePresentation(state);
        const resultKeys = Object.keys(result).sort();
        expect(resultKeys).toEqual(['badgeClass', 'label']);
      });
    }

    it('every named state returns a non-empty label and non-empty badgeClass', () => {
      for (const state of allNamedStates) {
        const result = prStatePresentation(state);
        expect(result.label.length, `label for "${state}" should be non-empty`).toBeGreaterThan(0);
        expect(result.badgeClass.length, `badgeClass for "${state}" should be non-empty`).toBeGreaterThan(0);
      }
    });
  });
});
