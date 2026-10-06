/**
 * Run each archived task of the sample install once, for real, and keep what the run cost and did.
 *
 * An archived task in the dataset is a task in Done with no session on the board. On the desktop it
 * still had one: the Completed Tasks dialog lists what its last session cost and did, and the
 * Knowledge Graph draws its conversation. Both come from that run, so both are recorded here rather
 * than written by hand. DERIVED from the dataset the way the spawn boots are
 * (scripts/capture-demo-sessions.mjs): every task in `DEMO_ARCHIVED_TASKS`, archived with no session.
 *
 * Each task runs headless on Claude Code (`claude -p --output-format json`), the agent its card
 * names, with the prompt Kangentic's default template sends (`archivedRunPromptOf`), in its OWN
 * throwaway clone next to the project's scratch clone (~\work\contoso-web-cw-done-deploy). Never the
 * shared clone: its history is what the History pane and the Knowledge Graph's commit count read,
 * and a task already merged upstream has to start from the commit before its change, which
 * `manifest.archived.refs` pins. A run in a repo that already has the change does no work, and its
 * row would be a false record.
 *
 * What is kept, in tests/captures/fixtures/demo/archived/runs.json keyed by task id:
 *   cost and duration   the run's own result JSON (`total_cost_usd` as reported, `duration_ms`),
 *                       the pair the status line feeds `captureSessionMetrics` on the desktop
 *   model               the main conversation's, read from the run's history (`mainLoopModel`):
 *                       never the result's largest `modelUsage` entry, which can be the advisor's
 *   tokens and tools    main's `parseClaudeTranscriptUsage` and `parseClaudeTranscriptToolCounts`
 *                       over the run's history, which `refineTranscriptTokens` and
 *                       `refineTranscriptToolCounts` call at suspend
 *   churn               git over the clone: merge-base to the working tree, untracked files
 *                       included, the scope `DiffService.getChurnSummary` reads (that service
 *                       imports Electron, so it cannot run here)
 *   agentSessionId      which history is the run's, for scripts/capture-demo-knowledge-graph.mjs,
 *                       which points main's own indexer at it; the clone's path is not stored but
 *                       derived by both scripts from one rule (scripts/lib/demo-archived-clone.mjs)
 * The transcript itself stays on the recording machine, like every other source here.
 *
 * Each clone is trusted first by the adapter's own writer (`ensureWorktreeTrust`), as the desktop
 * trusts a workspace before every spawn, so the run honours the repository's own permissions.allow
 * list. The runs use acceptEdits, the mode a lane spawns in by default. Headless, a command that
 * would need an approval is refused instead of asked, and the agent works around it; read each
 * transcript for refusals before keeping a run. Main reads Claude's history and ~/.claude.json from
 * the home directory and never from CLAUDE_CONFIG_DIR, so a run refuses to start with that set.
 *
 * The install's older history (fixtures/demo/archived/history.json) runs the same way, on that
 * file's model and effort; an upstream sample's history task is that sample's own merged commit,
 * started at its parent in a worktree of one blobless clone per sample.
 *
 *   node scripts/capture-demo-archived-runs.mjs                   every archived task not yet run
 *   node scripts/capture-demo-archived-runs.mjs --only cw-done    tasks whose id contains the text
 *   node scripts/capture-demo-archived-runs.mjs --force           run again even if recorded
 *   node scripts/capture-demo-archived-runs.mjs --jobs 4          runs at a time (default 1)
 *   node scripts/capture-demo-archived-runs.mjs --prune           remove each clone once its run is kept
 *   node scripts/capture-demo-archived-runs.mjs --root <dir>      scratch root (default: the home dir);
 *                                                                 the graph capture takes the same flag
 *   node scripts/capture-demo-archived-runs.mjs --remeasure       run nothing: re-read every recorded
 *                                                                 run's model, tokens and tools from its
 *                                                                 history, after a change to how they
 *                                                                 are measured
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildScaffoldRepo } from './lib/demo-scaffold-repo.mjs';
import { importTsModule } from './lib/bundle-ts-module.mjs';
import { archivedClonePath, scratchClonePath, scratchRootFromArgv } from './lib/demo-archived-clone.mjs';
import { gitOutput } from './lib/git-output.mjs';

const require = createRequire(import.meta.url);
const { buildSanitizer, sanitizeDeep } = require('./lib/demo-sanitizer.js');
const { toSpawnable, shellReparsedArgument, childAgentEnv } = require('./lib/spawnable.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'captures', 'fixtures', 'demo');
const outPath = path.join(fixturesDir, 'archived', 'runs.json');
const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8'));
const dataset = await importTsModule(path.join(repoRoot, 'tests', 'captures', 'helpers', 'demo-dataset.ts'));
const metrics = await importTsModule(path.join(repoRoot, 'tests', 'captures', 'helpers', 'archived-run-metrics.ts'));

const argv = process.argv.slice(2);
const readFlag = (name) => { const index = argv.indexOf(name); return index === -1 ? null : argv[index + 1]; };
const only = readFlag('--only');
const force = argv.includes('--force');
const prune = argv.includes('--prune');
const remeasure = argv.includes('--remeasure');
const jobs = Math.max(1, Number(readFlag('--jobs') ?? 1));
const scratchRoot = scratchRootFromArgv(argv);
const settings = manifest.archived;
if (!settings || !settings.model || !settings.permissionMode) throw new Error('[archived] manifest.json has no "archived" block with a model and a permissionMode');

/**
 * How one task runs. A history task (fixtures/demo/archived/history.json) takes that file's model
 * and effort, and an upstream one starts at the parent of the commit it is; every other archived
 * task takes the manifest's block.
 */
