import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { runSearchEverything } from '../../src/main/search/search-core';
import type { Project } from '../../src/shared/types';

/**
 * Tests for the unified search core (`runSearchEverything`).
 *
 * better-sqlite3 is compiled for Electron's Node ABI and cannot load
 * under vitest's system Node, so the DB is mocked via a hand-rolled
 * `prepare(sql).all()` shim that recognises the exact SQL strings the
 * search core emits. The events.jsonl scan path uses real fs+readline
 * so the test writes a real temp file at the layout the core expects:
 * `<projectPath>/.kangentic/sessions/<sessionId>/events.jsonl`.
 */

interface FakeProjectFixture {
  project: Project;
  tasks: Array<{ id: string; display_id: number; title: string; description: string; archived_at: string | null }>;
  backlog: Array<{ id: string; title: string; description: string }>;
  sessions: Array<{ id: string; task_id: string; session_type: string; started_at: string }>;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    name: overrides.name ?? 'TestProject',
    path: overrides.path ?? '/tmp/test-project',
    github_url: overrides.github_url ?? null,
    default_agent: overrides.default_agent ?? 'claude',
    group_id: overrides.group_id ?? null,
    position: overrides.position ?? 0,
    last_opened: overrides.last_opened ?? '2026-05-01T00:00:00Z',
    created_at: overrides.created_at ?? '2026-04-01T00:00:00Z',
  };
}

function makeMockDb(fixture: FakeProjectFixture): Database.Database {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('FROM tasks') && sql.includes('display_id, title, description, archived_at')) {
        return { all: vi.fn(() => fixture.tasks) };
      }
      if (sql.includes('FROM backlog_tasks')) {
        return { all: vi.fn(() => fixture.backlog) };
      }
      if (sql.includes('FROM sessions') && sql.includes('session_type')) {
        return { all: vi.fn(() => fixture.sessions) };
      }
      if (sql.includes('SELECT id, title FROM tasks')) {
        return { all: vi.fn(() => fixture.tasks.map((task) => ({ id: task.id, title: task.title }))) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  } as unknown as Database.Database;
}

/**
 * A mock DB that ALSO answers the conversation-memory prepares
 * (`searchConversationMemory`): the FTS MATCH query, the getChunks IN-clause,
 * and the per-chunk task-title / session-type hydration gets. Board tables are
 * empty so the only hits produced are conversation hits, isolating the new
 * `kind: 'conversation'` path.
 *
 * `liveSessionIds` scripts the liveness query the search core runs to compute
 * `sessionActive` (`SELECT id FROM sessions WHERE status IN ('running',
 * 'queued')`); defaults to none live, so `session-conv` is not live unless the
 * caller opts it in.
 */
function makeConversationMockDb(liveSessionIds: string[] = []): Database.Database {
  const lexicalRows = [{ id: 501, snip: 'a frobnicate hit…', score: -2.5 }];
  const chunkRow = {
    id: 501,
    corpus: 'conversation',
    doc_id: 'session-conv',
    seq: 3,
    session_id: 'session-conv',
    task_id: 'task-conv',
    agent_session_id: 'agent-xyz',
    role: 'assistant',
    text: 'discussion about frobnicate internals',
    content_hash: 'hc',
    token_estimate: 20,
    ts_start: 1717000000000,
    ts_end: 1717000001000,
    turn_uuid_start: 'turn-uuid-777',
    turn_uuid_end: 'turn-uuid-777',
    embedded_model: null,
  };
  return {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => {
        if (sql.includes('display_id, title, description, archived_at')) return [];
        if (sql.includes('FROM backlog_tasks')) return [];
        if (sql.includes('session_type, started_at FROM sessions')) return [];
        if (sql.includes('memory_chunks_fts') && sql.includes('MATCH')) return lexicalRows;
        if (sql.includes('FROM memory_chunks') && sql.includes('id IN')) return [chunkRow];
        if (sql.includes('SELECT id FROM sessions') && sql.includes('status IN')) {
          return liveSessionIds.map((id) => ({ id }));
        }
        throw new Error(`unexpected all SQL: ${sql}`);
      }),
      get: vi.fn(() => {
        if (sql.includes('SELECT title FROM tasks WHERE id')) return { title: 'Frobnicate Conversation Task' };
        if (sql.includes('SELECT session_type FROM sessions WHERE id')) return { session_type: 'kangentic_test_agent' };
        throw new Error(`unexpected get SQL: ${sql}`);
      }),
    })),
  } as unknown as Database.Database;
}

