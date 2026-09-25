/**
 * `resolveTheme` is the one definition of what "follow system appearance" paints. The
 * renderer (html class, diff pane, terminal theme-match) and main (the launch
 * background) both call it, so these cases are what keeps them from disagreeing.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, THEME_BASES, resolveTheme } from '../../src/shared/types';
import type { ThemeChoice, ThemeMode } from '../../src/shared/types';

const choice = (overrides: Partial<ThemeChoice>): ThemeChoice => ({
  theme: DEFAULT_CONFIG.theme,
  themeFollowsSystem: DEFAULT_CONFIG.themeFollowsSystem,
  themeLight: DEFAULT_CONFIG.themeLight,
  themeDark: DEFAULT_CONFIG.themeDark,
  ...overrides,
});

describe('resolveTheme', () => {
  it('paints the hand-picked theme when not following, whatever the OS says', () => {
    expect(resolveTheme(choice({ theme: 'moon', themeLight: 'sky', themeDark: 'ember' }), true)).toBe('moon');
    expect(resolveTheme(choice({ theme: 'moon', themeLight: 'sky', themeDark: 'ember' }), false)).toBe('moon');
  });

  it('paints the pair member for the OS side when following', () => {
    const following = choice({ theme: 'moon', themeFollowsSystem: true, themeLight: 'sky', themeDark: 'ember' });
    expect(resolveTheme(following, true)).toBe('ember');
    expect(resolveTheme(following, false)).toBe('sky');
  });

  it('defaults are a real pair: the standard dark and light themes', () => {
    expect(THEME_BASES[DEFAULT_CONFIG.themeDark]).toBe('dark');
    expect(THEME_BASES[DEFAULT_CONFIG.themeLight]).toBe('light');
    expect(resolveTheme(choice({ themeFollowsSystem: true }), true)).toBe('dark');
    expect(resolveTheme(choice({ themeFollowsSystem: true }), false)).toBe('light');
  });

  it('falls back to the default pair member when a slot holds the wrong base or an unknown id', () => {
    // An edited config file can put a light theme in the dark slot; the picker never does.
    expect(resolveTheme(choice({ themeFollowsSystem: true, themeDark: 'peach' }), true)).toBe('dark');
    expect(resolveTheme(choice({ themeFollowsSystem: true, themeLight: 'ocean' }), false)).toBe('light');
    expect(resolveTheme(choice({ themeFollowsSystem: true, themeDark: 'retired' as ThemeMode }), true)).toBe('dark');
  });
});
