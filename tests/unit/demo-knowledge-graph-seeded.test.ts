/**
 * The web demo's Knowledge Graph is a fixture main's own pipeline built over the sample install's
 * recorded conversations (tests/captures/fixtures/demo/graph/knowledge-graph.json, written by
 * scripts/capture-demo-knowledge-graph.mjs on the machine that recorded them). Like the message
 * trails it cannot be recomputed here, so this asserts it is PRESENT and that it describes the
 * sample install it is seeded into: every node a seeded conversation, every recorded conversation
 * a node or named with the reason it has none, every index the renderer follows in range, every
 * region named, and the Index counts the same ones the dataset's own rows and history give.
 *
 * It is the answer to the mock-parity test passing while the graph had nothing behind it: the
 * bridge's `graphSnapshot` answered null for every project, which is a valid answer, and the map
 * was simply never there.
 *
 * Below the fixture itself: Settings' Index card holds the same counts as the maps, a node carries
 * its card's own facts once the seed joins them, and the capture finds each run's history by the
 * agent's own session id (`agentSessionIdOf`).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEMO_ARCHIVED_RUNS, DEMO_ARCHIVED_SUMMARIES, DEMO_BACKLOG, DEMO_KNOWLEDGE_GRAPH, DEMO_KNOWLEDGE_GRAPH_NODE_TOTAL,
  DEMO_KNOWLEDGE_GRAPH_STATUS, DEMO_PROJECTS, DEMO_SESSIONS, DEMO_TASKS, archivedSessionIdOf, buildDemoPreConfig,
  shippedKnowledgeGraph,
} from '../../tests/captures/helpers/demo-dataset';
import { TranscriptMatchError, agentSessionIdOf } from '../../tests/captures/helpers/message-trail-extract';
import { SCENES } from '../../tests/captures/scenes';
import { KNOWLEDGE_GRAPH_GRANULARITIES } from '../../src/shared/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'captures', 'fixtures', 'demo');

interface ManifestEntry { file: string; sessionId: string }
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf-8')) as { captures: ManifestEntry[] };
const contosoHistory = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'history', 'contoso-web.json'), 'utf-8')) as { commits: unknown[] };

const projects = Object.entries(DEMO_KNOWLEDGE_GRAPH.projects);

/** Every conversation the sample install could draw, by project: recorded task sessions and archived runs. */
function recordedConversations(projectId: string): string[] {
  const live = manifest.captures
    .map((entry) => DEMO_SESSIONS.find((session) => session.id === entry.sessionId))
    .filter((session) => session && session.projectId === projectId && session.taskId && !session.transient)
    .map((session) => session!.id);
  const archived = DEMO_TASKS
    .filter((task) => task.projectId === projectId && task.archivedDaysAgo && !task.session_id && DEMO_ARCHIVED_RUNS[task.id])
    .map((task) => archivedSessionIdOf(task.id));
  return [...live, ...archived];
}

/** `recordedConversations` once per project, read inside the per-node loops below. */
const recordedByProject = new Map(DEMO_PROJECTS.map((project) => [project.id, new Set(recordedConversations(project.id))]));
const isRecordedIn = (projectId: string, sessionId: string): boolean => recordedByProject.get(projectId)?.has(sessionId) ?? false;

