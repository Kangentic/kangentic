/**
 * Unit tests for the token/context-window display formatters.
 */
import { describe, it, expect } from 'vitest';
import {
  formatTokenCount,
  formatContextWindow,
  isContextWindowKnown,
  isContextWindowOverBudget,
  contextWindowDisplayPercent,
  modelContextBadgeLabel,
  modelRowLabel,
  modelAliasTitle,
  aliasRowView,
  modelVersionSectionLabel,
  buildOfferedIdsByDisplayName,
} from '../../src/renderer/utils/format-tokens';
import { groupModelIds } from '../../src/shared/model-id';

describe('buildOfferedIdsByDisplayName', () => {
  it('maps the lowercased, trimmed display name to its id', () => {
    const idsByName = buildOfferedIdsByDisplayName(
      ['claude-opus-5-5', 'claude-sonnet-5-5'],
      { 'claude-opus-5-5': '  Opus 5.5 ', 'claude-sonnet-5-5': 'SONNET 5.5' },
    );
    expect(idsByName.get('opus 5.5')).toBe('claude-opus-5-5');
    expect(idsByName.get('sonnet 5.5')).toBe('claude-sonnet-5-5');
    expect(idsByName.size).toBe(2);
  });

  it('skips an id with no display name, so no name is invented for it', () => {
    const idsByName = buildOfferedIdsByDisplayName(
      ['claude-opus-5-5', 'mystery-model'],
      { 'claude-opus-5-5': 'Opus 5.5' },
    );
    expect(Array.from(idsByName.values())).toEqual(['claude-opus-5-5']);
  });

  it('ignores a display name for an id that is not offered', () => {
    const idsByName = buildOfferedIdsByDisplayName(
      ['claude-opus-5-5'],
      { 'claude-opus-5-5': 'Opus 5.5', 'claude-fable-5': 'Fable 5' },
    );
    expect(idsByName.has('fable 5')).toBe(false);
  });

  it('gives a shared name to the shortest id, whichever order the ids arrive in', () => {
    const displayNames = {
      'claude-opus-4-8': 'Opus 4.8',
      'claude-opus-4-8-20250101': 'Opus 4.8',
    };
    // The longer dated pin comes first, so a first-wins rule would pick it.
    expect(buildOfferedIdsByDisplayName(['claude-opus-4-8-20250101', 'claude-opus-4-8'], displayNames).get('opus 4.8'))
      .toBe('claude-opus-4-8');
    expect(buildOfferedIdsByDisplayName(['claude-opus-4-8', 'claude-opus-4-8-20250101'], displayNames).get('opus 4.8'))
      .toBe('claude-opus-4-8');
  });
});

describe('aliasRowView', () => {
  const displayNames = { opus: 'Opus', 'claude-opus-5-5': 'Opus 5.5' };
  const aliases = [{ id: 'opus', resolvesTo: 'claude-opus-5-5' }];

  it('shows the bare family label, the version it runs today, and a hover title naming both', () => {
    expect(aliasRowView(aliases[0], aliases, displayNames)).toEqual({
      label: 'Opus',
      target: 'Opus 5.5',
      title: 'Latest Opus, currently Opus 5.5',
    });
  });

  it('has a null target when the agent did not report what the alias resolves to', () => {
    const bareAlias = { id: 'opus' };
    expect(aliasRowView(bareAlias, [bareAlias], displayNames)).toEqual({
      label: 'Opus',
      target: null,
      title: 'Latest Opus',
    });
  });

  it('falls back to the raw id for the label and title when no display name is known', () => {
    const unnamed = { id: 'workhorse' };
    expect(aliasRowView(unnamed, [], {})).toEqual({
      label: 'workhorse',
      target: null,
      title: 'workhorse',
    });
  });
});

describe('modelVersionSectionLabel', () => {
  it('says "Specific versions" when aliases sit above the section, "Older versions" when they do not', () => {
    expect(modelVersionSectionLabel(true)).toBe('Specific versions');
    expect(modelVersionSectionLabel(false)).toBe('Older versions');
  });
});

describe('modelAliasTitle', () => {
  const displayNames = { opus: 'Opus', 'claude-opus-5-5': 'Opus 5.5' };

  it('names the version a floating alias runs today', () => {
    expect(modelAliasTitle('opus', [{ id: 'opus', resolvesTo: 'claude-opus-5-5' }], displayNames))
      .toBe('Latest Opus, currently Opus 5.5');
  });

  it('says only "Latest" when the agent did not report a target', () => {
    expect(modelAliasTitle('opus', [{ id: 'opus' }], displayNames)).toBe('Latest Opus');
  });

  it('is null for a value that is not one of the aliases, such as a pinned id', () => {
    expect(modelAliasTitle('claude-opus-5-5', [{ id: 'opus', resolvesTo: 'claude-opus-5-5' }], displayNames)).toBeNull();
  });
});

describe('formatTokenCount', () => {
  it('renders sub-thousand counts verbatim', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(850)).toBe('850');
  });

  it('renders thousands with a lowercase k, dropping a trailing .0', () => {
    expect(formatTokenCount(1200)).toBe('1.2k');
    expect(formatTokenCount(45300)).toBe('45.3k');
    expect(formatTokenCount(200000)).toBe('200k');
  });

  it('renders millions with an uppercase M', () => {
    expect(formatTokenCount(1200000)).toBe('1.2M');
  });
});

