/**
 * Build the web demo's Knowledge Graph with the shipped pipeline and keep what it drew.
 *
 * The web build has no main process, so the graph a visitor sees is a fixture
 * (tests/captures/fixtures/demo/graph/knowledge-graph.json). The parity rule
 * (`.claude/rules/web-demo-parity.md`) wants it derived, never authored, the way the message trails
 * are, so this does not compute anything itself. It registers the sample install in a running
 * `/preview` as real projects (src/devtools/main/seed-knowledge-graph-demo.ts), points each
 * recorded session at its agent's own history, opens each project, and lets main index, embed,
 * lay out, cluster and name the regions. It then reads the snapshots out through the preview's
 * devtools bridge and maps the preview's ids onto the dataset's.
 *
 * Like the trails, this is NOT reproducible from the repository: the conversations are the
 * agents' histories on the machine that recorded the sample install (scripts/capture-demo-sessions.mjs
 * and scripts/capture-demo-archived-runs.mjs). A session whose history is gone, or whose agent keeps
 * none, gets no node, and the fixture says which and why rather than leaving a gap.
 *
 * What is kept is only what the pipeline computed: each node's place, size, regions and agent name,
 * the links, the neighbour lists, the named regions at every granularity, and the coverage and
 * Index counts. A node's title, model, cost and time come from the dataset's rows when the demo
 * seeds them, as main's `documentMetadata` joins the same rows on the desktop, so a node always
 * agrees with its card.
 *
 * Each project's repository is a fresh copy whose history is the one the demo's History pane
 * shows: the contoso-web scaffold built from its commit plan (checked against the history fixture's
 * tip), and a one-commit clone of each upstream sample's scratch clone. The Index's commit count is
 * then the count that pane lists.
 *
 * Prerequisites: a `/preview` of this worktree running, Settings > Developer > Allow Unsafe
 * Operations on, and the bge-base embedding model on the machine (Settings > Knowledge Graph
 * downloads it). The preview's data is thrown away when it stops, so the seed runs once per launch.
 *
 *   node scripts/capture-demo-knowledge-graph.mjs
 *   node scripts/capture-demo-knowledge-graph.mjs --check        build and report, write nothing
 *   node scripts/capture-demo-knowledge-graph.mjs --root <dir>   where the archived runs' clones
 *                                                                were (default: the home dir); the
 *                                                                root capture-demo-archived-runs.mjs
 *                                                                was given, since a run's history
 *                                                                is filed under its clone's path
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildScaffoldRepo } from './lib/demo-scaffold-repo.mjs';
import { importTsModule } from './lib/bundle-ts-module.mjs';
import { archivedClonePath, scratchClonePath, scratchRootFromArgv } from './lib/demo-archived-clone.mjs';
import { gitOutput } from './lib/git-output.mjs';
import { evaluateInPreview, readPreviewPort } from './lib/preview-bridge.mjs';

const require = createRequire(import.meta.url);
const { buildSanitizer } = require('./lib/demo-sanitizer.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'captures', 'fixtures', 'demo');
const outPath = path.join(fixturesDir, 'graph', 'knowledge-graph.json');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
/** Where the archived runs' clones were, as scripts/capture-demo-archived-runs.mjs was told. */
const archivedRoot = scratchRootFromArgv(argv);

const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8'));
const archivedRuns = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'archived', 'runs.json'), 'utf-8'));
const contosoHistory = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'history', 'contoso-web.json'), 'utf-8'));
const dataset = await importTsModule(path.join(repoRoot, 'tests', 'captures', 'helpers', 'demo-dataset.ts'));
const extract = await importTsModule(path.join(repoRoot, 'tests', 'captures', 'helpers', 'message-trail-extract.ts'));
const metrics = await importTsModule(path.join(repoRoot, 'tests', 'captures', 'helpers', 'archived-run-metrics.ts'));

/** Embedding a few thousand chunks at the drain's duty cycle takes minutes, not hours. */
const READY_TIMEOUT_MS = 45 * 60 * 1000;
const POLL_MS = 5000;
/** Region naming lands on a read after the build; the key has to hold this many reads running. */
const STABLE_READS = 3;
/** Reads with the unindexed count unchanged before the sweep is taken as stopped. */
const UNINDEXED_QUIET_POLLS = 3;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// ---------------------------------------------------------------- the preview bridge
/** Two minutes a call: a seed or a project open can take that long, a status read never does. */
const call = (port, expression) => evaluateInPreview(port, `(async () => (${expression}))()`, 120_000);

