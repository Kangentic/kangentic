/**
 * Run the capture matrix behind the sample install.
 *
 * Three kinds of recording, all made by scripts/capture-agent-scrollback.js in a real PTY:
 *
 *   sessions   tests/captures/fixtures/demo/manifest.json lists one per session the boards show
 *              (which agent, which repo, the prompt, where the recording is cut).
 *   spawns     DERIVED from the dataset: for every task with no session, the agent starting on
 *              that task the way a drag into an auto-spawn column starts it on the desktop, with
 *              the prompt Kangentic's default template sends ("<title>: <description>"). A To Do
 *              task gets one boot per mode it can land in (plan, acceptEdits); the rest get the
 *              executing mode. The web build replays one when a visitor drags the card.
 *   terminals  DERIVED from the dataset: one per project, the default agent started with no
 *              prompt, which is what a new Command Terminal is.
 *
 * Prepares one scratch repo per project under a SHORT temp path (Windows path limits bite under a
 * deep one): a shallow clone for the two upstream samples, a copy of scripts/demo-repos/contoso-web
 * for the scaffolded work project. Each run is independent: a failed capture is reported and the
 * next one starts.
 *
 *   node scripts/capture-demo-sessions.mjs                  every recording
 *   node scripts/capture-demo-sessions.mjs --only codex     recordings whose file name contains "codex"
 *                                                            (a comma-separated list matches any of them)
 *   node scripts/capture-demo-sessions.mjs --skip-existing  keep recordings that already exist
 *   node scripts/capture-demo-sessions.mjs --root <dir>     scratch root (default: the home directory;
 *                                                            the clones land at ~\work\... and ~\oss\...)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'captures', 'fixtures', 'demo');
const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8'));
// Node strips the types itself; the dataset module has no Node imports by design.
const dataset = await import(pathToFileURL(path.join(repoRoot, 'tests', 'captures', 'helpers', 'demo-dataset.ts')).href);

const argv = process.argv.slice(2);
const readFlag = (name) => { const index = argv.indexOf(name); return index === -1 ? null : argv[index + 1]; };
const only = readFlag('--only');
const skipExisting = argv.includes('--skip-existing');
// The scratch clones live under the recording user's HOME at the same relative paths the sample
// install gives them (~\work\contoso-web, ~\oss\spring-petclinic). Every CLI prints the working
// directory somewhere, several as a tilde path and full-screen TUIs truncated to a column, and a
// truncated path can only be rewritten if the part that survives is already the final text; that
// leaves the sanitizer one job, the home prefix. --root moves them, at the cost of that property.
const scratchRoot = readFlag('--root') ?? os.homedir();

/** The project's directory relative to the home directory, straight from the dataset's paths. */
function homeRelativePath(project) {
  const segments = project.path.split(/[\\/]+/);
  // C:\Users\dev\<group>\<name>: everything after the user's directory.
  return path.join(...segments.slice(3));
}

/** How long a boot recording runs: the header, the prompt, and the first tool calls. */
const SPAWN_BOOT_SECONDS = 25;
/** A Command Terminal boot: the header and the empty prompt. */
const TERMINAL_BOOT_SECONDS = 8;

/**
 * The capture mode for an agent in a Kangentic permission mode. Codex's Windows sandbox needs
 * a helper the recording machine does not have, so every Codex recording runs in bypass mode.
 */
function captureMode(agent, permissionMode) {
  if (agent === 'codex') return 'bypass';
  if (agent === 'claude') return permissionMode;
  return null;
}

function laneOf(task) {
  return (dataset.DEMO_LANES_BY_PROJECT[task.projectId] || []).find((lane) => lane.slug === task.lane) || null;
}

/** The spawn boots: one per task with no session, per mode it can be dragged into. */
function derivedSpawnEntries() {
  const entries = [];
  for (const task of dataset.DEMO_TASKS) {
    if (task.session_id || task.archivedDaysAgo) continue;
    const lane = laneOf(task);
    if (!lane || lane.role === 'done') continue;
    const project = dataset.DEMO_PROJECTS.find((candidate) => candidate.id === task.projectId);
    // A task pin wins, then the column's own agent, then the project default (the app's order).
    const agent = task.agent || lane.agent || project.default_agent;
    // The default spawn_agent template is {{title}}{{description}}{{attachments}}, and the
    // description resolver prefixes ": " (src/main/agent/shared/task-template-resolvers.ts).
    const prompt = task.description ? `${task.title}: ${task.description}` : task.title;
    const modes = lane.slug === 'todo' ? ['plan', 'acceptEdits'] : [lane.permission_mode || 'acceptEdits'];
    for (const permissionMode of modes) {
      entries.push({
        kind: 'spawn',
        file: `spawn-${task.id}-${permissionMode}.json`,
        taskId: task.id,
        permissionMode,
        project: project.name,
        agent,
        mode: captureMode(agent, permissionMode),
        prompt,
        stopAfter: SPAWN_BOOT_SECONDS,
      });
    }
  }
  return entries;
}

