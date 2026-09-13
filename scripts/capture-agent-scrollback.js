#!/usr/bin/env node
/**
 * Capture a real agent session for the sample install (tests/captures/fixtures/demo/).
 *
 * Spawns an agent CLI in a real PTY inside a scratch repo, with the task prompt in argv (the way
 * Kangentic launches every adapter), records the raw bytes until the output goes quiet, ends the
 * session with the adapter's own exit sequence and the same 1500 ms grace SessionManager gives a
 * young agent (a bare kill leaves Claude's boot canary behind; see .claude/rules/pty-teardown-grace.md),
 * then replays the recording through the headless xterm parser and serializes the terminal state
 * to a plain normal-buffer stream. The web build replays THAT: a full-screen TUI only reproduces
 * at the geometry it was recorded at, while the serialized state renders at any size.
 *
 * Two views of the bytes are written: the serialized terminal state (a still frame, the marketing
 * captures) and the same bytes as a timed stream in 100 ms windows (the live frame replays the
 * session as it happened). Both are sanitized first (the home directory becomes C:\Users\dev,
 * the scratch clone becomes the project's home, the user and host names go, each also when a
 * row wrap or an escape sequence interrupts the literal), and the write is refused if a
 * personal marker survives. The working-tree diff and the last displayed lines ride along.
 *
 * Usage:
 *   node scripts/capture-agent-scrollback.js --agent codex --cwd <repo> --project online-boutique \
 *     --prompt "Set a TTL on cart keys" --out tests/captures/fixtures/demo/online-boutique-codex-redis-ttl.json
 * Options: --cols 120 --rows 40 --timeout 240 --idle 25 --min 40 --mode <permission mode> --no-trust
 *          --stop-after <seconds>   end the recording mid-turn (a session the app shows as working)
 *          --stop-when <regex>      end it on the first output matching (the test command starting)
 *          --live-tail <ms>         also keep the frame this long before the end: the moment the live
 *                                   frame opens a working session at, which a still paints for it
 *          --prompt ""              a Command Terminal: the agent started with no prompt
 *
 * Trust is pre-seeded for claude, codex, gemini, qwen, and copilot using the files each CLI reads,
 * so the first frame is the task and not a trust dialog. Every CLI must already be logged in.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv) {
  const options = { cols: 120, rows: 40, timeout: 240, idle: 25, min: 40, mode: null, trust: true, stopAfter: null, stopWhen: null, liveTail: 0, prompt: '' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => argv[++index];
    switch (argument) {
      case '--agent': options.agent = next(); break;
      case '--cwd': options.cwd = path.resolve(next()); break;
      case '--project': options.project = next(); break;
      case '--prompt': options.prompt = next(); break;
      case '--out': options.out = path.resolve(next()); break;
      case '--cols': options.cols = Number(next()); break;
      case '--rows': options.rows = Number(next()); break;
      case '--timeout': options.timeout = Number(next()); break;
      case '--idle': options.idle = Number(next()); break;
      case '--min': options.min = Number(next()); break;
      case '--mode': options.mode = next(); break;
      case '--stop-after': options.stopAfter = Number(next()); break;
      case '--stop-when': options.stopWhen = new RegExp(next(), 'i'); break;
      case '--live-tail': options.liveTail = Number(next()); break;
      case '--no-trust': options.trust = false; break;
      default: throw new Error(`Unknown argument ${argument}`);
    }
  }
  // --prompt may be empty: a Command Terminal boot is the agent started with no prompt at all.
  for (const required of ['agent', 'cwd', 'project', 'out']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

function forwardSlash(value) {
  return value.replace(/\\/g, '/');
}

/**
 * The interactive launch shape of each adapter, minus the session and MCP extras. An empty prompt
 * is the Command Terminal shape: the agent started interactively with nothing to do yet.
 */