function runPlanFor(task) {
  const history = dataset.DEMO_HISTORY.tasks.find((entry) => entry.id === task.id);
  if (history) {
    return { model: dataset.DEMO_HISTORY.model, effort: dataset.DEMO_HISTORY.effort, permissionMode: settings.permissionMode, ref: history.upstream?.parent ?? null };
  }
  return { model: settings.model, effort: null, permissionMode: settings.permissionModes?.[task.id] ?? settings.permissionMode, ref: settings.refs?.[task.id] ?? null };
}

/** A run is long work, not a boot: well past the longest one seen, then a hard stop. */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** One blobless clone per upstream sample, which every history task's worktree is added from. */
function baseCloneFor(project, spec) {
  const base = `${scratchClonePath(scratchRoot, project.path)}-base`;
  if (!fs.existsSync(path.join(base, '.git'))) {
    fs.mkdirSync(path.dirname(base), { recursive: true });
    console.error(`[archived] cloning ${spec.git} into ${base}`);
    execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', spec.git, base], { stdio: 'inherit' });
  }
  return base;
}

function prepareClone(project, spec, target, ref) {
  if (!fs.existsSync(path.join(target, '.git'))) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (spec.git) {
      // A worktree of the sample's blobless clone, at the commit the run starts from: the full
      // history without a second copy of it per task. Long paths on, for a deep old tree.
      const base = baseCloneFor(project, spec);
      console.error(`[archived] adding a worktree of ${project.name} at ${ref ? ref.slice(0, 10) : 'HEAD'} in ${target}`);
      execFileSync('git', ['-C', base, '-c', 'core.longpaths=true', 'worktree', 'add', '--detach', target, ref ?? 'HEAD'], { stdio: 'inherit' });
    } else if (spec.scaffold) {
      console.error(`[archived] building scaffold ${spec.scaffold} into ${target}`);
      buildScaffoldRepo(path.join(repoRoot, spec.scaffold), target);
      if (fs.existsSync(path.join(target, 'package.json'))) {
        // One command string through the shell, which finds npm's .cmd shim on Windows; an argument
        // array with `shell` set is deprecated (DEP0190).
        execSync('npm install --no-audit --no-fund --silent', { cwd: target, stdio: 'inherit' });
      }
    } else {
      throw new Error(`[archived] repo ${project.name} has neither git nor scaffold`);
    }
  }
  const lockPath = path.join(target, '.git', 'index.lock');
  if (fs.existsSync(lockPath)) fs.rmSync(lockPath, { force: true });
  gitOutput(target, ['reset', '--hard', '-q']);
  gitOutput(target, ['clean', '-fdq', '-e', 'node_modules']);
  if (ref) gitOutput(target, ['checkout', '-q', '--detach', ref]);
  return gitOutput(target, ['rev-parse', 'HEAD']);
}

/** Lines in a file the way the Changes panel counts an untracked one: newlines, binary skipped. */
function countUntrackedLines(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) if (byte === 0x0a) lines += 1;
  return buffer[buffer.length - 1] === 0x0a ? lines : lines + 1;
}

/** Branch churn against the starting commit: tracked changes in the working tree plus untracked files. */
function churnSince(cwd, baseRef) {
  let linesAdded = 0;
  let linesRemoved = 0;
  const files = new Set();
  const numstat = gitOutput(cwd, ['diff', '--numstat', baseRef]);
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [added, removed, filePath] = line.split('\t');
    files.add(filePath);
    if (added !== '-') linesAdded += Number(added);
    if (removed !== '-') linesRemoved += Number(removed);
  }
  const untracked = gitOutput(cwd, ['ls-files', '--others', '--exclude-standard']);
  for (const filePath of untracked.split('\n').filter(Boolean)) {
    files.add(filePath);
    const lines = countUntrackedLines(path.join(cwd, filePath));
    if (lines !== null) linesAdded += lines;
  }
  return { filesChanged: files.size, linesAdded, linesRemoved };
}

