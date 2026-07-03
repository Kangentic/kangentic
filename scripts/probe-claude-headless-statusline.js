#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI.
 *
 * Spawns a REAL, short-lived Claude Code CLI session inside a node-pty PTY,
 * exactly the way Kangentic's session-spawn-flow does (120x30, xterm-256color,
 * buildSpawnEnv-cleaned env, a per-session settings.json whose ONLY override is
 * the statusLine bridge + tui fullscreen), and measures whether status.json is
 * ever written for a BACKGROUND session (no attached terminal). This consumes a
 * little account quota and leaves a transcript file under
 * ~/.claude/projects/<slug>/ for manual cleanup. Throwaway cwd + session dir are
 * created under os.tmpdir() and deleted on exit unless --keep is passed.
 *
 * The question it answers: Claude only runs the statusLine command when its TUI
 * paints, and a headless PTY (nothing answering terminal capability queries)
 * never paints. Does answering those queries (via @xterm/headless as a
 * main-process query responder) make the statusline flow? This is the empirical
 * gate for the headless-query-responder lane.
 *
 * Usage:
 *   node scripts/probe-claude-headless-statusline.js --strategy baseline
 *   node scripts/probe-claude-headless-statusline.js --strategy responder
 *   node scripts/probe-claude-headless-statusline.js --strategy focus
 *   node scripts/probe-claude-headless-statusline.js --strategy keypress
 *   node scripts/probe-claude-headless-statusline.js --strategy responder+focus
 *   node scripts/probe-claude-headless-statusline.js --strategy responder --resume <sessionId>
 *
 * Flags:
 *   --strategy <name>   input strategy (default: baseline)
 *   --timeout <sec>     how long to wait for status.json (default: 30)
 *   --resume <id>       resume an existing session id instead of a fresh spawn
 *   --shell <spec>      shell to spawn (default: powershell.exe on win32, /bin/bash elsewhere)
 *   --claude <path>     claude CLI path (default: env CLAUDE_PATH or "claude")
 *   --keep              keep the throwaway cwd/session dir after exit
 *
 * The `responder` strategies require @xterm/headless. Install it for the probe
 * only (do not commit to package.json until the production decision):
 *   npm install --no-save @xterm/headless
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { randomUUID } = require('node:crypto');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    strategy: 'baseline',
    timeout: 30,
    resume: null,
    shell: null,
    claude: process.env.CLAUDE_PATH || 'claude',
    cwd: null,
    keep: false,
    hold: false,
    sessionId: null,
    noTui: false,
    enableProjectMcp: false,
    mcpConfig: null,
    full: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strategy') out.strategy = argv[++i];
    else if (arg === '--timeout') out.timeout = Number(argv[++i]);
    else if (arg === '--resume') out.resume = argv[++i];
    else if (arg === '--shell') out.shell = argv[++i];
    else if (arg === '--claude') out.claude = argv[++i];
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--session-id') out.sessionId = argv[++i];
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--hold') out.hold = true;
    // Omit the `tui` key from settings.json (matches real Kangentic when the
    // user has a global tui preference, which --settings may shadow). Tests
    // whether the headless statusline needs the alt-screen renderer.
    else if (arg === '--no-tui') out.noTui = true;
    // Add `enableAllProjectMcpServers: true` to settings so Claude launches the
    // project's .mcp.json servers (e.g. context7 via npx) at boot - tests
    // whether MCP init defers the headless statusline.
    else if (arg === '--enable-project-mcp') out.enableProjectMcp = true;
    // Pass --mcp-config <path> through to the claude command.
    else if (arg === '--mcp-config') out.mcpConfig = argv[++i];
    // Replicate the full Kangentic production settings shape: event-bridge hooks
    // on the key events + a representative permissions allow list +
    // enableAllProjectMcpServers. Isolates whether the full settings (not just
    // MCP or tui) suppress the headless statusline.
    else if (arg === '--full') out.full = true;
    else console.warn(`[probe] ignoring unknown arg: ${arg}`);
  }
  return out;
}

