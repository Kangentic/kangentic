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
const claudeExe = argument('claude', process.env.CLAUDE_PATH);
const probeCwd = argument('cwd', path.join(os.tmpdir(), 'kangentic-model-probe'));
if (process.platform !== 'win32') throw new Error('This probe measures ConPTY behaviour and runs on Windows only.');
if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
if (!claudeExe || !fs.existsSync(claudeExe)) throw new Error('--claude must name a Claude Code executable (a copy of a non-current version).');
if (!fs.existsSync(probeCwd)) throw new Error(`--cwd ${probeCwd} does not exist; use a folder Claude already trusts.`);

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

main().catch((error) => {
  console.error(error);
  for (const undo of cleanupOnFailure.reverse()) {
    try {
      undo();
    } catch {
      // Best-effort: the rest still run.
    }
  }
  process.exit(1);
});
