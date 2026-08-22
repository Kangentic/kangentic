/**
 * Zero-quota stand-in for an agent CLI.
 *
 * Its only job here is to make SessionManager register a real session, so the
 * MCP server can resolve `/mcp/<projectId>/<sessionId>` to a caller task the
 * way it does for a real agent. It never talks to a model.
 *
 * Two things are load-bearing (see the preview-zero-quota-agent-rig notes):
 * hide the cursor, because `\x1b[?25l` is Kangentic's first-output heuristic
 * and the launch overlay never lifts without it; and repaint on resize prefixed
 * with `\x1b[2J`, the marker main's repaint-settle keys on.
 */
process.stdout.write('\x1b[?1049h'); // alt screen
process.stdout.write('\x1b[?25l'); // hide cursor - the first-output heuristic
process.stdout.write('\x1b[2J\x1b[H');
process.stdout.write('kangentic browser-contention rig: mock session\r\n');
process.stdout.write('this process exists only to hold a session id.\r\n');

process.stdout.on('resize', () => {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write('kangentic browser-contention rig: mock session (repaint)\r\n');
});

if (process.stdin.isTTY && process.stdin.setRawMode) {
  // Interactive PTY mocks MUST setRawMode, or a multi-Ctrl+C exit sequence
  // collapses on Linux while passing on Windows.
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  if (chunk.includes(0x03)) process.exit(0); // Ctrl+C
});

// Long lifetime: the rig controls teardown, not a timer.
setInterval(() => {}, 1 << 30);
