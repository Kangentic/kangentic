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

  describe('#<number> ticket search', () => {
    // display_ids chosen so prefix matching is observable: #4, #40, #41 share a
    // prefix, #5 does not; #400 is archived so ranking can be checked too.
    const ticketFixtureTasks = [
      { id: 'task-4', display_id: 4, title: 'Exact four', description: 'body of four', archived_at: null },
      { id: 'task-41', display_id: 41, title: 'Forty one', description: '', archived_at: null },
      { id: 'task-40', display_id: 40, title: 'Forty', description: '', archived_at: null },
      { id: 'task-5', display_id: 5, title: 'Five is unrelated', description: '', archived_at: null },
      { id: 'task-400', display_id: 400, title: 'Archived four hundred', description: '', archived_at: '2026-04-15T00:00:00Z' },
    ];

    it('matches board tasks by display_id prefix and returns only task hits', async () => {
      const project = makeProject({ path: tempProjectRoot });
      const fixture: FakeProjectFixture = {
        project,
        tasks: ticketFixtureTasks,
        backlog: [{ id: 'backlog-4', title: 'has a 4 in it', description: '#4 mentioned' }],
        sessions: [],
      };
      const db = makeMockDb(fixture);

      const hits = await runSearchEverything({
        query: '#4',
        projects: [project],
        includeProjectHits: true,
        projectsForProjectHits: [project, makeProject({ id: '99999999-9999-4999-8999-999999999999', name: 'project-4', path: '/tmp/p4' })],
        getDb: () => db,
      });

      // Only task hits: no backlog / project / session / conversation kinds.
      expect(hits.every((hit) => hit.kind === 'task')).toBe(true);
      const matchedIds = hits.map((hit) => (hit.kind === 'task' ? hit.displayId : -1));
      // #4, #40, #41, #400 match the "4" prefix; #5 does not.
      expect(matchedIds).toEqual([4, 40, 41, 400]);
    });

    it('ranks non-archived first, then the exact match, then prefixes ascending', async () => {
      const project = makeProject({ path: tempProjectRoot });
      const fixture: FakeProjectFixture = { project, tasks: ticketFixtureTasks, backlog: [], sessions: [] };
      const db = makeMockDb(fixture);

      const hits = await runSearchEverything({
        query: '#4',
        projects: [project],
        includeProjectHits: false,
        getDb: () => db,
      });

      const order = hits.map((hit) => (hit.kind === 'task' ? hit.displayId : -1));
      // #4 (exact, non-archived) first, then #40 and #41 ascending, then the
      // archived #400 last.
      expect(order).toEqual([4, 40, 41, 400]);
      const exact = hits[0];
      if (exact.kind === 'task') {
        // A ticket hit renders plain: zero-width match, snippet is the title.
        expect(exact.snippetField).toBe('title');
        expect(exact.matchStart).toBe(exact.matchEnd);
        expect(exact.snippet).toContain('Exact four');
        expect(exact.archived).toBe(false);
      }
      const archived = hits[hits.length - 1];
      if (archived.kind === 'task') {
        expect(archived.displayId).toBe(400);
        expect(archived.archived).toBe(true);
      }
    });

    it('ranks the archived tiebreak last even when the archived match has a smaller display_id', async () => {
      // ticketFixtureTasks above is NOT discriminating for the archived tiebreak:
      // its only archived match (#400) is also the numerically LARGEST match, so
      // plain ascending order already puts it last - deleting the
      // `firstArchived`/`secondArchived` comparator lines entirely still yields
      // [4, 40, 41, 400]. This fixture flips that: the archived match (#40) is
      // numerically SMALLER than a non-archived match sharing the same prefix
      // (#41), so only the archived-last tiebreak (not ascending display_id) can
      // produce the expected order. The fixture's input order is also scrambled
      // (#40 first, not last) so a hypothetical "sort removed entirely" mutation
      // does not vacuously pass by matching input order.
      const archivedTiebreakFixtureTasks = [
        { id: 'task-tiebreak-40', display_id: 40, title: 'Forty, archived', description: '', archived_at: '2026-04-15T00:00:00Z' },
        { id: 'task-tiebreak-4', display_id: 4, title: 'Exact four', description: '', archived_at: null },
        { id: 'task-tiebreak-41', display_id: 41, title: 'Forty one, still active', description: '', archived_at: null },
      ];
      const project = makeProject({ path: tempProjectRoot });
      const fixture: FakeProjectFixture = { project, tasks: archivedTiebreakFixtureTasks, backlog: [], sessions: [] };
      const db = makeMockDb(fixture);

      const hits = await runSearchEverything({
        query: '#4',
        projects: [project],
        includeProjectHits: false,
        getDb: () => db,
      });

      const order = hits.map((hit) => (hit.kind === 'task' ? hit.displayId : -1));
      // Correct comparator: non-archived first (#4 exact, then #41 ascending),
      // archived last (#40). A reverted comparator (no archived tiebreak, plain
      // exact-then-ascending) would instead yield [4, 40, 41] - #40 sorting
      // before #41 purely on numeric value - which is what this test catches.
      expect(order).toEqual([4, 41, 40]);
      const archivedHit = hits[hits.length - 1];
      if (archivedHit.kind === 'task') {
        expect(archivedHit.displayId).toBe(40);
        expect(archivedHit.archived).toBe(true);
      }
    });

    it('collects ticket hits from multiple projects for a #<digits> query', async () => {
      // Mirrors "collects hits from multiple projects under scope=all" above but
      // for the ticket short-circuit path in runSearchEverything. Every existing
      // ticket test above passes projects: [project] (a single project), so
      // nothing exercises the `for (const project of input.projects)` loop in
      // the ticket branch; a regression that only scanned input.projects[0]
      // would still pass every prior ticket test.
      const ticketProjectAlphaRoot = path.join(tempProjectRoot, 'ticket-alpha');
      const ticketProjectBetaRoot = path.join(tempProjectRoot, 'ticket-beta');
      fs.mkdirSync(ticketProjectAlphaRoot, { recursive: true });
      fs.mkdirSync(ticketProjectBetaRoot, { recursive: true });

      const ticketProjectAlpha = makeProject({
        id: '55555555-5555-4555-8555-555555555555',
        name: 'TicketAlpha',
        path: ticketProjectAlphaRoot,
      });
      const ticketProjectBeta = makeProject({
        id: '66666666-6666-4666-8666-666666666666',
        name: 'TicketBeta',
        path: ticketProjectBetaRoot,
      });

      const ticketAlphaFixture: FakeProjectFixture = {
        project: ticketProjectAlpha,
        tasks: [{ id: 'task-alpha-4', display_id: 4, title: 'Alpha four', description: '', archived_at: null }],
        backlog: [],
        sessions: [],
      };
      const ticketBetaFixture: FakeProjectFixture = {
        project: ticketProjectBeta,
        tasks: [{ id: 'task-beta-41', display_id: 41, title: 'Beta forty one', description: '', archived_at: null }],
        backlog: [],
        sessions: [],
      };
      const ticketAlphaDb = makeMockDb(ticketAlphaFixture);
      const ticketBetaDb = makeMockDb(ticketBetaFixture);

      const hits = await runSearchEverything({
        query: '#4',
        projects: [ticketProjectAlpha, ticketProjectBeta],
        includeProjectHits: false,
        getDb: (projectId: string) => {
          if (projectId === ticketProjectAlpha.id) return ticketAlphaDb;
          return ticketBetaDb;
        },
      });

      const taskHits = hits.filter((hit) => hit.kind === 'task');
      expect(taskHits.length).toBe(2);
      const projectIds = taskHits.map((hit) => hit.projectId).sort();
      expect(projectIds).toEqual([ticketProjectAlpha.id, ticketProjectBeta.id].sort());
    });

    it('shares the task budget across projects for a ticket query, so project order decides who survives the cap', async () => {
      // Mirrors "stops collecting ticket hits once the per-kind budget is
      // exhausted" above, but with TWO projects, to prove the budget is a
      // SINGLE shared counter threaded across the `for (const project of
      // input.projects)` loop, not one budget.task allowance re-granted per
      // project. If pushTaskHitsByDisplayId were (incorrectly) called with a
      // fresh copy of the budget per project, project Beta's task would still
      // appear even after project Alpha alone exhausts PER_KIND_CAP.task; under
      // the correct shared-budget behavior it must not.
      const { PER_KIND_CAP } = await import('../../src/main/search/search-core');
      const budgetProjectAlphaRoot = path.join(tempProjectRoot, 'budget-alpha');
      const budgetProjectBetaRoot = path.join(tempProjectRoot, 'budget-beta');
      fs.mkdirSync(budgetProjectAlphaRoot, { recursive: true });
      fs.mkdirSync(budgetProjectBetaRoot, { recursive: true });

      const budgetProjectAlpha = makeProject({
        id: '77777777-7777-4777-8777-777777777777',
        name: 'BudgetAlpha',
        path: budgetProjectAlphaRoot,
      });
      const budgetProjectBeta = makeProject({
        id: '88888888-8888-4888-8888-888888888888',
        name: 'BudgetBeta',
        path: budgetProjectBetaRoot,
      });

      const taskCount = PER_KIND_CAP.task + 5;
      // All display_ids are in the 1000s range so every one matches the "#1"
      // query prefix, and none equals exactValue (1), so the sort stays plain
      // ascending within project Alpha's fixture.
      const budgetAlphaTasks = Array.from({ length: taskCount }, (_, index) => ({
        id: `alpha-ticket-budget-${index}`,
        display_id: 1000 + index,
        title: `alpha ticket budget task ${index}`,
        description: '',
        archived_at: null,
      }));
      const budgetBetaTasks = [
        { id: 'beta-ticket-budget-0', display_id: 1999, title: 'beta ticket budget task', description: '', archived_at: null },
      ];

      const budgetAlphaFixture: FakeProjectFixture = { project: budgetProjectAlpha, tasks: budgetAlphaTasks, backlog: [], sessions: [] };
      const budgetBetaFixture: FakeProjectFixture = { project: budgetProjectBeta, tasks: budgetBetaTasks, backlog: [], sessions: [] };
      const budgetAlphaDb = makeMockDb(budgetAlphaFixture);
      const budgetBetaDb = makeMockDb(budgetBetaFixture);

      const getDb = (projectId: string) => {
        if (projectId === budgetProjectAlpha.id) return budgetAlphaDb;
        return budgetBetaDb;
      };

      const hits = await runSearchEverything({
        query: '#1',
        projects: [budgetProjectAlpha, budgetProjectBeta],
        includeProjectHits: false,
        getDb,
      });

      const taskHits = hits.filter((hit) => hit.kind === 'task');
      expect(taskHits.length).toBe(PER_KIND_CAP.task);
      // Every surviving hit came from project Alpha; the shared budget hit zero
      // before project Beta's turn in the loop, so Beta contributes nothing
      // despite its own task also matching the "#1" prefix.
      expect(taskHits.every((hit) => hit.kind === 'task' && hit.projectId === budgetProjectAlpha.id)).toBe(true);

      // Vacuous-pass guard: confirm project Beta's task DOES match the "#1"
      // prefix on its own (isolated from Alpha's budget pressure), so the
      // "Beta contributes nothing" assertion above is actually proving the
      // shared budget, not just a fixture that never matched in the first place.
      const betaOnlyHits = await runSearchEverything({
        query: '#1',
        projects: [budgetProjectBeta],
        includeProjectHits: false,
        getDb,
      });
      const betaOnlyTaskHits = betaOnlyHits.filter((hit) => hit.kind === 'task');
      expect(betaOnlyTaskHits.length).toBe(1);
    });

    it('returns no hits when no display_id matches the prefix', async () => {
      const project = makeProject({ path: tempProjectRoot });
      const fixture: FakeProjectFixture = { project, tasks: ticketFixtureTasks, backlog: [], sessions: [] };
      const db = makeMockDb(fixture);

      const hits = await runSearchEverything({
        query: '#9',
        projects: [project],
        includeProjectHits: false,
        getDb: () => db,
      });

      expect(hits).toEqual([]);
    });

    it('does not treat a bare number (no "#") as a ticket query', async () => {
      const project = makeProject({ path: tempProjectRoot });
      const fixture: FakeProjectFixture = {
        project,
        // Title contains "4" so the text path would match it; the ticket path
        // would instead match by display_id. Assert we took the text path.
        tasks: [{ id: 'task-x', display_id: 77, title: 'contains a 4 here', description: '', archived_at: null }],
        backlog: [],
        sessions: [],
      };
      const db = makeMockDb(fixture);

      const hits = await runSearchEverything({
        query: '4',
        projects: [project],
        includeProjectHits: false,
        getDb: () => db,
      });

      const taskHits = hits.filter((hit) => hit.kind === 'task');
      expect(taskHits).toHaveLength(1);
      // Matched by text (the "4" in the title), not by display_id 77.
      if (taskHits[0].kind === 'task') {
        expect(taskHits[0].displayId).toBe(77);
        expect(taskHits[0].matchEnd).toBeGreaterThan(taskHits[0].matchStart);
      }
    });

    it('stops collecting ticket hits once the per-kind budget is exhausted', async () => {
      // Mirrors "stops collecting task hits..." above, but for the ticket
      // lookup path: pushTaskHitsByDisplayId has its own budget-check loop
      // (separate from pushTaskHits), so the text-search budget test does not
      // exercise it.
      const { PER_KIND_CAP } = await import('../../src/main/search/search-core');
      const taskCount = PER_KIND_CAP.task + 5;
      // display_ids 1000..1000+taskCount-1 are all in the 1000s range, so
      // every one starts with "1" and matches the "#1" query.
      const tasks = Array.from({ length: taskCount }, (_, index) => ({
        id: `ticket-budget-${index}`,
        display_id: 1000 + index,
        title: `ticket budget task ${index}`,
        description: '',
        archived_at: null,
      }));
      const project = makeProject({ path: tempProjectRoot });
      const fixture: FakeProjectFixture = { project, tasks, backlog: [], sessions: [] };
      const db = makeMockDb(fixture);

      const hits = await runSearchEverything({
        query: '#1',
        projects: [project],
        includeProjectHits: false,
        getDb: () => db,
      });

      const taskHits = hits.filter((hit) => hit.kind === 'task');
      expect(taskHits.length).toBe(PER_KIND_CAP.task);
    });
  });
});
