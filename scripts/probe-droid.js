#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Empirical probe for the Factory Droid CLI.
 *
 * Validates every claim the Kangentic Droid adapter makes about the
 * binary, with verbatim CLI evidence. Output is both human-readable
 * and machine-parseable (a final verdict block). Re-runnable; safe to
 * abort with Ctrl+C at any step.
 *
 * What it checks
 * --------------
 *   1. Detection           - is `droid` on PATH? what version?
 *   2. Help-text shape     - does `droid --help` advertise -s/--session-id
 *                            and --cwd at the top level, or are they
 *                            exec-only?
 *   3. Headless new        - `droid exec --output-format json` returns
 *                            a real session_id and is_error: false
 *   4. Headless resume     - `droid exec -s <id> --output-format json`
 *                            recalls the prior turn (verifies the same
 *                            JSON `session_id` comes back, and the
 *                            answer references the prior turn's content)
 *   5. Hook delivery       - hook entries injected via `--settings <path>`
 *                            fire on `droid` interactive (empirical state on
 *                            0.109.1: they do NOT fire, even with `model`
 *                            pinned in the merged settings)
 *   6. Interactive new     - spawns the TUI via node-pty, watches for
 *                            cursor-hide first-output marker
 *   7. Interactive resume  - spawns `droid --resume <uuid>` via node-pty
 *                            (top-level `-r/--resume`, NOT exec-only `-s`)
 *                            and asserts the TUI starts WITHOUT erroring -
 *                            the load-bearing question for whether
 *                            Kangentic's adapter can use a symmetric
 *                            new/resume command builder
 *   8. Project-level hooks - `<cwd>/.factory/settings.json` SessionStart hook
 *                            fires for an interactive `droid` invocation with
 *                            NO `--settings` flag (the documented per-project
 *                            injection vehicle; if this fires, the empty
 *                            Activity tab gap can be closed via a Codex/Gemini
 *                            -style refcounted hook-manager)
 *
 * Auth
 * ----
 * Set FACTORY_API_KEY in your env, OR run `droid` once interactively to
 * complete the browser OAuth flow before running this probe.
 *
 * Usage
 * -----
 *   node scripts/probe-droid.js
 *   node scripts/probe-droid.js --skip-pty       # only headless probes
 *   node scripts/probe-droid.js --keep-tmp       # leave tmp dir on disk
 *
 * Exit codes
 * ----------
 *   0   = all probes passed (symmetric resume confirmed)
 *   10  = droid not installed
 *   20  = auth missing / failed
 *   30  = headless new failed
 *   40  = headless resume failed
 *   50  = hooks did not fire
 *   60  = interactive new failed
 *   70  = interactive resume rejected -s flag (asymmetric path required)
 *   99  = unexpected error
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const args = process.argv.slice(2);
const SKIP_PTY = args.includes('--skip-pty');
const KEEP_TMP = args.includes('--keep-tmp');

// BYOK model selector. Accepts EITHER:
//   - the underlying model name (e.g. `claude-sonnet-4-5-20250929`) which the
//     probe resolves to the corresponding `customModels[].id` value
//   - a fully-qualified custom id (e.g. `custom:Sonnet-4.5-[BYOK]-0`) used as-is
// CRITICAL EMPIRICAL FINDING: Droid 0.109's `--model` flag wants the
// `id` field (with the `custom:` prefix), NOT the `model` field. Passing
// the underlying model directly returns `Exec failed` with num_turns=0.
const modelArgIndex = args.indexOf('--model');
const BYOK_MODEL_INPUT = modelArgIndex >= 0 && args[modelArgIndex + 1]
  ? args[modelArgIndex + 1]
  : 'claude-sonnet-4-5-20250929';
// The actual flag value is resolved later in checkAuthAvailable() and
// stored on the VERDICT object so every exec call uses the same id.
let RESOLVED_MODEL_FLAG = BYOK_MODEL_INPUT;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-droid-probe-'));
const HOOK_LOG = path.join(TMP_ROOT, 'hook.log');
const RECORD_HOOK_SCRIPT = path.join(TMP_ROOT, 'record-hook.js');
const REPORT_PATH = path.resolve(__dirname, '..', '.droid-probe-report.md');
const REPORT = [];
const VERDICT = {
  detected: null,
  detectedPath: null,
  version: null,
  topLevelSessionFlag: null,
  topLevelCwdFlag: null,
  headlessNewSessionId: null,
  headlessResumeWorked: null,
  hookFired: null,
  hookSessionIdField: null,
  ptyNewFirstOutput: null,
  ptyResumeAccepted: null,
  projectLevelHooksFire: null,
  projectLevelHookSessionIdField: null,
  projectLevelHookEventCounts: null,
  resumeStrategy: null,
};

function log(line = '') {
  process.stdout.write(line + '\n');
  REPORT.push(line);
}

function section(title) {
  log('');
  log('='.repeat(72));
  log(title);
  log('='.repeat(72));
}

function blockquote(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    log('  ' + raw);
  }
}