// ---------------------------------------------------------------- the repositories
const workRoot = path.join(os.tmpdir(), 'kangentic-demo-graph');

/** The scratch clone a project's recordings ran in, under the real home directory. */
function captureCwd(project) {
  return scratchClonePath(os.homedir(), project.path);
}

/** A fresh repository whose history is what the demo's History pane shows for the project. */
function prepareProjectRepo(project) {
  const target = path.join(workRoot, project.name);
  // Retried: a preview from an earlier run can still hold handles in the copy on Windows.
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(workRoot, { recursive: true });
  const spec = manifest.repos[project.name];
  if (spec.scaffold) {
    buildScaffoldRepo(path.join(repoRoot, spec.scaffold), target);
    const tip = gitOutput(target, ['rev-parse', 'HEAD']);
    if (tip !== contosoHistory.tipHash) throw new Error(`${project.name}: the scaffold built at ${tip}, the history fixture names ${contosoHistory.tipHash}; re-run scripts/capture-demo-history.mjs`);
  } else {
    // One commit, the one the recordings ran against, as the shallow scratch clone has.
    execFileSync('git', ['clone', '--quiet', '--depth', '1', pathToFileURL(captureCwd(project)).href, target], { stdio: 'inherit' });
  }
  return { path: target, commits: Number(gitOutput(target, ['rev-list', '--count', 'HEAD'])) };
}

// ---------------------------------------------------------------- the plan
async function planProject(project) {
  const tasks = dataset.DEMO_TASKS.filter((task) => task.projectId === project.id);
  const sessions = [];
  const withoutNode = [];
  for (const entry of manifest.captures) {
    const session = dataset.DEMO_SESSIONS.find((candidate) => candidate.id === entry.sessionId);
    // A Command Terminal is transient: no session row, so nothing for the indexer to find.
    if (!session || session.projectId !== project.id || session.transient || !session.taskId) continue;
    const record = JSON.parse(fs.readFileSync(path.join(fixturesDir, entry.file), 'utf-8'));
    const cwd = captureCwd(project);
    let agentSessionId = null;
    try {
      const source = await extract.locateTranscriptSource(record, cwd);
      if (source) agentSessionId = source.agentSessionId;
      else withoutNode.push({ sessionId: session.id, reason: `${record.agent} keeps no transcript Kangentic can read (${extract.AGENTS_WITHOUT_TRANSCRIPTS[record.agent]})` });
    } catch (error) {
      withoutNode.push({ sessionId: session.id, reason: `its history is gone from the recording machine (${error.message})` });
    }
    sessions.push({ key: session.id, taskKey: session.taskId, agent: record.agent, agentSessionId, cwd });
  }
  // The id the seed gives an archived task's last session, which its summary carries too.
  for (const task of dataset.DEMO_ARCHIVED_TASKS.filter((candidate) => candidate.projectId === project.id)) {
    const run = archivedRuns[task.id];
    if (!run) {
      withoutNode.push({ sessionId: dataset.archivedSessionIdOf(task.id), reason: 'no recorded run in archived/runs.json; run scripts/capture-demo-archived-runs.mjs' });
      continue;
    }
    const cwd = archivedClonePath(archivedRoot, project.path, task.id);
    // Named here when the history is gone (Claude's cleanupPeriodDays, or a --root other than the
    // run's): the index can never count it, so the wait for it would only run to its timeout.
    const historyPath = metrics.claudeHistoryPath(run.agentSessionId, cwd);
    if (!fs.existsSync(historyPath)) {
      withoutNode.push({ sessionId: dataset.archivedSessionIdOf(task.id), reason: `its history is gone from the recording machine (${historyPath})` });
      sessions.push({ key: dataset.archivedSessionIdOf(task.id), taskKey: task.id, agent: run.agent, agentSessionId: null, cwd });
      continue;
    }
    sessions.push({ key: dataset.archivedSessionIdOf(task.id), taskKey: task.id, agent: run.agent, agentSessionId: run.agentSessionId, cwd });
  }
  return {
    plan: {
      key: project.id,
      name: project.name,
      defaultAgent: project.default_agent,
      tasks: tasks.map((task) => ({
        key: task.id,
        title: task.title,
        description: task.description ?? '',
        labels: task.labels ?? [],
        displayId: task.display_id,
        done: task.lane === 'done',
        archived: Boolean(task.archivedDaysAgo),
      })),
      backlog: dataset.DEMO_BACKLOG
        .filter((item) => item.projectId === project.id)
        .map((item) => ({ title: item.title, description: item.description ?? '', priority: item.priority, labels: item.labels ?? [] })),
      sessions,
    },
    withoutNode,
  };
}

