/**
 * Measures a string's rendered width with a 2D canvas, for a column that sizes itself to the
 * widest label it can show (the backlog's Priority header and Updated dates) before any row
 * renders. The font family is the document body's, so the measure follows the app's face.
 */

// hmr-safe: a scratch canvas with no state worth keeping; a re-evaluated module builds a new one.
let measureContext: CanvasRenderingContext2D | null = null;

function getContext(): CanvasRenderingContext2D | null {
  if (measureContext) return measureContext;
  if (typeof document === 'undefined') return null;
  measureContext = document.createElement('canvas').getContext('2d');
  return measureContext;
}

/** The body's font family, the face every label in the table inherits. */
export function bodyFontFamily(): string {
  if (typeof document === 'undefined' || !document.body) return 'sans-serif';
  return getComputedStyle(document.body).fontFamily || 'sans-serif';
}

/**
 * Width in px of `text` at `font` (a CSS font shorthand, such as `600 11px Segoe UI`), plus
 * `letterSpacingPx` after each character, as CSS letter-spacing lays it out. Returns 0 where no
 * canvas exists.
 */
export function measureTextWidth(text: string, font: string, letterSpacingPx = 0): number {
  const context = getContext();
  if (!context) return 0;
  context.font = font;
  return context.measureText(text).width + letterSpacingPx * text.length;
}
