#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI. WINDOWS (ConPTY) ONLY.
 *
 * Does a typed agent launch survive a slow Windows PowerShell start? A board
 * launch types its whole command into the shell about 100 ms after the spawn
 * (`performSpawn`), long before a heavy profile has finished. This probe tells
 * a LATE line (it runs once the shell gets to it) from a LOST one (it never
 * runs), and times both, which is the evidence behind the agent-absence
 * sweep's start bound (`AGENT_START_CEILING_MS` in lifecycle/agent-output-tracker.ts,
 * docs/architecture/sessions/agent-absence-sweep.md, "A board launch's start
 * bound"). It also feeds every chunk through the real `AgentOutputTracker`, to
 * see whether the typed-line detector notices a line that runs late.
 *
 * Each cell spawns `powershell.exe -NoLogo` through node-pty, as the app does,
 * types a line built by the app's own `buildTypedLaunch` (the Clear-Host
 * prelude, `& ` and PowerShell quoting) at +100 ms, and waits for a stub agent
 * to write a marker file. The stub is node running a script that records the
 * time it started and the prompt it was given, prints one line and stays up.
 * The prompt is real prose from this repo's docs, cut to the cell's byte
 * length, not one repeated letter (shells-and-paths.md says why).
 *
 * The profile is approximated, never edited: `-NoProfile -NoExit -Command
 * "Start-Sleep -Seconds N"` keeps the shell busy for N seconds before its
 * interactive loop and PSReadLine start, as a slow profile does. The `real`
 * cell runs this machine's own profile instead.
 *
 * Usage:
 *   node scripts/probe-powershell-slow-shell-typed-line.js [--cells real,0,20,40] [--bytes 7649]
 *        [--length-cells 1552,7649,15769] [--out <results.json>]
 *
 * A cell is `profile:<seconds|real>@<bytes>`. The defaults run the profile axis
 * at 7649 bytes and the length axis with no profile delay.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

if (process.platform !== 'win32') throw new Error('This probe measures ConPTY and Windows PowerShell, and runs on Windows only.');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const repoRoot = path.resolve(__dirname, '..');
const profileCells = argument('cells', 'real,0,20,40').split(',').filter(Boolean);
const profileAxisBytes = Number(argument('bytes', '7649'));
const lengthCells = argument('length-cells', '1552,7649,15769').split(',').filter(Boolean).map(Number);
const outPath = argument('out', null);

/** How long past the profile a line may take before the cell calls it lost. */
const LOST_AFTER_PROFILE_MS = 60_000;
/** How long to keep reading output after the stub started, for the tracker. */
const AFTER_START_READ_MS = 3_000;
/** The app's delay before it types the line (`performSpawn`, no cwd fixup). */
const TYPE_AFTER_SPAWN_MS = 100;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-slow-shell-probe-'));