// ---------------------------------------------------------------- reading the graph back
function parseWire(wire) {
  if (!wire) return null;
  const projection = wire.projection ?? (wire.projectionJson ? JSON.parse(wire.projectionJson) : null);
  return { ...wire, projection };
}

const corpusOf = (snapshot, corpus) => snapshot.index.corpora.find((entry) => entry.corpus === corpus);

/** Has the open sweep and the embedding drain caught up with everything this project holds? */
function indexCaughtUp(snapshot, expected) {
  const conversation = corpusOf(snapshot, 'conversation');
  const task = corpusOf(snapshot, 'task');
  const commit = corpusOf(snapshot, 'commit');
  return snapshot.semanticAvailable
    && snapshot.coverage.notYetIndexed.documents === 0
    && snapshot.coverage.knownDocumentIdsMatched === expected.conversations
    && conversation.chunks > 0 && conversation.embeddedChunks === conversation.chunks
    && task.documents === expected.tasks && task.embeddedChunks === task.chunks
    && commit.documents === expected.commits;
}

async function waitFor(label, read, done) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: not ready after ${READY_TIMEOUT_MS / 60000} minutes; last read ${JSON.stringify(last)?.slice(0, 600)}`);
}

/** Why a planned session with a history got no node, from the index's own state row. */
function stateOf(databasePath, agentSessionId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const state = database.prepare("SELECT status, chunk_count AS chunks FROM memory_index_state WHERE corpus = 'conversation' AND doc_id = ?").get(agentSessionId);
    return state ? `the indexer left it ${state.status} with ${state.chunks} chunks` : 'the indexer never reached it';
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------- run
const port = readPreviewPort(repoRoot);
const planned = [];
for (const project of dataset.DEMO_PROJECTS) {
  const repo = prepareProjectRepo(project);
  const { plan, withoutNode } = await planProject(project);
  plan.path = repo.path;
  planned.push({ project, plan, withoutNode, expected: { conversations: plan.sessions.filter((session) => session.agentSessionId).length, tasks: plan.tasks.length + plan.backlog.length, commits: repo.commits } });
  console.error(`[graph] ${project.name}: ${plan.tasks.length} tasks, ${plan.sessions.length} sessions (${planned.at(-1).expected.conversations} with a history), ${repo.commits} commit(s)`);
}

const config = await call(port, 'window.electronAPI.config.get()');
// The config the demo's dataset carries, so Settings there describes the index the maps came from.
await call(port, `window.electronAPI.config.set(${JSON.stringify({ knowledgeGraph: { ...config.knowledgeGraph, ...dataset.DEMO_KNOWLEDGE_GRAPH_CONFIG } })})`);
const seeded = await call(port, `window.electronAPI.dev.seedKnowledgeGraphDemo(${JSON.stringify({ projects: planned.map((entry) => entry.plan) })})`);

const output = {
  $comment: 'The web demo\'s Knowledge Graph, built by main\'s own pipeline over the sample install\'s recorded conversations and read back out by scripts/capture-demo-knowledge-graph.mjs. Not reproducible from the repository: the conversations live on the machine that recorded them. Node metadata other than the agent name (title, model, cost, time) is not here; the seed fills it from the dataset rows, as main joins them on the desktop. withoutNode names every recorded session that has no node, with the reason.',
  modelTag: null,
  projects: {},
};
for (const entry of planned) {
  const seededProject = seeded.projects.find((candidate) => candidate.key === entry.project.id);
  if (!seededProject) throw new Error(`${entry.project.name}: the seed result has no project keyed ${entry.project.id}`);
  console.error(`[graph] ${entry.project.name}: opening`);
  await call(port, `window.electronAPI.projects.open(${JSON.stringify(seededProject.projectId)})`);
  // Null while the snapshot cannot be read (a worker restart, a close racing the read): not ready.
  const readSnapshot = async () => parseWire(await call(port, `window.electronAPI.knowledgeGraph.graphSnapshot(${JSON.stringify(seededProject.projectId)})`));

  // A sweep indexes at most MAX_SESSIONS_PER_SWEEP conversations and leaves the rest to the next
  // project open, so a project holding more is opened again whenever the sweep has stopped moving
  // with conversations still unindexed: the same opens a user's later visits would make.
  let lastUnindexed = null;
  let quietPolls = 0;
  let snapshot = await waitFor(`${entry.project.name} index`, async () => {
    const snapshot = await readSnapshot();
    const unindexed = snapshot ? snapshot.coverage.notYetIndexed.documents : null;
    quietPolls = unindexed !== null && unindexed === lastUnindexed ? quietPolls + 1 : 0;
    lastUnindexed = unindexed;
    if (unindexed && quietPolls >= UNINDEXED_QUIET_POLLS) {
      console.error(`[graph] ${entry.project.name}: ${unindexed} conversation(s) left after a sweep; opening the project again`);
      await call(port, `window.electronAPI.projects.open(${JSON.stringify(seededProject.projectId)})`);
      quietPolls = 0;
    }
    return snapshot;
  }, (snapshot) => snapshot !== null && indexCaughtUp(snapshot, entry.expected));
  console.error(`[graph] ${entry.project.name}: indexed and embedded; building the map`);
  if (!snapshot.projection || snapshot.stale) await call(port, `window.electronAPI.knowledgeGraph.refreshGraph(${JSON.stringify(seededProject.projectId)})`);
  snapshot = await waitFor(`${entry.project.name} map`, readSnapshot, (candidate) => candidate !== null && candidate.projection !== null && !candidate.building && !candidate.stale);

  // The names are laid over the map on a read after the build: wait until the key holds.
  let stable = 0;
  let key = snapshot.projectionKey;
  while (stable < STABLE_READS) {
    await sleep(POLL_MS);
    const next = await readSnapshot();
    if (next === null) {
      stable = 0;
      continue;
    }
    snapshot = next;
    stable = snapshot.projectionKey === key && !snapshot.building && !snapshot.stale ? stable + 1 : 0;
    key = snapshot.projectionKey;
  }

  const sessionKey = (previewId) => seededProject.sessionKeys[previewId] ?? null;
  const taskKey = (previewId) => (previewId ? seededProject.taskKeys[previewId] ?? null : null);
  const projection = snapshot.projection;
  const nodes = projection.nodes.map((node) => {
    const demoSessionId = sessionKey(node.sessionId);
    if (!demoSessionId) throw new Error(`${entry.project.name}: node ${node.docKey} belongs to no planned session`);
    // `agent` stays: it is the adapter's display name, which main resolved through its registry
    // from the row's session type. The rest of a node's metadata is the dataset's (see above).
    return { docKey: `conversation::${demoSessionId}`, sessionId: demoSessionId, taskId: taskKey(node.taskId), agent: node.agent, x: node.x, y: node.y, z: node.z, chunkCount: node.chunkCount, clusters: node.clusters };
  });
  const drawn = new Set(nodes.map((node) => node.sessionId));
  const databasePath = path.join(repoRoot, '.kangentic', 'data', 'projects', `${seededProject.projectId}.db`);
  const withoutNode = [...entry.withoutNode];
  for (const session of entry.plan.sessions) {
    if (drawn.has(session.key) || !session.agentSessionId) continue;
    withoutNode.push({ sessionId: session.key, reason: stateOf(databasePath, session.agentSessionId) });
  }

  output.modelTag = projection.modelTag;
  output.projects[entry.project.id] = {
    projection: {
      nodes,
      edges: projection.edges,
      nodeNeighbors: projection.nodeNeighbors,
      clusterings: projection.clusterings,
      signature: projection.signature,
      modelTag: projection.modelTag,
      dimensions: projection.dimensions,
      storageBytes: projection.storageBytes,
    },
    coverage: snapshot.coverage,
    index: snapshot.index,
    withoutNode,
  };
  const regions = projection.clusterings.map((clustering) => `${clustering.granularity}: ${clustering.regions.map((region) => `${region.label} (${region.size})`).join(', ')}`);
  console.error(`[graph] ${entry.project.name}: ${nodes.length} nodes, ${projection.edges.length} links\n  ${regions.join('\n  ')}\n  no node: ${withoutNode.map((item) => `${item.sessionId} (${item.reason})`).join('; ') || 'none'}`);
}

const serialized = `${JSON.stringify(output, null, 2)}\n`;
for (const project of dataset.DEMO_PROJECTS) {
  buildSanitizer({ project: project.name, cwd: captureCwd(project) }).assertClean(serialized, `knowledge-graph.json (${project.name})`);
}
if (checkOnly) {
  console.error('[graph] --check: nothing written');
} else {
  fs.writeFileSync(outPath, serialized, 'utf-8');
  console.error(`[graph] wrote ${path.relative(repoRoot, outPath)}`);
}