describe('demo Knowledge Graph fixture', () => {
  it('carries one map per sample project, keyed by its own id, built with one model', () => {
    expect(Object.keys(DEMO_KNOWLEDGE_GRAPH.projects).sort()).toEqual(DEMO_PROJECTS.map((project) => project.id).sort());
    expect(DEMO_KNOWLEDGE_GRAPH.modelTag).toMatch(/\S/);
    for (const [projectId, graph] of projects) {
      expect(graph.projection.nodes.length, `${projectId} draws nothing`).toBeGreaterThan(0);
      expect(graph.projection.modelTag, projectId).toBe(DEMO_KNOWLEDGE_GRAPH.modelTag);
    }
  });

  it('draws only seeded conversations, each on its own project\'s task', () => {
    for (const [projectId, graph] of projects) {
      const docKeys = new Set<string>();
      for (const node of graph.projection.nodes) {
        expect(node.docKey, projectId).toBe(`conversation::${node.sessionId}`);
        expect(docKeys.has(node.docKey), `${node.docKey} drawn twice`).toBe(false);
        docKeys.add(node.docKey);
        expect(isRecordedIn(projectId, node.sessionId), `${projectId} draws ${node.sessionId}, which it records no conversation for`).toBe(true);
        const task = DEMO_TASKS.find((candidate) => candidate.id === node.taskId);
        expect(task?.projectId, `${node.sessionId} hangs off task ${String(node.taskId)}`).toBe(projectId);
        expect(node.agent, `${node.sessionId} has no agent name`).toMatch(/\S/);
      }
    }
  });

  it('draws every recorded conversation, or names why it cannot', () => {
    for (const [projectId, graph] of projects) {
      const drawn = new Set(graph.projection.nodes.map((node) => node.sessionId));
      const named = new Map(graph.withoutNode.map((entry) => [entry.sessionId, entry.reason]));
      for (const sessionId of recordedByProject.get(projectId) ?? []) {
        if (drawn.has(sessionId)) {
          expect(named.has(sessionId), `${sessionId} is drawn and also listed without a node`).toBe(false);
          continue;
        }
        expect(named.get(sessionId), `${sessionId} is neither drawn nor named with a reason`).toMatch(/\S/);
      }
      for (const sessionId of named.keys()) expect(isRecordedIn(projectId, sessionId), `${sessionId} is named but not recorded here`).toBe(true);
    }
    // Vacuity: the archived runs are drawn, which is why they were recorded.
    const drawnEverywhere = new Set(projects.flatMap(([, graph]) => graph.projection.nodes.map((node) => node.sessionId)));
    for (const taskId of Object.keys(DEMO_ARCHIVED_RUNS)) expect(drawnEverywhere.has(archivedSessionIdOf(taskId)), taskId).toBe(true);
  });

  it('keeps every index the renderer follows in range, and names every region', () => {
    for (const [projectId, graph] of projects) {
      const { nodes, edges, nodeNeighbors, clusterings } = graph.projection;
      for (const edge of edges) {
        expect(edge.source >= 0 && edge.source < nodes.length && edge.target >= 0 && edge.target < nodes.length, `${projectId} edge ${edge.source}-${edge.target}`).toBe(true);
      }
      expect(nodeNeighbors.length, projectId).toBe(nodes.length);
      for (const list of nodeNeighbors) for (const neighbor of list) expect(neighbor.index >= 0 && neighbor.index < nodes.length, projectId).toBe(true);
      expect(clusterings.map((clustering) => clustering.granularity).sort(), projectId).toEqual([...KNOWLEDGE_GRAPH_GRANULARITIES].sort());
      for (const clustering of clusterings) {
        const regionIds = new Set(clustering.regions.map((region) => region.id));
        for (const region of clustering.regions) {
          expect(region.label, `${projectId} ${clustering.granularity} region ${region.id}`).toMatch(/\S/);
          expect(region.label, `${projectId} ${clustering.granularity} region ${region.id}`).not.toBe('unlabelled');
        }
        for (const node of nodes) expect(regionIds.has(node.clusters[clustering.granularity]), `${node.sessionId} ${clustering.granularity}`).toBe(true);
      }
      // The map is drawn from more than one point, or there is nothing to link.
      expect(edges.length, `${projectId} draws no links`).toBeGreaterThan(0);
    }
  });

  it('counts the index the sample install holds', () => {
    for (const [projectId, graph] of projects) {
      const corpus = (name: string) => graph.index.corpora.find((entry) => entry.corpus === name);
      // Task records are tasks and backlog items, as main's task corpus indexes them.
      const taskRecords = DEMO_TASKS.filter((task) => task.projectId === projectId).length
        + DEMO_BACKLOG.filter((item) => item.projectId === projectId).length;
      expect(corpus('task')?.documents, `${projectId} task records`).toBe(taskRecords);
      // The commits the History pane lists: the scaffold's plan for contoso-web, and the one commit
      // of each upstream sample's shallow clone.
      const project = DEMO_PROJECTS.find((candidate) => candidate.id === projectId);
      expect(corpus('commit')?.documents, `${projectId} commits`).toBe(project?.name === 'contoso-web' ? contosoHistory.commits.length : 1);
      expect(corpus('conversation')?.documents, `${projectId} conversations`).toBeGreaterThanOrEqual(graph.projection.nodes.length);
      // Embedded through: no line on the Index panel reads a percentage.
      for (const entry of graph.index.corpora) if (entry.embeds) expect(entry.embeddedChunks, `${projectId} ${entry.corpus}`).toBe(entry.chunks);
      expect(graph.coverage.notYetIndexed.documents, projectId).toBe(0);
    }
  });

  it('is what the seed serves and what the scene waits for', () => {
    expect(DEMO_KNOWLEDGE_GRAPH_NODE_TOTAL).toBe(projects.reduce((sum, [, graph]) => sum + graph.projection.nodes.length, 0));
    expect(SCENES['knowledge-graph']?.ready).toContain(`data-drawn-count="${DEMO_KNOWLEDGE_GRAPH_NODE_TOTAL}"`);
    // One scene per project as well, each waiting for that project's nodes alone.
    for (const project of DEMO_PROJECTS) {
      const scene = SCENES[`knowledge-graph-${project.name}`];
      expect(scene, `no knowledge-graph-${project.name} scene`).toBeDefined();
      expect(scene?.ready).toContain(`data-drawn-count="${DEMO_KNOWLEDGE_GRAPH.projects[project.id]?.projection.nodes.length}"`);
    }
    const dataset = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'captures', 'helpers', 'demo-dataset.ts'), 'utf-8');
    expect(dataset).toContain("from '../fixtures/demo/graph/knowledge-graph.json'");
    // Answered by the seed itself when the graph opens, from the maps it carries or fetches.
    expect(dataset, 'the seed answers the snapshots').toContain('window.electronAPI.knowledgeGraph.graphSnapshot = function');
    expect(dataset, 'the seed answers the Projects picker').toContain('window.electronAPI.knowledgeGraph.graphProjects = function');
  });
});

