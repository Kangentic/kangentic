import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MCP task tools: `runMode` handler-level wiring on kangentic_create_task /
 * kangentic_update_task.
 *
 * `mcp-task-tools-run-mode-schema.test.ts` covers only the zod `inputSchema`
 * shape - it registers the tools against a fake McpServer that never invokes
 * the registered handler callback. Neither of the two profile/pin-vs-runMode
 * mutual exclusivity rejections in task-tools.ts, nor the forwarding of
 * `runMode` into the `callHandler` payload (which task-commands.ts's
 * handleCreateTask / handleUpdateTask then persist as `run_mode`), was
 * exercised anywhere. task-tools.ts rejects two distinct contradictions:
 *
 *  1. `profile` alongside a pin or `runMode: 'agent_override'` (create_task
 *     ~lines 93-98, update_task ~448-450) - the original guard.
 *  2. A pin alongside `runMode: 'column_settings'` (create_task ~103-108,
 *     update_task ~457-459) - the mirror image: a pin already implies
 *     `'agent_override'`, so pairing it with the opposite mode is a
 *     contradiction `applyProfileExclusivity` would otherwise resolve
 *     silently in the pin's favour. update_task's guard checks truthiness,
 *     not `!== undefined`, so the empty-string CLEAR sentinel still legally
 *     pairs with `'column_settings'`.
 *
 * Harness mirrors mcp-task-session-tools.test.ts: mock handler-helpers
 * (callHandler/withProject/detectCrossProjectMention) and a fake McpServer
 * that stores each tool's handler by name so it can be invoked directly,
 * without the real SDK transport or a real project database.
 */

const { mockCallHandler, mockWithProject, mockDetectCrossProjectMention } = vi.hoisted(() => {
  const mockCallHandler = vi.fn(() =>
    Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  const mockDetectCrossProjectMention = vi.fn((): string[] => []);
  const mockWithProject = vi.fn(
    async (
      _resolver: unknown,
      _selector: unknown,
      run: (ctx: unknown, resolved: unknown) => Promise<unknown>,
      _options?: { alwaysAnnotate?: boolean },
    ) => {
      const resolved = {
        context: { getProjectPath: () => '/projects/default' },
        projectId: '11111111-1111-4111-8111-111111111111',
        projectName: 'Active',
        isDefault: true,
      };
      return run(resolved.context, resolved);
    },
  );
  return { mockCallHandler, mockWithProject, mockDetectCrossProjectMention };
});

// Mock handler-helpers BEFORE importing task-tools.ts, which pulls in
// commandHandlers -> better-sqlite3. Keeps this wiring-only suite DB-free.
vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: mockCallHandler,
  runHandler: vi.fn(),
  withProject: mockWithProject,
  detectCrossProjectMention: mockDetectCrossProjectMention,
  sanitizeProjectName: (name: string) => name,
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

// task-tools.ts imports handleMoveTaskToProject directly from task-commands
// (a two-context handler that bypasses the mocked callHandler above). Mock it
// here so this suite stays DB-free; unused by the tests below.
vi.mock('../../src/main/agent/commands/task-commands', () => ({
  TASK_DESCRIPTION_MAX_LENGTH: 50_000,
  handleMoveTaskToProject: vi.fn(),
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';

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
    resolveProject: vi.fn(() => makeDefaultContextResolved()),
    listProjects: vi.fn(() => []),
    defaultContextResolved: vi.fn(() => makeDefaultContextResolved()),
  } as unknown as RequestResolver;
}

describe('kangentic_create_task profile + runMode mutual exclusivity', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;
  let taskCounter: TaskCounter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectCrossProjectMention.mockReturnValue([]);
    server = makeFakeServer();
    resolver = makeResolver();
    taskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('rejects profile together with runMode: "agent_override" and creates nothing', async () => {
    const result = await server.getHandler('kangentic_create_task')({
      title: 'T',
      profile: 'profile-1',
      runMode: 'agent_override',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
    // Rejection is the first check in the handler body - no quota slot
    // burned and no task created.
    expect(mockCallHandler).not.toHaveBeenCalled();
    expect(taskCounter.tryReserve).not.toHaveBeenCalled();
  });

  it('allows profile together with runMode: "column_settings" through (deliberate asymmetry - the two agree)', async () => {
    const result = await server.getHandler('kangentic_create_task')({
      title: 'T',
      profile: 'profile-1',
      runMode: 'column_settings',
    });

    expect(result.isError).toBeUndefined();
    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    const typedParams = params as Record<string, unknown>;
    expect(typedParams.profile).toBe('profile-1');
    expect(typedParams.runMode).toBe('column_settings');
  });

  it('forwards a bare runMode to the callHandler payload', async () => {
    await server.getHandler('kangentic_create_task')({
      title: 'T',
      runMode: 'agent_override',
    });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [handlerName, params] = mockCallHandler.mock.calls[0];
    expect(handlerName).toBe('create_task');
    expect((params as Record<string, unknown>).runMode).toBe('agent_override');
  });

  it('rejects a pin (modelOverride) together with runMode: "column_settings" and creates nothing (mirror-image guard)', async () => {
    const result = await server.getHandler('kangentic_create_task')({
      title: 'T',
      modelOverride: 'opus',
      runMode: 'column_settings',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
    expect(mockCallHandler).not.toHaveBeenCalled();
    expect(taskCounter.tryReserve).not.toHaveBeenCalled();
  });
});

describe('kangentic_update_task profile + runMode mutual exclusivity', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;
  let taskCounter: TaskCounter;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    taskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('rejects profile together with runMode: "agent_override"', async () => {
    const result = await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      profile: 'profile-1',
      runMode: 'agent_override',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('forwards runMode to the callHandler payload on its own', async () => {
    await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      runMode: 'agent_override',
    });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [handlerName, params] = mockCallHandler.mock.calls[0];
    expect(handlerName).toBe('update_task');
    expect((params as Record<string, unknown>).runMode).toBe('agent_override');
  });

  it('rejects a pin (model) together with runMode: "column_settings" (mirror-image guard)', async () => {
    const result = await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      model: 'sonnet',
      runMode: 'column_settings',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('allows an empty-string model (the CLEAR sentinel) together with runMode: "column_settings" through - the deliberate asymmetry', async () => {
    // Truthiness, not `!== undefined`, is the guard's condition: clearing a
    // pin and switching to "follow the columns" agree, so this must NOT be
    // rejected the way a genuine pin (`model: 'sonnet'`) is above.
    const result = await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      model: '',
      runMode: 'column_settings',
    });

    expect(result.isError).toBeUndefined();
    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    const typedParams = params as Record<string, unknown>;
    expect(typedParams.model).toBeNull();
    expect(typedParams.runMode).toBe('column_settings');
  });
});
