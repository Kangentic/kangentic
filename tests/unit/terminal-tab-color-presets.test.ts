/**
 * Unit tests for the TerminalTab terminal-color preset helpers
 * (src/renderer/components/settings/tabs/TerminalTab.tsx):
 * `getThemeMatchColor` and `presetsWithDefaultFirst`.
 *
 * Both are pure functions previously exercised only indirectly, by clicking
 * through a real theme in tests/ui/settings-panel.spec.ts. Direct unit tests
 * pin the two edge cases the docstring calls out: the theme-match slot is
 * skipped when it duplicates the default (so the picker never shows the same
 * color twice), and the resulting preset list always has exactly
 * PRESET_COLORS.length entries regardless of which branch runs (the "two
 * clean rows in a 6-column grid" invariant).
 */
import { describe, it, expect } from 'vitest';
import { getThemeMatchColor, presetsWithDefaultFirst } from '../../src/renderer/components/settings/tabs/TerminalTab';
import { THEME_BACKGROUNDS, THEME_FOREGROUNDS } from '../../src/shared/types';
import { PRESET_COLORS } from '../../src/renderer/components/backlog/manage-labels/ColorPickerPopover';

describe('getThemeMatchColor', () => {
  it('resolves the background key against THEME_BACKGROUNDS', () => {
    expect(getThemeMatchColor('background', 'dark')).toBe(THEME_BACKGROUNDS.dark);
    expect(getThemeMatchColor('background', 'light')).toBe(THEME_BACKGROUNDS.light);
  });

  it('resolves the foreground key against THEME_FOREGROUNDS', () => {
    expect(getThemeMatchColor('foreground', 'dark')).toBe(THEME_FOREGROUNDS.dark);
    expect(getThemeMatchColor('foreground', 'light')).toBe(THEME_FOREGROUNDS.light);
  });

  it('resolves the cursor key against THEME_FOREGROUNDS (mirrors foreground)', () => {
    expect(getThemeMatchColor('cursor', 'dark')).toBe(THEME_FOREGROUNDS.dark);
    expect(getThemeMatchColor('cursor', 'light')).toBe(THEME_FOREGROUNDS.light);
  });
});

describe('presetsWithDefaultFirst', () => {
  it('puts the default first and drops the theme-match slot when it duplicates the default', () => {
    const result = presetsWithDefaultFirst('#e4e4e7', '#e4e4e7');
    expect(result[0]).toBe('#e4e4e7');
    // The leading PRESET_COLORS gray is retained (only the trailing one is dropped)
    // when the theme-match slot is skipped.
    expect(result).toEqual(['#e4e4e7', ...PRESET_COLORS.slice(0, -1)]);
  });

  it('puts the default then the theme-match color first when they differ', () => {
    const result = presetsWithDefaultFirst('#0c0c0c', '#18181b');
    expect(result[0]).toBe('#0c0c0c');
    expect(result[1]).toBe('#18181b');
    // Both the leading and trailing PRESET_COLORS gray are dropped so a third
    // preset never spills onto its own near-empty row.
    expect(result).toEqual(['#0c0c0c', '#18181b', ...PRESET_COLORS.slice(1, -1)]);
  });

  it('always yields exactly PRESET_COLORS.length entries, regardless of branch', () => {
    const equalBranch = presetsWithDefaultFirst('#e4e4e7', '#e4e4e7');
    const differingBranch = presetsWithDefaultFirst('#0c0c0c', '#18181b');
    expect(equalBranch).toHaveLength(PRESET_COLORS.length);
    expect(differingBranch).toHaveLength(PRESET_COLORS.length);
  });

  it('never contains a duplicate color in either branch', () => {
    const equalBranch = presetsWithDefaultFirst('#e4e4e7', '#e4e4e7');
    const differingBranch = presetsWithDefaultFirst('#0c0c0c', '#18181b');
    expect(new Set(equalBranch).size).toBe(equalBranch.length);
    expect(new Set(differingBranch).size).toBe(differingBranch.length);
  });
});
