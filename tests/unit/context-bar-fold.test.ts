/**
 * The context bar's one-row fold (src/renderer/components/terminal/context-bar-fold.ts):
 * what folds into the +N list, in which order, and what never does.
 */
import { describe, expect, it } from 'vitest';
import { resolveContextBarFold, type ContextBarFoldItem } from '../../src/renderer/components/terminal/context-bar-fold';

/** Widths measured on a live Claude bar, the 8px gap before each included. */
const ITEMS: ContextBarFoldItem[] = [
  { id: 'shell', width: 93 },
  { id: 'agent', width: 87 },
  { id: 'version', width: 56 },
  { id: 'rate-limits', width: 164 },
  { id: 'cost', width: 54 },
  { id: 'tool-calls', width: 62 },
  { id: 'tokens', width: 109 },
  { id: 'context-fraction', width: 78 },
  { id: 'context', width: 80 },
  { id: 'elapsed', width: 81 },
];
/** The model and effort pickers, never folded. */
const FIXED = 82 + 8 + 52;
const MORE = 30 + 8;

const fold = (available: number) => [...resolveContextBarFold({ available, fixedWidth: FIXED, items: ITEMS, moreWidth: MORE })];
/** One track per bar at a 40px minimum: each wants 40px more at the 80px comfort width. */
const COMFORT = { 'rate-limits': 40, context: 40 };
const foldWithComfort = (available: number) => [
  ...resolveContextBarFold({ available, fixedWidth: FIXED, items: ITEMS, moreWidth: MORE, meterComfort: COMFORT }),
];

describe('resolveContextBarFold', () => {
  it('folds nothing when the whole row fits, and shows no +N', () => {
    expect(fold(1200)).toEqual([]);
  });

  it('folds the shell first, then the version, then on down the order', () => {
    expect(fold(1005)).toEqual(['shell']);
    expect(fold(950)).toEqual(['shell', 'version']);
    // No active-time pill on this bar, so the elapsed time is next.
    expect(fold(880)).toEqual(['shell', 'version', 'elapsed']);
  });

  it('keeps the agent, model, effort, rate limits and context in a short row, folding the rest', () => {
    expect(fold(550)).toEqual(['shell', 'version', 'elapsed', 'tokens', 'tool-calls', 'cost', 'context-fraction']);
  });

  it('folds the rate limits, then the context, then the agent only under the floor', () => {
    expect(fold(400)).toContain('rate-limits');
    expect(fold(400)).not.toContain('context');
    expect(fold(250)).toEqual(expect.arrayContaining(['rate-limits', 'context']));
    expect(fold(200)).toContain('agent');
  });

  it('counts the +N pill once anything folds', () => {
    // One pixel short of the whole row folds the shell, and the +N takes some of its room back.
    const whole = FIXED + ITEMS.reduce((total, item) => total + item.width, 0);
    expect(fold(whole)).toEqual([]);
    expect(fold(whole - 1)).toEqual(['shell']);
    expect(fold(whole - 93 + MORE - 1)).toEqual(['shell', 'version']);
  });

  it('folds cost and then the context counts before a bar drops under its comfort width', () => {
    // At 600 the bars at their 40px minimum leave room for the counts, so without
    // the comfort width they stay; each bar wanting 40px more folds them too.
    expect(fold(600)).not.toContain('context-fraction');
    expect(foldWithComfort(600)).toEqual(['shell', 'version', 'elapsed', 'tokens', 'tool-calls', 'cost', 'context-fraction']);
  });

  it('never folds the five for the comfort width: once only they are left, a bar narrows to its minimum', () => {
    // The five and the +N pill take 511px with the bars at their minimum.
    for (const available of [511, 520, 560]) {
      const folded = foldWithComfort(available);
      expect(folded).not.toContain('rate-limits');
      expect(folded).not.toContain('context');
      expect(folded).not.toContain('agent');
    }
    expect(foldWithComfort(510)).toContain('rate-limits');
  });

  it('moves the edge in a wide row by the comfort width, and folds nothing with room for it', () => {
    expect(fold(1050)).toEqual([]);
    expect(foldWithComfort(1050)).toEqual(['shell']);
    expect(foldWithComfort(1200)).toEqual([]);
  });

  it('skips a pill the bar does not show', () => {
    const items = ITEMS.filter((item) => item.id !== 'shell');
    const folded = resolveContextBarFold({ available: 800, fixedWidth: FIXED, items, moreWidth: MORE });
    expect(folded.has('shell')).toBe(false);
    expect([...folded][0]).toBe('version');
  });
});
