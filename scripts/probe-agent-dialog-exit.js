#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI. WINDOWS (ConPTY) ONLY.
 *
 * Does an adapter's exit sequence, typed into an open tool-permission prompt,
 * answer that prompt? Claude's old `\x03` + `/exit\r` did: the Enter landed
 * on the highlighted Yes and ran the tool (task #854). For one agent: launch
 * it in a ConPTY under pwsh, as the pty host does (the command typed into the
 * live shell), with a prompt asking for one shell command that writes a
 * marker file; wait until its confirmation prompt is on screen; write the
 * adapter's exit sequence as the session manager does (each string at once,
 * back to back); then record whether the marker appeared and whether the CLI
 * exited. It costs one short prompt of the agent's own quota.
 *
 * Like the trust managers do before a spawn, it adds a TRUST_FOLDER entry for
 * the run folder to Gemini's or Qwen's trustedFolders.json, and removes it
 * after. It answers a folder-trust dialog shown before the prompt (Copilot's)
 * with Enter, never one that shows the command.
 *
 * Usage:
 *   node scripts/probe-agent-dialog-exit.js --agent <gemini|qwen|copilot|kimi|droid|grok>
 *        [--sequence '<json array of the steps to write>'] [--out <results.jsonl>]
 *
 * Measured 2026-10-19, Windows 11 build 26200, node-pty 1.1.0, each in the
 * mode that asks before a shell command:
 *   gemini 0.64.0 (Default)  Ctrl+C cancelled the request and the tool never ran;
 *                            `/quit` stayed in the input unsubmitted, so Gemini kept
 *                            running until the force-kill
 *   copilot 1.0.98 (Default) "Operation aborted by user", the tool never ran; `/exit`
 *                            did not take, Copilot kept running until the force-kill
 *   qwen, kimi, droid        not logged in on the probing machine: not measured
 *   grok 1.0.0               the service refused the version (426), no prompt reached
 *   aider, goose, ollama     not installed: not measured
 * Codex, Cursor, OpenCode, Warp and Antigravity send Ctrl+C alone, with no
 * Enter that could answer a prompt.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.platform !== 'win32') throw new Error('This probe measures ConPTY behaviour and runs on Windows only.');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What Kangentic's trust managers write before a spawn (`gemini/trust-manager.ts`,
 * `qwen-code/trust-manager.ts`): a TRUST_FOLDER entry for the session's folder,
 * so a session never meets the folder-trust dialog. Removed after the run.
 */
