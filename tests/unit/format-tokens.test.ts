/**
 * Unit tests for the token/context-window display formatters.
 */
import { describe, it, expect } from 'vitest';
import { formatTokenCount, formatContextWindow, isContextWindowTrusted, modelContextBadgeLabel } from '../../src/renderer/utils/format-tokens';
import { groupModelIds } from '../../src/shared/model-id';

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

describe('isContextWindowTrusted', () => {
  it('trusts a positive window that fits the used tokens', () => {
    expect(isContextWindowTrusted(1_000_000, 85_000)).toBe(true);
  });

  it('rejects the 0 sentinel and an impossible over-full window', () => {
    expect(isContextWindowTrusted(0, 85_000)).toBe(false);
    expect(isContextWindowTrusted(200_000, 250_000)).toBe(false);
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