// The app's own code, bundled from source: the typed line's builder and the
// typed-line detector run exactly as the app ships them.
const esbuild = require('esbuild');
const helperBundle = esbuild.buildSync({
  stdin: {
    contents: [
      "export { AgentOutputTracker, AGENT_START_CEILING_MS } from './src/main/pty/lifecycle/agent-output-tracker';",
      "export { buildTypedLaunch } from './src/main/pty/spawn/typed-launch';",
      "export { quoteArg } from './src/shared/paths';",
    ].join('\n'),
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  define: { __KANGENTIC_DEV__: 'false' },
  external: ['electron', 'node-pty', 'koffi'],
  logLevel: 'silent',
});
const helperPath = path.join(workDir, 'helpers.cjs');
fs.writeFileSync(helperPath, helperBundle.outputFiles[0].text);
const { AgentOutputTracker, AGENT_START_CEILING_MS, buildTypedLaunch, quoteArg } = require(helperPath);

const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
const pty = require(nodePtyDir);
const { WindowsPtyAgent } = require(path.join(nodePtyDir, 'lib', 'windowsPtyAgent'));
// The app's patch (src/main/pty/spawn/conpty-console-list.ts).
WindowsPtyAgent.prototype._getConsoleProcessList = function consoleList() {
  return Promise.resolve(this._exitCode === undefined ? [this._innerPid] : []);
};

const stubPath = path.join(workDir, 'stub-agent.js');
fs.writeFileSync(stubPath, [
  "const fs = require('node:fs');",
  'const prompt = process.argv[2] ?? "";',
  "const hash = require('node:crypto').createHash('sha256').update(prompt).digest('hex');",
  'fs.writeFileSync(process.env.PROBE_MARKER, JSON.stringify({ startedAt: Date.now(), promptLength: prompt.length, hash, prompt }));',
  "process.stdout.write('Stub agent ready\\r\\n');",
  'setInterval(() => {}, 60_000);',
].join('\n'));

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Prose with the characters a task prompt carries: backticks, quotes, `$`,
// parentheses, line breaks.
const proseSource = [
  'docs/architecture/sessions/agent-absence-sweep.md',
  'docs/platforms/shells-and-paths.md',
  'docs/architecture/sessions/suspend-and-cleanup.md',
].map((relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8')).join('\n\n');

function commandFor(prompt) {
  return `${quoteArg(process.execPath, 'powershell')} ${quoteArg(stubPath, 'powershell')} ${quoteArg(prompt, 'powershell', { multiline: true })}`;
}

function launchFor(prompt) {
  return buildTypedLaunch({
    command: commandFor(prompt),
    shell: 'powershell.exe',
    platform: 'win32',
    sessionDirectory: null,
    batchShimLaunch: () => null,
  });
}

/** The longest prompt whose typed line is at most `targetBytes`. */
function promptForBytes(targetBytes) {
  let low = 0;
  let high = proseSource.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (launchFor(proseSource.slice(0, middle)).typedLineBytes <= targetBytes) low = middle;
    else high = middle - 1;
  }
  return proseSource.slice(0, low);
}

async function runCell(profile, targetBytes) {
  const promptSent = promptForBytes(targetBytes);
  // What a whole delivery looks like: the quoting writes a content `"` as `'`
  // on purpose (`escapeForDoubleQuotedShell`, shell-quote.ts).
  const prompt = promptSent.replace(/"/g, "'");
  const launch = launchFor(promptSent);
  const markerPath = path.join(workDir, `marker-${profile}-${targetBytes}.json`);
  fs.rmSync(markerPath, { force: true });
  const args = profile === 'real'
    ? ['-NoLogo']
    : ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `Start-Sleep -Seconds ${Number(profile)}`];
  const profileMs = profile === 'real' ? 0 : Number(profile) * 1000;
  const tracker = new AgentOutputTracker();
  const chunks = [];
  const spawnedAt = Date.now();
  let trackerFiredMs = null;
  const shell = pty.spawn('powershell.exe', args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: workDir,
    env: { ...process.env, PROBE_MARKER: markerPath },
  });
  let exited = null;
  shell.onExit((exit) => { exited = { ms: Date.now() - spawnedAt, code: exit.exitCode }; });
  shell.onData((data) => {
    const atMs = Date.now() - spawnedAt;
    chunks.push({ atMs, data });
    if (trackerFiredMs === null && tracker.consume('probe', data)) trackerFiredMs = atMs;
  });
  await sleep(TYPE_AFTER_SPAWN_MS);
  shell.write(`${launch.typedLine}\r`);

  const deadline = spawnedAt + profileMs + LOST_AFTER_PROFILE_MS;
  let marker = null;
  while (Date.now() < deadline && exited === null) {
    if (fs.existsSync(markerPath)) {
      try {
        marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        break;
      } catch {
        // Written as we read it; read again.
      }
    }
    await sleep(100);
  }
  if (marker) await sleep(AFTER_START_READ_MS);
  try { shell.kill(); } catch { /* already gone */ }
  await sleep(500);

  const firstOutputMs = chunks.length > 0 ? chunks[0].atMs : null;
  // Where a prompt that arrived changed first differs, with a little context.
  let firstDifference = null;
  if (marker && marker.hash !== sha256(prompt)) {
    let index = 0;
    while (index < prompt.length && prompt[index] === marker.prompt[index]) index += 1;
    firstDifference = {
      index,
      sent: JSON.stringify(prompt.slice(Math.max(0, index - 40), index + 40)),
      received: JSON.stringify(String(marker.prompt).slice(Math.max(0, index - 40), index + 40)),
    };
  }
  return {
    firstDifference,
    profile,
    targetBytes,
    typedLineBytes: launch.typedLineBytes,
    outcome: marker ? (marker.hash === sha256(prompt) ? 'ran_whole' : 'ran_mangled') : (exited ? 'shell_exited' : 'lost'),
    agentStartMs: marker ? marker.startedAt - spawnedAt : null,
    promptLengthSent: prompt.length,
    promptLengthReceived: marker ? marker.promptLength : null,
    firstOutputMs,
    trackerFiredMs,
    trackerCeilingMs: AGENT_START_CEILING_MS,
    trackerMissedPastCeiling: marker !== null && trackerFiredMs === null && firstOutputMs !== null
      && marker.startedAt - spawnedAt - firstOutputMs > AGENT_START_CEILING_MS,
    shellExit: exited,
    outputTail: marker ? null : chunks.map((chunk) => chunk.data).join('').slice(-600),
  };
}

async function main() {
  const cells = [
    ...profileCells.map((profile) => [profile, profileAxisBytes]),
    ...lengthCells.filter((bytes) => !(profileCells.includes('0') && bytes === profileAxisBytes)).map((bytes) => ['0', bytes]),
  ];
  const results = [];
  for (const [profile, bytes] of cells) {
    process.stdout.write(`cell profile=${profile} bytes=${bytes} ... `);
    const result = await runCell(profile, bytes);
    results.push(result);
    console.log(`${result.outcome} agentStart=${result.agentStartMs}ms firstOutput=${result.firstOutputMs}ms tracker=${result.trackerFiredMs ?? 'never'}ms typed=${result.typedLineBytes}B`);
    if (result.outputTail) console.log(`  output tail: ${JSON.stringify(result.outputTail)}`);
    if (result.firstDifference) console.log(`  first difference at ${result.firstDifference.index}:\n    sent     ${result.firstDifference.sent}\n    received ${result.firstDifference.received}`);
  }
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  removeWorkDir();
}

/**
 * The stub agent is a grandchild that can still hold workDir as its cwd for a
 * moment after the shell is killed, and Windows refuses to remove it then.
 */
function removeWorkDir() {
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`Could not remove ${workDir}: ${error.message}`);
  }
}

main().catch((error) => {
  console.error(error);
  removeWorkDir();
  process.exitCode = 1;
});
