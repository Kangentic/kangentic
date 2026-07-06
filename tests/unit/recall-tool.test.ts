import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../../src/shared/types';
import type { TranscriptSearchHit } from '../../src/main/retrieval/memory-search';
import type { Embedder } from '../../src/main/retrieval/types';

/**
 * kangentic_recall MCP tool handler.
 *
 * Strategy mirrors search-everything-mcp.test.ts: stub the memory-search core so
 * the test focuses on the tool's own logic - the indexing-disabled short-circuit,
 * scope/project routing, the taskId/agent/since-until post-filters, the
 * mode->embedder selection, and the citation-block formatting (score, sessionId,
 * turnUuid lines + the get_transcript footer). The hybrid retrieval itself is
 * covered by memory-search-degradation.test.ts and retrieval-fusion.test.ts.
 */

const { mockSearchConversationMemory } = vi.hoisted(() => ({
  mockSearchConversationMemory: vi.fn(async () => [] as TranscriptSearchHit[]),
}));

vi.mock('../../src/main/retrieval/memory-search', () => ({
  searchConversationMemory: mockSearchConversationMemory,
}));

import { registerRecallTools } from '../../src/main/agent/mcp-http/recall-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

const DEFAULT_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? DEFAULT_PROJECT_ID,
    name: overrides.name ?? 'Default',
    path: overrides.path ?? '/mock/default',
    github_url: overrides.github_url ?? null,
    default_agent: overrides.default_agent ?? 'claude',
    group_id: overrides.group_id ?? null,
    position: overrides.position ?? 0,
    last_opened: overrides.last_opened ?? '2026-05-01T00:00:00Z',
    created_at: overrides.created_at ?? '2026-04-01T00:00:00Z',
  };
}

const DEFAULT_PROJECT = makeProject({ id: DEFAULT_PROJECT_ID, name: 'Default', path: '/mock/default' });
const OTHER_PROJECT = makeProject({ id: OTHER_PROJECT_ID, name: 'Other', path: '/mock/other' });

function makeHit(overrides: Partial<TranscriptSearchHit> = {}): TranscriptSearchHit {
  // Spread overrides over the base so an explicit `null` (e.g. turnUuid) is
  // honored rather than coalesced back to the default.
  const base: TranscriptSearchHit = {
    chunkId: 1,
    projectId: DEFAULT_PROJECT_ID,
    projectName: 'Default',
    sessionId: 'session-1',
    taskId: 'task-1',
    taskTitle: 'Fix the bug',
    agentName: 'Claude Code',
    role: 'assistant',
    turnUuid: 'turn-1',
    turnTs: Date.parse('2026-06-01T00:00:00Z'),
    snippet: 'a helpful snippet',
    matchStart: 0,
    matchEnd: 0,
    score: 0.0164,
    matchKind: 'lexical',
  };
  return { ...base, ...overrides };
}

type AnyToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function makeFakeServer() {
  const handlers: Record<string, AnyToolHandler> = {};
  return {
    registerTool: vi.fn((name: string, _config: unknown, handler: AnyToolHandler) => {
      handlers[name] = handler;
    }),
    getHandler(name: string): AnyToolHandler {
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler;
    },
  };
}

/** Sentinel embedder object; identity is what we assert on. */
const SENTINEL_EMBEDDER = { embed: vi.fn(), dimensions: 384, modelTag: 'sentinel' } as unknown as Embedder;

function makeResolver(): RequestResolver {
  return {
    isMemoryIndexingEnabled: vi.fn(() => true),
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
    getMemoryEmbedder: vi.fn(() => SENTINEL_EMBEDDER),
  } as unknown as RequestResolver;
}

type SearchInput = {
  query: string;
  projects: Project[];
  k?: number;
  embedWaitMs?: number;
  embedder?: Embedder | null;
};

function lastSearchInput(): SearchInput {
  const calls = mockSearchConversationMemory.mock.calls;
  return calls[calls.length - 1][0] as unknown as SearchInput;
}

