#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI.
 *
 * Captures the PARSED terminal grid of a live session so the Agent Monitor's
 * "recent output peek" extraction rule can be designed against real data instead
 * of guessed at.
 *
 * Why this exists: the peek reads the per-session headless xterm parser main
 * already maintains (BufferState.headless / HeadlessFrameBuffer) and shows the
 * last few rendered lines on a monitor card. Picking WHICH lines is not
 * derivable from source. A fullscreen TUI (Claude Code runs `tui: fullscreen`,
 * i.e. the alt screen) puts its input box and mode line at the BOTTOM of the
 * grid, so a naive "last N non-empty lines" returns box-drawing characters
 * rather than output. A plain shell puts the prompt at the bottom with real
 * output above it. This probe dumps both so the rule can be written against
 * what the grid actually contains.
 *
 * Two modes:
 *   --mode shell    spawn a shell, run a command that prints output, dump the
 *                   grid. Costs nothing, needs no agent CLI.
 *   --mode claude   spawn a REAL Claude Code CLI session exactly the way
 *                   session-spawn-flow does (120x30, xterm-256color,
 *                   buildSpawnEnv-cleaned env, per-session settings.json with
 *                   tui: fullscreen), send one short prompt, dump the grid.
 *                   Consumes a little account quota and leaves a transcript
 *                   under ~/.claude/projects/ for manual cleanup.
 *
 * The claude mode runs @xterm/headless as a capability-query RESPONDER. That is
 * load-bearing and was established by probe-claude-headless-statusline.js:
 * Claude only paints when something answers its terminal capability queries, and
 * a bare PTY with no renderer answers nothing, so without the responder the grid
 * stays empty and the probe measures nothing.
 *
 * Usage:
 *   node scripts/probe-terminal-peek-grid.js --mode shell
 *   node scripts/probe-terminal-peek-grid.js --mode claude
 *   node scripts/probe-terminal-peek-grid.js --mode claude --settle 25 --out grid.json
 *
 * Flags:
 *   --mode <shell|claude>  what to spawn (default: shell)
 *   --settle <sec>         how long to let it paint before dumping (default: 6 shell, 20 claude)
 *   --prompt <text>        prompt for claude mode
 *   --command <text>       command for shell mode
 *   --claude <path>        claude CLI path (default: env CLAUDE_PATH or "claude")
 *   --shell <spec>         shell to spawn (default: powershell.exe on win32, /bin/bash elsewhere)
 *   --cwd <path>           spawn cwd (default: a throwaway temp dir)
 *   --out <path>           also write the dump as JSON to this path
 *   --keep                 keep the throwaway dir
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { randomUUID } = require('node:crypto');

const COLS = 120;
const ROWS = 30;

function parseArgs(argv) {
  const out = {
    mode: 'shell',
    settle: null,
    prompt: 'Reply with a numbered list of exactly three colors, one per line, and nothing else.',
    command: null,
    claude: process.env.CLAUDE_PATH || 'claude',
    shell: null,
    cwd: null,
    out: null,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') out.mode = argv[++i];
    else if (arg === '--settle') out.settle = Number(argv[++i]);
    else if (arg === '--prompt') out.prompt = argv[++i];
    else if (arg === '--command') out.command = argv[++i];
    else if (arg === '--claude') out.claude = argv[++i];
    else if (arg === '--shell') out.shell = argv[++i];
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--keep') out.keep = true;
    else console.warn(`[peek-probe] ignoring unknown arg: ${arg}`);
  }
  return out;
}

/** Replica of buildSpawnEnv: drop CLAUDECODE and every CLAUDE_CODE_* marker. */
function buildSpawnEnv() {
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
    result[key] = value;
  }
  return result;
}

