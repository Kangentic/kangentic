import { nativeTerminalDefaults, type TerminalAppearanceDefaults } from '../../shared/terminal-native-defaults';

/**
 * This platform's native terminal font, size and cursor, the renderer's fallback
 * when the config names none (a cleared Settings field). Main gives a fresh install
 * the same values (`ConfigManager`), so a field left empty draws what a new user sees.
 * No `window` (a unit test in node) reads as no platform: the shared fallback.
 */
export function rendererTerminalDefaults(): TerminalAppearanceDefaults {
  const platform = typeof window !== 'undefined' ? window.electronAPI?.platform ?? '' : '';
  return nativeTerminalDefaults(platform);
}
