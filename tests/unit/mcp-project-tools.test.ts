import { describe, it, expect, vi } from 'vitest';
import { registerProjectTools } from '../../src/main/agent/mcp-http/project-tools';
import type { RequestResolver, ProjectSummary } from '../../src/main/agent/mcp-http/project-resolver';

/**
 * Minimal fake McpServer that captures registered tool handlers.
 * The real McpServer from @modelcontextprotocol/sdk is not needed here -
 * we only care that registerProjectTools calls server.registerTool with the
 * right name and that the handler function produces the correct output.
 */
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function makeFakeServer(): { registerTool: ReturnType<typeof vi.fn>; getHandler: (name: string) => ToolHandler } {
  const handlers: Record<string, ToolHandler> = {};
  const registerTool = vi.fn((_name: string, _config: unknown, handler: ToolHandler) => {
    handlers[_name] = handler;
  });
  return {
    registerTool,
    getHandler: (name: string) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler;
    },
  };
}

function makeResolver(projects: ProjectSummary[]): RequestResolver {
  return {
    listProjects: vi.fn(() => projects),
    resolveProject: vi.fn(),
    defaultContextResolved: vi.fn(),
  } as unknown as RequestResolver;
}

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Example',
    path: '/projects/example',
    lastOpened: '2026-01-01T00:00:00Z',
    isActive: false,
    ...overrides,
  };
}

describe('registerProjectTools - kangentic_list_projects', () => {
  it('registers a tool named kangentic_list_projects', () => {
    const server = makeFakeServer();
    const resolver = makeResolver([]);
    registerProjectTools(server as never, resolver);
    expect(server.registerTool).toHaveBeenCalledWith(
      'kangentic_list_projects',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('returns "No projects registered." when the project list is empty', async () => {
    const server = makeFakeServer();
    const resolver = makeResolver([]);
    registerProjectTools(server as never, resolver);

    const result = await server.getHandler('kangentic_list_projects')({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('No projects registered.');
  });

  it('formats a single non-active project correctly', async () => {
    const project = makeProject({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'My Project',
      path: '/projects/mine',
      lastOpened: '2026-03-15T10:00:00Z',
      isActive: false,
    });
    const server = makeFakeServer();
    const resolver = makeResolver([project]);
    registerProjectTools(server as never, resolver);

    const result = await server.getHandler('kangentic_list_projects')({});

    const text = result.content[0].text;
    expect(text).toBe(
      `- My Project (id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa, path: /projects/mine, lastOpened: 2026-03-15T10:00:00Z)`,
    );
    // Inactive project must NOT include the "[active]" tag.
    expect(text).not.toContain('[active]');
  });

  it('appends [active] tag to the active project', async () => {
    const activeProject = makeProject({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Active Board',
      path: '/projects/active',
      lastOpened: '2026-03-15T10:00:00Z',
      isActive: true,
    });
    const server = makeFakeServer();
    const resolver = makeResolver([activeProject]);
    registerProjectTools(server as never, resolver);

    const result = await server.getHandler('kangentic_list_projects')({});

    const text = result.content[0].text;
    expect(text).toContain('Active Board [active]');
    expect(text).toContain('id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('lists all projects joined by newlines, with the active one tagged', async () => {
    const projects = [
      makeProject({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Alpha', path: '/a', lastOpened: '2026-01-01T00:00:00Z', isActive: true }),
      makeProject({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Beta', path: '/b', lastOpened: '2026-02-01T00:00:00Z', isActive: false }),
    ];
    const server = makeFakeServer();
    const resolver = makeResolver(projects);
    registerProjectTools(server as never, resolver);

    const result = await server.getHandler('kangentic_list_projects')({});

    const lines = result.content[0].text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Alpha [active]');
    expect(lines[0]).toContain('id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(lines[1]).toContain('Beta');
    expect(lines[1]).not.toContain('[active]');
    expect(lines[1]).toContain('id: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('calls resolver.listProjects() once per handler invocation', async () => {
    const server = makeFakeServer();
    const resolver = makeResolver([makeProject({ isActive: true })]);
    registerProjectTools(server as never, resolver);

    await server.getHandler('kangentic_list_projects')({});
    await server.getHandler('kangentic_list_projects')({});

    // Each handler call should call listProjects once. The resolver's
    // internal caching (cachedProjects) is resolver-level, not tool-level -
    // the tool itself always delegates to the resolver.
    expect(vi.mocked(resolver.listProjects)).toHaveBeenCalledTimes(2);
  });
});
