#!/usr/bin/env node
/**
 * Scroll-latency rig mock agent, for `kangentic_devtools_scroll_latency`.
 *
 * Stands in for Claude Code's fullscreen renderer with an answer time of zero,
 * so a measurement against it is Kangentic's own floor: everything between the
 * wheel and the painted frame except the agent. It answers `--version` and
 * `--help` like mock-claude.js so detection succeeds, enters the alt screen,
 * hides the cursor (Kangentic's first-output latch for Claude), turns on SGR
 * mouse tracking and focus reports as Claude does, and holds a long synthetic
 * transcript. Each SGR wheel report (button 64 up, 65 down) moves the view
 * three lines and repaints the whole grid at once, inside one DEC 2026
 * synchronized frame.
 *
 * A load session: put `scroll-load=<hz>` anywhere in the arguments (the task's
 * prompt reaches the mock as one) and it appends a transcript line and
 * repaints the grid at that rate, like a busy agent streaming output.
 * `MOCK_SCROLL_LOAD_HZ` sets the same thing from the environment.
 * `scroll-flood` instead writes lines as fast as the PTY takes them, the shape
 * of `cat` on a large log. `MOCK_SCROLL_ANSWER_DELAY_MS` delays each answer, to
 * model an agent. A typed character or Backspace is echoed at once on the
 * input row, the way an agent's prompt box answers a keystroke.
 *
 * Lives for `MOCK_SCROLL_LIFETIME_MS` (default 30 minutes) and exits on
 * Ctrl+C, Ctrl+D, `/exit`, or a closed stdin.
 */

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('mock-claude 0.0.0-scroll');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: claude [options] [prompt]');
  console.log('');
  console.log('Options:');
  console.log('  --version            Print version and exit');
  console.log('  --help               Show this help');
  console.log('  --print              Non-interactive mode');
  console.log('  --session-id <uuid>  Create a new session with this id');
  console.log('  --resume <uuid>      Resume an existing session');
  console.log('  --model <name>       Override the model for this session');
  console.log('  --effort <level>     Effort level for the current session (low, medium, high, xhigh, max)');
  console.log('  --permission-mode <mode>  Permission mode');
  process.exit(0);
}

const loadMatch = /scroll-load=(\d+(?:\.\d+)?)/.exec(args.join(' '));
const loadHz = loadMatch ? parseFloat(loadMatch[1]) : parseFloat(process.env.MOCK_SCROLL_LOAD_HZ || '0');
const flood = /scroll-flood/.test(args.join(' '));
const answerDelayMs = parseInt(process.env.MOCK_SCROLL_ANSWER_DELAY_MS || '0', 10);
const lifetimeMs = parseInt(process.env.MOCK_SCROLL_LIFETIME_MS || String(30 * 60_000), 10);
const LINES_PER_NOTCH = 3;

const transcript = [];
for (let index = 0; index < 2000; index++) {
  transcript.push(index % 7 === 0
    ? '\x1b[1m● Read\x1b[0m src/renderer/components/board/file-' + index + '.tsx'
    : '  line ' + index + ' of the mock transcript, long enough to fill most of a terminal row');
}
// How many lines above the bottom the view sits; 0 follows the tail.
let linesFromBottom = 0;
let frames = 0;
// What has been typed on the input row.
let typed = '';

function inputRow() {
  const rows = process.stdout.rows || 40;
  const cols = process.stdout.columns || 120;
  // Only what fits, so an echo stays one row's worth however much was typed.
  return '\x1b[' + rows + ';1H > ' + typed.slice(-Math.max(1, cols - 4)) + '\x1b[K';
}

