/**
 * Factory Droid CLI transcript cleanup.
 *
 * Empirically validated against Droid 0.109.3 (see `scripts/capture-droid-pty.js`
 * for the capture harness). Droid uses an Ink-based TUI that redraws the full
 * viewport on every spinner tick, so the raw PTY scrollback contains many
 * frames concatenated together. Each frame includes the response area on top
 * and a status block at the bottom (autonomy mode, model name, input box,
 * version notices, timer).
 *
 * Markers:
 *   - Assistant response: `⛬` (U+26EC) followed by content
 *   - User prompt: NO leader. The user's submitted text appears as a bare line
 *     in the conversation area, with no prefix marker.
 *
 * Strategy (mirrors Gemini's last-frame-wins approach since Droid lacks
 * a structural user-prompt marker):
 *   1. Filter Droid-specific noise patterns (status bar, streaming spinner,
 *      version indicators, input placeholder, autonomy line).
 *   2. Find the FIRST `⛬` line - this is where the response area begins.
 *      Walk backward from there to find the nearest non-empty content line;
 *      that line is the user prompt. Anchoring on the first `⛬` is critical
 *      because any line between two `⛬` frames is response continuation, not
 *      a prompt.
 *   3. Find the LAST `⛬` line - this anchors the most complete response.
 *      Earlier `⛬` lines are redraws of partially streamed responses.
 *   4. Return prompt + slice from last `⛬` onward, finalized.
 *
 * Limitation: multi-turn conversations only capture the last turn. Earlier
 * turns are discarded because Droid's frame redraws make turn boundaries
 * indistinguishable from the prefix-streaming pattern. Same compromise as the
 * Gemini adapter; can be revisited if multi-turn Droid handoffs become common.
 */

import { filterNoiseLines, finalizeTranscript } from '../../handoff/transcript-cleanup';

const DROID_NOISE_PATTERNS: RegExp[] = [
  // Streaming status line: "<braille> Streaming...  (Press ESC to stop)"
  /Streaming\.\.\.\s*\(Press ESC to stop\)/,
  // Standalone braille spinner glyph (U+2800 - U+28FF range)
  /^\s*[⠀-⣿]+\s*$/,
  // Autonomy status (always emitted as part of the bottom status block)
  /Auto\s*\([^)]*\)\s*-\s*all actions require approval/,
  // Model annotations that appear in the status block
  /\[BYOK\]/,
  /\[custom\]/,
  // Empty input box (ink renders ` >` with one leading space)
  /^\s*>\s*$/,
  // Input placeholder hint shown when the box is empty
  /^\s*>\s*Type\s+["'`]/,
  // Update notices
  /✓\s+v\d+\.\d+\.\d+(?:\.\d+)?\s+ready/,
  /↓\s+Downloading update/,
  /⟳\s+Verifying update/,
  // IDE connection indicator (rendered with phase glyph at end of status bar)
  /^\s*IDE\s+[○◌◐◑◒◓◔◕●]/,
  // Elapsed-time timer that decorates the status bar mid-response
  /\[⏱\s+\d+s\]/,
];

/**
 * Droid response marker: `⛬` followed by whitespace and content. Allow leading
 * whitespace because Ink sometimes pads the marker by one space when the
 * response area is rendered alongside other UI elements.
 */
const DROID_RESPONSE = /^\s*⛬\s/;

export function cleanDroidTranscript(rawText: string): string | null {
  const lines = rawText.split('\n');

  // Step 1: Filter Droid-specific noise + shared TUI noise patterns.
  const filtered = filterNoiseLines(lines, DROID_NOISE_PATTERNS);
  const text = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
  const cleanLines = text.split('\n');

  // Step 2: Find the FIRST `⛬` line. This is the boundary where the
  // response area begins; everything before it (after noise filtering) is
  // the user prompt. We anchor on FIRST (not LAST) because lines between
  // two `⛬` frames are response continuation, not prompts - walking back
  // from the LAST `⛬` would falsely classify continuation lines as the
  // user prompt for any multi-line response.
  let firstResponseStart = -1;
  for (let index = 0; index < cleanLines.length; index++) {
    if (DROID_RESPONSE.test(cleanLines[index])) {
      firstResponseStart = index;
      break;
    }
  }

  if (firstResponseStart === -1) {
    // No structural response marker found. Fall back to plain finalization
    // so the dispatcher does not return null on no-response transcripts that
    // still carry useful prose.
    return finalizeTranscript(text);
  }

  // Step 3: Find the LAST `⛬` line. Each Ink redraw emits a fresh `⛬`
  // block with progressively more content, so the LAST one starts the most
  // complete final-frame response.
  let lastResponseStart = firstResponseStart;
  for (let index = cleanLines.length - 1; index > firstResponseStart; index--) {
    if (DROID_RESPONSE.test(cleanLines[index])) {
      lastResponseStart = index;
      break;
    }
  }

  // Step 4: Walk backward from FIRST `⛬` to find the user prompt. Droid has
  // no prompt marker, so we take the nearest non-empty content line above
  // the response area.
  let promptIndex = -1;
  for (let index = firstResponseStart - 1; index >= 0; index--) {
    if (cleanLines[index].trim()) {
      promptIndex = index;
      break;
    }
  }

  if (promptIndex === -1) {
    // No prompt context above - return only the response block.
    return finalizeTranscript(cleanLines.slice(lastResponseStart).join('\n'));
  }

  // Step 5: Combine prompt + last-frame response. finalizeTranscript
  // collapses duplicate trailing paragraphs, so redundant trailing content
  // is handled there.
  const promptLine = cleanLines[promptIndex];
  const responseBlock = cleanLines.slice(lastResponseStart).join('\n');
  return finalizeTranscript(`${promptLine}\n\n${responseBlock}`);
}