/** Replica of resolveShellArgs for the shells this probe supports. */
function resolveShellArgs(shell) {
  const lower = shell.toLowerCase();
  if (lower.startsWith('wsl ')) {
    const parts = shell.split(/\s+/);
    return { exe: parts[0], args: parts.slice(1) };
  }
  if (lower.includes('cmd')) return { exe: shell, args: [] };
  if (lower.includes('powershell') || lower.includes('pwsh')) return { exe: shell, args: ['-NoLogo'] };
  if (lower.includes('fish') || lower.includes('nu')) return { exe: shell, args: [] };
  return { exe: shell, args: ['--login'] };
}

function adaptCommandForShell(cmd, shellName) {
  if (process.platform !== 'win32') return cmd;
  const lower = shellName.toLowerCase();
  if (lower.includes('powershell') || lower.includes('pwsh')) return '& ' + cmd;
  return cmd;
}

function toForwardSlash(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Alt-screen enter/exit variants, mirroring ALT_SCREEN_MODES in
 * pty-buffer-manager.ts. Tracked from the raw byte stream exactly the way
 * BufferState.inAltScreen is, so the dump reports the same signal production
 * code would branch on.
 */
function tracksAltScreen(combined) {
  let inAlt = false;
  const setPattern = /\x1b\[\?([0-9;]+)([hl])/g;
  let match;
  while ((match = setPattern.exec(combined)) !== null) {
    const isSet = match[2] === 'h';
    for (const raw of match[1].split(';')) {
      const mode = Number(raw);
      if (mode === 47 || mode === 1047 || mode === 1049) inAlt = isSet;
    }
  }
  return inAlt;
}

function cleanup(dir, keep) {
  if (keep) {
    console.log(`[peek-probe] --keep set; leaving ${dir}`);
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[peek-probe] cleanup of ${dir} failed: ${err && err.message}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode !== 'shell' && opts.mode !== 'claude') {
    console.error(`[peek-probe] invalid --mode "${opts.mode}". Valid: shell, claude`);
    process.exit(2);
  }
  const settleSec = opts.settle ?? (opts.mode === 'claude' ? 20 : 6);

  let HeadlessTerminal;
  try {
    ({ Terminal: HeadlessTerminal } = require('@xterm/headless'));
  } catch {
    console.error('[peek-probe] @xterm/headless is not installed. Run npm install in this worktree.');
    process.exit(3);
  }

  const shell = opts.shell || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
  const shellName = shell.toLowerCase();
  const { exe: shellExe, args: shellArgs } = resolveShellArgs(shell);

  const throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-peek-'));
  fs.writeFileSync(path.join(throwaway, 'README.md'), '# Kangentic peek-grid probe workspace\n');
  const spawnCwd = opts.cwd || throwaway;

  // Same headless parser production uses (HeadlessFrameBuffer wraps exactly this
  // Terminal at the same geometry), doubling as the capability-query responder.
  const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });

  const env = buildSpawnEnv();
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shellExe, shellArgs, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: spawnCwd, env });
  } catch (err) {
    console.error('[peek-probe] pty.spawn failed:', err);
    cleanup(throwaway, opts.keep);
    process.exit(1);
  }

  term.onData((reply) => {
    try { ptyProcess.write(reply); } catch { /* pty gone */ }
  });

  const allOutput = [];
  ptyProcess.onData((data) => {
    allOutput.push(data);
    term.write(data);
  });

  let settingsPath = null;
  if (opts.mode === 'claude') {
    const sessionId = randomUUID();
    const sessionDir = path.join(throwaway, '.kangentic', 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    settingsPath = path.join(sessionDir, 'settings.json');
    // tui: fullscreen is the whole point - it is what puts Claude in the alt
    // screen, which is the case the extraction rule has to survive.
    fs.writeFileSync(settingsPath, JSON.stringify({ tui: 'fullscreen' }, null, 2));

    const parts = [
      `"${opts.claude}"`,
      '--permission-mode', 'plan',
      '--settings', `"${toForwardSlash(settingsPath)}"`,
      '--session-id', sessionId,
      '--', `'${opts.prompt.replace(/'/g, "")}'`,
    ];
    const command = adaptCommandForShell(parts.join(' '), shellName);
    setTimeout(() => {
      console.log(`[peek-probe] writing: ${command}`);
      try { ptyProcess.write(command + '\r'); } catch { /* ignore */ }
    }, 100);
  } else {
    const command = opts.command
      || (process.platform === 'win32'
        ? 'Write-Output "alpha"; Write-Output "bravo"; Write-Output "charlie"'
        : 'printf "alpha\\nbravo\\ncharlie\\n"');
    setTimeout(() => {
      console.log(`[peek-probe] writing: ${command}`);
      try { ptyProcess.write(command + '\r'); } catch { /* ignore */ }
    }, 400);
  }

  console.log(`[peek-probe] mode=${opts.mode} settle=${settleSec}s cwd=${spawnCwd}`);
  console.log('[peek-probe] waiting for the grid to paint...');

  setTimeout(() => {
    // xterm parses write() on a macrotask, so drain with a zero-length write
    // barrier before reading the buffer (same reason HeadlessFrameBuffer.flush
    // exists). This probe is measuring content, so it takes the barrier; the
    // production peek deliberately does not and tolerates a one-tick lag.
    term.write('', () => {
      const buffer = term.buffer.active;
      const combined = allOutput.join('');
      const inAltScreen = tracksAltScreen(combined);
      const baseY = buffer.baseY;
      const cursorY = buffer.cursorY;
      const absoluteCursorRow = baseY + cursorY;

      const lines = [];
      for (let y = 0; y < baseY + ROWS; y++) {
        const line = buffer.getLine(y);
        if (!line) continue;
        lines.push({
          absoluteRow: y,
          viewportRow: y - baseY,
          isCursorRow: y === absoluteCursorRow,
          text: line.translateToString(true),
        });
      }

      const dump = {
        mode: opts.mode,
        cols: COLS,
        rows: ROWS,
        inAltScreen,
        baseY,
        cursorY,
        absoluteCursorRow,
        bufferLength: buffer.length,
        totalOutputBytes: combined.length,
        lines,
      };

      console.log('');
      console.log('[peek-probe] ===== GRID =====');
      console.log(`inAltScreen=${inAltScreen} baseY=${baseY} cursorY=${cursorY} absCursorRow=${absoluteCursorRow} bufferLength=${buffer.length}`);
      console.log('');
      for (const line of lines) {
        const marker = line.isCursorRow ? '>>' : '  ';
        console.log(`${marker} [${String(line.absoluteRow).padStart(3)}] ${JSON.stringify(line.text)}`);
      }
      console.log('');

      // The candidate rule from the plan, printed so it can be judged directly
      // against the grid above rather than reasoned about.
      const aboveCursor = lines
        .filter((line) => line.absoluteRow < absoluteCursorRow && line.text.trim() !== '')
        .slice(-3)
        .map((line) => line.text);
      const lastNonEmpty = lines
        .filter((line) => line.text.trim() !== '')
        .slice(-3)
        .map((line) => line.text);
      console.log('[peek-probe] candidate "last 3 non-empty ABOVE cursor":');
      console.log(JSON.stringify(aboveCursor, null, 2));
      console.log('[peek-probe] candidate "last 3 non-empty overall":');
      console.log(JSON.stringify(lastNonEmpty, null, 2));

      if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify(dump, null, 2));
        console.log(`[peek-probe] dump written to ${opts.out}`);
      }

      try { ptyProcess.write('\x03'); } catch { /* ignore */ }
      setTimeout(() => {
        try { ptyProcess.kill(); } catch { /* ignore */ }
        try { term.dispose(); } catch { /* ignore */ }
        cleanup(throwaway, opts.keep);
        console.log('[peek-probe] done.');
        process.exit(0);
      }, 500);
    });
  }, settleSec * 1000);
}

main().catch((err) => {
  console.error('[peek-probe] fatal:', err);
  process.exit(1);
});
