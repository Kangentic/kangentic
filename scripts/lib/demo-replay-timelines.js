/**
 * The two timelines a recording carries besides its bytes, both derived from its own stream.
 *
 * A recording's raw bytes replay only into a terminal whose grid matches the one they were made
 * at: Windows ConPTY re-emits even Claude's classic renderer with absolute cursor positions, so
 * another grid lands two frames' text on one row. That grid is not something a page can promise.
 * It moves with the visitor's display scaling and with which monospace font their machine has,
 * and the board's bottom panel is 15 rows where a session recording is 37, which no font size can
 * reconcile.
 *
 * A serialized FRAME has no such problem. It reflows, so the same frame paints correctly into any
 * grid, and a 37-row frame in a 15-row panel simply shows its last 15 rows, which is what a
 * terminal scrolled to the bottom shows anyway. So every recording carries a timeline of frames
 * as well as its stream, and a terminal that cannot take the bytes plays the frames instead. Live
 * output at any size, on any machine, with no second recording.
 *
 * The peek timeline is the same idea for the Monitor: the displayed last lines and when they
 * changed, so a card moves even on a page with no terminal open at all.
 *
 * One replay produces both. Shared by scripts/capture-agent-scrollback.js (new recordings) and
 * scripts/backfill-demo-timelines.mjs (the ones already on disk), so the two cannot drift.
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
 * How often a frame is kept. Four a second reads as an agent working; one a second reads as a
 * flipbook next to the desktop, and the cost is not what decides it (23 KB gzipped against 32 KB
 * for the session's own stream, in a file fetched only when a terminal mounts). An unchanged
 * screen is dropped either way, so an idle stretch costs nothing.
 */
const FRAME_INTERVAL_MS = 250;

/**
 * Both timelines, from one pass over the stream.
 *
 * Frames serialize the visible screen only (scrollback 0): that is what a repaint replaces, and
 * it keeps an entry the size of one screen rather than of the whole session.
 */
async function computeReplayTimelines(options) {
  const stream = Array.isArray(options.stream) ? options.stream : [];
  if (stream.length === 0) return { peekTimeline: [], frameTimeline: [] };
  const { Terminal } = require('@xterm/headless');
  const { SerializeAddon } = require('@xterm/addon-serialize');
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  const terminal = new Terminal({ cols: options.cols, rows: options.rows, allowProposedApi: true, scrollback: 5000 });
  // The Unicode 11 width table, as every xterm in the app runs (src/shared/xterm-unicode11.ts).
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);

  const peekChanges = [];
  const frameTimeline = [];
  let previousPeek = '';
  let previousFrame = null;
  let nextFrameAt = 0;
  for (const window of stream) {
    await new Promise((resolve) => terminal.write(window.data, resolve));

    const lines = peekFromTerminal(terminal);
    if (lines.length > 0) {
      const key = lines.join('\n');
      if (key !== previousPeek) {
        previousPeek = key;
        peekChanges.push({ t: window.t, lines });
      }
    }

    if (window.t < nextFrameAt) continue;
    nextFrameAt = window.t + FRAME_INTERVAL_MS;
    const frame = serializer.serialize({ scrollback: 0 });
    if (frame === previousFrame) continue;
    previousFrame = frame;
    frameTimeline.push({ t: window.t, frame });
  }
  terminal.dispose();
  return { peekTimeline: sampleByReadingTime(peekChanges), frameTimeline };
}

module.exports = { PEEK_CHROME, peekFromTerminal, computeReplayTimelines, readingTimeOf, FRAME_INTERVAL_MS };
