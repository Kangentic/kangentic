import { DEFAULT_CONFIG } from '../../shared/types';

/**
 * The terminal font size range the Settings field accepts. The floor is also
 * what every mounted xterm is held to, whatever the config says.
 */
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

/**
 * The font size a terminal actually runs at, from the configured one.
 *
 * The floor is a crash guard, not a preference (Sentry DESKTOP-1J/1K). xterm's
 * WebGL renderer floors the character width to whole device pixels
 * (`WebglRenderer._updateDimensions`), so a font whose 'W' measures under one
 * device pixel gets a cell 0 pixels wide. Its zero-size guard tests width AND
 * height, and the height is ceiled to at least 1, so it builds a glyph atlas at
 * width 0 anyway. The first `_` it rasterizes throws `IndexSizeError` from
 * `getImageData`, in the render frame and again in the atlas warm-up's idle
 * callback, which nothing cancels once queued. So the size has to be refused
 * before xterm ever sees it. 1px is the one a person reaches: the Settings
 * field committed every keystroke, so typing "12" applied 1 first.
 *
 * Floor only. A size above the field's maximum renders fine, and a hand-edited
 * larger value keeps working.
 */
export function resolveTerminalFontSize(configured: number | null | undefined): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_CONFIG.terminal.fontSize;
  }
  return Math.max(configured, TERMINAL_FONT_SIZE_MIN);
}
