import { describe, it, expect } from 'vitest';
import { monacoThemeForTheme, selectDiffAlgorithmOptions } from '../../src/renderer/components/dialogs/task-detail/changes/diff-render-options';
import { THEME_BASES } from '../../src/shared/types';
import type { ThemeMode } from '../../src/shared/types';

describe('selectDiffAlgorithmOptions', () => {
  it('uses the advanced algorithm with no computation-time bound for a small diff', () => {
    expect(selectDiffAlgorithmOptions(100, 200)).toEqual({ diffAlgorithm: 'advanced' });
  });

  it('drops to the legacy algorithm with a bounded computation time for a large diff', () => {
    expect(selectDiffAlgorithmOptions(150_000, 150_000)).toEqual({
      diffAlgorithm: 'legacy',
      maxComputationTime: 2_000,
    });
  });

  it('is exactly at the boundary when combined length equals the threshold (still advanced)', () => {
    expect(selectDiffAlgorithmOptions(100_000, 100_000)).toEqual({ diffAlgorithm: 'advanced' });
  });
});

describe('monacoThemeForTheme', () => {
  // Driven from THEME_BASES itself (the real source of truth for light-vs-dark),
  // not from a re-typed literal map, so a newly added ThemeMode is covered here
  // automatically and this cannot silently agree with a broken mapping.
  const expectedMonacoTheme: Record<ThemeMode, 'vs' | 'vs-dark'> = Object.fromEntries(
    Object.entries(THEME_BASES).map(([theme, base]) => [theme, base === 'dark' ? 'vs-dark' : 'vs']),
  ) as Record<ThemeMode, 'vs' | 'vs-dark'>;

  it.each(Object.keys(THEME_BASES) as ThemeMode[])('resolves %s to its THEME_BASES-derived Monaco theme', (theme) => {
    expect(monacoThemeForTheme(theme)).toBe(expectedMonacoTheme[theme]);
  });

  // The regression this pins: 'dark' and 'light' are hardcoded settings-dropdown
  // options and are NOT listed in NAMED_THEMES, so a lookup keyed off that list
  // (the pre-fix implementation) missed exactly these two ids. 'light' is the
  // one that shipped broken - it fell through to the 'dark' fallback and
  // rendered a black diff pane inside an otherwise light app.
  it('resolves the built-in light theme to vs, not the vs-dark fallback', () => {
    expect(monacoThemeForTheme('light')).toBe('vs');
  });

  it('resolves the built-in dark theme to vs-dark', () => {
    expect(monacoThemeForTheme('dark')).toBe('vs-dark');
  });

  it('falls back to vs-dark for an id THEME_BASES does not recognize', () => {
    expect(monacoThemeForTheme('not-a-real-theme' as ThemeMode)).toBe('vs-dark');
  });
});
