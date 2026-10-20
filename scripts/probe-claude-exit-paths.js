#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI. WINDOWS (ConPTY) ONLY.
 *
 * Measures what each way of ending a Claude Code session does to Claude: does
 * its SessionEnd hook run, does it exit by itself and when, is its transcript's
 * last line whole, and is its boot-canary record withdrawn. It is the evidence
 * behind `src/main/pty/host/dead-root-orphans.ts` and the timing notes in
 * `.claude/rules/pty-teardown-grace.md` and `docs/session-lifecycle.md`.
 *
 * Each run spawns a shell through node-pty (with the app's console-list patch,
 * as the pty host runs it), launches Claude with a settings file whose hooks
 * record when SessionStart and SessionEnd ran, waits until the session is
 * mature (past the boot-canary window), sends one short prompt, then ends the
 * session the way the mode names. It costs one small prompt of account quota
 * and leaves a transcript under ~/.claude/projects/<slug>/.
 *
 * Run a COPY of a Claude version you are not using day to day, so its
 * boot-canary state in ~/.claude.json is keyed away from your live install
 * (copy one from ~/.local/share/claude/versions/). The auto-updater is turned
 * off for the run. The working directory must be one Claude already trusts.
 *
 * Usage:
 *   node scripts/probe-claude-exit-paths.js --mode <mode> --claude <path-to-claude-copy.exe> [--cwd <trusted dir>]
 *
 * Modes:
 *   graceful               Ctrl+C then /exit while the shell lives
 *   close                  the app's kill() of a mature session: close the console at once
 *   suspend                the app's suspend(): exit sequence, wait 1500 ms, close the console
 *   orphan-terminate       shell killed from outside, then TerminateProcess on claude 1.5 s later
 *   orphan-ipty-write      shell killed, then the exit sequence through IPty.write()
 *   orphan-console-input   shell killed, then the exit sequence through the agent's input pipe
 *                          (what the pty host does; spawn/exited-console-input.ts)
 *   orphan-conhost         shell killed, then the console host terminated
 *   clear                  /clear, then /exit: the gap between /clear's SessionEnd and the
 *                          SessionStart that follows it, which the Command Terminal end settle
 *                          (COMMAND_TERMINAL_AGENT_END_SETTLE_MS in session-manager.ts) must outlast
 *   resume                 /resume left open as a user browsing it would, then another session
 *                          chosen, then /exit: whether the open picker alone runs SessionEnd (no
 *                          settle could outlast a user's browsing), and the choice's own gap
 *
 * Matrix cells (task #854): one way of ending Claude, in one state, at one age.
 *   node scripts/probe-claude-exit-paths.js --end <path> --state <state> --age young|mature
 *        --claude <copy.exe> [--channel console|orphan] [--renderer setting|no-flicker]
 *        [--lock-hold-ms <n>] [--siblings <n>] [--app-settings <settings.json> [--mcp-config <file>]]
 *        [--out <results.jsonl>]
 *   node scripts/probe-claude-exit-paths.js --matrix --claude <copy.exe> --out <results.jsonl>
 *        [--ends a,b] [--states a,b] [--ages a,b] [--repeat <n>] [the cell flags above]
 *   node scripts/probe-claude-exit-paths.js --deciders --claude <copy.exe> --out <results.jsonl>
 *        the cells the exit decision rests on (DECIDING_CELLS): `close` in every state and age,
 *        and `esc-clear-exit` through --channel orphan. Rerun them on a Claude Code release whose
 *        notes touch exiting, SessionEnd, signal or console handling, or the fullscreen renderer,
 *        and on any change to how Kangentic ends a session. Every cell must pass. About 25 minutes.
 *
 *   The Linux counterpart is scripts/probe-claude-exit-paths-linux.py (the same cells, a hangup
 *   in place of the console close; runnable in WSL against a local stand-in for the API).
 *
 *   End paths are fixed bytes and delays, the same in every state, because the app sends them
 *   blind (see END_PATHS). `close` is the app's console close. States: idle; busy (a turn
 *   running: the prompt is a positional argument when young, as the app's command builder passes
 *   it, and typed when mature); typed (a two-line draft pasted, not submitted); dialog (a Bash
 *   permission prompt open, with user settings left out so no allow rule answers it). Young acts
 *   only while the run's own fullscreenBootPending record is present; a run whose record was never
 *   armed or was already withdrawn is void. The orphan channel kills the shell from outside and
 *   writes the end path to the dead shell's console input, as the pty host's orphan ask does.
 *
 *   Every cell scrubs its own leftover fullscreenBootPending record (dead pids only, under
 *   Claude's ~/.claude.json.lock, temp file plus rename) so a failed young run is never a strike
 *   for the next launch of that version. It refuses to run a version whose fullscreen renderer is
 *   auto-disabled on this machine, since it would boot the classic renderer and measure nothing.
 *
 * Matrix measured 2026-10-19 on Claude Code 2.1.302 (and the deciding cells on 2.1.303), Windows
 * 11 build 26200, node-pty 1.1.0 (task #854). Pass = exits by itself, SessionEnd ran, a young
 * record withdrawn, no new turn, no tool run:
 *   current (\x03 /exit\r)   idle, typed pass; busy (still thinking): prompt put back with /exit
 *                            appended and sent as a second turn, no exit; dialog: tool approved,
 *                            no exit
 *   close                    every state, young and mature: SessionEnd (other), record gone within
 *                            170 ms, exit 0.3 to 0.9 s (1.9 s streaming); under --lock-hold-ms 600
 *                            record within 1.15 s, exit within 2.6 s; --siblings 2 record within
 *                            125 ms; 2.1.303 --app-settings exit 0.4 to 2 s, once 4 s
 *   ctrl-c-twice             busy and dialog: no exit; typed young: 4.5 s
 *   ctrl-d-twice             typed and dialog: no exit
 *   esc-clear-exit           every state, 0.9 to 1.3 s (2 s streaming, 1.5 to 2 s under lock
 *                            contention); through --channel orphan every state, 0.9 to 1.2 s
 *   esc-ctrl-c-ladder        young idle and dialog over 1.5 s
 *   --renderer no-flicker    alt screen entered, no record ever written (2.1.302 and 2.1.303)
 *   precedence (2.1.303)     no-flicker over --tui default: fullscreen; --env
 *                            CLAUDE_CODE_NO_FLICKER=0 over tui fullscreen: classic; --env
 *                            CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 over no-flicker: classic
 *   Young streaming was not reachable: the first answer to a launch prompt began about 15 s
 *   after the first frame. No probe run wrote an /exit record into a transcript that already
 *   held an exchange.
 *
 * Measured 2026-10-11 on Claude Code 2.1.294, Windows 11 build 26200, node-pty 1.1.0:
 *   graceful              hook 191 ms (prompt_input_exit), exit 622 ms, transcript +3 lines
 *   close                 hook 131 ms (other), exit 585 ms, transcript +2 lines
 *   suspend               hook 169 ms (prompt_input_exit), gone before the close
 *   orphan-terminate      no hook, no exit records
 *   orphan-ipty-write     never arrived; still running at 15 s
 *   orphan-console-input  hook ran (prompt_input_exit), exit about 600 ms after the write, +3 lines
 *   orphan-conhost        still running at 15 s
 *   clear                 /clear: SessionEnd 574 ms (clear), SessionStart 722 ms (clear), 148 ms
 *                         apart, Claude still running; the /exit after it: hook 174 ms, exit 593 ms
 *   resume                picker open 8 s: no hook, Claude running; the choice: SessionEnd 423 ms
 *                         (resume), SessionStart 539 ms (resume), 116 ms apart, Claude still
 *                         running; the /exit after it: hook 250 ms, exit 654 ms
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const MODES = ['graceful', 'close', 'suspend', 'orphan-terminate', 'orphan-ipty-write', 'orphan-console-input', 'orphan-conhost', 'clear', 'resume'];

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const mode = argument('mode');
const endArgument = argument('end');
const decidersRun = process.argv.includes('--deciders');
const matrixRun = process.argv.includes('--matrix') || decidersRun;
const summaryOnly = argument('summary') !== undefined;
const claudeExe = argument('claude', process.env.CLAUDE_PATH);
const probeCwd = argument('cwd', path.join(os.tmpdir(), 'kangentic-model-probe'));
if (process.platform !== 'win32') throw new Error('This probe measures ConPTY behaviour and runs on Windows only.');
if (!summaryOnly) {
  if (!matrixRun && !endArgument && !MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')} (or use --end / --matrix)`);
  if (!claudeExe || !fs.existsSync(claudeExe)) throw new Error('--claude must name a Claude Code executable (a copy of a non-current version).');
  if (!fs.existsSync(probeCwd)) throw new Error(`--cwd ${probeCwd} does not exist; use a folder Claude already trusts.`);
}

const MATURE_WAIT_MS = 16000; // the canary record is withdrawn 10 s after the first frame
const ANSWER_WAIT_MS = 25000;
const CLEAR_WAIT_MS = 8000; // long enough for /clear's SessionEnd and SessionStart hooks to land
const RESUME_PICKER_WAIT_MS = 8000; // longer than the end settle, as a user reading the list takes

// Run in reverse when a run throws, so a failed run leaves no shell, no Claude
// session and no temp folder behind.
const cleanupOnFailure = [];

const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
const pty = require(nodePtyDir);
const { WindowsPtyAgent } = require(path.join(nodePtyDir, 'lib', 'windowsPtyAgent'));
// The app's patch (src/main/pty/spawn/conpty-console-list.ts).
WindowsPtyAgent.prototype._getConsoleProcessList = function consoleList() {
  return Promise.resolve(this._exitCode === undefined ? [this._innerPid] : []);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function childrenOf(pid) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object ProcessId,Name | ConvertTo-Json -Compress`], { encoding: 'utf8' });
  const text = (result.stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function consoleHostsOf(pid) {
  return childrenOf(pid).filter((child) => /^(conhost|openconsole)\.exe$/i.test(child.Name)).map((child) => child.ProcessId);
}

function newestTranscript(sinceMs) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const slugPart = path.basename(probeCwd);
  let newest = null;
  for (const directory of fs.readdirSync(projectsDir)) {
    if (!directory.includes(slugPart)) continue;
    for (const file of fs.readdirSync(path.join(projectsDir, directory))) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = path.join(projectsDir, directory, file);
      const modified = fs.statSync(fullPath).mtimeMs;
      if (modified >= sinceMs && (!newest || modified > newest.modified)) newest = { fullPath, modified };
    }
  }
  return newest && newest.fullPath;
}

function transcriptState(transcriptPath) {
  if (!transcriptPath) return { found: false };
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter((line) => line.length > 0);
  let lastLineParses = true;
  try {
    JSON.parse(lines[lines.length - 1]);
  } catch {
    lastLineParses = false;
  }
  return { found: true, lines: lines.length, lastLineParses };
}

/** The hook marker's lines written at or after `sinceMs`, oldest first. */
function hookLinesSince(markerPath, sinceMs) {
  if (!fs.existsSync(markerPath)) return [];
  return fs.readFileSync(markerPath, 'utf8').trim().split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split(' ');
      return { at: Number(fields[0]), label: fields[1], reason: fields.slice(2).join(' ') };
    })
    .filter((hookLine) => hookLine.at >= sinceMs);
}

/** End and start hook timings for one step, relative to when the step began. */
function endStartGap(hookLines, stepAt) {
  const end = hookLines.find((hookLine) => hookLine.label === 'end');
  const start = hookLines.find((hookLine) => hookLine.label === 'start');
  return {
    endMsAfterStep: end ? end.at - stepAt : null,
    endReason: end ? end.reason : null,
    startMsAfterStep: start ? start.at - stepAt : null,
    startSource: start ? start.reason : null,
    endToStartGapMs: end && start ? start.at - end.at : null,
  };
}

function canaryRecordFor(pid) {
  const state = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  return Boolean(state.fullscreenBootPending && Object.prototype.hasOwnProperty.call(state.fullscreenBootPending, String(pid)));
}

async function main() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-exit-probe-'));
  cleanupOnFailure.push(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const markerPath = path.join(runDir, 'hooks.log');
  const hookScript = path.join(runDir, 'hook-marker.js');
  fs.writeFileSync(hookScript, [
    "const fs = require('node:fs');",
    'const [, , markerPath, label] = process.argv;',
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  let reason = '';",
    "  try { const payload = JSON.parse(input); reason = payload.reason || payload.source || ''; } catch { /* no payload */ }",
    '  fs.appendFileSync(markerPath, `${Date.now()} ${label} ${reason}\\n`);',
    '});',
  ].join('\n'));
  const hook = (label) => `node "${hookScript.replace(/\\/g, '/')}" "${markerPath.replace(/\\/g, '/')}" ${label}`;
  const settingsPath = path.join(runDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    tui: 'fullscreen',
    hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: hook('start') }] }],
      SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: hook('end') }] }],
    },
  }));

  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  for (const key of Object.keys(env)) if (/^CLAUDE_?CODE/i.test(key)) delete env[key];

  const startedAt = Date.now();
  const shell = pty.spawn('pwsh.exe', ['-NoLogo', '-NoProfile'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: probeCwd, env });
  let output = '';
  let shellExitedAt = null;
  shell.onData((data) => { output += data; });
  shell.onExit(() => { shellExitedAt = Date.now(); });
  cleanupOnFailure.push(() => { if (shellExitedAt === null) shell.kill(); });

  await sleep(2000);
  shell.write(`& "${claudeExe}" --settings "${settingsPath}" --model haiku\r`);
  const launchMark = output.length;
  const firstFrameDeadline = Date.now() + 30000;
  while (!output.slice(launchMark).includes('\x1b[?25l') && Date.now() < firstFrameDeadline) await sleep(100);
  await sleep(MATURE_WAIT_MS);

  const claude = childrenOf(shell.pid).find((child) => /^claude(\.exe)?$/i.test(child.Name) || child.Name.toLowerCase() === path.basename(claudeExe).toLowerCase());
  if (!claude) throw new Error('Claude did not start under the shell');
  const claudePid = claude.ProcessId;
  cleanupOnFailure.push(() => { if (isAlive(claudePid)) process.kill(claudePid); });

  shell.write('Reply with the single word OK.');
  await sleep(400);
  shell.write('\r');
  await sleep(ANSWER_WAIT_MS);
  const transcriptBefore = transcriptState(newestTranscript(startedAt));
  const canaryBefore = canaryRecordFor(claudePid);

  let actionAt = Date.now();
  let pollFrom = actionAt;
  let stepResult = null;
  if (mode === 'clear') {
    shell.write('/clear');
    await sleep(400);
    shell.write('\r');
    await sleep(CLEAR_WAIT_MS);
    stepResult = { ...endStartGap(hookLinesSince(markerPath, actionAt), actionAt), claudeAlive: isAlive(claudePid) };
  } else if (mode === 'resume') {
    shell.write('/resume');
    await sleep(400);
    shell.write('\r');
    await sleep(RESUME_PICKER_WAIT_MS);
    const pickerOpen = { hookLines: hookLinesSince(markerPath, actionAt), claudeAlive: isAlive(claudePid) };
    // Choose the entry below the highlighted one: another session in this folder.
    const chosenAt = Date.now();
    shell.write('\x1b[B');
    await sleep(300);
    shell.write('\r');
    await sleep(CLEAR_WAIT_MS);
    stepResult = {
      pickerOpen,
      chosen: { ...endStartGap(hookLinesSince(markerPath, chosenAt), chosenAt), claudeAlive: isAlive(claudePid) },
      screenTail: output.slice(-1500).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
    };
  }
  if (stepResult) {
    // Then end it as a user would; the fields below describe this exit.
    actionAt = Date.now();
    pollFrom = actionAt;
    shell.write('\x03');
    shell.write('/exit\r');
  } else if (mode === 'graceful') {
    shell.write('\x03');
    shell.write('/exit\r');
  } else if (mode === 'close') {
    shell.kill();
  } else if (mode === 'suspend') {
    shell.write('\x03');
    shell.write('/exit\r');
    await sleep(1500);
    if (shellExitedAt === null) shell.kill();
  } else {
    process.kill(shell.pid); // something outside the app kills the shell
    while (shellExitedAt === null && Date.now() - actionAt < 10000) await sleep(25);
    pollFrom = Date.now();
    if (mode === 'orphan-terminate') {
      await sleep(1500);
      if (isAlive(claudePid)) process.kill(claudePid);
    } else if (mode === 'orphan-ipty-write') {
      shell.write('\x03');
      shell.write('/exit\r');
    } else if (mode === 'orphan-console-input') {
      const input = shell._agent && shell._agent.inSocket;
      input.write('\x03');
      input.write('/exit\r');
    } else if (mode === 'orphan-conhost') {
      for (const consoleHostPid of consoleHostsOf(process.pid)) process.kill(consoleHostPid);
    }
  }

  let claudeExitedAt = null;
  while (Date.now() - actionAt < 15000) {
    if (!isAlive(claudePid)) {
      claudeExitedAt = Date.now();
      break;
    }
    await sleep(25);
  }
  const forced = claudeExitedAt === null;
  if (forced) process.kill(claudePid);
  await sleep(2500);
  if (shellExitedAt === null) shell.kill();

  const endLine = hookLinesSince(markerPath, actionAt).find((hookLine) => hookLine.label === 'end');
  console.log(JSON.stringify({
    mode,
    ...(stepResult ? { [mode]: stepResult } : {}),
    claudeVersion: spawnSync(claudeExe, ['--version'], { encoding: 'utf8' }).stdout.trim(),
    claudeExitedMsAfterAction: claudeExitedAt === null ? null : claudeExitedAt - actionAt,
    claudeExitedMsAfterOrphanStep: claudeExitedAt === null || pollFrom === actionAt ? null : claudeExitedAt - pollFrom,
    forcedAfter15s: forced,
    sessionEndHookRan: Boolean(endLine),
    sessionEndHookMsAfterAction: endLine ? endLine.at - actionAt : null,
    sessionEndReason: endLine ? endLine.reason : null,
    transcriptBefore,
    transcriptAfter: transcriptState(newestTranscript(startedAt)),
    canaryRecordBefore: canaryBefore,
    canaryRecordAfter: canaryRecordFor(claudePid),
  }, null, 2));
  fs.rmSync(runDir, { recursive: true, force: true });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Matrix cells (task #854)
// ---------------------------------------------------------------------------

/** Fixed bytes and delays, identical in every state. `null` is the console close. */
const END_PATHS = {
  current: ['\x03', '/exit\r'],
  close: null,
  'ctrl-c-twice': ['\x03', { delayMs: 300 }, '\x03'],
  'ctrl-d-twice': ['\x04', { delayMs: 300 }, '\x04'],
  'esc-clear-exit': ['\x1b', { delayMs: 400 }, '\x03', '/exit\r'],
  'esc-ctrl-c-ladder': ['\x1b', { delayMs: 400 }, '\x03', { delayMs: 300 }, '\x03', { delayMs: 300 }, '\x03'],
};
const STATES = ['idle', 'busy', 'streaming', 'typed', 'dialog'];
const AGES = ['young', 'mature'];
const CHANNELS = ['console', 'orphan'];
const RENDERERS = ['setting', 'no-flicker'];

/** How long Claude may take to exit by itself before a cell fails, per way of asking. */
const EXIT_BOUND_MS = { typedConsole: 1500, close: 5000, orphan: 10000 };
const CELL_OBSERVE_MS = 15000;
const STATE_TIMEOUT_MS = 25000;
// A turn interrupted before any assistant text has its prompt put back in the input box (what
// turned the incident's /exit into a second turn: its agents were still thinking 2.3 s in); one
// interrupted after text keeps that text and restores nothing. `busy` acts 250 ms after the
// submit, while the model is still thinking; `streaming` acts once the answer is on screen. Each
// is void if the screen says otherwise.
const ACT_AFTER_SUBMIT_MS = { busy: 250 };
const NO_FLICKER_YOUNG_LIMIT_MS = 9000; // no record to read, so young is a clock reading
// Long enough that the answer streams for many seconds: haiku writes 400 numbers in about one.
const BUSY_PROMPT = 'Write the numbers 1 to 2000, one per line, no other text.';
// Idle and typed cells finish one short exchange first, as a task's session has, so the
// transcript exists and an exit record in it can be seen.
const IDLE_PROMPT = 'Reply with the single word OK.';
const DRAFT_TEXT = 'first line of a draft\nsecond line of a draft';
const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json');
const CLAUDE_JSON_LOCK_PATH = `${CLAUDE_JSON_PATH}.lock`;
const MARKER_HOOK_EVENTS = [
  ['SessionStart', 'start'],
  ['SessionEnd', 'end'],
  ['UserPromptSubmit', 'prompt'],
  ['PreToolUse', 'pre-tool'],
  ['PostToolUse', 'post-tool'],
  ['PermissionRequest', 'permission'],
  ['Notification', 'notification'],
  ['Stop', 'stop'],
];

const forwardSlash = (value) => value.replace(/\\/g, '/');
const sleepUntil = (epochMs) => sleep(Math.max(0, epochMs - Date.now()));

async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return Boolean(predicate());
}

/** `~/.claude.json` parsed, or null while a writer has it half written. */
function readClaudeJsonState() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** Claude's own lock protocol (src/main/agent/adapters/claude/claude-json-lock.ts). */
async function withClaudeJsonFileLock(operation) {
  const startedAt = Date.now();
  const ladder = [50, 100, 200, 400, 800];
  let attempt = 0;
  for (;;) {
    try {
      fs.mkdirSync(CLAUDE_JSON_LOCK_PATH);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let stale = false;
    try {
      stale = Date.now() - fs.statSync(CLAUDE_JSON_LOCK_PATH).mtimeMs > 10000;
    } catch {
      // Released between the mkdir and the stat.
    }
    if (stale) {
      fs.rmSync(CLAUDE_JSON_LOCK_PATH, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - startedAt >= 12000) throw new Error('ELOCKED: ~/.claude.json.lock was held past the budget');
    await sleep(attempt < ladder.length ? ladder[attempt] : 1000);
    attempt += 1;
  }
  try {
    return await operation();
  } finally {
    fs.rmSync(CLAUDE_JSON_LOCK_PATH, { recursive: true, force: true });
  }
}

/**
 * Remove this run's own fullscreenBootPending records for pids that are dead,
 * so a failed young run never becomes a strike for the next launch of this
 * version. Reads inside the lock, writes a temp file and renames it over the
 * original: every running Claude reads this file.
 */
async function scrubDeadCanaryRecords(pids) {
  const deadPids = pids.filter((pid) => Number.isInteger(pid) && pid > 0 && !isAlive(pid)).map(String);
  if (deadPids.length === 0) return [];
  return withClaudeJsonFileLock(async () => {
    const text = fs.readFileSync(CLAUDE_JSON_PATH, 'utf8');
    const state = JSON.parse(text);
    const pending = state.fullscreenBootPending;
    const removed = deadPids.filter((pid) => pending && Object.prototype.hasOwnProperty.call(pending, pid));
    if (removed.length === 0) return [];
    for (const pid of removed) delete pending[pid];
    const tempPath = `${CLAUDE_JSON_PATH}.exit-probe-tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2) + (text.endsWith('\n') ? '\n' : ''), 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tempPath, CLAUDE_JSON_PATH);
        break;
      } catch (error) {
        if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
          fs.rmSync(tempPath, { force: true });
          throw error;
        }
        await sleep(100);
      }
    }
    return removed.map(Number);
  });
}

