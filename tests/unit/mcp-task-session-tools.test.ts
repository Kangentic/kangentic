import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for cross-cutting concerns in mcp-http/task-tools.ts and
 * mcp-http/session-tools.ts. These focus on wiring behaviour that is NOT
 * already covered by the mcp-project-resolver.test.ts suite:
 *
 *  1. create_task: rate-limit check (tryReserve) happens AFTER project
 *     resolution so a bad project selector does NOT burn a quota slot.
 *  2. get_current_task: uses resolver.defaultContextResolved().context
 *     directly - it intentionally does NOT go through withProject because
 *     the tool is always scoped to the URL-path project.
 *  3. list_sessions: representative session tool that routes the optional
 *     `project` param through withProject. A bad selector must return an
 *     error result without calling the inner handler.
 *
 * Strategy: mock handler-helpers (callHandler, runHandler, withProject) and
 * capture their call patterns. Use a fake McpServer that stores handlers by
 * name so we can invoke them directly without spinning up the real SDK
 * transport machinery.
 */

// vi.hoisted lifts these initializers above the vi.mock calls so the factory
// closures can reference the spy instances without a TDZ error.
const { mockCallHandler, mockRunHandler, mockWithProject } = vi.hoisted(() => {
  const mockCallHandler = vi.fn(() =>
    Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  const mockRunHandler = vi.fn(() =>
    Promise.resolve({ success: true, data: [], message: 'ok' }),
  );
  const mockWithProject = vi.fn(
    async (
      _resolver: unknown,
      selector: unknown,
      run: (ctx: unknown) => Promise<unknown>,
    ) => {
      if (selector === 'INVALID_PROJECT') {
        return {
          content: [{ type: 'text' as const, text: 'No project matching "INVALID_PROJECT".' }],
          isError: true,
        };
      }
      const ctx = { getProjectPath: () => '/projects/default' };
      return run(ctx);
    },
  );
  return { mockCallHandler, mockRunHandler, mockWithProject };
});

// Mock handler-helpers BEFORE importing task-tools/session-tools, which
// pull in commandHandlers -> better-sqlite3. Stubbing the module keeps the
// unit scope pure (no native modules, no Electron process).
vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: mockCallHandler,
  runHandler: mockRunHandler,
  withProject: mockWithProject,
  makeTaskCounter: (max: number) => {
    let count = 0;
    return {
      tryReserve: vi.fn(() => {
        if (count >= max) return false;
        count++;
        return true;
      }),
    };
  },
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import { registerSessionTools } from '../../src/main/agent/mcp-http/session-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';

// Fake McpServer that captures registered handlers by tool name so tests can
// invoke them directly without the real SDK transport machinery.
type AnyToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function makeFakeServer() {
  const handlers: Record<string, AnyToolHandler> = {};
  return {
    registerTool: vi.fn((_name: string, _config: unknown, handler: AnyToolHandler) => {
      handlers[_name] = handler;
    }),
    getHandler(name: string): AnyToolHandler {
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler;
    },
  };
}

function makeDefaultContextResolved() {
  return {
    context: { getProjectPath: () => '/projects/default' },
    projectId: '11111111-1111-4111-8111-111111111111',
    projectName: 'Active',
    isDefault: true,
  };
}

function makeResolver(): RequestResolver {
  return {
    resolveProject: vi.fn((selector: string | null | undefined) => {
      if (!selector) return makeDefaultContextResolved();
      return { error: `No project matching "${selector}"` };
    }),
    listProjects: vi.fn(() => []),
    defaultContextResolved: vi.fn(() => makeDefaultContextResolved()),
  } as unknown as RequestResolver;
}

// ---------------------------------------------------------------------------
// create_task - rate-limit wiring
// ---------------------------------------------------------------------------

describe('create_task rate-limit wiring', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;
  let taskCounter: TaskCounter;
  const MAX_TASKS = 5;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    let count = 0;
    taskCounter = {
      tryReserve: vi.fn(() => {
        if (count >= MAX_TASKS) return false;
        count++;
        return true;
      }),
    };
    registerTaskTools(server as never, resolver, taskCounter, MAX_TASKS);
  });

  it('does NOT call tryReserve when the project selector is invalid', async () => {
    // withProject is mocked to return an error when selector === 'INVALID_PROJECT'.
    // tryReserve must stay uncalled - a failed resolution must NOT burn a quota slot.
    const result = await server.getHandler('kangentic_create_task')({
      title: 'My task',
      project: 'INVALID_PROJECT',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No project matching "INVALID_PROJECT"');
    expect(taskCounter.tryReserve).not.toHaveBeenCalled();
  });

  it('calls tryReserve exactly once when the project resolves successfully', async () => {
    await server.getHandler('kangentic_create_task')({ title: 'Valid task' });

    expect(taskCounter.tryReserve).toHaveBeenCalledOnce();
  });

  it('returns a rate-limit error and does NOT call callHandler when the counter is exhausted', async () => {
    // Drain the counter.
    for (let i = 0; i < MAX_TASKS; i++) {
      await server.getHandler('kangentic_create_task')({ title: `Task ${i}` });
    }
    mockCallHandler.mockClear();

    const result = await server.getHandler('kangentic_create_task')({ title: 'One too many' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Rate limit reached');
    expect(result.content[0].text).toContain(String(MAX_TASKS));
    // callHandler must NOT be called after a failed tryReserve.
    expect(mockCallHandler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// get_current_task - uses defaultContextResolved, NOT withProject
// ---------------------------------------------------------------------------

describe('get_current_task uses defaultContextResolved, not withProject', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    const taskCounter: TaskCounter = { tryReserve: vi.fn(() => true) };
    registerTaskTools(server as never, resolver, taskCounter, 50);
  });

  it('calls resolver.defaultContextResolved() instead of withProject when cwd is supplied', async () => {
    await server.getHandler('kangentic_get_current_task')({ cwd: '/some/project/worktrees/task-slug' });

    expect(resolver.defaultContextResolved).toHaveBeenCalledOnce();
    // withProject must NOT be called - this tool is always scoped to the
    // URL-path project, not a caller-supplied project selector.
    expect(mockWithProject).not.toHaveBeenCalled();
  });

  it('calls resolver.defaultContextResolved() instead of withProject when branch is supplied', async () => {
    await server.getHandler('kangentic_get_current_task')({ branch: 'feature/my-task' });

    expect(resolver.defaultContextResolved).toHaveBeenCalledOnce();
    expect(mockWithProject).not.toHaveBeenCalled();
  });

  it('returns an error when neither cwd nor branch is provided', async () => {
    const result = await server.getHandler('kangentic_get_current_task')({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide at least one of');
    // No context resolution should happen when the inputs are invalid.
    expect(resolver.defaultContextResolved).not.toHaveBeenCalled();
    expect(mockWithProject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// list_sessions - representative session tool that routes through withProject
// ---------------------------------------------------------------------------

describe('list_sessions project routing via withProject', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    registerSessionTools(server as never, resolver);
  });

  it('calls withProject with the resolver and the supplied project selector', async () => {
    await server.getHandler('kangentic_list_sessions')({ taskId: 'task-uuid', project: 'Beta' });

    expect(mockWithProject).toHaveBeenCalledOnce();
    const [passedResolver, passedSelector] = mockWithProject.mock.calls[0];
    expect(passedResolver).toBe(resolver);
    expect(passedSelector).toBe('Beta');
  });

  it('returns an error result when the project selector is invalid (no inner handler called)', async () => {
    mockCallHandler.mockClear();

    const result = await server.getHandler('kangentic_list_sessions')({
      taskId: 'task-uuid',
      project: 'INVALID_PROJECT',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No project matching "INVALID_PROJECT"');
    // callHandler must not have been invoked - resolution failed before
    // the inner tool body could run.
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('calls callHandler with "list_sessions" when the project resolves successfully', async () => {
    await server.getHandler('kangentic_list_sessions')({ taskId: 'task-uuid' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [handlerName, params] = mockCallHandler.mock.calls[0];
    expect(handlerName).toBe('list_sessions');
    expect((params as Record<string, unknown>).taskId).toBe('task-uuid');
  });
});
