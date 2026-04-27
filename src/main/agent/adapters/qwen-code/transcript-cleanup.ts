/**
 * Qwen Code transcript cleanup.
 *
 * Qwen Code is a soft fork of gemini-cli and inherits its TUI rendering
 * verbatim: same `>` prompt marker, same `✦` response marker, same
 * braille spinner, same banner art, same per-token viewport redraw.
 * The strategy here mirrors Gemini's: filter noise, then keep only the
 * last `✦` block (most complete) plus the prompt that precedes it.
 *
 * Qwen-specific additions on top of the Gemini noise list:
 *   1. `I'm ready.` idle indicator (printed when the TUI is waiting).
 *   2. `Session ID: <uuid>` shutdown header.
 *   3. `qwen --resume '<uuid>'` (or `gemini --resume '<uuid>'`, since
 *      some forks still emit the upstream literal) shutdown footer.
 *   4. Select-Auth-Method wizard chrome (visible if a session triggers
 *      reauthentication mid-stream).
 *
 * Markers: > (user prompt), ✦ (assistant response).
 *
 * Limitation: same as Gemini - multi-turn conversations only capture
 * the last turn because each `✦` redraw replaces the previous one in
 * the alternate-screen buffer.
 */

import { filterNoiseLines, finalizeTranscript } from '../../handoff/transcript-cleanup';

const QWEN_NOISE_PATTERNS: RegExp[] = [
  // Banner art (Gemini-inherited)
  /[▝▜▄▗▟▀]{2,}/,
  // Lines of block chars (full-width bars used as TUI borders)
  /^[▀▄\s]{10,}$/,
  // Braille spinners with "Thinking..." status
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking/,
  // YOLO mode indicator
  /^\s*YOLO\s+Ctrl\+Y/,
  // Input prompt placeholder (with or without leading spaces, * or > prefix)
  /[>*]\s+Type your message/,
  // Workspace/model status bar (inherited from gemini-cli)
  /^\s*workspace\s*\(\/directory\)/,
  /^\s*~\\.*worktrees\\/,
  /^\s*~\\\.{3}\\/,
  /^\s*no sandbox/,
  /^\s*branch\s/,
  /^\s*sandbox\s/,
  /Auto\s*\((?:Gemini|Qwen)\s*\d/,
  /\/model\s*$/,
  // Shortcuts hint
  /\?\s*for shortcuts/,
  // Info messages
  /^ℹ\s*Positional arguments/,
  // Authenticated-with line
  /^\s*Authenticated with/,
  // Tips for getting started block
  /^\s*Tips for getting started/,
  /^\s*\d\.\s*(?:Create QWEN\.md|Create GEMINI\.md|\/help|Ask coding|Be specific)/,
  // Shift+Tab hint
  /Shift\+Tab to accept/,
  // Tip lines in status bar
  /Tip:\s/,
  // "esc to cancel" in spinner lines
  /esc to cancel/,

  // Qwen-specific additions below.

  // Idle indicator: TUI prints "I'm ready." inside the prompt box when
  // waiting for input. Match both straight and curly apostrophe variants
  // since real PTY output may emit U+2019 depending on locale.
  /^\s*I[''’]m ready\.?\s*$/,
  // Shutdown header: `Session ID: <uuid>`
  /^\s*Session ID:\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/,
  // Shutdown footer: `qwen --resume '<uuid>'` (some fork builds still
  // emit `gemini --resume` so accept either binary name, mirroring the
  // adapter's sessionId.fromOutput regex)
  /^\s*(?:qwen|gemini)\s+--resume\s+'?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'?\s*$/,
  // Select-Auth-Method wizard (visible when reauth triggers mid-session).
  // The wizard sits inside box-drawing borders so the surrounding chrome
  // is filtered by BORDER_ONLY_LINE; these patterns catch the menu items
  // that fall on content lines.
  /^\s*Select Auth Method/,
  /^\s*\(Use arrow keys/,
  /^\s*Sign in with Google\s*$/,
  /^\s*Use Gemini API Key\s*$/,
  /^\s*Vertex AI\s*$/,
  /^\s*Login with Qwen\s*$/,
  /^\s*OpenAI Compatible\s*$/,
];

/** Qwen prompt marker: > followed by content (optional leading whitespace). */
const QWEN_PROMPT = /^\s*>\s+\S/;
/** Qwen response marker: ✦ followed by content. */
const QWEN_RESPONSE = /^\s*✦\s/;

export function cleanQwenTranscript(rawText: string): string | null {
  // Step 0: Strip inline TUI chrome that gets concatenated onto content
  // lines. Qwen (like Gemini) sometimes appends "? for shortcuts" directly
  // to the last response line without a newline separator.
  const preClean = rawText.replace(/\?\s*for shortcuts/g, '');

  const rawLines = preClean.split('\n');

  // Step 1: Strip box-drawing borders from `│ inner │` lines so the inner
  // text is exposed to the noise filter. Qwen wraps every interactive
  // surface (prompt, trust, auth dialogs) inside `╰─╯` boxes - without
  // this step, lines like `│ I'm ready.       │` slip past every pattern
  // because they contain neither pure border content (so BORDER_ONLY_LINE
  // misses them) nor a bare match for the idle/wizard regexes (so the
  // Qwen patterns miss them too). Mirror codex/transcript-cleanup.ts.
  const lines: string[] = [];
  for (const line of rawLines) {
    const boxMatch = line.match(/^│\s?(.*?)\s*│$/);
    if (boxMatch) {
      const inner = boxMatch[1].trimEnd();
      if (inner) lines.push(inner);
      continue;
    }
    lines.push(line);
  }

  // Step 2: Filter noise (shared SHARED_NOISE_PATTERNS + BORDER_ONLY_LINE
  // are applied automatically by filterNoiseLines).
  const filtered = filterNoiseLines(lines, QWEN_NOISE_PATTERNS);
  const text = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
  const cleanLines = text.split('\n');

  // Step 3: Find the LAST ✦ response block.
  // Qwen redraws the response on each token, each prefixed with ✦.
  // The last ✦ block is always the most complete.
  let lastResponseStart = -1;
  for (let index = cleanLines.length - 1; index >= 0; index--) {
    if (QWEN_RESPONSE.test(cleanLines[index])) {
      lastResponseStart = index;
      break;
    }
  }

  if (lastResponseStart === -1) return finalizeTranscript(text);

  // Step 4: Find the prompt that precedes the last ✦ response.
  let promptStart = -1;
  for (let index = lastResponseStart - 1; index >= 0; index--) {
    if (QWEN_PROMPT.test(cleanLines[index])) {
      promptStart = index;
      break;
    }
  }

  if (promptStart === -1) {
    // No prompt found - just return the last response block
    return finalizeTranscript(cleanLines.slice(lastResponseStart).join('\n'));
  }

  // Step 5: Take prompt + last ✦ block only (skip any intermediate ✦
  // blocks between them - they are stale partial redraws).
  const promptLine = cleanLines[promptStart];
  const responseLines = cleanLines.slice(lastResponseStart);

  return finalizeTranscript(promptLine + '\n\n' + responseLines.join('\n'));
}
