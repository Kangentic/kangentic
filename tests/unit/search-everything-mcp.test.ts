import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../../src/shared/types';
import type { Embedder } from '../../src/main/retrieval/types';

/**
 * Tests for the kangentic_search MCP tool wrapper.
 *
 * Strategy: stub the search-core so the test focuses on routing - which
 * projects get scanned, whether project hits are enabled, how scope
 * interacts with the explicit `project` selector, and the response
 * formatting. Core search behaviour itself is covered by
 * search-everything-core.test.ts.
 */

const { mockRunSearchEverything } = vi.hoisted(() => ({
  mockRunSearchEverything: vi.fn(async () => []),
}));

vi.mock('../../src/main/search/search-core', () => ({
  runSearchEverything: mockRunSearchEverything,
}));

// groupBy:"task" and relatedToTask rank through the related-work rollup, which
// is tested where it lives; here only the routing and the formatting are. The
// module is mocked partially, so a constant it exports (PASSAGES_SHOWN) stays
// the real one.
const {
  mockSearchRelatedWork,
  mockIndexedConversationNodes,
  mockBoardRecordTasks,
  mockReadBoardTaskFacts,
} = vi.hoisted(() => ({
  mockSearchRelatedWork: vi.fn(),
  mockIndexedConversationNodes: vi.fn(() => [] as unknown[]),
  mockBoardRecordTasks: vi.fn(() => [] as unknown[]),
  mockReadBoardTaskFacts: vi.fn(() => [] as unknown[]),
}));

vi.mock('../../src/main/retrieval/related-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/retrieval/related-work')>();
  return {
    ...actual,
    searchRelatedWork: mockSearchRelatedWork,
    indexedConversationNodes: mockIndexedConversationNodes,
    boardRecordTasks: mockBoardRecordTasks,
    readBoardTaskFacts: mockReadBoardTaskFacts,
  };
});

// The rest of what the tool reads from a project: its database, the task
// lookup, the commit search and the written summaries. Each has its own tests.
const {
  mockGetProjectDb,
  mockGetByDisplayId,
  mockGetById,
  mockSearchCommits,
  mockSummariesFor,
} = vi.hoisted(() => ({
  mockGetProjectDb: vi.fn((projectId: string): unknown => ({ projectId })),
  mockGetByDisplayId: vi.fn(),
  mockGetById: vi.fn(),
  mockSearchCommits: vi.fn(() => [] as unknown[]),
  mockSummariesFor: vi.fn(() => new Map<string, string>()),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: mockGetProjectDb }));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getByDisplayId = mockGetByDisplayId;
    getById = mockGetById;
  },
}));

vi.mock('../../src/main/retrieval/commit/commit-search', () => ({ searchCommits: mockSearchCommits }));

vi.mock('../../src/main/retrieval/summary/summary-store', () => ({
  SummaryStore: class {
    summariesFor = mockSummariesFor;
  },
}));

// The index reads run in the retrieval worker. Here a call goes straight to
// the worker's own handlers, in process, so the module mocks above stand in
// for the index behind them exactly as they did before the move.
vi.mock('../../src/main/retrieval/retrieval-client', async () => {
  const { retrievalHandlers } = await import('../../src/main/retrieval/worker/methods');
  const context = { getDb: mockGetProjectDb, closeDb: () => undefined, emit: () => undefined };
  return {
    RetrievalUnavailableError: class RetrievalUnavailableError extends Error {},
    retrievalClient: {
      call: async (method: keyof typeof retrievalHandlers, params: unknown) => (
        (retrievalHandlers[method] as (params: unknown, handlerContext: unknown) => unknown)(params, context)
      ),
    },
  };
});

import {
  factsInline,
  formatRankedTasksForAgents,
  RANKED_TASKS_RESPONSE_CHARS,
  RELATED_TO_TASK_ROWS,
  registerSearchTools,
  searchArgumentRefusal,
} from '../../src/main/agent/mcp-http/search-tools';
import { retrievalClient, RetrievalUnavailableError } from '../../src/main/retrieval/retrieval-client';
import { INDEX_RESTARTING } from '../../src/main/retrieval/retrieval-queries';
import { PASSAGES_SHOWN, type RelatedWorkTask } from '../../src/main/retrieval/related-work';
import { ANSWER_SEARCH_BUDGET, watchAnswerSearches } from '../../src/main/agent/mcp-http/answer-search-trace';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { BoardTaskFacts } from '../../src/main/retrieval/answer-tasks';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    name: overrides.name ?? 'Default',
    path: overrides.path ?? '/tmp/default',
    github_url: overrides.github_url ?? null,
    default_agent: overrides.default_agent ?? 'claude',
    group_id: overrides.group_id ?? null,
    position: overrides.position ?? 0,
    last_opened: overrides.last_opened ?? '2026-05-01T00:00:00Z',
    created_at: overrides.created_at ?? '2026-04-01T00:00:00Z',
  };
}

type AnyToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function makeFakeServer() {
  const handlers: Record<string, AnyToolHandler> = {};
  const configs: Record<string, { description?: string }> = {};
  return {
    registerTool: vi.fn((name: string, config: { description?: string }, handler: AnyToolHandler) => {
      handlers[name] = handler;
      configs[name] = config;
    }),
    getHandler(name: string): AnyToolHandler {
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler;
    },
    getConfig(name: string): { description?: string } {
      const config = configs[name];
      if (!config) throw new Error(`Tool "${name}" was not registered`);
      return config;
    },
  };
}

const DEFAULT_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const DEFAULT_PROJECT = makeProject({ id: DEFAULT_PROJECT_ID, name: 'Default', path: '/tmp/default' });
const OTHER_PROJECT = makeProject({ id: OTHER_PROJECT_ID, name: 'Other', path: '/tmp/other' });

/** Sentinel embedder; identity is what the mode->embedder tests assert on. */
const SENTINEL_EMBEDDER = { embed: vi.fn(), dimensions: 384, modelTag: 'sentinel', noiseFloor: 0.4 } as unknown as Embedder;

function makeResolver(options: { embedder?: Embedder | null; indexingEnabled?: boolean } = {}): RequestResolver {
  const embedder = options.embedder === undefined ? SENTINEL_EMBEDDER : options.embedder;
  const indexingEnabled = options.indexingEnabled ?? true;
  return {
    resolveProject: vi.fn((selector: string | null | undefined) => {
      if (!selector) {
        return {
          context: { getProjectPath: () => DEFAULT_PROJECT.path },
          projectId: DEFAULT_PROJECT_ID,
          projectName: DEFAULT_PROJECT.name,
          isDefault: true,
        };
      }
      if (selector === 'Other') {
        return {
          context: { getProjectPath: () => OTHER_PROJECT.path },
          projectId: OTHER_PROJECT_ID,
          projectName: OTHER_PROJECT.name,
          isDefault: false,
        };
      }
      return { error: `No project matching "${selector}".` };
    }),
    listProjectsRaw: vi.fn(() => [DEFAULT_PROJECT, OTHER_PROJECT]),
    isMemoryIndexingEnabled: vi.fn(() => indexingEnabled),
    getMemoryEmbedder: vi.fn(() => embedder),
  } as unknown as RequestResolver;
}

/** An embedder that answers one vector per text, as the real one does. */
function makeAnsweringEmbedder() {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0]))),
    dimensions: 2,
    modelTag: 'test@1',
    noiseFloor: 0,
  };
}

/** A server with the search tool registered, for a test that needs its own resolver or caller. */
function registerServer(resolver: RequestResolver, callerSessionId?: string) {
  const fakeServer = makeFakeServer();
  registerSearchTools(fakeServer as never, resolver, callerSessionId);
  return fakeServer.getHandler('kangentic_search');
}

/** A task's board facts, by default the ones the documented example line is made of. */
function boardFacts(overrides: Partial<BoardTaskFacts> = {}): BoardTaskFacts {
  return {
    taskId: 'task-561',
    title: 'Relay config',
    displayId: 561,
    sessions: 4,
    costUsd: 4.12,
    durationMs: 7_800_000,
    tokens: 3_100_000,
    outcome: 'done',
    lastActivityMs: null,
    agent: null,
    model: null,
    filesChanged: 12,
    linesAdded: 340,
    linesRemoved: 80,
    prNumber: 417,
    prState: 'merged',
    ...overrides,
  };
}

/** A ranked task, strongest first by index, with a session, a turn and a best passage of its own. */
function rankedTask(index: number, overrides: Partial<RelatedWorkTask> = {}): RelatedWorkTask {
  return {
    key: `task-${index}`,
    taskId: `task-${index}`,
    displayId: 100 + index,
    title: `Task ${index}`,
    score: 1 - index / 100,
    strength: 1 - index / 100,
    matches: 2,
    firstMs: Date.UTC(2026, 7, 1),
    lastMs: Date.UTC(2026, 7, 2),
    docKeys: [],
    bestChunkId: index,
    sessionId: `session-${index}`,
    turnUuid: `turn-${index}`,
    ...overrides,
  };
}

