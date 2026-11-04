/**
 * Goose CLI transcript cleanup for handoff context.
 *
 * Goose draws inline, with no alternate screen, so its scrollback is mostly
 * the conversation itself. The chrome it adds is the startup banner and the
 * context bar after a turn. Both come from Goose's source at 1.57.0
 * (`crates/goose-cli/src/session/output.rs`), not from a captured session,
 * since Goose was not installed where this was written:
 *
 * - `display_session_info`, three lines of goose art beside the session's
 *   facts: `  __( O)>  <new session|resuming|ephemeral> · <provider> · <model>`,
 *   ` \____)    <session id> · <cwd>`, and `   L L     goose is ready`.
 * - `display_context_usage`: `  <bar of ━ and ╌> <n>% <used>/<limit>` (token
 *   counts like `12k/128k`), or `context usage unavailable (context limit is 0)`.
 *
 * The whole scrollback is kept apart from those lines: Goose has no prompt glyph
 * to find the last turn by, so there is no last-turn cut as Gemini's or
 * Antigravity's cleaners make.
 */

import { filterNoiseLines, finalizeTranscript } from '../../handoff/transcript-cleanup';

const GOOSE_NOISE_PATTERNS: RegExp[] = [
  // The banner's three art lines, which also carry the provider, model, session id and cwd.
  /__\( O\)>/,
  /^\s*\\_{4}\)/,
  /^\s*L L\s+goose is ready/,
  // The context bar after a turn.
  /^\s*[━╌]+\s+\d+%\s+\S+\/\S+\s*$/,
  /context usage unavailable \(context limit is 0\)/,
];

export function cleanGooseTranscript(rawText: string): string | null {
  const lines = rawText.split('\n');
  return finalizeTranscript(filterNoiseLines(lines, GOOSE_NOISE_PATTERNS).join('\n'));
}