function cleanup() {
  if (KEEP_TMP) {
    log('');
    log(`(tmp dir kept: ${TMP_ROOT})`);
    return;
  }
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (error) {
    log(`(failed to clean tmp dir ${TMP_ROOT}: ${error.message})`);
  }
}

function writeReport() {
  try {
    fs.writeFileSync(REPORT_PATH, REPORT.join('\n') + '\n');
    log('');
    log(`Report written to ${REPORT_PATH}`);
  } catch (error) {
    log(`(failed to write report: ${error.message})`);
  }
}

function exit(code, reason) {
  if (reason) {
    log('');
    log(`EXIT ${code}: ${reason}`);
  }
  log('');
  log('--- VERDICT ---');
  for (const [key, value] of Object.entries(VERDICT)) {
    log(`  ${key.padEnd(28)} ${JSON.stringify(value)}`);
  }
  writeReport();
  cleanup();
  process.exit(code);
}

process.on('SIGINT', () => exit(130, 'aborted by user'));

// ------------------------------- helpers ---------------------------------

function which(binary) {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = childProcess.spawnSync(command, [binary], { encoding: 'utf-8' });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function runOnce(command, argv, options = {}) {
  const result = childProcess.spawnSync(command, argv, {
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? 60_000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: process.platform === 'win32',
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function safeJson(text) {
  // `droid exec --output-format json` is documented to print one final
  // JSON record to stdout; tolerate trailing newline or banner noise.
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // Sometimes the JSON is the last line of multi-line output.
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try { return JSON.parse(line); } catch { continue; }
    }
  }
  return null;
}

function checkAuthAvailable() {
  // Prefer BYOK: a `customModels` entry in `~/.factory/settings.json`
  // with a populated apiKey is sufficient to bypass FACTORY_API_KEY.
  try {
    const settingsPath = path.join(os.homedir(), '.factory', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const models = Array.isArray(parsed.customModels) ? parsed.customModels : [];
      // Match by either the input being a fully-qualified custom id
      // (`custom:...`), or by the underlying `model` name.
      const targeted = models.find((entry) => entry && (
        entry.id === BYOK_MODEL_INPUT
        || entry.model === BYOK_MODEL_INPUT
        || entry.displayName === BYOK_MODEL_INPUT
      ));
      if (targeted && typeof targeted.apiKey === 'string' && targeted.apiKey.length > 0
          && !targeted.apiKey.startsWith('PASTE_')) {
        // The CLI's `--model` flag expects the `id` field (with the
        // `custom:` prefix) for BYOK entries. Resolve here once.
        RESOLVED_MODEL_FLAG = typeof targeted.id === 'string' && targeted.id.length > 0
          ? targeted.id
          : BYOK_MODEL_INPUT;
        return {
          ok: true,
          source: `BYOK customModel "${targeted.displayName || targeted.model}" in ${settingsPath}`,
          resolvedFlag: RESOLVED_MODEL_FLAG,
          underlyingModel: targeted.model,
        };
      }
      if (targeted && typeof targeted.apiKey === 'string' && targeted.apiKey.startsWith('PASTE_')) {
        return { ok: false, source: `BYOK entry for "${BYOK_MODEL_INPUT}" still has placeholder apiKey` };
      }
    }
  } catch (error) {
    // fall through to FACTORY_API_KEY check
  }
  if (process.env.FACTORY_API_KEY && process.env.FACTORY_API_KEY.length > 0) {
    return { ok: true, source: 'FACTORY_API_KEY env var (Factory subscription)', resolvedFlag: BYOK_MODEL_INPUT };
  }
  return { ok: false, source: 'no BYOK customModel and no FACTORY_API_KEY' };
}

// --------------------------------------------------------------------------
// Step 1 - detection
// --------------------------------------------------------------------------
function step1Detection() {
  section('Step 1 - droid binary detection');
  const detectedPath = which('droid');
  if (!detectedPath) {
    log('FAIL: `droid` not on PATH.');
    log('Install one of:');
    log('  npm i -g droid');
    log('  curl -fsSL https://app.factory.ai/cli | sh         (macOS/Linux)');
    log('  irm https://app.factory.ai/cli/windows | iex       (Windows)');
    VERDICT.detected = false;
    exit(10, 'droid not installed');
  }
  log(`PASS: droid resolves to: ${detectedPath}`);
  VERDICT.detected = true;
  VERDICT.detectedPath = detectedPath;

  const versionResult = runOnce('droid', ['--version']);
  log('');
  log(`> droid --version  (exit=${versionResult.status})`);
  if (versionResult.stdout) blockquote('stdout: ' + versionResult.stdout.trim());
  if (versionResult.stderr) blockquote('stderr: ' + versionResult.stderr.trim());
  const versionLine = (versionResult.stdout || versionResult.stderr).trim().split(/\r?\n/)[0] || '';
  VERDICT.version = versionLine || null;
}

// --------------------------------------------------------------------------
// Step 2 - help text
// --------------------------------------------------------------------------
function step2HelpText() {
  section('Step 2 - help-text introspection');

  const topHelp = runOnce('droid', ['--help'], { timeoutMs: 15_000 });
  log(`> droid --help  (exit=${topHelp.status})`);
  blockquote(topHelp.stdout || topHelp.stderr || '(no output)');
  const topText = (topHelp.stdout + topHelp.stderr).toLowerCase();
  const sessionFlagAtTop = /-s\b|--session-id\b/.test(topText);
  const cwdFlagAtTop = /--cwd\b/.test(topText);
  log('');
  log(`top-level documents -s/--session-id : ${sessionFlagAtTop ? 'YES' : 'no'}`);
  log(`top-level documents --cwd           : ${cwdFlagAtTop ? 'YES' : 'no'}`);
  VERDICT.topLevelSessionFlag = sessionFlagAtTop;
  VERDICT.topLevelCwdFlag = cwdFlagAtTop;

  const execHelp = runOnce('droid', ['exec', '--help'], { timeoutMs: 15_000 });
  log('');
  log(`> droid exec --help  (exit=${execHelp.status})`);
  blockquote(execHelp.stdout || execHelp.stderr || '(no output)');
}

// --------------------------------------------------------------------------
// Step 3 - headless new session
// --------------------------------------------------------------------------
function step3HeadlessNew() {
  section('Step 3 - headless new session via `droid exec`');

  const auth = checkAuthAvailable();
  log(`auth source:    ${auth.source}`);
  if (auth.resolvedFlag) {
    log(`--model flag:   ${auth.resolvedFlag}`);
  }
  if (auth.underlyingModel) {
    log(`underlying:     ${auth.underlyingModel}`);
  }
  if (!auth.ok) {
    log('');
    log('FACTORY_API_KEY is not set in this shell. Get a key at:');
    log('  https://app.factory.ai/settings/api-keys');
    log('Then re-run with the key exported, e.g.:');
    log('  PowerShell:  $env:FACTORY_API_KEY="fk-..." ; node scripts/probe-droid.js');
    log('  bash/zsh:    FACTORY_API_KEY=fk-... node scripts/probe-droid.js');
    VERDICT.headlessNewSessionId = false;
    exit(20, 'set FACTORY_API_KEY and re-run');
  }

  const cwd = path.join(TMP_ROOT, 'project-a');
  fs.mkdirSync(cwd, { recursive: true });

  const argv = [
    'exec',
    '--auto', 'low',
    '--model', RESOLVED_MODEL_FLAG,
    '--output-format', 'json',
    '--cwd', cwd,
    'Reply with the single word PROBE-ALPHA and nothing else.',
  ];
  log('');
  log(`> droid ${argv.join(' ')}`);
  const result = runOnce('droid', argv, { timeoutMs: 90_000 });
  log(`(exit=${result.status})`);
  if (result.stderr) blockquote('stderr: ' + result.stderr.trim());
  blockquote('stdout: ' + (result.stdout.trim() || '(empty)'));

  if (result.status !== 0) {
    if (/unauthor|unauthent|api[_ ]?key|sign[ -]?in|login|invalid[_ ]?api/i.test(result.stdout + result.stderr)) {
      VERDICT.headlessNewSessionId = false;
      exit(20, 'auth missing/failed; verify the BYOK apiKey value in ~/.factory/settings.json');
    }
    VERDICT.headlessNewSessionId = false;
    exit(30, `droid exec returned ${result.status}; aborting`);
  }

  const json = safeJson(result.stdout);
  if (!json) {
    VERDICT.headlessNewSessionId = false;
    exit(30, 'droid exec did not emit parseable JSON in --output-format json mode');
  }
  log('');
  log('parsed JSON keys: ' + Object.keys(json).join(', '));
  log(`session_id: ${json.session_id}`);
  log(`is_error:   ${json.is_error}`);
  log(`result:     ${typeof json.result === 'string' ? json.result.slice(0, 200) : '(non-string)'}`);

  if (!json.session_id || json.is_error) {
    VERDICT.headlessNewSessionId = false;
    exit(30, 'session_id missing or is_error true');
  }
  VERDICT.headlessNewSessionId = json.session_id;
  return { sessionId: json.session_id, cwd, firstResult: json.result };
}

// --------------------------------------------------------------------------
// Step 4 - headless resume
// --------------------------------------------------------------------------
function step4HeadlessResume(prior) {
  section('Step 4 - headless resume via `droid exec -s <id>`');

  const argv = [
    'exec',
    '--auto', 'low',
    '--model', RESOLVED_MODEL_FLAG,
    '--output-format', 'json',
    '--cwd', prior.cwd,
    '-s', prior.sessionId,
    'What single token did you reply with on the previous turn? Reply with only that token.',
  ];
  log(`> droid ${argv.join(' ')}`);
  const result = runOnce('droid', argv, { timeoutMs: 90_000 });
  log(`(exit=${result.status})`);
  if (result.stderr) blockquote('stderr: ' + result.stderr.trim());
  blockquote('stdout: ' + (result.stdout.trim() || '(empty)'));

  if (result.status !== 0) {
    VERDICT.headlessResumeWorked = false;
    exit(40, `droid exec -s returned ${result.status}`);
  }
  const json = safeJson(result.stdout);
  if (!json) {
    VERDICT.headlessResumeWorked = false;
    exit(40, 'resume call did not emit parseable JSON');
  }
  log('');
  log(`session_id: ${json.session_id}`);
  log(`session_id matches prior: ${json.session_id === prior.sessionId ? 'YES' : 'NO (Droid issued a new id)'}`);
  log(`result:     ${typeof json.result === 'string' ? json.result.slice(0, 200) : '(non-string)'}`);

  const recall = typeof json.result === 'string' && /probe[- ]?alpha/i.test(json.result);
  log(`recalled prior reply: ${recall ? 'YES' : 'no'}`);
  VERDICT.headlessResumeWorked = recall ? 'recalled' : 'session-loaded-no-recall';
  if (!json.session_id) {
    exit(40, 'resume call did not return a session_id');
  }
}

// --------------------------------------------------------------------------
// Steps 5+6+7 - PTY interactive new + hooks via `--settings <path>` + resume
// --------------------------------------------------------------------------
function writeRecorderScript() {
  const recorder = `#!/usr/bin/env node
const fs = require('fs');
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { buf += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(HOOK_LOG)},
    JSON.stringify({ event: process.argv[2], stdin: buf, ts: Date.now() }) + '\\n');
});
`;
  fs.writeFileSync(RECORD_HOOK_SCRIPT, recorder);
}

function buildHookSettings() {
  const recorderForwardSlashed = RECORD_HOOK_SCRIPT.replace(/\\/g, '/');
  const cmd = (eventName) => `node "${recorderForwardSlashed}" ${eventName}`;
  // Claude-shape settings. The `--settings <path>` flag merges this into
  // the user's ~/.factory/settings.json for the lifetime of the process,
  // so the BYOK customModels stay active alongside our injected hooks.
  // CRITICAL: also pin the `model` field to the resolved BYOK id, otherwise
  // interactive `droid` falls back to its Factory-subscription default
  // (e.g. claude-opus-4-7) and may hit credit limits even though BYOK is
  // configured. The customModels map lives in the user-level settings, but
  // the active model selector defaults to subscription unless overridden.
  return {
    model: RESOLVED_MODEL_FLAG,
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: cmd('SessionStart'), timeout: 10 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('UserPromptSubmit'), timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('Stop'), timeout: 10 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('PreToolUse'), timeout: 10 }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('PostToolUse'), timeout: 10 }] }],
    },
  };
}

