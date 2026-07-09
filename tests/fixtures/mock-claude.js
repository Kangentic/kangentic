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
  } else if (args[i] === '--permission-mode') {
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
// cursor keys (DECCKM, 1h), draws a 3-option menu, and reacts to arrow-key
// input by moving the highlight via a cursor-addressed, synchronized-output
// (2026h/2026l) DIFF - never a full repaint - exactly like the fix this
// harness verifies (a dropped diff, or a replay landing in the wrong xterm
// buffer, must not go unnoticed).
const FULLSCREEN_SELECT_OPTIONS = ['First option', 'Second option', 'Third option'];

if (process.env.MOCK_CLAUDE_FULLSCREEN_SELECT === '1') {
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
    const partialEscapeMatch = combined.match(/\x1b(?:O|\[)?$/);
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
