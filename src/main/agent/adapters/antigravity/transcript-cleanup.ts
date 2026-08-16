/**
 * Antigravity CLI transcript cleanup for handoff context.
 *
 * The agy TUI repaints heavily: braille spinner frames ("⣾  Generating...",
 * "Working...", "Loading..."), partial repaint fragments, a logo/header
 * block, footer hints ("esc to cancel", "? for shortcuts", the
 * `<mode> · <model> · <effort>` status segment), and a shutdown summary
 * ("Resume with -c ...  agy --conversation=<id>"). Patterns derive from real
 * agy 1.1.13 PTY captures (the E1 rig; pinned in
 * tests/unit/antigravity-transcript-cleanup.test.ts).
 *
 * Markers: `>` prefixes the echoed user prompt. Responses have NO marker
 * glyph (unlike Gemini's ✦), so the strategy is: filter noise, find the LAST
 * `>` prompt line, and return it plus everything after - the final turn.
 * Same last-turn-only limitation as the Gemini cleaner.
 */

import { filterNoiseLines, finalizeTranscript } from '../../handoff/transcript-cleanup';

const ANTIGRAVITY_NOISE_PATTERNS: RegExp[] = [
  // Logo art (half-block glyph runs)
  /[▀▄]{2,}/,
  // Sign-in banner
  /Welcome to the Antigravity CLI/,
  /Signing in\.\.\./,
  // Header block
  /^\s*Antigravity CLI \d/,
  /\(Antigravity Starter Quota\)/,
  // A lone account-email line from the header
  /^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/,
  // Braille spinner frames and their status-word fragments
  /^\s*[⣾⣷⣯⣟⡿⢿⣻⣽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
  /(Generating|Working|Loading)\.\.\./,
  // Footer hints and status segment
  /esc to cancel/,
  /\?\s*for shortcuts/,
  /press ctrl\+c again to exit/,
  /·.*·\s*(low|medium|high)\s*$/,
  // Tips and slash-menu chrome
  /^\s*└?\s*Tip: /,
  /↑\/↓ Navigate|enter Select|tab Complete/,
  // Box-drawing separators
  /^\s*─{10,}\s*$/,
  // Feedback survey
  /How's the CLI experience so far/,
  /\[1\] Good\s+\[2\] Fine/,
  // Shutdown summary
  /^\s*Resume with -c/,
  /^\s*agy --conversation=/,
];

/** Antigravity prompt marker: > followed by content. */
const ANTIGRAVITY_PROMPT = /^\s*>\s+\S/;

export function cleanAntigravityTranscript(rawText: string): string | null {
  // Chrome that gets concatenated onto content lines without a newline.
  const preClean = rawText
    .replace(/\?\s*for shortcuts/g, '')
    .replace(/esc to cancel/g, '');

  const lines = preClean.split('\n');
  const filtered = filterNoiseLines(lines, ANTIGRAVITY_NOISE_PATTERNS);
  const text = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
  const cleanLines = text.split('\n');

  // Find the LAST echoed prompt; the final response follows it.
  let promptStart = -1;
  for (let index = cleanLines.length - 1; index >= 0; index--) {
    if (ANTIGRAVITY_PROMPT.test(cleanLines[index])) {
      promptStart = index;
      break;
    }
  }

  if (promptStart === -1) return finalizeTranscript(text);
  return finalizeTranscript(cleanLines.slice(promptStart).join('\n'));
}