const VALID_STRATEGIES = new Set(['baseline', 'responder', 'focus', 'keypress', 'responder+focus']);

// ---------------------------------------------------------------------------
// Spawn recipe (mirrors src/main/pty/spawn/pty-spawn.ts + session-spawn-flow.ts)
// ---------------------------------------------------------------------------

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

/** Replica of resolveShellArgs for the shells the probe supports. */
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

/**
 * Partial replica of adaptCommandForShell: handles only the PowerShell `& `
 * call prefix. It deliberately omits the real function's Git Bash / WSL
 * exe-path conversion (convertWindowsExePath), so pointing --shell at Git Bash
 * with a Windows --claude path is unsupported here; use the documented default
 * shells (powershell.exe / /bin/bash) or a POSIX claude path.
 */
function adaptCommandForShell(cmd, shellName) {
  if (process.platform !== 'win32') return cmd;
  const lower = shellName.toLowerCase();
  if (lower.includes('powershell') || lower.includes('pwsh')) return '& ' + cmd;
  return cmd;
}

function toForwardSlash(p) {
  return p.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Capability-query scanner
// ---------------------------------------------------------------------------

/*
 * Each entry: a label, a matcher over a raw output chunk, and whether xterm.js
 * (and therefore @xterm/headless, which shares common/InputHandler.ts) answers
 * it. The gate we are hunting must be in the `xtermAnswers: true` set, because
 * an attached renderer session paints fine and xterm answers nothing outside
 * this set (notably NOT XTGETTCAP or XTVERSION).
 */
const QUERY_PATTERNS = [
  { label: 'DSR-CPR (ESC[6n)', re: /\x1b\[\??6n/g, xtermAnswers: true },
  { label: 'DSR-status (ESC[5n)', re: /\x1b\[5n/g, xtermAnswers: true },
  { label: 'DA1 (ESC[c / ESC[0c)', re: /\x1b\[0?c/g, xtermAnswers: true },
  { label: 'DA2 (ESC[>c)', re: /\x1b\[>0?c/g, xtermAnswers: true },
  { label: 'DA3 (ESC[=c)', re: /\x1b\[=0?c/g, xtermAnswers: false },
  { label: 'XTVERSION (ESC[>Ps q)', re: /\x1b\[>[0-9]*q/g, xtermAnswers: false },
  { label: 'OSC-10 fg color query', re: /\x1b\]10;\?(\x07|\x1b\\)/g, xtermAnswers: true },
  { label: 'OSC-11 bg color query', re: /\x1b\]11;\?(\x07|\x1b\\)/g, xtermAnswers: true },
  { label: 'OSC-12 cursor color query', re: /\x1b\]12;\?(\x07|\x1b\\)/g, xtermAnswers: true },
  { label: 'XTGETTCAP (DCS +q)', re: /\x1bP\+q/g, xtermAnswers: false },
  { label: 'DECRQM (ESC[?..$p)', re: /\x1b\[\?[0-9;]+\$p/g, xtermAnswers: true },
  { label: 'DECRQSS (DCS $q)', re: /\x1bP\$q/g, xtermAnswers: true },
  { label: 'kitty-keyboard query (ESC[?u)', re: /\x1b\[\?u/g, xtermAnswers: true },
  { label: 'window-size report (ESC[14t/16t/18t)', re: /\x1b\[(14|16|18)t/g, xtermAnswers: false },
];

function scanQueries(text) {
  const counts = {};
  for (const pattern of QUERY_PATTERNS) {
    const matches = text.match(pattern.re);
    if (matches && matches.length > 0) counts[pattern.label] = matches.length;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!VALID_STRATEGIES.has(opts.strategy)) {
    console.error(`[probe] invalid --strategy "${opts.strategy}". Valid: ${[...VALID_STRATEGIES].join(', ')}`);
    process.exit(2);
  }

  const shell = opts.shell || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
  const shellName = shell.toLowerCase();
  const { exe: shellExe, args: shellArgs } = resolveShellArgs(shell);

  // Throwaway root (holds the session dir + run evidence) under os.tmpdir().
  // Never a hardcoded absolute root (cross-platform-parity rule). The SPAWN cwd
  // defaults to this throwaway dir, but --cwd overrides it so the probe can run
  // in an already-trusted directory (the real worktree) to eliminate Claude's
  // first-time "do you trust this folder?" prompt, which a fresh temp dir trips
  // but a real Kangentic session (spawned in the trusted project) never does.
  const throwawayCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-probe-'));
  fs.writeFileSync(path.join(throwawayCwd, 'README.md'), '# Kangentic headless-statusline probe throwaway workspace\n');
  const spawnCwd = opts.cwd || throwawayCwd;
  const sessionId = opts.resume || opts.sessionId || randomUUID();
  const sessionDir = path.join(throwawayCwd, '.kangentic', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Minimal settings.json: ONLY the statusLine bridge + tui fullscreen. No
  // hooks, no MCP - isolates the statusline as the single variable.
  const statusBridge = toForwardSlash(path.resolve(__dirname, '..', 'src', 'main', 'agent', 'status-bridge.js'));
  const statusPath = toForwardSlash(path.join(sessionDir, 'status.json'));
  const settingsPath = path.join(sessionDir, 'settings.json');
  const settings = {
    statusLine: { type: 'command', command: `node "${statusBridge}" "${statusPath}"`, refreshInterval: 10 },
  };
  if (!opts.noTui) settings.tui = 'fullscreen';
  if (opts.enableProjectMcp || opts.full) settings.enableAllProjectMcpServers = true;
  if (opts.full) {
    // Replicate Kangentic's real hook load: event-bridge.js spawned on the key
    // lifecycle events, writing to a temp events.jsonl (same shape as the real
    // settings.json we read from the stuck session).
    const eventBridge = toForwardSlash(path.resolve(__dirname, '..', 'src', 'main', 'agent', 'event-bridge.js'));
    const eventsPath = toForwardSlash(path.join(sessionDir, 'events.jsonl'));
    const hookCmd = (eventType) => ({ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${eventType}` });
    settings.hooks = {
      SessionStart: [{ matcher: '', hooks: [hookCmd('session_start')] }],
      UserPromptSubmit: [{ matcher: '', hooks: [hookCmd('prompt')] }],
      PreToolUse: [{ matcher: '', hooks: [hookCmd('tool_start')] }],
      PostToolUse: [{ matcher: '', hooks: [hookCmd('tool_end')] }],
      Stop: [{ matcher: '', hooks: [hookCmd('idle')] }],
      Notification: [{ matcher: '', hooks: [hookCmd('notification')] }],
      SessionEnd: [{ matcher: '', hooks: [hookCmd('session_end')] }],
    };
    settings.permissions = {
      allow: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(node:*)', 'Bash(git:*)', 'mcp__context7', 'mcp__kangentic', 'WebSearch', 'Skill'],
      deny: [],
    };
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // Output dir for this run.
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(throwawayCwd, `run-${opts.strategy.replace('+', '-')}-${runStamp}`);
  fs.mkdirSync(runDir, { recursive: true });
  const rawStream = fs.createWriteStream(path.join(runDir, 'raw.ndjson'));

  const startTime = Date.now();
  const tMs = () => Date.now() - startTime;
  const allOutput = [];
  let lastOutputAtMs = 0;
  const record = (dir, data) => {
    const entry = { tMs: tMs(), dir, len: data.length, hex: Buffer.from(data, 'utf8').toString('hex').slice(0, 400), text: data.length <= 200 ? data : data.slice(0, 200) };
    rawStream.write(JSON.stringify(entry) + '\n');
  };

  console.log(`[probe] strategy=${opts.strategy} resume=${opts.resume ? sessionId : 'none'} shell=${shell}`);
  console.log(`[probe] spawn cwd=${spawnCwd}`);
  console.log(`[probe] session/evidence root=${throwawayCwd}`);
  console.log(`[probe] settings=${settingsPath}`);
  console.log(`[probe] status.json target=${statusPath}`);
  console.log(`[probe] run dir=${runDir}`);

  // Optional headless responder.
  let headlessTerm = null;
  const wantsResponder = opts.strategy === 'responder' || opts.strategy === 'responder+focus';
  if (wantsResponder) {
    let HeadlessTerminal;
    try {
      ({ Terminal: HeadlessTerminal } = require('@xterm/headless'));
    } catch {
      console.error('[probe] @xterm/headless is not installed. Run: npm install --no-save @xterm/headless');
      cleanup(throwawayCwd, opts.keep);
      process.exit(3);
    }
    headlessTerm = new HeadlessTerminal({ cols: 120, rows: 30, scrollback: 0, allowProposedApi: true });
    headlessTerm.onData((reply) => {
      record('in', reply);
      try { ptyProcess.write(reply); } catch { /* pty gone */ }
    });
  }

  const env = buildSpawnEnv();
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shellExe, shellArgs, { name: 'xterm-256color', cols: 120, rows: 30, cwd: spawnCwd, env });
  } catch (err) {
    console.error('[probe] pty.spawn failed:', err);
    cleanup(throwawayCwd, opts.keep);
    process.exit(1);
  }

  let sawFocusMode = false;
  let focusSent = false;
  const sendFocusIn = () => {
    if (focusSent) return;
    focusSent = true;
    record('in', '\x1b[I');
    try { ptyProcess.write('\x1b[I'); } catch { /* ignore */ }
    console.log(`[probe] +${tMs()}ms sent focus-in (ESC[I)`);
  };

  ptyProcess.onData((data) => {
    record('out', data);
    allOutput.push(data);
    lastOutputAtMs = tMs();
    if (headlessTerm) headlessTerm.write(data);
    // focus strategies: react to the terminal enabling focus-reporting (1004h).
    if ((opts.strategy === 'focus' || opts.strategy === 'responder+focus') && !sawFocusMode && data.includes('\x1b[?1004h')) {
      sawFocusMode = true;
      sendFocusIn();
    }
  });

  // Build the claude command and write it after 100ms, exactly like the spawn flow.
  const parts = [`"${opts.claude}"`, '--permission-mode', 'plan', '--settings', `"${toForwardSlash(settingsPath)}"`];
  if (opts.mcpConfig) {
    parts.push('--mcp-config', `"${toForwardSlash(opts.mcpConfig)}"`);
  }
  if (opts.resume) {
    parts.push('--resume', sessionId);
  } else {
    parts.push('--session-id', sessionId, '--', "'Reply with exactly: ok'");
  }
  const rawCommand = parts.join(' ');
  const command = adaptCommandForShell(rawCommand, shellName);

  setTimeout(() => {
    console.log(`[probe] +${tMs()}ms writing command: ${command}`);
    try { ptyProcess.write(command + '\r'); } catch { /* ignore */ }
  }, 100);

  // Blind fallbacks for focus/keypress at t+3s.
  if (opts.strategy === 'focus' || opts.strategy === 'responder+focus') {
    setTimeout(() => { if (!focusSent) sendFocusIn(); }, 3000);
  }
  if (opts.strategy === 'keypress') {
    setTimeout(() => {
      record('in', '\x1b[C');
      try { ptyProcess.write('\x1b[C'); } catch { /* ignore */ }
      console.log(`[probe] +${tMs()}ms sent benign keypress (right-arrow ESC[C)`);
    }, 3000);
  }

  // Poll for status.json.
  let statusAppearedAtMs = null;
  let statusPayload = null;
  let statusFireCount = 0;
  const pollInterval = setInterval(() => {
    try {
      const raw = fs.readFileSync(statusPath, 'utf8');
      if (raw && raw.trim().length > 0) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.context_window) {
          statusFireCount++;
          if (statusAppearedAtMs === null) {
            statusAppearedAtMs = tMs();
            statusPayload = parsed;
            console.log(`[probe] +${statusAppearedAtMs}ms STATUS.JSON APPEARED: model=${parsed.model && parsed.model.id} window=${parsed.context_window.context_window_size} used%=${parsed.context_window.used_percentage}`);
            // In --hold mode keep running to build a transcript / observe later
            // fires; otherwise finish on the first appearance.
            if (!opts.hold) finish('status-appeared');
          } else {
            statusPayload = parsed; // keep the latest
          }
        }
      }
    } catch { /* not yet, or mid-write */ }
  }, 500);

  const hardTimeout = setTimeout(() => finish('timeout'), opts.timeout * 1000);

  let finished = false;
  function finish(reason) {
    if (finished) return;
    finished = true;
    clearInterval(pollInterval);
    clearTimeout(hardTimeout);

    const combined = allOutput.join('');
    const queryCounts = scanQueries(combined);
    const unansweredXterm = {};
    const answerableSeen = {};
    for (const pattern of QUERY_PATTERNS) {
      if (queryCounts[pattern.label]) {
        if (pattern.xtermAnswers) answerableSeen[pattern.label] = queryCounts[pattern.label];
      }
    }
    // "Unanswered in the xterm set" only meaningful for baseline (no responder).
    if (!wantsResponder) Object.assign(unansweredXterm, answerableSeen);

    const summary = {
      strategy: opts.strategy,
      resume: opts.resume ? sessionId : null,
      shell,
      reason,
      statusJsonAppearedAtMs: statusAppearedAtMs,
      statusFireCount,
      statusModelId: statusPayload && statusPayload.model && statusPayload.model.id,
      statusContextWindowSize: statusPayload && statusPayload.context_window && statusPayload.context_window.context_window_size,
      statusUsedPercentage: statusPayload && statusPayload.context_window && statusPayload.context_window.used_percentage,
      totalOutputBytes: combined.length,
      cursorHidden: combined.includes('\x1b[?25l'),
      altScreenEntered: combined.includes('\x1b[?1049h'),
      focusReportingEnabled: combined.includes('\x1b[?1004h'),
      trustPromptDetected: /do you trust|trust the files|trust this folder|proceed\?/i.test(combined),
      lastOutputAtMs,
      allQueriesSeen: queryCounts,
      xtermAnswerableQueriesSeen: answerableSeen,
      unansweredXtermAnswerableQueries: wantsResponder ? '(responder active - answered)' : unansweredXterm,
    };
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    rawStream.end();

    console.log('');
    console.log('[probe] ===== SUMMARY =====');
    console.log(JSON.stringify(summary, null, 2));
    console.log('');
    console.log(`[probe] result: ${statusAppearedAtMs !== null ? 'STATUS.JSON FLOWED at +' + statusAppearedAtMs + 'ms' : 'NO STATUS.JSON within ' + opts.timeout + 's'} (${reason})`);
    console.log(`[probe] evidence retained in: ${runDir}`);

    // Kill the PTY (claude + shell). Send exit then hard-kill shortly after.
    try { ptyProcess.write('\x03'); } catch { /* ignore */ }
    setTimeout(() => {
      try { ptyProcess.kill(); } catch { /* ignore */ }
      if (headlessTerm) { try { headlessTerm.dispose(); } catch { /* ignore */ } }
      const transcriptSlug = throwawayCwd.replace(/[/\\:]/g, '-').replace(/^-+/, '');
      console.log(`[probe] transcript left under ~/.claude/projects/ (slug derived from ${throwawayCwd}); delete manually if desired.`);
      cleanup(throwawayCwd, opts.keep);
      console.log(`[probe] done.`);
      process.exit(statusAppearedAtMs !== null ? 0 : 4);
    }, 800);
  }
}

function cleanup(throwawayCwd, keep) {
  if (keep) {
    console.log(`[probe] --keep set; leaving ${throwawayCwd}`);
    return;
  }
  try {
    fs.rmSync(throwawayCwd, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[probe] cleanup of ${throwawayCwd} failed (a handle may still be open): ${err && err.message}`);
  }
}

main().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});