describe('kangentic_search MCP tool', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSearchEverything.mockResolvedValue([]);
    mockSearchCommits.mockReturnValue([]);
    mockGetProjectDb.mockImplementation((projectId: string) => ({ projectId }));
    mockBoardRecordTasks.mockReturnValue([{ taskId: 'task-quiet', displayId: 14, title: 'A task with no conversation' }]);
    mockReadBoardTaskFacts.mockReturnValue([]);
    mockSummariesFor.mockReturnValue(new Map());
    mockGetByDisplayId.mockReturnValue(undefined);
    mockGetById.mockReturnValue(undefined);
    server = makeFakeServer();
    resolver = makeResolver();
    registerSearchTools(server as never, resolver);
  });

  it('defaults scope to "current" and scans only the active project', async () => {
    await server.getHandler('kangentic_search')({ query: 'hello' });

    expect(mockRunSearchEverything).toHaveBeenCalledOnce();
    const callArg = mockRunSearchEverything.mock.calls[0][0] as { projects: Project[]; includeProjectHits: boolean };
    expect(callArg.projects.map((project) => project.id)).toEqual([DEFAULT_PROJECT_ID]);
    expect(callArg.includeProjectHits).toBe(false);
  });

  it('scope="all" widens to every registered project and enables project hits', async () => {
    await server.getHandler('kangentic_search')({ query: 'hello', scope: 'all' });

    const callArg = mockRunSearchEverything.mock.calls[0][0] as { projects: Project[]; includeProjectHits: boolean };
    expect(callArg.projects.map((project) => project.id).sort()).toEqual([DEFAULT_PROJECT_ID, OTHER_PROJECT_ID].sort());
    expect(callArg.includeProjectHits).toBe(true);
  });

  it('explicit project selector forces scope to "current" even when scope="all" is passed', async () => {
    await server.getHandler('kangentic_search')({ query: 'hello', scope: 'all', project: 'Other' });

    const callArg = mockRunSearchEverything.mock.calls[0][0] as { projects: Project[]; includeProjectHits: boolean };
    expect(callArg.projects.map((project) => project.id)).toEqual([OTHER_PROJECT_ID]);
    expect(callArg.includeProjectHits).toBe(false);
  });

  it('returns an error result when the project selector is invalid', async () => {
    const result = await server.getHandler('kangentic_search')({ query: 'hello', project: 'BadName' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No project matching');
    expect(mockRunSearchEverything).not.toHaveBeenCalled();
  });

  describe('mode -> conversation embedder selection', () => {
    it('mode "hybrid" (default) pulls the resolver embedder and passes it + a 5000ms budget to conversation search', async () => {
      await server.getHandler('kangentic_search')({ query: 'q' });

      expect(resolver.getMemoryEmbedder).toHaveBeenCalledTimes(1);
      const callArg = mockRunSearchEverything.mock.calls[0][0] as {
        conversationSearch: { enabled: boolean; embedder: unknown; embedWaitMs: number };
      };
      expect(callArg.conversationSearch.enabled).toBe(true);
      expect(callArg.conversationSearch.embedder).toBe(SENTINEL_EMBEDDER);
      expect(callArg.conversationSearch.embedWaitMs).toBe(5000);
    });

    it('mode "keyword" passes a null embedder and never asks the resolver for one', async () => {
      await server.getHandler('kangentic_search')({ query: 'q', mode: 'keyword' });

      expect(resolver.getMemoryEmbedder).not.toHaveBeenCalled();
      const callArg = mockRunSearchEverything.mock.calls[0][0] as {
        conversationSearch: { embedder: unknown };
      };
      expect(callArg.conversationSearch.embedder).toBeNull();
    });
  });

  it('formats hits grouped by kind with a summary line', async () => {
    mockRunSearchEverything.mockResolvedValueOnce([
      {
        kind: 'task',
        projectId: DEFAULT_PROJECT_ID,
        projectName: 'Default',
        taskId: 'task-A',
        displayId: 7,
        taskTitle: 'Fix the thing',
        archived: false,
        snippetField: 'title',
        snippet: 'Fix the thing',
        matchStart: 0,
        matchEnd: 3,
      },
      {
        kind: 'session_event',
        projectId: DEFAULT_PROJECT_ID,
        projectName: 'Default',
        taskId: 'task-A',
        taskTitle: 'Fix the thing',
        sessionId: 'session-X',
        agentName: 'Claude Code',
        eventTs: 1000,
        eventKey: 'session-X-1000',
        eventType: 'tool_start',
        snippet: 'Bash: fix me',
        matchStart: 6,
        matchEnd: 9,
      },
    ]);

    const result = await server.getHandler('kangentic_search')({ query: 'fix' });

    const text = result.content[0].text;
    expect(text).toContain('Found 2 hit(s) for "fix"');
    expect(text).toContain('## Tasks');
    expect(text).toContain('[#7] Fix the thing');
    expect(text).toContain('## Session Events');
    expect(text).toContain('via Claude Code');
  });

  it('returns "No hits" when the core returns an empty result', async () => {
    mockRunSearchEverything.mockResolvedValueOnce([]);

    const result = await server.getHandler('kangentic_search')({ query: 'nothing-matches-this' });

    expect(result.content[0].text).toContain('No hits matching "nothing-matches-this"');
  });

  it('returns an error when listProjectsRaw returns an empty list', async () => {
    // Covers the `projectsToScan.length === 0` guard when allProjects is empty
    // and the default project id cannot be found in the list.
    (resolver.listProjectsRaw as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);

    const result = await server.getHandler('kangentic_search')({ query: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No projects available to search');
    expect(mockRunSearchEverything).not.toHaveBeenCalled();
  });

  it('formats backlog-only hits correctly (no Tasks or Session Events sections)', async () => {
    mockRunSearchEverything.mockResolvedValueOnce([
      {
        kind: 'backlog',
        projectId: DEFAULT_PROJECT_ID,
        projectName: 'Default',
        backlogId: 'backlog-1',
        backlogTitle: 'Refactor the auth module',
        snippetField: 'title',
        snippet: 'Refactor the auth module',
        matchStart: 0,
        matchEnd: 8,
      },
    ]);

    const result = await server.getHandler('kangentic_search')({ query: 'Refactor' });

    const text = result.content[0].text;
    expect(text).toContain('Found 1 hit(s)');
    expect(text).toContain('## Backlog');
    expect(text).toContain('Refactor the auth module');
    expect(text).not.toContain('## Tasks');
    expect(text).not.toContain('## Session Events');
    expect(text).not.toContain('## Projects');
    expect(result.isError).toBeUndefined();
  });

  it('formats project-only hits correctly (no Tasks, Backlog, or Session Events sections)', async () => {
    mockRunSearchEverything.mockResolvedValueOnce([
      {
        kind: 'project',
        projectId: OTHER_PROJECT_ID,
        projectName: 'Other',
        projectPath: '/tmp/other',
        snippet: 'Other',
        matchStart: 0,
        matchEnd: 5,
      },
    ]);

    const result = await server.getHandler('kangentic_search')({ query: 'Other', scope: 'all' });

    const text = result.content[0].text;
    expect(text).toContain('Found 1 hit(s)');
    expect(text).toContain('## Projects');
    expect(text).toContain('Other');
    expect(text).not.toContain('## Tasks');
    expect(text).not.toContain('## Backlog');
    expect(text).not.toContain('## Session Events');
    expect(result.isError).toBeUndefined();
  });

  it('formats a conversation hit under a ## Conversations section with score/sessionId/turnUuid', async () => {
    mockRunSearchEverything.mockResolvedValueOnce([
      {
        kind: 'conversation',
        projectId: DEFAULT_PROJECT_ID,
        projectName: 'Default',
        taskId: 'task-conv',
        taskTitle: 'Investigate frobnication',
        sessionId: 'session-conv',
        agentName: 'Claude Code',
        chunkId: 501,
        turnUuid: 'turn-uuid-777',
        turnKind: 'assistant',
        turnTs: 1717000000000,
        score: 0.0164,
        matchKind: 'lexical',
        snippet: 'a frobnicate hit',
        matchStart: 2,
        matchEnd: 12,
      },
    ]);

    const result = await server.getHandler('kangentic_search')({ query: 'frobnicate' });

    const text = result.content[0].text;
    expect(text).toContain('Found 1 hit(s)');
    // Summary count line includes the conversation tally.
    expect(text).toContain('conversation: 1');
    expect(text).toContain('## Conversations');
    // The row carries the formatted score, sessionId, and turnUuid.
    expect(text).toContain('[0.016]');
    expect(text).toContain('Investigate frobnication');
    expect(text).toContain('via Claude Code');
    expect(text).toContain('sessionId: session-conv');
    expect(text).toContain('turnUuid: turn-uuid-777');
    expect(text).toContain('a frobnicate hit');
    // Citation-first drill-down hint points at get_transcript with aroundUuid.
    expect(text).toContain('kangentic_get_transcript');
    expect(text).toContain('aroundUuid');
    // Not mixed into an unrelated section.
    expect(text).not.toContain('## Tasks');
    expect(result.isError).toBeUndefined();
  });

  describe('groupBy:"task"', () => {
    const NODES = [
      { docKey: 'conversation::a', taskId: 'task-561', displayId: 561, title: 'Relay config', sessionId: 'session-a' },
      { docKey: 'conversation::b', taskId: 'task-561', displayId: 561, title: 'Relay config', sessionId: 'session-b' },
      { docKey: 'conversation::c', taskId: null, displayId: null, title: null, sessionId: 'session-c' },
    ];

    function relatedWork() {
      const handed = [
        {
          key: 'task-561', taskId: 'task-561', displayId: 561, title: 'Relay config', score: 0.9, strength: 1,
          matches: 6, firstMs: Date.UTC(2026, 7, 1), lastMs: Date.UTC(2026, 8, 20),
          docKeys: ['conversation::a', 'conversation::b'], bestChunkId: 42, sessionId: 'session-b', turnUuid: 'turn-7',
        },
        {
          key: 'conversation:conversation::c', taskId: null, displayId: null, title: 'Untitled', score: 0.5, strength: 0.56,
          matches: 1, firstMs: null, lastMs: null,
          docKeys: ['conversation::c'], bestChunkId: null, sessionId: null, turnUuid: null,
        },
      ];
      return { ranked: handed, handed, passages: new Map([[42, 'the relay URL parser']]), semantic: true, elapsedMs: 3 };
    }

    beforeEach(() => {
      mockIndexedConversationNodes.mockReturnValue(NODES);
      mockSearchRelatedWork.mockResolvedValue(relatedWork());
    });

    it('leaves the default output alone: no groupBy never touches the rollup', async () => {
      await server.getHandler('kangentic_search')({ query: 'relay' });
      expect(mockRunSearchEverything).toHaveBeenCalledOnce();
      expect(mockSearchRelatedWork).not.toHaveBeenCalled();
    });

    it('ranks the project\'s tasks through the same rollup Ask uses', async () => {
      const result = await server.getHandler('kangentic_search')({ query: 'relay', groupBy: 'task' });

      expect(mockRunSearchEverything).not.toHaveBeenCalled();
      expect(mockIndexedConversationNodes).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, expect.any(Function));
      const input = mockSearchRelatedWork.mock.calls[0][0] as { question: string; projectId: string; nodes: unknown[]; embedder: unknown; recordOnlyTasks: unknown };
      // The worker ranks with the vectors main made and the model's own fields.
      expect(input).toMatchObject({
        question: 'relay',
        projectId: DEFAULT_PROJECT_ID,
        embedder: { modelTag: SENTINEL_EMBEDDER.modelTag, noiseFloor: SENTINEL_EMBEDDER.noiseFloor },
      });
      expect(input.nodes).toEqual(NODES);
      // The tool ranks the whole project, so every board task is in reach of
      // its own record, conversations or not.
      expect(input.recordOnlyTasks).toEqual([{ taskId: 'task-quiet', displayId: 14, title: 'A task with no conversation' }]);

      const text = result.content[0].text;
      expect(text).toContain('2 of 2 related task(s) for "relay", strongest first.');
      expect(text).toContain('kangentic_get_transcript');
      expect(result.isError).toBeUndefined();
    });

    it('gives an agent each task\'s facts, summary and best passage, with every id to follow up by', async () => {
      mockReadBoardTaskFacts.mockReturnValue([boardFacts({ taskId: 'task-561', displayId: 561, title: 'Relay config' })]);
      mockSummariesFor.mockReturnValue(new Map([['task-561', 'Made the relay reconnect after a router restart.']]));

      const result = await server.getHandler('kangentic_search')({ query: 'relay', groupBy: 'task' });

      expect(mockReadBoardTaskFacts).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, expect.any(Function));
      // The conversation with no task has no id to read a summary by.
      expect(mockSummariesFor).toHaveBeenCalledWith(['task-561']);
      const text = result.content[0].text;
      expect(text).toContain([
        '- #561 Relay config (strength 1.00, 6 matches, 2026-08-01 to 2026-09-20, taskId: task-561, sessionId: session-b, turnUuid: turn-7)',
        '  facts: $4.12, 2h 10m, 3.1M tokens, 4 conversations, 12 files, +340/-80 lines, Done, PR 417 merged',
        '  summary: Made the relay reconnect after a router restart.',
        '  passage: "the relay URL parser"',
        '- Untitled (a conversation with no task) (strength 0.56, 1 match, ? to ?)',
      ].join('\n'));
      expect(text).toContain('kangentic_get_transcript');
    });

    it('hands a caller that has an id but is not an answer run the same rows as any other agent', async () => {
      mockReadBoardTaskFacts.mockReturnValue([boardFacts({ taskId: 'task-561', displayId: 561, title: 'Relay config' })]);
      const handler = registerServer(resolver, 'session-regular');

      const result = await handler({ query: 'relay', groupBy: 'task' });

      expect(result.content[0].text).toContain('  facts: $4.12');
      expect(result.content[0].text).toContain('  passage: "the relay URL parser"');
    });

    it('keeps an answer run\'s rows lean: no facts, no summary, the passage on the same line', async () => {
      mockReadBoardTaskFacts.mockReturnValue([boardFacts({ taskId: 'task-561', displayId: 561, title: 'Relay config' })]);
      mockSummariesFor.mockReturnValue(new Map([['task-561', 'Made the relay reconnect.']]));
      const handler = registerServer(resolver, 'answer-lean-1');
      const stop = watchAnswerSearches('answer-lean-1', () => undefined);
      try {
        const result = await handler({ query: 'relay', groupBy: 'task' });

        const text = result.content[0].text;
        expect(text).toContain('- #561 Relay config (strength 1.00, 6 matches, 2026-08-01 to 2026-09-20, taskId: task-561, sessionId: session-b, turnUuid: turn-7) - "the relay URL parser"');
        expect(text).toContain('- Untitled (a conversation with no task) (strength 0.56, 1 match, ? to ?)');
        expect(text).not.toContain('facts:');
        expect(text).not.toContain('summary:');
        // The run already holds every task's facts and the handed tasks' summaries.
        expect(mockReadBoardTaskFacts).not.toHaveBeenCalled();
        expect(mockSummariesFor).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    });

    it('reads summaries for the first twelve rows only, and only for a row that is a task', async () => {
      const rows = Array.from({ length: PASSAGES_SHOWN + 3 }, (_unused, index) => rankedTask(index));
      rows[2] = rankedTask(2, { taskId: null, displayId: null });
      mockSearchRelatedWork.mockResolvedValueOnce({ ranked: rows, handed: rows, passages: new Map(), semantic: true, elapsedMs: 1 });

      await server.getHandler('kangentic_search')({ query: 'relay', groupBy: 'task' });

      const expected = rows.slice(0, PASSAGES_SHOWN).flatMap((row) => (row.taskId ? [row.taskId] : []));
      expect(expected).toHaveLength(PASSAGES_SHOWN - 1);
      expect(mockSummariesFor).toHaveBeenCalledWith(expected);
    });

    it('still ranks when the summaries cannot be read', async () => {
      mockSummariesFor.mockImplementation(() => { throw new Error('no such table'); });
      const result = await server.getHandler('kangentic_search')({ query: 'relay', groupBy: 'task' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('- #561 Relay config');
    });

    it('matches by keyword alone in keyword mode, and says so', async () => {
      mockSearchRelatedWork.mockResolvedValueOnce({ ...relatedWork(), semantic: false });
      const result = await server.getHandler('kangentic_search')({ query: 'relay', groupBy: 'task', mode: 'keyword' });
      expect((mockSearchRelatedWork.mock.calls[0][0] as { embedder: unknown }).embedder).toBeNull();
      expect(result.content[0].text).toContain('Matched by keyword only');
    });

    it('refuses scope:"all" and taskId with a way to fix the call', async () => {
      const wide = await server.getHandler('kangentic_search')({ query: 'relay', groupBy: 'task', scope: 'all' });
      expect(wide.isError).toBe(true);
      expect(wide.content[0].text).toContain('Drop scope:"all"');

      const narrow = await server.getHandler('kangentic_search')({ query: 'relay', groupBy: 'task', taskId: 'task-1' });
      expect(narrow.isError).toBe(true);
      expect(narrow.content[0].text).toContain('Drop taskId');
      expect(mockSearchRelatedWork).not.toHaveBeenCalled();
    });

    it('says so when nothing matches', async () => {
      mockSearchRelatedWork.mockResolvedValueOnce({ ranked: [], handed: [], passages: new Map(), semantic: true, elapsedMs: 1 });
      const result = await server.getHandler('kangentic_search')({ query: 'zebra kettle', groupBy: 'task' });
      expect(result.content[0].text).toContain('"zebra kettle"');
      expect(result.content[0].text).toContain('No tasks matched.');
    });

    it('says so to an answer run in the words it already had', async () => {
      mockSearchRelatedWork.mockResolvedValueOnce({ ranked: [], handed: [], passages: new Map(), semantic: true, elapsedMs: 1 });
      const handler = registerServer(resolver, 'answer-lean-2');
      const stop = watchAnswerSearches('answer-lean-2', () => undefined);
      try {
        const result = await handler({ query: 'zebra kettle', groupBy: 'task' });
        expect(result.content[0].text).toBe('No tasks have conversations matching "zebra kettle".');
      } finally {
        stop();
      }
    });

    it('reports an answer run\'s search to the Knowledge Graph, as every conversation of every task found', async () => {
      const answerServer = makeFakeServer();
      registerSearchTools(answerServer as never, resolver, 'answer-chat-1');
      const seen: Array<{ query: string; sessionIds: string[] }> = [];
      const stop = watchAnswerSearches('answer-chat-1', (search) => seen.push(search));
      try {
        await answerServer.getHandler('kangentic_search')({ query: 'relay', groupBy: 'task' });
      } finally {
        stop();
      }
      expect(seen).toEqual([{ query: 'relay', sessionIds: ['session-a', 'session-b', 'session-c'] }]);
    });
  });

  describe('the arguments a call may not combine', () => {
    const NEEDS_QUERY = 'Pass query to search, or relatedToTask to rank the work related to one task.';

    it('accepts a call with no query in its schema, and refuses it in the handler with what to pass', async () => {
      const schema = (server.getConfig('kangentic_search') as unknown as {
        inputSchema: { safeParse(value: unknown): { success: boolean } };
      }).inputSchema;
      expect(schema.safeParse({ relatedToTask: '#561' }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(true);
      // A query, when given, still has to say something.
      expect(schema.safeParse({ query: '' }).success).toBe(false);

      const result = await server.getHandler('kangentic_search')({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(NEEDS_QUERY);
    });

    it('refuses relatedToTask with taskId, and relatedToTask with groupBy "kind", saying what to drop', async () => {
      const withTaskId = await server.getHandler('kangentic_search')({ relatedToTask: '#561', taskId: 'task-1' });
      expect(withTaskId.isError).toBe(true);
      expect(withTaskId.content[0].text).toBe('relatedToTask ranks the tasks like one task, and taskId searches inside one task. Pass one of them.');

      const withKind = await server.getHandler('kangentic_search')({ relatedToTask: '#561', groupBy: 'kind' });
      expect(withKind.isError).toBe(true);
      expect(withKind.content[0].text).toBe('relatedToTask always returns task rows. Drop groupBy.');
    });

    it('refuses before it resolves a project or runs any search', async () => {
      await server.getHandler('kangentic_search')({});
      await server.getHandler('kangentic_search')({ relatedToTask: '#561', taskId: 'task-1' });
      await server.getHandler('kangentic_search')({ relatedToTask: '#561', groupBy: 'kind' });

      expect(resolver.resolveProject).not.toHaveBeenCalled();
      expect(mockRunSearchEverything).not.toHaveBeenCalled();
      expect(mockSearchRelatedWork).not.toHaveBeenCalled();
      expect(mockSearchCommits).not.toHaveBeenCalled();
    });

    it('does not spend an answer run\'s search budget on a refused call', async () => {
      const handler = registerServer(resolver, 'answer-refusals');
      const stop = watchAnswerSearches('answer-refusals', () => undefined);
      try {
        // More refusals than the budget: were each one to claim a search, none would be left.
        for (let attempt = 0; attempt < ANSWER_SEARCH_BUDGET; attempt += 1) {
          await handler({});
          await handler({ relatedToTask: '#561', taskId: 'task-1' });
          await handler({ relatedToTask: '#561', groupBy: 'kind' });
          await handler({ relatedToTask: '#561', scope: 'all' });
          await handler({ query: 'relay', groupBy: 'task', scope: 'all' });
          await handler({ query: 'relay', groupBy: 'task', taskId: 'task-1' });
        }
        for (let search = 0; search < ANSWER_SEARCH_BUDGET; search += 1) {
          const result = await handler({ query: `query ${search}` });
          expect(result.content[0].text).not.toContain('answer now from what you have already found');
        }
        const overBudget = await handler({ query: 'one more' });
        expect(overBudget.content[0].text).toContain('answer now from what you have already found');
      } finally {
        stop();
      }
    });

    it('refuses relatedToTask across every project, and lets an explicit project narrow it', async () => {
      mockGetByDisplayId.mockReturnValue({ id: 'task-target-uuid', display_id: 561, title: 'Relay config', description: '' });

      const wide = await server.getHandler('kangentic_search')({ relatedToTask: '#561', scope: 'all' });
      expect(wide.isError).toBe(true);
      expect(wide.content[0].text).toContain('Drop scope:"all"');
      expect(mockSearchRelatedWork).not.toHaveBeenCalled();

      // A project selector forces scope to "current", so the same call is fine.
      mockSearchRelatedWork.mockResolvedValue({ ranked: [], handed: [], passages: new Map(), semantic: true, elapsedMs: 1 });
      const narrowed = await server.getHandler('kangentic_search')({ relatedToTask: '#561', scope: 'all', project: 'Other' });
      expect(narrowed.isError).toBeUndefined();
      expect((mockSearchRelatedWork.mock.calls[0][0] as { projectId: string }).projectId).toBe(OTHER_PROJECT_ID);
    });
  });

  describe('searchArgumentRefusal', () => {
    const none = { query: undefined, taskId: undefined, groupBy: undefined, relatedToTask: undefined };

    it('refuses a call with neither a query nor a task to relate to', () => {
      expect(searchArgumentRefusal(none)).toContain('Pass query to search, or relatedToTask');
      expect(searchArgumentRefusal({ ...none, query: '' })).toContain('Pass query to search, or relatedToTask');
      expect(searchArgumentRefusal({ ...none, groupBy: 'task' })).toContain('Pass query to search, or relatedToTask');
    });

    it('refuses relatedToTask combined with taskId or with groupBy "kind"', () => {
      expect(searchArgumentRefusal({ ...none, relatedToTask: '#561', taskId: 'task-1' })).toContain('Pass one of them.');
      expect(searchArgumentRefusal({ ...none, relatedToTask: '#561', groupBy: 'kind' })).toContain('Drop groupBy.');
    });

    it('refuses the one-project rankings across every project, unless a project narrows them', () => {
      expect(searchArgumentRefusal({ ...none, relatedToTask: '#561', scope: 'all' })).toContain('Drop scope:"all"');
      expect(searchArgumentRefusal({ ...none, query: 'relay', groupBy: 'task', scope: 'all' })).toContain('Drop scope:"all"');
      // A project selector forces scope to "current".
      expect(searchArgumentRefusal({ ...none, relatedToTask: '#561', scope: 'all', project: 'Other' })).toBeNull();
      expect(searchArgumentRefusal({ ...none, query: 'relay', groupBy: 'task', scope: 'all', project: 'Other' })).toBeNull();
    });

    it('refuses groupBy "task" narrowed to one task', () => {
      expect(searchArgumentRefusal({ ...none, query: 'relay', groupBy: 'task', taskId: 'task-1' })).toContain('Drop taskId');
    });

    it('lets every other combination through', () => {
      expect(searchArgumentRefusal({ ...none, query: 'relay' })).toBeNull();
      expect(searchArgumentRefusal({ ...none, relatedToTask: '#561' })).toBeNull();
      expect(searchArgumentRefusal({ ...none, relatedToTask: '#561', query: 'reconnect' })).toBeNull();
      expect(searchArgumentRefusal({ ...none, relatedToTask: '#561', groupBy: 'task' })).toBeNull();
      expect(searchArgumentRefusal({ ...none, query: 'relay', taskId: 'task-1' })).toBeNull();
      expect(searchArgumentRefusal({ ...none, query: 'relay', scope: 'all' })).toBeNull();
    });
  });

  describe('relatedToTask', () => {
    const TARGET = { id: 'task-target-uuid', display_id: 561, title: 'Relay config', description: 'Make the relay reconnect after the router restarts.' };
    const TARGET_NODE = { docKey: 'conversation::t1', taskId: TARGET.id, displayId: 561, title: 'Relay config', sessionId: 'session-target' };
    const OTHER_NODE = { docKey: 'conversation::o1', taskId: 'task-other', displayId: 562, title: 'Relay pairing', sessionId: 'session-other' };

    /** Related work over `count` tasks, none of them the target; the first one's conversation is OTHER_NODE's. */
    function relatedTasks(count: number) {
      const handed = Array.from({ length: count }, (_unused, index) => rankedTask(index, {
        key: `task-other-${index}`,
        taskId: `task-other-${index}`,
        docKeys: index === 0 ? [OTHER_NODE.docKey] : [],
      }));
      return {
        ranked: handed,
        handed,
        passages: new Map(handed.map((task, index) => [index, `passage ${index}`])),
        semantic: true,
        elapsedMs: 2,
      };
    }

    function lastSearchInput() {
      return mockSearchRelatedWork.mock.calls[mockSearchRelatedWork.mock.calls.length - 1][0] as {
        question: string;
        keywordText?: string;
        projectId: string;
        nodes: Array<{ taskId: string | null }>;
        recordOnlyTasks: Array<{ taskId: string }>;
        embedder: unknown;
        queryVectors?: Float32Array[];
      };
    }

    beforeEach(() => {
      mockGetByDisplayId.mockImplementation((displayId: number) => (displayId === 561 ? TARGET : undefined));
      mockGetById.mockImplementation((id: string) => (id === TARGET.id ? TARGET : undefined));
      mockIndexedConversationNodes.mockReturnValue([TARGET_NODE, OTHER_NODE]);
      mockBoardRecordTasks.mockReturnValue([
        { taskId: TARGET.id, displayId: 561, title: 'Relay config' },
        { taskId: 'task-other', displayId: 562, title: 'Relay pairing' },
        { taskId: 'task-quiet', displayId: 14, title: 'A task with no conversation' },
      ]);
      mockSearchRelatedWork.mockResolvedValue(relatedTasks(3));
    });

    it('finds the task by "#N", by "N" or by its id', async () => {
      for (const reference of ['#561', '561', ' #561 ', TARGET.id]) {
        mockSearchRelatedWork.mockClear();
        const result = await server.getHandler('kangentic_search')({ relatedToTask: reference });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('most related to #561 Relay config');
        expect(mockSearchRelatedWork).toHaveBeenCalledOnce();
      }
      expect(mockGetByDisplayId).toHaveBeenCalledWith(561);
      expect(mockGetById).toHaveBeenCalledWith(TARGET.id);
    });

    it('leaves the task itself out of the conversations and the records it ranks', async () => {
      await server.getHandler('kangentic_search')({ relatedToTask: '#561' });

      const input = lastSearchInput();
      expect(input.projectId).toBe(DEFAULT_PROJECT_ID);
      expect(input.nodes.map((node) => node.taskId)).toEqual(['task-other']);
      expect(input.recordOnlyTasks.map((record) => record.taskId)).toEqual(['task-other', 'task-quiet']);
      expect(mockIndexedConversationNodes).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, expect.any(Function));
      expect(mockBoardRecordTasks).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, expect.any(Function));
    });

    it('embeds the task once, as one query vector, and searches keywords by the query and title', async () => {
      const model = makeAnsweringEmbedder();
      const handler = registerServer(makeResolver({ embedder: model as unknown as Embedder }));

      await handler({ relatedToTask: '#561', query: 'reconnect' });

      const text = `reconnect. Relay config\n${TARGET.description}`;
      expect(model.embed).toHaveBeenCalledOnce();
      expect(model.embed).toHaveBeenCalledWith([text], { timeoutMs: 5000, isQuery: true });
      const input = lastSearchInput();
      expect(input.queryVectors).toHaveLength(1);
      expect(input.question).toBe(text);
      // A long description would OR a hundred words into the keyword search, so it is the title.
      expect(input.keywordText).toBe('reconnect Relay config');
      // The worker searches with the vector main made and the model's own
      // fields (its noise floor calibrates relevance), never a second embed.
      expect(input.embedder).toMatchObject({ modelTag: model.modelTag, noiseFloor: model.noiseFloor });
    });

    it('embeds the title and description alone when no query focuses it', async () => {
      const model = makeAnsweringEmbedder();
      const handler = registerServer(makeResolver({ embedder: model as unknown as Embedder }));

      await handler({ relatedToTask: '561' });

      expect(model.embed.mock.calls[0][0]).toEqual([`Relay config\n${TARGET.description}`]);
      expect(lastSearchInput().keywordText?.trim()).toBe('Relay config');
    });

    it('cuts what it embeds at 1200 characters', async () => {
      mockGetByDisplayId.mockReturnValue({ ...TARGET, description: 'word '.repeat(2000) });
      const model = makeAnsweringEmbedder();
      const handler = registerServer(makeResolver({ embedder: model as unknown as Embedder }));

      await handler({ relatedToTask: '561', query: 'reconnect' });

      const [embedded] = model.embed.mock.calls[0][0];
      expect(embedded).toHaveLength(1200);
      expect(embedded.startsWith('reconnect. Relay config\nword word')).toBe(true);
    });

    it('ranks by keyword alone when the model does not answer, without embedding again', async () => {
      for (const failure of [
        () => Promise.reject(new Error('timed out')),
        () => Promise.resolve(null),
      ]) {
        mockSearchRelatedWork.mockClear();
        const model = { ...makeAnsweringEmbedder(), embed: vi.fn(failure) };
        const handler = registerServer(makeResolver({ embedder: model as unknown as Embedder }));

        const result = await handler({ relatedToTask: '561' });

        expect(result.isError).toBeUndefined();
        expect(model.embed).toHaveBeenCalledOnce();
        // An empty list, not an absent one: an absent one would make the search embed the question itself.
        expect(lastSearchInput().queryVectors).toEqual([]);
      }
    });

    it('never asks for a model in keyword mode', async () => {
      const model = makeAnsweringEmbedder();
      const resolverWithModel = makeResolver({ embedder: model as unknown as Embedder });
      const handler = registerServer(resolverWithModel);

      await handler({ relatedToTask: '561', mode: 'keyword' });

      expect(resolverWithModel.getMemoryEmbedder).not.toHaveBeenCalled();
      expect(model.embed).not.toHaveBeenCalled();
      expect(lastSearchInput().embedder).toBeNull();
      expect(lastSearchInput().queryVectors).toEqual([]);
    });

    it('gives an agent twelve rows at most, each with its facts, summary and passage', async () => {
      mockSearchRelatedWork.mockResolvedValue(relatedTasks(RELATED_TO_TASK_ROWS + 3));
      mockReadBoardTaskFacts.mockReturnValue([boardFacts({ taskId: 'task-other-0', displayId: 100, title: 'Task 0' })]);
      mockSummariesFor.mockReturnValue(new Map([['task-other-0', 'Paired a phone with the relay.']]));

      const result = await server.getHandler('kangentic_search')({ relatedToTask: '#561' });

      const text = result.content[0].text;
      expect(RELATED_TO_TASK_ROWS).toBe(12);
      expect(text).toContain('12 task(s) most related to #561 Relay config, strongest first (the task itself left out).');
      expect(text.match(/^- #/gm)).toHaveLength(RELATED_TO_TASK_ROWS);
      expect(text).toContain('- #111 Task 11 (');
      expect(text).not.toContain('Task 12');
      expect(text).toContain('  facts: $4.12, 2h 10m, 3.1M tokens, 4 conversations, 12 files, +340/-80 lines, Done, PR 417 merged');
      expect(text).toContain('  summary: Paired a phone with the relay.');
      expect(text).toContain('  passage: "passage 0"');
      expect(mockReadBoardTaskFacts).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, expect.any(Function));
    });

    it('says nothing is related when nothing ranked', async () => {
      mockSearchRelatedWork.mockResolvedValue(relatedTasks(0));
      const result = await server.getHandler('kangentic_search')({ relatedToTask: '#561' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Nothing in the index is related to #561 Relay config.');
    });

    it('gives an answer run the lean rows, capped at twelve, and traces the search as "related to #N"', async () => {
      mockSearchRelatedWork.mockResolvedValue(relatedTasks(RELATED_TO_TASK_ROWS + 3));
      const handler = registerServer(resolver, 'answer-related-1');
      const seen: Array<{ query: string; sessionIds: string[] }> = [];
      const stop = watchAnswerSearches('answer-related-1', (search) => seen.push(search));
      try {
        const result = await handler({ relatedToTask: '#561', query: 'reconnect' });

        const text = result.content[0].text;
        expect(text).toContain('12 of 15 related task(s) for "related to #561 Relay config", strongest first.');
        expect(text.match(/^- #/gm)).toHaveLength(RELATED_TO_TASK_ROWS);
        expect(text).toContain('- #100 Task 0 (strength 1.00, 2 matches, 2026-08-01 to 2026-08-02, taskId: task-other-0, sessionId: session-0, turnUuid: turn-0) - "passage 0"');
        expect(text).not.toContain('facts:');
        expect(mockReadBoardTaskFacts).not.toHaveBeenCalled();
        // The label is the task, not the focus words, and the target's own conversation is not in it.
        expect(seen).toEqual([{ query: 'related to #561', sessionIds: ['session-other'] }]);
      } finally {
        stop();
      }
    });

    it('spends exactly one of an answer run\'s searches on a ranking that runs, and refuses the next once the budget is spent', async () => {
      const handler = registerServer(resolver, 'answer-related-budget-1');
      const stop = watchAnswerSearches('answer-related-budget-1', () => undefined);
      try {
        for (let search = 0; search < ANSWER_SEARCH_BUDGET; search += 1) {
          const result = await handler({ relatedToTask: '#561' });
          expect(result.isError).toBeUndefined();
          expect(result.content[0].text).not.toContain('answer now from what you have already found');
        }
        expect(mockSearchRelatedWork).toHaveBeenCalledTimes(ANSWER_SEARCH_BUDGET);

        const overBudget = await handler({ relatedToTask: '#561' });

        expect(overBudget.isError).toBeUndefined();
        expect(overBudget.content[0].text).toContain('answer now from what you have already found');
        // Refused before the ranking: nothing ran.
        expect(mockSearchRelatedWork).toHaveBeenCalledTimes(ANSWER_SEARCH_BUDGET);
      } finally {
        stop();
      }
    });

    it('names the project and how to find the task when it does not exist', async () => {
      const result = await server.getHandler('kangentic_search')({ relatedToTask: '#999' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No task "#999" in project "Default".');
      expect(result.content[0].text).toContain('kangentic_find_task');
      expect(mockSearchRelatedWork).not.toHaveBeenCalled();

      const other = await server.getHandler('kangentic_search')({ relatedToTask: '#999', project: 'Other' });
      expect(other.isError).toBe(true);
      expect(other.content[0].text).toContain('No task "#999" in project "Other".');
    });

    it('reports a task that cannot be read as missing rather than failing', async () => {
      mockGetProjectDb.mockImplementation(() => { throw new Error('database is locked'); });
      const result = await server.getHandler('kangentic_search')({ relatedToTask: '#561' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No task "#561"');
    });

    it('says the index is off, and ranks nothing, when indexing is off', async () => {
      const handler = registerServer(makeResolver({ indexingEnabled: false }));

      const result = await handler({ relatedToTask: '#561' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(
        'The index is off (Settings > Knowledge Graph), so there is nothing to rank the work related to #561 Relay config by.',
      );
      expect(mockSearchRelatedWork).not.toHaveBeenCalled();
    });

    it('checks the task exists before it says the index is off', async () => {
      const handler = registerServer(makeResolver({ indexingEnabled: false }));
      const result = await handler({ relatedToTask: '#999' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No task "#999"');
    });
  });

  describe('commits in a search by kind', () => {
    const COMMIT_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

    function commitHit(overrides: Record<string, unknown> = {}) {
      return {
        sha: COMMIT_SHA,
        subject: 'fix(relay): back off on reconnect (PR 812)',
        committedMs: Date.UTC(2026, 8, 19),
        taskId: 'task-561',
        displayId: 561,
        taskTitle: 'Relay config',
        ...overrides,
      };
    }

    function taskHit() {
      return {
        kind: 'task', projectId: DEFAULT_PROJECT_ID, projectName: 'Default', taskId: 'task-561', displayId: 561,
        taskTitle: 'Relay config', archived: false, snippetField: 'title', snippet: 'Relay config', matchStart: 0, matchEnd: 5,
      };
    }

    it('lists each commit under ## Commits with the task it came from, and counts it', async () => {
      mockSearchCommits.mockReturnValue([commitHit()]);

      const result = await server.getHandler('kangentic_search')({ query: 'reconnect' });

      const text = result.content[0].text;
      expect(text).toContain('Found 1 hit(s) for "reconnect"');
      expect(text).toContain('commit: 1');
      expect(text).toContain('## Commits');
      expect(text).toContain('- a1b2c3d4e5 2026-09-19 fix(relay): back off on reconnect (PR 812) - from #561 Relay config (project: Default, taskId: task-561)');
      expect(text).toContain('A commit is linked to the task whose conversation first wrote its subject.');
    });

    it('says a commit with no task has none, and lists it all the same', async () => {
      mockSearchCommits.mockReturnValue([commitHit({ taskId: null, displayId: null, taskTitle: null })]);
      const result = await server.getHandler('kangentic_search')({ query: 'reconnect' });
      expect(result.content[0].text).toContain('(PR 812) - no task linked (project: Default)');
    });

    it('shows commits, not "No hits", when only commits matched', async () => {
      mockSearchCommits.mockReturnValue([commitHit()]);
      const result = await server.getHandler('kangentic_search')({ query: 'reconnect' });
      expect(result.content[0].text).not.toContain('No hits');
      expect(result.content[0].text).toContain('## Commits');
      expect(result.content[0].text).not.toContain('## Tasks');
    });

    it('counts commits with the other hits in the total', async () => {
      mockRunSearchEverything.mockResolvedValueOnce([taskHit()]);
      mockSearchCommits.mockReturnValue([commitHit(), commitHit({ sha: 'b'.repeat(40) })]);

      const result = await server.getHandler('kangentic_search')({ query: 'relay' });

      const text = result.content[0].text;
      expect(text).toContain('Found 3 hit(s)');
      expect(text).toContain('tasks: 1');
      expect(text).toContain('commit: 2');
      expect(text.indexOf('## Tasks')).toBeLessThan(text.indexOf('## Commits'));
    });

    it('searches the active project\'s commits with the query and the task it was narrowed to', async () => {
      await server.getHandler('kangentic_search')({ query: 'reconnect', taskId: 'task-561' });
      await server.getHandler('kangentic_search')({ query: 'reconnect' });

      expect(mockSearchCommits).toHaveBeenCalledTimes(2);
      const [firstDb, firstQuery, firstOptions] = mockSearchCommits.mock.calls[0] as unknown as [unknown, string, { taskId?: string }];
      expect(firstDb).toEqual({ projectId: DEFAULT_PROJECT_ID });
      expect(firstQuery).toBe('reconnect');
      expect(firstOptions.taskId).toBe('task-561');
      expect((mockSearchCommits.mock.calls[1] as unknown as [unknown, string, { taskId?: string }])[2].taskId).toBeUndefined();
    });

    it('searches every project\'s commits, once each, when scope is all', async () => {
      mockSearchCommits.mockImplementation(((db: { projectId: string }) => [
        commitHit({ sha: db.projectId === OTHER_PROJECT_ID ? 'b'.repeat(40) : COMMIT_SHA }),
      ]) as never);

      const result = await server.getHandler('kangentic_search')({ query: 'reconnect', scope: 'all' });

      const searchedProjects = (mockSearchCommits.mock.calls as unknown as Array<[{ projectId: string }]>).map((call) => call[0].projectId);
      expect(searchedProjects.sort()).toEqual([DEFAULT_PROJECT_ID, OTHER_PROJECT_ID].sort());
      const text = result.content[0].text;
      expect(text).toContain('(project: Default, taskId: task-561)');
      expect(text).toContain('(project: Other, taskId: task-561)');
    });

    it('skips a project whose commits cannot be read, and keeps the others', async () => {
      mockSearchCommits.mockImplementation(((db: { projectId: string }) => {
        if (db.projectId === OTHER_PROJECT_ID) throw new Error('no such table');
        return [commitHit()];
      }) as never);

      const result = await server.getHandler('kangentic_search')({ query: 'reconnect', scope: 'all' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('commit: 1');
    });

    it('skips a "#N" ticket lookup, which asks for board tasks only', async () => {
      await server.getHandler('kangentic_search')({ query: '#42' });
      await server.getHandler('kangentic_search')({ query: '  #42  ' });

      expect(mockSearchCommits).not.toHaveBeenCalled();
      // The board's own ticket lookup still runs.
      expect(mockRunSearchEverything).toHaveBeenCalledTimes(2);
    });

    it('does not take a bare number or a "#" with words for a ticket lookup', async () => {
      mockRunSearchEverything.mockResolvedValueOnce([taskHit()]);
      mockSearchCommits.mockReturnValue([commitHit({ sha: '1234567'.padEnd(40, '0') })]);

      const bare = await server.getHandler('kangentic_search')({ query: '1234567' });
      await server.getHandler('kangentic_search')({ query: '#42 relay' });

      // Its task hits render as ever, with the commits whose sha it starts beside them.
      expect(mockRunSearchEverything.mock.calls[0][0]).toMatchObject({ query: '1234567' });
      expect(bare.content[0].text).toContain('## Tasks');
      expect(bare.content[0].text).toContain('## Commits');
      expect(bare.content[0].text).toContain('- 1234567000 ');
      expect(mockSearchCommits).toHaveBeenCalledTimes(2);
    });

    it('does not search commits, and says why, when the index is off', async () => {
      const handler = registerServer(makeResolver({ indexingEnabled: false }));

      const result = await handler({ query: 'reconnect' });

      expect(mockSearchCommits).not.toHaveBeenCalled();
      expect(mockGetProjectDb).not.toHaveBeenCalled();
      expect(result.content[0].text).toBe(
        'No hits matching "reconnect".\nConversations and commits were not searched: the index is off in Settings > Knowledge Graph.',
      );
    });

    it('ends a result that has hits with the index-off note too, and gives no second note', async () => {
      mockRunSearchEverything.mockResolvedValueOnce([taskHit()]);
      const handler = registerServer(makeResolver({ indexingEnabled: false, embedder: null }));

      const result = await handler({ query: 'relay' });

      const text = result.content[0].text;
      expect(text.endsWith('\nConversations and commits were not searched: the index is off in Settings > Knowledge Graph.')).toBe(true);
      expect(text).not.toContain('keyword only');
    });

    it('says conversations were matched by keyword only when hybrid mode has no model', async () => {
      const handler = registerServer(makeResolver({ embedder: null }));

      const result = await handler({ query: 'reconnect' });

      expect(result.content[0].text).toContain(
        'Conversations were matched by keyword only, because the Knowledge Graph\'s local model is off or not ready.',
      );
      // Commits are still searched: only the conversations lack their model.
      expect(mockSearchCommits).toHaveBeenCalledOnce();
    });

    it('says nothing about a model the caller did not ask for, or one that is ready', async () => {
      const keywordMode = await registerServer(makeResolver({ embedder: null }))({ query: 'reconnect', mode: 'keyword' });
      expect(keywordMode.content[0].text).not.toContain('keyword only');

      const ready = await server.getHandler('kangentic_search')({ query: 'reconnect' });
      expect(ready.content[0].text).not.toContain('keyword only');
    });

    it('tells an answer run\'s trace the tasks its commit hits are linked to, once each', async () => {
      mockRunSearchEverything.mockResolvedValueOnce([{
        kind: 'conversation', projectId: DEFAULT_PROJECT_ID, projectName: 'Default', taskId: 'task-a', taskTitle: 'A',
        sessionId: 'session-conv', agentName: 'Claude Code', chunkId: 1, turnUuid: 'turn-1', turnKind: 'assistant',
        turnTs: 1, score: 0.5, matchKind: 'lexical', snippet: 'a hit', matchStart: 0, matchEnd: 1,
      }]);
      mockSearchCommits.mockReturnValue([
        commitHit({ taskId: 'task-a' }),
        commitHit({ sha: 'b'.repeat(40), taskId: 'task-a' }),
        commitHit({ sha: 'c'.repeat(40), taskId: 'task-b' }),
        commitHit({ sha: 'd'.repeat(40), taskId: null, displayId: null, taskTitle: null }),
      ]);
      const handler = registerServer(resolver, 'answer-kind-1');
      const seen: Array<{ query: string; sessionIds: string[]; taskIds?: string[] }> = [];
      const stop = watchAnswerSearches('answer-kind-1', (search) => seen.push(search));
      try {
        await handler({ query: 'relay' });
      } finally {
        stop();
      }
      expect(seen).toEqual([{ query: 'relay', sessionIds: ['session-conv'], taskIds: ['task-a', 'task-b'] }]);
    });

    it('sends no task ids when an answer run\'s search found no commits', async () => {
      const handler = registerServer(resolver, 'answer-kind-2');
      const seen: Array<{ query: string; sessionIds: string[]; taskIds?: string[] }> = [];
      const stop = watchAnswerSearches('answer-kind-2', (search) => seen.push(search));
      try {
        await handler({ query: 'relay' });
      } finally {
        stop();
      }
      expect(seen).toEqual([{ query: 'relay', sessionIds: [], taskIds: [] }]);
    });
  });

  describe('when the retrieval worker cannot answer', () => {
    const NOT_SEARCHED_NOTE = `Conversations and commits were not searched. ${INDEX_RESTARTING}`;

    /**
     * The worker rejects `method` the way a restarting one does; every other
     * method runs through its real handler, as in the rest of this file.
     * Returns what puts the client back.
     */
    function workerDownFor(method: string): () => void {
      const realCall = retrievalClient.call as unknown as (called: string, params: unknown) => Promise<unknown>;
      const spy = vi.spyOn(retrievalClient, 'call').mockImplementation((async (called: string, params: unknown) => {
        if (called === method) throw new RetrievalUnavailableError('The retrieval worker exited');
        return realCall(called, params);
      }) as never);
      // The search layer logs each unavailable search; the log is not under test.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      return () => {
        spy.mockRestore();
        warn.mockRestore();
      };
    }

    /** The core's conversation search stands in for the one the tool hands it, so the tool's own wiring of it runs. */
    function runConversationSearchInCore(query: string): void {
      mockRunSearchEverything.mockImplementationOnce((async (args: {
        projects: Project[];
        conversationSearch: { search: (request: { query: string; projects: Project[]; embedder: null }) => Promise<unknown> };
      }) => {
        await args.conversationSearch.search({ query, projects: args.projects, embedder: null });
        return [];
      }) as never);
    }

    it('answers a bare "No hits" when the worker is up and finds nothing', async () => {
      const result = await server.getHandler('kangentic_search')({ query: 'reconnect' });

      expect(result.content[0].text).toBe('No hits matching "reconnect".');
    });

    it('says the conversations and commits were not searched, when the conversation search finds the worker down', async () => {
      runConversationSearchInCore('reconnect');
      const restore = workerDownFor('search.conversations');
      try {
        const result = await server.getHandler('kangentic_search')({ query: 'reconnect' });

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe(`No hits matching "reconnect".\n${NOT_SEARCHED_NOTE}`);
      } finally {
        restore();
      }
    });

    it('says the conversations and commits were not searched, when the commit search finds the worker down', async () => {
      const restore = workerDownFor('search.commits');
      try {
        const result = await server.getHandler('kangentic_search')({ query: 'reconnect' });

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe(`No hits matching "reconnect".\n${NOT_SEARCHED_NOTE}`);
      } finally {
        restore();
      }
    });

    it('ends a result that has hits with the note too, in place of the keyword-only note', async () => {
      mockRunSearchEverything.mockResolvedValueOnce([{
        kind: 'task', projectId: DEFAULT_PROJECT_ID, projectName: 'Default', taskId: 'task-561', displayId: 561,
        taskTitle: 'Relay config', archived: false, snippetField: 'title', snippet: 'Relay config', matchStart: 0, matchEnd: 5,
      }]);
      // No model, so hybrid mode would also have said "keyword only".
      const handler = registerServer(makeResolver({ embedder: null }));
      const restore = workerDownFor('search.commits');
      try {
        const result = await handler({ query: 'relay' });

        const text = result.content[0].text;
        expect(text).toContain('## Tasks');
        expect(text.endsWith(`\n${NOT_SEARCHED_NOTE}`)).toBe(true);
        expect(text).not.toContain('keyword only');
      } finally {
        restore();
      }
    });
  });

  describe('an answer run\'s search budget', () => {
    it('allows a question its budget of searches, then tells the agent to answer instead of searching', async () => {
      // Measured: told to search again when a search missed, one agent made
      // about 50 searches over 95 seconds before writing a word.
      const answerServer = makeFakeServer();
      registerSearchTools(answerServer as never, resolver, 'answer-chat-2');
      const stop = watchAnswerSearches('answer-chat-2', () => undefined);
      try {
        for (let search = 0; search < ANSWER_SEARCH_BUDGET; search += 1) {
          const result = await answerServer.getHandler('kangentic_search')({ query: `query ${search}` });
          expect(result.content[0].text).not.toContain('Do not search again');
        }
        const callsWithinBudget = mockRunSearchEverything.mock.calls.length;
        const refused = await answerServer.getHandler('kangentic_search')({ query: 'one more' });
        expect(refused.isError).toBeUndefined();
        expect(refused.content[0].text).toContain('answer now from what you have already found');
        // Refused before any work: no search ran.
        expect(mockRunSearchEverything.mock.calls.length).toBe(callsWithinBudget);
      } finally {
        stop();
      }
    });

    it('gives each question its own budget', async () => {
      const answerServer = makeFakeServer();
      registerSearchTools(answerServer as never, resolver, 'answer-chat-3');
      let stop = watchAnswerSearches('answer-chat-3', () => undefined);
      for (let search = 0; search <= ANSWER_SEARCH_BUDGET; search += 1) {
        await answerServer.getHandler('kangentic_search')({ query: `query ${search}` });
      }
      stop();
      // The next question in the chat watches again, and searches again.
      stop = watchAnswerSearches('answer-chat-3', () => undefined);
      try {
        const result = await answerServer.getHandler('kangentic_search')({ query: 'next question' });
        expect(result.content[0].text).not.toContain('Do not search again');
      } finally {
        stop();
      }
    });

    it('spends none of the question\'s searches on a related-task call that names a task that does not exist', async () => {
      // Nothing is on the board as #999 here. More such calls than the budget:
      // were each one to claim a search, none would be left for a real one.
      const handler = registerServer(resolver, 'answer-budget-related-1');
      const stop = watchAnswerSearches('answer-budget-related-1', () => undefined);
      try {
        for (let attempt = 0; attempt <= ANSWER_SEARCH_BUDGET + 1; attempt += 1) {
          const refused = await handler({ relatedToTask: '#999' });
          expect(refused.isError).toBe(true);
          expect(refused.content[0].text).toContain('No task "#999"');
        }
        for (let search = 0; search < ANSWER_SEARCH_BUDGET; search += 1) {
          const result = await handler({ query: `query ${search}` });
          expect(result.isError).toBeUndefined();
          expect(result.content[0].text).not.toContain('answer now from what you have already found');
        }
        const overBudget = await handler({ query: 'one more' });
        expect(overBudget.content[0].text).toContain('answer now from what you have already found');
      } finally {
        stop();
      }
    });

    it('never limits an ordinary agent\'s search', async () => {
      for (let search = 0; search <= ANSWER_SEARCH_BUDGET + 1; search += 1) {
        const result = await server.getHandler('kangentic_search')({ query: `query ${search}` });
        expect(result.content[0].text).not.toContain('Do not search again');
      }
    });
  });

  describe('an answer run\'s project scope', () => {
    // The user chose the projects a question is asked across, and the Privacy
    // tab names what an answer sends. The search tool is the one door an agent
    // has to a project's history, so it keeps to those projects whatever
    // `project` or `scope` the agent passes.
    const THIRD_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
    const THIRD_PROJECT = makeProject({ id: THIRD_PROJECT_ID, name: 'Third', path: '/tmp/third' });

    /** A resolver with three registered projects, of which a question is asked across some. */
    function threeProjectResolver(): RequestResolver {
      const registered = makeResolver();
      vi.mocked(registered.listProjectsRaw).mockReturnValue([DEFAULT_PROJECT, OTHER_PROJECT, THIRD_PROJECT]);
      return registered;
    }

    /** The projects the search core was asked to scan, and the ones it may name in project hits. */
    function scannedProjects() {
      const call = mockRunSearchEverything.mock.calls[0][0] as unknown as {
        projects: Project[];
        projectsForProjectHits: Project[];
        includeProjectHits: boolean;
      };
      return {
        scanned: call.projects.map((project) => project.id),
        nameable: call.projectsForProjectHits.map((project) => project.id),
        includeProjectHits: call.includeProjectHits,
      };
    }

    it('refuses a project the question was not asked across, and names the ones it was', async () => {
      const handler = registerServer(threeProjectResolver(), 'answer-scope-1');
      const stop = watchAnswerSearches('answer-scope-1', () => undefined, [DEFAULT_PROJECT_ID, THIRD_PROJECT_ID]);
      try {
        const result = await handler({ query: 'relay', project: 'Other' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('This question is asked across Default, Third. Search only those.');
        // Nothing was read from the project it may not search.
        expect(mockRunSearchEverything).not.toHaveBeenCalled();
        expect(mockSearchCommits).not.toHaveBeenCalled();
        expect(mockGetProjectDb).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    });

    it('still searches a project the question was asked across when the agent names it', async () => {
      const handler = registerServer(threeProjectResolver(), 'answer-scope-2');
      const stop = watchAnswerSearches('answer-scope-2', () => undefined, [DEFAULT_PROJECT_ID, OTHER_PROJECT_ID]);
      try {
        const result = await handler({ query: 'relay', project: 'Other' });

        expect(result.isError).toBeUndefined();
        expect(scannedProjects().scanned).toEqual([OTHER_PROJECT_ID]);
      } finally {
        stop();
      }
    });

    it('searches only the projects the question was asked across when the agent passes scope "all"', async () => {
      const handler = registerServer(threeProjectResolver(), 'answer-scope-3');
      const stop = watchAnswerSearches('answer-scope-3', () => undefined, [DEFAULT_PROJECT_ID, OTHER_PROJECT_ID]);
      try {
        await handler({ query: 'relay', scope: 'all' });

        const { scanned, nameable, includeProjectHits } = scannedProjects();
        expect(scanned).toEqual([DEFAULT_PROJECT_ID, OTHER_PROJECT_ID]);
        // Project-name hits come from the same list, so the third project's name does not leak.
        expect(includeProjectHits).toBe(true);
        expect(nameable).toEqual([DEFAULT_PROJECT_ID, OTHER_PROJECT_ID]);
        // Its commits are not read either.
        expect(mockGetProjectDb.mock.calls.map(([projectId]) => projectId)).toEqual([DEFAULT_PROJECT_ID, OTHER_PROJECT_ID]);
      } finally {
        stop();
      }
    });

    it('does not limit an answer run whose question names no projects', async () => {
      const handler = registerServer(threeProjectResolver(), 'answer-scope-4');
      const stop = watchAnswerSearches('answer-scope-4', () => undefined);
      try {
        await handler({ query: 'relay', scope: 'all' });

        expect(scannedProjects().scanned).toEqual([DEFAULT_PROJECT_ID, OTHER_PROJECT_ID, THIRD_PROJECT_ID]);
      } finally {
        stop();
      }
    });

    it('holds a run no question is watching to the project its URL names, though it passes scope "all"', async () => {
      // The watch goes when its question ends, and a run can outlive it. No
      // question means no scope, and no scope is not every project. This caller
      // never had a watch registered, which is the same state.
      const handler = registerServer(threeProjectResolver(), 'answer-scope-6');

      const result = await handler({ query: 'relay', scope: 'all' });

      expect(result.isError).toBeUndefined();
      const { scanned, nameable } = scannedProjects();
      expect(scanned).toEqual([DEFAULT_PROJECT_ID]);
      // The other projects' names do not leak through project hits either, and
      // none of their commits are read.
      expect(nameable).toEqual([DEFAULT_PROJECT_ID]);
      expect(mockGetProjectDb.mock.calls.map(([projectId]) => projectId)).toEqual([DEFAULT_PROJECT_ID]);
    });

    it('refuses a project other than its own to a run no question is watching', async () => {
      const handler = registerServer(threeProjectResolver(), 'answer-scope-7');

      const result = await handler({ query: 'relay', project: 'Other' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('This question is asked across Default. Search only those.');
      expect(mockRunSearchEverything).not.toHaveBeenCalled();
      expect(mockGetProjectDb).not.toHaveBeenCalled();
    });

    it('spends none of the question\'s searches on a call it refuses', async () => {
      const handler = registerServer(threeProjectResolver(), 'answer-scope-5');
      const stop = watchAnswerSearches('answer-scope-5', () => undefined, [DEFAULT_PROJECT_ID]);
      try {
        // More refusals than the budget: were each one to claim a search, none would be left.
        for (let attempt = 0; attempt <= ANSWER_SEARCH_BUDGET; attempt += 1) {
          const refused = await handler({ query: 'relay', project: 'Other' });
          expect(refused.isError).toBe(true);
          expect(refused.content[0].text).toContain('Search only those.');
        }
        for (let search = 0; search < ANSWER_SEARCH_BUDGET; search += 1) {
          const result = await handler({ query: `query ${search}` });
          expect(result.isError).toBeUndefined();
          expect(result.content[0].text).not.toContain('answer now from what you have already found');
        }
        const overBudget = await handler({ query: 'one more' });
        expect(overBudget.content[0].text).toContain('answer now from what you have already found');
      } finally {
        stop();
      }
    });
  });

  it('renders turnUuid as n/a when a conversation hit lost its anchor', async () => {
    mockRunSearchEverything.mockResolvedValueOnce([
      {
        kind: 'conversation',
        projectId: DEFAULT_PROJECT_ID,
        projectName: 'Default',
        taskId: null,
        taskTitle: '(unknown task)',
        sessionId: 'session-anchorless',
        agentName: 'Claude Code',
        chunkId: 9,
        turnUuid: null,
        turnKind: 'mixed',
        turnTs: null,
        score: 0.5,
        matchKind: 'semantic',
        snippet: 'no-mark snippet',
        matchStart: 0,
        matchEnd: 0,
      },
    ]);

    const result = await server.getHandler('kangentic_search')({ query: 'anything' });

    const text = result.content[0].text;
    expect(text).toContain('## Conversations');
    expect(text).toContain('turnUuid: n/a');
    expect(text).toContain('[0.500]');
  });
});

describe('factsInline', () => {
  it('prints a task\'s facts on one line, as the documented example', () => {
    expect(factsInline(boardFacts())).toBe('$4.12, 2h 10m, 3.1M tokens, 4 conversations, 12 files, +340/-80 lines, Done, PR 417 merged');
  });

  it('uses the singular for one conversation and one file', () => {
    expect(factsInline(boardFacts({ sessions: 1, filesChanged: 1 }))).toContain('1 conversation, 1 file, ');
    expect(factsInline(boardFacts({ sessions: 1, filesChanged: 1 }))).not.toContain('conversations');
  });

  it('leaves out a fact that was never recorded instead of printing a zero', () => {
    const unrecorded = boardFacts({
      sessions: 2, costUsd: null, durationMs: null, tokens: null, outcome: 'active',
      filesChanged: null, linesAdded: null, linesRemoved: null, prNumber: null, prState: null,
    });
    expect(factsInline(unrecorded)).toBe('2 conversations, Open');
    expect(factsInline(boardFacts({ linesRemoved: null }))).toContain('+340 lines');
    expect(factsInline(boardFacts({ linesRemoved: null }))).not.toContain('/');
    expect(factsInline(boardFacts({ prState: null }))).toMatch(/, PR 417$/);
  });
});

describe('formatRankedTasksForAgents', () => {
  const HEADER = '3 of 3 related task(s) for "relay", strongest first.';
  const noExtras = { factsByTaskId: new Map<string, BoardTaskFacts>(), summaryByTaskId: new Map<string, string>() };

  function relatedFor(handed: RelatedWorkTask[], overrides: { semantic?: boolean; passageLength?: number } = {}) {
    return {
      semantic: overrides.semantic ?? true,
      passages: new Map(handed.flatMap((task) => (task.bestChunkId === null ? [] : [[task.bestChunkId, 'x'.repeat(overrides.passageLength ?? 12)] as [number, string]]))),
    };
  }

  it('gives a row its match line, then its facts, summary and passage on lines of their own', () => {
    const handed = [rankedTask(0)];
    const text = formatRankedTasksForAgents(HEADER, handed, { semantic: true, passages: new Map([[0, 'the relay URL parser']]) }, {
      factsByTaskId: new Map([['task-0', boardFacts({ taskId: 'task-0' })]]),
      summaryByTaskId: new Map([['task-0', 'Made the relay reconnect.']]),
    });

    expect(text).toContain([
      '- #100 Task 0 (strength 1.00, 2 matches, 2026-08-01 to 2026-08-02, taskId: task-0, sessionId: session-0, turnUuid: turn-0)',
      '  facts: $4.12, 2h 10m, 3.1M tokens, 4 conversations, 12 files, +340/-80 lines, Done, PR 417 merged',
      '  summary: Made the relay reconnect.',
      '  passage: "the relay URL parser"',
    ].join('\n'));
  });

  it('starts with the header and what strength and matches mean, and ends with how to read the turns', () => {
    const handed = [rankedTask(0)];
    const text = formatRankedTasksForAgents(HEADER, handed, relatedFor(handed), noExtras);
    expect(text.startsWith(`${HEADER} strength is relative to the best match (1.00), and matches counts the passages that matched.`)).toBe(true);
    expect(text).toContain(`The first ${PASSAGES_SHOWN} carry a summary where one was written and their best passage.`);
    expect(text.endsWith('kangentic_get_transcript: { sessionId, aroundUuid: <turnUuid>, context: 3 }')).toBe(true);
  });

  it('leaves out the lines a row has nothing for, and names a conversation with no task', () => {
    const orphan = rankedTask(1, { taskId: null, displayId: null, title: 'Untitled', bestChunkId: null, sessionId: null, turnUuid: null, firstMs: null, lastMs: null, matches: 1, strength: 0.56 });
    const text = formatRankedTasksForAgents(HEADER, [orphan], { semantic: true, passages: new Map() }, noExtras);

    expect(text).toContain('\n- Untitled (a conversation with no task) (strength 0.56, 1 match, ? to ?)\n');
    expect(text).not.toContain('facts:');
    expect(text).not.toContain('summary:');
    expect(text).not.toContain('passage:');
  });

  it('gives the first twelve rows their detail and every later row one line of facts and its task id', () => {
    const handed = Array.from({ length: PASSAGES_SHOWN + 2 }, (_unused, index) => rankedTask(index));
    const lateTask = handed[PASSAGES_SHOWN];
    const extras = {
      factsByTaskId: new Map([[lateTask.taskId as string, boardFacts({ sessions: 1, costUsd: 2, durationMs: 300_000, tokens: 12_000, outcome: 'active', filesChanged: null, linesAdded: null, linesRemoved: null, prNumber: null, prState: null })]]),
      summaryByTaskId: new Map([[lateTask.taskId as string, 'A summary the lean row must not carry.']]),
    };

    const text = formatRankedTasksForAgents(HEADER, handed, relatedFor(handed), extras);

    // The twelfth row is still detailed, the thirteenth is not.
    expect(text).toContain(`  passage: "${'x'.repeat(12)}"`);
    expect(text.match(/^ {2}passage: /gm)).toHaveLength(PASSAGES_SHOWN);
    expect(text).toContain('- #112 Task 12 (strength 0.88, 2 matches, 2026-08-01 to 2026-08-02, taskId: task-12) - $2.00, 5m, 12k tokens, 1 conversation, Open\n');
    expect(text).toContain('- #113 Task 13 (strength 0.87, 2 matches, 2026-08-01 to 2026-08-02, taskId: task-13)\n');
    expect(text).not.toContain('taskId: task-12, sessionId');
    expect(text).not.toContain('A summary the lean row must not carry.');
  });

  it('stops at the size cap, counts the rows it did not show, and says how to narrow', () => {
    // Twelve detailed rows with a long passage each are about 50,000 characters.
    const handed = Array.from({ length: PASSAGES_SHOWN + 3 }, (_unused, index) => rankedTask(index));

    const text = formatRankedTasksForAgents(HEADER, handed, relatedFor(handed, { passageLength: 4_000 }), noExtras);

    const shown = (text.match(/^- #/gm) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(handed.length);
    const note = `${handed.length - shown} more related task(s) not shown. Add words to the query to narrow it.`;
    expect(text).toContain(`\n${note}\n`);
    // The rows shown are the strongest ones, in order, with nothing skipped.
    for (let index = 0; index < shown; index += 1) expect(text).toContain(`- #${100 + index} Task ${index} (`);
    expect(text).not.toContain(`- #${100 + shown} Task ${shown} (`);
    // The rows and the intro stay inside the cap. The note and the reading hint follow them.
    const body = text.slice(0, text.indexOf(`\n${note}`));
    expect(body.length).toBeLessThanOrEqual(RANKED_TASKS_RESPONSE_CHARS);
    expect(RANKED_TASKS_RESPONSE_CHARS).toBe(30_000);
  });

  it('does not say rows are missing when every row fits', () => {
    const handed = Array.from({ length: PASSAGES_SHOWN + 3 }, (_unused, index) => rankedTask(index));
    const text = formatRankedTasksForAgents(HEADER, handed, relatedFor(handed), noExtras);
    expect(text.match(/^- #/gm)).toHaveLength(handed.length);
    expect(text).not.toContain('not shown');
  });

  it('says when it matched by keyword only, and only then', () => {
    const handed = [rankedTask(0)];
    const keywordOnly = formatRankedTasksForAgents(HEADER, handed, relatedFor(handed, { semantic: false }), noExtras);
    expect(keywordOnly).toContain('Matched by keyword only, because the Knowledge Graph\'s local model is off or not ready.');
    expect(formatRankedTasksForAgents(HEADER, handed, relatedFor(handed, { semantic: true }), noExtras)).not.toContain('keyword only');
  });

  it('says no tasks matched when there are none, after the header', () => {
    expect(formatRankedTasksForAgents('0 of 0 related task(s) for "zebra", strongest first.', [], { semantic: true, passages: new Map() }, noExtras))
      .toBe('0 of 0 related task(s) for "zebra", strongest first.\nNo tasks matched.');
  });
});
