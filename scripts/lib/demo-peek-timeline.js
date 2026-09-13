/**
 * The Monitor's output peek over the course of a recording.
 *
 * A Monitor card shows the last lines its session's terminal is displaying. On the desktop those
 * change as the agent works, which is most of what makes the Monitor read as live. The web build
 * has the same bytes on a timer, so the same changes are derivable: replay the recording's stream
 * through a headless xterm and read the displayed last lines after every window.
 *
 * Raw, that is far too much motion. Two of the sample install's sessions change their last lines
 * six times a second, which reads as a flicker rather than as an agent working. So the raw changes
 * are sampled by READING TIME: a change is kept only once the one before it has been on screen
 * long enough to read. Real output varies in length, so the kept spacing comes out irregular on its
 * own; nothing here is random, which matters because the built files are content-hashed and a
 * build has to be reproducible.
 *
 * Shared by scripts/capture-agent-scrollback.js (new recordings) and
 * scripts/backfill-demo-peek-timelines.mjs (the ones already on disk), so the two cannot drift.
 */
'use strict';

/**
 * Footer, status, and input-placeholder rows are each CLI's chrome, not the agent's output; the
 * Monitor peek skips them (Claude's mode footer, Codex's prompt hint and model line, Copilot's
 * session footer, OpenCode's status bar, Gemini's key hints).
 */
const PEEK_CHROME = /(esc to (cancel|interrupt)|enter to select|ctrl\+p commands|\? for shortcuts|shift\+tab to cycle|accept edits on|tab to amend|open sidebar|Type your message|^› |^❯|^gpt-[\w.-]+ (low|medium|high|xhigh) ·|Session: [\d.]+ AIC used|Build · |\d+(\.\d+)?K \(\d+%\)|to navigate)/i;

/**
 * The last two lines of the terminal as it DISPLAYS them, for the Monitor card's output peek.
 * Read from the rendered buffer rather than the byte stream, so cursor-positioned words keep
 * their spacing. Box borders at either edge are trimmed; a TUI's frame is not output either.
 */
function peekFromTerminal(terminal) {
  const buffer = terminal.buffer.active;
  const kept = [];
  for (let row = buffer.length - 1; row >= 0 && kept.length < 2; row--) {
    const line = buffer.getLine(row);
    const text = (line ? line.translateToString(true) : '').replace(/\s+/g, ' ').replace(/^[\s│┃]+|[\s│┃]+$/g, '');
    if (!/[A-Za-z]{3}/.test(text) || PEEK_CHROME.test(text) || /^[─-▟\s]+$/.test(text)) continue;
    kept.unshift(text.length > 96 ? `${text.slice(0, 93)}...` : text);
  }
  return kept;
}

// How long a peek has to stay on screen before the next one replaces it. Two lines of about 90
// characters each land near the top of this range, a short status line at the bottom of it.
const READING_TIME_BASE_MS = 1200;
const READING_TIME_PER_CHARACTER_MS = 18;
const READING_TIME_MIN_MS = 2500;
const READING_TIME_MAX_MS = 6000;

function readingTimeOf(lines) {
  const characterCount = lines.join(' ').length;
  const estimate = READING_TIME_BASE_MS + READING_TIME_PER_CHARACTER_MS * characterCount;
  return Math.min(READING_TIME_MAX_MS, Math.max(READING_TIME_MIN_MS, estimate));
}

/** Keep a change only once the one before it has been readable for its own reading time. */
function sampleByReadingTime(changes) {
  const kept = [];
  let lastKept = null;
  for (const change of changes) {
    if (lastKept !== null && change.t - lastKept.t < readingTimeOf(lastKept.lines)) continue;
    kept.push(change);
    lastKept = change;
  }
  return kept;
}

/**
 * Every distinct displayed-last-lines change over a recording's stream, sampled to a cadence a
 * reader can follow. Entries carry the stream's own timestamps, so the frame schedules them
 * against the same clock it replays the bytes on.
 */
async function computePeekTimeline(options) {
  const stream = Array.isArray(options.stream) ? options.stream : [];
  if (stream.length === 0) return [];
  const { Terminal } = require('@xterm/headless');
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  const terminal = new Terminal({ cols: options.cols, rows: options.rows, allowProposedApi: true, scrollback: 5000 });
  // The Unicode 11 width table, as every xterm in the app runs (src/shared/xterm-unicode11.ts).
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const changes = [];
  let previous = '';
  for (const window of stream) {
    await new Promise((resolve) => terminal.write(window.data, resolve));
    const lines = peekFromTerminal(terminal);
    if (lines.length === 0) continue;
    const key = lines.join('\n');
    if (key === previous) continue;
    previous = key;
    changes.push({ t: window.t, lines });
  }
  terminal.dispose();
  return sampleByReadingTime(changes);
}

module.exports = { PEEK_CHROME, peekFromTerminal, computePeekTimeline, readingTimeOf };
