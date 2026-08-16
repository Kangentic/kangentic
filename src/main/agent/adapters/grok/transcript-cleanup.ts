import { filterNoiseLines, finalizeTranscript } from '../../handoff/transcript-cleanup';

/**
 * Grok Build transcript cleanup for cross-agent handoff.
 *
 * Empirically derived from a captured grok 1.0.0 PTY session (interactive
 * TUI probe, Windows). Grok runs a fullscreen alt-screen TUI, so the live
 * frames never accumulate in the normal buffer; what the scrollback holds
 * after a graceful exit (`/quit`, which `getExitSequence` sends) is grok's
 * OWN clean conversation dump:
 *
 *   Reply with exactly: PONG        <- initial positional prompt echo
 *   > Reply with exactly: PONG      <- user turns, `> ` prefixed
 *     PONG                          <- response text
 *   Resume this session with:
 *     grok --resume <uuid>
 *
 * Strategy: filter TUI chrome that can leak into the buffer when the
 * terminal lacks alt-screen support (welcome box, braille logo/spinners,
 * status timers, upgrade banner, telemetry opt-in prose, key hints, the
 * slash-command palette), strip the resume trailer, and anchor the last
 * turn on the LAST `> ` user-prompt line when one exists.
 */

const GROK_NOISE_PATTERNS: RegExp[] = [
  // Welcome banner and box chrome
  /Grok Build\s+\d+\.\d+\.\d+/,
  /Grok\s?[\d.]+\s?is\s?here/i,
  /Click\s?here\s?to\s?Upgrade/i,
  /Upgrade\s?for\s?more\s?usage/i,
  /New worktree\s*ctrl\+w/i,
  /Resume session\s*ctrl\+s/i,
  /^\s*Changelog\s*$/,
  /Quit\s*ctrl\+q/i,
  // Braille logo art and spinner glyphs (U+2800 - U+28FF), possibly mixed
  // with digits from the underlying frame
  /^[\s\d]*[⠀-⣿]+[\s\d]*$/,
  // Telemetry opt-in prose
  /Help\s?improve\s?Grok/i,
  /\[Opt\s?out\]\s?\[Opt\s?in\]/i,
  /Opt-?in\s?to\s?allow\s?SpaceXAI/i,
  /Read\s?Terms\s?and\s?Privacy\s?Policy/i,
  // Status/timer chrome
  /◆?\s*Thinking…/,
  /Th\w*nking…\s*[\d.]+s/,
  /Thought for\s+[\d.]+s/i,
  /Responding…\s*[\d.]+s/,
  /Worked for\s+[\d.]+s/i,
  // Key hints and status bar
  /Ctrl\+x\s*:\s*shortcuts/i,
  /Enter\s*:\s*send/i,
  /Shift\+Tab\s*:\s*mode/i,
  /^\s*\[stable\]\s*$/,
  // Slash-command palette entries ("/quit Quit the application", ...)
  /^\s*\/\w[\w-]*\s+[A-Z]/,
];

/** User prompt marker in grok's exit dump: `> ` followed by the typed text. */
const GROK_USER_PROMPT = /^\s*>\s+\S/;

/** The resume trailer grok prints after the conversation dump. */
const GROK_RESUME_TRAILER = /^\s*(Resume this session with:|grok\s+--resume\s+\S+)\s*$/;

export function cleanGrokTranscript(rawText: string): string | null {
  const lines = rawText.split('\n');

  const filtered = filterNoiseLines(lines, GROK_NOISE_PATTERNS)
    .filter((line) => !GROK_RESUME_TRAILER.test(line));
  const text = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
  const cleanLines = text.split('\n');

  // Anchor the last turn on the LAST `> ` user-prompt line. Everything from
  // there onward is that turn's prompt + response in grok's own clean dump.
  let lastPromptIndex = -1;
  for (let index = cleanLines.length - 1; index >= 0; index--) {
    if (GROK_USER_PROMPT.test(cleanLines[index])) {
      lastPromptIndex = index;
      break;
    }
  }

  if (lastPromptIndex === -1) {
    // No structural marker (e.g. the session was killed before the exit
    // dump). Plain finalization keeps whatever prose survived filtering.
    return finalizeTranscript(text);
  }

  const promptLine = cleanLines[lastPromptIndex].replace(/^\s*>\s+/, '');
  const responseBlock = cleanLines.slice(lastPromptIndex + 1).join('\n');
  return finalizeTranscript(`${promptLine}\n\n${responseBlock}`);
}