function buildCommand(agent, cwd, prompt, mode) {
  const withPrompt = (args, positional) => (prompt ? [...args, ...positional] : args);
  switch (agent) {
    case 'claude':
      return { exe: 'claude', args: withPrompt(['--permission-mode', mode || 'acceptEdits'], ['--', prompt]), exit: ['\x03', '/exit\r'] };
    case 'codex':
      // The adapter's acceptEdits and bypass mappings (src/main/agent/adapters/codex/command-builder.ts).
      // Codex's Windows sandbox needs a helper this machine does not have, and a session in which every
      // file read fails is not a session worth showing, so the manifest runs Codex in bypass mode.
      // The one override is the startup update check: started with no prompt, an outdated Codex
      // parks on its "Update available" modal for the whole recording, and a notice about the
      // recording machine's install is not part of the session being shown.
      return {
        exe: 'codex',
        args: withPrompt(
          mode === 'bypass'
            ? ['-c', 'check_for_update_on_startup=false', '-C', cwd, '--dangerously-bypass-approvals-and-sandbox']
            : ['-c', 'check_for_update_on_startup=false', '-C', cwd, '--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
          [prompt],
        ),
        exit: ['\x03'],
      };
    case 'gemini':
      return { exe: 'gemini', args: withPrompt(['--approval-mode', mode || 'auto_edit'], [prompt]), exit: ['\x03', '/quit\r'] };
    case 'qwen':
      return { exe: 'qwen', args: withPrompt(['--approval-mode', mode || 'auto-edit'], ['-i', prompt]), exit: ['\x03', '/quit\r'] };
    case 'opencode':
      return { exe: 'opencode', args: withPrompt(['--agent', mode || 'build'], ['--prompt', prompt]), exit: ['\x03'] };
    case 'kimi':
      return { exe: 'kimi', args: withPrompt(['-w', cwd], ['--prompt', prompt]), exit: ['\x03', '/exit\r'] };
    case 'droid':
      return { exe: 'droid', args: withPrompt(['--cwd', cwd], [prompt]), exit: ['\x03', '/quit\r'] };
    case 'copilot':
      return { exe: 'copilot', args: withPrompt(['--allow-all-tools'], ['-i', prompt]), exit: ['\x03', '/exit\r'] };
    case 'cursor':
      return { exe: 'cursor-agent', args: withPrompt([], [prompt]), exit: ['\x03'] };
    default:
      throw new Error(`No launch shape for agent "${agent}"`);
  }
}

/**
 * node-pty needs a real path on Windows, and several CLIs install as .ps1 or .cmd shims that
 * ConPTY cannot start directly. Resolve through PATH and wrap a shim in its interpreter.
 */
function toSpawnable(exe, args) {
  const { execFileSync } = require('node:child_process');
  let resolved = exe;
  if (process.platform === 'win32') {
    const lookup = execFileSync('where.exe', [exe], { encoding: 'utf-8' }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lookup.length === 0) throw new Error(`Could not find ${exe} on PATH`);
    // npm installs three shims side by side (an extensionless shell script, .cmd, .ps1). Prefer
    // a native executable, then .cmd, then .ps1; the shell script cannot start as a process.
    const rank = (candidate) => (/\.exe$/i.test(candidate) ? 0 : /\.cmd$/i.test(candidate) ? 1 : /\.ps1$/i.test(candidate) ? 2 : 3);
    resolved = lookup.slice().sort((left, right) => rank(left) - rank(right))[0];
  }
  if (/\.ps1$/i.test(resolved)) {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args] };
  }
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return { file: 'cmd.exe', args: ['/d', '/c', resolved, ...args] };
  }
  return { file: resolved, args };
}