/**
 * The Command Terminal boots: the project's default agent, no prompt, two per project. A new
 * terminal's window opens alone or tiled beside the project's existing terminal, and the two
 * sizes differ enough that a boot recorded at one breaks at the other (an inline TUI's repaint
 * lands on wrapped rows), so each layout has its own recording and the frame picks one at
 * spawn time.
 */
function derivedTerminalEntries() {
  return dataset.DEMO_PROJECTS.flatMap((project) => ['single', 'tiled'].map((layout) => ({
    kind: 'terminal',
    layout,
    file: layout === 'single' ? `terminal-${project.id}.json` : `terminal-${project.id}-tiled.json`,
    projectId: project.id,
    project: project.name,
    agent: project.default_agent,
    mode: captureMode(project.default_agent, 'acceptEdits'),
    prompt: '',
    stopAfter: TERMINAL_BOOT_SECONDS,
  })));
}

function prepareRepo(name, spec) {
  const project = dataset.DEMO_PROJECTS.find((candidate) => candidate.name === name);
  if (!project) throw new Error(`[matrix] ${name} is not a project in the dataset`);
  const target = path.join(scratchRoot, homeRelativePath(project));
  if (fs.existsSync(path.join(target, '.git'))) {
    console.error(`[matrix] ${name}: scratch repo present at ${target}`);
    return target;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (spec.git) {
    console.error(`[matrix] ${name}: cloning ${spec.git}`);
    execFileSync('git', ['clone', '--depth', '1', spec.git, target], { stdio: 'inherit' });
  } else if (spec.scaffold) {
    console.error(`[matrix] ${name}: copying scaffold ${spec.scaffold}`);
    fs.cpSync(path.join(repoRoot, spec.scaffold), target, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: target, stdio: 'inherit' });
    execFileSync('git', ['add', '-A'], { cwd: target, stdio: 'inherit' });
    execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', 'Initial import'], { cwd: target, stdio: 'inherit' });
    if (fs.existsSync(path.join(target, 'package.json'))) {
      console.error(`[matrix] ${name}: npm install`);
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: target, stdio: 'inherit', shell: process.platform === 'win32' });
    }
  } else {
    throw new Error(`[matrix] repo ${name} has neither git nor scaffold`);
  }
  return target;
}

/**
 * A scaffold change (the allow-list, say) has to reach an existing scratch copy too; the copy is
 * refreshed from the scaffold and re-committed so a diff is measured against the same tree the
 * repo ships. Untracked build output (node_modules) is kept.
 */
function refreshScaffold(name, spec, target) {
  if (!spec.scaffold) return;
  fs.cpSync(path.join(repoRoot, spec.scaffold), target, { recursive: true });
  execFileSync('git', ['add', '-A'], { cwd: target, stdio: 'ignore' });
  try {
    execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', 'Refresh scaffold'], { cwd: target, stdio: 'ignore' });
    console.error(`[matrix] ${name}: scaffold refreshed`);
  } catch {
    // Nothing changed; git commit exits non-zero on an empty index.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every capture starts from the committed tree so one agent's edits never leak into the next. */
async function resetRepo(target) {
  // A just-killed agent can still hold a file for a moment on Windows; retry before giving up,
  // and never let a reset failure take the whole matrix down.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const lockPath = path.join(target, '.git', 'index.lock');
      if (fs.existsSync(lockPath)) fs.rmSync(lockPath, { force: true });
      execFileSync('git', ['reset', '--hard', '-q'], { cwd: target, stdio: 'ignore' });
      execFileSync('git', ['clean', '-fdq', '-e', 'node_modules'], { cwd: target, stdio: 'ignore' });
      return;
    } catch (error) {
      console.error(`[matrix] reset of ${target} failed (attempt ${attempt}): ${error.message ?? error}`);
      await sleep(2000);
    }
  }
  console.error(`[matrix] ${target} could not be reset; the next capture starts from a dirty tree`);
}

/** The capture script's own default timeout; a manifest entry can raise its own with "timeout". */
const DEFAULT_CAPTURE_TIMEOUT_SECONDS = 240;

/** The capture script's own timeout plus the exit grace, then a hard stop, so a stuck PTY handle can never stall the matrix. */
function captureWatchdogMs(entry) {
  return ((entry.timeout || DEFAULT_CAPTURE_TIMEOUT_SECONDS) + 90) * 1000;
}