function paint() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const bodyRows = Math.max(1, rows - 2);
  const maxOffset = Math.max(0, transcript.length - bodyRows);
  linesFromBottom = Math.max(0, Math.min(maxOffset, linesFromBottom));
  const firstLine = transcript.length - bodyRows - linesFromBottom;
  frames += 1;
  let out = '\x1b[?2026h\x1b[H';
  for (let row = 0; row < bodyRows; row++) {
    const text = transcript[firstLine + row] ?? '';
    out += '\x1b[' + (row + 1) + ';1H' + text.slice(0, cols) + '\x1b[K';
  }
  const status = ' mock-scroll ' + (loadHz > 0 ? 'load ' + loadHz + ' Hz' : 'responder') + '  offset ' + linesFromBottom + '  frame ' + frames;
  out += '\x1b[' + (rows - 1) + ';1H\x1b[7m' + status.slice(0, cols).padEnd(cols, ' ') + '\x1b[0m';
  out += inputRow();
  out += '\x1b[?2026l';
  process.stdout.write(out);
}

// Raw mode first: on Windows, ConPTY passes the mouse-tracking request on to
// the terminal only once the console reads VT input, which raw mode turns on.
// Asked for before it, the request is dropped and the wheel never reports.
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
// Alt screen, hidden cursor, SGR mouse tracking, focus reports.
process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1004h');
paint();
process.stdout.on('resize', paint);

let loadTimer = null;
if (flood) {
  const floodChunk = '  flooding output, the shape of cat on a large log file, one line after another\r\n'.repeat(200);
  const floodWrite = () => {
    // Write until the PTY's buffer is full, then wait for it to drain.
    while (process.stdout.write(floodChunk)) { /* keep writing */ }
    process.stdout.once('drain', floodWrite);
  };
  floodWrite();
} else if (loadHz > 0) {
  let appended = 0;
  loadTimer = setInterval(() => {
    appended += 1;
    transcript.push('  streamed line ' + appended + ' from a busy mock agent, about as wide as real output');
    paint();
  }, Math.max(10, Math.round(1000 / loadHz)));
}

function scroll(notches) {
  linesFromBottom += notches * LINES_PER_NOTCH;
  if (answerDelayMs > 0) setTimeout(paint, answerDelayMs);
  else paint();
}

function shutdown(code) {
  if (loadTimer) clearInterval(loadTimer);
  process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1004l\x1b[?25h\x1b[?1049l');
  process.exit(code);
}

process.stdin.setEncoding('utf8');
// A report split across two reads keeps its head here for the next one.
let inputCarry = '';
process.stdin.on('data', (chunk) => {
  const combined = inputCarry + chunk;
  inputCarry = '';
  if (combined.includes('\x03') || combined.includes('\x04') || combined.includes('/exit')) {
    shutdown(0);
    return;
  }
  // A trailing partial escape waits for the next read, so neither the report
  // match nor the key loop below sees half of one.
  const partial = combined.match(/\x1b(?:\[(?:<[\d;]*)?)?$/);
  if (partial) inputCarry = partial[0];
  const complete = partial ? combined.slice(0, combined.length - partial[0].length) : combined;
  // One answer per read, as a TUI answers a batch it read at once.
  const reports = complete.match(/\x1b\[<6[45];\d+;\d+M/g) ?? [];
  let notches = 0;
  for (const report of reports) notches += report.startsWith('\x1b[<64') ? 1 : -1;
  if (reports.length > 0) scroll(notches);
  // Typed characters and Backspace, with every escape sequence (mouse and
  // focus reports) taken out first.
  const keys = complete.replace(/\x1b\[M[\s\S]{3}|\x1b\[[<\d;?]*[A-Za-z~]|\x1bO[\s\S]/g, '');
  let typedChanged = false;
  for (const key of keys) {
    if (key === '\x7f' || key === '\x08') {
      typed = typed.slice(0, -1);
      typedChanged = true;
    } else if (key >= ' ' && key <= '~') {
      typed += key;
      typedChanged = true;
    }
  }
  if (typedChanged) process.stdout.write(inputRow());
});
process.stdin.on('end', () => shutdown(0));
process.stdin.resume();
setTimeout(() => shutdown(0), lifetimeMs);
