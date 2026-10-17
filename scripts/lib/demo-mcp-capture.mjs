/**
 * What a recording whose agent calls Kangentic's own MCP tools needs before its PTY starts, and
 * what it leaves to clean up after. Used by scripts/capture-demo-sessions.mjs for a manifest entry
 * marked `mcp`.
 *
 * Kangentic's MCP server runs only inside the app (an HTTP server in Electron main), and its tools
 * answer from that app's board, so the recording is made against a running `/preview` of this
 * worktree, never the dogfooding app: the preview's data is ephemeral, and the dogfooding app's
 * server would describe the recording machine's real projects. The preview is seeded with the
 * sample install's project as the scene paints it (src/devtools/main/seed-knowledge-graph-demo.ts:
 * every task in its own column, each column's agent, the recorded task's branch and worktree), so
 * each ticket number, column and path a `kangentic_*` result prints is the demo's.
 *
 * The agent is launched the way Kangentic launches it with the server attached
 * (src/main/agent/adapters/claude/command-builder.ts): an `--mcp-config` naming the project's URL
 * with the per-launch token, and a `--settings` file whose only rule allows `mcp__kangentic`, the
 * rule the desktop adds so its own tools never prompt. Nothing else is pre-allowed.
 *
 * It runs in the task's own worktree, as Kangentic runs a task, with `node_modules` linked to the
 * main checkout's the way Kangentic links it (src/main/git/node-modules-link.ts), so
 * `kangentic_get_current_task` resolves the task from the caller's working directory. Before the
 * recording a headless run of the task's own prompt (`claude -p`, unrecorded) leaves the work the
 * recorded session then reviews: the column message is a review, and a review needs a diff.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { evaluateInPreview, readPreviewPort } from './preview-bridge.mjs';
import { importTsModule } from './bundle-ts-module.mjs';

const require = createRequire(import.meta.url);
const { toSpawnable, shellReparsedArgument, childAgentEnv } = require('./spawnable.js');

/** A headless pre-run that has not finished in this long is stopped, and the capture with it. */
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a stopped POSIX run gets to end its own tool processes before it is killed outright. */
const STOP_GRACE_MS = 5000;

/** The comparison src/shared/paths.ts isSamePath makes: case-insensitive on Windows only. */
function sameDirectory(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
}

/** The column a dataset task sits in, by name, from its project's lanes. */
export function laneNameOf(dataset, task) {
  const lane = (dataset.DEMO_LANES_BY_PROJECT[task.projectId] || []).find((candidate) => candidate.slug === task.lane);
  if (!lane) throw new Error(`[mcp] ${task.id} sits in lane "${task.lane}", which its project's board does not have`);
  return lane.name;
}

/**
 * The board the preview is seeded with: the project's whole install (live tasks, the archived
 * history, the backlog) plus its scene-only tasks, each in its own column, and the recorded task
 * at the worktree the agent runs in.
 */
export function seedPlanFor(dataset, project, root, recordedTask, worktree) {
  const tasks = dataset.DEMO_ALL_TASKS.filter((task) => task.projectId === project.id);
  const lanes = dataset.DEMO_LANES_BY_PROJECT[project.id] || [];
  return {
    projects: [{
      key: project.id,
      name: project.name,
      path: root,
      defaultAgent: project.default_agent,
      columnAgents: Object.fromEntries(lanes.filter((lane) => lane.agent).map((lane) => [lane.name, lane.agent])),
      tasks: tasks.map((task) => ({
        key: task.id,
        title: task.title,
        description: task.description,
        labels: task.labels,
        displayId: task.display_id,
        done: task.lane === 'done',
        archived: Boolean(task.archivedDaysAgo),
        lane: laneNameOf(dataset, task),
        branchName: task.branch_name,
        baseBranch: task.base_branch,
        // Only the recorded task's worktree exists on this machine; the others' paths are the
        // sample install's and name nothing here.
        ...(task.id === recordedTask.id ? { worktreePath: worktree } : {}),
      })),
      backlog: dataset.DEMO_BACKLOG
        .filter((item) => item.projectId === project.id)
        .map((item) => ({ title: item.title, description: item.description, priority: item.priority, labels: item.labels })),
      sessions: [],
    }],
  };
}

