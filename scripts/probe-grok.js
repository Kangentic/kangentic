#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Empirical probe for the Grok Build CLI (xAI).
 *
 * Validates every claim the Kangentic Grok adapter makes about the binary,
 * with verbatim CLI evidence. Output is both human-readable and
 * machine-parseable (a final verdict block). Re-runnable; safe to abort
 * with Ctrl+C at any step. First validated against grok 1.0.0 (3cd0d0cbce)
 * on Windows.
 *
 * What it checks
 * --------------
 *   1. Detection           - is `grok` on PATH? does the banner parse as
 *                            `grok <version> ...`?
 *   2. Headless new        - `grok -p --output-format json` returns a real
 *                            sessionId, and total_cost_usd_ticks is exactly
 *                            total_cost_usd * 1e10 (the tick unit the
 *                            session-history parser depends on).
 *   3. Session store       - the session lands at
 *                            ~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/
 *                            with updates.jsonl + chat_history.jsonl +
 *                            summary.json (the adapter's deterministic
 *                            locate path).
 *   4. Caller-owned id     - `-s <fresh uuid>` names the session dir with
 *                            OUR uuid; re-using the same uuid errors
 *                            (supportsCallerSessionId semantics).
 *   5. Trust + hooks       - with the probe cwd seeded into
 *                            ~/.grok/trusted_folders.toml (the same entry
 *                            shape trust-manager.ts writes), project hooks
 *                            in <cwd>/.grok/hooks/*.json fire in HEADLESS
 *                            mode, the hook process inherits the spawn env
 *                            (KANGENTIC_EVENTS_PATH), the stdin payload
 *                            carries the camelCase fields the hook-manager
 *                            extracts (toolName, toolUseId, toolInput,
 *                            reason), and the REAL event-bridge.js resolves
 *                            its `env:` sentinel and appends to the
 *                            per-session events.jsonl.
 *   6. Interactive (PTY)   - spawns the TUI via node-pty: first-output is
 *                            the cursor-hide marker, a typed submit lands
 *                            in chat_history.jsonl within the delivery
 *                            budget (flush-on-submit), and `/quit` exits
 *                            cleanly with the conversation dump the
 *                            transcript cleanup anchors on.
 *
 * Auth
 * ----
 * Grok currently serves a free tier without login, so the probe usually
 * needs no auth. If your account/region requires it, run `grok login`
 * first. Each full run spends a few tiny single-turn prompts.
 *
 * Usage
 * -----
 *   node scripts/probe-grok.js
 *   node scripts/probe-grok.js --skip-pty       # only headless probes
 *   node scripts/probe-grok.js --keep-tmp       # leave tmp dir on disk
 *
 * Exit codes
 * ----------
 *   0   = all probes passed
 *   10  = grok not installed / banner did not parse
 *   30  = headless new failed (auth? network?)
 *   35  = cost tick unit drifted from 1e-10 USD
 *   40  = session store not at the expected encoded path
 *   45  = caller-owned -s semantics drifted
 *   50  = hooks did not fire / payload shape drifted / env not inherited
 *   55  = event-bridge env: sentinel did not append
 *   60  = interactive PTY probe failed (first output / flush / quit)
 *   99  = unexpected error
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const args = process.argv.slice(2);
const SKIP_PTY = args.includes('--skip-pty');
const KEEP_TMP = args.includes('--keep-tmp');

const verdicts = [];
function verdict(name, pass, evidence) {
  verdicts.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  (${evidence})` : ''}`);
}

function fail(code, message) {
  console.error(`\nPROBE FAILED: ${message}`);
  printVerdicts();
  process.exit(code);
}

function printVerdicts() {
  console.log('\n=== VERDICTS ===');
  for (const entry of verdicts) {
    console.log(JSON.stringify(entry));
  }
}

function run(command, commandArgs, options = {}) {
  const result = childProcess.spawnSync(command, commandArgs, {
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: false,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
  };
}

function grokHome() {
  return process.env.GROK_HOME && process.env.GROK_HOME.trim().length > 0
    ? process.env.GROK_HOME
    : path.join(os.homedir(), '.grok');
}

/** Locate the grok binary the way the adapter's detector does. */
function findGrok() {
  const candidates = process.platform === 'win32'
    ? [path.join(os.homedir(), '.grok', 'bin', 'grok.exe')]
    : [path.join(os.homedir(), '.grok', 'bin', 'grok'), '/usr/local/bin/grok', '/opt/homebrew/bin/grok'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fall back to PATH resolution via the shell's own lookup.
  const probe = run(process.platform === 'win32' ? 'where.exe' : 'which', ['grok'], { timeoutMs: 5000 });
  const first = probe.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  return first ? first.trim() : null;
}

const TRUST_MARKER = '# kangentic-probe-grok (removed automatically)';

/** Seed a trust entry for `dir` the way trust-manager.ts does; returns an undo fn. */
function seedTrust(dir) {
  const storePath = path.join(grokHome(), 'trusted_folders.toml');
  let existing = '';
  try { existing = fs.readFileSync(storePath, 'utf-8'); } catch { /* fresh */ }
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const table = `${TRUST_MARKER}\n[folders.'${dir}']\ntrusted = true\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.appendFileSync(storePath, `${separator}\n${table}`);
  return () => {
    try {
      const content = fs.readFileSync(storePath, 'utf-8');
      const markerIndex = content.indexOf(TRUST_MARKER);
      if (markerIndex === -1) return;
      // Our block is marker + 3 lines, appended at the tail.
      const lines = content.slice(markerIndex).split('\n');
      const remainder = lines.slice(4).join('\n');
      fs.writeFileSync(storePath, content.slice(0, markerIndex).replace(/\n+$/, '\n') + remainder);
    } catch (error) {
      console.warn('could not undo trust seed:', error.message);
    }
  };
}

async function main() {
  console.log('=== Grok Build CLI probe ===\n');

  // ---- 1. Detection ----
  const grokPath = findGrok();
  if (!grokPath) fail(10, 'grok binary not found (install: https://github.com/xai-org/grok-build)');
  const versionResult = run(grokPath, ['--version'], { timeoutMs: 10_000 });
  const banner = (versionResult.stdout.trim() || versionResult.stderr.trim());
  const versionMatch = banner.match(/^grok\s+(\d[\w.+-]*)/i);
  verdict('detection: banner parses as grok', Boolean(versionMatch), banner);
  if (!versionMatch) fail(10, `unexpected --version banner: ${banner}`);

  // ---- Probe workspace ----
  // A git repo, because grok discovers the project root (where `.grok/hooks`
  // and `.grok/config.toml` load from) by walking up to the first `.git` -
  // and every Kangentic spawn cwd (project root or worktree) is a git root.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-probe-'));
  run('git', ['init', '--quiet'], { cwd: tmpDir, timeoutMs: 15_000 });
  console.log(`probe cwd: ${tmpDir}`);
  const cleanupFns = [];
  const cleanup = () => {
    for (const fn of cleanupFns.reverse()) {
      try { fn(); } catch { /* best effort */ }
    }
    if (!KEEP_TMP) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* locked */ }
    }
    // Session dirs created under the user's real grok home for this tmp cwd.
    if (!KEEP_TMP) {
      try {
        fs.rmSync(path.join(grokHome(), 'sessions', encodeURIComponent(tmpDir)), { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  };

  try {
    // ---- 2. Headless new + cost tick unit ----
    const headless = run(grokPath, ['-p', 'Reply with exactly: OK', '--output-format', 'json'], { cwd: tmpDir });
    let headlessJson = null;
    try { headlessJson = JSON.parse(headless.stdout); } catch { /* handled below */ }
    verdict('headless: -p returns JSON with sessionId', Boolean(headlessJson && headlessJson.sessionId),
      headlessJson ? `sessionId=${headlessJson.sessionId}` : `exit=${headless.status} stderr=${headless.stderr.slice(0, 200)}`);
    if (!headlessJson || !headlessJson.sessionId) fail(30, 'headless run failed - check auth (grok login) and network');

    const ticks = headlessJson.total_cost_usd_ticks;
    const usd = headlessJson.total_cost_usd;
    const ticksMatch = typeof ticks === 'number' && typeof usd === 'number'
      && Math.abs(ticks * 1e-10 - usd) < 1e-9;
    verdict('cost: ticks are 1e-10 USD', ticksMatch, `ticks=${ticks} usd=${usd}`);
    if (!ticksMatch) fail(35, 'total_cost_usd_ticks no longer equals total_cost_usd * 1e10 - update session-history-parser.ts');

    // ---- 3. Session store keying ----
    const sessionDir = path.join(grokHome(), 'sessions', encodeURIComponent(tmpDir), headlessJson.sessionId);
    const storeFiles = ['updates.jsonl', 'chat_history.jsonl', 'summary.json'];
    const missing = storeFiles.filter((name) => !fs.existsSync(path.join(sessionDir, name)));
    verdict('store: encodeURIComponent(cwd)/<id>/ layout', missing.length === 0,
      missing.length === 0 ? sessionDir : `missing ${missing.join(', ')} under ${sessionDir}`);
    if (missing.length > 0) fail(40, 'session store not at the deterministic path session-paths.ts computes');

    // ---- 4. Caller-owned -s semantics ----
    const callerUuid = crypto.randomUUID();
    const named = run(grokPath, ['-p', 'Reply with exactly: OK', '-s', callerUuid, '--output-format', 'json'], { cwd: tmpDir });
    const namedDirExists = fs.existsSync(path.join(grokHome(), 'sessions', encodeURIComponent(tmpDir), callerUuid));
    verdict('sessions: -s names a NEW session with our uuid', namedDirExists, callerUuid);
    const duplicate = run(grokPath, ['-p', 'noop', '-s', callerUuid, '--output-format', 'json'], { cwd: tmpDir, timeoutMs: 30_000 });
    const duplicateRejected = duplicate.status !== 0;
    verdict('sessions: re-using an existing uuid with -s errors', duplicateRejected,
      `exit=${duplicate.status} stderr=${(duplicate.stderr || duplicate.stdout).slice(0, 160).replace(/\s+/g, ' ')}`);
    if (!namedDirExists || !duplicateRejected) fail(45, 'caller-owned session-id semantics drifted - revisit supportsCallerSessionId');

    // ---- 5. Trust + hooks + env inheritance + event-bridge sentinel ----
    const dumpPath = path.join(tmpDir, 'hook-dump.jsonl');
    const dumpScript = path.join(tmpDir, 'hook-dump.js');
    fs.writeFileSync(dumpScript, [
      "const fs = require('fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  let stdin = null;',
      '  try { stdin = JSON.parse(input); } catch { stdin = null; }',
      '  const record = { env: { KANGENTIC_EVENTS_PATH: process.env.KANGENTIC_EVENTS_PATH || null }, stdin };',
      `  fs.appendFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(record) + '\\n');`,
      '});',
    ].join('\n'));

    const eventBridge = path.join(__dirname, '..', 'src', 'main', 'agent', 'event-bridge.js');
    const eventsPath = path.join(tmpDir, 'events.jsonl');
    const toForward = (value) => value.replace(/\\/g, '/');
    const hooksDir = path.join(tmpDir, '.grok', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'kangentic-probe.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: `node "${toForward(dumpScript)}"` }] }],
        Stop: [{ hooks: [
          { type: 'command', command: `node "${toForward(dumpScript)}"` },
          { type: 'command', command: `node "${toForward(eventBridge)}" "env:KANGENTIC_EVENTS_PATH" idle` },
        ] }],
      },
    }, null, 2));

    // Project hooks are trust-gated; seed the same entry trust-manager.ts writes.
    cleanupFns.push(seedTrust(tmpDir));

    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello from the probe.\n');
    const hookRun = run(grokPath, ['-p', 'Use your file reading tool to read hello.txt and reply with its contents.', '--output-format', 'plain'], {
      cwd: tmpDir,
      env: { KANGENTIC_EVENTS_PATH: eventsPath },
    });
    if (hookRun.status !== 0) {
      console.warn(`hook run exited ${hookRun.status}: ${(hookRun.stderr || hookRun.stdout).slice(0, 200)}`);
    }

    let dumpRecords = [];
    try {
      dumpRecords = fs.readFileSync(dumpPath, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch { /* handled below */ }
    const preToolRecord = dumpRecords.find((record) => record.stdin && record.stdin.hookEventName === 'pre_tool_use');
    const stopRecord = dumpRecords.find((record) => record.stdin && record.stdin.hookEventName === 'stop');
    verdict('hooks: project hooks fire under seeded trust (headless included)', dumpRecords.length > 0, `${dumpRecords.length} records`);
    verdict('hooks: payload carries camelCase toolName/toolUseId/toolInput',
      Boolean(preToolRecord && preToolRecord.stdin.toolName && preToolRecord.stdin.toolUseId && preToolRecord.stdin.toolInput),
      preToolRecord ? `toolName=${preToolRecord.stdin.toolName}` : 'no pre_tool_use record');
    verdict('hooks: Stop payload carries reason', Boolean(stopRecord && stopRecord.stdin.reason),
      stopRecord ? `reason=${stopRecord.stdin.reason}` : 'no stop record');
    verdict('hooks: process inherits the spawn env', Boolean(dumpRecords[0] && dumpRecords[0].env.KANGENTIC_EVENTS_PATH === eventsPath));
    if (dumpRecords.length === 0 || !preToolRecord) {
      fail(50, 'hooks did not fire or the payload shape drifted - re-verify hook-manager.ts field names');
    }

    let bridgeLines = [];
    try {
      bridgeLines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch { /* handled below */ }
    const idleLanded = bridgeLines.some((event) => event.type === 'idle');
    verdict('event-bridge: env: sentinel resolves and appends', idleLanded, `${bridgeLines.length} events`);
    if (!idleLanded) fail(55, 'event-bridge env:KANGENTIC_EVENTS_PATH sentinel did not append - check event-bridge.js');

    // ---- 6. Interactive PTY probe ----
    if (!SKIP_PTY) {
      await ptyProbe(grokPath, tmpDir);
    } else {
      console.log('skipping PTY probe (--skip-pty)');
    }

    printVerdicts();
    const allPassed = verdicts.every((entry) => entry.pass);
    console.log(allPassed ? '\nALL PROBES PASSED' : '\nSOME PROBES FAILED');
    process.exit(allPassed ? 0 : 99);
  } finally {
    cleanup();
  }
}

/** Interactive TUI probe: first-output marker, submit flush latency, /quit. */
function ptyProbe(grokPath, baseDir) {
  return new Promise((resolve) => {
    let pty;
    try {
      pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));
    } catch {
      console.warn('node-pty not available (run npm install); skipping PTY probe');
      resolve();
      return;
    }

    const cwd = fs.mkdtempSync(path.join(baseDir, 'pty-'));
    const sessionsRoot = path.join(grokHome(), 'sessions', encodeURIComponent(cwd));
    const MARKER = 'PONG';
    const chunks = [];
    let sentAt = 0;
    let chatFlushMs = null;
    let turnDone = false;
    let exitCode = null;

    const proc = pty.spawn(grokPath, [], {
      name: 'xterm-256color', cols: 110, rows: 32, cwd, env: process.env,
    });
    proc.onData((data) => chunks.push(data));
    proc.onExit(({ exitCode: code }) => { exitCode = code; });

    const poll = setInterval(() => {
      if (!sentAt) return;
      let sessionDirs = [];
      try { sessionDirs = fs.readdirSync(sessionsRoot); } catch { return; }
      for (const dir of sessionDirs) {
        if (chatFlushMs === null) {
          try {
            const content = fs.readFileSync(path.join(sessionsRoot, dir, 'chat_history.jsonl'), 'utf-8');
            for (const line of content.split('\n')) {
              if (!line) continue;
              try {
                const record = JSON.parse(line);
                if (record.type === 'user' && !record.synthetic_reason && JSON.stringify(record.content).includes(MARKER)) {
                  chatFlushMs = Date.now() - sentAt;
                }
              } catch { /* partial line */ }
            }
          } catch { /* not yet */ }
        }
        if (!turnDone) {
          try {
            if (fs.readFileSync(path.join(sessionsRoot, dir, 'updates.jsonl'), 'utf-8').includes('"turn_completed"')) {
              turnDone = true;
            }
          } catch { /* not yet */ }
        }
      }
    }, 25);

    setTimeout(() => {
      proc.write(`Reply with exactly: ${MARKER}`);
      setTimeout(() => { sentAt = Date.now(); proc.write('\r'); }, 500);
    }, 4000);

    const quitCheck = setInterval(() => {
      if (turnDone) {
        clearInterval(quitCheck);
        setTimeout(() => { proc.write('/quit'); setTimeout(() => proc.write('\r'), 400); }, 1500);
        setTimeout(finish, 8000);
      }
    }, 500);
    const hardStop = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } finish(); }, 90_000);

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearInterval(quitCheck);
      clearTimeout(hardStop);
      try { proc.kill(); } catch { /* gone */ }

      const all = chunks.join('');
      verdict('pty: first output hides the cursor (ESC[?25l)', all.includes('[?25l'));
      verdict('pty: typed submit flushes to chat_history within 2s',
        chatFlushMs !== null && chatFlushMs < 2000,
        chatFlushMs === null ? 'never flushed' : `${chatFlushMs}ms`);
      verdict('pty: /quit exits cleanly', exitCode === 0, `exit=${exitCode}`);
      verdict('pty: exit dump carries the conversation + resume hint',
        all.includes('Resume this session with:'),
        undefined);
      if (!KEEP_TMP) {
        try { fs.rmSync(sessionsRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      resolve();
    }
  });
}

main().catch((error) => {
  console.error(error);
  fail(99, error.message);
});