describe('demo Knowledge Graph status', () => {
  const documentsAcrossProjects = (corpusName: string) => projects.reduce(
    (sum, [, graph]) => sum + (graph.index.corpora.find((entry) => entry.corpus === corpusName)?.documents ?? 0), 0,
  );

  it('counts in Settings what the maps count, summed over every project', () => {
    const conversations = documentsAcrossProjects('conversation');
    const tasks = documentsAcrossProjects('task');
    const commits = documentsAcrossProjects('commit');
    // Vacuity: more than one project, and three different non-zero sums, so one project's count or a
    // line wired to another corpus's sum cannot match by coincidence.
    expect(projects.length).toBeGreaterThan(1);
    for (const sum of [conversations, tasks, commits]) expect(sum).toBeGreaterThan(0);
    expect(new Set([conversations, tasks, commits]).size).toBe(3);
    // The Index card's count is the corpus's `documents` (sourceStatusOf), not its chunks.
    expect(DEMO_KNOWLEDGE_GRAPH_STATUS.sources.conversations.count).toBe(conversations);
    expect(DEMO_KNOWLEDGE_GRAPH_STATUS.sources.tasks.count).toBe(tasks);
    expect(DEMO_KNOWLEDGE_GRAPH_STATUS.sources.commits.count).toBe(commits);
  });

  it('is switched on, with the model the maps were built with downloaded', () => {
    expect(DEMO_KNOWLEDGE_GRAPH_STATUS.indexingEnabled).toBe(true);
    expect(DEMO_KNOWLEDGE_GRAPH_STATUS.model.state).toBe('ready');
  });
});