/**
 * The Claude binary, resolved the way scripts/capture-agent-scrollback.js resolves one. A shim
 * runs through its interpreter, which re-parses the line after Node quotes it, and a mangled prompt
 * would record a run of some other task, so such a prompt is refused rather than run.
 */
function claudeSpawnable(args) {
  const spawnable = toSpawnable('claude', args);
  const reparsed = shellReparsedArgument(spawnable);
  if (reparsed !== null) {
    throw new Error(`[archived] claude starts only through ${spawnable.file} here, which would re-parse the argument ${JSON.stringify(reparsed.slice(0, 80))}; put claude.exe on PATH`);
  }
  return spawnable;
}

/** Stop a run and everything it started. On Windows a kill reaches only the direct child (cmd.exe, for a shim). */
function killRun(child) {
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

/**
 * Mark the clone trusted with the adapter's own writer, and refuse the run when the write did not
 * land: that writer skips (and the desktop shows one trust prompt) when Claude holds
 * ~/.claude.json.lock past its budget, and an untrusted headless run ignores the repository's
 * permissions.allow list, so its numbers would describe some other run.
 */
async function seedClaudeTrust(trust, cwd) {
  await trust.ensureWorktreeTrust(cwd);
  const key = path.resolve(cwd).replace(/\\/g, '/');
  const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
  if (data.projects?.[key]?.hasTrustDialogAccepted !== true) {
    throw new Error(`${cwd} is not trusted in ~/.claude.json (the lock was held, or the file did not parse); the run would ignore the allow list`);
  }
}

function runHeadless(cwd, prompt, plan) {
  const flags = ['-p', '--output-format', 'json', '--model', plan.model, '--permission-mode', plan.permissionMode];
  if (plan.effort) flags.push('--effort', plan.effort);
  const { file, args } = claudeSpawnable([...flags, '--', prompt]);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: childAgentEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => { killRun(child); reject(new Error(`run exceeded ${RUN_TIMEOUT_MS / 60000} minutes`)); }, RUN_TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    // 'close', not 'exit': only 'close' waits for stdout to end, and the result is parsed whole.
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`exit ${code}, unparseable result: ${stdout.slice(0, 400)}`));
      }
    });
  });
}

/**
 * Remove a run's clone once its numbers are kept. Only the clone's PATH matters afterwards: the
 * agent's history is filed under it, and the Knowledge Graph capture names it again by the same
 * rule. A worktree goes back through its base clone so the base forgets it.
 */
function removeClone(project, spec, cwd) {
  if (spec.git) {
    const base = baseCloneFor(project, spec);
    try {
      execFileSync('git', ['-C', base, 'worktree', 'remove', '--force', cwd], { stdio: 'ignore' });
      return;
    } catch {
      // A standalone clone made before the worktrees, or one already half gone: removed below.
    }
  }
  fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
}

const recorded = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf-8')) : {};
const archivedTasks = dataset.DEMO_ARCHIVED_TASKS;

