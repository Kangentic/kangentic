/**
 * Text that reads on a user-chosen fill (a column's color): near-black or
 * white, whichever has the higher WCAG 2 contrast ratio against it. The column
 * color is the user's, so neither theme token can be trusted to read on it.
 */

const DARK_TEXT = '#18181b';
const LIGHT_TEXT = '#ffffff';
const DARK_TEXT_LUMINANCE = relativeLuminance(24, 24, 27);

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(first: number, second: number): number {
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** `#rgb` or `#rrggbb` to its channels, or null for anything else. */
function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? match[1].replace(/./g, (digit) => digit + digit) : match[1];
  return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16)) as [number, number, number];
}

/** Whether the text on this fill is dark. A color that does not parse reads as dark text. */
export function prefersDarkText(fillHex: string): boolean {
  const channels = parseHex(fillHex);
  if (!channels) return true;
  const fill = relativeLuminance(...channels);
  return contrastRatio(fill, DARK_TEXT_LUMINANCE) >= contrastRatio(fill, 1);
}

/** The text color that reads on this fill. */
export function readableTextOn(fillHex: string): string {
  return prefersDarkText(fillHex) ? DARK_TEXT : LIGHT_TEXT;
}
