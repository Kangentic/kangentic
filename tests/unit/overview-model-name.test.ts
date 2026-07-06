import { describe, it, expect } from 'vitest';
import { formatModelName } from '../../src/renderer/components/dialogs/board-manager/ColumnsOverview';

describe('formatModelName', () => {
  it('humanizes Claude model ids to friendly names', () => {
    expect(formatModelName('claude-fable-5')).toBe('Fable 5');
    expect(formatModelName('claude-opus-4-8')).toBe('Opus 4.8');
    expect(formatModelName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(formatModelName('claude-haiku-4-5')).toBe('Haiku 4.5');
  });

  it('surfaces a context-window bracket variant', () => {
    expect(formatModelName('claude-opus-4-8[1m]')).toBe('Opus 4.8 (1M)');
  });

  it('drops a trailing date stamp', () => {
    expect(formatModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('title-cases a non-Claude id and trims', () => {
    expect(formatModelName('gpt-5')).toBe('Gpt 5');
    expect(formatModelName('  claude-opus-4-8  ')).toBe('Opus 4.8');
  });

  it('returns the input when nothing meaningful can be derived', () => {
    expect(formatModelName('')).toBe('');
  });

  it('returns the trimmed input verbatim when the vendor-prefix strip leaves no segments', () => {
    // 'claude-' strips to '' after removing the 'claude-' prefix; split('-')
    // on an empty string yields [''], which .filter(Boolean) drops entirely,
    // so segments.length === 0 short-circuits to the raw trimmed input.
    expect(formatModelName('claude-')).toBe('claude-');
  });

  it('returns the trimmed input verbatim when the whole id is a bracket suffix (bracketMatch is never consulted)', () => {
    // bracketMatch DOES match '[1m]' -> '1m', but `base` (the string with the
    // bracket stripped) becomes '', which also yields zero segments. The
    // segments.length === 0 branch returns `trimmed` immediately, before the
    // label/bracketMatch formatting is ever reached - so the bracket is NOT
    // rendered as "(1M)" here, unlike the `claude-opus-4-8[1m]` case above.
    expect(formatModelName('[1m]')).toBe('[1m]');
  });

  it('returns the trimmed input verbatim when every segment is a >=6-digit date stamp', () => {
    // '20260703' survives segmenting (one non-empty segment), but it is an
    // 8-digit all-numeric run, so the `segment.length < 6` date-stamp guard
    // drops it from versionParts and it never reaches nameParts either
    // (it's numeric). Both parts end empty, so `label` is '' and the
    // `if (!label) return trimmed;` fallback fires.
    expect(formatModelName('20260703')).toBe('20260703');
  });
});