describe('runSearchEverything', () => {
  let tempProjectRoot: string;

  beforeEach(() => {
    tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'search-everything-'));
  });

  afterEach(() => {
    fs.rmSync(tempProjectRoot, { recursive: true, force: true });
  });

  it('returns an empty array for an empty query', async () => {
    const project = makeProject({ path: tempProjectRoot });
    const fixture: FakeProjectFixture = { project, tasks: [], backlog: [], sessions: [] };
    const db = makeMockDb(fixture);

    const hits = await runSearchEverything({
      query: '   ',
      projects: [project],
      includeProjectHits: true,
      getDb: () => db,
    });

    expect(hits).toEqual([]);
  });

  it('returns title-prioritized task hits, backlog hits, session-event hits, and project hits when scope widens', async () => {
    const project = makeProject({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'KangenticDemo',
      path: tempProjectRoot,
    });
    const fixture: FakeProjectFixture = {
      project,
      tasks: [
        { id: 'task-A', display_id: 1, title: 'Frobnicate the widget', description: 'unrelated body', archived_at: null },
        { id: 'task-B', display_id: 2, title: 'Unrelated heading', description: 'frobnicate is mentioned here', archived_at: null },
        { id: 'task-C', display_id: 3, title: 'Old frobnicate task', description: '', archived_at: '2026-04-15T00:00:00Z' },
      ],
      backlog: [
        { id: 'backlog-1', title: 'Frobnicate later', description: '' },
      ],
      sessions: [
        { id: 'session-X', task_id: 'task-A', session_type: 'claude_agent', started_at: '2026-05-01T00:00:00Z' },
      ],
    };
    const db = makeMockDb(fixture);

    const sessionDir = path.join(tempProjectRoot, '.kangentic', 'sessions', 'session-X');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'events.jsonl'),
      [
        JSON.stringify({ ts: 1000, type: 'tool_start', tool: 'Bash', detail: 'frobnicate --help' }),
        JSON.stringify({ ts: 1100, type: 'tool_start', tool: 'Read', detail: 'irrelevant content' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const hits = await runSearchEverything({
      query: 'frobnicate',
      projects: [project],
      includeProjectHits: true,
      projectsForProjectHits: [project, makeProject({ id: '22222222-2222-4222-8222-222222222222', name: 'frobnicate-toolkit', path: '/tmp/other' })],
      getDb: () => db,
    });

    const taskHits = hits.filter((hit) => hit.kind === 'task');
    const backlogHits = hits.filter((hit) => hit.kind === 'backlog');
    const sessionEventHits = hits.filter((hit) => hit.kind === 'session_event');
    const projectHits = hits.filter((hit) => hit.kind === 'project');

    expect(taskHits.length).toBe(3);
    if (taskHits[0].kind === 'task') {
      expect(taskHits[0].snippetField).toBe('title');
    }
    if (taskHits[1].kind === 'task') {
      expect(taskHits[1].snippetField).toBe('title');
    }
    if (taskHits[2].kind === 'task') {
      expect(taskHits[2].snippetField).toBe('description');
    }

    expect(backlogHits.length).toBe(1);
    if (backlogHits[0].kind === 'backlog') {
      expect(backlogHits[0].backlogTitle).toBe('Frobnicate later');
    }

    expect(sessionEventHits.length).toBe(1);
    if (sessionEventHits[0].kind === 'session_event') {
      expect(sessionEventHits[0].sessionId).toBe('session-X');
      expect(sessionEventHits[0].snippet).toContain('frobnicate');
    }

    expect(projectHits.length).toBe(1);
    if (projectHits[0].kind === 'project') {
      expect(projectHits[0].projectName).toBe('frobnicate-toolkit');
    }
  });

  it('omits project hits when includeProjectHits is false', async () => {
    const project = makeProject({ name: 'frobnicate-app', path: tempProjectRoot });
    const fixture: FakeProjectFixture = { project, tasks: [], backlog: [], sessions: [] };
    const db = makeMockDb(fixture);

    const hits = await runSearchEverything({
      query: 'frobnicate',
      projects: [project],
      includeProjectHits: false,
      getDb: () => db,
    });

    expect(hits.filter((hit) => hit.kind === 'project')).toEqual([]);
  });

  it('handles missing events.jsonl silently (fresh session, no events file yet)', async () => {
    const project = makeProject({ path: tempProjectRoot });
    const fixture: FakeProjectFixture = {
      project,
      tasks: [],
      backlog: [],
      sessions: [
        { id: 'session-empty', task_id: 'task-X', session_type: 'claude_agent', started_at: '2026-05-01T00:00:00Z' },
      ],
    };
    const db = makeMockDb(fixture);

    const hits = await runSearchEverything({
      query: 'anything',
      projects: [project],
      includeProjectHits: false,
      getDb: () => db,
    });

    expect(hits).toEqual([]);
  });

  it('returns an empty array when given an empty projects list', async () => {
    // Covers the Promise.all([]) path - no projects means no DB calls, no
    // event scans, and the result must be empty without throwing.
    const hits = await runSearchEverything({
      query: 'anything',
      projects: [],
      includeProjectHits: false,
      getDb: () => { throw new Error('should not be called'); },
    });

    expect(hits).toEqual([]);
  });

  it('defaults projectsForProjectHits to the projects list when omitted', async () => {
    // Passing `includeProjectHits: true` and omitting `projectsForProjectHits`
    // should match against the same projects array (the default). Confirm a
    // project-name match is found even without the explicit override field.
    const project = makeProject({ name: 'matchable-project', path: tempProjectRoot });
    const fixture: FakeProjectFixture = { project, tasks: [], backlog: [], sessions: [] };
    const db = makeMockDb(fixture);

    const hits = await runSearchEverything({
      query: 'matchable',
      projects: [project],
      includeProjectHits: true,
      // intentionally omit projectsForProjectHits
      getDb: () => db,
    });

    const projectHits = hits.filter((hit) => hit.kind === 'project');
    expect(projectHits.length).toBe(1);
    if (projectHits[0].kind === 'project') {
      expect(projectHits[0].projectName).toBe('matchable-project');
    }
  });

  it('swallows pushSessionEventHits errors and continues to the next project', async () => {
    // Covers the console.warn + continue branch in the Promise.all error handler.
    // The first project's getDb throws during the session query; the second
    // project must still produce task hits.
    const failingProject = makeProject({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'FailingProject',
      path: path.join(tempProjectRoot, 'failing'),
    });
    const goodProjectRoot = path.join(tempProjectRoot, 'good');
    fs.mkdirSync(goodProjectRoot, { recursive: true });
    const goodProject = makeProject({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'GoodProject',
      path: goodProjectRoot,
    });

    const goodFixture: FakeProjectFixture = {
      project: goodProject,
      tasks: [
        { id: 'task-good', display_id: 1, title: 'target-term result', description: '', archived_at: null },
      ],
      backlog: [],
      sessions: [
        { id: 'session-good', task_id: 'task-good', session_type: 'claude_agent', started_at: '2026-05-01T00:00:00Z' },
      ],
    };
    const goodDb = makeMockDb(goodFixture);

    // The failing project's DB throws when the sessions query runs.
    const failingDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('FROM tasks') && sql.includes('display_id')) {
          return { all: vi.fn(() => []) };
        }
        if (sql.includes('FROM backlog_tasks')) {
          return { all: vi.fn(() => []) };
        }
        // Sessions query (reached during pushSessionEventHits) throws.
        throw new Error('simulated DB failure');
      }),
    } as unknown as Database.Database;

    const hits = await runSearchEverything({
      query: 'target-term',
      projects: [failingProject, goodProject],
      includeProjectHits: false,
      getDb: (projectId: string) => {
        if (projectId === failingProject.id) return failingDb;
        return goodDb;
      },
    });

    // The failing project error must be swallowed; the good project's task hit
    // must still appear.
    const taskHits = hits.filter((hit) => hit.kind === 'task');
    expect(taskHits.length).toBeGreaterThanOrEqual(1);
    expect(taskHits.some((hit) => hit.kind === 'task' && hit.taskTitle === 'target-term result')).toBe(true);
  });

  it('collects hits from multiple projects under scope=all', async () => {
    // Covers the multi-project Promise.all path. Two separate projects each
    // have one matching task; both must appear in the result.
    const projectAlphaRoot = path.join(tempProjectRoot, 'alpha');
    const projectBetaRoot = path.join(tempProjectRoot, 'beta');
    fs.mkdirSync(projectAlphaRoot, { recursive: true });
    fs.mkdirSync(projectBetaRoot, { recursive: true });

    const projectAlpha = makeProject({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Alpha',
      path: projectAlphaRoot,
    });
    const projectBeta = makeProject({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: 'Beta',
      path: projectBetaRoot,
    });

    const alphaFixture: FakeProjectFixture = {
      project: projectAlpha,
      tasks: [{ id: 'task-alpha', display_id: 1, title: 'shared-keyword in alpha', description: '', archived_at: null }],
      backlog: [],
      sessions: [],
    };
    const betaFixture: FakeProjectFixture = {
      project: projectBeta,
      tasks: [{ id: 'task-beta', display_id: 2, title: 'shared-keyword in beta', description: '', archived_at: null }],
      backlog: [],
      sessions: [],
    };

    const alphaDb = makeMockDb(alphaFixture);
    const betaDb = makeMockDb(betaFixture);

    const hits = await runSearchEverything({
      query: 'shared-keyword',
      projects: [projectAlpha, projectBeta],
      includeProjectHits: false,
      getDb: (projectId: string) => {
        if (projectId === projectAlpha.id) return alphaDb;
        return betaDb;
      },
    });

    const taskHits = hits.filter((hit) => hit.kind === 'task');
    expect(taskHits.length).toBe(2);
    const projectIds = taskHits.map((hit) => hit.projectId).sort();
    expect(projectIds).toEqual([projectAlpha.id, projectBeta.id].sort());
  });

  it('stops collecting task hits once the per-kind budget is exhausted', async () => {
    // Generates PER_KIND_CAP.task + 5 matching rows and verifies the result
    // contains exactly PER_KIND_CAP.task hits (no over-shoot).
    const { PER_KIND_CAP } = await import('../../src/main/search/search-core');
    const taskCount = PER_KIND_CAP.task + 5;
    const tasks = Array.from({ length: taskCount }, (_, index) => ({
      id: `task-${index}`,
      display_id: index + 1,
      title: `budget-test task ${index + 1}`,
      description: '',
      archived_at: null,
    }));
    const project = makeProject({ path: tempProjectRoot });
    const fixture: FakeProjectFixture = { project, tasks, backlog: [], sessions: [] };
    const db = makeMockDb(fixture);

    const hits = await runSearchEverything({
      query: 'budget-test',
      projects: [project],
      includeProjectHits: false,
      getDb: () => db,
    });

    const taskHits = hits.filter((hit) => hit.kind === 'task');
    expect(taskHits.length).toBe(PER_KIND_CAP.task);
  });

  it('returns no session-event hits when the project has zero sessions', async () => {
    // Covers the `if (sessions.length === 0) return;` early-exit in
    // pushSessionEventHits without relying on a missing events.jsonl file.
    const project = makeProject({ path: tempProjectRoot });
    const fixture: FakeProjectFixture = {
      project,
      tasks: [],
      backlog: [],
      sessions: [], // explicitly empty - no sessions row at all
    };
    const db = makeMockDb(fixture);

    const hits = await runSearchEverything({
      query: 'zero-sessions',
      projects: [project],
      includeProjectHits: false,
      getDb: () => db,
    });

    expect(hits.filter((hit) => hit.kind === 'session_event')).toEqual([]);
  });

  it('surfaces a kind: "conversation" hit when conversationSearch is enabled', async () => {
    const project = makeProject({ path: tempProjectRoot });
    const db = makeConversationMockDb();

    const hits = await runSearchEverything({
      query: 'frobnicate',
      projects: [project],
      includeProjectHits: false,
      getDb: () => db,
      conversationSearch: { enabled: true },
    });

    const conversationHits = hits.filter((hit) => hit.kind === 'conversation');
    expect(conversationHits).toHaveLength(1);
    const hit = conversationHits[0];
    if (hit.kind === 'conversation') {
      expect(hit.projectId).toBe(project.id);
      expect(hit.sessionId).toBe('session-conv');
      expect(hit.taskId).toBe('task-conv');
      expect(hit.taskTitle).toBe('Frobnicate Conversation Task');
      // Unknown session_type falls back to the raw value deterministically.
      expect(hit.agentName).toBe('kangentic_test_agent');
      expect(hit.chunkId).toBe(501);
      expect(hit.turnUuid).toBe('turn-uuid-777');
      expect(hit.turnKind).toBe('assistant');
      expect(hit.turnTs).toBe(1717000000000);
      expect(hit.matchKind).toBe('lexical');
      expect(hit.snippet).toContain('frobnicate');
      // Phase-1 RRF score for a single lexical rank-1 hit: 1/(60+1).
      expect(hit.score).toBeCloseTo(1 / 61, 12);
      // No live session was scripted, so the hit's session is not active.
      expect(hit.sessionActive).toBe(false);
    }
  });

  it('marks a conversation hit sessionActive when its session is running or queued', async () => {
    // Same fixture as above, but this time the liveness query
    // (`SELECT id FROM sessions WHERE status IN (...)`) reports session-conv
    // as live. A hardcoded sessionActive constant (true or false) would fail
    // one of this test and its sibling above.
    const project = makeProject({ path: tempProjectRoot });
    const db = makeConversationMockDb(['session-conv']);

    const hits = await runSearchEverything({
      query: 'frobnicate',
      projects: [project],
      includeProjectHits: false,
      getDb: () => db,
      conversationSearch: { enabled: true },
    });

    const conversationHits = hits.filter((hit) => hit.kind === 'conversation');
    expect(conversationHits).toHaveLength(1);
    const hit = conversationHits[0];
    if (hit.kind === 'conversation') {
      expect(hit.sessionId).toBe('session-conv');
      expect(hit.sessionActive).toBe(true);
    }
  });

  it('produces no conversation hits (and does not touch the memory index) when conversationSearch is omitted', async () => {
    // Same conversation-capable DB, but without conversationSearch the memory
    // path never runs, so behaviour matches the pre-feature contract exactly.
    const project = makeProject({ path: tempProjectRoot });
    const db = makeConversationMockDb();

    const hits = await runSearchEverything({
      query: 'frobnicate',
      projects: [project],
      includeProjectHits: false,
      getDb: () => db,
      // conversationSearch intentionally omitted.
    });

    expect(hits.filter((hit) => hit.kind === 'conversation')).toEqual([]);
    // Board tables are empty, so with the feature off the whole result is empty.
    expect(hits).toEqual([]);
  });
});
