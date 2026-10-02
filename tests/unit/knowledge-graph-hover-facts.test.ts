/**
 * The hover card's number formatting, and the one case that took the whole
 * surface down.
 *
 * `formatCostWithTokens` is typed `number | null` because that is what the
 * projection's SQL produces, but a node arriving in the renderer is a JSON
 * payload: a field that is ABSENT rather than null comes through as `undefined`.
 * A `=== null` guard does not catch that, so the value reached
 * `usd.toLocaleString()` and threw - inside `HoverCard`, where
 * `PanelErrorBoundary` caught it and unmounted the entire Knowledge Graph. The
 * symptom was the panel flashing open and disappearing on a node hover, which
 * reads as a selection bug rather than a crash.
 */

import { describe, it, expect } from 'vitest';
import {
  formatCostWithTokens,
  formatCost,
  formatCompactCount,
  formatDuration,
} from '../../src/renderer/components/knowledge-graph/KnowledgeGraphCanvas';

// `formatCost` renders through `toLocaleString(undefined, ...)`, so its digits,
// grouping and decimal marks follow the PROCESS locale. These expectations ask
// the same runtime for the number's text instead of hard-coding en-US ('1,206.50'
// reads '1.206,50' under de-DE), so the suite passes on any developer machine
// and on CI. The dollar sign and the sub-cent collapse are the contract under
// test and stay literal.
const CENT_PRECISION = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function dollars(amount: number): string {
  return `$${CENT_PRECISION.format(amount)}`;
}

describe('hover card facts', () => {
  it('does not throw when a conversation recorded no cost', () => {
    // The crash, in its two reachable shapes. `undefined` is the one that shipped.
    expect(() => formatCostWithTokens(undefined, undefined)).not.toThrow();
    expect(formatCostWithTokens(undefined, undefined)).toBeNull();
    expect(formatCostWithTokens(null, null)).toBeNull();
  });

  it('still reports tokens when only the cost is missing', () => {
    // Absent and null must behave identically - the row is about what was
    // captured, and "the key is missing" is not a different fact from "it is null".
    expect(formatCostWithTokens(undefined, 70_300_000)).toBe('70.3M tokens');
    expect(formatCostWithTokens(null, 70_300_000)).toBe('70.3M tokens');
  });

  it('folds the token count into the cost when both are present', () => {
    expect(formatCostWithTokens(41.32, 60_100_000)).toBe(`${dollars(41.32)} (60.1M tokens)`);
  });

  it('reports cost alone when the token count is missing', () => {
    expect(formatCostWithTokens(41.32, undefined)).toBe(dollars(41.32));
    expect(formatCostWithTokens(41.32, 0)).toBe(dollars(41.32));
  });

  it('keeps cost to the cent at every scale', () => {
    // Rounding to whole dollars above ten would print "$41" for both 41.01 and
    // 41.04, and these are amounts someone may reconcile against a bill.
    expect(formatCost(41.02)).toBe(dollars(41.02));
    expect(formatCost(1206.5)).toBe(dollars(1206.5));
    // Locale-free statement of the same rule. The pair is chosen so whole-dollar
    // rounding merges it (a pair like 41.02 and 41.98 still differs after
    // rounding, so it would pass against the rounded format too), and the first
    // line pins that the pair really does merge. Only cent precision keeps
    // the two amounts apart.
    expect(Math.round(41.01)).toBe(Math.round(41.04));
    expect(formatCost(41.01)).not.toBe(formatCost(41.04));
    // Only a genuinely sub-cent amount collapses: "$0.00" reads as free.
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0)).toBe(dollars(0));
  });

  it('abbreviates large counts and leaves small ones alone', () => {
    expect(formatCompactCount(999)).toBe('999');
    expect(formatCompactCount(1500)).toBe('1.5k');
    expect(formatCompactCount(70_300_000)).toBe('70.3M');
  });

  it('says wall time the way a person would', () => {
    // Rounds to the nearest minute, so 30s is already "1m"; this is the band
    // that genuinely reports nothing rather than a misleading zero.
    expect(formatDuration(20_000)).toBe('under a minute');
    expect(formatDuration(30_000)).toBe('1m');
    expect(formatDuration(8 * 60 * 60 * 1000 + 7 * 60 * 1000)).toBe('8h 7m');
    expect(formatDuration(2 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000)).toBe('2d 4h');
  });
});
