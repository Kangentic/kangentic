/**
 * Kimi CLI transcript cleanup for PTY output.
 *
 * Kimi's TUI (verified empirically with kimi v1.37.0) renders:
 *
 *   Welcome banner box (cyan border):
 *     "Welcome to Kimi Code CLI!"
 *     "Send /help for help information."
 *     ""
 *     "Directory: ~\Path\to\workdir"
 *     "Session: <uuid>"
 *     "Model: <name|not set, send /login to login>"
 *     ""
 *     "Tip: Spot a bug or have feedback? Type /feedback ..."
 *
 *   Input area (separator line):
 *     "_ input ____..."
 *
 *   Bottom status bar:
 *     "agent  ~\path  <branch>  ctrl-o: editor | ctrl-j: newline    context: 0.0%"
 *
 * Strategy:
 *   1. Strip welcome-banner metadata (Directory/Session/Model/Tip lines).
 *   2. Strip the "_ input _..." separator.
 *   3. Strip the bottom status bar fragments (agent / context: N% / hotkey
 *      hints).
 *   4. Defer to the shared border filter for the box-drawing characters.
 *   5. finalizeTranscript() collapses blank runs and trims duplicates.
 *
 * Unlike Aider we don't pick "last turn" - Kimi shows full conversation
 * inline and we want all of it for handoff context. The shared filter +
 * specific noise patterns leave just the assistant/user message bodies.
 */

import { filterNoiseLines, finalizeTranscript } from '../../handoff/transcript-cleanup';

const KIMI_NOISE_PATTERNS: RegExp[] = [
  // Welcome banner content
  /^Welcome to Kimi Code CLI!?$/i,
  /^Send \/help for help/i,
  /^Directory:\s/,
  /^Session:\s+[0-9a-f-]+$/i,
  /^Model:\s/,
  /^Tip:\s.+\/feedback/i,
  // Input area separator
  /^[_]+\s*input\s*[_]+$/i,
  // Bottom status bar bits. Empirically appears as a single status line
  // with multiple cells separated by 2+ spaces; the cells themselves
  // are stable enough to anchor on.
  /^\s*agent\s+/,
  /\bctrl-[oj]:\s/,
  /\bcontext:\s+[\d.]+%/,
  // "To resume this session" banner shown on print-mode exit.
  /^To resume this session:\s+kimi\s+-r\s+[0-9a-f-]+$/i,
  // Inline status / OAuth prompts
  /^LLM not set$/,
  /^Send \/login to login$/i,
  // Slash-command help table rows. Anchored on the known Kimi command
  // set (per `kimi --help` v1.37.0 + the in-TUI /help output) so that
  // legitimate user/assistant prose starting with one of these tokens
  // (e.g. "/login is required to access the API") is NOT eaten. New
  // Kimi releases that introduce new slash commands will surface those
  // help-table rows in the handoff transcript until this list is
  // updated, which is the correct failure mode (non-essential noise
  // instead of dropping real content).
  // Two-or-more spaces between command and description distinguish a help-table
  // row ("/login   Log in to your Kimi account") from legitimate prose like
  // "/login is required to access the API" (single space, sentence structure).
  /^\s*\/(?:help|login|logout|exit|quit|clear|compact|feedback|init|model|memory|status|cost|review|undo|redo|new)\s{2,}\S/i,
];

export function cleanKimiTranscript(rawText: string): string | null {
  const lines = rawText.split('\n');
  const filtered = filterNoiseLines(lines, KIMI_NOISE_PATTERNS);
  const text = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
  return finalizeTranscript(text);
}