/**
 * The PTY size a recording is made at: the size of the surface it plays on, from the manifest's
 * geometry. A replay cannot renegotiate the size the way a live PTY does, so a full-screen TUI
 * only reproduces at its recorded size, and a row-based renderer wraps and pads at the recorded
 * width and height; recorded at the surface's size, both look as the desktop would.
 */
function geometryFor(entry) {
  if (entry.cols && entry.rows) return { cols: entry.cols, rows: entry.rows };
  const geometry = manifest.geometry;
  // The rows follow the agent: a surface's context bar is two rows for Claude (the account's
  // rate-limit pills) and one for every other agent, which is two more terminal rows.
  const forAgent = (surface) => ({ cols: surface.cols, rows: (surface.rowsByAgent && surface.rowsByAgent[entry.agent]) || surface.rows });
  if (entry.kind === 'session') {
    const session = dataset.DEMO_SESSIONS.find((candidate) => candidate.id === entry.sessionId);
    return forAgent(session && session.transient ? geometry.commandTerminal : geometry.taskWindow);
  }
  if (entry.kind === 'terminal') return forAgent(entry.layout === 'tiled' ? geometry.commandTerminalTiled : geometry.commandTerminal);
  return forAgent(geometry.taskWindow);
}

function runCapture(entry, cwd) {
  const out = path.join(fixturesDir, entry.file);
  const { cols, rows } = geometryFor(entry);
  const args = [
    path.join(repoRoot, 'scripts', 'capture-agent-scrollback.js'),
    '--agent', entry.agent, '--cwd', cwd, '--project', entry.project, '--prompt', entry.prompt, '--out', out,
    '--cols', String(cols), '--rows', String(rows),
  ];
  if (entry.mode) args.push('--mode', entry.mode);
  // A slower agent needs longer than the capture script's default before it is cut: a recording
  // that stops on "timeout" ends mid-work, which is a working session's shape, not an idle one's.
  if (entry.timeout) args.push('--timeout', String(entry.timeout));
  if (entry.stopAfter) args.push('--stop-after', String(entry.stopAfter));
  if (entry.stopWhen) args.push('--stop-when', entry.stopWhen);
  if (entry.kind === 'session') {
    // The frame at the moment the live frame opens this session at, when it is shown as working.
    const session = dataset.DEMO_SESSIONS.find((candidate) => candidate.id === entry.sessionId);
    const liveTail = (session && session.liveTailMs) || manifest.liveTailMs;
    if (liveTail) args.push('--live-tail', String(liveTail));
  }
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      console.error(`[matrix] ${entry.file}: watchdog fired, stopping the capture process`);
      child.kill();
    }, captureWatchdogMs(entry));
    child.on('exit', (code) => {
      clearTimeout(watchdog);
      // A recording written before a forced stop still counts. A file left over from an earlier
      // run does not: a capture that hung before writing would otherwise report the stale
      // recording as captured, and the stale one would ship.
      const written = fs.existsSync(out) && fs.statSync(out).mtimeMs >= startedAt;
      if (watchdogFired && !written) console.error(`[matrix] ${entry.file}: no recording written; the earlier file, if any, is unchanged`);
      resolve(code === 0 || written ? 0 : (watchdogFired ? 'watchdog' : (code ?? 1)));
    });
  });
}

const entries = [
  ...manifest.captures.map((entry) => ({ kind: 'session', ...entry })),
  ...derivedSpawnEntries(),
  ...derivedTerminalEntries(),
];
console.error(`[matrix] ${manifest.captures.length} sessions, ${entries.filter((entry) => entry.kind === 'spawn').length} spawn boots, ${entries.filter((entry) => entry.kind === 'terminal').length} terminal boots`);

const refreshed = new Set();
const results = [];
for (const entry of entries) {
  if (only && !only.split(',').some((needle) => entry.file.includes(needle))) continue;
  const outPath = path.join(fixturesDir, entry.file);
  if (skipExisting && fs.existsSync(outPath)) {
    console.error(`[matrix] ${entry.file}: exists, skipped`);
    results.push({ file: entry.file, status: 'skipped' });
    continue;
  }
  const spec = manifest.repos[entry.project];
  const cwd = prepareRepo(entry.project, spec);
  if (!refreshed.has(entry.project)) {
    refreshScaffold(entry.project, spec, cwd);
    refreshed.add(entry.project);
  }
  await resetRepo(cwd);
  console.error(`\n[matrix] ${entry.file}: ${entry.agent} on ${entry.project}${entry.kind === 'session' ? '' : ` (${entry.kind} boot)`}`);
  const code = await runCapture(entry, cwd);
  results.push({ file: entry.file, status: code === 0 ? 'captured' : `failed (${code})` });
  await resetRepo(cwd);
}

console.error('\n[matrix] summary');
for (const result of results) console.error(`  ${result.status.padEnd(12)} ${result.file}`);