/** The running preview's inspection port, refused with the two things to fix when it cannot be driven. */
async function connectPreview(repoRoot) {
  const port = readPreviewPort(repoRoot);
  // A trivial eval proves the bridge answers and Allow Unsafe Operations is on before anything is
  // written; evaluateInPreview names the setting when it is off.
  await evaluateInPreview(port, '1 + 1');
  return port;
}

/**
 * Drop a project a run registered at the scratch clone, so a re-run seeds a fresh board instead of
 * being refused by the seeder's doubling guard. The app's removal ends the project's sessions (the
 * mock agent the recorded move started in the next column, whose working directory holds the task's
 * worktree open) and deletes `.kangentic/`, so the node_modules link must already be gone
 * (releaseBoard): a recursive delete that met a Windows junction would empty the clone's own
 * node_modules.
 */
async function dropEarlierProject(port, root) {
  const projects = await evaluateInPreview(port, 'window.electronAPI.projects.list()');
  for (const project of projects ?? []) {
    if (!sameDirectory(project.path, root)) continue;
    console.error(`[mcp] removing the project an earlier run registered at ${root}`);
    await evaluateInPreview(port, `window.electronAPI.projects.delete(${JSON.stringify(project.id)})`, 120_000);
  }
}

/** Set the preview's Claude CLI path, or clear it (null) so the preview finds Claude on its own again. */
async function setClaudePath(port, cliPath) {
  await evaluateInPreview(port,
    'window.electronAPI.config.get().then((config) => { '
    + 'const cliPaths = { ...((config.agent || {}).cliPaths || {}) }; '
    + `const cliPath = ${JSON.stringify(cliPath)}; `
    + 'if (cliPath === null) delete cliPaths.claude; else cliPaths.claude = cliPath; '
    + 'return window.electronAPI.config.set({ ...config, agent: { ...(config.agent || {}), cliPaths } }); })');
}

/**
 * Any spawn the recorded move starts in the next column runs the repo's mock CLI rather than a
 * second real agent (the lifecycle rig's precedent, scripts/rigs/browser-contention/lifecycle.mjs).
 * Returns the path the preview had before (null for none), which releaseBoard puts back.
 */
async function pointClaudeAtMock(port, repoRoot) {
  const mockCli = path.join(repoRoot, 'tests', 'fixtures', process.platform === 'win32' ? 'mock-claude.cmd' : 'mock-claude.js');
  // Git keeps the script without its executable bit, so a POSIX spawn of it would fail with EACCES
  // (the E2E tier sets the bit the same way before pointing the app at it).
  if (process.platform !== 'win32') fs.chmodSync(mockCli, 0o755);
  const previous = await evaluateInPreview(port, 'window.electronAPI.config.get().then((config) => ((config.agent || {}).cliPaths || {}).claude ?? null)');
  await setClaudePath(port, mockCli);
  return previous ?? null;
}

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });

/**
 * The worktree's node_modules link, removed on its own. A Windows junction goes with rmdirSync,
 * which removes the reparse point alone; a POSIX symlink is file-like. Either way nothing reaches
 * the target (src/main/git/node-modules-link.ts), where a recursive removal would.
 */
function removeNodeModulesLink(worktree) {
  const link = path.join(worktree, 'node_modules');
  let isLink = false;
  try { fs.readlinkSync(link); isLink = true; } catch { isLink = false; }
  if (!isLink) return;
  if (process.platform === 'win32') fs.rmdirSync(link);
  else fs.unlinkSync(link);
}

