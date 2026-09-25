#!/usr/bin/env node
/**
 * Mock Claude CLI for E2E tests.
 *
 * Handles:
 *   --version           → prints version string and exits
 *   --session-id ID     → NEW session with given ID (prints SESSION marker)
 *   --resume ID         → RESUMED session with given ID (prints RESUMED marker)
 *   <positional arg>    → prints the prompt text for verification
 *
 * Markers for test assertions:
 *   MOCK_CLAUDE_SESSION:<id>   → new session created via --session-id
 *   MOCK_CLAUDE_RESUMED:<id>   → existing session resumed via --resume
 *   MOCK_CLAUDE_PROMPT:<text>  → prompt/task text delivered
 *   MOCK_CLAUDE_NO_PROMPT      → no session-id and no prompt
 *   MOCK_CLAUDE_SETTINGS:<path> → settings file path from --settings
 *   MOCK_CLAUDE_PERMISSION_MODE:<mode> → value passed via --permission-mode
 *
 * Every marker line is printed by this script itself, never left to the
 * shell's echo of the invoked command line: a shell/ConPTY preamble or
 * screen clear can scroll or wipe an echoed command line before a test
 * observes it, so a test that needs to prove a specific flag was passed
 * must assert on a labeled marker this file prints, not on the raw argv
 * text appearing anywhere in scrollback.
 *
 * Stays alive for a few seconds to simulate a running session,
 * then exits cleanly.
 */

const args = process.argv.slice(2);

// Version detection (called by ClaudeDetector)
if (args.includes('--version')) {
  console.log('mock-claude 0.0.0-test');
  process.exit(0);
}

// Help detection (called by ClaudeAdapter.discoverCapabilities to parse
// --effort levels and detect --model flag presence). Print a minimal but
// realistic help block and exit immediately so capability discovery does
// not stall waiting for the long-running session branch below.
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

// Parse flags to find the prompt (last positional arg)
let sessionId = null;
let resumed = false;
let prompt = null;
let settingsPath = null;
let permissionMode = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id' && i + 1 < args.length) {
    sessionId = args[i + 1];
    resumed = false;
    i++; // skip value
  } else if (args[i] === '--resume' && i + 1 < args.length) {
    sessionId = args[i + 1];
    resumed = true;
    i++; // skip value
  } else if (args[i] === '--settings' && i + 1 < args.length) {
    settingsPath = args[i + 1];
    i++; // skip value
  } else if (args[i] === '--permission-mode' && i + 1 < args.length) {
    permissionMode = args[i + 1];
    i++; // skip value
  } else if (args[i] === '--dangerously-skip-permissions' || args[i] === '--print') {
    // flag without value, skip
  } else if (args[i] === '--') {
    // End-of-options: everything after -- is the prompt
    if (i + 1 < args.length) {
      prompt = args[i + 1];
    }
    break;
  } else if (!args[i].startsWith('-')) {
    prompt = args[i];
  }
}

if (settingsPath) {
  console.log('MOCK_CLAUDE_SETTINGS:' + settingsPath);
}

if (permissionMode) {
  console.log('MOCK_CLAUDE_PERMISSION_MODE:' + permissionMode);
}

if (sessionId) {
  if (resumed) {
    console.log('MOCK_CLAUDE_RESUMED:' + sessionId);
  } else {
    console.log('MOCK_CLAUDE_SESSION:' + sessionId);
  }
}

if (prompt) {
  console.log('MOCK_CLAUDE_PROMPT:' + prompt);
} else if (!sessionId) {
  console.log('MOCK_CLAUDE_NO_PROMPT');
}

