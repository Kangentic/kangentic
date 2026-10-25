/**
 * The terminal font, size and cursor a fresh install gets, per platform: what
 * that platform's own default terminal draws, so an agent run in Kangentic
 * looks as it does run standalone from PowerShell or bash.
 *
 * - Windows is Windows Terminal's profile defaults (`profiles.schema.json`):
 *   Cascadia Mono with a bar cursor. Windows 11 ships Cascadia Mono
 *   system-wide; Windows 10 falls back to Consolas, its console's own font.
 * - Linux is GNOME Terminal's: `use-system-font` is on by default, and the
 *   system `monospace-font-name` is 'Adwaita Mono 11' since GNOME 48 (Source
 *   Code Pro before it). Its cursor is a block.
 *
 * The size is 14px everywhere, not the native point size. Windows Terminal's
 * 12pt is 16px and GNOME's 11pt is 14.67px, but xterm's renderer floors a
 * cell's width to whole device pixels and draws each glyph at its own advance,
 * so a size whose advance falls just under the next pixel draws its glyphs
 * wider than their cells. Measured for Cascadia Mono in Chromium: 14px is an
 * 8.2px advance in an 8px cell (2.5% over) at 100, 125, 150 and 200% scaling;
 * 15px is 8.79px in the same 8px cell at 100% and 125% (9.9% over, letters set
 * visibly tight, rows 2px taller, no more columns); 16px is 4 to 6.5% over and
 * drew thin lines through the Claude Code mascot's block glyphs in a task
 * window. 14px is also what every install already ran at.
 * - macOS keeps the previous default for now. Terminal.app's Basic profile is
 *   SF Mono, which ships only inside Terminal.app and Xcode under a licence for
 *   Apple's own apps, so Kangentic cannot draw it, and its size (11pt in the
 *   one dated source found) is unconfirmed on a current macOS.
 *
 * Padding is not here: every platform gets Windows Terminal's 8px inset
 * (`index.css`, `.xterm`), since GNOME Terminal's 1px and Terminal.app's fixed
 * inset leave the text against the pane's edges beside another terminal.
 */

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';

export interface TerminalAppearanceDefaults {
  fontFamily: string;
  fontSize: number;
  cursorStyle: TerminalCursorStyle;
}

/** What every platform got before the native defaults, and still the shared
 *  `DEFAULT_CONFIG` value. An install still on exactly this font and size never
 *  chose one, so `ConfigManager` moves it to its platform's native default once. */
export const PREVIOUS_TERMINAL_DEFAULTS: TerminalAppearanceDefaults = {
  fontFamily: 'Menlo, Consolas, "Courier New", monospace',
  fontSize: 14,
  cursorStyle: 'block',
};

/** The native default for `platform` (`process.platform`, or the renderer's `electronAPI.platform`). */
export function nativeTerminalDefaults(platform: string): TerminalAppearanceDefaults {
  if (platform === 'win32') {
    return { fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace', fontSize: 14, cursorStyle: 'bar' };
  }
  if (platform === 'linux') {
    return { fontFamily: '"Adwaita Mono", "Source Code Pro", "DejaVu Sans Mono", monospace', fontSize: 14, cursorStyle: 'block' };
  }
  return PREVIOUS_TERMINAL_DEFAULTS;
}

/** Whether a terminal config still carries the previous default font and size, which nobody chose. */
export function isPreviousTerminalDefault(terminal: { fontFamily?: string | null; fontSize?: number | null }): boolean {
  return terminal.fontFamily === PREVIOUS_TERMINAL_DEFAULTS.fontFamily && terminal.fontSize === PREVIOUS_TERMINAL_DEFAULTS.fontSize;
}