describe('demo Knowledge Graph node facts', () => {
  const NOW_MS = Date.UTC(2026, 8, 1, 12, 0, 0);
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** One function's source out of the generated script, by brace matching from its declaration. */
  function extractFunction(script: string, name: string): string {
    const start = script.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`function ${name} not found in the generated seed`);
    const open = script.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < script.length; index += 1) {
      if (script[index] === '{') depth += 1;
      if (script[index] === '}') {
        depth -= 1;
        if (depth === 0) return script.slice(start, index + 1);
      }
    }
    throw new Error(`unbalanced function ${name} in the generated seed`);
  }

  interface SeededNode {
    sessionId: string;
    taskId: string | null;
    title: string | null;
    displayId: number | null;
    outcome: string | null;
    model: string | null;
    effort: string | null;
    durationMs: number | null;
    costUsd: number | null;
    tokens: number | null;
    lastActivityMs: number | null;
  }
  interface SeededSnapshot {
    projectId: string;
    projection: { nodes: SeededNode[]; builtAt: string; signature: string };
    building: boolean;
    buildProgress: unknown;
    stale: boolean;
    semanticAvailable: boolean;
    projectionKey: string;
  }
  interface SeededPickerRow { id: string; name: string; conversations: number; taskRecords: number; lastActivityMs: number | null }
  interface Lifted {
    script: string;
    snapshots: Record<string, SeededSnapshot>;
    projects: SeededPickerRow[];
    archivedExitedAtMs: (task: { archivedDaysAgo: number }) => number;
  }
  /** The parts of the seed's `data` a test below changes before lifting. */
  interface SeedData {
    tasks: Array<{ id: string; projectId: string; lane: string }>;
    lanesByProject: Record<string, Array<{ slug: string; role: string | null }>>;
    knowledgeGraph: { projects: Record<string, { projection: { nodes: Array<{ sessionId: string; taskId: string | null }> } }> };
  }

  /**
   * The seed's own `knowledgeGraphSeed`, run over the data it is generated with, at a fixed clock.
   * `adjust` edits that data first, to reach a case the sample install itself never has.
   */
  function liftKnowledgeGraphSeed(adjust?: (data: SeedData) => void): Lifted {
    const script = buildDemoPreConfig({ scrollback: Object.fromEntries(DEMO_SESSIONS.map((session) => [session.id, 'recording'])) });
    // `var data = <JSON>;` is one line: JSON.stringify escapes every newline inside a string.
    const dataStart = script.indexOf('var data = ') + 'var data = '.length;
    const data = JSON.parse(script.slice(dataStart, script.indexOf(';\n', dataStart))) as SeedData;
    adjust?.(data);
    const source = [
      'var tasksById = {};',
      'data.tasks.forEach(function (task) { tasksById[task.id] = task; });',
      extractFunction(script, 'archivedExitedAtMs'),
      extractFunction(script, 'knowledgeGraphSeed'),
      'var seeded = knowledgeGraphSeed(data.knowledgeGraph);',
      'return { snapshots: seeded.snapshots, projects: seeded.projects, archivedExitedAtMs: archivedExitedAtMs };',
    ].join('\n');
    const lifted = new Function('data', 'now', source)(data, NOW_MS) as Omit<Lifted, 'script'>;
    return { ...lifted, script };
  }

  // Lifted in a hook, not while the file collects, so a seed that cannot be built or lifted fails
  // these tests alone and leaves the fixture tests above reporting on their own.
  let lifted: Lifted;
  let seededNodes: SeededNode[];
  beforeAll(() => {
    lifted = liftKnowledgeGraphSeed();
    seededNodes = Object.values(lifted.snapshots).flatMap((snapshot) => snapshot.projection.nodes);
  });

  it('gives a live session\'s node its row\'s model and cost, and an archived task\'s node its summary\'s', () => {
    let live = 0;
    let archived = 0;
    for (const node of seededNodes) {
      const task = DEMO_TASKS.find((candidate) => candidate.id === node.taskId);
      const session = DEMO_SESSIONS.find((candidate) => candidate.id === node.sessionId);
      const summary = DEMO_ARCHIVED_SUMMARIES.find((candidate) => candidate.taskId === node.taskId);
      expect(task, `${node.sessionId} hangs off no task`).toBeDefined();
      expect(node.title, node.sessionId).toBe(task?.title);
      if (session) {
        live += 1;
        expect(node.model, node.sessionId).toBe(session.model?.displayName);
        expect(node.costUsd, node.sessionId).toBe(session.costUsd);
        expect(node.outcome, node.sessionId).toBe('active');
        continue;
      }
      expect(summary, `${node.sessionId} is neither a session nor an archived task`).toBeDefined();
      archived += 1;
      expect(node.model, node.sessionId).toBe(summary?.modelDisplayName);
      expect(node.costUsd, node.sessionId).toBe(summary?.costUsd);
      expect(node.tokens, node.sessionId).toBe((summary?.inputTokens ?? 0) + (summary?.outputTokens ?? 0));
      expect(node.durationMs, node.sessionId).toBe(summary?.durationMs);
      expect(node.outcome, node.sessionId).toBe('done');
    }
    // Vacuity: the map draws both kinds, or one branch above never ran.
    expect(live).toBeGreaterThan(0);
    expect(archived).toBeGreaterThan(0);
  });

  it('dates an archived node at the moment its run ended, before its task was archived', () => {
    let checked = 0;
    for (const node of seededNodes) {
      const task = DEMO_TASKS.find((candidate) => candidate.id === node.taskId);
      if (!task?.archivedDaysAgo || DEMO_SESSIONS.some((session) => session.id === node.sessionId)) continue;
      checked += 1;
      expect(node.lastActivityMs, node.sessionId).toBe(lifted.archivedExitedAtMs({ archivedDaysAgo: task.archivedDaysAgo }));
      // A run ends before its Done move archives the task, never at or after it.
      expect(node.lastActivityMs, node.sessionId).toBeLessThan(NOW_MS - task.archivedDaysAgo * DAY_MS);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('dates the Completed Tasks row\'s exit at the same moment, through the same function', () => {
    // The row's summaryCache entry is built inside the seed's pre-configure callback, which a unit
    // test cannot run, so what is pinned is that it reads archivedExitedAtMs, as the node above does.
    expect(lifted.script).toContain('var exitedAtMs = archivedExitedAtMs(task);');
    expect(lifted.script).toContain('exitedAt: new Date(exitedAtMs).toISOString()');
  });

  it('dates a live session\'s node at its newest tool call, and gives it its row\'s duration and effort', () => {
    let withToolCalls = 0;
    let live = 0;
    for (const node of seededNodes) {
      const session = DEMO_SESSIONS.find((candidate) => candidate.id === node.sessionId);
      if (!session) continue;
      live += 1;
      expect(node.durationMs, node.sessionId).toBe(session.durationMinutes * 60_000);
      expect(node.effort, node.sessionId).toBe(session.effort ?? null);
      if (session.events.length === 0) {
        // No tool call to date it by: still a real moment, and never one in the future.
        expect(node.lastActivityMs, node.sessionId).not.toBeNull();
        expect(node.lastActivityMs ?? Infinity, node.sessionId).toBeLessThanOrEqual(NOW_MS);
        continue;
      }
      withToolCalls += 1;
      // The newest call is the one with the fewest minutes ago, wherever the list happens to put it.
      const newestMinutesAgo = Math.min(...session.events.map((event) => event.minutesAgo));
      expect(node.lastActivityMs, node.sessionId).toBe(NOW_MS - newestMinutesAgo * 60_000);
    }
    // Vacuity: the map draws live sessions, and at least one of them has tool calls to date it by.
    expect(live).toBeGreaterThan(0);
    expect(withToolCalls).toBeGreaterThan(0);
  });

  it('builds each snapshot after the newest conversation it draws, and leaves it settled', () => {
    expect(Object.keys(lifted.snapshots).sort()).toEqual(projects.map(([projectId]) => projectId).sort());
    for (const [projectId, snapshot] of Object.entries(lifted.snapshots)) {
      const times = snapshot.projection.nodes.map((node) => node.lastActivityMs).filter((time): time is number => time !== null);
      expect(times.length, `${projectId} dates no node`).toBeGreaterThan(0);
      // A UTC instant, per the timestamp rule, no earlier than any conversation the map draws.
      expect(new Date(snapshot.projection.builtAt).toISOString(), projectId).toBe(snapshot.projection.builtAt);
      expect(Date.parse(snapshot.projection.builtAt), `${projectId} was built before its newest conversation`).toBeGreaterThanOrEqual(Math.max(...times));
      expect(Date.parse(snapshot.projection.builtAt), `${projectId} was built in the future`).toBeLessThanOrEqual(NOW_MS);
      // Nothing to wait for or rebuild: no build running, no progress bar, no stale banner.
      expect(snapshot.projectId).toBe(projectId);
      expect(snapshot.building, projectId).toBe(false);
      expect(snapshot.buildProgress, projectId).toBeNull();
      expect(snapshot.stale, projectId).toBe(false);
      expect(snapshot.semanticAvailable, projectId).toBe(true);
      // The renderer keys its drawn map on this, so it names the project and the layout it drew.
      expect(snapshot.projectionKey, projectId).toContain(projectId);
      expect(snapshot.projectionKey, projectId).toContain(snapshot.projection.signature);
    }
  });

  it('lists one picker row per project, named for it and dated at its newest node', () => {
    const datedAt = (projectId: string): number => Math.max(
      ...lifted.snapshots[projectId].projection.nodes.map((node) => node.lastActivityMs).filter((time): time is number => time !== null),
    );
    expect(lifted.projects.map((row) => row.id)).toEqual(DEMO_PROJECTS.map((project) => project.id));
    for (const row of lifted.projects) {
      expect(row.name, row.id).toBe(DEMO_PROJECTS.find((project) => project.id === row.id)?.name);
      expect(row.lastActivityMs, `${row.id} shows a different last activity than its map`).toBe(datedAt(row.id));
    }
  });

  it('calls a conversation done once its task is in the Done column, though not archived', () => {
    // The sample install has no conversation on a Done card that is still on the board, so one is made:
    // a live session's task moved into its project's Done column.
    const liveNode = seededNodes.find((node) => DEMO_SESSIONS.some((session) => session.id === node.sessionId));
    if (!liveNode?.taskId) throw new Error('the map draws no live session on a task');
    const movedTaskId = liveNode.taskId;
    const moved = liftKnowledgeGraphSeed((data) => {
      const task = data.tasks.find((candidate) => candidate.id === movedTaskId);
      const doneLane = task ? data.lanesByProject[task.projectId].find((lane) => lane.role === 'done') : undefined;
      if (!task || !doneLane) throw new Error(`no Done column to move ${movedTaskId} into`);
      task.lane = doneLane.slug;
    });
    const movedNodes = Object.values(moved.snapshots).flatMap((snapshot) => snapshot.projection.nodes);
    expect(movedNodes.find((node) => node.sessionId === liveNode.sessionId)?.outcome).toBe('done');
    // Only that task's conversation changed: the other live nodes are still active.
    const otherLive = movedNodes.filter((node) => node.sessionId !== liveNode.sessionId && DEMO_SESSIONS.some((session) => session.id === node.sessionId));
    expect(otherLive.length).toBeGreaterThan(0);
    for (const node of otherLive) expect(node.outcome, node.sessionId).toBe(node.taskId === movedTaskId ? 'done' : 'active');
  });

  it('gives a conversation whose task the board lacks no title, number or outcome, and keeps the session\'s own facts', () => {
    const liveNode = seededNodes.find((node) => DEMO_SESSIONS.some((session) => session.id === node.sessionId));
    if (!liveNode) throw new Error('the map draws no live session');
    const orphaned = liftKnowledgeGraphSeed((data) => {
      for (const graph of Object.values(data.knowledgeGraph.projects)) {
        for (const node of graph.projection.nodes) if (node.sessionId === liveNode.sessionId) node.taskId = 'task-not-on-this-board';
      }
    });
    const node = Object.values(orphaned.snapshots).flatMap((snapshot) => snapshot.projection.nodes).find((candidate) => candidate.sessionId === liveNode.sessionId);
    expect(node, 'the orphaned conversation is still drawn').toBeDefined();
    expect(node?.title).toBeNull();
    expect(node?.displayId).toBeNull();
    expect(node?.outcome).toBeNull();
    // The session row still answers for what a session knows: its model and cost.
    const session = DEMO_SESSIONS.find((candidate) => candidate.id === liveNode.sessionId);
    expect(node?.model).toBe(session?.model?.displayName);
    expect(node?.costUsd).toBe(session?.costUsd);
  });

  it('answers for no project the fixture holds no map for, in the snapshots or in the picker', () => {
    const projectIds = projects.map(([projectId]) => projectId);
    // Vacuity: more than one project, so dropping one leaves another to answer for.
    expect(projectIds.length).toBeGreaterThan(1);
    const droppedProjectId = projectIds[0];
    const keptProjectIds = projectIds.filter((projectId) => projectId !== droppedProjectId);
    const without = liftKnowledgeGraphSeed((data) => {
      delete data.knowledgeGraph.projects[droppedProjectId];
    });
    expect(Object.keys(without.snapshots).sort()).toEqual([...keptProjectIds].sort());
    expect(without.projects.map((row) => row.id).sort()).toEqual([...keptProjectIds].sort());
  });
});

describe('demo Knowledge Graph in the seed', () => {
  /** The `data` object a generated seed carries. */
  function seededData(script: string): { knowledgeGraph: { projects: Record<string, Record<string, unknown>> } | null } {
    // `var data = <JSON>;` is one line: JSON.stringify escapes every newline inside a string.
    const dataStart = script.indexOf('var data = ') + 'var data = '.length;
    return JSON.parse(script.slice(dataStart, script.indexOf(';\n', dataStart)));
  }
  const scrollback = Object.fromEntries(DEMO_SESSIONS.map((session) => [session.id, 'recording']));

  it('leaves the maps out of a seed that fetches them, which the web build emits as their own file', () => {
    expect(seededData(buildDemoPreConfig({ scrollback, knowledgeGraph: 'fetched' })).knowledgeGraph).toBeNull();
  });

  it('carries the maps the build would emit when inline, the default, without the capture\'s notes', () => {
    for (const script of [buildDemoPreConfig({ scrollback }), buildDemoPreConfig({ scrollback, knowledgeGraph: 'inline' })]) {
      const carried = seededData(script).knowledgeGraph;
      expect(carried).toEqual(JSON.parse(JSON.stringify(shippedKnowledgeGraph())));
      expect(Object.keys(carried?.projects ?? {}).sort()).toEqual(DEMO_PROJECTS.map((project) => project.id).sort());
      for (const graph of Object.values(carried?.projects ?? {})) expect(Object.keys(graph).sort()).toEqual(['coverage', 'index', 'projection']);
    }
  });

  it('answers the graph through the lazy loader, never through the pre-configure seed', () => {
    const script = buildDemoPreConfig({ scrollback, knowledgeGraph: 'fetched' });
    expect(script).toContain('fetch(recordings.knowledgeGraph)');
    expect(script).not.toContain('knowledgeGraphSnapshotsByProject');
  });
});

describe('demo Knowledge Graph history lookup', () => {
  const CLAUDE_SESSION_ID = '3f2b8c1e-6d4a-4b7e-9c2d-1a5e7f9b0c3d';
  const CODEX_ROLLOUT_ID = '019a3f2e-7b1c-7d4e-8a2f-5c6d7e8f9a0b';
  const REAL_GEMINI_SESSION_ID = '8336f267-33dc-4cd7-8212-b807cb166f76';
  const FIXTURES_DIRECTORY = path.join(REPO_ROOT, 'tests', 'fixtures');
  const temporaryDirectories: string[] = [];

  function makeTemporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-agent-session-id-'));
    temporaryDirectories.push(directory);
    return directory;
  }

  afterAll(() => {
    for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reads a Claude session id from the history file\'s name', () => {
    expect(agentSessionIdOf('claude', `/home/dev/.claude/projects/c--work-contoso-web/${CLAUDE_SESSION_ID}.jsonl`)).toBe(CLAUDE_SESSION_ID);
  });

  it('reads a Codex rollout id from the end of the rollout file\'s name, and refuses a name without one', () => {
    const rolloutDirectory = '/home/dev/.codex/sessions/2026/09/01';
    expect(agentSessionIdOf('codex', `${rolloutDirectory}/rollout-2026-09-01T10-00-00-${CODEX_ROLLOUT_ID}.jsonl`)).toBe(CODEX_ROLLOUT_ID);
    expect(() => agentSessionIdOf('codex', `${rolloutDirectory}/rollout-2026-09-01T10-00-00.jsonl`)).toThrow(TranscriptMatchError);
  });

  it('reads the id a real Codex rollout records for itself, from the name Codex files it under', () => {
    // The real rollout's own session_meta line carries its id and start; Codex names the file
    // rollout-<start, colons as dashes>-<id>.jsonl (the pattern its session history parser matches).
    const realRollout = path.join(FIXTURES_DIRECTORY, 'codex-real-rollout.jsonl');
    const sessionMeta = JSON.parse(fs.readFileSync(realRollout, 'utf-8').split('\n')[0]) as { timestamp: string; payload: { id: string } };
    const startedAt = sessionMeta.timestamp.slice(0, 19).replace(/:/g, '-');
    const filedRollout = path.join(makeTemporaryDirectory(), `rollout-${startedAt}-${sessionMeta.payload.id}.jsonl`);
    fs.copyFileSync(realRollout, filedRollout);

    expect(agentSessionIdOf('codex', filedRollout)).toBe(sessionMeta.payload.id);
  });

  it('reads a Gemini session id from the first line of a .jsonl chat file, not from the whole file', () => {
    const chatFile = path.join(makeTemporaryDirectory(), 'session-2026-06-10T18-32-8336f267.jsonl');
    // A real chat file: a metadata line, then `$set` and message lines that are not one JSON document.
    fs.copyFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'gemini-real-session.jsonl'), chatFile);
    expect(agentSessionIdOf('gemini', chatFile)).toBe(REAL_GEMINI_SESSION_ID);
  });

  it('reads a Gemini session id from a whole-object .json chat file spanning many lines', () => {
    const chatFile = path.join(makeTemporaryDirectory(), 'session-2026-06-10T18-32-a1b2c3d4.json');
    const chat = {
      sessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
      projectHash: '69d89678a773f06a24c7a68033f3c103b6c5e8541f58451b8427c58199a8180d',
      startTime: '2026-06-10T18:32:07.204Z',
      messages: [{ id: 'u1', type: 'user', content: [{ text: 'List the files in this directory.' }] }],
    };
    // Pretty-printed, so a reader that took only the first line would be handed a lone "{".
    fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2));
    expect(agentSessionIdOf('gemini', chatFile)).toBe(chat.sessionId);
  });

  it('refuses a Gemini chat file that carries no session id', () => {
    const directory = makeTemporaryDirectory();
    const withoutId = path.join(directory, 'session-without-id.json');
    fs.writeFileSync(withoutId, JSON.stringify({ projectHash: 'abc', messages: [] }, null, 2));
    expect(() => agentSessionIdOf('gemini', withoutId)).toThrow(TranscriptMatchError);
    const emptyId = path.join(directory, 'session-empty-id.json');
    fs.writeFileSync(emptyId, JSON.stringify({ sessionId: '', messages: [] }));
    expect(() => agentSessionIdOf('gemini', emptyId)).toThrow(TranscriptMatchError);
    // A .jsonl whose first line is not the metadata line, as the real file's second line.
    const firstLineIsMessages = path.join(directory, 'session-messages-first.jsonl');
    fs.writeFileSync(firstLineIsMessages, '{"$set":{"messages":[]}}\n{"sessionId":"a1b2c3d4-0000-4000-8000-000000000002"}\n');
    expect(() => agentSessionIdOf('gemini', firstLineIsMessages)).toThrow(TranscriptMatchError);
  });

  it('reads an OpenCode session row id from after the database path\'s #, and refuses a path without one', () => {
    const databasePath = path.join(os.tmpdir(), 'opencode', 'opencode.db');
    expect(agentSessionIdOf('opencode', `${databasePath}#ses_0f3a9c2d1b7e4Kq8XnLw5vRt2P`)).toBe('ses_0f3a9c2d1b7e4Kq8XnLw5vRt2P');
    expect(() => agentSessionIdOf('opencode', databasePath)).toThrow(TranscriptMatchError);
    expect(() => agentSessionIdOf('opencode', `${databasePath}#`)).toThrow(TranscriptMatchError);
  });

  it('refuses an agent it has no reader for, naming it', () => {
    expect(() => agentSessionIdOf('aider', '/home/dev/.aider.chat.history.md')).toThrow(TranscriptMatchError);
    expect(() => agentSessionIdOf('aider', '/home/dev/.aider.chat.history.md')).toThrow(/aider/);
  });
});