/** Samples which tracked pids have a fullscreenBootPending record, every 100 ms. */
function createCanarySampler(intervalMs = 100) {
  const tracked = new Map();
  const sample = () => {
    const state = readClaudeJsonState();
    if (!state) return; // half written: keep the last sample
    const pending = state.fullscreenBootPending || {};
    const now = Date.now();
    for (const [pid, record] of tracked) {
      const present = Object.prototype.hasOwnProperty.call(pending, String(pid));
      if (present) {
        if (record.firstSeenAt === null) record.firstSeenAt = now;
        record.lastSeenAt = now;
      } else if (record.present) {
        record.goneAt = now;
      }
      record.present = present;
    }
  };
  const timer = setInterval(sample, intervalMs);
  return {
    track(pid) {
      if (!tracked.has(pid)) tracked.set(pid, { firstSeenAt: null, lastSeenAt: null, goneAt: null, present: false });
      sample();
    },
    get: (pid) => tracked.get(pid),
    sampleNow: sample,
    stop: () => clearInterval(timer),
  };
}

function writeJsonMarkerHook(runDir) {
  const hookScript = path.join(runDir, 'hook-marker-json.js');
  fs.writeFileSync(hookScript, [
    "const fs = require('node:fs');",
    'const [, , markerPath, label] = process.argv;',
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const record = { at: Date.now(), label };',
    '  try {',
    '    const payload = JSON.parse(input);',
    "    record.reason = payload.reason || payload.source || '';",
    '    if (payload.tool_name) record.tool = payload.tool_name;',
    "    if (typeof payload.prompt === 'string') record.promptTail = payload.prompt.slice(-60);",
    "    if (typeof payload.message === 'string') record.message = payload.message.slice(0, 160);",
    "    if (typeof payload.transcript_path === 'string') record.transcriptPath = payload.transcript_path;",
    '  } catch { /* no payload */ }',
    "  fs.appendFileSync(markerPath, JSON.stringify(record) + '\\n');",
    '});',
  ].join('\n'));
  return hookScript;
}

