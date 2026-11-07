/**
 * Search over one terminal's output, on `@xterm/addon-search`.
 *
 * Output is read newest first, so a search starts at the newest match and "older"
 * walks up through it. The addon counts from the top of the buffer, which is why
 * `summarizeFindResults` turns its index around: the match a search lands on reads
 * "1 of 14", and each step older counts up.
 *
 * Reach is what this xterm holds. On the alternate screen that is the screen, since
 * `baseY` is 0 there.
 */

import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';

/** Matches highlighted per search. The addon stops collecting at this count. */
export const TERMINAL_FIND_HIGHLIGHT_LIMIT = 1000;

export type FindDirection = 'older' | 'newer';

export interface FindResults {
  /** The active match, counted from the top of the buffer. -1 when no match is active, as past the limit. */
  resultIndex: number;
  resultCount: number;
}

export type FindSummary =
  | { kind: 'none' }
  | { kind: 'past-limit'; limit: number }
  | { kind: 'position'; position: number; total: number }
  | { kind: 'total'; total: number };

export function summarizeFindResults(results: FindResults, limit: number): FindSummary {
  if (results.resultCount === 0) return { kind: 'none' };
  // The addon stops at the limit, so a count that reaches it may be short of the
  // real one, and the active match may sit beyond what it collected.
  if (results.resultCount >= limit) return { kind: 'past-limit', limit };
  if (results.resultIndex < 0) return { kind: 'total', total: results.resultCount };
  return { kind: 'position', position: results.resultCount - results.resultIndex, total: results.resultCount };
}

function parseHexColor(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (!match) return null;
  return [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)];
}

/** `amount` of `color` over `background`, as the opaque `#RRGGBB` xterm's decorations require. */
export function blendToOpaqueHex(color: string, background: string, amount: number): string | null {
  const foreground = parseHexColor(color);
  const base = parseHexColor(background);
  if (!foreground || !base) return null;
  const channels = foreground.map((channel, index) => Math.round(channel * amount + base[index] * (1 - amount)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** Text stays readable on these over a dark terminal: the active fill measures 4:1 against the default foreground. */
const MATCH_FILL = 0.35;
const ACTIVE_MATCH_FILL = 0.55;
/** Falls back to these when a theme token or a custom background is not `#RRGGBB`. */
const FALLBACK_HIGHLIGHT = '#d9b83f';
const FALLBACK_BACKGROUND = '#0c0c0c';

/** Read at each search, so a theme change applies to the next one. */
function buildDecorations(terminal: Terminal): NonNullable<ISearchOptions['decorations']> {
  const token = getComputedStyle(document.documentElement).getPropertyValue('--kng-warning').trim();
  const highlight = parseHexColor(token) ? token : FALLBACK_HIGHLIGHT;
  const themeBackground = terminal.options.theme?.background ?? '';
  const background = parseHexColor(themeBackground) ? themeBackground : FALLBACK_BACKGROUND;
  const matchFill = blendToOpaqueHex(highlight, background, MATCH_FILL) ?? highlight;
  const activeFill = blendToOpaqueHex(highlight, background, ACTIVE_MATCH_FILL) ?? highlight;
  return {
    matchBackground: matchFill,
    matchOverviewRuler: matchFill,
    activeMatchBackground: activeFill,
    activeMatchBorder: highlight,
    activeMatchColorOverviewRuler: activeFill,
  };
}

export interface TerminalBufferReach {
  alternate: boolean;
  /** Lines a search covers, from the oldest held to the cursor. */
  lines: number;
}

export interface TerminalFind {
  find(query: string, direction: FindDirection): void;
  /** Drops the highlights and the selected match. */
  clear(): void;
  // arrival-focus-ok: the find bar's close, a user gesture and never an arrival.
  focusTerminal(): void;
  readReach(): TerminalBufferReach;
  /** Called on every result change, including the catch-up after output pauses. */
  onResults(listener: (results: FindResults) => void): () => void;
  /** Called when the terminal enters or leaves the alternate screen. */
  onBufferChange(listener: () => void): () => void;
}

export function runTerminalFind(terminal: Terminal, addon: SearchAddon, query: string, direction: FindDirection): void {
  const searchOptions: ISearchOptions = { decorations: buildDecorations(terminal) };
  if (direction === 'older') addon.findPrevious(query, searchOptions);
  else addon.findNext(query, searchOptions);
}

/** Disposes `addon`, so the caller loads a new one. */
export function clearTerminalFind(terminal: Terminal | null, addon: SearchAddon | null): void {
  // Not clearDecorations: output just before a close leaves the addon a 200 ms
  // re-search timer that only dispose cancels, and it would clear whatever the user
  // selects next.
  addon?.dispose();
  // The selection goes too. A find selects its match, and Ctrl+C with a selection
  // copies instead of interrupting, so a match left selected would eat the user's
  // next interrupt.
  terminal?.clearSelection();
}

export function readTerminalReach(terminal: Terminal | null): TerminalBufferReach {
  const buffer = terminal?.buffer.active;
  if (!buffer) return { alternate: false, lines: 0 };
  return { alternate: buffer.type === 'alternate', lines: buffer.baseY + buffer.cursorY + 1 };
}