// Background-shell harness for the bg-shell false-idle regression guard.
//
// When MOCK_CLAUDE_BACKGROUND_BASH=1 is set, emit the POST-REMAP event
// sequence that the real event-bridge would produce when the agent
// launches a backgrounded Bash (run_in_background: true) and then
// yields its turn:
//
//   background_shell_start  (PreToolUse remapped by tool_input.run_in_background)
//   tool_end                (PostToolUse fires immediately -- handle returned)
//   idle                    (Stop hook fires because the assistant turn ended)
//
// The mock bypasses the real hook pipeline and writes these lines
// directly to the session's events.jsonl. Coverage of the event-bridge
// remap itself (real stdin payload -> correct retyping) lives in
// tests/e2e/claude-activity-detection.spec.ts so the two concerns stay
// separate: the bridge tests prove the remap directive works, this
// harness proves the state-machine side (Guard 3) handles the remapped
// stream correctly end-to-end.
//
// Simultaneously spawn a detached child that keeps running to
// represent the still-active background shell. The child's PID is
// published to bg-shell.pid so the spec can prove it is alive at the
// moment activity state is observed.
//
// Pre-fix, this scenario flipped the session to 'idle' even though
// the child was still running (task #503 wild capture). Post-fix,
// Guard 3 defers the idle while activeBackgroundShells > 0 and the
// session stays 'thinking'. The spec asserts the post-fix behavior,
// so this code path exercises the fix rather than the old bug.
if (process.env.MOCK_CLAUDE_BACKGROUND_BASH === '1' && sessionId && !settingsPath) {
  // Kangentic's internal session ID (the directory name under
  // .kangentic/sessions/) differs from the --session-id it passes to
  // the Claude CLI. The ONLY reliable way to find Kangentic's session
  // directory is `--settings <path>`, which is rooted in it. Guessing
  // from --session-id + cwd lands in a sibling directory the file
  // watcher does not see, so the harness would fail silently. Refuse
  // to run the bg-bash branch in that case and let the spec's
  // readBgShellPid timeout with its own diagnostic.
  console.error(
    'MOCK_CLAUDE_BG_SHELL_NO_SETTINGS: refusing to guess sessionDir from --session-id; ' +
      'Kangentic must pass --settings to the mock for the bg-bash harness to work.',
  );
} else if (process.env.MOCK_CLAUDE_BACKGROUND_BASH === '1' && sessionId) {
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const { spawn } = require('node:child_process');

  const sessionDir = pathMod.dirname(settingsPath);
  const eventsPath = pathMod.join(sessionDir, 'events.jsonl');
  const pidPath = pathMod.join(sessionDir, 'bg-shell.pid');
  const diagPath = pathMod.join(sessionDir, 'bg-shell.diag');

  // Diagnostic breadcrumb written unconditionally so the spec can
  // distinguish "bg-bash branch never ran" from "bg-bash branch ran
  // but spawn/write failed partway through."
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      diagPath,
      JSON.stringify(
        {
          entered: true,
          cwd: process.cwd(),
          sessionId,
          pid: process.pid,
          execPath: process.execPath,
          platform: process.platform,
          env_bg_bash: process.env.MOCK_CLAUDE_BACKGROUND_BASH,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error('MOCK_CLAUDE_BG_SHELL_DIAG_ERROR:' + error.message);
  }

  // Synthetic event cycle mirroring what the real event-bridge would
  // emit for a backgrounded Bash. The bridge's PreToolUse handler
  // inspects tool_input.run_in_background and remaps the event type
  // from tool_start to background_shell_start; we bypass the bridge
  // and write the remapped type directly:
  //
  //   background_shell_start  (PreToolUse, remapped by run_in_background)
  //   tool_end                (PostToolUse -- handle returned ~300ms later)
  //   idle                    (Stop -- agent yielded)
  //
  // Guard 3 in the activity state machine defers the idle while
  // activeBackgroundShells > 0, so the session should stay 'thinking'
  // until a KillBash fires (which the mock does not emit) or session_end.
  try {
    const toolStart = Date.now();
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        ts: toolStart,
        type: 'background_shell_start',
        tool: 'Bash',
        detail: 'npx playwright test --project=ui &',
      }) + '\n',
    );
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        ts: toolStart + 300,
        type: 'tool_end',
        tool: 'Bash',
      }) + '\n',
    );
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        ts: toolStart + 1500,
        type: 'idle',
      }) + '\n',
    );
    console.log('MOCK_CLAUDE_BG_SHELL_EVENTS_WRITTEN:' + eventsPath);
  } catch (error) {
    console.error('MOCK_CLAUDE_BG_SHELL_EVENTS_ERROR:' + error.message);
  }

  // Detached long-running child: this is the "background shell" that
  // Claude Code's TUI would count as "1 shell still running." Kangentic
  // has no way to observe this from the event stream alone.
  //
  // stdio: 'ignore' is critical on Windows -- 'inherit' tries to
  // inherit the parent's PTY handle, which node-pty-hosted processes
  // cannot share with a detached child. windowsHide: true suppresses
  // a console window flashing up.
  //
  // Lifetime is bounded by MOCK_CLAUDE_BG_SHELL_LIFETIME_MS (default
  // 10s) so CI never leaks more than ~10s of orphan node processes
  // when Playwright kills the test suite with SIGKILL (which bypasses
  // the killTick SIGTERM handler). The positive-control spec's
  // observation window is 5s, so 10s leaves comfortable margin.
  const lifetimeMs = parseInt(process.env.MOCK_CLAUDE_BG_SHELL_LIFETIME_MS || '10000', 10);
  try {
    const tick = spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(function(){process.exit(0)},${lifetimeMs})`,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    tick.unref();

    if (typeof tick.pid === 'number' && tick.pid > 0) {
      fs.writeFileSync(pidPath, String(tick.pid));
      console.log('MOCK_CLAUDE_BG_SHELL_PID:' + tick.pid);
    } else {
      // Spawn succeeded but returned no PID (extremely rare on Node).
      // Write the sentinel so the spec's readBgShellPid can distinguish
      // this case from "wrapper never invoked" or "spawn threw."
      console.error('MOCK_CLAUDE_BG_SHELL_SPAWN_NO_PID');
      try {
        fs.writeFileSync(pidPath, '-1');
      } catch {
        /* ignore */
      }
    }

    const killTick = () => {
      try {
        // process.kill with a plain PID works on both POSIX and Windows.
        // The negative-PID process-group form is POSIX-only.
        if (tick.pid) process.kill(tick.pid);
      } catch {
        /* ignore */
      }
    };
    process.on('SIGTERM', killTick);
    process.on('SIGINT', killTick);
    process.on('exit', killTick);
  } catch (error) {
    console.error('MOCK_CLAUDE_BG_SHELL_SPAWN_ERROR:' + error.message);
    // Write a sentinel PID so the harness can distinguish
    // "spawn failed" from "wrapper not invoked" in post-mortem.
    try {
      fs.writeFileSync(pidPath, '-1');
    } catch {
      /* ignore */
    }
  }
}

// Fullscreen-TUI interactive select-prompt harness for the terminal
// input/focus-disconnect regression (fullscreen select-prompt freeze fix).
//
// mock-claude normally emits plain console.log marker lines with no terminal
// escape sequences at all, so it cannot reproduce a bug that only exists in
// the alt-screen (fullscreen renderer) replay path. When
// MOCK_CLAUDE_FULLSCREEN_SELECT=1 is set, this branch instead behaves like a
// real Claude Code fullscreen TUI parked at an AskUserQuestion-style select
// prompt: it enters the alt screen buffer (1049h), turns on application
// cursor keys (DECCKM, 1h) and SGR-encoded mouse tracking (1000h + 1006h),
// draws a 3-option menu, and reacts to arrow-key and SGR wheel-report input
// by moving the highlight via a cursor-addressed, synchronized-output
// (2026h/2026l) DIFF - never a full repaint - exactly like the fix this
// harness verifies (a dropped diff, a replay landing in the wrong xterm
// buffer, or a replay that loses the mouse encoding must not go unnoticed).
const FULLSCREEN_SELECT_OPTIONS = ['First option', 'Second option', 'Third option'];

// Fullscreen TUI that REPAINTS ON RESIZE, for the terminal fit/handoff harness.
//
// The other branches of this mock cannot reproduce the terminal's most-reported
// visual bugs (opens mis-sized then "refits"; sometimes stays mis-sized) because
// those bugs are a race between a PTY resize, the agent's ASYNCHRONOUS repaint,
// and the renderer's scrollback replay. A mock that never repaints has no race, so
// an E2E harness against it passes while the real app flickers - which is exactly
// what happened: the DOM-only fit harness went green against plain mock-claude and
// proved nothing about real Claude.
//
// This branch behaves like Claude's real renderer in the three ways that matter:
//
//   1. It owns the whole screen (alt buffer, cursor hidden), so its frames land in
//      the same xterm buffer and replay path a real TUI uses.
//   2. It repaints on SIGWINCH (Node surfaces ConPTY resizes as stdout 'resize'
//      too, so this works on Windows), bracketed in a DEC 2026 synchronized frame
//      and prefixed with a full-screen erase - the marker the repaint-settle keys on.
//   3. The repaint is DELAYED (MOCK_CLAUDE_TUI_REPAINT_DELAY_MS, default 80ms).
//      This is the load-bearing detail: an instant repaint would land before the
//      renderer samples scrollback and hide the very ordering bug under test.
//
// Every frame draws a RULER line exactly as wide as the current grid, ending in a
// sentinel. If the PTY and the xterm grid disagree, that line wraps and the
// sentinel moves off its row - a width mismatch made visible in the content
// itself rather than inferred from pixel arithmetic.
//
// MOCK_CLAUDE_RESIZE_LOG=<path> appends one `<cols>x<rows>` line per observed
// resize. That is how a test counts how many PTY widths a single detail-open
// produced: two means the mount fitted twice, so the agent repainted twice and the
// user saw the second one land. The log is the bridge-free detector for that,
// which matters because the devtools inspection route is tree-shaken out of the
// production builds CI runs.
if (process.env.MOCK_CLAUDE_TUI_REPAINT === '1') {
  const fs = require('node:fs');
  const repaintDelayMs = parseInt(process.env.MOCK_CLAUDE_TUI_REPAINT_DELAY_MS || '80', 10);
  const resizeLogPath = process.env.MOCK_CLAUDE_RESIZE_LOG || null;
  let repaintTimer = null;
  let frameCount = 0;

  const currentCols = () => process.stdout.columns || 80;
  const currentRows = () => process.stdout.rows || 24;

  const drawFrame = () => {
    const cols = currentCols();
    const rows = currentRows();
    frameCount += 1;
    const sentinel = '#END';
    // Exactly `cols` wide: fills the row with no wrap when the grid agrees with
    // the PTY, and wraps the sentinel onto the next row when it does not.
    const ruler = ('RULER-' + cols + '-').padEnd(cols - sentinel.length, '.') + sentinel;

    let out = '\x1b[?2026h'; // synchronized frame begin
    out += '\x1b[2J'; // full-screen erase: the repaint marker
    out += '\x1b[1;1HMOCK TUI FRAME ' + frameCount + ' cols=' + cols + ' rows=' + rows;
    out += '\x1b[2;1H' + ruler;
    out += '\x1b[3;1Hauto mode on (mock banner)';
    for (let row = 4; row <= Math.min(rows, 12); row++) {
      out += '\x1b[' + row + ';1Hline ' + row + ' at width ' + cols;
    }
    out += '\x1b[?2026l'; // synchronized frame end
    process.stdout.write(out);
  };

  // Enter the alt screen and hide the cursor. Hiding it is also Kangentic's
  // first-output heuristic for Claude, so without it the launch overlay never
  // lifts and the terminal stays behind the shimmer.
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  drawFrame();

  // Announce that the fixture is LIVE, with the geometry it booted at. A harness
  // has to wait for this before it can count resizes: the mock is a grandchild of
  // the PTY (shell, then node), so it can take several hundred ms to start, and a
  // test that measures sooner sees an empty log and the fixture's first frame
  // already at the final width - indistinguishable from "the app never resized
  // the PTY", which is how a run went vacuously green. Written to the same log so
  // no second channel (or DOM read of a WebGL-rendered grid) is needed.
  if (resizeLogPath) {
    try {
      fs.appendFileSync(resizeLogPath, 'start:' + currentCols() + 'x' + currentRows() + '\n');
    } catch {
      /* a missing log dir must not kill the session */
    }
  }

  const onResizeObserved = () => {
    if (resizeLogPath) {
      try {
        fs.appendFileSync(resizeLogPath, currentCols() + 'x' + currentRows() + '\n');
      } catch {
        /* a missing log dir must not kill the session */
      }
    }
    // Delayed and coalesced, like a real agent that has to be scheduled before it
    // can re-measure and redraw.
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = setTimeout(drawFrame, repaintDelayMs);
  };

  // KNOWN PLATFORM LIMIT, measured: on Windows this fixture never observes a
  // resize at all. ConPTY delivers no SIGWINCH equivalent to a grandchild process
  // (this mock runs under a shell, under the pseudoconsole), and node's cached
  // `process.stdout.columns` is therefore never refreshed - it stays frozen at
  // whatever the geometry was when the process booted. Two runs proved it: one
  // booted at 157 columns and one at the 200-column spawn default, and BOTH logged
  // zero resizes while xterm's grid demonstrably changed.
  //
  // So on Windows the resize log is empty by construction and a test must NOT use
  // it as an oracle - that is what let two harness runs pass vacuously. The resize
  // count a test needs is observable from the renderer instead (xterm writes its
  // grid size into `.xterm-screen`'s inline style, which is real DOM in every
  // build); see tests/e2e/terminal-fit-invariant.spec.ts. On Linux, where CI runs
  // the gate, the event below fires and the log is a useful failure diagnostic,
  // though nothing asserts on it. The `start:` line above is the portable
  // "fixture is alive" signal on every platform.
  //
  // A geometry POLL used to sit here as a supposed portable fallback. It was dead
  // code on both platforms: useless on Windows (the value it samples is frozen)
  // and redundant on Linux (the event fires), while ticking 40x/sec inside the
  // process under measurement. Removed rather than left as reassuring ballast.
  //
  // Deliberately NOT solved by having the fixture ask the terminal for its size
  // (`\x1b[999;999H\x1b[6n`): that needs a probe every few tens of ms, and the
  // constant output drip would keep the PTY from ever going quiet, which is an
  // input to the repaint-settle logic under test. A harness must not perturb the
  // thing it measures.
  process.stdout.on('resize', onResizeObserved);

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const timeout = setTimeout(() => process.exit(0), 120000);
  const shutdown = () => {
    clearTimeout(timeout);
    if (repaintTimer) clearTimeout(repaintTimer);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    if (data.includes('/exit')) shutdown();
  });
  process.stdin.resume();
} else if (process.env.MOCK_CLAUDE_FULLSCREEN_SELECT === '1') {
  let selectedIndex = 0;

  const cursorTo = (row, col) => '\x1b[' + row + ';' + col + 'H';

  const renderOptionRow = (index) => {
    const row = 3 + index;
    const marker = index === selectedIndex ? '> ' : '  ';
    const text = marker + FULLSCREEN_SELECT_OPTIONS[index];
    const styled = index === selectedIndex ? '\x1b[7m' + text + '\x1b[0m' : text;
    return cursorTo(row, 1) + styled + '\x1b[K';
  };

  const drawFullScreen = () => {
    let out = '\x1b[?1049h'; // enter the alt screen buffer
    out += '\x1b[?1h'; // DECCKM: application cursor keys
    // VT200 mouse tracking in SGR encoding, like Claude's real fullscreen
    // renderer: wheel scroll arrives as SGR reports (\x1b[<64/65;x;yM), and
    // the handler below parses ONLY that encoding. This split is load-bearing
    // for the replay guard: the serialize addon re-asserts TRACKING (?1000h)
    // but cannot emit the ENCODING (?1006h), so a replay that fails to restore
    // it leaves xterm sending legacy X10 reports this harness (like real
    // Claude) ignores - and the wheel assertion in the spec goes red.
    out += '\x1b[?1000h\x1b[?1006h';
    // Hide the cursor while the TUI manages its own visual indicators. This
    // is also Kangentic's detectFirstOutput heuristic for Claude (see
    // src/main/agent/adapters/claude/claude-adapter.ts) -- without it the
    // renderer's launch overlay never lifts and the terminal stays hidden
    // behind the shimmer indefinitely.
    out += '\x1b[?25l';
    out += '\x1b[2J'; // clear screen - marks where the TUI takes over
    out += cursorTo(1, 1) + 'Select an option:';
    for (let i = 0; i < FULLSCREEN_SELECT_OPTIONS.length; i++) {
      out += renderOptionRow(i);
    }
    process.stdout.write(out);
  };

  const moveHighlight = (delta) => {
    const previousIndex = selectedIndex;
    const nextIndex = Math.min(
      FULLSCREEN_SELECT_OPTIONS.length - 1,
      Math.max(0, selectedIndex + delta),
    );
    if (nextIndex === previousIndex) return;
    selectedIndex = nextIndex;
    // A real diff, not a full repaint: only the two affected rows redraw,
    // bracketed in a synchronized-output frame like Claude's real renderer.
    const diff = '\x1b[?2026h' + renderOptionRow(previousIndex) + renderOptionRow(selectedIndex) + '\x1b[?2026l';
    process.stdout.write(diff);
  };

  // A real interactive TUI reads its stdin in RAW mode: on a real TTY/PTY,
  // stdin otherwise stays in the OS's cooked/line-buffered mode, which both
  // locally echoes typed characters AND withholds every keystroke from the
  // 'data' event until a newline is typed - so a single arrow-key press
  // (never followed by Enter) would never be delivered at all. Guarded on
  // isTTY: a plain pipe (e.g. a direct child_process spawn in a unit-style
  // probe) has no raw/cooked mode and setRawMode does not exist there.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  drawFullScreen();

  // Bounded lifetime safety net in case a test never sends Enter/exit
  // (mirrors the 30s cap on the default branch below).
  const timeout = setTimeout(() => process.exit(0), 30000);
  process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
  process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

  // Substring matching (not exact equality) on an accumulated buffer: a real
  // PTY can deliver a 3-byte arrow-key escape sequence split across two
  // 'data' events, or coalesce several keystrokes into one. inputCarry keeps
  // a short trailing partial escape for the next chunk, mirroring the
  // cross-chunk mode-carry pattern in pty-buffer-manager.ts.
  let inputCarry = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    const combined = inputCarry + data;
    inputCarry = '';
    if (combined.includes('\r') || combined.includes('\n')) {
      clearTimeout(timeout);
      process.stdout.write('\x1b[?1049l'); // leave the alt screen buffer
      console.log('MOCK_CLAUDE_SELECTED:' + selectedIndex);
      process.exit(0);
      return;
    }
    if (combined.includes('/exit')) {
      clearTimeout(timeout);
      process.exit(0);
      return;
    }
    if (combined.includes('\x1bOA') || combined.includes('\x1b[A')) {
      moveHighlight(-1);
    }
    if (combined.includes('\x1bOB') || combined.includes('\x1b[B')) {
      moveHighlight(1);
    }
    // SGR-encoded wheel reports only (button 64 = up, 65 = down), one move per
    // report. Legacy X10 reports (\x1b[M + 3 raw bytes) are deliberately NOT
    // parsed - real Claude ignores them too, which is how a replay that drops
    // the ?1006h encoding manifests as dead scroll. Click reports (\x1b[<0...)
    // fall through unmatched, like every other unrecognized input.
    const wheelReports = combined.match(/\x1b\[<6[45];\d+;\d+M/g);
    if (wheelReports) {
      for (const report of wheelReports) {
        moveHighlight(report.startsWith('\x1b[<65') ? 1 : -1);
      }
    }
    // The carry must retain a trailing partial SGR report (\x1b[<64;12 ...) as
    // well as a bare \x1b / \x1b[ / \x1bO, or a wheel report split across two
    // PTY chunks loses its head and the notch is silently dropped.
    const partialEscapeMatch = combined.match(/\x1b(?:\[(?:<[\d;]*)?|O)?$/);
    if (partialEscapeMatch) inputCarry = partialEscapeMatch[0];
  });
  process.stdin.resume();
} else {
  // Stay alive to simulate a running session (30s gives tests time to interact)
  const timeout = setTimeout(() => process.exit(0), 30000);

  // Exit cleanly on SIGTERM/SIGINT
  process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
  process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

  // Keep stdin open so PTY doesn't close
  process.stdin.resume();

  // Listen for /exit command on stdin (graceful shutdown)
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    if (data.includes('/exit')) {
      clearTimeout(timeout);
      process.exit(0);
    }
  });
}