describe('formatContextWindow', () => {
  it('formats a 1M window as an uppercase "1M" badge', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
  });

  it('formats a 200K window as an uppercase "200K" badge', () => {
    expect(formatContextWindow(200_000)).toBe('200K');
    expect(formatContextWindow(400_000)).toBe('400K');
  });

  it('keeps one decimal for non-round sizes', () => {
    expect(formatContextWindow(128_000)).toBe('128K');
    expect(formatContextWindow(1_500_000)).toBe('1.5M');
  });

  it('returns null for the unknown (non-positive) sentinel so callers render no badge', () => {
    expect(formatContextWindow(0)).toBeNull();
    expect(formatContextWindow(-1)).toBeNull();
    expect(formatContextWindow(Number.NaN)).toBeNull();
  });
});

describe('isContextWindowKnown', () => {
  it('is known for any positive window size, regardless of usage', () => {
    expect(isContextWindowKnown(1_000_000)).toBe(true);
    expect(isContextWindowKnown(200_000)).toBe(true);
  });

  it('rejects the 0/negative "unknown size" sentinel', () => {
    expect(isContextWindowKnown(0)).toBe(false);
    expect(isContextWindowKnown(-1)).toBe(false);
  });
});

describe('isContextWindowOverBudget', () => {
  it('flags usedTokens exceeding a known window', () => {
    expect(isContextWindowOverBudget(200_000, 250_000)).toBe(true);
  });

  it('is not over budget when tokens fit the window, or the window is unknown', () => {
    expect(isContextWindowOverBudget(1_000_000, 85_000)).toBe(false);
    expect(isContextWindowOverBudget(0, 85_000)).toBe(false);
  });

  it('is not over budget when usedTokens exactly equals the window (strict >, not >=)', () => {
    // Pins the strict-inequality boundary: a session that has used exactly its
    // full window has not exceeded it. Flipping the predicate's `>` to `>=`
    // would turn this red while leaving every other case in this file green.
    expect(isContextWindowOverBudget(200_000, 200_000)).toBe(false);
  });
});

describe('contextWindowDisplayPercent', () => {
  it('rounds the reported percentage for a known, in-budget window', () => {
    expect(contextWindowDisplayPercent(1_000_000, 85_000, 8.5)).toBe(9);
    expect(contextWindowDisplayPercent(200_000, 130_000, 65)).toBe(65);
  });

  it('returns 0 for an unknown window regardless of the reported percentage', () => {
    expect(contextWindowDisplayPercent(0, 100_000, 42)).toBe(0);
    expect(contextWindowDisplayPercent(-1, 100_000, 42)).toBe(0);
  });

  it('forces 100 when usedTokens exceeds a known window', () => {
    expect(contextWindowDisplayPercent(200_000, 250_000, 325)).toBe(100);
  });

  it('caps a known, in-budget window whose reported percentage still exceeds 100', () => {
    // usedTokens fits the window (not over budget), but Claude's authoritative
    // used_percentage can exceed 100 against an auto-compact-adjusted
    // denominator. The cap keeps the label from reading e.g. 105%. Reverting the
    // Math.min to a plain Math.round turns this case red.
    expect(contextWindowDisplayPercent(200_000, 190_000, 105)).toBe(100);
  });
});

describe('modelContextBadgeLabel', () => {
  // Regression pin: a `[1m]`-only row (no separate bare alias exists) carries a
  // structurally-certain 1M window from its id string alone, so it must badge
  // "1M" even with zero telemetry. A prior regression dropped this check and
  // fell through to the telemetry lookup, which returned null (no badge) for a
  // row that had never been probed. Red-green verified: removing the
  // `if (group.primaryIsOneMillion) return '1M';` early-return in
  // format-tokens.ts made this assertion fail (received null), and restoring
  // it made it pass.
  it('badges a [1m]-only row as "1M" from the id alone, with no telemetry', () => {
    const [group] = groupModelIds(['claude-opus-4-8[1m]']);
    expect(modelContextBadgeLabel(group, {})).toBe('1M');
  });

  it('suppresses the badge when a separate selectable [1m] chip exists', () => {
    const [group] = groupModelIds(['claude-opus-4-8', 'claude-opus-4-8[1m]']);
    expect(modelContextBadgeLabel(group, {})).toBeNull();
  });

  it('badges a bare-alias-only row from telemetry when a window is known', () => {
    const [group] = groupModelIds(['claude-opus-4-8']);
    expect(modelContextBadgeLabel(group, { 'claude-opus-4-8': 200_000 })).toBe('200K');
  });

  it('renders no badge for a bare-alias-only row with no telemetry yet', () => {
    const [group] = groupModelIds(['claude-opus-4-8']);
    expect(modelContextBadgeLabel(group, {})).toBeNull();
  });
});

describe('modelRowLabel', () => {
  it('uses the agent-provided display name when known', () => {
    expect(modelRowLabel('claude-opus-4-8', { 'claude-opus-4-8': 'Opus 4.8' })).toBe('Opus 4.8');
  });

  it('falls back to the raw id when no display name is known', () => {
    expect(modelRowLabel('claude-opus-4-8', {})).toBe('claude-opus-4-8');
  });

  it('appends the formatted date for a dated pin, even when a display name is known', () => {
    expect(
      modelRowLabel('claude-opus-4-7-20251022', { 'claude-opus-4-7-20251022': 'Opus 4.7' }),
    ).toBe('Opus 4.7 · 2025-10-22');
  });

  it('does not duplicate the date when falling back to the raw id (it already carries the date)', () => {
    expect(modelRowLabel('claude-opus-4-7-20251022', {})).toBe('claude-opus-4-7-20251022');
  });
});
