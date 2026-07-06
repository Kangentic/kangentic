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

import { registerSearchTools } from '../../src/main/agent/mcp-http/search-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

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

function makeResolver(): RequestResolver {
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
    isMemoryIndexingEnabled: vi.fn(() => true),
    getMemoryEmbedder: vi.fn(() => SENTINEL_EMBEDDER),
  } as unknown as RequestResolver;
}

describe('kangentic_search MCP tool', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSearchEverything.mockResolvedValue([]);
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