// ---------------------------------------------------------------- trust pre-seeding
function withClaudeJsonLock(work) {
  const lockDir = path.join(os.homedir(), '.claude.json.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) {
        console.error('[capture] ~/.claude.json.lock is held; skipping the trust write (Claude will show one trust prompt)');
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    work();
    return true;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function seedTrust(agent, cwd) {
  const resolved = forwardSlash(path.resolve(cwd));
  if (agent === 'claude') {
    withClaudeJsonLock(() => {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      let data = {};
      try { data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')); } catch { data = {}; }
      if (!data.projects || typeof data.projects !== 'object') data.projects = {};
      if (data.projects[resolved]?.hasTrustDialogAccepted === true) return;
      data.projects[resolved] = { allowedTools: [], enabledMcpjsonServers: [], disabledMcpjsonServers: [], ...(data.projects[resolved] || {}), hasTrustDialogAccepted: true };
      fs.writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2), 'utf-8');
      console.error('[capture] trusted the scratch repo in ~/.claude.json');
    });
  } else if (agent === 'codex') {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    let toml = '';
    try { toml = fs.readFileSync(configPath, 'utf-8'); } catch { toml = ''; }
    const header = `[projects.'${path.resolve(cwd)}']`;
    if (toml.includes(header)) return;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${toml.trimEnd()}\n\n${header}\ntrust_level = "trusted"\n`, 'utf-8');
    console.error('[capture] trusted the scratch repo in ~/.codex/config.toml');
  } else if (agent === 'gemini' || agent === 'qwen') {
    const dir = path.join(os.homedir(), agent === 'gemini' ? '.gemini' : '.qwen');
    const trustedPath = path.join(dir, 'trustedFolders.json');
    let entries = {};
    try { entries = JSON.parse(fs.readFileSync(trustedPath, 'utf-8')); } catch { entries = {}; }
    if (entries[resolved]) return;
    entries[resolved] = 'TRUST_FOLDER';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(trustedPath, JSON.stringify(entries, null, 2), 'utf-8');
    console.error(`[capture] trusted the scratch repo in ${trustedPath}`);
  } else if (agent === 'copilot') {
    // Copilot CLI keeps its trusted folders in the managed config, as native paths.
    const configPath = path.join(os.homedir(), '.copilot', 'config.json');
    let data = {};
    try { data = JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^\s*\/\/.*$/gm, '')); } catch { data = {}; }
    if (!Array.isArray(data.trustedFolders)) data.trustedFolders = [];
    const native = path.resolve(cwd);
    if (data.trustedFolders.includes(native)) return;
    data.trustedFolders.push(native);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
    console.error('[capture] trusted the scratch repo in ~/.copilot/config.json');
  }
}

// ---------------------------------------------------------------- environment
function buildEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
    if (key === 'NO_COLOR') continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  // The classic renderer scrolls like a normal terminal, which is what a replay wants, and it
  // never arms Claude's fullscreen boot canary.
  env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';
  return env;
}

// ---------------------------------------------------------------- sanitization
function buildSanitizer(options) {
  const home = os.homedir();
  const user = os.userInfo().username;
  const host = os.hostname();
  // The sample install is a Windows machine, as the recording machine and the mock's platform
  // are, so every agent's PowerShell tool calls, backslash paths, and .bat scripts stay
  // consistent with the home directory they print. Only the identity changes: the user is
  // "dev", the home is C:\Users\dev, and the scratch clone becomes the project's real home.
  const demoGroup = options.project === 'contoso-web' ? 'work' : 'oss';
  const demoHome = 'C:\\Users\\dev';
  const demoHomeRelative = `${demoGroup}\\${options.project}`;
  const demoPath = `${demoHome}\\${demoHomeRelative}`;
  const demoTemp = `${demoHome}\\AppData\\Local\\Temp`;
  // Agents print the cwd relative to the home directory too ("~\AppData\Local\Temp\...").
  const homeRelative = path.relative(home, options.cwd);
  const tempRelative = path.relative(home, os.tmpdir());
  // Codex escapes backslashes in its log lines ("cwd=C:\\Users\\...") and elides the middle of
  // the directory in its status box ("~\AppData\Local\...\kng-demo\<project>").
  const doubled = (value) => value.replace(/\\/g, '\\\\');
  const scratchParent = path.basename(path.dirname(options.cwd));
  const replacements = [
    [options.cwd, demoPath],
    [doubled(options.cwd), doubled(demoPath)],
    [forwardSlash(options.cwd), forwardSlash(demoPath)],
    [`~\\${homeRelative}`, `~\\${demoHomeRelative}`],
    [`~/${forwardSlash(homeRelative)}`, `~/${forwardSlash(demoHomeRelative)}`],
    [`~\\AppData\\Local\\\u2026\\${scratchParent}\\${path.basename(options.cwd)}`, `~\\${demoHomeRelative}`],
    [`~/AppData/Local/\u2026/${scratchParent}/${path.basename(options.cwd)}`, `~/${forwardSlash(demoHomeRelative)}`],
    [homeRelative, demoHomeRelative],
    [doubled(homeRelative), doubled(demoHomeRelative)],
    [forwardSlash(homeRelative), forwardSlash(demoHomeRelative)],
    // Some CLIs log to the temp directory itself (Cursor's retrieval trace, for one).
    [os.tmpdir(), demoTemp],
    [doubled(os.tmpdir()), doubled(demoTemp)],
    [forwardSlash(os.tmpdir()), forwardSlash(demoTemp)],
    [`~\\${tempRelative}`, `~\\AppData\\Local\\Temp`],
    [`~/${forwardSlash(tempRelative)}`, '~/AppData/Local/Temp'],
    [home, demoHome],
    [doubled(home), doubled(demoHome)],
    [forwardSlash(home), forwardSlash(demoHome)],
    [`C:\\Users\\${user}`, demoHome],
    [`C:\\\\Users\\\\${user}`, doubled(demoHome)],
    [`C:/Users/${user}`, forwardSlash(demoHome)],
    [`/Users/${user}`, '/Users/dev'],
    [`/home/${user}`, '/home/dev'],
    [host, 'DEV-PC'],
    [user, 'dev'],
  ];
  // A terminal wraps a long path across rows, so the literal can be interrupted by escape
  // sequences, row breaks, and padding. Match each literal with those allowed between its
  // characters, and collapse the whole match to the replacement.
  const GAP = '(?:\\x1b\\[[0-9;?]*[A-Za-z]|\\s)*';
  const tolerant = (literal) => new RegExp(
    literal.split('').map((character) => character.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join(GAP),
    'g',
  );
  // A tolerant pattern can only match where the text, with escape sequences and whitespace
  // removed, contains the literal collapsed the same way. That check is one pass per window;
  // the pattern itself rescans the run of padding after every occurrence of its first
  // character, which on a full-screen repaint is thousands of cells per occurrence, and a long
  // Codex session (a 1.2 MB stream of them) stalled in here for longer than the matrix
  // watchdog allows. So each pattern runs only on a window that can contain its literal.
  const collapse = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\s/g, '');
  const patterns = replacements
    .filter(([from, to]) => from && from.length > 2 && from !== to)
    .map(([from, to]) => [tolerant(from), to, collapse(from)]);
  // What may not survive: any home directory that is not dev's, the scratch root, and the
  // recording machine's own user and host names. Checked on the text with escape sequences
  // removed, so a wrapped path is one string again.
  const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const leaks = [
    ['a home directory other than dev', /C:[\\/]{1,2}Users[\\/]{1,2}(?!dev\b)[A-Za-z0-9._-]+/i],
    ['a home directory other than dev', /\/(?:Users|home)\/(?!dev\b)[A-Za-z0-9._-]+/],
    ['the capture scratch root', /kng-demo/],
    [`the user name "${user}"`, new RegExp(`\\b${escape(user)}\\b`, 'i')],
    [`the host name "${host}"`, new RegExp(`\\b${escape(host)}\\b`, 'i')],
  ];
  return {
    apply(text) {
      let output = text;
      let collapsed = collapse(text);
      for (const [pattern, to, needle] of patterns) {
        if (!collapsed.includes(needle)) continue;
        const before = output;
        output = output.replace(pattern, () => to);
        if (output !== before) collapsed = collapse(output);
      }
      return output;
    },
    assertClean(text, label) {
      const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      for (const [what, pattern] of leaks) {
        const hit = pattern.exec(plain);
        if (hit) {
          // The surrounding text, so the missing replacement can be named.
          const context = JSON.stringify(plain.slice(Math.max(0, hit.index - 160), hit.index + hit[0].length + 80));
          throw new Error(`[capture] ${label} still contains ${what} after sanitization; refusing to write. Context: ${context}`);
        }
      }
    },
  };
}

// ---------------------------------------------------------------- the working tree
const LANGUAGE_BY_EXTENSION = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', js: 'javascript', mjs: 'javascript', jsx: 'javascript',
  java: 'java', go: 'go', cs: 'csharp', py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html', css: 'css', scss: 'scss',
  md: 'markdown', sql: 'sql', sh: 'shell', ps1: 'powershell', dockerfile: 'dockerfile', properties: 'ini',
};
const MAX_DIFF_FILE_BYTES = 200 * 1024;

/**
 * What the agent changed, in the shape the mock's git.diffFiles returns, so the task's Changes
 * panel shows the real diff next to the real terminal. Untracked files enter the index as
 * intent-to-add so one `git diff HEAD` covers everything; the index is reset afterwards.
 */
function collectChanges(cwd, sanitizer) {
  const { execFileSync } = require('node:child_process');
  const git = (args, allowFailure = false) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      if (allowFailure) return '';
      throw error;
    }
  };
  git(['add', '--intent-to-add', '--all']);
  try {
    const statusByPath = new Map();
    for (const line of git(['diff', '--name-status', 'HEAD']).split('\n').filter(Boolean)) {
      const [status, ...rest] = line.split('\t');
      statusByPath.set(rest[rest.length - 1], status.charAt(0));
    }
    const files = [];
    for (const line of git(['diff', '--numstat', 'HEAD']).split('\n').filter(Boolean)) {
      const [insertionsText, deletionsText, ...rest] = line.split('\t');
      const filePath = rest[rest.length - 1].replace(/^"|"$/g, '');
      if (filePath.startsWith('node_modules/') || filePath.startsWith('.kangentic/')) continue;
      const status = statusByPath.get(filePath) || 'M';
      const binary = insertionsText === '-';
      const absolute = path.join(cwd, filePath);
      const tooLarge = fs.existsSync(absolute) && fs.statSync(absolute).size > MAX_DIFF_FILE_BYTES;
      const original = status === 'A' || binary ? '' : git(['show', `HEAD:${filePath}`], true);
      const modified = status === 'D' || binary || tooLarge ? '' : fs.readFileSync(absolute, 'utf-8');
      const extension = path.basename(filePath).toLowerCase().split('.').pop();
      files.push({
        path: filePath,
        status,
        binary: binary || tooLarge,
        insertions: binary ? 0 : Number(insertionsText),
        deletions: binary ? 0 : Number(deletionsText),
        original: sanitizer.apply(original),
        modified: sanitizer.apply(modified),
        language: LANGUAGE_BY_EXTENSION[extension] || null,
      });
    }
    return {
      files,
      totalInsertions: files.reduce((sum, file) => sum + file.insertions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  } finally {
    git(['reset', '-q'], true);
  }
}

// ---------------------------------------------------------------- serialization
async function serializeThroughXterm(raw, cols, rows) {
  const { Terminal } = require('@xterm/headless');
  const { SerializeAddon } = require('@xterm/addon-serialize');
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  // The Unicode 11 width table, as every xterm in the app runs (src/shared/xterm-unicode11.ts).
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  await new Promise((resolve) => terminal.write(raw, resolve));
  const serialized = serializer.serialize({ scrollback: 5000 });
  const altScreen = terminal.buffer.active.type === 'alternate';
  const peek = peekFromTerminal(terminal);
  terminal.dispose();
  return { serialized, altScreen, peek };
}

// The Monitor peek, and the timeline of how it changes over the recording, are computed by the
// one module the backfill script shares, so a new recording and an old one cannot disagree.
const { peekFromTerminal, computePeekTimeline } = require('./lib/demo-peek-timeline');

// ---------------------------------------------------------------- main
async function main() {
  const options = parseArgs(process.argv.slice(2));
  let pty;
  try {
    pty = require('node-pty');
  } catch (error) {
    console.error('Failed to load node-pty. Try: npm rebuild node-pty');
    throw error;
  }
  const command = buildCommand(options.agent, options.cwd, options.prompt, options.mode);
  if (options.trust) seedTrust(options.agent, options.cwd);
  const sanitizer = buildSanitizer(options);

  console.error(`[capture] ${options.agent} in ${options.cwd} (${options.cols}x${options.rows})`);
  console.error(`[capture] ${command.exe} ${command.args.map((value) => (value.includes(' ') ? JSON.stringify(value) : value)).join(' ')}`);

  const startedAt = Date.now();
  let raw = '';
  // The same bytes with their arrival times, so the web build can replay the session as it
  // happened rather than paint its last frame. Coalesced into 100 ms windows: a window is the
  // unit the sanitizer rewrites, and a path split across two windows is what assertClean on
  // the joined stream exists to catch.
  const stream = [];
  let lastOutputAt = Date.now();
  let exited = false;
  let exitCode = null;
  // The recording ends where the agent's work ends: the exit sequence's own frames (the typed
  // /exit, "press Ctrl-C again", a resume hint) are not part of the session being shown.
  let recording = true;

  const spawnable = toSpawnable(command.exe, command.args);
  console.error(`[capture] spawning ${spawnable.file}`);
  const child = pty.spawn(spawnable.file, spawnable.args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: buildEnv(),
    useConpty: true,
  });

  child.onData((data) => {
    if (!recording) return;
    raw += data;
    const at = Date.now() - startedAt;
    const last = stream[stream.length - 1];
    if (last && at - last.t < 100) last.data += data;
    else stream.push({ t: at, data });
    lastOutputAt = Date.now();
  });
  const exitPromise = new Promise((resolve) => {
    child.onExit(({ exitCode: code }) => {
      exited = true;
      exitCode = code;
      resolve();
    });
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let reason = 'timeout';
  for (;;) {
    await sleep(500);
    const elapsed = Date.now() - startedAt;
    if (exited) { reason = 'exited'; break; }
    if (elapsed > options.timeout * 1000) { reason = 'timeout'; break; }
    // A session shown as working has to END mid-turn: the last frame is the spinner and the tool
    // calls in flight, not a finished answer. The agent still gets its exit sequence afterwards.
    // --stop-when ends it on the first output that matches (the test command starting, say),
    // which lands at the same point of the work however fast the model was that run.
    if (options.stopAfter && elapsed > options.stopAfter * 1000) { reason = 'stop-after'; break; }
    if (options.stopWhen && elapsed > 5000) {
      const tail = raw.slice(-8192).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      if (options.stopWhen.test(tail)) { reason = 'stop-when'; break; }
    }
    if (elapsed > options.min * 1000 && Date.now() - lastOutputAt > options.idle * 1000) { reason = 'idle'; break; }
    if (elapsed % 10000 < 500) console.error(`[capture] ${(elapsed / 1000).toFixed(0)}s, ${raw.length} bytes`);
  }
  console.error(`[capture] stopping after ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${reason}), ${raw.length} bytes`);

  recording = false;
  if (!exited) {
    // The adapter's exit sequence, then the same grace SessionManager.kill() gives a young agent.
    for (const chunk of command.exit) {
      child.write(chunk);
      await sleep(400);
    }
    await Promise.race([exitPromise, sleep(1500)]);
    if (!exited) {
      child.kill();
      await Promise.race([exitPromise, sleep(1500)]);
    }
  }
  // Each stage announces itself: a capture that stalls after the recording ended (seen on long
  // Codex sessions) is then a named stage in the matrix log, not a silent watchdog kill.
  console.error(`[capture] exit sequence done (agent ${exited ? 'exited' : 'still running'})`);

  // Two views of the same bytes ship. The serialized terminal state is what a still frame and
  // the marketing captures paint; the timed stream is what the live frame replays as it
  // happened. Each window of the stream is sanitized on its own, and the joined result is
  // checked as one string, so a path the agent printed across a window boundary cannot slip
  // through half-rewritten.
  const { serialized, altScreen, peek } = await serializeThroughXterm(raw, options.cols, options.rows);
  console.error(`[capture] serialized ${serialized.length} bytes through xterm`);
  const cleanSerialized = sanitizer.apply(serialized);
  sanitizer.assertClean(cleanSerialized, 'serialized');
  const cleanStream = stream.map((window) => ({ t: window.t, data: sanitizer.apply(window.data) }));
  sanitizer.assertClean(cleanStream.map((window) => window.data).join(''), 'stream');
  console.error(`[capture] sanitized the frame and ${cleanStream.length} stream windows`);
  const cleanPeek = peek.map((line) => sanitizer.apply(line));
  for (const line of cleanPeek) sanitizer.assertClean(line, 'peek');
  // The moment the live frame opens a session shown as working: this long before the recording's
  // end, the rest streaming in after the page opens (--live-tail, from the manifest's liveTailMs
  // or the session's own). A still and the marketing captures paint this frame for such a
  // session, so every view starts from the same moment, and the Monitor peek at that moment
  // rides along. A recording shorter than the tail has none: the frame starts it from the top.
  let openFrame = null;
  const lastWindow = stream[stream.length - 1];
  if (options.liveTail > 0 && lastWindow && lastWindow.t > options.liveTail) {
    const openAt = lastWindow.t - options.liveTail;
    const rawUpToOpen = stream.filter((window) => window.t <= openAt).map((window) => window.data).join('');
    const open = await serializeThroughXterm(rawUpToOpen, options.cols, options.rows);
    const cleanOpen = sanitizer.apply(open.serialized);
    sanitizer.assertClean(cleanOpen, 'open frame');
    const cleanOpenPeek = open.peek.map((line) => sanitizer.apply(line));
    for (const line of cleanOpenPeek) sanitizer.assertClean(line, 'open frame peek');
    openFrame = { beforeEndMs: options.liveTail, serialized: cleanOpen, peek: cleanOpenPeek };
    console.error(`[capture] open frame at ${(openAt / 1000).toFixed(1)}s: ${cleanOpen.length} bytes`);
  }
  // How the Monitor card's output peek changes as the agent works, sampled to a cadence a reader
  // can follow. The stream is already sanitized, so the lines read off it are too; they are
  // checked again here because a peek is read from the RENDERED buffer, where cursor positioning
  // can join text the sanitizer only ever saw in separate windows.
  const peekTimeline = await computePeekTimeline({ stream: cleanStream, cols: options.cols, rows: options.rows });
  for (const change of peekTimeline) {
    for (const line of change.lines) sanitizer.assertClean(line, `peek timeline at ${change.t} ms`);
  }
  console.error(`[capture] peek timeline: ${peekTimeline.length} change(s) across ${(lastWindow ? lastWindow.t / 1000 : 0).toFixed(0)}s`);

  const changes = collectChanges(options.cwd, sanitizer);
  for (const file of changes.files) {
    sanitizer.assertClean(file.original, `changes ${file.path} (original)`);
    sanitizer.assertClean(file.modified, `changes ${file.path} (modified)`);
  }
  console.error(`[capture] working tree: ${changes.files.length} file(s) changed, +${changes.totalInsertions} -${changes.totalDeletions}`);

  let agentVersion = null;
  try {
    const { execFileSync } = require('node:child_process');
    const probe = toSpawnable(command.exe, ['--version']);
    agentVersion = execFileSync(probe.file, probe.args, { encoding: 'utf-8', env: buildEnv(), timeout: 20000 }).trim().split('\n')[0];
  } catch { agentVersion = null; }
  console.error(`[capture] agent version: ${agentVersion || 'unknown'}`);

  const record = {
    agent: options.agent,
    agentVersion,
    project: options.project,
    prompt: options.prompt,
    cols: options.cols,
    rows: options.rows,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    stopReason: reason,
    exitCode,
    altScreen,
    rawBytes: raw.length,
    serialized: cleanSerialized,
    peek: cleanPeek,
    openFrame,
    peekTimeline,
    changes,
    stream: cleanStream,
  };
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, JSON.stringify(record, null, 2), 'utf-8');
  console.error(`[capture] wrote ${options.out} (raw ${raw.length} bytes recorded, serialized ${cleanSerialized.length} bytes kept, alt screen: ${altScreen})`);
}

main().then(() => {
  // A force-killed agent can leave the ConPTY handle open, which keeps the event loop alive and
  // stalls the matrix driver behind a process that has nothing left to do.
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