describe('kangentic_recall MCP tool', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchConversationMemory.mockResolvedValue([]);
    server = makeFakeServer();
    resolver = makeResolver();
    registerRecallTools(server as never, resolver);
  });

  it('short-circuits with the Settings message when indexing is disabled', async () => {
    (resolver.isMemoryIndexingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await server.getHandler('kangentic_recall')({ query: 'idle bug' });

    expect(result.content[0].text).toContain('Conversation memory indexing is disabled');
    expect(result.content[0].text).toContain('Settings -> Memory');
    expect(mockSearchConversationMemory).not.toHaveBeenCalled();
  });

  it('returns a citation block with score, sessionId/turnUuid, role, snippet, and the get_transcript footer', async () => {
    mockSearchConversationMemory.mockResolvedValueOnce([
      makeHit({ sessionId: 'session-abc', turnUuid: 'turn-xyz', score: 0.0164, role: 'assistant', snippet: 'the false-idle fix' }),
    ]);

    const result = await server.getHandler('kangentic_recall')({ query: 'false idle' });
    const text = result.content[0].text;

    expect(text).toContain('Recall: 1 hit(s) for "false idle"');
    expect(text).toContain('(scope: current, mode: hybrid)');
    expect(text).toContain('[0.016]');
    expect(text).toContain('Fix the bug');
    expect(text).toContain('Claude Code');
    expect(text).toContain('sessionId: session-abc');
    expect(text).toContain('turnUuid: turn-xyz');
    expect(text).toContain('(assistant)');
    expect(text).toContain('the false-idle fix');
    // Citation-first footer points at get_transcript with aroundUuid.
    expect(text).toContain('kangentic_get_transcript');
    expect(text).toContain('aroundUuid');
    expect(result.isError).toBeUndefined();
  });

  it('over-fetches OVERFETCH_CAP hits then trims to k with the default k of 8', async () => {
    mockSearchConversationMemory.mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, index) => makeHit({ chunkId: index, taskTitle: `Task ${index}` })),
    );

    const result = await server.getHandler('kangentic_recall')({ query: 'anything' });

    expect(result.content[0].text).toContain('Recall: 8 hit(s)');
    const input = lastSearchInput();
    expect(input.k).toBe(50);
    expect(input.embedWaitMs).toBe(5000);
  });

  it('renders the no-match message when the core returns nothing', async () => {
    mockSearchConversationMemory.mockResolvedValueOnce([]);

    const result = await server.getHandler('kangentic_recall')({ query: 'nothing-here' });

    expect(result.content[0].text).toContain('Recall: no past conversations matched "nothing-here"');
  });

  it('renders turnUuid as n/a when a hit lost its anchor', async () => {
    mockSearchConversationMemory.mockResolvedValueOnce([makeHit({ turnUuid: null })]);

    const result = await server.getHandler('kangentic_recall')({ query: 'anchorless' });

    expect(result.content[0].text).toContain('turnUuid: n/a');
  });

  describe('post-filters', () => {
    it('taskId excludes hits belonging to other tasks', async () => {
      mockSearchConversationMemory.mockResolvedValueOnce([
        makeHit({ taskId: 't1', taskTitle: 'Task One' }),
        makeHit({ taskId: 't2', taskTitle: 'Task Two' }),
      ]);

      const result = await server.getHandler('kangentic_recall')({ query: 'q', taskId: 't1' });
      const text = result.content[0].text;

      expect(text).toContain('Recall: 1 hit(s)');
      expect(text).toContain('Task One');
      expect(text).not.toContain('Task Two');
    });

    it('agent filters by case-insensitive display-name substring', async () => {
      mockSearchConversationMemory.mockResolvedValueOnce([
        makeHit({ agentName: 'Claude Code', taskTitle: 'Claude work' }),
        makeHit({ agentName: 'Codex CLI', taskTitle: 'Codex work' }),
      ]);

      const result = await server.getHandler('kangentic_recall')({ query: 'q', agent: 'codex' });
      const text = result.content[0].text;

      expect(text).toContain('Recall: 1 hit(s)');
      expect(text).toContain('Codex work');
      expect(text).not.toContain('Claude work');
    });

    it('since excludes hits whose turn timestamp is before the floor', async () => {
      mockSearchConversationMemory.mockResolvedValueOnce([
        makeHit({ turnTs: Date.parse('2026-01-15T00:00:00Z'), taskTitle: 'January work' }),
        makeHit({ turnTs: Date.parse('2026-06-15T00:00:00Z'), taskTitle: 'June work' }),
      ]);

      const result = await server.getHandler('kangentic_recall')({ query: 'q', since: '2026-03-01' });
      const text = result.content[0].text;

      expect(text).toContain('June work');
      expect(text).not.toContain('January work');
    });

    it('until excludes hits whose turn timestamp is after the ceiling', async () => {
      mockSearchConversationMemory.mockResolvedValueOnce([
        makeHit({ turnTs: Date.parse('2026-01-15T00:00:00Z'), taskTitle: 'January work' }),
        makeHit({ turnTs: Date.parse('2026-06-15T00:00:00Z'), taskTitle: 'June work' }),
      ]);

      const result = await server.getHandler('kangentic_recall')({ query: 'q', until: '2026-03-01' });
      const text = result.content[0].text;

      expect(text).toContain('January work');
      expect(text).not.toContain('June work');
    });
  });

  describe('mode -> embedder selection', () => {
    it('mode "lexical" passes a null embedder and never asks the resolver for one', async () => {
      await server.getHandler('kangentic_recall')({ query: 'q', mode: 'lexical' });

      expect(lastSearchInput().embedder).toBeNull();
      expect(resolver.getMemoryEmbedder).not.toHaveBeenCalled();
    });

    it('mode "hybrid" (default) requests the resolver embedder and passes it through', async () => {
      await server.getHandler('kangentic_recall')({ query: 'q' });

      expect(resolver.getMemoryEmbedder).toHaveBeenCalledTimes(1);
      expect(lastSearchInput().embedder).toBe(SENTINEL_EMBEDDER);
    });

    it('mode "semantic" also requests the resolver embedder (falls back to lexical downstream)', async () => {
      await server.getHandler('kangentic_recall')({ query: 'q', mode: 'semantic' });

      expect(resolver.getMemoryEmbedder).toHaveBeenCalledTimes(1);
      expect(lastSearchInput().embedder).toBe(SENTINEL_EMBEDDER);
    });
  });

  describe('scope / project routing', () => {
    it('defaults scope to "current" and scans only the active project', async () => {
      mockSearchConversationMemory.mockResolvedValueOnce([makeHit()]);

      const result = await server.getHandler('kangentic_recall')({ query: 'q' });

      expect(lastSearchInput().projects.map((project) => project.id)).toEqual([DEFAULT_PROJECT_ID]);
      expect(result.content[0].text).toContain('scope: current');
    });

    it('scope "all" widens to every registered project', async () => {
      mockSearchConversationMemory.mockResolvedValueOnce([makeHit()]);

      const result = await server.getHandler('kangentic_recall')({ query: 'q', scope: 'all' });

      expect(lastSearchInput().projects.map((project) => project.id).sort()).toEqual(
        [DEFAULT_PROJECT_ID, OTHER_PROJECT_ID].sort(),
      );
      expect(result.content[0].text).toContain('scope: all');
    });

    it('an explicit project selector forces scope back to "current"', async () => {
      mockSearchConversationMemory.mockResolvedValueOnce([makeHit({ projectId: OTHER_PROJECT_ID })]);

      const result = await server.getHandler('kangentic_recall')({ query: 'q', scope: 'all', project: 'Other' });

      expect(lastSearchInput().projects.map((project) => project.id)).toEqual([OTHER_PROJECT_ID]);
      expect(result.content[0].text).toContain('scope: current');
    });

    it('returns an error result for an invalid project selector', async () => {
      const result = await server.getHandler('kangentic_recall')({ query: 'q', project: 'Nope' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No project matching');
      expect(mockSearchConversationMemory).not.toHaveBeenCalled();
    });

    it('errors when there are no projects to recall from', async () => {
      (resolver.listProjectsRaw as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);

      const result = await server.getHandler('kangentic_recall')({ query: 'q' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No projects available to recall from');
      expect(mockSearchConversationMemory).not.toHaveBeenCalled();
    });
  });
});