/** Written after every run, in task order, so a failure or a stop keeps what already ran. */
function writeRecorded() {
  const ordered = Object.fromEntries(archivedTasks.filter((candidate) => recorded[candidate.id]).map((candidate) => [candidate.id, recorded[candidate.id]]));
  fs.writeFileSync(outPath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf-8');
}

/** Sanitize a record the way every fixture here is, and refuse it if a personal marker survives. */
function cleanRecord(record, project, cwd, label) {
  const sanitizer = buildSanitizer({ project: project.name, cwd });
  const clean = sanitizeDeep(record, sanitizer);
  sanitizer.assertClean(JSON.stringify(clean), label);
  return clean;
}

async function recordTask(task, context) {
  const project = dataset.DEMO_PROJECTS.find((candidate) => candidate.id === task.projectId);
  const spec = manifest.repos[project.name];
  const cwd = archivedClonePath(scratchRoot, project.path, task.id);
  const prompt = dataset.archivedRunPromptOf(task);
  const plan = runPlanFor(task);
  // Synchronous on purpose: two workers never prepare a clone at once, so the base clone and
  // its worktree list are never raced.
  const baseRef = prepareClone(project, spec, cwd, plan.ref);
  await seedClaudeTrust(context.trust, cwd);
  console.error(`[archived] ${task.id}: ${plan.model}${plan.effort ? ` (${plan.effort})` : ''} on ${project.name} at ${baseRef.slice(0, 10)}`);
  const startedAt = Date.now();
  const run = metrics.readHeadlessRunResult(await runHeadless(cwd, prompt, plan));
  const historyPath = metrics.claudeHistoryPath(run.sessionId, cwd);
  if (!fs.existsSync(historyPath)) throw new Error(`no history at ${historyPath} for session ${run.sessionId}`);
  const measured = await metrics.measureClaudeRun(historyPath);
  if (!measured) throw new Error('the history carries no usage or no tool call');
  const churn = churnSince(cwd, baseRef);
  const record = {
    agent: 'claude',
    agentVersion: context.agentVersion,
    model: measured.model ?? plan.model,
    ...(plan.effort ? { effort: plan.effort } : {}),
    permissionMode: plan.permissionMode,
    prompt,
    ref: spec.git ? baseRef : null,
    agentSessionId: run.sessionId,
    capturedAt: new Date(startedAt + run.durationMs).toISOString(),
    durationMs: run.durationMs,
    costUsd: run.costUsd,
    numTurns: run.numTurns,
    inputTokens: measured.inputTokens,
    outputTokens: measured.outputTokens,
    tools: measured.tools,
    ...churn,
  };
  const clean = cleanRecord(record, project, cwd, `${task.id} archived run`);
  recorded[task.id] = clean;
  writeRecorded();
  console.error(`[archived] ${task.id}: $${clean.costUsd.toFixed(2)}, ${Math.round(clean.durationMs / 60000)} min, ${Object.values(clean.tools).reduce((sum, count) => sum + count, 0)} tools, ${clean.filesChanged} files +${clean.linesAdded} -${clean.linesRemoved}`);
  if (prune) removeClone(project, spec, cwd);
}

/**
 * Re-read a recorded run's model, tokens and tools from its history, which stays on the recording
 * machine. Everything the history does not hold (cost, duration, turns, churn, the CLI version, the
 * capture time) is kept as recorded. True when a field changed.
 */
async function remeasureTask(task) {
  const record = recorded[task.id];
  const project = dataset.DEMO_PROJECTS.find((candidate) => candidate.id === task.projectId);
  const cwd = archivedClonePath(scratchRoot, project.path, task.id);
  const historyPath = metrics.claudeHistoryPath(record.agentSessionId, cwd);
  if (!fs.existsSync(historyPath)) throw new Error(`no history at ${historyPath}; Claude Code deletes its own after cleanupPeriodDays`);
  const measured = await metrics.measureClaudeRun(historyPath);
  if (!measured) throw new Error('the history carries no usage or no tool call');
  const next = cleanRecord({
    ...record,
    model: measured.model ?? record.model,
    inputTokens: measured.inputTokens,
    outputTokens: measured.outputTokens,
    tools: measured.tools,
  }, project, cwd, `${task.id} archived run`);
  const changed = ['model', 'inputTokens', 'outputTokens', 'tools'].filter((field) => JSON.stringify(next[field]) !== JSON.stringify(record[field]));
  if (changed.length === 0) return false;
  for (const field of changed) console.error(`[archived] ${task.id}: ${field} ${JSON.stringify(record[field])} -> ${JSON.stringify(next[field])}`);
  recorded[task.id] = next;
  return true;
}

let failed = 0;
const selected = archivedTasks.filter((task) => !only || task.id.includes(only));
if (remeasure) {
  const tasks = selected.filter((task) => recorded[task.id]);
  console.error(`[archived] re-measuring ${tasks.length} recorded run(s) from their histories`);
  let changedCount = 0;
  for (const task of tasks) {
    try {
      if (await remeasureTask(task)) changedCount += 1;
    } catch (error) {
      failed += 1;
      console.error(`[archived] ${task.id}: FAILED. ${error.message}`);
    }
  }
  if (changedCount > 0) writeRecorded();
  console.error(`[archived] done: ${changedCount} changed, ${failed} failed`);
} else {
  if (process.env.CLAUDE_CONFIG_DIR) {
    throw new Error('[archived] CLAUDE_CONFIG_DIR is set, but main (and this script) read Claude\'s history and ~/.claude.json from the home directory; unset it to record');
  }
  const trust = await importTsModule(path.join(repoRoot, 'src', 'main', 'agent', 'adapters', 'claude', 'trust-manager.ts'));
  const versionCommand = claudeSpawnable(['--version']);
  const agentVersion = execFileSync(versionCommand.file, versionCommand.args, { encoding: 'utf-8' }).trim().split(/\s+/)[0];
  const context = { trust, agentVersion };
  console.error(`[archived] ${archivedTasks.length} archived tasks, ${Object.keys(recorded).length} already recorded, ${jobs} at a time`);
  const queue = selected.filter((task) => !recorded[task.id] || force);
  async function worker() {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      try {
        await recordTask(task, context);
      } catch (error) {
        failed += 1;
        console.error(`[archived] ${task.id}: FAILED. ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: jobs }, () => worker()));
  console.error(`[archived] done: ${Object.keys(recorded).length} recorded, ${failed} failed this run`);
}
if (failed > 0) process.exit(1);