function trustedFoldersEditor(configDirName) {
  const file = path.join(os.homedir(), configDirName, 'trustedFolders.json');
  const rewrite = (mutate) => {
    let entries = {};
    try {
      entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      // Absent: start one. A file that does not parse is the user's own list,
      // and writing ours over it would lose it.
      if (error.code !== 'ENOENT') throw new Error(`${file} could not be read (${error.message}); fix or move it first`);
    }
    mutate(entries);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.probe-tmp`, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(`${file}.probe-tmp`, file);
  };
  return {
    trust: (folder) => rewrite((entries) => { entries[folder] = 'TRUST_FOLDER'; }),
    untrust: (folder) => rewrite((entries) => { if (entries[folder] === 'TRUST_FOLDER') delete entries[folder]; }),
  };
}

const AGENTS = {
  // Each in a mode that asks before a shell command: Gemini's and Qwen's "Default (Confirm
  // Actions)", Copilot's "Default" (its acceptEdits passes --allow-all-tools).
  gemini: { sequence: ['\x03', '/quit\r'], trustDir: '.gemini', command: (prompt) => `& gemini '${prompt}'` },
  qwen: { sequence: ['\x03', '/quit\r'], trustDir: '.qwen', command: (prompt) => `& qwen '${prompt}'` },
  copilot: { sequence: ['\x03', '/exit\r'], command: (prompt) => `& copilot -i '${prompt}'` },
  kimi: { sequence: ['\x03', '/exit\r'], command: (prompt) => `& kimi --prompt '${prompt}'` },
  droid: { sequence: ['\x03', '/quit\r'], command: (prompt, cwd) => `& droid --cwd '${cwd}' '${prompt}'` },
  grok: { sequence: ['\x03', '/quit\r'], command: (prompt) => `& grok --permission-mode acceptEdits -- '${prompt}'` },
};

const TRUST = /do you trust|trust (this|the) (folder|files|directory|workspace)/i;
const DIALOG = /\b(allow|approve|deny|reject|confirm|proceed)\b|\by\/n\b|do you want|allow once|run (this|the) command|waiting for (user )?(confirmation|approval)/i;
const SHELL_PROMPT = /^PS [A-Za-z]:\\.*>\s*$/;

function screenText(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

function lastNonEmpty(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) if (lines[index].trim()) return lines[index];
  return '';
}

async function main() {
  const name = argument('agent');
  const agent = AGENTS[name];
  if (!agent) throw new Error(`--agent must be one of ${Object.keys(AGENTS).join(', ')}`);
  const sequence = argument('sequence') ? JSON.parse(argument('sequence')) : agent.sequence;
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-dialog-${name}-`));
  const marker = path.join(runDir, 'marker.txt').replace(/\\/g, '/');
  const prompt = `Run exactly this one shell command and nothing else: echo probe > ${marker}`;

  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CLAUDE_?CODE/i.test(key) || key === 'CLAUDECODE') delete env[key];
  const terminal = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
  const shell = pty.spawn('pwsh.exe', ['-NoLogo', '-NoProfile'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: runDir, env });
  let lastChangeAt = Date.now();
  let shellExited = false;
  shell.onData((data) => {
    terminal.write(data);
    lastChangeAt = Date.now();
  });
  shell.onExit(() => { shellExited = true; });

  const record = { agent: name, sequence, at: new Date().toISOString() };
  const trustEditor = agent.trustDir ? trustedFoldersEditor(agent.trustDir) : null;
  if (trustEditor) trustEditor.trust(runDir);
  try {
    await sleep(2500);
    const launchedAt = Date.now();
    shell.write(`${agent.command(prompt, runDir)}\r`);
    let trustAnswers = 0;
    let dialogAt = null;
    while (Date.now() - launchedAt < 150000) {
      await sleep(500);
      if (fs.existsSync(marker)) break;
      const lines = screenText(terminal);
      const text = lines.join('\n');
      const stableMs = Date.now() - lastChangeAt;
      // A folder-trust dialog comes before the prompt is shown; a tool prompt shows the command.
      if (TRUST.test(text) && !text.includes('marker.txt') && trustAnswers < 2 && stableMs > 1000) {
        trustAnswers += 1;
        (record.trustScreens ||= []).push(lines.filter((line) => line.trim()));
        shell.write('\r');
        lastChangeAt = Date.now();
        continue;
      }
      if (Date.now() - launchedAt > 8000 && stableMs > 1500 && DIALOG.test(text) && !SHELL_PROMPT.test(lastNonEmpty(lines))) {
        dialogAt = Date.now();
        break;
      }
    }
    record.trustAnswers = trustAnswers;
    record.screenBeforeAction = screenText(terminal).filter((line) => line.trim());
    if (fs.existsSync(marker)) {
      record.result = 'tool-ran-without-a-prompt';
      return record;
    }
    if (dialogAt === null) {
      record.result = 'no-dialog-seen';
      return record;
    }
    const actionAt = Date.now();
    for (const step of sequence) {
      if (typeof step === 'string') shell.write(step);
      else await sleep(step.delayMs);
    }
    let toolRanMs = null;
    let exitedMs = null;
    while (Date.now() - actionAt < 12000) {
      await sleep(200);
      if (toolRanMs === null && fs.existsSync(marker)) toolRanMs = Date.now() - actionAt;
      if (exitedMs === null && SHELL_PROMPT.test(lastNonEmpty(screenText(terminal)))) exitedMs = Date.now() - actionAt;
      if (exitedMs !== null && Date.now() - actionAt > exitedMs + 1500) break;
    }
    record.toolRan = toolRanMs !== null;
    record.toolRanMs = toolRanMs;
    record.cliExited = exitedMs !== null;
    record.cliExitedMs = exitedMs;
    record.screenAfterAction = screenText(terminal).filter((line) => line.trim());
    record.result = record.toolRan ? 'TOOL-APPROVED-BY-EXIT-SEQUENCE' : record.cliExited ? 'exited-tool-not-run' : 'tool-not-run-cli-still-running';
    return record;
  } finally {
    if (!shellExited) spawnSync('taskkill', ['/PID', String(shell.pid), '/T', '/F'], { stdio: 'ignore' });
    terminal.dispose();
    if (trustEditor) trustEditor.untrust(runDir);
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

main().then((record) => {
  const line = JSON.stringify(record);
  console.log(line);
  const out = argument('out');
  if (out) fs.appendFileSync(out, `${line}\n`);
  setTimeout(() => process.exit(0), 500);
}, (error) => {
  console.error(error);
  process.exit(1);
});
