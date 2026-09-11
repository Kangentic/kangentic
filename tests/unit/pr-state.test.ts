import { describe, it, expect } from 'vitest';
import { prStatePresentation, prMergeReadinessTooltip } from '../../src/renderer/lib/pr-state';
import type { PRMergeReadiness, PRState } from '../../src/shared/types';

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

/**
 * Merge readiness folds into the OPEN chip and nowhere else. The decisions
 * pinned here: `ready` keeps the open hue (one hue per card, and the promise
 * is the same green), `blocked` is amber, `conflicts` is orange rather than
 * red so it cannot be mistaken for `closed` at a glance, an undetermined or
 * pending verdict keeps plain `open`, and a stale verdict on a non-open PR is
 * ignored outright.
 */
describe('prStatePresentation with merge readiness', () => {
  const EVERY_READINESS: Array<PRMergeReadiness | null | undefined> = [
    'ready', 'blocked', 'conflicting', 'unknown', null, undefined,
  ];

  it('open + ready keeps the open hue and relabels the chip', () => {
    expect(prStatePresentation('open', 'ready')).toEqual({
      label: 'ready',
      badgeClass: 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20',
    });
    expect(prStatePresentation('open', 'ready').badgeClass).toBe(prStatePresentation('open').badgeClass);
  });

  it('open + blocked is amber', () => {
    expect(prStatePresentation('open', 'blocked')).toEqual({
      label: 'blocked',
      badgeClass: 'bg-amber-400/10 text-amber-400 ring-1 ring-amber-400/20',
    });
  });

  it('open + conflicting is orange, never the red that closed uses', () => {
    const result = prStatePresentation('open', 'conflicting');
    expect(result).toEqual({
      label: 'conflicts',
      badgeClass: 'bg-orange-400/10 text-orange-400 ring-1 ring-orange-400/20',
    });
    expect(result.badgeClass).not.toContain('red');
  });

  it.each([['unknown'], [null], [undefined]] as Array<[PRMergeReadiness | null | undefined]>)(
    'open + %s is byte-identical to the one-argument open chip',
    (readiness) => {
      expect(prStatePresentation('open', readiness)).toEqual(prStatePresentation('open'));
    },
  );

  it.each(['draft', 'merged', 'closed'] as PRState[])('%s ignores every readiness value', (state) => {
    for (const readiness of EVERY_READINESS) {
      expect(prStatePresentation(state, readiness), `${state} + ${String(readiness)}`).toEqual(prStatePresentation(state));
    }
  });

  it('an unlinked state renders no badge whatever the readiness says', () => {
    for (const readiness of EVERY_READINESS) {
      expect(prStatePresentation(null, readiness)).toEqual({ label: '', badgeClass: '' });
      expect(prStatePresentation(undefined, readiness)).toEqual({ label: '', badgeClass: '' });
    }
  });

  it('keeps the exact label + badgeClass key shape for every open verdict', () => {
    for (const readiness of EVERY_READINESS) {
      expect(Object.keys(prStatePresentation('open', readiness)).sort()).toEqual(['badgeClass', 'label']);
    }
  });
});

describe('prMergeReadinessTooltip', () => {
  it.each(['ready', 'blocked', 'conflicting'] as PRMergeReadiness[])(
    'names the caveat for an open PR judged %s',
    (readiness) => {
      const tooltip = prMergeReadinessTooltip('open', readiness);
      expect(tooltip).toContain('last PR refresh');
    },
  );

  it('says nothing while the verdict is pending or unjudged', () => {
    expect(prMergeReadinessTooltip('open', 'unknown')).toBeUndefined();
    expect(prMergeReadinessTooltip('open', null)).toBeUndefined();
    expect(prMergeReadinessTooltip('open', undefined)).toBeUndefined();
  });

  it('says nothing for a non-open PR even with a stale verdict', () => {
    for (const state of ['draft', 'merged', 'closed', null, undefined] as Array<PRState | null | undefined>) {
      expect(prMergeReadinessTooltip(state, 'ready'), String(state)).toBeUndefined();
    }
  });
});
