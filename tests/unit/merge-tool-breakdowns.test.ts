/**
 * Unit tests for `mergeToolBreakdowns` (src/shared/tool-call-totals.ts), the
 * one place per-tool rows from several session records (and the live run) are
 * summed. The context bar's popover and the Session Summary both read through
 * it, so a field it drops or invents shows up in both tables. Also
 * `sumToolResultTokens`, which sums the popover's Tokens estimates the same way.
 */
import { describe, it, expect } from 'vitest';
import { mergeToolBreakdowns, sumToolResultTokens } from '../../src/shared/tool-call-totals';
import type { PerToolStat } from '../../src/shared/types';

function row(toolName: string, callCount: number, extra: Partial<PerToolStat> = {}): PerToolStat {
  return { toolName, callCount, totalDurationMs: callCount * 100, interruptedCount: 0, ...extra };
}

describe('mergeToolBreakdowns', () => {
  it('sums the required counters of the same tool across groups', () => {
    const merged = mergeToolBreakdowns([
      [row('Read', 26, { totalDurationMs: 4400, interruptedCount: 1 })],
      [row('Read', 4, { totalDurationMs: 600, interruptedCount: 2 })],
    ]);

    expect(merged).toEqual([{ toolName: 'Read', callCount: 30, totalDurationMs: 5000, interruptedCount: 3 }]);
  });

  it('sums an optional field when any row carries it, and omits it when none does', () => {
    // An earlier run that ended at app quit has no estimates; the live run does.
    const merged = mergeToolBreakdowns([
      [row('Read', 2), row('Bash', 1, { waitedCount: 1 })],
      [row('Read', 3, { resultTokens: 900 }), row('Bash', 1, { waitedCount: 2 })],
    ]);

    const read = merged.find((stat) => stat.toolName === 'Read');
    const bash = merged.find((stat) => stat.toolName === 'Bash');
    expect(read?.resultTokens).toBe(900);
    expect(bash?.waitedCount).toBe(3);
    // Never invented: a zero would render as a measured value.
    expect(read).not.toHaveProperty('waitedCount');
    expect(bash).not.toHaveProperty('resultTokens');
    expect(read).not.toHaveProperty('costUsd');
  });

  it('sums the per-tool cost and token fields an adapter reports', () => {
    const merged = mergeToolBreakdowns([
      [row('Edit', 1, { costUsd: 0.25, inputTokens: 10, outputTokens: 5 })],
      [row('Edit', 1, { costUsd: 0.5, inputTokens: 20, outputTokens: 7 })],
    ]);

    expect(merged[0]).toMatchObject({ costUsd: 0.75, inputTokens: 30, outputTokens: 12 });
  });

  it('keeps a tool that appears in only one group', () => {
    const merged = mergeToolBreakdowns([[row('Grep', 25)], [row('Write', 1)]]);

    expect(merged.map((stat) => stat.toolName)).toEqual(['Grep', 'Write']);
  });

  it('sorts by call count, most first, ties by tool name', () => {
    const merged = mergeToolBreakdowns([
      [row('Write', 1), row('Bash', 2)],
      [row('Read', 2), row('Grep', 5)],
    ]);

    expect(merged.map((stat) => stat.toolName)).toEqual(['Grep', 'Bash', 'Read', 'Write']);
  });

  it('does not mutate its inputs', () => {
    const earlier = [row('Read', 2, { resultTokens: 100 })];
    const live = [row('Read', 3, { resultTokens: 50 })];

    mergeToolBreakdowns([earlier, live]);

    expect(earlier[0]).toEqual(row('Read', 2, { resultTokens: 100 }));
    expect(live[0]).toEqual(row('Read', 3, { resultTokens: 50 }));
  });

  it('returns an empty table for no rows', () => {
    expect(mergeToolBreakdowns([])).toEqual([]);
    expect(mergeToolBreakdowns([[], []])).toEqual([]);
  });
});

describe('sumToolResultTokens', () => {
  it('sums each tool across the earlier runs and the live run', () => {
    expect(sumToolResultTokens([{ Read: 57_900, Grep: 13_700 }, { Read: 5, Write: 43 }]))
      .toEqual({ Read: 57_905, Grep: 13_700, Write: 43 });
  });

  it('is null only when no run could be read', () => {
    expect(sumToolResultTokens([null, null])).toBeNull();
    expect(sumToolResultTokens([])).toBeNull();
  });

  it('treats an empty answer as an answer, not as a missing one', () => {
    // A live read that found no tool results yet still says the column is known.
    expect(sumToolResultTokens([null, {}])).toEqual({});
    expect(sumToolResultTokens([{ Read: 100 }, null])).toEqual({ Read: 100 });
  });

  it('keeps a tool named like an Object.prototype member as an ordinary key', () => {
    const summed = sumToolResultTokens([{ constructor: 2 }, JSON.parse('{"__proto__": 3}') as Record<string, number>]);

    expect(Object.hasOwn(summed ?? {}, 'constructor')).toBe(true);
    expect(summed?.constructor).toBe(2);
    expect(Object.hasOwn(summed ?? {}, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(summed)).toBe(Object.prototype);
  });
});