/** Take the worktree away: the node_modules link first, then the checkout. */
function removeTaskWorktree(root, worktree) {
  removeNodeModulesLink(worktree);
  if (fs.existsSync(worktree)) {
    try { git(root, ['worktree', 'remove', '--force', worktree]); } catch { /* not registered: removed below */ }
  }
  try { git(root, ['worktree', 'prune']); } catch { /* nothing registered */ }
  fs.rmSync(worktree, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Put the scratch clone and the preview back as they were before an `mcp` capture: the link first,
 * then the preview's project (whose removal ends the agent holding the worktree), then whatever of
 * the worktree is left, and last the preview's Claude path, once the project that could auto-spawn
 * an agent is gone. A link that cannot be removed stops everything, because the project's removal
 * deletes `.kangentic/`. After it, each step runs even when an earlier one failed, and the first
 * failure is thrown at the end.
 */
async function releaseBoard(port, root, worktree, previousClaudePath) {
  removeNodeModulesLink(worktree);
  let failure = null;
  try {
    await dropEarlierProject(port, root);
  } catch (error) {
    failure = error;
  }
  try {
    removeTaskWorktree(root, worktree);
  } catch (error) {
    failure ??= error;
  }
  if (previousClaudePath !== undefined) {
    try {
      await setClaudePath(port, previousClaudePath);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/** The task's worktree on its own branch from the scaffold's tip, with node_modules linked in. */
function addTaskWorktree(root, worktree, branch) {
  removeTaskWorktree(root, worktree);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(root, ['worktree', 'add', '-B', branch, worktree, 'HEAD']);
  const target = path.join(root, 'node_modules');
  if (fs.existsSync(target)) fs.symlinkSync(target, path.join(worktree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Whether a `claude -p --output-format json` run reported success: one result object whose
 * `is_error` is false (tests/fixtures/claude-print-result-success.json is a real one). An error
 * result, stdout that is not JSON, and any other shape a later CLI might print read as failure.
 */
export function preparedRunSucceeded(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    return false;
  }
  return result !== null && typeof result === 'object' && !Array.isArray(result) && result.type === 'result' && result.is_error === false;
}

/**
 * Stop a timed-out run and what it started. Windows ends the whole tree. POSIX sends SIGTERM, which
 * lets Claude end its own tool processes, then SIGKILL if the run is still alive after a grace.
 */
function stopRun(child) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, STOP_GRACE_MS).unref();
}

/**
 * The work the review reads: one headless run of the task's own prompt, not recorded. A run may
 * commit what it did. The commit is dropped and the work kept (a mixed reset to where the run
 * started), so the review reads it as the working tree's diff, and the recording's `changes` is
 * measured against the base as every other recording's is.
 *
 * A run that times out is rejected once it has exited, not when it is told to stop, so the caller
 * never removes the worktree under a run still working in it. Its exit is awaited rather than its
 * `close`, which a tool process still holding stdout would hold off.
 */
function runPrepare(cwd, prompt) {
  const spawnable = toSpawnable('claude', ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--', prompt]);
  const reparsed = shellReparsedArgument(spawnable);
  if (reparsed !== null) throw new Error(`[mcp] claude starts only through ${spawnable.file} here, which would re-parse ${JSON.stringify(reparsed.slice(0, 80))}; put claude.exe on PATH`);
  const startedAt = git(cwd, ['rev-parse', 'HEAD']).trim();
  console.error(`[mcp] preparing the work to review: ${prompt}`);
  return new Promise((resolve, reject) => {
    const child = spawn(spawnable.file, spawnable.args, { cwd, env: childAgentEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
    const timeoutError = new Error(`[mcp] the preparing run exceeded ${PREPARE_TIMEOUT_MS / 60000} minutes`);
    let stdout = '';
    let timedOut = false;
    let lastResort = null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      stopRun(child);
      // A run that outlives even that is reported anyway, so the capture never waits on it forever.
      lastResort = setTimeout(() => reject(timeoutError), 2 * STOP_GRACE_MS);
    }, PREPARE_TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(lastResort); reject(error); });
    child.on('exit', () => {
      if (!timedOut) return;
      clearTimeout(lastResort);
      reject(timeoutError);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0 || !preparedRunSucceeded(stdout)) {
        reject(new Error(`[mcp] the preparing run failed (exit ${code}): ${stdout.slice(0, 400)}`));
        return;
      }
      if (git(cwd, ['rev-parse', 'HEAD']).trim() !== startedAt) {
        git(cwd, ['reset', '-q', startedAt]);
        console.error('[mcp] the preparing run committed its work; kept the work and dropped the commit');
      }
      const changed = git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean).length;
      if (changed === 0) {
        reject(new Error('[mcp] the preparing run changed nothing, so the review would have no diff to read'));
        return;
      }
      console.error(`[mcp] the work to review is in place: ${changed} changed path(s)`);
      resolve();
    });
  });
}

/**
 * The two files the desktop hands Claude for its server: mcp.json, and the settings with the allow
 * rule. An entry's `claudeSettings` is a display preference a user sets in Claude's own /config,
 * which Claude stores in the user's ~/.claude/settings.json and reads as its own user layer beside
 * Kangentic's --settings file. The rig cannot edit the recording machine's file, so the preference
 * rides in the --settings file instead, where Claude reads it the same way. The allow rule is
 * always the desktop's, and the entry cannot carry a permission of its own. A write that fails
 * takes the folder with it, since mcp.json carries the server's token.
 */
export function writeLaunchFiles(url, token, userSettings) {
  if (userSettings && Object.prototype.hasOwnProperty.call(userSettings, 'permissions')) {
    throw new Error('[mcp] claudeSettings stands in for a display preference; it carries no permissions, which nothing pre-allows');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-demo-mcp-'));
  const mcpConfigPath = path.join(directory, 'mcp.json');
  const settingsPath = path.join(directory, 'settings.json');
  try {
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { kangentic: { type: 'http', url, headers: { 'X-Kangentic-Token': token } } } }, null, 2));
    fs.writeFileSync(settingsPath, JSON.stringify({ ...(userSettings ?? {}), permissions: { allow: ['mcp__kangentic'] } }, null, 2));
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, mcpConfigPath, settingsPath };
}

/**
 * Get the preview, the board, the worktree and the work in place for one `mcp` entry. Returns the
 * directory the agent runs in, the extra capture-agent-scrollback.js arguments, and a cleanup that
 * takes the board, the worktree, the preview's Claude path and the launch files back again.
 */
export async function prepareMcpCapture({ repoRoot, dataset, entry, root }) {
  if (entry.agent !== 'claude') throw new Error(`[mcp] ${entry.file}: only Claude's launch shape carries Kangentic's MCP server here`);
  const session = dataset.findDemoSession(entry.sessionId);
  const recordedTask = session && dataset.DEMO_ALL_TASKS.find((task) => task.id === session.taskId);
  if (!recordedTask || !recordedTask.worktree_folder || !recordedTask.branch_name) {
    throw new Error(`[mcp] ${entry.file}: its session's task needs a worktree folder and a branch to run in`);
  }
  const project = dataset.DEMO_PROJECTS.find((candidate) => candidate.id === recordedTask.projectId);
  const worktree = path.join(root, '.kangentic', 'worktrees', recordedTask.worktree_folder);

  const port = await connectPreview(repoRoot);
  await releaseBoard(port, root, worktree);
  const seeded = await evaluateInPreview(port, `window.electronAPI.dev.seedKnowledgeGraphDemo(${JSON.stringify(seedPlanFor(dataset, project, root, recordedTask, worktree))})`, 120_000);

  // From here the preview holds the seeded project, so every failure releases it before it is
  // thrown: the caller gets no cleanup from a throw, and a worktree left behind would sit under the
  // clone the next scaffold refresh reads.
  let previousClaudePath;
  let launch = null;
  const release = async () => {
    try {
      await releaseBoard(port, root, worktree, previousClaudePath);
    } finally {
      if (launch) fs.rmSync(launch.directory, { recursive: true, force: true, maxRetries: 3 });
    }
  };
  try {
    const projectResult = seeded?.projects?.[0];
    if (!projectResult?.mcpUrl || !seeded?.mcpToken) throw new Error('[mcp] the preview reports no MCP server; turn Settings > MCP Server on and re-run');
    const seededTaskCount = Object.keys(projectResult.taskKeys).length;
    console.error(`[mcp] seeded ${project.name} with ${seededTaskCount} tasks at ${root}; ${recordedTask.title} is #${recordedTask.display_id} in ${laneNameOf(dataset, recordedTask)}`);
    previousClaudePath = await pointClaudeAtMock(port, repoRoot);
    addTaskWorktree(root, worktree, recordedTask.branch_name);
    const trust = await importTsModule(path.join(repoRoot, 'src', 'main', 'agent', 'adapters', 'claude', 'trust-manager.ts'));
    await trust.ensureWorktreeTrust(worktree);
    const prompt = recordedTask.description ? `${recordedTask.title}: ${recordedTask.description}` : recordedTask.title;
    await runPrepare(worktree, prompt);
    launch = writeLaunchFiles(projectResult.mcpUrl, seeded.mcpToken, entry.claudeSettings);
  } catch (error) {
    try {
      await release();
    } catch (releaseError) {
      console.error(`[mcp] releasing the board after that failure failed too (${releaseError.message ?? releaseError}); the next mcp capture retries it`);
    }
    throw error;
  }
  return {
    cwd: worktree,
    args: ['--mcp-config', launch.mcpConfigPath, '--settings', launch.settingsPath, '--scratch-root', root],
    cleanup: release,
  };
}