function readHookRecords() {
  if (!fs.existsSync(HOOK_LOG)) return [];
  return fs.readFileSync(HOOK_LOG, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function extractSessionIdFromHooks(records) {
  for (const record of records) {
    if (record.event !== 'SessionStart') continue;
    try {
      const ctx = JSON.parse(record.stdin);
      const id = ctx.session_id ?? ctx.sessionId ?? null;
      if (id) return { id, fieldName: ctx.session_id ? 'session_id' : 'sessionId' };
    } catch { /* skip */ }
  }
  return null;
}

async function step5And6PtyNew() {
  section('Steps 5 + 6 - interactive new session via PTY with `--settings <path>` hook injection');

  let pty;
  try {
    pty = require('node-pty');
  } catch (error) {
    log('FAIL to load node-pty:');
    log('  ' + error.message);
    log('  Run `npm install` from this worktree, then retry.');
    return null;
  }

  writeRecorderScript();
  const settingsPath = path.join(TMP_ROOT, 'merged-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(buildHookSettings(), null, 2));
  log(`hook settings file: ${settingsPath}`);

  const cwd = path.join(TMP_ROOT, 'project-c');
  fs.mkdirSync(cwd, { recursive: true });

  // Use a positional prompt so the TUI takes input without us needing to
  // type into the alternate-screen buffer (which is fragile in a probe).
  const argv = ['--cwd', cwd, '--settings', settingsPath, 'Reply with PROBE-INTERACTIVE and nothing else.'];
  log(`spawning: droid ${argv.join(' ')}`);

  const newProc = pty.spawn(
    VERDICT.detectedPath || (process.platform === 'win32' ? 'droid.cmd' : 'droid'),
    argv,
    { name: 'xterm-color', cols: 120, rows: 30, cwd, env: process.env },
  );
  let newBuffer = '';
  newProc.onData((data) => { newBuffer += data; });

  // Give the TUI plenty of time to render, fire SessionStart, send the
  // initial prompt, get a reply, and fire Stop.
  await new Promise((resolve) => setTimeout(resolve, 25_000));

  const cursorHide = newBuffer.includes('\x1b[?25l');
  log(`captured ${newBuffer.length} bytes; cursor-hide (\\x1b[?25l): ${cursorHide ? 'YES' : 'no'}`);
  log('first 400 bytes of TUI output:');
  blockquote(JSON.stringify(newBuffer.slice(0, 400)));
  VERDICT.ptyNewFirstOutput = cursorHide;

  // Quit the TUI cleanly. Some Droid versions accept /quit; otherwise Ctrl+C.
  try { newProc.write('/quit\r'); } catch { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  try { newProc.write('\x03'); } catch { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  try { newProc.kill(); } catch { /* may already be dead */ }

  // Inspect hook delivery now that the session has had a chance to run.
  const records = readHookRecords();
  log(`hook records captured: ${records.length}`);
  const byEvent = {};
  for (const record of records) {
    byEvent[record.event] = (byEvent[record.event] || 0) + 1;
  }
  for (const event of Object.keys(byEvent).sort()) {
    log(`  ${event.padEnd(20)} ${byEvent[event]}`);
  }
  VERDICT.hookFired = records.length > 0;

  const idInfo = extractSessionIdFromHooks(records);
  if (idInfo) {
    VERDICT.hookSessionIdField = idInfo.fieldName;
    log(`SessionStart payload field: "${idInfo.fieldName}" -> ${idInfo.id}`);
    return { sessionId: idInfo.id, settingsPath, cwd };
  }
  log('No SessionStart hook record contained a session_id field.');
  return null;
}

async function step7PtyResume(prior) {
  section('Step 7 - interactive resume via PTY (`droid --resume <uuid>`)');

  let pty;
  try {
    pty = require('node-pty');
  } catch {
    log('SKIP: node-pty unavailable.');
    return;
  }

  if (!prior) {
    // Fall back to the headless session_id captured in Step 3.
    const fallback = VERDICT.headlessNewSessionId;
    if (typeof fallback !== 'string' || !fallback) {
      log('SKIP: no session_id captured from earlier steps.');
      VERDICT.ptyResumeAccepted = null;
      return;
    }
    prior = { sessionId: fallback, settingsPath: path.join(TMP_ROOT, 'merged-settings.json'), cwd: path.join(TMP_ROOT, 'project-c') };
    log(`(falling back to headless session id ${fallback})`);
  }

  // Reset hook log so we can detect new SessionStart fire from the resume.
  try { fs.unlinkSync(HOOK_LOG); } catch { /* ignore */ }

  const argv = ['--cwd', prior.cwd, '--settings', prior.settingsPath, '--resume', prior.sessionId];
  log(`spawning: droid ${argv.join(' ')}`);

  const resumeProc = pty.spawn(
    VERDICT.detectedPath || (process.platform === 'win32' ? 'droid.cmd' : 'droid'),
    argv,
    { name: 'xterm-color', cols: 120, rows: 30, cwd: prior.cwd, env: process.env },
  );
  let buffer = '';
  let exited = false;
  let exitCode = null;
  resumeProc.onData((data) => { buffer += data; });
  resumeProc.onExit(({ exitCode: code }) => { exited = true; exitCode = code; });

  await new Promise((resolve) => setTimeout(resolve, 12_000));

  const lower = buffer.toLowerCase();
  const sawCursorHide = buffer.includes('\x1b[?25l');
  const errorPattern = /(unknown (option|flag|argument)|invalid (option|flag|argument)|usage:|^error:|not found|unrecognized|session.*not.*found)/m;
  const hadError = errorPattern.test(lower);
  const earlyExit = exited && exitCode !== 0;

  log(`captured ${buffer.length} bytes; exited=${exited} exitCode=${exitCode}`);
  log(`cursor-hide marker (TUI started): ${sawCursorHide ? 'YES' : 'no'}`);
  log(`error/usage pattern matched:      ${hadError ? 'YES' : 'no'}`);
  log('first 600 bytes of TUI output:');
  blockquote(JSON.stringify(buffer.slice(0, 600)));

  // Check resume-time SessionStart hook for the same session_id.
  const records = readHookRecords();
  const idInfo = extractSessionIdFromHooks(records);
  if (idInfo) {
    log(`resume SessionStart hook session_id: ${idInfo.id}`);
    log(`matches prior session id (${prior.sessionId}): ${idInfo.id === prior.sessionId ? 'YES' : 'no'}`);
  } else {
    log('(no SessionStart hook fired during resume)');
  }

  try { resumeProc.write('/quit\r'); } catch { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  try { resumeProc.write('\x03'); } catch { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  try { resumeProc.kill(); } catch { /* ignore */ }

  VERDICT.ptyResumeAccepted = sawCursorHide && !hadError && !earlyExit;
}

// --------------------------------------------------------------------------
// Step 8 - PTY interactive new + hooks via project-level
// `<cwd>/.factory/settings.json` (NO `--settings` flag)
// --------------------------------------------------------------------------
async function step8ProjectLevelHooks() {
  section('Step 8 - project-level <cwd>/.factory/settings.json hook injection (NO --settings flag)');

  let pty;
  try {
    pty = require('node-pty');
  } catch (error) {
    log('FAIL to load node-pty:');
    log('  ' + error.message);
    log('  Run `npm install` from this worktree, then retry.');
    return;
  }

  // Reset hook log so step 5/7 records do not leak into step 8 counts.
  try { fs.unlinkSync(HOOK_LOG); } catch { /* ignore */ }
  writeRecorderScript();

  const cwd = path.join(TMP_ROOT, 'project-d-factory-hooks');
  const factoryDir = path.join(cwd, '.factory');
  fs.mkdirSync(factoryDir, { recursive: true });
  const settingsPath = path.join(factoryDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(buildHookSettings(), null, 2));
  log(`hook settings file: ${settingsPath}`);
  log('(intentionally NOT passing `--settings` - relying on project-level discovery)');

  // Mirror step 5's argv exactly, MINUS the `--settings` flag, so the only
  // variable between the two probes is the hook injection vehicle.
  const argv = ['--cwd', cwd, 'Reply with PROBE-PROJECT-HOOKS and nothing else.'];
  log(`spawning: droid ${argv.join(' ')}`);

  const projectHooksProc = pty.spawn(
    VERDICT.detectedPath || (process.platform === 'win32' ? 'droid.cmd' : 'droid'),
    argv,
    { name: 'xterm-color', cols: 120, rows: 30, cwd, env: process.env },
  );
  let buffer = '';
  projectHooksProc.onData((data) => { buffer += data; });

  // Same 25s window as step 5 - enough for SessionStart, the prompt round-trip,
  // and Stop to fire if hooks are honored.
  await new Promise((resolve) => setTimeout(resolve, 25_000));

  const cursorHide = buffer.includes('\x1b[?25l');
  log(`captured ${buffer.length} bytes; cursor-hide (\\x1b[?25l): ${cursorHide ? 'YES' : 'no'}`);
  log('first 400 bytes of TUI output:');
  blockquote(JSON.stringify(buffer.slice(0, 400)));

  try { projectHooksProc.write('/quit\r'); } catch { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  try { projectHooksProc.write('\x03'); } catch { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  try { projectHooksProc.kill(); } catch { /* may already be dead */ }

  const records = readHookRecords();
  log(`hook records captured: ${records.length}`);
  const byEvent = {};
  for (const record of records) {
    byEvent[record.event] = (byEvent[record.event] || 0) + 1;
  }
  for (const event of Object.keys(byEvent).sort()) {
    log(`  ${event.padEnd(20)} ${byEvent[event]}`);
  }

  VERDICT.projectLevelHooksFire = records.length > 0;
  VERDICT.projectLevelHookEventCounts = byEvent;

  if (records.length > 0) {
    const idInfo = extractSessionIdFromHooks(records);
    if (idInfo) {
      VERDICT.projectLevelHookSessionIdField = idInfo.fieldName;
      log(`SessionStart payload field: "${idInfo.fieldName}" -> ${idInfo.id}`);
    }
    log('PROJECT-LEVEL HOOKS FIRE: adapter wiring is viable.');
    log('  Next step (separate decision): add src/main/agent/adapters/droid/hook-manager.ts');
    log('  using the Codex/Gemini refcounted pattern (Map<projectRoot, Set<taskId>>).');
  } else {
    log('PROJECT-LEVEL HOOKS DID NOT FIRE: zero records captured.');
    log('  Both injection vehicles (--settings and <cwd>/.factory/settings.json) fail on this Droid build.');
    log('  Activity tab cannot be populated for Droid via the existing hook pipeline.');
  }
}

async function step6And7Pty() {
  if (SKIP_PTY) {
    section('Steps 5+6+7+8 - skipped (--skip-pty)');
    return;
  }
  const result = await step5And6PtyNew();
  await step7PtyResume(result);
  await step8ProjectLevelHooks();
}

// --------------------------------------------------------------------------
// Final verdict
// --------------------------------------------------------------------------
function finalVerdict() {
  section('Final verdict');
  if (VERDICT.ptyResumeAccepted === true) {
    VERDICT.resumeStrategy = 'symmetric';
    log('SYMMETRIC resume CONFIRMED: interactive `droid --resume <uuid>` starts the TUI.');
    log('Adapter wiring:');
    log('  new:    droid --cwd <cwd> [--settings <merged>] "<prompt>"');
    log('  resume: droid --cwd <cwd> [--settings <merged>] --resume <uuid> "<prompt>"');
    exit(0);
  }
  if (VERDICT.ptyResumeAccepted === false) {
    VERDICT.resumeStrategy = 'asymmetric';
    log('ASYMMETRIC resume REQUIRED: interactive `droid --resume <uuid>` did not start the TUI.');
    log('Adapter wiring:');
    log('  new:    droid --cwd <cwd> [--settings <merged>] "<prompt>"');
    log('  resume: droid exec --cwd <cwd> --auto <level> -s <uuid> "<prompt>"');
    exit(70, 'asymmetric path required');
  }
  if (VERDICT.headlessResumeWorked) {
    VERDICT.resumeStrategy = 'asymmetric (PTY untested)';
    log('PARTIAL: headless resume works; interactive resume was skipped or unavailable.');
    log('Recommend asymmetric wiring until interactive `-s` is empirically verified.');
    exit(0);
  }
  log('UNDETERMINED: insufficient evidence. Re-run after fixing the missing prerequisites.');
  exit(99, 'undetermined');
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  log('Factory Droid CLI empirical probe');
  log(`platform:   ${process.platform} (${os.release()})`);
  log(`tmp dir:    ${TMP_ROOT}`);
  log(`BYOK input: ${BYOK_MODEL_INPUT}  (override with --model <id>)`);

  step1Detection();
  step2HelpText();
  const prior = step3HeadlessNew();
  step4HeadlessResume(prior);
  await step6And7Pty();
  finalVerdict();
}

main().catch((error) => {
  log('UNEXPECTED ERROR:');
  log('  ' + (error.stack || error.message));
  exit(99, 'uncaught exception');
});