function readMarker(markerPath) {
  if (!fs.existsSync(markerPath)) return [];
  return fs.readFileSync(markerPath, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function markerHooks(hookScript, markerPath) {
  const hooks = {};
  for (const [event, label] of MARKER_HOOK_EVENTS) {
    hooks[event] = [{ matcher: '', hooks: [{ type: 'command', command: `node "${forwardSlash(hookScript)}" "${forwardSlash(markerPath)}" ${label}` }] }];
  }
  return hooks;
}

/**
 * The settings file one launch gets: the marker hooks alone, or a copy of a
 * real session's merged settings (Kangentic's event-bridge hooks and status
 * line) with every path into that session's directory moved into this run's
 * directory, and the marker hooks added beside its own.
 */
function cellSettings({ hookScript, markerPath, renderer, appSettingsPath, runDir }) {
  const ownHooks = markerHooks(hookScript, markerPath);
  let settings = { hooks: ownHooks };
  if (appSettingsPath) {
    const sessionDir = forwardSlash(path.dirname(path.resolve(appSettingsPath)));
    const escapedBackslashDir = JSON.stringify(sessionDir.replace(/\//g, '\\')).slice(1, -1);
    const text = fs.readFileSync(appSettingsPath, 'utf8').split(sessionDir).join(forwardSlash(runDir)).split(escapedBackslashDir).join(forwardSlash(runDir));
    if (/[\\/]\.kangentic[\\/]+sessions[\\/]/.test(text)) throw new Error('--app-settings still names a live session directory after the rewrite; refusing to write into it');
    settings = JSON.parse(text);
    delete settings.permissions; // an allow rule would answer the dialog cell's prompt
    settings.hooks = settings.hooks || {};
    for (const [event, entries] of Object.entries(ownHooks)) settings.hooks[event] = [...(settings.hooks[event] || []), ...entries];
  }
  if (renderer === 'setting') settings.tui = 'fullscreen';
  else delete settings.tui;
  // `--tui <value>` puts that value in --settings whatever the renderer, so the
  // documented precedence of the env variables over the setting can be checked.
  const tuiOverride = argument('tui');
  if (tuiOverride !== undefined) settings.tui = tuiOverride;
  return settings;
}

/** Every value of a repeatable `--name value` flag. */
function argumentsAll(name) {
  const values = [];
  for (let index = 0; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] === `--${name}`) values.push(process.argv[index + 1]);
  }
  return values;
}

/**
 * The environment the app's buildSpawnEnv gives a Claude PTY on Windows, plus
 * each `--env KEY=VALUE` (repeatable), set last so it can stand in for a
 * user's own exported variable (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`).
 */
function cellEnv(renderer) {
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  const insideClaude = env.CLAUDECODE !== undefined;
  for (const key of Object.keys(env)) if (/^CLAUDE_?CODE/i.test(key)) delete env[key];
  if (insideClaude) delete env.NO_COLOR;
  env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT = '1';
  if (renderer === 'no-flicker') env.CLAUDE_CODE_NO_FLICKER = '1';
  for (const pair of argumentsAll('env')) {
    const separator = pair.indexOf('=');
    if (separator > 0) env[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return env;
}

function launchClaude({ label, runDir, env, settings, markerPath, positional, extraArgs }) {
  const settingsPath = path.join(runDir, `${label}-settings.json`);
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const shell = pty.spawn('pwsh.exe', ['-NoLogo', '-NoProfile'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: probeCwd, env });
  const handle = { label, shell, markerPath, output: '', launchMark: 0, launchedAt: null, altScreenAt: null, shellExitedAt: null, claudePid: null };
  shell.onData((data) => {
    handle.output += data;
    if (handle.altScreenAt === null && handle.launchedAt !== null && handle.output.indexOf('\x1b[?1049h', handle.launchMark) >= 0) {
      handle.altScreenAt = Date.now();
    }
  });
  shell.onExit(() => { handle.shellExitedAt = Date.now(); });
  handle.start = async () => {
    await sleep(2000);
    const parts = [`& "${claudeExe}"`, '--settings', `"${settingsPath}"`, '--model', 'haiku', ...extraArgs];
    // After `--`, as the app's command builder puts it: `--mcp-config` takes a
    // list and would read the prompt as one more config file.
    if (positional) parts.push('--', `'${positional}'`);
    handle.launchMark = handle.output.length;
    handle.launchedAt = Date.now();
    shell.write(`${parts.join(' ')}\r`);
  };
  return handle;
}

async function findClaudePid(shellPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = childrenOf(shellPid).find((row) => /^claude/i.test(row.Name));
    if (child) return child.ProcessId;
    await sleep(200);
  }
  return null;
}

async function writeSteps(write, steps) {
  for (const step of steps) {
    if (typeof step === 'string') write(step);
    else await sleep(step.delayMs);
  }
}

function transcriptLines(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  return fs.readFileSync(transcriptPath, 'utf8').split('\n').filter((line) => line.length > 0);
}

/**
 * Whether the busy prompt's answer was already on screen: three consecutive
 * numbers in the output with the escape sequences taken out (the fullscreen
 * view shows the answer's latest rows, not its first). Read from the screen,
 * not the transcript, which writes an assistant message only once it ends,
 * stamped then, so an interrupted answer always reads as written after it.
 */
function answerOnScreen(output) {
  const text = output
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b./g, ' ');
  const runs = /(?:^|\D)(\d+)\s+(\d+)\s+(\d+)(?=\D|$)/g;
  for (let match = runs.exec(text); match !== null; match = runs.exec(text)) {
    const first = Number(match[1]);
    if (Number(match[2]) === first + 1 && Number(match[3]) === first + 2) return true;
    runs.lastIndex = match.index + 1;
  }
  return false;
}

function transcriptPathOf(handle, sinceMs) {
  const start = readMarker(handle.markerPath).find((line) => line.label === 'start' && line.transcriptPath);
  return start ? start.transcriptPath : newestTranscript(sinceMs);
}

/** Puts the session in the cell's state. `confirmed` says whether it got there. */
async function setUpState(handle, options, statePrompt) {
  const since = options.age === 'young' ? handle.launchedAt : Date.now();
  if (options.age === 'mature') {
    handle.shell.write(statePrompt);
    await sleep(400);
    handle.shell.write('\r');
  }
  if (options.state === 'idle' || options.state === 'typed') {
    const finished = await waitFor(() => readMarker(handle.markerPath).some((line) => line.label === 'stop' && line.at >= since), STATE_TIMEOUT_MS);
    await sleep(300);
    if (!finished || options.state === 'idle') return { confirmed: finished };
    const mark = handle.output.length;
    handle.shell.write(`\x1b[200~${DRAFT_TEXT}\x1b[201~`);
    await sleep(500);
    return { confirmed: handle.output.slice(mark).includes('draft') };
  }
  if (options.state === 'busy' || options.state === 'streaming') {
    const submitLine = () => readMarker(handle.markerPath).find((line) => line.label === 'prompt' && line.at >= since);
    if (!await waitFor(() => Boolean(submitLine()), STATE_TIMEOUT_MS, 10)) return { confirmed: false };
    const submitAt = submitLine().at;
    if (options.state === 'streaming') {
      // Thinking can run past any fixed delay; act once the answer is on screen.
      if (!await waitFor(() => answerOnScreen(handle.output.slice(handle.launchMark)), STATE_TIMEOUT_MS)) return { confirmed: false };
    } else {
      await sleepUntil(submitAt + ACT_AFTER_SUBMIT_MS.busy);
    }
    const stopped = readMarker(handle.markerPath).some((line) => line.label === 'stop' && line.at >= submitAt);
    return { confirmed: !stopped, submitAt };
  }
  const opened = await waitFor(() => readMarker(handle.markerPath).some((line) => line.at >= since
    && (line.label === 'permission' || (line.label === 'notification' && /permission/i.test(line.message || '')))), STATE_TIMEOUT_MS);
  if (opened) await sleep(300); // let the prompt finish drawing
  return { confirmed: opened };
}

function readCellOptions() {
  const options = {
    end: argument('end'),
    state: argument('state', 'idle'),
    age: argument('age', 'young'),
    channel: argument('channel', 'console'),
    renderer: argument('renderer', 'setting'),
    lockHoldMs: Number(argument('lock-hold-ms', '0')),
    siblings: Number(argument('siblings', '0')),
    appSettings: argument('app-settings', null),
    mcpConfig: argument('mcp-config', null),
    out: argument('out', null),
  };
  if (!Object.prototype.hasOwnProperty.call(END_PATHS, options.end)) throw new Error(`--end must be one of ${Object.keys(END_PATHS).join(', ')}`);
  if (!STATES.includes(options.state)) throw new Error(`--state must be one of ${STATES.join(', ')}`);
  if (!AGES.includes(options.age)) throw new Error(`--age must be one of ${AGES.join(', ')}`);
  if (!CHANNELS.includes(options.channel)) throw new Error(`--channel must be one of ${CHANNELS.join(', ')}`);
  if (!RENDERERS.includes(options.renderer)) throw new Error(`--renderer must be one of ${RENDERERS.join(', ')}`);
  if (options.channel === 'orphan' && END_PATHS[options.end] === null) throw new Error('the orphan channel has no console to close');
  return options;
}

async function runCell(options) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-exit-cell-'));
  cleanupOnFailure.push(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const env = cellEnv(options.renderer);
  const version = (spawnSync(claudeExe, ['--version'], { encoding: 'utf8', env }).stdout || '').trim().split(/\s+/)[0];
  const stateBefore = readClaudeJsonState() || {};
  if (options.renderer === 'setting' && stateBefore.fullscreenAutoDisabled && stateBefore.fullscreenAutoDisabled.version === version) {
    throw new Error(`Fullscreen is auto-disabled for ${version} on this machine, so this run would boot the classic renderer and measure nothing. Run /tui fullscreen in a Claude ${version} session first.`);
  }

  const hookScript = writeJsonMarkerHook(runDir);
  const toolMarker = forwardSlash(path.join(runDir, 'tool-ran.txt'));
  const statePrompt = options.state === 'busy' || options.state === 'streaming' ? BUSY_PROMPT
    : options.state === 'dialog' ? `Use the Bash tool to run exactly this command and nothing else: touch ${toolMarker}`
      : IDLE_PROMPT;
  const sharedArgs = [];
  if (options.mcpConfig) {
    const mcpCopy = path.join(runDir, 'mcp.json');
    fs.copyFileSync(options.mcpConfig, mcpCopy);
    sharedArgs.push('--mcp-config', `"${mcpCopy}"`);
  }
  // The dialog cell leaves user settings out: an allow rule or auto mode there would answer the prompt.
  const mainArgs = options.state === 'dialog' ? [...sharedArgs, '--setting-sources', 'project,local', '--permission-mode', 'default'] : sharedArgs;

  const sampler = createCanarySampler();
  cleanupOnFailure.push(() => sampler.stop());
  const launchFor = (label, positional, extraArgs) => {
    const markerPath = path.join(runDir, `${label}-hooks.jsonl`);
    const settings = cellSettings({ hookScript, markerPath, renderer: options.renderer, appSettingsPath: options.appSettings, runDir });
    return launchClaude({ label, runDir, env, settings, markerPath, positional, extraArgs });
  };
  const main = launchFor('main', options.age === 'young' ? statePrompt : null, mainArgs);
  const siblings = [];
  for (let index = 0; index < options.siblings; index += 1) siblings.push(launchFor(`sibling-${index}`, null, sharedArgs));
  const launches = [main, ...siblings];
  // Runs after the kills below (the stack unwinds in reverse): a crashed cell
  // must not leave its own boot record behind as a strike either.
  cleanupOnFailure.push(async () => {
    await sleep(1500);
    await scrubDeadCanaryRecords(launches.map((handle) => handle.claudePid));
  });
  for (const handle of launches) {
    cleanupOnFailure.push(() => { if (handle.shellExitedAt === null) handle.shell.kill(); });
    cleanupOnFailure.push(() => { if (handle.claudePid && isAlive(handle.claudePid)) process.kill(handle.claudePid); });
  }
  let lockHeldUntilReleased = false;
  cleanupOnFailure.push(() => { if (lockHeldUntilReleased) fs.rmSync(CLAUDE_JSON_LOCK_PATH, { recursive: true, force: true }); });

  await Promise.all(launches.map((handle) => handle.start()));
  const altScreen = await waitFor(() => main.altScreenAt !== null, 30000);
  main.claudePid = await findClaudePid(main.shell.pid, 10000);
  if (!main.claudePid) throw new Error('Claude did not start under the shell');
  sampler.track(main.claudePid);
  for (const sibling of siblings) {
    sibling.claudePid = await findClaudePid(sibling.shell.pid, 10000);
    if (sibling.claudePid) sampler.track(sibling.claudePid);
  }
  const firstFrameAt = main.altScreenAt ?? Date.now();
  if (options.renderer === 'setting') await waitFor(() => sampler.get(main.claudePid).firstSeenAt !== null, 3000, 100);
  if (options.age === 'mature') await sleepUntil(firstFrameAt + MATURE_WAIT_MS);
  const setup = await setUpState(main, options, statePrompt);

  sampler.sampleNow();
  const canaryAtAction = { ...sampler.get(main.claudePid) };
  const armed = canaryAtAction.firstSeenAt !== null;
  let voidReason = null;
  if (!altScreen) voidReason = 'classic-renderer';
  else if (options.renderer === 'setting' && !armed) voidReason = 'never-armed';
  else if (options.renderer === 'setting' && options.age === 'young' && !canaryAtAction.present) voidReason = 'aged-out';
  else if (options.renderer === 'setting' && options.age === 'mature' && canaryAtAction.present) voidReason = 'still-young';
  else if (options.renderer === 'no-flicker' && options.age === 'young' && Date.now() - firstFrameAt > NO_FLICKER_YOUNG_LIMIT_MS) voidReason = 'aged-out';
  else if (!setup.confirmed) voidReason = 'state-not-reached';

  const transcriptPath = transcriptPathOf(main, main.launchedAt);
  const transcriptBefore = transcriptLines(transcriptPath) || [];
  let lockHeld = false;
  let lockReleaseTimer = null;
  if (options.lockHoldMs > 0) {
    try {
      fs.mkdirSync(CLAUDE_JSON_LOCK_PATH);
      lockHeld = true;
      lockHeldUntilReleased = true;
      lockReleaseTimer = setTimeout(() => {
        lockHeldUntilReleased = false;
        fs.rmSync(CLAUDE_JSON_LOCK_PATH, { recursive: true, force: true });
      }, options.lockHoldMs);
    } catch {
      // Someone holds it already: that is contention too.
    }
  }

  const outputBeforeAction = main.output.slice(main.launchMark);
  const steps = END_PATHS[options.end];
  let actionAt = Date.now();
  let shellKilledAt = null;
  if (options.channel === 'orphan') {
    process.kill(main.shell.pid); // something outside the app kills the shell
    shellKilledAt = Date.now();
    await waitFor(() => main.shellExitedAt !== null, 10000, 25);
    const input = main.shell._agent && main.shell._agent.inSocket;
    if (!input) throw new Error('node-pty no longer exposes _agent.inSocket');
    input.on('error', () => { /* a write the dead console refuses fails here */ });
    actionAt = Date.now();
    await writeSteps((data) => input.write(data), steps);
  } else if (steps === null) {
    main.shell.kill();
  } else {
    await writeSteps((data) => main.shell.write(data), steps);
  }

  let claudeExitedAt = null;
  while (Date.now() - actionAt < CELL_OBSERVE_MS) {
    if (!isAlive(main.claudePid)) {
      claudeExitedAt = Date.now();
      break;
    }
    await sleep(25);
  }
  const forced = claudeExitedAt === null;
  if (forced) {
    try {
      process.kill(main.claudePid);
    } catch {
      // Gone meanwhile.
    }
  }
  await sleep(1500);
  sampler.sampleNow();
  const canaryAfter = { ...sampler.get(main.claudePid) };
  await sleep(1000);
  if (main.shellExitedAt === null) main.shell.kill();

  // Siblings end the way a mature idle session safely does.
  for (const sibling of siblings) {
    if (sibling.altScreenAt !== null) await sleepUntil(sibling.altScreenAt + MATURE_WAIT_MS);
    if (sibling.shellExitedAt === null) {
      sibling.shell.write('\x03');
      sibling.shell.write('/exit\r');
    }
    if (sibling.claudePid) await waitFor(() => !isAlive(sibling.claudePid), 5000, 50);
    if (sibling.claudePid && isAlive(sibling.claudePid)) process.kill(sibling.claudePid);
    if (sibling.shellExitedAt === null) sibling.shell.kill();
  }
  await sleep(500);
  sampler.sampleNow();
  sampler.stop();
  const scrubbedPids = await scrubDeadCanaryRecords(launches.map((handle) => handle.claudePid));
  const stateAfter = readClaudeJsonState() || {};

  const afterAction = readMarker(main.markerPath).filter((line) => line.at >= actionAt);
  const endLine = afterAction.find((line) => line.label === 'end');
  const extraPrompts = afterAction.filter((line) => line.label === 'prompt');
  const toolRan = afterAction.some((line) => line.label === 'post-tool') || fs.existsSync(toolMarker);
  const transcriptAfter = transcriptLines(transcriptPathOf(main, main.launchedAt)) || [];
  const added = transcriptAfter.slice(transcriptBefore.length);
  let transcriptLastLineParses = null;
  if (transcriptAfter.length > 0) {
    try {
      JSON.parse(transcriptAfter[transcriptAfter.length - 1]);
      transcriptLastLineParses = true;
    } catch {
      transcriptLastLineParses = false;
    }
  }
  const assistantTextBeforeAction = answerOnScreen(outputBeforeAction);
  if (!voidReason && options.state === 'busy' && assistantTextBeforeAction) voidReason = 'output-already-started';
  if (!voidReason && options.state === 'streaming' && !assistantTextBeforeAction) voidReason = 'output-not-started';
  const exitBoundMs = options.channel === 'orphan' ? EXIT_BOUND_MS.orphan : steps === null ? EXIT_BOUND_MS.close : EXIT_BOUND_MS.typedConsole;
  const claudeExitedMs = claudeExitedAt === null ? null : claudeExitedAt - actionAt;
  const shellExitedMs = main.shellExitedAt === null ? null : main.shellExitedAt - actionAt;
  const canaryLeft = Boolean(canaryAfter.present);
  const failures = [];
  if (voidReason) failures.push(`void:${voidReason}`);
  if (forced) failures.push('did-not-exit');
  else if (claudeExitedMs > exitBoundMs) failures.push(`slow-exit>${exitBoundMs}ms`);
  if (!endLine) failures.push('no-session-end');
  if (options.age === 'young' && canaryLeft) failures.push('canary-left');
  if (extraPrompts.length > 0) failures.push('extra-turn');
  if (toolRan) failures.push('tool-ran');
  if (transcriptLastLineParses === false) failures.push('transcript-torn');
  // What this renderer exists to show: such a session never writes a boot record.
  if (options.renderer === 'no-flicker' && (armed || canaryAfter.firstSeenAt !== null)) failures.push('canary-armed-under-no-flicker');

  // A hold longer than the cell would leave the lock behind once the process exits.
  if (lockHeldUntilReleased) {
    clearTimeout(lockReleaseTimer);
    lockHeldUntilReleased = false;
    fs.rmSync(CLAUDE_JSON_LOCK_PATH, { recursive: true, force: true });
  }
  sampler.stop();
  fs.rmSync(runDir, { recursive: true, force: true });
  return {
    at: new Date(actionAt).toISOString(),
    version,
    end: options.end,
    state: options.state,
    age: options.age,
    channel: options.channel,
    renderer: options.renderer,
    extraEnv: argumentsAll('env'),
    lockHoldMs: options.lockHoldMs,
    lockHeld,
    siblings: options.siblings,
    appSettings: Boolean(options.appSettings),
    pass: failures.length === 0,
    failures,
    altScreen,
    armed,
    armedMsAfterFirstFrame: armed ? canaryAtAction.firstSeenAt - firstFrameAt : null,
    stateConfirmed: setup.confirmed,
    assistantTextBeforeAction,
    actionMsAfterFirstFrame: actionAt - firstFrameAt,
    shellKilledMsBeforeAction: shellKilledAt === null ? null : actionAt - shellKilledAt,
    claudeExitedMs,
    shellExitedMs,
    claudeOutlivedShellMs: claudeExitedMs !== null && shellExitedMs !== null ? claudeExitedMs - shellExitedMs : null,
    forcedAfter15s: forced,
    sessionEndRan: Boolean(endLine),
    sessionEndReason: endLine ? endLine.reason : null,
    sessionEndMs: endLine ? endLine.at - actionAt : null,
    canaryAtAction: canaryAtAction.present,
    canaryWithdrawnMs: canaryAfter.goneAt !== null && canaryAfter.goneAt >= actionAt ? canaryAfter.goneAt - actionAt : null,
    canaryLeft,
    canaryEverArmed: armed || canaryAfter.firstSeenAt !== null,
    scrubbedPids,
    extraTurn: extraPrompts.length > 0,
    extraTurnPromptTail: extraPrompts.length > 0 ? extraPrompts[0].promptTail : null,
    toolRanAfterAction: toolRan,
    transcriptFound: transcriptAfter.length > 0,
    transcriptLinesAdded: added.length,
    exitRecordInTranscript: added.some((line) => line.includes('<command-name>/exit') || line.includes('local-command-stdout')),
    transcriptLastLineParses,
    strikesBefore: stateBefore.fullscreenBootStrikes ?? null,
    strikesAfter: stateAfter.fullscreenBootStrikes ?? null,
    autoDisabledAfter: stateAfter.fullscreenAutoDisabled ?? null,
  };
}

/** Exit status of a cell that ran and recorded a failure; a crash exits 1. */
const CELL_FAILED_EXIT_STATUS = 2;
/** The matrix stops a cell at 240 s from outside, where its own cleanup cannot run; it stops itself first. */
const CELL_SELF_TIMEOUT_MS = 230000;
const MATRIX_CELL_TIMEOUT_MS = 240000;

async function undoCellSetup() {
  for (const undo of cleanupOnFailure.reverse()) {
    try {
      await undo();
    } catch {
      // Best-effort: the rest still run.
    }
  }
}

async function cellMain() {
  if (!claudeExe || !fs.existsSync(claudeExe)) throw new Error('--claude must name a Claude Code executable (a copy).');
  const options = readCellOptions();
  const watchdog = setTimeout(async () => {
    console.error(`[cell] still running after ${CELL_SELF_TIMEOUT_MS} ms; cleaning up`);
    await undoCellSetup();
    process.exit(1);
  }, CELL_SELF_TIMEOUT_MS);
  watchdog.unref();
  const record = await runCell(options);
  clearTimeout(watchdog);
  if (options.out) fs.appendFileSync(options.out, `${JSON.stringify(record)}\n`);
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.pass ? 0 : CELL_FAILED_EXIT_STATUS);
}

function summaryLine(record) {
  if (record.crashed) return `${record.end.padEnd(18)} ${record.state.padEnd(6)} ${record.age.padEnd(6)} CRASHED (exit ${record.exitStatus})`;
  const number = (value) => (value === null || value === undefined ? '-' : String(value));
  return [
    record.end.padEnd(18),
    record.state.padEnd(6),
    record.age.padEnd(6),
    (record.pass ? 'pass' : 'FAIL').padEnd(4),
    `exit=${number(record.claudeExitedMs)}`,
    `shell=${number(record.shellExitedMs)}`,
    `end=${number(record.sessionEndMs)}${record.sessionEndReason ? `(${record.sessionEndReason})` : ''}`,
    `canaryGone=${number(record.canaryWithdrawnMs)}`,
    `/exit=${record.exitRecordInTranscript ? 'yes' : 'no'}`,
    record.failures.join(','),
  ].join(' ');
}

function printSummary(records) {
  console.log('\nend                state  age    ok   timings (ms after the action) and failures');
  for (const record of records) console.log(summaryLine(record));
}

async function summaryMain() {
  const records = fs.readFileSync(argument('summary'), 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  printSummary(records);
}

/**
 * The cells the exit decision rests on (task #854), for `--deciders`: the
 * console close Claude gets on Windows in every state and age, and the typed
 * sequence through a dead shell's console, the one place it is still typed.
 */
const DECIDING_CELLS = [
  { channel: 'console', end: 'close', states: STATES, ages: AGES },
  { channel: 'orphan', end: 'esc-clear-exit', states: ['idle', 'busy', 'dialog'], ages: AGES },
];

async function matrixMain() {
  if (!claudeExe || !fs.existsSync(claudeExe)) throw new Error('--claude must name a Claude Code executable (a copy).');
  const out = argument('out');
  if (!out) throw new Error('--matrix needs --out <results.jsonl>');
  const repeat = Number(argument('repeat', '1'));
  const groups = decidersRun ? DECIDING_CELLS : [{
    channel: argument('channel', 'console'),
    ends: argument('ends', Object.keys(END_PATHS).join(',')).split(','),
    states: argument('states', STATES.join(',')).split(','),
    ages: argument('ages', AGES.join(',')).split(','),
  }];
  const passThrough = ['--claude', claudeExe, '--cwd', probeCwd, '--out', out];
  for (const name of ['renderer', 'lock-hold-ms', 'siblings', 'app-settings', 'mcp-config']) {
    const value = argument(name);
    if (value !== undefined) passThrough.push(`--${name}`, value);
  }
  for (const pair of argumentsAll('env')) passThrough.push('--env', pair);
  if (argument('tui') !== undefined) passThrough.push('--tui', argument('tui'));
  const cells = [];
  for (const group of groups) {
    for (const end of group.ends ?? [group.end]) {
      for (const state of group.states) {
        for (const age of group.ages) {
          for (let run = 0; run < repeat; run += 1) {
            if (group.channel === 'orphan' && END_PATHS[end] === null) continue;
            cells.push({ end, state, age, channel: group.channel });
          }
        }
      }
    }
  }
  const linesBefore = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter((line) => line.length > 0).length : 0;
  for (const [index, cell] of cells.entries()) {
    console.log(`[matrix] ${index + 1}/${cells.length} channel=${cell.channel} end=${cell.end} state=${cell.state} age=${cell.age}`);
    const result = spawnSync(process.execPath, [__filename, '--end', cell.end, '--state', cell.state, '--age', cell.age, '--channel', cell.channel, ...passThrough], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: MATRIX_CELL_TIMEOUT_MS,
    });
    if (result.status !== 0 && result.status !== CELL_FAILED_EXIT_STATUS) {
      console.log(`[matrix]   cell failed to run (exit ${result.status})`);
      fs.appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), end: cell.end, state: cell.state, age: cell.age, channel: cell.channel, crashed: true, exitStatus: result.status })}\n`);
    }
    await sleep(2000); // let the last Claude's ~/.claude.json writes settle
  }
  const records = fs.readFileSync(out, 'utf8').split('\n').filter((line) => line.length > 0).slice(linesBefore).map((line) => JSON.parse(line));
  printSummary(records);
  // A failed, void or crashed cell fails the run, so a wrapper can tell.
  process.exit(records.every((record) => !record.crashed && record.pass) ? 0 : 1);
}

const entry = summaryOnly ? summaryMain : matrixRun ? matrixMain : endArgument ? cellMain : main;
entry().catch(async (error) => {
  console.error(error);
  await undoCellSetup();
  process.exit(1);
});
